// scheduled-jobs.js
//
// Scheduled background jobs for the Mindbody <-> GoHighLevel integration.
// Currently just the daily no-show detection job. Separate from server.js
// (which only handles live webhooks) but shares the same .env file.
//
// Run manually with `node scheduled-jobs.js`, or `require('./scheduled-jobs')`
// from a cron handler (e.g. Vercel Cron) and call runNoShowJob() — importing
// this file does not run anything by itself.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

// The studio operates in this timezone regardless of where this script
// actually runs (e.g. a cron host in UTC, or a laptop in another US
// timezone). All "yesterday" date math must be done relative to
// studio-local time, not the server's own local time, or the job could
// check the wrong day for hours around midnight Eastern.
const STUDIO_TIMEZONE = "America/New_York";

// Mindbody Public API v6 credentials. These are separate from
// MINDBODY_WEBHOOK_SECRET (used by server.js to verify incoming webhooks) —
// this script instead calls OUT to Mindbody's API, which needs its own
// Api-Key/SiteId pair.
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY;
const MINDBODY_SITE_ID = process.env.MINDBODY_SITE_ID;

if (!MINDBODY_API_KEY) {
  console.error("Missing MINDBODY_API_KEY in .env — refusing to run.");
  process.exit(1);
}

if (!MINDBODY_SITE_ID) {
  console.error("Missing MINDBODY_SITE_ID in .env — refusing to run.");
  process.exit(1);
}

// Mindbody staff credentials, used only by the getOrCreateGHLContact
// fallback below to fetch a client directly from Mindbody (via a staff
// access token) when a job encounters a client GHL doesn't have yet. Same
// requirement as server.js's getOrCreateGHLContact.
const MINDBODY_STAFF_USERNAME = process.env.MINDBODY_STAFF_USERNAME;
const MINDBODY_STAFF_PASSWORD = process.env.MINDBODY_STAFF_PASSWORD;

if (!MINDBODY_STAFF_USERNAME || !MINDBODY_STAFF_PASSWORD) {
  console.error("Missing MINDBODY_STAFF_USERNAME and/or MINDBODY_STAFF_PASSWORD in .env — refusing to run.");
  process.exit(1);
}

// Same GoHighLevel API token used by server.js.
const GHL_API_TOKEN = process.env.GHL_API_TOKEN;

if (!GHL_API_TOKEN) {
  console.error("Missing GHL_API_TOKEN in .env — refusing to run.");
  process.exit(1);
}

// Same GoHighLevel location used throughout the webhook server.
const GHL_LOCATION_ID = "WAhdYoo8o5RyZH6nek1I";

// The GoHighLevel custom object that stores Mindbody membership records —
// same object key used in server.js. Duplicated here (rather than imported)
// since these two files are meant to stay independent.
const MEMBERSHIP_OBJECT_KEY = "custom_objects.memberships";

const GHL_API_BASE_URL = "https://services.leadconnectorhq.com";
const MINDBODY_API_BASE_URL = "https://api.mindbodyonline.com/public/v6";

// Headers required on every GoHighLevel API call.
const GHL_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Version: "v3",
  Authorization: `Bearer ${GHL_API_TOKEN}`,
};

// Headers required on every Mindbody Public API call.
const MINDBODY_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "Api-Key": MINDBODY_API_KEY,
  SiteId: MINDBODY_SITE_ID,
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

/**
 * Mindbody/GoHighLevel sometimes send null for optional fields.
 * `String(null)` produces the literal text "null", which we don't want
 * ending up in GoHighLevel custom fields. Converts null/undefined to an
 * empty string, everything else to a string.
 */
