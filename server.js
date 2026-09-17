// server.js
//
// A small Express server that receives webhook events from Mindbody
// and (for now) just logs them. Later this will forward the data to GoHighLevel.

// Load variables from the .env file into process.env
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

// Mindbody signs each webhook request using a shared secret. We need that
// same secret here so we can verify the signature. It lives in .env and is
// never committed to source control.
const WEBHOOK_SECRET = process.env.MINDBODY_WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  // Fail fast: without a secret we can't safely verify any incoming webhook.
  console.error('Missing MINDBODY_WEBHOOK_SECRET in .env — refusing to start.');
  process.exit(1);
}

// Mindbody staff credentials, used only by the getOrCreateGHLContact
// fallback below to fetch a client directly from Mindbody (via a staff
// access token) when a webhook references a client GHL doesn't have yet.
// Separate from MINDBODY_WEBHOOK_SECRET, which only verifies incoming
// webhooks and never calls out to Mindbody.
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY;
const MINDBODY_STAFF_USERNAME = process.env.MINDBODY_STAFF_USERNAME;
const MINDBODY_STAFF_PASSWORD = process.env.MINDBODY_STAFF_PASSWORD;

if (!MINDBODY_API_KEY) {
  console.error('Missing MINDBODY_API_KEY in .env — refusing to start.');
  process.exit(1);
}

if (!MINDBODY_STAFF_USERNAME || !MINDBODY_STAFF_PASSWORD) {
  console.error('Missing MINDBODY_STAFF_USERNAME and/or MINDBODY_STAFF_PASSWORD in .env — refusing to start.');
  process.exit(1);
}

// GoHighLevel API token used to create/update contacts. Generated in your
// GoHighLevel private integration / API settings.
const GHL_API_TOKEN = process.env.GHL_API_TOKEN;

if (!GHL_API_TOKEN) {
  // Fail fast: without a token we can't call the GoHighLevel API at all.
  console.error('Missing GHL_API_TOKEN in .env — refusing to start.');
  process.exit(1);
}

// The GoHighLevel sub-account (location) that new Mindbody contacts should
// be created under.
const GHL_LOCATION_ID = 'WAhdYoo8o5RyZH6nek1I';

// The GoHighLevel custom object that stores Mindbody membership records, and
// the association that links a membership record to its contact.
const MEMBERSHIP_OBJECT_KEY = 'custom_objects.memberships';
const MEMBERSHIP_CONTACT_ASSOCIATION_ID = '6aa055b768fe746e819ecb09';

// Maps Mindbody location IDs to human-readable names, for the
// mb_first_class_location custom field.
const LOCATION_ID_TO_NAME = {
  1: 'Albertson',
  2: 'East Meadow',
};

// The GoHighLevel custom object that stores Mindbody purchase records, and
// the association that links a purchase record to its contact.
const PURCHASE_OBJECT_KEY = 'custom_objects.purchases';
const PURCHASE_CONTACT_ASSOCIATION_ID = '6aa07325c6f326bcc38504a2';

const GHL_API_BASE_URL = 'https://services.leadconnectorhq.com';
const MINDBODY_API_BASE_URL = 'https://api.mindbodyonline.com/public/v6';

// Headers required on every GoHighLevel API call.
const GHL_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Version: 'v3',
  Authorization: `Bearer ${GHL_API_TOKEN}`,
};

/**
 * Wraps fetch() with basic retry-with-backoff and rate-limit protection.
 * Retries on a thrown error (network failure/timeout) or a 429/5xx
 * response, up to `retries` additional attempts beyond the initial one. On
 * a 429 with a Retry-After header, waits that many seconds instead of the
 * default delay.
 *
 * This is purely additive: on final failure it returns the failed response
 * (or throws the final error) exactly as a plain fetch() would, so all the
 * existing per-item try/catch and !response.ok handling in this file keeps
 * working unchanged on top of it.
 */
