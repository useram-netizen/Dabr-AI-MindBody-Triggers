// migration.js
//
// One-time (rerunnable) backfill: creates a GoHighLevel contact for every
// pre-existing Mindbody client that predates the webhook going live (only
// clients created AFTER the webhook was wired up have been auto-created by
// server.js so far). Standalone from server.js and scheduled-jobs.js —
// shares their .env, but nothing else is imported.
//
// Usage:
//   node migration.js --site 5744518 --limit 500

require("dotenv").config();

const fs = require("fs");
const path = require("path");

// --- Env var checks ---------------------------------------------------
// Mindbody's client-list endpoint needs a staff access token, which is
// obtained via Username/Password (the /usertoken/issue endpoint) — this is
// separate from MINDBODY_API_KEY/SITE_ID, which server.js and
// scheduled-jobs.js use for their own (different) API calls.
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY;
const MINDBODY_STAFF_USERNAME = process.env.MINDBODY_STAFF_USERNAME;
const MINDBODY_STAFF_PASSWORD = process.env.MINDBODY_STAFF_PASSWORD;

if (!MINDBODY_API_KEY) {
  console.error("Missing MINDBODY_API_KEY in .env — refusing to run.");
  process.exit(1);
}

if (!MINDBODY_STAFF_USERNAME || !MINDBODY_STAFF_PASSWORD) {
  console.error(
    "Missing MINDBODY_STAFF_USERNAME and/or MINDBODY_STAFF_PASSWORD in .env — refusing to run.",
  );
  process.exit(1);
}

const GHL_API_TOKEN = process.env.GHL_API_TOKEN;

if (!GHL_API_TOKEN) {
  console.error("Missing GHL_API_TOKEN in .env — refusing to run.");
  process.exit(1);
}

// Same GoHighLevel location used throughout the rest of this project.
const GHL_LOCATION_ID = "WAhdYoo8o5RyZH6nek1I";

const GHL_API_BASE_URL = "https://services.leadconnectorhq.com";
const MINDBODY_API_BASE_URL = "https://api.mindbodyonline.com/public/v6";

// Headers required on every GoHighLevel API call.
const GHL_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Version: "v3",
  Authorization: `Bearer ${GHL_API_TOKEN}`,
};

// The two Mindbody sites this studio operates across.
const MIGRATION_SITES = [5744518, 5755023];

// Location IDs overlap across sites (both have a location with Id: 1), so
// the tag mapping is keyed by site AND home-location together.
const SITE_LOCATION_TAGS = {
  "5744518": { "1": "mb-location-albertson", "2": "mb-location-east-meadow" },
  "5755023": { "1": "mb-location-fresh-meadows" },
};

function getLocationTag(siteId, homeLocationId) {
  const siteMap = SITE_LOCATION_TAGS[toSafeString(siteId)];
  if (!siteMap) return null;
  return siteMap[toSafeString(homeLocationId)] ?? null;
}

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
 * onward.
 */
function toDateOnly(dateTimeString) {
  if (!dateTimeString) {
    return "";
  }
  return String(dateTimeString).split("T")[0];
}

// --- Mindbody access token caching -------------------------------------
// Same pattern as D:\dabrai\server.js: fetch a staff access token on demand
// and cache it in memory until it's about to expire. Tokens are
// site-specific, so the cache is keyed per site ID.
const tokenCacheBySite = {}; // { [siteId]: { token, expiresAt } }

async function getMindbodyAccessToken(siteId) {
  const cached = tokenCacheBySite[siteId];
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const response = await fetchWithRetry(
    `${MINDBODY_API_BASE_URL}/usertoken/issue`,
    {
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
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Mindbody access token: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();
  const token = data.AccessToken;

  // Decode the JWT's payload (the middle segment) to read its real "exp"
  // claim, rather than assuming a fixed lifetime.
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64").toString(),
  );

  const expiresAt = payload.exp * 1000;
  tokenCacheBySite[siteId] = { token, expiresAt };

  console.log(
    `Fetched new Mindbody access token for site ${siteId}, expires at ${new Date(expiresAt).toISOString()}`,
  );

  return token;
}

/**
 * Fetches one page of Mindbody clients for a site. Handles a 401 by
 * refreshing the cached token and retrying exactly once, same as
 * D:\dabrai\server.js.
 */
async function fetchMindbodyClientsPage(siteId, limit, offset) {
  const url = `${MINDBODY_API_BASE_URL}/client/clients?Limit=${limit}&Offset=${offset}`;

  let accessToken = await getMindbodyAccessToken(siteId);

  const headers = () => ({
    "Api-Key": MINDBODY_API_KEY,
    SiteId: String(siteId),
    Authorization: `Bearer ${accessToken}`,
  });

  let response = await fetchWithRetry(url, { method: "GET", headers: headers() });

  if (response.status === 401) {
    console.warn(
      "Mindbody API returned 401 — refreshing access token and retrying once.",
    );
    delete tokenCacheBySite[siteId];
    accessToken = await getMindbodyAccessToken(siteId);
    response = await fetchWithRetry(url, { method: "GET", headers: headers() });
  }

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `Mindbody client list fetch failed: ${response.status} ${JSON.stringify(body)}`,
    );
  }

  return (body && body.Clients) || [];
}