function toSafeString(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

/**
 * Mindbody sends several date fields as full ISO timestamps. GoHighLevel's
 * date fields just want the date part, so we strip everything from "T"
 * onward. Duplicated from server.js — needed by buildContactPayload below.
 */
function toDateOnly(dateTimeString) {
  if (!dateTimeString) {
    return "";
  }
  return String(dateTimeString).split("T")[0];
}

/**
 * Builds the GoHighLevel contact field mapping used when creating a
 * contact. Duplicated verbatim from server.js's buildContactPayload — only
 * needed here by getOrCreateGHLContact's fallback creation path.
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
    country: "US",
    dateOfBirth: toDateOnly(eventData.birthDateTime),
    tags: ["mindbody"],
    customFields: [
      { id: "LRTn7qgpgX6HMVR8f6zd", key: "mindbody_client_id", fieldValue: toSafeString(eventData.clientId) },
      { id: "BS1lWuBcmo3ZyWnCA2mr", key: "mindbody_unique_id", fieldValue: toSafeString(eventData.clientUniqueId) },
      { id: "BREWxivlCEYv67Y1rPCa", key: "mindbody_status", fieldValue: toSafeString(eventData.status) },
      { id: "l9KGKwvV0Ehgjc6aP6bK", key: "mindbody_creation_date", fieldValue: toSafeString(eventData.creationDateTime) },
      { id: "ZuELR70PXP89mbEULdia", key: "mindbody_birth_date", fieldValue: toSafeString(eventData.birthDateTime) },
      { id: "TtjLkyY4382fnIXKEOit", key: "mindbody_home_location", fieldValue: toSafeString(eventData.homeLocation) },
      { id: "FCPq5xu60vqGaYxhm27W", key: "mindbody_is_prospect", fieldValue: eventData.isProspect ? "Yes" : "No" },
      { id: "gYUo2TAeqDaRQMZVsIAm", key: "mindbody_referred_by", fieldValue: toSafeString(eventData.referredBy) },
      { id: "S23LRNvmCQ1HbDq6nYXH", key: "mindbody_lead_channel_id", fieldValue: toSafeString(eventData.leadChannelId) },
    ],
  };
}

// --- Mindbody access token caching -------------------------------------
// Same pattern as server.js / migration.js: fetch a staff access token on
// demand and cache it in memory until it's about to expire. Tokens are
// site-specific, so the cache is keyed per site ID. Needed here only by
// getOrCreateGHLContact's fallback (the existing getYesterdaysClasses /
// getClassVisits / getLastVisitDate calls keep using the simpler
// MINDBODY_HEADERS as before — untouched).
const tokenCacheBySite = {}; // { [siteId]: { token, expiresAt } }

async function getMindbodyAccessToken(siteId) {
  const cached = tokenCacheBySite[siteId];
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const response = await fetchWithRetry(`${MINDBODY_API_BASE_URL}/usertoken/issue`, {
    method: "POST",
    headers: {
      "Api-Key": MINDBODY_API_KEY,
      SiteId: String(siteId),
      "Content-Type": "application/json",
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
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());

  const expiresAt = payload.exp * 1000;
  tokenCacheBySite[siteId] = { token, expiresAt };

  console.log(`Fetched new Mindbody access token for site ${siteId}, expires at ${new Date(expiresAt).toISOString()}`);

  return token;
}

/**
 * Appends one line to activity.log (same directory and same format as
 * server.js's logActivity — both files write to the same file, so their
 * entries interleave in one shared log).
 */
function logActivity({ trigger, mindbodyClientId, ghlContactId, action, status }) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] TRIGGER=${trigger} MINDBODY_CLIENT=${mindbodyClientId} GHL_CONTACT=${ghlContactId || "NOT_FOUND"} ACTION="${action}" STATUS=${status}\n`;

  try {
    fs.appendFileSync(path.join(__dirname, "activity.log"), line);
  } catch (error) {
    console.error("Failed to write to activity.log:", error);
  }
}

/**
 * Looks up the GoHighLevel contact matching a Mindbody client, by the
 * mindbody_client_id custom field (set when the contact was originally
 * created by server.js). Returns the GHL contact ID, or null if no contact
 * matches or the search itself fails.
 */
async function findGHLContactByMindbodyClientId(clientId) {
  try {
    const searchResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/search`, {
      method: "POST",
      headers: GHL_HEADERS,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        pageLimit: 1,
        filters: [
          {
            field: "customFields.LRTn7qgpgX6HMVR8f6zd",
            operator: "eq",
            value: toSafeString(clientId),
          },
        ],
      }),
    });

    const searchBody = await searchResponse.json().catch(() => null);

    if (!searchResponse.ok) {
      console.error(
        "GoHighLevel contact search failed:",
        searchResponse.status,
        JSON.stringify(searchBody, null, 2),
      );
      return null;
    }

    const contacts = (searchBody && searchBody.contacts) || [];

    if (contacts.length === 0) {
      return null;
    }

    return contacts[0].id;
  } catch (error) {
    console.error("Error calling GoHighLevel API:", error);
    return null;
  }
}

