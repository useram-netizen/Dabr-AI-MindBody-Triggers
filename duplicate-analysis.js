// duplicate-analysis.js
//
// Read-only diagnostic: does NOT touch GHL at all, and does not modify
// anything in Mindbody either — it only fetches client lists and analyzes
// them locally, to determine whether "duplicate contact" errors seen during
// migration trace back to genuine duplicate client records within
// Mindbody's own data (same email or phone on multiple different Ids),
// rather than anything in migration.js or the webhook code.
//
// Usage:
//   node duplicate-analysis.js
// Runs both sites by default, one after another, each producing its own
// console summary and its own duplicate-analysis-{siteLabel}.json file.

require("dotenv").config();

const fs = require("fs");
const path = require("path");

// --- Env var checks ------------------------------------------------------
// Same Mindbody staff-token credentials migration.js uses. No GHL_API_TOKEN
// check here — this file never calls GHL.
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

const MINDBODY_API_BASE_URL = "https://api.mindbodyonline.com/public/v6";

// The sites to analyze, each with a human-readable label used in console
// output and output filenames.
const SITES = [
  { siteId: 5744518, siteLabel: "albertson-eastmeadow" },
  { siteId: 5755023, siteLabel: "freshmeadows" },
];

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
 * refreshing the cached token and retrying exactly once, same pattern as
 * migration.js.
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

/**
 * Fetches every client for a site, paginating 200 at a time until an empty
 * page comes back. A 150ms delay between PAGE calls (not per-client) is
 * plenty here, since this never touches GHL and each call already returns
 * up to 200 clients at once.
 */
async function fetchAllClients(siteId) {
  const allClients = [];
  let offset = 0;
  const pageLimit = 200;

  while (true) {
    const clients = await fetchMindbodyClientsPage(siteId, pageLimit, offset);

    if (clients.length === 0) {
      break;
    }

    allClients.push(...clients);
    offset += clients.length;

    console.log(`  fetched ${allClients.length} client(s) so far from site ${siteId}...`);

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return allClients;
}

/**
 * Normalizes an email for comparison: lowercase + trimmed. Returns null for
 * a missing/empty email (such clients are excluded from the email-based
 * duplicate check entirely).
 */
function normalizeEmail(email) {
  if (!email || typeof email !== "string") {
    return null;
  }
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes a phone number for comparison: digits only, all formatting
 * (spaces, dashes, parens, country-code +, etc.) stripped. Returns null for
 * a missing/empty phone (such clients are excluded from the phone-based
 * duplicate check entirely).
 */
function normalizePhone(phone) {
  if (!phone || typeof phone !== "string") {
    return null;
  }
  const digitsOnly = phone.replace(/\D/g, "");
  return digitsOnly.length > 0 ? digitsOnly : null;
}

// A small, JSON-friendly snapshot of a client, used in the detailed
// duplicate-group output file (not the full raw record — just enough to
// identify and eyeball each case).
function toClientSummary(client) {
  return {
    Id: client.Id,
    FirstName: client.FirstName,
    LastName: client.LastName,
    Email: client.Email,
    MobilePhone: client.MobilePhone,
    Status: client.Status,
    CreationDate: client.CreationDate,
  };
}

/**
 * Analyzes a site's full client list for duplicate emails/phones, prints a
 * labeled console summary, and writes the detailed duplicate groups to
 * duplicate-analysis-{siteLabel}.json.
 */
function analyzeDuplicates(clients, siteLabel) {
  const emailMap = new Map(); // normalizedEmail -> [client, ...]
  const phoneMap = new Map(); // normalizedPhone -> [client, ...]

  for (const client of clients) {
    const email = normalizeEmail(client.Email);
    if (email) {
      if (!emailMap.has(email)) emailMap.set(email, []);
      emailMap.get(email).push(client);
    }

    const phone = normalizePhone(client.MobilePhone);
    if (phone) {
      if (!phoneMap.has(phone)) phoneMap.set(phone, []);
      phoneMap.get(phone).push(client);
    }
  }

  const emailDuplicateEntries = [...emailMap.entries()].filter(([, group]) => group.length > 1);
  const phoneDuplicateEntries = [...phoneMap.entries()].filter(([, group]) => group.length > 1);

  const emailDuplicateClientCount = emailDuplicateEntries.reduce((sum, [, group]) => sum + group.length, 0);
  const phoneDuplicateClientCount = phoneDuplicateEntries.reduce((sum, [, group]) => sum + group.length, 0);

  const involvedClientIds = new Set();
  for (const [, group] of emailDuplicateEntries) {
    for (const client of group) involvedClientIds.add(client.Id);
  }
  for (const [, group] of phoneDuplicateEntries) {
    for (const client of group) involvedClientIds.add(client.Id);
  }

  console.log(`\n=== Duplicate analysis: ${siteLabel} ===`);
  console.log(`Total clients analyzed: ${clients.length}`);
  console.log(
    `Emails with 2+ clients attached: ${emailDuplicateEntries.length} unique email(s), involving ${emailDuplicateClientCount} client(s) total`,
  );
  console.log(
    `Phones with 2+ clients attached: ${phoneDuplicateEntries.length} unique phone(s), involving ${phoneDuplicateClientCount} client(s) total`,
  );
  console.log(
    `Distinct clients involved in at least one duplicate (by email OR phone): ${involvedClientIds.size}`,
  );

  const outputPath = path.join(__dirname, `duplicate-analysis-${siteLabel}.json`);

  const output = {
    siteLabel,
    totalClientsAnalyzed: clients.length,
    summary: {
      emailDuplicateGroups: emailDuplicateEntries.length,
      emailDuplicateClientCount,
      phoneDuplicateGroups: phoneDuplicateEntries.length,
      phoneDuplicateClientCount,
      distinctClientsInvolvedInAnyDuplicate: involvedClientIds.size,
    },
    emailDuplicates: emailDuplicateEntries
      .sort((a, b) => b[1].length - a[1].length)
      .map(([email, group]) => ({
        email,
        clientCount: group.length,
        clients: group.map(toClientSummary),
      })),
    phoneDuplicates: phoneDuplicateEntries
      .sort((a, b) => b[1].length - a[1].length)
      .map(([phone, group]) => ({
        phone,
        clientCount: group.length,
        clients: group.map(toClientSummary),
      })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Detailed duplicate groups written to ${outputPath}`);

  return output;
}

async function main() {
  for (const { siteId, siteLabel } of SITES) {
    console.log(`\nFetching all clients for site ${siteId} (${siteLabel})...`);
    const clients = await fetchAllClients(siteId);
    analyzeDuplicates(clients, siteLabel);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Duplicate analysis failed:", err);
    process.exit(1);
  });
}

module.exports = { fetchAllClients, analyzeDuplicates, normalizeEmail, normalizePhone };