async function fetchWithRetry(url, options, retries = 2, delayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;

    try {
      response = await fetch(url, options);
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }

      console.warn(
        `fetchWithRetry: ${url} threw "${error.message}" — retrying in ${delayMs}ms (attempt ${attempt + 1}/${retries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }

    const shouldRetry = response.status === 429 || response.status >= 500;

    if (!shouldRetry || attempt === retries) {
      return response;
    }

    let waitMs = delayMs;

    if (response.status === 429) {
      const retryAfterHeader =
        response.headers && response.headers.get
          ? response.headers.get("Retry-After")
          : null;
      const retryAfterSeconds = Number(retryAfterHeader);

      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        waitMs = retryAfterSeconds * 1000;
      }
    }

    console.warn(
      `fetchWithRetry: ${url} returned ${response.status} — retrying in ${waitMs}ms (attempt ${attempt + 1}/${retries})`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// --- Mindbody access token caching -------------------------------------
// Same pattern as migration.js / D:\dabrai\server.js: fetch a staff access
// token on demand and cache it in memory until it's about to expire.
// Tokens are site-specific, so the cache is keyed per site ID.
const tokenCacheBySite = {}; // { [siteId]: { token, expiresAt } }

async function getMindbodyAccessToken(siteId) {
  const cached = tokenCacheBySite[siteId];
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const response = await fetchWithRetry(`${MINDBODY_API_BASE_URL}/usertoken/issue`, {
    method: 'POST',
    headers: {
      'Api-Key': MINDBODY_API_KEY,
      SiteId: String(siteId),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Username: MINDBODY_STAFF_USERNAME,
      Password: MINDBODY_STAFF_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Mindbody access token: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const token = data.AccessToken;

  // Decode the JWT's payload (the middle segment) to read its real "exp"
  // claim, rather than assuming a fixed lifetime.
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());

  const expiresAt = payload.exp * 1000;
  tokenCacheBySite[siteId] = { token, expiresAt };

  console.log(`Fetched new Mindbody access token for site ${siteId}, expires at ${new Date(expiresAt).toISOString()}`);

  return token;
}

/**
 * Appends one line to activity.log (same directory as this file) recording
 * a single outcome — one call per meaningful success/failure point inside
 * a handler, alongside (not instead of) the existing console.log/console.error
 * calls.
 */
function logActivity({ trigger, mindbodyClientId, ghlContactId, action, status }) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] TRIGGER=${trigger} MINDBODY_CLIENT=${mindbodyClientId} GHL_CONTACT=${ghlContactId || 'NOT_FOUND'} ACTION="${action}" STATUS=${status}\n`;

  try {
    fs.appendFileSync(path.join(__dirname, 'activity.log'), line);
  } catch (error) {
    console.error('Failed to write to activity.log:', error);
  }
}

/**
 * Wraps a single NEW logging statement (the verbose entry/decision/outcome
 * console logging added below, on top of the existing console.log/
 * console.error/logActivity calls) in its own try/catch, so a bug in a log
 * line itself can never break the real business logic around it — worst
 * case it prints one "Logging error (non-fatal)" line and everything else
 * proceeds exactly as before. Existing logging calls are untouched; this is
 * only used for the new logging this pass adds.
 */
function safeLog(logFn) {
  try {
    logFn();
  } catch (error) {
    console.error('Logging error (non-fatal):', error);
  }
}

// We need the raw, exact bytes of the request body to verify the HMAC
// signature (any re-serialization of the JSON, even reformatting whitespace,
// would produce a different signature). express.json()'s `verify` option
// lets us stash those raw bytes on the request before Express parses them
// into `req.body`.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * Checks the X-Mindbody-Signature header against a signature we compute
 * ourselves from the raw request body + our shared secret.
 *
 * Mindbody sends the header in the form:  sha256=<base64-encoded-hmac>
 */
function isValidSignature(req) {
  const signatureHeader = req.get('X-Mindbody-Signature');

  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const receivedSignature = signatureHeader.slice('sha256='.length);

  // Recompute the expected signature from the raw request body.
  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  // Use a timing-safe comparison so we don't leak information about the
  // secret through how long the comparison takes.
  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * Mindbody sends `null` for a lot of optional fields (e.g. referredBy when
 * a client wasn't referred by anyone). `String(null)` produces the literal
 * text "null", which we don't want ending up in GoHighLevel custom fields.
 * This converts null/undefined to an empty string, and everything else to
 * a string.
 */
function toSafeString(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

/**
 * Mindbody sends birthDateTime as a full ISO timestamp (e.g.
 * "1990-05-14T00:00:00"). GoHighLevel's dateOfBirth field just wants the
 * date part, so we strip everything from "T" onward.
 */
function toDateOnly(dateTimeString) {
  if (!dateTimeString) {
    return '';
  }
  return String(dateTimeString).split('T')[0];
}

/**
 * Builds the GoHighLevel contact field mapping shared by create and update.
 * Does NOT include `locationId` or `source` — those only apply on create
 * (on update, the contact's location is already fixed by its ID in the URL).
 *
 * eventData is the eventData object from the Mindbody webhook payload —
 * see https://developers.mindbodyonline.com for its full shape.
 */
function buildContactPayload(eventData) {
  return {
    firstName: eventData.firstName,
    lastName: eventData.lastName,
    name: `${eventData.firstName} ${eventData.lastName}`,
    email: eventData.email,
    phone: eventData.mobilePhone,
    address1: eventData.addressLine1,
    city: eventData.city,
    state: eventData.state,
    postalCode: eventData.postalCode,
    country: 'US',
    dateOfBirth: toDateOnly(eventData.birthDateTime),
    tags: ['mindbody'],
    customFields: [
      { id: 'LRTn7qgpgX6HMVR8f6zd', key: 'mindbody_client_id', fieldValue: toSafeString(eventData.clientId) },
      { id: 'BS1lWuBcmo3ZyWnCA2mr', key: 'mindbody_unique_id', fieldValue: toSafeString(eventData.clientUniqueId) },
      { id: 'BREWxivlCEYv67Y1rPCa', key: 'mindbody_status', fieldValue: toSafeString(eventData.status) },
      { id: 'l9KGKwvV0Ehgjc6aP6bK', key: 'mindbody_creation_date', fieldValue: toSafeString(eventData.creationDateTime) },
      { id: 'ZuELR70PXP89mbEULdia', key: 'mindbody_birth_date', fieldValue: toSafeString(eventData.birthDateTime) },
      { id: 'TtjLkyY4382fnIXKEOit', key: 'mindbody_home_location', fieldValue: toSafeString(eventData.homeLocation) },
      { id: 'FCPq5xu60vqGaYxhm27W', key: 'mindbody_is_prospect', fieldValue: eventData.isProspect ? 'Yes' : 'No' },
      { id: 'gYUo2TAeqDaRQMZVsIAm', key: 'mindbody_referred_by', fieldValue: toSafeString(eventData.referredBy) },
      { id: 'S23LRNvmCQ1HbDq6nYXH', key: 'mindbody_lead_channel_id', fieldValue: toSafeString(eventData.leadChannelId) },
    ],
  };
}

/**
 * Creates a contact in GoHighLevel from a Mindbody "client.created" event.
 */
async function createGHLContact(eventData) {
  safeLog(() =>
    console.log(
      `createGHLContact: ENTRY trigger=client.created mindbodyClientId=${eventData.clientId} email=${eventData.email} firstName=${eventData.firstName} lastName=${eventData.lastName}`
    )
  );

  // Create is the only place locationId + source apply.
  const contactPayload = {
    ...buildContactPayload(eventData),
    locationId: GHL_LOCATION_ID,
    source: 'mindbody',
  };

  try {
    safeLog(() =>
      console.log(
        `createGHLContact: calling POST ${GHL_API_BASE_URL}/contacts/ — locationId=${contactPayload.locationId} tags=${JSON.stringify(contactPayload.tags)} customFieldIds=${JSON.stringify(contactPayload.customFields.map((f) => f.id))}`
      )
    );

    const response = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify(contactPayload),
    });

    safeLog(() => console.log(`createGHLContact: POST /contacts/ responded status=${response.status} ok=${response.ok}`));

    // GoHighLevel returns a JSON body on both success and failure, so we
    // read it either way — the failure body is what tells us *why* a field
    // was rejected.
    const responseBody = await response.json().catch(() => null);

    if (!response.ok) {
      console.error('GoHighLevel contact creation failed:', response.status, JSON.stringify(responseBody, null, 2));
      logActivity({
        trigger: 'client.created',
        mindbodyClientId: eventData.clientId,
        ghlContactId: null,
        action: 'Failed to create GHL contact',
        status: 'error',
      });
      safeLog(() =>
        console.log(
          `createGHLContact: OUTCOME failure — mindbodyClientId=${eventData.clientId} not created, GHL returned status ${response.status}`
        )
      );
      return;
    }

    console.log('GoHighLevel contact created:', JSON.stringify(responseBody, null, 2));
    logActivity({
      trigger: 'client.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: responseBody && responseBody.contact && responseBody.contact.id,
      action: 'Created GHL contact',
      status: 'success',
    });
    safeLog(() =>
      console.log(
        `createGHLContact: OUTCOME success — created GHL contact ${responseBody && responseBody.contact && responseBody.contact.id} for mindbodyClientId=${eventData.clientId}`
      )
    );
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'client.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'Error creating GHL contact',
      status: 'error',
    });
    safeLog(() =>
      console.log(`createGHLContact: OUTCOME error — mindbodyClientId=${eventData.clientId} threw: ${error && error.message}`)
    );
  }
}

/**
 * Looks up the GoHighLevel contact matching a Mindbody client, by the
 * mindbody_client_id custom field (set when the contact was originally
 * created). Returns the GHL contact ID, or null if no contact matches or
 * the search itself fails.
 *
 * Shared by updateGHLContact and the membership handlers below, since both
 * need to resolve a Mindbody clientId to a GHL contact.
 */