/**
 * Maps a raw Mindbody client/clients record (capitalized field names, e.g.
 * FirstName, BirthDate) into the lowercase eventData-shaped object
 * buildContactPayload expects (firstName, birthDateTime, ...). Duplicated
 * verbatim from server.js's mapMindbodyClientToEventData.
 *
 * Same gap as server.js/migration.js: the webhook's eventData.leadChannelId
 * has no equivalent on this REST endpoint, so it's left undefined here too
 * rather than guessing a source field.
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
 * the spot if one doesn't exist yet. Duplicated verbatim from server.js's
 * getOrCreateGHLContact. Returns the GHL contact ID (existing or freshly
 * created), or null if the fallback itself fails (Mindbody fetch or GHL
 * creation).
 *
 * NOTE: Mindbody's `ClientId` (singular) query parameter does NOT actually
 * filter results — confirmed by direct testing, it silently ignores the
 * value and returns an unrelated default client instead. `ClientIds`
 * (plural) is the parameter that actually works, so that's used below.
 */
async function getOrCreateGHLContact(mindbodyClientId, siteId) {
  const existingContactId = await findGHLContactByMindbodyClientId(mindbodyClientId);

  if (existingContactId) {
    return existingContactId;
  }

  try {
    let accessToken = await getMindbodyAccessToken(siteId);

    const mindbodyHeaders = () => ({
      "Api-Key": MINDBODY_API_KEY,
      SiteId: String(siteId),
      Authorization: `Bearer ${accessToken}`,
    });

    const url = `${MINDBODY_API_BASE_URL}/client/clients?ClientIds=${mindbodyClientId}`;

    let mbResponse = await fetchWithRetry(url, { method: "GET", headers: mindbodyHeaders() });

    if (mbResponse.status === 401) {
      console.warn("Mindbody API returned 401 — refreshing access token and retrying once.");
      delete tokenCacheBySite[siteId];
      accessToken = await getMindbodyAccessToken(siteId);
      mbResponse = await fetchWithRetry(url, { method: "GET", headers: mindbodyHeaders() });
    }

    const mbBody = await mbResponse.json().catch(() => null);

    if (!mbResponse.ok) {
      console.error("Mindbody client fetch failed (fallback):", mbResponse.status, JSON.stringify(mbBody, null, 2));
      logActivity({
        trigger: "getOrCreateGHLContact",
        mindbodyClientId,
        ghlContactId: null,
        action: "Fallback Mindbody client fetch failed",
        status: "error",
      });
      return null;
    }

    const client = (mbBody && mbBody.Clients && mbBody.Clients[0]) || null;

    if (!client) {
      console.error(`Mindbody client fetch (fallback) returned no client for ID ${mindbodyClientId}`);
      logActivity({
        trigger: "getOrCreateGHLContact",
        mindbodyClientId,
        ghlContactId: null,
        action: "Fallback Mindbody client fetch returned no client",
        status: "error",
      });
      return null;
    }

    const adaptedEventData = mapMindbodyClientToEventData(client);

    const contactPayload = {
      ...buildContactPayload(adaptedEventData),
      locationId: GHL_LOCATION_ID,
      source: "mindbody",
    };

    const createResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/`, {
      method: "POST",
      headers: GHL_HEADERS,
      body: JSON.stringify(contactPayload),
    });

    const createBody = await createResponse.json().catch(() => null);

    if (!createResponse.ok) {
      console.error("GoHighLevel contact creation failed (fallback):", createResponse.status, JSON.stringify(createBody, null, 2));
      logActivity({
        trigger: "getOrCreateGHLContact",
        mindbodyClientId,
        ghlContactId: null,
        action: "Fallback GHL contact creation failed",
        status: "error",
      });
      return null;
    }

    const newContactId = createBody && createBody.contact && createBody.contact.id;
    console.log(`GoHighLevel contact created via fallback (id: ${newContactId}) for mindbody client ${mindbodyClientId}`);
    logActivity({
      trigger: "getOrCreateGHLContact",
      mindbodyClientId,
      ghlContactId: newContactId,
      action: "Created missing contact via fallback",
      status: "success",
    });
    return newContactId;
  } catch (error) {
    console.error("Error in getOrCreateGHLContact fallback:", error);
    logActivity({
      trigger: "getOrCreateGHLContact",
      mindbodyClientId,
      ghlContactId: null,
      action: "Fallback contact creation threw an error",
      status: "error",
    });
    return null;
  }
}

// Yesterday's date, computed once in the studio's own timezone.
const yesterday = DateTime.now()
  .setZone(STUDIO_TIMEZONE)
  .minus({ days: 1 })
  .toFormat("yyyy-MM-dd");

// The classvisits response nests everything under response.Class (see
// getClassVisits below). We only dump it to the console once per process
// run, the first time it's fetched — not once per class, which would be
// noisy — purely as a debugging aid.
let hasLoggedRawClassVisitsResponse = false;

/**
 * Fetches every class that ran at the studio yesterday (studio-local date).
 */
async function getYesterdaysClasses() {
  const url = `${MINDBODY_API_BASE_URL}/class/classes?StartDateTime=${yesterday}T00:00:00&EndDateTime=${yesterday}T23:59:59`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: MINDBODY_HEADERS,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(
      "Mindbody classes fetch failed:",
      response.status,
      JSON.stringify(body, null, 2),
    );
    return [];
  }

  return (body && body.Classes) || [];
}

/**
 * Fetches the roster of visits for a single class.
 *
 * Confirmed from a live test run: the response nests the visit list under
 * response.Class.Visits, and response.Class.ClassDescription.Name is that
 * same class's name as seen by this endpoint specifically (kept separate
 * from the class-list endpoint's own copy of the name, since they're two
 * different API calls even though the values should agree).
 *
 * Returns { visits, className }. Falls back to response.Visits directly if
 * response.Class isn't present, and to an empty visits array (with a
 * warning) if neither shape matches.
 */
async function getClassVisits(classId) {
  const url = `${MINDBODY_API_BASE_URL}/class/classvisits?ClassID=${classId}`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: MINDBODY_HEADERS,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(
      "Mindbody class visits fetch failed:",
      response.status,
      JSON.stringify(body, null, 2),
    );
    return { visits: [], className: undefined };
  }

  if (!hasLoggedRawClassVisitsResponse) {
    console.dir((body && body.Class) || body, { depth: null });
    hasLoggedRawClassVisitsResponse = true;
  }

  if (body && body.Class && Array.isArray(body.Class.Visits)) {
    return {
      visits: body.Class.Visits,
      className:
        body.Class.ClassDescription && body.Class.ClassDescription.Name,
    };
  }

  if (Array.isArray(body && body.Visits)) {
    return { visits: body.Visits, className: undefined };
  }

  console.warn(
    `Mindbody class visits response for class ${classId} had no recognizable Visits array — skipping`,
  );
  return { visits: [], className: undefined };
}

/**
 * The daily no-show detection job: finds every client who was booked into a
 * class yesterday (studio-local date) but never signed in, and tags/updates
 * their GoHighLevel contact accordingly.
 */
async function runNoShowJob() {
  console.log(
    `Running no-show job for studio date ${yesterday} (${STUDIO_TIMEZONE})`,
  );

  const classes = await getYesterdaysClasses();

  let noShowsFound = 0;
  let contactsUpdated = 0;
  let skipped = 0;

  for (const classItem of classes) {
    const { visits, className } = await getClassVisits(classItem.Id);

    for (const visit of visits) {
      const appointmentStatus = visit.AppointmentStatus;

      if (appointmentStatus === undefined) {
        console.warn(
          `Visit for class ${classItem.Id} has no AppointmentStatus field — skipping:`,
          JSON.stringify(visit),
        );
        skipped += 1;
        continue;
      }

      if (appointmentStatus !== "NoShow") {
        continue;
      }

      noShowsFound += 1;

      // Falls back to fetching straight from Mindbody in case this
      // client was never created in GHL (e.g. predates the webhook).
      const contactId = await getOrCreateGHLContact(visit.ClientId, MINDBODY_SITE_ID);

      if (!contactId) {
        console.warn(
          `Could not resolve a GHL contact for mindbody client ${visit.ClientId} — skipping no-show update`,
        );
        logActivity({
          trigger: "no-show-job",
          mindbodyClientId: visit.ClientId,
          ghlContactId: null,
          action: "Could not resolve GHL contact for no-show update",
          status: "error",
        });
        skipped += 1;
        continue;
      }

      try {
        // We need the contact's current tags and mb_noshow_count so the
        // update doesn't clobber existing tags or reset the count.
        const getResponse = await fetchWithRetry(
          `${GHL_API_BASE_URL}/contacts/${contactId}`,
          {
            method: "GET",
            headers: GHL_HEADERS,
          },
        );

        const getBody = await getResponse.json().catch(() => null);

        if (!getResponse.ok) {
          console.error(
            "GoHighLevel contact fetch failed:",
            getResponse.status,
            JSON.stringify(getBody, null, 2),
          );
          logActivity({
            trigger: "no-show-job",
            mindbodyClientId: visit.ClientId,
            ghlContactId: contactId,
            action: "Failed to fetch GHL contact for no-show update",
            status: "error",
          });
          skipped += 1;
          continue;
        }

        const existingTags =
          (getBody && getBody.contact && getBody.contact.tags) || [];
        const mergedTags = Array.from(new Set([...existingTags, "mb-no-show"]));

        const existingCustomFields =
          (getBody && getBody.contact && getBody.contact.customFields) || [];
        const existingCountField = existingCustomFields.find(
          (field) => field.id === "7vWHhHXGCARUqcwBTTle",
        );
        const parsedExistingCount = Number(
          existingCountField && existingCountField.value,
        );
        const currentCount = Number.isFinite(parsedExistingCount)
          ? parsedExistingCount
          : 0;

        const updateResponse = await fetchWithRetry(
          `${GHL_API_BASE_URL}/contacts/${contactId}`,
          {
            method: "PUT",
            headers: GHL_HEADERS,
            body: JSON.stringify({
              tags: mergedTags,
              customFields: [
                {
                  id: "HYW1iODs9HgKuVF9gNKx",
                  key: "mb_last_noshow_date",
                  fieldValue: yesterday,
                },
                {
                  id: "ZLZ7nHX851siZ7Wn9VhA",
                  key: "mb_last_noshow_class",
                  fieldValue: toSafeString(className),
                },
                {
                  id: "7vWHhHXGCARUqcwBTTle",
                  key: "mb_noshow_count",
                  fieldValue: currentCount + 1,
                },
              ],
            }),
          },
        );

        const updateBody = await updateResponse.json().catch(() => null);

        if (!updateResponse.ok) {
          console.error(
            "GoHighLevel no-show contact update failed:",
            updateResponse.status,
            JSON.stringify(updateBody, null, 2),
          );
          logActivity({
            trigger: "no-show-job",
            mindbodyClientId: visit.ClientId,
            ghlContactId: contactId,
            action: "Failed to apply mb-no-show tag",
            status: "error",
          });
          skipped += 1;
          continue;
        }

        console.log(
          `GoHighLevel contact updated for no-show (id: ${contactId}, new count: ${currentCount + 1}):`,
          JSON.stringify(updateBody, null, 2),
        );
        logActivity({
          trigger: "no-show-job",
          mindbodyClientId: visit.ClientId,
          ghlContactId: contactId,
          action: "Applied mb-no-show tag",
          status: "success",
        });
        contactsUpdated += 1;
      } catch (error) {
        console.error("Error calling GoHighLevel API:", error);
        logActivity({
          trigger: "no-show-job",
          mindbodyClientId: visit.ClientId,
          ghlContactId: contactId,
          action: "Error applying mb-no-show tag",
          status: "error",
        });
        skipped += 1;
      }
    }

    // Small pause between classes so this job doesn't fire requests back
    // to back as fast as possible.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(
    `No-show job summary: ${classes.length} class(es) checked, ${noShowsFound} no-show(s) found, ${contactsUpdated} contact(s) updated, ${skipped} skipped.`,
  );
}

/**
 * Fetches every GoHighLevel contact that has a mindbody_client_id custom
 * field set at all (i.e. every contact synced from Mindbody), paginating
 * through /contacts/search until an empty page comes back.
 */
async function getAllContactsWithMindbodyId() {
  const allContacts = [];
  let page = 1;
  const pageLimit = 100;

  while (true) {
    const response = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/search`, {
      method: "POST",
      headers: GHL_HEADERS,
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        page,
        pageLimit,
        filters: [
          { field: "customFields.LRTn7qgpgX6HMVR8f6zd", operator: "exists" },
        ],
      }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(
        "GoHighLevel contact search failed:",
        response.status,
        JSON.stringify(body, null, 2),
      );
      break;
    }

    const contacts = (body && body.contacts) || [];

    if (contacts.length === 0) {
      break;
    }

    allContacts.push(...contacts);
    page += 1;
  }

  return allContacts;
}