// --- One-time sample fetch (step 1) -------------------------------------
// Prints one real client's raw JSON so field names can be confirmed before
// any mapping code is written. Not part of the normal migration run — kept
// here for reference/re-verification if Mindbody's schema ever changes.
async function printSampleClient(siteId) {
  const clients = await fetchMindbodyClientsPage(siteId, 1, 0);
  const sampleClient = clients[0];
  console.log(`Sample client from site ${siteId}:`);
  console.dir(sampleClient, { depth: null });
  return sampleClient;
}

/**
 * Looks up whether a GHL contact already exists for this Mindbody client,
 * by the mindbody_client_id custom field. Duplicated locally from
 * server.js's findGHLContactByMindbodyClientId — same logic, kept
 * independent per-file on purpose.
 */
async function findGHLContactByMindbodyClientId(clientId) {
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
    throw new Error(
      `GoHighLevel contact search failed: ${searchResponse.status} ${JSON.stringify(searchBody)}`,
    );
  }

  const contacts = (searchBody && searchBody.contacts) || [];
  return contacts.length > 0 ? contacts[0].id : null;
}

/**
 * Builds the GHL contact payload from a raw Mindbody client/clients record.
 *
 * Field names below were confirmed against a real client/clients response
 * (via printSampleClient) before writing this — the client/clients
 * endpoint uses capitalized field names (Id, FirstName, BirthDate, ...),
 * unlike the lowercase webhook eventData names used in server.js's
 * buildContactPayload. HomeLocation is a nested object here (not a bare ID
 * like the webhook's homeLocation), so its Id is pulled out explicitly.
 *
 * One gap: the webhook's eventData.leadChannelId has no equivalent on this
 * REST endpoint — that concept only exists on certain webhook event
 * payloads, not on the client entity itself — so mindbody_lead_channel_id
 * is left blank for migrated clients rather than guessing a source field.
 */
function buildMigrationContactPayload(client, siteId) {
  const homeLocationId = client.HomeLocation && client.HomeLocation.Id;
  const locationTag = getLocationTag(siteId, homeLocationId);
  const tags = locationTag ? ["mindbody", locationTag] : ["mindbody"];

  return {
    firstName: client.FirstName,
    lastName: client.LastName,
    // Guard against a null FirstName/LastName producing a literal "null"
    // in the combined name.
    name: `${toSafeString(client.FirstName)} ${toSafeString(client.LastName)}`.trim(),
    email: client.Email,
    phone: client.MobilePhone,
    address1: client.AddressLine1,
    city: client.City,
    state: client.State,
    postalCode: client.PostalCode,
    country: "US",
    dateOfBirth: toDateOnly(client.BirthDate),
    locationId: GHL_LOCATION_ID,
    source: "mindbody",
    tags,
    customFields: [
      { id: "LRTn7qgpgX6HMVR8f6zd", key: "mindbody_client_id", fieldValue: toSafeString(client.Id) },
      { id: "BS1lWuBcmo3ZyWnCA2mr", key: "mindbody_unique_id", fieldValue: toSafeString(client.UniqueId) },
      { id: "BREWxivlCEYv67Y1rPCa", key: "mindbody_status", fieldValue: toSafeString(client.Status) },
      { id: "l9KGKwvV0Ehgjc6aP6bK", key: "mindbody_creation_date", fieldValue: toSafeString(client.CreationDate) },
      { id: "ZuELR70PXP89mbEULdia", key: "mindbody_birth_date", fieldValue: toSafeString(client.BirthDate) },
      { id: "TtjLkyY4382fnIXKEOit", key: "mindbody_home_location", fieldValue: toSafeString(homeLocationId) },
      { id: "FCPq5xu60vqGaYxhm27W", key: "mindbody_is_prospect", fieldValue: client.IsProspect ? "Yes" : "No" },
      { id: "gYUo2TAeqDaRQMZVsIAm", key: "mindbody_referred_by", fieldValue: toSafeString(client.ReferredBy) },
      { id: "S23LRNvmCQ1HbDq6nYXH", key: "mindbody_lead_channel_id", fieldValue: "" },
    ],
  };
}