async function findGHLContactByMindbodyClientId(clientId) {
  try {
    const searchResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/search`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        pageLimit: 1,
        filters: [
          {
            field: 'customFields.LRTn7qgpgX6HMVR8f6zd',
            operator: 'eq',
            value: toSafeString(clientId),
          },
        ],
      }),
    });

    const searchBody = await searchResponse.json().catch(() => null);

    if (!searchResponse.ok) {
      console.error('GoHighLevel contact search failed:', searchResponse.status, JSON.stringify(searchBody, null, 2));
      return null;
    }

    const contacts = (searchBody && searchBody.contacts) || [];

    if (contacts.length === 0) {
      return null;
    }

    return contacts[0].id;
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    return null;
  }
}

/**
 * Maps a raw Mindbody client/clients record (capitalized field names, e.g.
 * FirstName, BirthDate) into the lowercase eventData-shaped object
 * buildContactPayload expects (firstName, birthDateTime, ...). Mirrors the
 * same mapping already used in migration.js's buildMigrationContactPayload,
 * duplicated here since these files are meant to stay independent.
 *
 * Same gap as migration.js: the webhook's eventData.leadChannelId has no
 * equivalent on this REST endpoint, so it's left undefined here too rather
 * than guessing a source field.
 */
function mapMindbodyClientToEventData(client) {
  return {
    firstName: client.FirstName,
    lastName: client.LastName,
    email: client.Email,
    mobilePhone: client.MobilePhone,
    addressLine1: client.AddressLine1,
    city: client.City,
    state: client.State,
    postalCode: client.PostalCode,
    birthDateTime: client.BirthDate,
    clientId: client.Id,
    clientUniqueId: client.UniqueId,
    status: client.Status,
    creationDateTime: client.CreationDate,
    homeLocation: client.HomeLocation && client.HomeLocation.Id,
    isProspect: client.IsProspect,
    referredBy: client.ReferredBy,
    leadChannelId: undefined,
  };
}

/**
 * Resolves a Mindbody client to a GHL contact ID, creating the contact on
 * the spot if one doesn't exist yet — used by handlers that reference a
 * client that may not have gone through client.created yet (e.g. a
 * membership/purchase/class-completion webhook arriving first). Returns the
 * GHL contact ID (existing or freshly created), or null if the fallback
 * itself fails (Mindbody fetch or GHL creation).
 *
 * NOTE: Mindbody's `ClientId` (singular) query parameter does NOT actually
 * filter results — confirmed by direct testing, it silently ignores the
 * value and returns an unrelated default client instead. `ClientIds`
 * (plural) is the parameter that actually works, so that's used below.
 */
async function getOrCreateGHLContact(mindbodyClientId, siteId) {
  safeLog(() => console.log(`getOrCreateGHLContact: ENTRY mindbodyClientId=${mindbodyClientId} siteId=${siteId}`));

  const existingContactId = await findGHLContactByMindbodyClientId(mindbodyClientId);

  safeLog(() =>
    console.log(
      `getOrCreateGHLContact: findGHLContactByMindbodyClientId(${mindbodyClientId}) -> ${existingContactId || 'NOT_FOUND'} — ${existingContactId ? 'FOUND, returning existing contact' : 'not found, will fall back to Mindbody fetch + create'}`
    )
  );

  if (existingContactId) {
    safeLog(() => console.log(`getOrCreateGHLContact: OUTCOME success (fast path) — returning existing contact ${existingContactId}`));
    return existingContactId;
  }

  try {
    let accessToken = await getMindbodyAccessToken(siteId);
    safeLog(() => console.log(`getOrCreateGHLContact: obtained Mindbody access token for siteId=${siteId}`));

    const mindbodyHeaders = () => ({
      'Api-Key': MINDBODY_API_KEY,
      SiteId: String(siteId),
      Authorization: `Bearer ${accessToken}`,
    });

    const url = `${MINDBODY_API_BASE_URL}/client/clients?ClientIds=${mindbodyClientId}`;

    safeLog(() => console.log(`getOrCreateGHLContact: calling GET ${url}`));

    let mbResponse = await fetchWithRetry(url, { method: 'GET', headers: mindbodyHeaders() });

    safeLog(() => console.log(`getOrCreateGHLContact: GET client/clients responded status=${mbResponse.status} ok=${mbResponse.ok}`));

    if (mbResponse.status === 401) {
      console.warn('Mindbody API returned 401 — refreshing access token and retrying once.');
      safeLog(() => console.log('getOrCreateGHLContact: DECISION 401 received — refreshing token and retrying once'));
      delete tokenCacheBySite[siteId];
      accessToken = await getMindbodyAccessToken(siteId);
      mbResponse = await fetchWithRetry(url, { method: 'GET', headers: mindbodyHeaders() });
      safeLog(() => console.log(`getOrCreateGHLContact: retry GET client/clients responded status=${mbResponse.status} ok=${mbResponse.ok}`));
    }

    const mbBody = await mbResponse.json().catch(() => null);

    if (!mbResponse.ok) {
      console.error('Mindbody client fetch failed (fallback):', mbResponse.status, JSON.stringify(mbBody, null, 2));
      logActivity({
        trigger: 'getOrCreateGHLContact',
        mindbodyClientId,
        ghlContactId: null,
        action: 'Fallback Mindbody client fetch failed',
        status: 'error',
      });
      safeLog(() =>
        console.log(`getOrCreateGHLContact: OUTCOME failure — Mindbody client fetch failed for ${mindbodyClientId}, status ${mbResponse.status}`)
      );
      return null;
    }

    const client = (mbBody && mbBody.Clients && mbBody.Clients[0]) || null;

    safeLog(() =>
      console.log(
        `getOrCreateGHLContact: DECISION Mindbody returned ${mbBody && Array.isArray(mbBody.Clients) ? mbBody.Clients.length : 0} client(s) for ${mindbodyClientId} — ${client ? 'using first result' : 'none, cannot create contact'}`
      )
    );

    if (!client) {
      console.error(`Mindbody client fetch (fallback) returned no client for ID ${mindbodyClientId}`);
      logActivity({
        trigger: 'getOrCreateGHLContact',
        mindbodyClientId,
        ghlContactId: null,
        action: 'Fallback Mindbody client fetch returned no client',
        status: 'error',
      });
      safeLog(() => console.log(`getOrCreateGHLContact: OUTCOME failure — no Mindbody client found for ${mindbodyClientId}`));
      return null;
    }

    const adaptedEventData = mapMindbodyClientToEventData(client);

    const contactPayload = {
      ...buildContactPayload(adaptedEventData),
      locationId: GHL_LOCATION_ID,
      source: 'mindbody',
    };

    safeLog(() =>
      console.log(
        `getOrCreateGHLContact: calling POST ${GHL_API_BASE_URL}/contacts/ — locationId=${contactPayload.locationId} tags=${JSON.stringify(contactPayload.tags)} customFieldIds=${JSON.stringify(contactPayload.customFields.map((f) => f.id))}`
      )
    );

    const createResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify(contactPayload),
    });

    safeLog(() => console.log(`getOrCreateGHLContact: POST /contacts/ responded status=${createResponse.status} ok=${createResponse.ok}`));

    const createBody = await createResponse.json().catch(() => null);

    if (!createResponse.ok) {
      console.error('GoHighLevel contact creation failed (fallback):', createResponse.status, JSON.stringify(createBody, null, 2));
      logActivity({
        trigger: 'getOrCreateGHLContact',
        mindbodyClientId,
        ghlContactId: null,
        action: 'Fallback GHL contact creation failed',
        status: 'error',
      });
      safeLog(() =>
        console.log(`getOrCreateGHLContact: OUTCOME failure — GHL rejected fallback creation for ${mindbodyClientId}, status ${createResponse.status}`)
      );
      return null;
    }

    const newContactId = createBody && createBody.contact && createBody.contact.id;
    console.log(`GoHighLevel contact created via fallback (id: ${newContactId}) for mindbody client ${mindbodyClientId}`);
    logActivity({
      trigger: 'getOrCreateGHLContact',
      mindbodyClientId,
      ghlContactId: newContactId,
      action: 'Created missing contact via fallback',
      status: 'success',
    });
    safeLog(() =>
      console.log(`getOrCreateGHLContact: OUTCOME success (fallback create) — created GHL contact ${newContactId} for mindbodyClientId=${mindbodyClientId}`)
    );
    return newContactId;
  } catch (error) {
    console.error('Error in getOrCreateGHLContact fallback:', error);
    logActivity({
      trigger: 'getOrCreateGHLContact',
      mindbodyClientId,
      ghlContactId: null,
      action: 'Fallback contact creation threw an error',
      status: 'error',
    });
    safeLog(() => console.log(`getOrCreateGHLContact: OUTCOME error — mindbodyClientId=${mindbodyClientId} threw: ${error && error.message}`));
    return null;
  }
}

/**
 * Updates the existing GoHighLevel contact matching a Mindbody
 * "client.updated" event.
 */
async function updateGHLContact(eventData) {
  safeLog(() =>
    console.log(`updateGHLContact: ENTRY trigger=client.updated mindbodyClientId=${eventData.clientId} email=${eventData.email}`)
  );

  const contactId = await findGHLContactByMindbodyClientId(eventData.clientId);

  safeLog(() =>
    console.log(
      `updateGHLContact: findGHLContactByMindbodyClientId(${eventData.clientId}) -> ${contactId || 'NOT_FOUND'} — ${contactId ? 'contact found, proceeding' : 'no contact found, will skip'}`
    )
  );

  if (!contactId) {
    console.warn(`No matching GHL contact found for mindbody client ${eventData.clientId} — skipping update`);
    logActivity({
      trigger: 'client.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'No matching GHL contact found, skipped update',
      status: 'error',
    });
    safeLog(() =>
      console.log(`updateGHLContact: OUTCOME skipped — no GHL contact for mindbodyClientId=${eventData.clientId}, nothing updated`)
    );
    return;
  }

  try {
    const updatePayload = buildContactPayload(eventData);
    safeLog(() =>
      console.log(
        `updateGHLContact: calling PUT ${GHL_API_BASE_URL}/contacts/${contactId} — tags=${JSON.stringify(updatePayload.tags)} customFieldIds=${JSON.stringify(updatePayload.customFields.map((f) => f.id))}`
      )
    );

    const updateResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: GHL_HEADERS,
      body: JSON.stringify(updatePayload),
    });

    safeLog(() => console.log(`updateGHLContact: PUT /contacts/${contactId} responded status=${updateResponse.status} ok=${updateResponse.ok}`));

    const updateBody = await updateResponse.json().catch(() => null);

    if (!updateResponse.ok) {
      console.error('GoHighLevel contact update failed:', updateResponse.status, JSON.stringify(updateBody, null, 2));
      logActivity({
        trigger: 'client.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to update GHL contact',
        status: 'error',
      });
      safeLog(() =>
        console.log(`updateGHLContact: OUTCOME failure — contact ${contactId} not updated, GHL returned status ${updateResponse.status}`)
      );
      return;
    }

    console.log(`GoHighLevel contact updated (id: ${contactId}):`, JSON.stringify(updateBody, null, 2));
    logActivity({
      trigger: 'client.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Updated GHL contact',
      status: 'success',
    });
    safeLog(() => console.log(`updateGHLContact: OUTCOME success — contact ${contactId} updated for mindbodyClientId=${eventData.clientId}`));
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'client.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Error updating GHL contact',
      status: 'error',
    });
    safeLog(() => console.log(`updateGHLContact: OUTCOME error — contact ${contactId} threw: ${error && error.message}`));
  }
}

/**
 * Looks up a GoHighLevel Membership custom-object record by the
 * mindbody_membership_id property. Returns the record's GHL ID, or null if
 * no record matches or the search itself fails.
 */
async function findMembershipRecordByMindbodyId(membershipId) {
  try {
    const searchResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records/search`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        page: 1,
        pageLimit: 1,
        filters: [
          {
            field: 'properties.mindbody_membership_id',
            operator: 'eq',
            value: toSafeString(membershipId),
          },
        ],
      }),
    });

    const searchBody = await searchResponse.json().catch(() => null);

    if (!searchResponse.ok) {
      console.error('GoHighLevel membership record search failed:', searchResponse.status, JSON.stringify(searchBody, null, 2));
      return null;
    }

    const records = (searchBody && searchBody.records) || [];

    if (records.length === 0) {
      return null;
    }

    return records[0].id;
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    return null;
  }
}