/**
 * Extracts a single custom field's value from a GHL contact object already
 * fetched via getAllContactsWithMindbodyId(). Returns null if the contact
 * has no such field.
 */
function getContactCustomFieldValue(contact, fieldId) {
  const customFields = (contact && contact.customFields) || [];
  const field = customFields.find((f) => f.id === fieldId);
  return field ? field.value : null;
}

/**
 * Extracts the mindbody_client_id custom field value from a GHL contact
 * object already fetched via getAllContactsWithMindbodyId(). Returns null
 * if the contact has no such field.
 */
function getContactMindbodyClientId(contact) {
  return getContactCustomFieldValue(contact, "LRTn7qgpgX6HMVR8f6zd");
}

/**
 * Checks whether a GHL contact has any linked Membership record with
 * membership_status === 'active'. Same logic as the membership check inside
 * handleFirstClassCompleted in server.js, duplicated here as a standalone
 * function since these two files are meant to stay independent.
 */
async function hasActiveMembership(contactId) {
  try {
    const relationsResponse = await fetchWithRetry(
      `${GHL_API_BASE_URL}/associations/relations/${contactId}?locationId=${GHL_LOCATION_ID}`,
      { method: "GET", headers: GHL_HEADERS },
    );

    const relationsBody = await relationsResponse.json().catch(() => null);

    if (!relationsResponse.ok) {
      console.error(
        "GoHighLevel relations fetch failed:",
        relationsResponse.status,
        JSON.stringify(relationsBody, null, 2),
      );
      return false;
    }

    // Logging the raw shape, so we can confirm the response structure
    // before relying on it below (same diagnostic as server.js).
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
        (relation) =>
          relation.firstObjectKey === MEMBERSHIP_OBJECT_KEY ||
          relation.secondObjectKey === MEMBERSHIP_OBJECT_KEY,
      )
      .map((relation) =>
        relation.firstRecordId === contactId
          ? relation.secondRecordId
          : relation.firstRecordId,
      );

    for (const membershipRecordId of membershipRecordIds) {
      const membershipResponse = await fetchWithRetry(
        `${GHL_API_BASE_URL}/objects/${MEMBERSHIP_OBJECT_KEY}/records/${membershipRecordId}?locationId=${GHL_LOCATION_ID}`,
        { method: "GET", headers: GHL_HEADERS },
      );

      const membershipBody = await membershipResponse.json().catch(() => null);

      if (!membershipResponse.ok) {
        console.error(
          "GoHighLevel membership record fetch failed:",
          membershipResponse.status,
          JSON.stringify(membershipBody, null, 2),
        );
        continue;
      }

      const membershipStatus =
        membershipBody &&
        membershipBody.record &&
        membershipBody.record.properties &&
        membershipBody.record.properties.membership_status;

      if (membershipStatus === "active") {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error("Error calling GoHighLevel API:", error);
    return false;
  }
}

// The clientvisits response's exact shape hasn't been verified yet, so we
// only dump it to the console once per process run, the first time it's
// fetched — purely as a debugging aid.
let hasLoggedRawClientVisitsResponse = false;

/**
 * Finds a Mindbody client's most recent visit, returned as a Luxon DateTime
 * (parsed in STUDIO_TIMEZONE). Returns null if the client has no visits at
 * all.
 */
async function getLastVisitDate(mindbodyClientId) {
  const url = `${MINDBODY_API_BASE_URL}/client/clientvisits?ClientId=${mindbodyClientId}`;

  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: MINDBODY_HEADERS,
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    console.error(
      "Mindbody client visits fetch failed:",
      response.status,
      JSON.stringify(body, null, 2),
    );
    return null;
  }

  if (!hasLoggedRawClientVisitsResponse) {
    console.dir(body, { depth: null });
    hasLoggedRawClientVisitsResponse = true;
  }

  // Defensive: use `Visits` if present, otherwise assume the response body
  // itself is the array — same pattern as getClassVisits.
  const visits = Array.isArray(body && body.Visits)
    ? body.Visits
    : Array.isArray(body)
      ? body
      : [];

  if (visits.length === 0) {
    return null;
  }

  let mostRecentVisitDate = null;

  for (const visit of visits) {
    if (!visit.StartDateTime) {
      continue;
    }

    const visitDate = DateTime.fromISO(visit.StartDateTime, {
      zone: STUDIO_TIMEZONE,
    });

    if (!mostRecentVisitDate || visitDate > mostRecentVisitDate) {
      mostRecentVisitDate = visitDate;
    }
  }

  return mostRecentVisitDate;
}