// --- Progress tracking (resumability) ------------------------------------
const PROGRESS_FILE_PATH = path.join(__dirname, "migration-progress.json");

function loadProgress() {
  try {
    const raw = fs.readFileSync(PROGRESS_FILE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    console.warn(
      `Could not read ${PROGRESS_FILE_PATH} (${error.message}) — starting from a fresh progress record.`,
    );
    return {};
  }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE_PATH, JSON.stringify(progress, null, 2));
}

/**
 * Runs the migration for one site: fetches clients starting from the saved
 * offset, dedup-checks each against GHL, creates a contact if missing, and
 * persists progress so a rerun resumes rather than restarting from zero.
 */
async function runMigration(siteId, limit) {
  const progress = loadProgress();
  const siteKey = toSafeString(siteId);
  let offset = (progress[siteKey] && progress[siteKey].offset) || 0;

  console.log(
    `Running migration for site ${siteId}, limit ${limit}, starting at offset ${offset}`,
  );

  let totalFetched = 0;
  let created = 0;
  let skippedDuplicate = 0;
  let errored = 0;
  let processedThisRun = 0;
  let offsetIsStillAdvanceable = true;

  while (processedThisRun < limit) {
    const pageLimit = Math.min(200, limit - processedThisRun);
    const clients = await fetchMindbodyClientsPage(siteId, pageLimit, offset + processedThisRun);

    if (clients.length === 0) {
      console.log(`No more clients returned for site ${siteId} — stopping.`);
      break;
    }

    for (const client of clients) {
      if (processedThisRun >= limit) {
        break;
      }

      totalFetched += 1;
      const clientId = client.Id;

      try {
        const existingContactId = await findGHLContactByMindbodyClientId(clientId);

        if (existingContactId) {
          console.log(`Duplicate — mindbody client ${clientId} already exists as GHL contact ${existingContactId}, skipping`);
          skippedDuplicate += 1;
        } else {
          const payload = buildMigrationContactPayload(client, siteId);

          const createResponse = await fetchWithRetry(`${GHL_API_BASE_URL}/contacts/`, {
            method: "POST",
            headers: GHL_HEADERS,
            body: JSON.stringify(payload),
          });

          const createBody = await createResponse.json().catch(() => null);

          if (!createResponse.ok) {
            throw new Error(
              `GoHighLevel contact creation failed: ${createResponse.status} ${JSON.stringify(createBody)}`,
            );
          }

          const newContactId = createBody && createBody.contact && createBody.contact.id;
          console.log(`Created — mindbody client ${clientId} -> GHL contact ${newContactId}`);
          created += 1;
        }

        processedThisRun += 1;

        if (offsetIsStillAdvanceable) {
          offset += 1;
          saveProgress({ ...progress, [siteKey]: { offset } });
        }
      } catch (error) {
        console.error(`Errored — mindbody client ${clientId}:`, error.message || error);
        errored += 1;
        processedThisRun += 1;
        // Freeze the saved offset right here so a rerun retries this exact
        // client — later successes in this same run must not advance past
        // an unresolved failure.
        offsetIsStillAdvanceable = false;
      }

      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  console.log(
    `Migration summary for site ${siteId}: ${totalFetched} fetched, ${created} created, ${skippedDuplicate} skipped as duplicate, ${errored} errored.`,
  );
}

// --- CLI -----------------------------------------------------------------
function parseCliArgs(argv) {
  const args = { limit: 500 };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--site") {
      args.site = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--limit") {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
  }

  return args;
}

function printUsageAndExit() {
  console.error("Usage: node migration.js --site <siteId> [--limit <n>]");
  console.error(`  --site must be one of: ${MIGRATION_SITES.join(", ")}`);
  console.error("  --limit defaults to 500");
  process.exit(1);
}

if (require.main === module) {
  const args = parseCliArgs(process.argv.slice(2));

  if (!args.site || !MIGRATION_SITES.includes(args.site)) {
    printUsageAndExit();
  }

  runMigration(args.site, args.limit).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}

module.exports = { runMigration, printSampleClient, getLocationTag };