/**
 * Membership create/cancel both stamp a date onto the record (start_date on
 * create, end_date on cancel), preferring the webhook's own
 * eventInstanceOriginationDateTime and falling back to today's date
 * (server time) when that's not present.
 */
function resolveMembershipEventDate(eventData) {
  if (eventData.eventInstanceOriginationDateTime) {
    return toDateOnly(eventData.eventInstanceOriginationDateTime);
  }
  return new Date().toISOString().split('T')[0];
}

/**
 * Handles a Mindbody "clientMembershipAssignment.created" event: creates a
 * Membership record in GoHighLevel and links it to the matching contact.
 */
async function handleMembershipCreated(eventData) {
  safeLog(() =>
    console.log(
      `handleMembershipCreated: ENTRY trigger=clientMembershipAssignment.created mindbodyClientId=${eventData.clientId} siteId=${eventData.siteId} membershipId=${eventData.membershipId} membershipName=${eventData.membershipName}`
    )
  );

  // Step 1 — find (or, if missing, create) the GHL contact this membership
  // belongs to. Falls back to fetching straight from Mindbody in case this
  // membership webhook arrived before/instead of client.created.
  const contactId = await getOrCreateGHLContact(eventData.clientId, eventData.siteId);

  safeLog(() =>
    console.log(
      `handleMembershipCreated: DECISION getOrCreateGHLContact -> ${contactId || 'NULL'} — ${contactId ? 'contact resolved, proceeding to create membership record' : 'could not resolve, will skip'}`
    )
  );

  if (!contactId) {
    console.warn(`Could not resolve a GHL contact for mindbody client ${eventData.clientId} — skipping membership creation`);
    logActivity({
      trigger: 'clientMembershipAssignment.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'Could not resolve GHL contact for membership creation',
      status: 'error',
    });
    safeLog(() =>
      console.log(`handleMembershipCreated: OUTCOME skipped — no GHL contact for mindbodyClientId=${eventData.clientId}, no membership record created`)
    );
    return;
  }

  console.log(`Found GHL contact ${contactId} for mindbody client ${eventData.clientId}`);

  // Step 2 — create the Membership record.
  let recordId;
  try {
    const startDate = resolveMembershipEventDate(eventData);
    safeLog(() =>
      console.log(
        `handleMembershipCreated: calling POST ${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records — membership_name=${eventData.membershipName} mindbody_membership_id=${eventData.membershipId} membership_status=active start_date=${startDate}`
      )
    );

    const recordResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        properties: {
          membership_name: eventData.membershipName,
          mindbody_membership_id: toSafeString(eventData.membershipId),
          membership_status: 'active',
          start_date: startDate,
        },
      }),
    });

    safeLog(() =>
      console.log(`handleMembershipCreated: POST membership record responded status=${recordResponse.status} ok=${recordResponse.ok}`)
    );

    const recordBody = await recordResponse.json().catch(() => null);

    if (!recordResponse.ok) {
      console.error('GoHighLevel membership record creation failed:', recordResponse.status, JSON.stringify(recordBody, null, 2));
      logActivity({
        trigger: 'clientMembershipAssignment.created',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to create membership record',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleMembershipCreated: OUTCOME failure — membership record not created for contact ${contactId}, status ${recordResponse.status}`)
      );
      return;
    }

    recordId = recordBody && recordBody.record && recordBody.record.id;
    console.log('GoHighLevel membership record created:', JSON.stringify(recordBody, null, 2));
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'clientMembershipAssignment.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Error creating membership record',
      status: 'error',
    });
    safeLog(() => console.log(`handleMembershipCreated: OUTCOME error — membership record creation threw: ${error && error.message}`));
    return;
  }

  safeLog(() =>
    console.log(`handleMembershipCreated: DECISION recordId=${recordId || 'MISSING'} — ${recordId ? 'proceeding to create relation' : 'cannot link, will skip'}`)
  );

  if (!recordId) {
    console.error('GoHighLevel membership record creation response did not include a record id — skipping relation creation');
    logActivity({
      trigger: 'clientMembershipAssignment.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Membership record creation response missing record id',
      status: 'error',
    });
    safeLog(() => console.log(`handleMembershipCreated: OUTCOME failure — no record id returned, relation not created for contact ${contactId}`));
    return;
  }

  // Step 3 — link the new Membership record to the contact.
  try {
    safeLog(() =>
      console.log(
        `handleMembershipCreated: calling POST ${GHL_API_BASE_URL}/associations/relations — associationId=${MEMBERSHIP_CONTACT_ASSOCIATION_ID} firstRecordId=${contactId} secondRecordId=${recordId}`
      )
    );

    const relationResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/associations/relations`, {
      method: 'POST',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        associationId: MEMBERSHIP_CONTACT_ASSOCIATION_ID,
        firstRecordId: contactId,
        secondRecordId: recordId,
      }),
    });

    safeLog(() =>
      console.log(`handleMembershipCreated: POST relation responded status=${relationResponse.status} ok=${relationResponse.ok}`)
    );

    const relationBody = await relationResponse.json().catch(() => null);

    if (!relationResponse.ok) {
      console.error('GoHighLevel membership-contact relation creation failed:', relationResponse.status, JSON.stringify(relationBody, null, 2));
      logActivity({
        trigger: 'clientMembershipAssignment.created',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to create membership-contact relation',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleMembershipCreated: OUTCOME failure — relation not created between contact ${contactId} and record ${recordId}, status ${relationResponse.status}`)
      );
      return;
    }

    console.log(
      `GoHighLevel membership-contact relation created (contact: ${contactId}, membership record: ${recordId}):`,
      JSON.stringify(relationBody, null, 2)
    );
    logActivity({
      trigger: 'clientMembershipAssignment.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Created membership record and linked to contact',
      status: 'success',
    });
    safeLog(() =>
      console.log(`handleMembershipCreated: OUTCOME success — membership record ${recordId} created and linked to contact ${contactId}`)
    );
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'clientMembershipAssignment.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Error creating membership-contact relation',
      status: 'error',
    });
    safeLog(() => console.log(`handleMembershipCreated: OUTCOME error — relation creation threw: ${error && error.message}`));
  }
}