/**
 * The inactive-member detection job: finds every GHL contact synced from
 * Mindbody that has no active membership and hasn't visited in 90+ days
 * (or has never visited at all), and tags them mb-inactive-member.
 */
async function runInactiveMemberJob() {
  console.log(`Running inactive-member job (studio timezone: ${STUDIO_TIMEZONE})`);

  const contacts = await getAllContactsWithMindbodyId();
  const now = DateTime.now().setZone(STUDIO_TIMEZONE);

  let noMindbodyId = 0;
  let skippedActiveMembership = 0;
  let skippedRecentVisit = 0;
  let skippedTooNew = 0;
  let taggedInactive = 0;
  let errored = 0;

  for (const contact of contacts) {
    const mindbodyClientId = getContactMindbodyClientId(contact);

    if (!mindbodyClientId) {
      console.warn(
        `GHL contact ${contact.id} has no mindbody_client_id — skipping`,
      );
      logActivity({
        trigger: "inactive-member-job",
        mindbodyClientId: null,
        ghlContactId: contact.id,
        action: "GHL contact has no mindbody_client_id, skipped",
        status: "error",
      });
      noMindbodyId += 1;
      continue;
    }

    try {
      const isActiveMember = await hasActiveMembership(contact.id);

      if (isActiveMember) {
        console.log(
          `Contact ${contact.id} (mindbody client ${mindbodyClientId}) has an active membership — skipping`,
        );
        logActivity({
          trigger: "inactive-member-job",
          mindbodyClientId,
          ghlContactId: contact.id,
          action: "Has active membership, skipped inactive check",
          status: "success",
        });
        skippedActiveMembership += 1;
        continue;
      }

      const lastVisitDate = await getLastVisitDate(mindbodyClientId);

      if (lastVisitDate === null) {
        // Zero visits ever — but a brand-new signup also has zero visits.
        // Only treat this as "inactive" if their Mindbody account itself is
        // old enough for zero visits to actually be meaningful.
        const creationDateValue = getContactCustomFieldValue(
          contact,
          "l9KGKwvV0Ehgjc6aP6bK",
        );
        const creationDate = creationDateValue
          ? DateTime.fromISO(String(creationDateValue), {
              zone: STUDIO_TIMEZONE,
            })
          : null;
        const daysSinceCreation =
          creationDate && creationDate.isValid
            ? now.diff(creationDate, "days").days
            : null;

        if (daysSinceCreation === null || daysSinceCreation < 90) {
          console.log(
            `Contact ${contact.id} (mindbody client ${mindbodyClientId}) has zero visits but is too new to judge (mindbody_creation_date: ${creationDateValue || "missing"}) — skipping`,
          );
          logActivity({
            trigger: "inactive-member-job",
            mindbodyClientId,
            ghlContactId: contact.id,
            action: "Zero visits but too new to judge, skipped",
            status: "success",
          });
          skippedTooNew += 1;
          continue;
        }
        // Else: account is 90+ days old with zero visits — falls through
        // and is tagged inactive below, same as a lapsed visitor.
      } else {
        const daysSinceLastVisit = now.diff(lastVisitDate, "days").days;

        if (daysSinceLastVisit < 90) {
          console.log(
            `Contact ${contact.id} (mindbody client ${mindbodyClientId}) visited ${Math.floor(daysSinceLastVisit)} day(s) ago — skipping`,
          );
          logActivity({
            trigger: "inactive-member-job",
            mindbodyClientId,
            ghlContactId: contact.id,
            action: "Recent visit, skipped inactive tagging",
            status: "success",
          });
          skippedRecentVisit += 1;
          continue;
        }
      }

      // We need the contact's current tags so the update doesn't clobber
      // whatever tags are already on it.
      const getResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/${contact.id}`, {
        method: "GET",
        headers: GHL_HEADERS,
      });

      const getBody = await getResponse.json().catch(() => null);

      if (!getResponse.ok) {
        console.error(
          "GoHighLevel contact fetch failed:",
          getResponse.status,
          JSON.stringify(getBody, null, 2),
        );
        logActivity({
          trigger: "inactive-member-job",
          mindbodyClientId,
          ghlContactId: contact.id,
          action: "Failed to fetch GHL contact for inactive tagging",
          status: "error",
        });
        continue;
      }

      const existingTags =
        (getBody && getBody.contact && getBody.contact.tags) || [];
      const mergedTags = Array.from(
        new Set([...existingTags, "mb-inactive-member"]),
      );

      const updateResponse = await fetchWithRetry(
        `${GHL_API_BASE_URL}/contacts/${contact.id}`,
        {
          method: "PUT",
          headers: GHL_HEADERS,
          body: JSON.stringify({ tags: mergedTags }),
        },
      );

      const updateBody = await updateResponse.json().catch(() => null);

      if (!updateResponse.ok) {
        console.error(
          "GoHighLevel inactive-member tag update failed:",
          updateResponse.status,
          JSON.stringify(updateBody, null, 2),
        );
        logActivity({
          trigger: "inactive-member-job",
          mindbodyClientId,
          ghlContactId: contact.id,
          action: "Failed to apply mb-inactive-member tag",
          status: "error",
        });
        continue;
      }

      console.log(
        `GoHighLevel contact tagged mb-inactive-member (id: ${contact.id}, mindbody client ${mindbodyClientId})`,
      );
      logActivity({
        trigger: "inactive-member-job",
        mindbodyClientId,
        ghlContactId: contact.id,
        action: "Applied mb-inactive-member tag",
        status: "success",
      });
      taggedInactive += 1;
    } catch (error) {
      console.error(
        `Error processing contact ${contact.id} (mindbody client ${mindbodyClientId}):`,
        error,
      );
      logActivity({
        trigger: "inactive-member-job",
        mindbodyClientId,
        ghlContactId: contact.id,
        action: "Error processing contact for inactive tagging",
        status: "error",
      });
      errored += 1;
    }

    // Small pause between contacts so this job doesn't fire requests back
    // to back as fast as possible.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  console.log(
    `Inactive-member job summary: ${contacts.length} contact(s) checked, ${skippedActiveMembership} skipped (active membership), ${skippedRecentVisit} skipped (recent visit), ${skippedTooNew} skipped (too new), ${taggedInactive} newly tagged inactive, ${noMindbodyId} had no mindbody_client_id, ${errored} errored.`,
  );
}

if (require.main === module) {
  const jobName = process.argv[2];
  if (jobName === "inactive-member") {
    runInactiveMemberJob().catch((err) => {
      console.error("Inactive member job failed:", err);
      process.exit(1);
    });
  } else {
    runNoShowJob().catch((err) => {
      console.error("No-show job failed:", err);
      process.exit(1);
    });
  }
}

module.exports = { runNoShowJob, runInactiveMemberJob };