/**
 * Handles a Mindbody "clientMembershipAssignment.cancelled" event: marks
 * the matching Membership record in GoHighLevel as terminated. Never
 * creates a new record — if no matching record exists, it's skipped.
 */
async function handleMembershipCancelled(eventData) {
  safeLog(() =>
    console.log(
      `handleMembershipCancelled: ENTRY trigger=clientMembershipAssignment.cancelled mindbodyClientId=${eventData.clientId} membershipId=${eventData.membershipId}`
    )
  );

  const recordId = await findMembershipRecordByMindbodyId(eventData.membershipId);

  safeLog(() =>
    console.log(
      `handleMembershipCancelled: findMembershipRecordByMindbodyId(${eventData.membershipId}) -> ${recordId || 'NOT_FOUND'} — ${recordId ? 'found, proceeding to cancel' : 'not found, will skip'}`
    )
  );

  if (!recordId) {
    console.warn(`No matching GHL membership record found for mindbody membership ${eventData.membershipId} — skipping cancellation update`);
    logActivity({
      trigger: 'clientMembershipAssignment.cancelled',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'No matching GHL membership record found, skipped cancellation',
      status: 'error',
    });
    safeLog(() =>
      console.log(`handleMembershipCancelled: OUTCOME skipped — no membership record for membershipId=${eventData.membershipId}, nothing cancelled`)
    );
    return;
  }

  console.log(`Found GHL membership record ${recordId} for mindbody membership ${eventData.membershipId}`);

  try {
    const endDate = resolveMembershipEventDate(eventData);
    safeLog(() =>
      console.log(
        `handleMembershipCancelled: calling PUT ${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records/${recordId} — membership_status=terminated end_date=${endDate}`
      )
    );

    const updateResponse = await fetchWithRetry(
      `${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records/${recordId}?locationId=${GHL_LOCATION_ID}`,
      {
        method: 'PUT',
        headers: GHL_HEADERS,
        body: JSON.stringify({
          properties: {
            membership_status: 'terminated',
            end_date: endDate,
          },
        }),
      }
    );

    safeLog(() =>
      console.log(`handleMembershipCancelled: PUT membership record responded status=${updateResponse.status} ok=${updateResponse.ok}`)
    );

    const updateBody = await updateResponse.json().catch(() => null);

    if (!updateResponse.ok) {
      console.error('GoHighLevel membership record cancellation failed:', updateResponse.status, JSON.stringify(updateBody, null, 2));
      logActivity({
        trigger: 'clientMembershipAssignment.cancelled',
        mindbodyClientId: eventData.clientId,
        ghlContactId: null,
        action: 'Failed to update membership_status to terminated',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleMembershipCancelled: OUTCOME failure — record ${recordId} not cancelled, status ${updateResponse.status}`)
      );
      return;
    }

    console.log(`GoHighLevel membership record cancelled (id: ${recordId}):`, JSON.stringify(updateBody, null, 2));
    logActivity({
      trigger: 'clientMembershipAssignment.cancelled',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'Updated membership_status to terminated',
      status: 'success',
    });
    safeLog(() => console.log(`handleMembershipCancelled: OUTCOME success — membership record ${recordId} marked terminated`));
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'clientMembershipAssignment.cancelled',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'Error updating membership_status to terminated',
      status: 'error',
    });
    safeLog(() => console.log(`handleMembershipCancelled: OUTCOME error — record ${recordId} cancellation threw: ${error && error.message}`));
  }
}

/**
 * Handles a Mindbody "classRosterBooking.created" event: when a booking is
 * a client's first-ever visit at the site (clientsNumberOfVisitsAtSite ===
 * 1 — confirmed present on THIS event type, unlike
 * classRosterBookingStatus.updated), records which booking that is on the
 * contact. Does not apply any tag — that only happens once the client
 * actually shows up, handled by handleFirstClassCompleted below via an
 * exact classRosterBookingId match against the value recorded here.
 */
async function handleClassBookingCreated(eventData) {
  safeLog(() =>
    console.log(
      `handleClassBookingCreated: ENTRY trigger=classRosterBooking.created mindbodyClientId=${eventData.clientId} classRosterBookingId=${eventData.classRosterBookingId} clientsNumberOfVisitsAtSite=${eventData.clientsNumberOfVisitsAtSite}`
    )
  );

  safeLog(() =>
    console.log(
      `handleClassBookingCreated: DECISION clientsNumberOfVisitsAtSite=${eventData.clientsNumberOfVisitsAtSite} — ${eventData.clientsNumberOfVisitsAtSite === 1 ? 'IS first visit, proceeding' : 'not first visit, no-op'}`
    )
  );

  if (eventData.clientsNumberOfVisitsAtSite !== 1) {
    return;
  }

  const contactId = await getOrCreateGHLContact(eventData.clientId, eventData.siteId);

  safeLog(() =>
    console.log(
      `handleClassBookingCreated: DECISION getOrCreateGHLContact -> ${contactId || 'NULL'} — ${contactId ? 'contact resolved, proceeding to record booking' : 'could not resolve, will skip'}`
    )
  );

  if (!contactId) {
    console.warn(`Could not resolve a GHL contact for mindbody client ${eventData.clientId} — skipping first-visit booking record`);
    logActivity({
      trigger: 'classRosterBooking.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'Could not resolve GHL contact for first-visit booking record',
      status: 'error',
    });
    safeLog(() =>
      console.log(`handleClassBookingCreated: OUTCOME skipped — no GHL contact for mindbodyClientId=${eventData.clientId}, booking id not recorded`)
    );
    return;
  }

  try {
    safeLog(() =>
      console.log(
        `handleClassBookingCreated: calling PUT ${GHL_API_BASE_URL}/contacts/${contactId} — customFieldId=9NuHRxHfjnenKLKdWY7G (mb_first_visit_booking_id)=${eventData.classRosterBookingId}`
      )
    );

    const updateResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        customFields: [
          { id: '9NuHRxHfjnenKLKdWY7G', key: 'mb_first_visit_booking_id', fieldValue: toSafeString(eventData.classRosterBookingId) },
        ],
      }),
    });

    safeLog(() =>
      console.log(`handleClassBookingCreated: PUT /contacts/${contactId} responded status=${updateResponse.status} ok=${updateResponse.ok}`)
    );

    const updateBody = await updateResponse.json().catch(() => null);

    if (!updateResponse.ok) {
      console.error('GoHighLevel first-visit booking id update failed:', updateResponse.status, JSON.stringify(updateBody, null, 2));
      logActivity({
        trigger: 'classRosterBooking.created',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to set mb_first_visit_booking_id',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleClassBookingCreated: OUTCOME failure — contact ${contactId} not updated, status ${updateResponse.status}`)
      );
      return;
    }

    console.log(
      `GoHighLevel contact recorded first-visit booking id (id: ${contactId}, booking: ${eventData.classRosterBookingId}):`,
      JSON.stringify(updateBody, null, 2)
    );
    logActivity({
      trigger: 'classRosterBooking.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Set mb_first_visit_booking_id',
      status: 'success',
    });
    safeLog(() =>
      console.log(`handleClassBookingCreated: OUTCOME success — contact ${contactId} mb_first_visit_booking_id set to ${eventData.classRosterBookingId}`)
    );
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'classRosterBooking.created',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Error setting mb_first_visit_booking_id',
      status: 'error',
    });
    safeLog(() => console.log(`handleClassBookingCreated: OUTCOME error — contact ${contactId} threw: ${error && error.message}`));
  }
}

/**
 * Handles a Mindbody "classRosterBookingStatus.updated" event, watching for
 * a client's very first completed class: tags the matching GHL contact and
 * records which class/date/location it was.
 *
 * clientsNumberOfVisitsAtSite does NOT exist on this event type (confirmed
 * from real production payloads — it only exists on
 * classRosterBooking.created), so "is this their first class" can't be
 * determined from this event alone. Instead, this correlates against the
 * mb_first_visit_booking_id recorded by handleClassBookingCreated above: if
 * this booking's ID exactly matches what was recorded as the client's
 * first-ever booking, this is that first visit actually happening; anything
 * else (mismatched or unset) is a repeat visit.
 *
 * Fires very frequently (every roster status change for every class), so
 * the not-signed-in skip case below intentionally logs nothing — only
 * meaningful outcomes are worth a log line.
 */
async function handleFirstClassCompleted(eventData) {
  safeLog(() =>
    console.log(
      `handleFirstClassCompleted: ENTRY trigger=classRosterBookingStatus.updated mindbodyClientId=${eventData.clientId} classRosterBookingId=${eventData.classRosterBookingId} signedInStatus=${eventData.signedInStatus}`
    )
  );

  safeLog(() =>
    console.log(
      `handleFirstClassCompleted: DECISION signedInStatus="${eventData.signedInStatus}" — ${eventData.signedInStatus === 'SignedIn' ? 'SignedIn, proceeding' : 'not SignedIn, no-op'}`
    )
  );

  if (eventData.signedInStatus !== 'SignedIn') {
    return;
  }

  // Falls back to fetching straight from Mindbody in case this class-
  // completion webhook arrived before/instead of client.created.
  const contactId = await getOrCreateGHLContact(eventData.clientId, eventData.siteId);

  safeLog(() =>
    console.log(
      `handleFirstClassCompleted: DECISION getOrCreateGHLContact -> ${contactId || 'NULL'} — ${contactId ? 'contact resolved, proceeding' : 'could not resolve, will skip'}`
    )
  );

  if (!contactId) {
    console.warn(`Could not resolve a GHL contact for mindbody client ${eventData.clientId} — skipping first-class update`);
    logActivity({
      trigger: 'classRosterBookingStatus.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: null,
      action: 'Could not resolve GHL contact for first-class update',
      status: 'error',
    });
    safeLog(() =>
      console.log(`handleFirstClassCompleted: OUTCOME skipped — no GHL contact for mindbodyClientId=${eventData.clientId}`)
    );
    return;
  }

  try {
    // We need the contact's current tags so the update doesn't clobber
    // whatever tags are already on it.
    safeLog(() => console.log(`handleFirstClassCompleted: calling GET ${GHL_API_BASE_URL}/contacts/${contactId}`));

    const getResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/${contactId}`, {
      method: 'GET',
      headers: GHL_HEADERS,
    });

    safeLog(() => console.log(`handleFirstClassCompleted: GET /contacts/${contactId} responded status=${getResponse.status} ok=${getResponse.ok}`));

    const getBody = await getResponse.json().catch(() => null);

    if (!getResponse.ok) {
      console.error('GoHighLevel contact fetch failed:', getResponse.status, JSON.stringify(getBody, null, 2));
      logActivity({
        trigger: 'classRosterBookingStatus.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to fetch GHL contact for first-class update',
        status: 'error',
      });
      safeLog(() => console.log(`handleFirstClassCompleted: OUTCOME failure — could not fetch contact ${contactId}, status ${getResponse.status}`));
      return;
    }

    const existingTags = (getBody && getBody.contact && getBody.contact.tags) || [];

    safeLog(() => console.log(`handleFirstClassCompleted: contact ${contactId} existing tags=${JSON.stringify(existingTags)}`));

    // Correlate against the booking recorded by handleClassBookingCreated:
    // only treat this as "first class completed" if this exact booking is
    // the one that was flagged as the client's first-ever visit. Anything
    // else (mismatched or never set) is a repeat visit, not a first one.
    const existingCustomFields = (getBody && getBody.contact && getBody.contact.customFields) || [];
    const firstVisitBookingIdField = existingCustomFields.find((field) => field.id === '9NuHRxHfjnenKLKdWY7G');
    const storedFirstVisitBookingId = firstVisitBookingIdField ? toSafeString(firstVisitBookingIdField.value) : '';
    const incomingBookingId = toSafeString(eventData.classRosterBookingId);
    const bookingMatches = Boolean(storedFirstVisitBookingId) && storedFirstVisitBookingId === incomingBookingId;

    safeLog(() =>
      console.log(
        `handleFirstClassCompleted: contact ${contactId} mb_first_visit_booking_id="${storedFirstVisitBookingId}" vs incoming classRosterBookingId="${incomingBookingId}" — ${bookingMatches ? 'MATCH, proceeding' : 'MISMATCH, skipping as repeat visit'}`
      )
    );

    if (!bookingMatches) {
      console.log(
        `Booking ${incomingBookingId} does not match contact ${contactId}'s recorded first-visit booking ("${storedFirstVisitBookingId}") — repeat visit, skipping first-class tag/fields`
      );
      logActivity({
        trigger: 'classRosterBookingStatus.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Booking does not match recorded first-visit booking, skipped as repeat visit',
        status: 'success',
      });
      safeLog(() =>
        console.log(`handleFirstClassCompleted: OUTCOME skipped (repeat visit) — contact ${contactId}, booking ${incomingBookingId}`)
      );
      return;
    }

    const mergedTags = Array.from(new Set([...existingTags, 'mb-first-class-completed']));

    const locationName = LOCATION_ID_TO_NAME[eventData.locationId] || toSafeString(eventData.locationId);

    safeLog(() =>
      console.log(
        `handleFirstClassCompleted: calling PUT ${GHL_API_BASE_URL}/contacts/${contactId} — tags=${JSON.stringify(mergedTags)} mb_first_class_name=${eventData.itemName} mb_first_class_date=${toDateOnly(eventData.classDateTime)} mb_first_class_location=${locationName}`
      )
    );

    const updateResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: GHL_HEADERS,
      body: JSON.stringify({
        tags: mergedTags,
        customFields: [
          { id: '0bvsglN3zlqLFX9iBGgs', key: 'mb_first_class_name', fieldValue: toSafeString(eventData.itemName) },
          { id: 'kDcEDHktzm2VXwSEL6mp', key: 'mb_first_class_date', fieldValue: toDateOnly(eventData.classDateTime) },
          { id: 'Hl8gF2NHBeYkMZpU3eoV', key: 'mb_first_class_location', fieldValue: locationName },
        ],
      }),
    });

    safeLog(() =>
      console.log(`handleFirstClassCompleted: PUT /contacts/${contactId} (tags/fields) responded status=${updateResponse.status} ok=${updateResponse.ok}`)
    );

    const updateBody = await updateResponse.json().catch(() => null);

    if (!updateResponse.ok) {
      console.error('GoHighLevel first-class contact update failed:', updateResponse.status, JSON.stringify(updateBody, null, 2));
      logActivity({
        trigger: 'classRosterBookingStatus.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to apply mb-first-class-completed tag',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleFirstClassCompleted: OUTCOME failure — mb-first-class-completed tag not applied to contact ${contactId}, status ${updateResponse.status}`)
      );
      return;
    }

    console.log(`GoHighLevel contact updated for first class completed (id: ${contactId}):`, JSON.stringify(updateBody, null, 2));
    logActivity({
      trigger: 'classRosterBookingStatus.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Applied mb-first-class-completed tag',
      status: 'success',
    });
    safeLog(() => console.log(`handleFirstClassCompleted: OUTCOME success — mb-first-class-completed applied to contact ${contactId}`));

    // Now check whether this contact has an active Membership record, so we
    // can flag "first class but no membership" for follow-up.
    safeLog(() =>
      console.log(`handleFirstClassCompleted: calling GET ${GHL_API_BASE_URL}/associations/relations/${contactId}`)
    );

    const relationsResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/associations/relations/${contactId}?locationId=${GHL_LOCATION_ID}`, {
      method: 'GET',
      headers: GHL_HEADERS,
    });

    safeLog(() =>
      console.log(`handleFirstClassCompleted: GET relations responded status=${relationsResponse.status} ok=${relationsResponse.ok}`)
    );

    const relationsBody = await relationsResponse.json().catch(() => null);

    if (!relationsResponse.ok) {
      console.error('GoHighLevel relations fetch failed:', relationsResponse.status, JSON.stringify(relationsBody, null, 2));
      logActivity({
        trigger: 'classRosterBookingStatus.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to fetch relations for membership check',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleFirstClassCompleted: OUTCOME failure — could not fetch relations for contact ${contactId}, status ${relationsResponse.status}`)
      );
      return;
    }

    // Logging the raw shape the first time this runs, so we can confirm the
    // response structure before relying on it below.
    console.dir(relationsBody, { depth: null });

    // Defensive: use `relations` if present, otherwise assume the response
    // body itself is the array.
    const relations = Array.isArray(relationsBody && relationsBody.relations)
      ? relationsBody.relations
      : Array.isArray(relationsBody)
      ? relationsBody
      : [];

    const membershipRecordIds = relations
      .filter(
        (relation) => relation.firstObjectKey === MEMBERSHIP_OBJECT_KEY || relation.secondObjectKey === MEMBERSHIP_OBJECT_KEY
      )
      .map((relation) => (relation.firstRecordId === contactId ? relation.secondRecordId : relation.firstRecordId));

    console.log(`Found ${membershipRecordIds.length} membership relation(s) for contact ${contactId}`);
    safeLog(() =>
      console.log(`handleFirstClassCompleted: DECISION ${membershipRecordIds.length} membership relation(s) found — checking each for active status`)
    );

    let hasActiveMembership = false;

    for (const membershipRecordId of membershipRecordIds) {
      safeLog(() =>
        console.log(`handleFirstClassCompleted: calling GET ${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records/${membershipRecordId}`)
      );

      const membershipResponse = await fetchWithRetry(
        `${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records/${membershipRecordId}?locationId=${GHL_LOCATION_ID}`,
        { method: 'GET', headers: GHL_HEADERS }
      );

      safeLog(() =>
        console.log(`handleFirstClassCompleted: GET membership record ${membershipRecordId} responded status=${membershipResponse.status} ok=${membershipResponse.ok}`)
      );

      const membershipBody = await membershipResponse.json().catch(() => null);

      if (!membershipResponse.ok) {
        console.error('GoHighLevel membership record fetch failed:', membershipResponse.status, JSON.stringify(membershipBody, null, 2));
        logActivity({
          trigger: 'classRosterBookingStatus.updated',
          mindbodyClientId: eventData.clientId,
          ghlContactId: contactId,
          action: 'Failed to fetch a membership record during membership check',
          status: 'error',
        });
        continue;
      }

      const membershipStatus =
        membershipBody && membershipBody.record && membershipBody.record.properties && membershipBody.record.properties.membership_status;

      safeLog(() =>
        console.log(
          `handleFirstClassCompleted: membership record ${membershipRecordId} membership_status="${membershipStatus}" — ${membershipStatus === 'active' ? 'ACTIVE, stopping check' : 'not active, checking next'}`
        )
      );

      if (membershipStatus === 'active') {
        hasActiveMembership = true;
        break;
      }
    }

    safeLog(() =>
      console.log(`handleFirstClassCompleted: DECISION hasActiveMembership=${hasActiveMembership} for contact ${contactId}`)
    );

    if (hasActiveMembership) {
      console.log(`Active membership found for contact ${contactId} — skipping mb-first-class-no-membership tag`);
      logActivity({
        trigger: 'classRosterBookingStatus.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Active membership found, skipped mb-first-class-no-membership tag',
        status: 'success',
      });
      safeLog(() =>
        console.log(`handleFirstClassCompleted: OUTCOME success (no-membership tag skipped) — contact ${contactId} has an active membership`)
      );
      return;
    }

    const tagsWithNoMembership = Array.from(new Set([...mergedTags, 'mb-first-class-no-membership']));

    safeLog(() =>
      console.log(
        `handleFirstClassCompleted: calling PUT ${GHL_API_BASE_URL}/contacts/${contactId} — tags=${JSON.stringify(tagsWithNoMembership)}`
      )
    );

    const noMembershipUpdateResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/${contactId}`, {
      method: 'PUT',
      headers: GHL_HEADERS,
      body: JSON.stringify({ tags: tagsWithNoMembership }),
    });

    safeLog(() =>
      console.log(`handleFirstClassCompleted: PUT /contacts/${contactId} (no-membership tag) responded status=${noMembershipUpdateResponse.status} ok=${noMembershipUpdateResponse.ok}`)
    );

    const noMembershipUpdateBody = await noMembershipUpdateResponse.json().catch(() => null);

    if (!noMembershipUpdateResponse.ok) {
      console.error('GoHighLevel no-membership tag update failed:', noMembershipUpdateResponse.status, JSON.stringify(noMembershipUpdateBody, null, 2));
      logActivity({
        trigger: 'classRosterBookingStatus.updated',
        mindbodyClientId: eventData.clientId,
        ghlContactId: contactId,
        action: 'Failed to apply mb-first-class-no-membership tag',
        status: 'error',
      });
      safeLog(() =>
        console.log(`handleFirstClassCompleted: OUTCOME failure — mb-first-class-no-membership tag not applied to contact ${contactId}, status ${noMembershipUpdateResponse.status}`)
      );
      return;
    }

    console.log(`GoHighLevel contact tagged mb-first-class-no-membership (id: ${contactId}):`, JSON.stringify(noMembershipUpdateBody, null, 2));
    logActivity({
      trigger: 'classRosterBookingStatus.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Applied mb-first-class-no-membership tag',
      status: 'success',
    });
    safeLog(() => console.log(`handleFirstClassCompleted: OUTCOME success — mb-first-class-no-membership applied to contact ${contactId}`));
  } catch (error) {
    console.error('Error calling GoHighLevel API:', error);
    logActivity({
      trigger: 'classRosterBookingStatus.updated',
      mindbodyClientId: eventData.clientId,
      ghlContactId: contactId,
      action: 'Error during first-class-completed handling',
      status: 'error',
    });
    safeLog(() => console.log(`handleFirstClassCompleted: OUTCOME error — contact ${contactId} threw: ${error && error.message}`));
  }
}

/**
 * Handles a Mindbody "clientSale.created" event: creates a Purchase record
 * in GoHighLevel for each item in the sale and links it to the contact that
 * item was for (the recipient, not necessarily whoever paid).
 *
 * A single sale can contain multiple items, possibly for different
 * recipients, so each item is processed independently — one missing
 * contact skips just that item, not the whole sale.
 */
async function handlePurchaseCreated(eventData) {
  const items = eventData.items || [];
  const purchaseDate = toDateOnly(eventData.saleDateTime);

  safeLog(() =>
    console.log(
      `handlePurchaseCreated: ENTRY trigger=clientSale.created saleId=${eventData.saleId} itemCount=${items.length} purchaseDate=${purchaseDate}`
    )
  );

  let succeeded = 0;
  let skipped = 0;

  for (const item of items) {
    safeLog(() =>
      console.log(
        `handlePurchaseCreated: processing item name=${item.name} type=${item.type} amountPaid=${item.amountPaid} recipientClientId=${item.recipientClientId}`
      )
    );

    // Step 1 — find (or, if missing, create) the GHL contact this item's
    // purchase belongs to. Falls back to fetching straight from Mindbody in
    // case this sale webhook arrived before/instead of client.created.
    const contactId = await getOrCreateGHLContact(item.recipientClientId, eventData.siteId);

    safeLog(() =>
      console.log(
        `handlePurchaseCreated: DECISION getOrCreateGHLContact -> ${contactId || 'NULL'} for item "${item.name}" — ${contactId ? 'contact resolved, proceeding' : 'could not resolve, will skip this item'}`
      )
    );

    if (!contactId) {
      console.warn(`Could not resolve a GHL contact for mindbody client ${item.recipientClientId} — skipping purchase item "${item.name}"`);
      logActivity({
        trigger: 'clientSale.created',
        mindbodyClientId: item.recipientClientId,
        ghlContactId: null,
        action: `Could not resolve GHL contact for purchase item "${item.name}"`,
        status: 'error',
      });
      safeLog(() => console.log(`handlePurchaseCreated: OUTCOME item skipped — no GHL contact for recipientClientId=${item.recipientClientId}`));
      skipped += 1;
      continue;
    }

    console.log(`Found GHL contact ${contactId} for mindbody client ${item.recipientClientId}`);

    // Step 2 — create the Purchase record.
    let recordId;
    try {
      safeLog(() =>
        console.log(
          `handlePurchaseCreated: calling POST ${GHL_API_BASE_URL}/objects/${PURCHASE_OBJECT_KEY}/records — item_name=${item.name} item_type=${item.type} amount_paid=${item.amountPaid} mindbody_sale_id=${eventData.saleId}`
        )
      );

      const recordResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/objects/${PURCHASE_OBJECT_KEY}/records`, {
        method: 'POST',
        headers: GHL_HEADERS,
        body: JSON.stringify({
          locationId: GHL_LOCATION_ID,
          properties: {
            item_name: item.name,
            item_type: item.type,
            amount_paid: item.amountPaid,
            purchase_date: purchaseDate,
            mindbody_sale_id: toSafeString(eventData.saleId),
          },
        }),
      });

      safeLog(() =>
        console.log(`handlePurchaseCreated: POST purchase record responded status=${recordResponse.status} ok=${recordResponse.ok}`)
      );

      const recordBody = await recordResponse.json().catch(() => null);

      if (!recordResponse.ok) {
        console.error('GoHighLevel purchase record creation failed:', recordResponse.status, JSON.stringify(recordBody, null, 2));
        logActivity({
          trigger: 'clientSale.created',
          mindbodyClientId: item.recipientClientId,
          ghlContactId: contactId,
          action: 'Failed to create purchase record',
          status: 'error',
        });
        safeLog(() =>
          console.log(`handlePurchaseCreated: OUTCOME item failed — purchase record not created for contact ${contactId}, status ${recordResponse.status}`)
        );
        skipped += 1;
        continue;
      }

      recordId = recordBody && recordBody.record && recordBody.record.id;
      console.log('GoHighLevel purchase record created:', JSON.stringify(recordBody, null, 2));
    } catch (error) {
      console.error('Error calling GoHighLevel API:', error);
      logActivity({
        trigger: 'clientSale.created',
        mindbodyClientId: item.recipientClientId,
        ghlContactId: contactId,
        action: 'Error creating purchase record',
        status: 'error',
      });
      safeLog(() => console.log(`handlePurchaseCreated: OUTCOME item error — purchase record creation threw: ${error && error.message}`));
      skipped += 1;
      continue;
    }

    safeLog(() =>
      console.log(`handlePurchaseCreated: DECISION recordId=${recordId || 'MISSING'} — ${recordId ? 'proceeding to link to contact' : 'cannot link, will skip'}`)
    );

    if (!recordId) {
      console.error('GoHighLevel purchase record creation response did not include a record id — skipping relation creation');
      logActivity({
        trigger: 'clientSale.created',
        mindbodyClientId: item.recipientClientId,
        ghlContactId: contactId,
        action: 'Purchase record creation response missing record id',
        status: 'error',
      });
      safeLog(() => console.log(`handlePurchaseCreated: OUTCOME item failed — no record id returned for contact ${contactId}`));
      skipped += 1;
      continue;
    }

    // Step 3 — link the new Purchase record to the contact.
    try {
      safeLog(() =>
        console.log(
          `handlePurchaseCreated: calling POST ${GHL_API_BASE_URL}/associations/relations — associationId=${PURCHASE_CONTACT_ASSOCIATION_ID} firstRecordId=${contactId} secondRecordId=${recordId}`
        )
      );

      const relationResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/associations/relations`, {
        method: 'POST',
        headers: GHL_HEADERS,
        body: JSON.stringify({
          associationId: PURCHASE_CONTACT_ASSOCIATION_ID,
          locationId: GHL_LOCATION_ID,
          firstRecordId: contactId,
          secondRecordId: recordId,
        }),
      });

      safeLog(() =>
        console.log(`handlePurchaseCreated: POST relation responded status=${relationResponse.status} ok=${relationResponse.ok}`)
      );

      const relationBody = await relationResponse.json().catch(() => null);

      if (!relationResponse.ok) {
        console.error('GoHighLevel purchase-contact relation creation failed:', relationResponse.status, JSON.stringify(relationBody, null, 2));
        logActivity({
          trigger: 'clientSale.created',
          mindbodyClientId: item.recipientClientId,
          ghlContactId: contactId,
          action: 'Failed to create purchase-contact relation',
          status: 'error',
        });
        safeLog(() =>
          console.log(`handlePurchaseCreated: OUTCOME item failed — relation not created between contact ${contactId} and record ${recordId}, status ${relationResponse.status}`)
        );
        skipped += 1;
        continue;
      }

      console.log(
        `GoHighLevel purchase-contact relation created (contact: ${contactId}, purchase record: ${recordId}):`,
        JSON.stringify(relationBody, null, 2)
      );
      logActivity({
        trigger: 'clientSale.created',
        mindbodyClientId: item.recipientClientId,
        ghlContactId: contactId,
        action: 'Created purchase record and linked to contact',
        status: 'success',
      });
      safeLog(() =>
        console.log(`handlePurchaseCreated: OUTCOME item success — purchase record ${recordId} created and linked to contact ${contactId}`)
      );
      succeeded += 1;
    } catch (error) {
      console.error('Error calling GoHighLevel API:', error);
      logActivity({
        trigger: 'clientSale.created',
        mindbodyClientId: item.recipientClientId,
        ghlContactId: contactId,
        action: 'Error creating purchase-contact relation',
        status: 'error',
      });
      safeLog(() => console.log(`handlePurchaseCreated: OUTCOME item error — relation creation threw: ${error && error.message}`));
      skipped += 1;
    }
  }

  console.log(`clientSale.created processed: ${succeeded} item(s) succeeded, ${skipped} item(s) skipped (out of ${items.length} total).`);
  safeLog(() =>
    console.log(`handlePurchaseCreated: OUTCOME summary — saleId=${eventData.saleId} succeeded=${succeeded} skipped=${skipped} total=${items.length}`)
  );
}

// When you first create a webhook subscription in Mindbody, Mindbody sends a
// HEAD request to this URL to confirm something is listening before it will
// activate the subscription. It doesn't need a body or signature check —
// just a 200 OK.
app.head('/webhooks/mindbody', (req, res) => {
  res.sendStatus(200);
});

// The main webhook endpoint. Mindbody POSTs event payloads here whenever a
// subscribed event happens (e.g. a client is created).
app.post('/webhooks/mindbody', async (req, res) => {
  if (!isValidSignature(req)) {
    console.warn('Rejected webhook: invalid signature');
    return res.sendStatus(401);
  }

  // Mindbody requires a response within 10 seconds, so we respond
  // immediately and log/process the payload afterward. Once we start
  // forwarding to GoHighLevel, that work should happen after this response
  // too (or be handed off to a queue), not before it.
  res.sendStatus(200);

  const { eventId, eventData } = req.body;

  console.log('--- Mindbody webhook received ---');
  console.log('Event ID:', eventId);
  console.log('Event Data:', JSON.stringify(eventData, null, 2));
  console.log('Full payload:', JSON.stringify(req.body, null, 2));
  console.log('----------------------------------');

  // The Mindbody response has already been sent above, so awaiting here
  // doesn't risk missing Mindbody's 10-second response window — it just
  // keeps this request's logs in order.
  if (eventId === 'client.created') {
    await createGHLContact(eventData);
  } else if (eventId === 'client.updated') {
    await updateGHLContact(eventData);
  } else if (eventId === 'clientMembershipAssignment.created') {
    await handleMembershipCreated(eventData);
  } else if (eventId === 'clientMembershipAssignment.cancelled') {
    await handleMembershipCancelled(eventData);
  } else if (eventId === 'classRosterBooking.created') {
    await handleClassBookingCreated(eventData);
  } else if (eventId === 'classRosterBookingStatus.updated') {
    await handleFirstClassCompleted(eventData);
  } else if (eventId === 'clientSale.created') {
    await handlePurchaseCreated(eventData);
  }
});

// Simple health check so you (or an uptime monitor) can confirm the server
// is up and responding.
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
