#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const USER_AGENT = "VerdalFlagDownloader/1.0 (daniel.mcassey@gmail.com)";

const OUTPUT_DIR = path.resolve("public/flags");

const REQUEST_DELAY_MS = 1500;
const BETWEEN_COUNTRIES_DELAY_MS = 3000;
const MAX_DOWNLOAD_ATTEMPTS = 8;
const MAX_METADATA_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 120_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Officially withdrawn / formerly-used ISO 3166-1 alpha-2 codes. The country and
// territory passes intentionally include deprecated-rank P297 values so that
// legitimately deprecated-but-current codes (e.g. EH Western Sahara, held by the
// SADR item) are not lost. The side effect is that genuinely retired codes also
// leak in, because the items that carry them are not always tagged as dissolved
// (P576/P582) in Wikidata. Skipping the codes in this set removes the
// duplicates/zombies while keeping EH et al:
//   BU -> MM (Myanmar/Burma)        TP -> TL (East Timor/Timor-Leste)
//   AN -> dissolved (Netherlands Antilles, split into BQ/CW/SX)
//   plus the rest of the ISO 3166-1 "formerly used" register.
//
// This set is the OFFLINE FALLBACK. At runtime it is refreshed from Wikidata's
// ISO 3166-3 register (see getWithdrawnIso2Codes) so the list maintains itself
// as ISO retires/reassigns codes; the static copy is only used if that query
// fails. NOTE: do not add a code here that is still a current alpha-2 (e.g. "sk"
// is Slovakia) — that would drop a live country.
const FALLBACK_WITHDRAWN_ISO2_CODES = new Set([
  "an", // Netherlands Antilles (dissolved 2010)
  "bu", // Burma -> mm
  "cs", // Serbia and Montenegro / Czechoslovakia
  "ct", // Canton and Enderbury Islands
  "dd", // East Germany
  "dy", // Dahomey -> bj
  "fq", // French Southern and Antarctic Territories (old) -> tf
  "fx", // France, Metropolitan
  "hv", // Upper Volta -> bf
  "jt", // Johnston Island
  "mi", // Midway Islands
  "nh", // New Hebrides -> vu
  "nq", // Dronning Maud Land
  "nt", // Neutral Zone
  "pc", // Pacific Islands (Trust Territory)
  "pu", // US Miscellaneous Pacific Islands
  "pz", // Panama Canal Zone
  "rh", // Southern Rhodesia -> zw
  "su", // USSR
  "tp", // East Timor -> tl
  "vd", // North Vietnam
  "wk", // Wake Island
  "yd", // South Yemen
  "yu", // Yugoslavia
  "zr"  // Zaire -> cd
]);

// Resolved once at startup (see resolveWithdrawnIso2Codes). The download passes
// read this; it always contains at least the offline fallback above.
let WITHDRAWN_ISO2_CODES = FALLBACK_WITHDRAWN_ISO2_CODES;

// Territory ISO2 codes to skip entirely. UM (US Minor Outlying Islands) is a
// statistical grouping of uninhabited islands with no flag of its own — it only
// ever flies the US flag — so we exclude it rather than record a reference.
const EXCLUDED_TERRITORY_CODES = new Set(["um"]);

const args = new Set(process.argv.slice(2));

const SHOULD_DOWNLOAD_COUNTRIES = args.has("--countries") || args.size === 0;
const SHOULD_DOWNLOAD_TERRITORIES = args.has("--territories") || args.size === 0;
const SHOULD_DOWNLOAD_ORGANIZATIONS = args.has("--organizations") || args.size === 0;
const SHOULD_DOWNLOAD_SUBDIVISIONS = args.has("--subdivisions");
const SHOULD_DOWNLOAD_ALL_SUBDIVISIONS = args.has("--all-subdivisions");

const subdivisionCountryArg = process.argv.find((arg) =>
  arg.startsWith("--subdivision-country=")
);

const SUBDIVISION_COUNTRY_CODE = subdivisionCountryArg
  ? subdivisionCountryArg.split("=")[1]?.trim().toUpperCase()
  : "US";

function assertUserAgentConfigured() {
  if (
    USER_AGENT.includes("you@example.com") ||
    USER_AGENT.includes("YourAppName")
  ) {
    console.warn(
      "\nWARNING: Please update USER_AGENT with your app name and contact email before running this seriously.\n"
    );
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;

  const seconds = Number(headerValue);

  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(headerValue);

  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function getBackoffMs(attempt, retryAfterHeader) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);

  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  }

  const exponential = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = randomBetween(500, 2500);

  return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

function stripHtml(value) {
  if (!value) return "";

  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Turn an acronym / short name into a compact filename code, e.g.
// "U.N." -> "un", "NATO" -> "nato", "ASEAN" -> "asean". Returns "" if nothing
// usable remains.
function acronymToCode(value) {
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Pick the shortest short name from a "|"-separated GROUP_CONCAT, which is
// almost always the acronym (e.g. prefers "UN" over "United Nations").
function pickShortestShortName(shortNames) {
  if (!shortNames) return "";

  return shortNames
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => a.length - b.length)[0] ?? "";
}

function getFileTitleFromSpecialFilePath(fileUrl) {
  const rawName = decodeURIComponent(fileUrl.split("/").pop() ?? "");

  if (!rawName) {
    throw new Error(`Could not extract filename from URL: ${fileUrl}`);
  }

  return `File:${rawName}`;
}

function shouldRetryStatus(status) {
  return [403, 408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function fetchWithRetry(url, options, label, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(REQUEST_DELAY_MS);

    const res = await fetch(url, options);

    if (res.ok) {
      return res;
    }

    const body = await res.text().catch(() => "");

    if (shouldRetryStatus(res.status) && attempt < maxAttempts) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = getBackoffMs(attempt, retryAfter);

      console.warn(
        [
          `${label} got ${res.status} ${res.statusText}.`,
          `Attempt ${attempt}/${maxAttempts}.`,
          `Waiting ${Math.round(waitMs / 1000)}s before retrying.`,
          url.toString()
        ].join(" ")
      );

      if (body) {
        console.warn(body.slice(0, 500));
      }

      await sleep(waitMs);
      continue;
    }

    throw new Error(
      `${label} failed after ${attempt} attempt(s): ${res.status} ${res.statusText} ${url.toString()}\n${body}`
    );
  }

  throw new Error(`${label} failed unexpectedly: ${url.toString()}`);
}

async function fetchJson(url, label) {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Api-User-Agent": USER_AGENT,
        "Accept": "application/json"
      }
    },
    label,
    MAX_METADATA_ATTEMPTS
  );

  return res.json();
}

async function wikidataQuery(sparql) {
  const url = new URL("https://query.wikidata.org/sparql");
  url.searchParams.set("format", "json");
  url.searchParams.set("query", sparql);

  const json = await fetchJson(url, "Wikidata query");

  return json.results.bindings.map((row) => {
    const result = {};

    for (const [key, value] of Object.entries(row)) {
      result[key] = value.value;
    }

    return result;
  });
}

async function getCountriesWithIso2() {
  const sparql = `
SELECT DISTINCT ?country ?countryLabel ?iso2 WHERE {
  ?country wdt:P31/wdt:P279* wd:Q6256;
           wdt:P297 ?iso2.

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
ORDER BY ?iso2
`;

  return wikidataQuery(sparql);
}

// Derive the set of retired ISO 3166-1 alpha-2 codes from Wikidata's ISO 3166-3
// register (P773). An ISO 3166-3 code is 4 letters whose first two are the
// withdrawn alpha-2 (e.g. ANHH -> AN, BUMM -> BU, TPTL -> TP). A code is only
// treated as retired if no *living* entity (not dissolved via P576/P582) still
// holds it at truthy rank — that keeps reassigned codes such as BQ (formerly
// British Antarctic Territory, now Bonaire) and avoids ever dropping a current
// country.
async function getWithdrawnIso2Codes() {
  const sparql = `
SELECT DISTINCT ?former WHERE {
  ?old wdt:P773 ?iso3.
  BIND(LCASE(SUBSTR(?iso3, 1, 2)) AS ?former)
  FILTER(STRLEN(?former) = 2)

  # Keep codes that have since been reassigned to a country/territory that still
  # exists (e.g. BQ -> Bonaire); only those are excluded from the retired set.
  FILTER NOT EXISTS {
    ?cur wdt:P297 ?cur2.
    FILTER(LCASE(STR(?cur2)) = ?former)
    FILTER NOT EXISTS { ?cur wdt:P576 ?dissolved. }
    FILTER NOT EXISTS { ?cur wdt:P582 ?endTime. }
  }
}
ORDER BY ?former
`;

  const rows = await wikidataQuery(sparql);

  return new Set(rows.map((row) => row.former).filter(Boolean));
}

// Refresh WITHDRAWN_ISO2_CODES from Wikidata, falling back to the static set if
// the query fails or returns nothing usable.
async function resolveWithdrawnIso2Codes() {
  try {
    const fetched = await getWithdrawnIso2Codes();

    if (fetched.size === 0) {
      console.warn(
        "Withdrawn-code query returned no rows; using built-in fallback list."
      );
      return;
    }

    // Union with the fallback so the static list also covers any pre-1974 /
    // never-in-ISO-3166-3 codes the register omits.
    WITHDRAWN_ISO2_CODES = new Set([
      ...FALLBACK_WITHDRAWN_ISO2_CODES,
      ...fetched
    ]);

    console.log(
      `Loaded ${WITHDRAWN_ISO2_CODES.size} withdrawn ISO 3166-1 codes from Wikidata.`
    );
  } catch (error) {
    console.warn(
      `Could not refresh withdrawn-code list from Wikidata; using built-in fallback. (${error.message})`
    );
  }
}

async function getCommonsMetadata(fileTitle) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("titles", fileTitle);
  url.searchParams.set("iiprop", "url|user|extmetadata");

  const json = await fetchJson(url, `Commons metadata for ${fileTitle}`);

  const page = json.query?.pages?.[0];

  if (!page || page.missing) {
    throw new Error(`Commons file not found: ${fileTitle}`);
  }

  const imageInfo = page.imageinfo?.[0];

  if (!imageInfo) {
    throw new Error(`No imageinfo returned for: ${fileTitle}`);
  }

  const meta = imageInfo.extmetadata ?? {};

  return {
    title: fileTitle,
    objectName: stripHtml(meta.ObjectName?.value),
    commonsUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(fileTitle).replace(
      /%3A/i,
      ":"
    )}`,
    downloadUrl: imageInfo.url,
    descriptionUrl: imageInfo.descriptionurl,
    user: imageInfo.user,

    license: stripHtml(meta.LicenseShortName?.value),
    licenseUrl: stripHtml(meta.LicenseUrl?.value),
    usageTerms: stripHtml(meta.UsageTerms?.value),
    attributionRequired: stripHtml(meta.AttributionRequired?.value),
    copyrightStatus: stripHtml(meta.Copyrighted?.value),
    restrictions: stripHtml(meta.Restrictions?.value),

    artist: stripHtml(meta.Artist?.value),
    credit: stripHtml(meta.Credit?.value),
    attribution: stripHtml(meta.Attribution?.value)
  };
}

async function downloadFile(url, destination) {
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Api-User-Agent": USER_AGENT,
        "Accept": "image/svg+xml,image/*,*/*"
      }
    },
    "Download",
    MAX_DOWNLOAD_ATTEMPTS
  );

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destination, buffer);
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function readExistingAttribution() {
  const filePath = path.join(OUTPUT_DIR, "attribution.json");

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      generatedAt: null,
      countries: {},
      territories: {},
      organizations: {},
      subdivisions: {}
    };
  }
}

async function saveAttribution(attribution) {
  attribution.generatedAt = new Date().toISOString();
  await writeJson(path.join(OUTPUT_DIR, "attribution.json"), attribution);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFlag({
  fileUrl,
  outputFile,
  attributionKey,
  attributionBucket,
  extraAttribution = {}
}) {
  const fileTitle = getFileTitleFromSpecialFilePath(fileUrl);
  const metadata = await getCommonsMetadata(fileTitle);

  if (!metadata.downloadUrl.toLowerCase().endsWith(".svg")) {
    console.log(`Skipping non-SVG: ${fileTitle}`);
    return false;
  }

  await ensureDir(path.dirname(outputFile));

  const localFile = path.relative(process.cwd(), outputFile).replaceAll("\\", "/");

  if (await fileExists(outputFile)) {
    console.log(`Already exists, skipping: ${localFile}`);

    attributionBucket[attributionKey] = {
      ...extraAttribution,
      ...metadata,
      localFile
    };

    return true;
  }

  console.log(`Downloading ${metadata.title} -> ${localFile}`);

  await downloadFile(metadata.downloadUrl, outputFile);

  attributionBucket[attributionKey] = {
    ...extraAttribution,
    ...metadata,
    localFile
  };

  return true;
}

async function downloadCountryFlags(attribution) {
  console.log("\nFetching country flags...\n");

  // p:P297/ps:P297 instead of wdt:P297 to include deprecated-rank ISO codes.
  // Needed for e.g. SADR (Q40362), which holds the EH flag but whose P297="EH"
  // is marked deprecated because the territory item Q6250 is the primary EH entry.
  // Because deprecated P297 codes are now included, we must also filter out
  // dissolved / historical countries (Yugoslavia, USSR, etc.) whose codes were
  // previously suppressed by the wdt: truthy-rank shorthand.
  const sparql = `
SELECT DISTINCT ?country ?countryLabel ?iso2 ?flag WHERE {
  ?country wdt:P31/wdt:P279* wd:Q6256;
           p:P297/ps:P297 ?iso2;
           wdt:P41 ?flag.

  FILTER NOT EXISTS { ?country wdt:P576 ?dissolved. }
  FILTER NOT EXISTS { ?country wdt:P582 ?endTime. }
  MINUS { ?country wdt:P31/wdt:P279* wd:Q3024240. }  # historical country

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
ORDER BY ?iso2
`;

  const rows = await wikidataQuery(sparql);

  console.log(`Found ${rows.length} country flag rows.`);

  let downloaded = 0;
  let failed = 0;

  for (const row of rows) {
    const iso2 = row.iso2?.toLowerCase();

    if (!iso2) {
      console.log(`Skipping country without ISO2 code: ${row.countryLabel}`);
      continue;
    }

    if (WITHDRAWN_ISO2_CODES.has(iso2)) {
      console.log(`Skipping withdrawn ISO code: ${iso2} (${row.countryLabel})`);
      continue;
    }

    const outputFile = path.join(OUTPUT_DIR, "countries", `${iso2}.svg`);

    try {
      const didDownload = await downloadFlag({
        fileUrl: row.flag,
        outputFile,
        attributionKey: iso2,
        attributionBucket: attribution.countries,
        extraAttribution: {
          wikidataItem: row.country,
          label: row.countryLabel,
          iso2
        }
      });

      if (didDownload) downloaded++;
    } catch (error) {
      failed++;
      console.error(`Failed country flag: ${row.countryLabel} (${iso2})`);
      console.error(error.message);
    }

    await saveAttribution(attribution);
  }

  console.log(`\nDownloaded/skipped ${downloaded} country SVG flags.`);
  console.log(`Failed ${failed} country SVG flags.`);

  return {
    downloaded,
    failed
  };
}

// Build a map of sovereign-country ISO2 (lowercased) -> Set of every flag URL
// that country holds at any rank. Used by the territory pass to decide whether a
// territory flies its parent's flag rather than one of its own.
async function getCountryFlagSets() {
  const sparql = `
SELECT ?iso2 (GROUP_CONCAT(DISTINCT STR(?flag); separator="|") AS ?flags) WHERE {
  ?country wdt:P31/wdt:P279* wd:Q6256;
           wdt:P297 ?iso2;
           p:P41/ps:P41 ?flag.
}
GROUP BY ?iso2
`;

  const rows = await wikidataQuery(sparql);
  const map = new Map();

  for (const row of rows) {
    const iso2 = row.iso2?.toLowerCase();
    if (!iso2) continue;

    const flags = (row.flags || "").split("|").filter(Boolean);
    map.set(iso2, new Set(flags));
  }

  return map;
}

const splitConcat = (value) => (value || "").split("|").filter(Boolean);

// Proposed / unofficial flags (e.g. "Proposed flag of Réunion (VAR).svg") are not
// a territory's real flag, so they must never be picked as its own flag. A
// territory whose only distinct flag is such a design falls through to using its
// parent country's flag instead.
function isProposedOrUnofficialFlag(flagUrl) {
  const name = decodeURIComponent(flagUrl).toLowerCase();
  return name.includes("proposed") || name.includes("unofficial");
}

async function downloadTerritoryFlags(attribution) {
  console.log("\nFetching dependent / overseas territory flags...\n");

  // Catch all entities that hold an ISO 3166-1 alpha-2 code (P297) but are NOT
  // sovereign countries (Q6256) — those are already handled by the country pass.
  // A type whitelist was previously used here but it silently missed entities
  // whose Wikidata classification fell outside the list (e.g. AX Åland Islands,
  // EH Western Sahara, BQ Caribbean Netherlands). The catch-all approach is both
  // simpler and complete by construction.
  //
  // Flags are collected two ways and collapsed per territory:
  //   ?truthyFlag (wdt:P41)      -> the territory's current/best-rank flag(s)
  //   ?flag       (p:P41/ps:P41) -> every flag at any rank (incl. deprecated)
  // Many territories list their sovereign's flag under P41 (and sometimes a pile
  // of historical variants), so we can't just take "a flag". Instead we subtract
  // the parent country's flags (see getCountryFlagSets): whatever distinct flag
  // remains is the territory's own and gets downloaded; if nothing remains the
  // territory merely flies the parent's flag and we record `usesFlag: "<parent>"`
  // with no download. The parent is resolved via P17 -> that country's P297.
  const sparql = `
SELECT ?iso2
       (SAMPLE(?territory) AS ?item)
       (SAMPLE(?territoryLabel) AS ?label)
       (GROUP_CONCAT(DISTINCT STR(?truthyFlag); separator="|") AS ?truthyFlags)
       (GROUP_CONCAT(DISTINCT STR(?flag); separator="|") AS ?allFlags)
       (GROUP_CONCAT(DISTINCT ?parentIso2; separator="|") AS ?parents) WHERE {
  ?territory wdt:P297 ?iso2.

  # Sovereign countries are already covered by the country pass.
  FILTER NOT EXISTS { ?territory wdt:P31/wdt:P279* wd:Q6256. }

  # Exclude entities that no longer exist (dissolved / abolished / ended).
  FILTER NOT EXISTS { ?territory wdt:P576 ?dissolved. }
  FILTER NOT EXISTS { ?territory wdt:P582 ?endTime. }
  MINUS { ?territory wdt:P31/wdt:P279* wd:Q3024240. }  # historical country

  OPTIONAL { ?territory wdt:P41 ?truthyFlag. }
  OPTIONAL { ?territory p:P41/ps:P41 ?flag. }

  # Sovereign parent (for territories that rely on the parent's flag).
  OPTIONAL {
    ?territory wdt:P17 ?parent.
    ?parent wdt:P297 ?parentIso2.
    FILTER(?parent != ?territory)
  }

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
GROUP BY ?iso2
ORDER BY ?iso2
`;

  const [rows, countryFlagSets] = await Promise.all([
    wikidataQuery(sparql),
    getCountryFlagSets()
  ]);

  console.log(`Found ${rows.length} territory rows.`);

  if (!attribution.territories) {
    attribution.territories = {};
  }

  let downloaded = 0;
  let failed = 0;
  let usesParent = 0;

  for (const row of rows) {
    const iso2 = row.iso2?.toLowerCase();
    const label = row.label;

    if (!iso2) {
      console.log(`Skipping territory without ISO2 code: ${label}`);
      continue;
    }

    if (WITHDRAWN_ISO2_CODES.has(iso2)) {
      console.log(`Skipping withdrawn ISO code: ${iso2} (${label})`);
      continue;
    }

    if (EXCLUDED_TERRITORY_CODES.has(iso2)) {
      console.log(`Skipping excluded territory: ${iso2} (${label})`);
      continue;
    }

    // Skip anything already captured by the sovereign-country pass.
    if (attribution.countries?.[iso2]) {
      continue;
    }

    const parents = splitConcat(row.parents).map((code) => code.toLowerCase());
    const parentIso2 = parents.sort()[0] ?? null;

    // The union of every flag held by this territory's parent country/countries.
    const parentFlags = new Set();
    for (const parent of parents) {
      for (const flag of countryFlagSets.get(parent) ?? []) {
        parentFlags.add(flag);
      }
    }

    // The territory's own flag is whatever it carries that the parent does not.
    // Prefer current/best-rank (truthy) flags; fall back to any rank so a
    // territory whose only flag is deprecated (and distinct) is still captured.
    const truthyFlags = splitConcat(row.truthyFlags);
    const allFlags = splitConcat(row.allFlags);

    const isOwnFlag = (flag) =>
      !parentFlags.has(flag) && !isProposedOrUnofficialFlag(flag);

    const distinctTruthy = truthyFlags.filter(isOwnFlag);
    const distinctAll = allFlags.filter(isOwnFlag);

    const ownFlag = distinctTruthy.sort()[0] ?? distinctAll.sort()[0] ?? null;

    // No flag distinct from the parent's: the territory just flies the parent's
    // flag. Record the reference; there is nothing to download.
    if (!ownFlag) {
      if (!parentIso2) {
        console.log(
          `Skipping territory with no own flag and no identifiable parent: ${label} (${iso2})`
        );
        continue;
      }

      attribution.territories[iso2] = {
        wikidataItem: row.item,
        label,
        iso2,
        usesFlag: parentIso2,
        localFile: null
      };

      usesParent++;
      console.log(`${iso2} has no distinct flag; uses parent ${parentIso2} flag.`);

      await saveAttribution(attribution);
      continue;
    }

    const outputFile = path.join(OUTPUT_DIR, "territories", `${iso2}.svg`);

    try {
      const didDownload = await downloadFlag({
        fileUrl: ownFlag,
        outputFile,
        attributionKey: iso2,
        attributionBucket: attribution.territories,
        extraAttribution: {
          wikidataItem: row.item,
          label,
          iso2,
          usesFlag: null
        }
      });

      if (didDownload) downloaded++;
    } catch (error) {
      failed++;
      console.error(`Failed territory flag: ${label} (${iso2})`);
      console.error(error.message);
    }

    await saveAttribution(attribution);
  }

  console.log(`\nDownloaded/skipped ${downloaded} territory SVG flags.`);
  console.log(`Recorded ${usesParent} territories that use a parent country's flag.`);
  console.log(`Failed ${failed} territory SVG flags.`);

  return {
    downloaded,
    failed,
    usesParent
  };
}

async function downloadOrganizationFlags(attribution) {
  console.log("\nFetching supranational / international organization flags...\n");

  // Supranational unions and intergovernmental organizations (EU, UN, NATO,
  // African Union, ASEAN, etc.) have flags but are neither countries nor
  // territories. We prefer a short code for the filename: an ISO 3166-1 code if
  // present (e.g. EU), otherwise the English short name / acronym (P1813, e.g.
  // UN, NATO), falling back to a slug of the full name.
  const sparql = `
SELECT ?org ?orgLabel ?iso2 ?flag
       (GROUP_CONCAT(DISTINCT ?shortNameEn; separator="|") AS ?shortNames) WHERE {
  VALUES ?orgType {
    wd:Q1335818   # supranational union
    wd:Q245065    # intergovernmental organization
    wd:Q4120211   # regional organization
    wd:Q14911660  # political and economic union
  }

  ?org wdt:P31/wdt:P279* ?orgType;
       wdt:P41 ?flag.

  OPTIONAL { ?org wdt:P297 ?iso2. }
  OPTIONAL {
    ?org wdt:P1813 ?shortNameEn.
    # "mul" = multilingual: Wikidata stores language-agnostic acronyms (e.g. the
    # EU's "EU") under this tag rather than "en".
    FILTER(LANG(?shortNameEn) IN ("en", "mul"))
  }

  # Exclude organizations that no longer exist (dissolved / ended).
  FILTER NOT EXISTS { ?org wdt:P576 ?dissolved. }
  FILTER NOT EXISTS { ?org wdt:P582 ?endTime. }

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
GROUP BY ?org ?orgLabel ?iso2 ?flag
ORDER BY ?orgLabel
`;

  const rows = await wikidataQuery(sparql);

  console.log(`Found ${rows.length} organization flag rows.`);

  if (!attribution.organizations) {
    attribution.organizations = {};
  }

  let downloaded = 0;
  let failed = 0;

  for (const row of rows) {
    const shortName = pickShortestShortName(row.shortNames);

    const key =
      row.iso2?.toLowerCase() ||
      acronymToCode(shortName) ||
      slugify(row.orgLabel);

    if (!key) {
      console.log(`Skipping organization without a usable key: ${row.orgLabel}`);
      continue;
    }

    const outputFile = path.join(OUTPUT_DIR, "organizations", `${key}.svg`);

    try {
      const didDownload = await downloadFlag({
        fileUrl: row.flag,
        outputFile,
        attributionKey: key,
        attributionBucket: attribution.organizations,
        extraAttribution: {
          wikidataItem: row.org,
          label: row.orgLabel,
          ...(shortName ? { shortName } : {}),
          ...(row.iso2 ? { iso2: row.iso2.toLowerCase() } : {})
        }
      });

      if (didDownload) downloaded++;
    } catch (error) {
      failed++;
      console.error(`Failed organization flag: ${row.orgLabel} (${key})`);
      console.error(error.message);
    }

    await saveAttribution(attribution);
  }

  console.log(`\nDownloaded/skipped ${downloaded} organization SVG flags.`);
  console.log(`Failed ${failed} organization SVG flags.`);

  return {
    downloaded,
    failed
  };
}

async function downloadSubdivisionsForCountry(attribution, countryCode) {
  console.log(`\nFetching subdivision flags for ${countryCode}...\n`);

  const upperCountryCode = countryCode.toUpperCase();
  const lowerCountryCode = countryCode.toLowerCase();

  const sparql = `
SELECT DISTINCT ?subdivision ?subdivisionLabel ?isoCode ?flag WHERE {
  ?country wdt:P297 "${upperCountryCode}";
           wdt:P150 ?subdivision.

  ?subdivision wdt:P41 ?flag.

  OPTIONAL { ?subdivision wdt:P300 ?isoCode. }

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
ORDER BY ?subdivisionLabel
`;

  const rows = await wikidataQuery(sparql);

  console.log(`Found ${rows.length} subdivision flag rows for ${upperCountryCode}.`);

  if (!attribution.subdivisions[lowerCountryCode]) {
    attribution.subdivisions[lowerCountryCode] = {};
  }

  let downloaded = 0;
  let failed = 0;

  for (const row of rows) {
    const rawCode = row.isoCode || `${upperCountryCode}-${slugify(row.subdivisionLabel)}`;
    const code = rawCode.toLowerCase();

    const outputFile = path.join(
      OUTPUT_DIR,
      "subdivisions",
      lowerCountryCode,
      `${code}.svg`
    );

    try {
      const didDownload = await downloadFlag({
        fileUrl: row.flag,
        outputFile,
        attributionKey: code,
        attributionBucket: attribution.subdivisions[lowerCountryCode],
        extraAttribution: {
          wikidataItem: row.subdivision,
          label: row.subdivisionLabel,
          isoCode: code,
          countryCode: lowerCountryCode
        }
      });

      if (didDownload) downloaded++;
    } catch (error) {
      failed++;
      console.error(`Failed subdivision flag: ${row.subdivisionLabel} (${code})`);
      console.error(error.message);
    }

    await saveAttribution(attribution);
  }

  console.log(`\nDownloaded/skipped ${downloaded} subdivision SVG flags for ${upperCountryCode}.`);
  console.log(`Failed ${failed} subdivision SVG flags for ${upperCountryCode}.`);

  return {
    downloaded,
    failed
  };
}

async function downloadAllFirstLevelSubdivisionFlags(attribution) {
  console.log("\nFetching country list first...\n");

  const countries = await getCountriesWithIso2();

  console.log(`Found ${countries.length} countries.`);
  console.log("Downloading subdivisions country-by-country to avoid Wikidata timeouts.\n");

  let totalDownloaded = 0;
  let totalFailed = 0;
  let failedBatches = 0;

  for (const country of countries) {
    const countryCode = country.iso2?.toUpperCase();

    if (!countryCode) {
      continue;
    }

    try {
      const result = await downloadSubdivisionsForCountry(attribution, countryCode);

      totalDownloaded += result.downloaded;
      totalFailed += result.failed;
    } catch (error) {
      failedBatches++;
      totalFailed++;

      console.error(`Failed subdivision batch for ${country.countryLabel} (${countryCode})`);
      console.error(error.message);
    }

    await saveAttribution(attribution);

    await sleep(BETWEEN_COUNTRIES_DELAY_MS);
  }

  console.log(`\nDownloaded/skipped ${totalDownloaded} subdivision SVG flags in total.`);
  console.log(`Failed ${totalFailed} subdivision SVG flags in total.`);
  console.log(`Failed ${failedBatches} country subdivision batches.`);

  return {
    downloaded: totalDownloaded,
    failed: totalFailed,
    failedBatches
  };
}

async function main() {
  assertUserAgentConfigured();

  await ensureDir(OUTPUT_DIR);

  const attribution = await readExistingAttribution();

  // Country and territory passes need the retired-code list; refresh it from
  // Wikidata once up front so both passes share a single query result.
  if (SHOULD_DOWNLOAD_COUNTRIES || SHOULD_DOWNLOAD_TERRITORIES) {
    await resolveWithdrawnIso2Codes();
  }

  if (SHOULD_DOWNLOAD_COUNTRIES) {
    await downloadCountryFlags(attribution);
    await saveAttribution(attribution);
  }

  if (SHOULD_DOWNLOAD_TERRITORIES) {
    await downloadTerritoryFlags(attribution);
    await saveAttribution(attribution);
  }

  if (SHOULD_DOWNLOAD_ORGANIZATIONS) {
    await downloadOrganizationFlags(attribution);
    await saveAttribution(attribution);
  }

  if (SHOULD_DOWNLOAD_SUBDIVISIONS) {
    await downloadSubdivisionsForCountry(attribution, SUBDIVISION_COUNTRY_CODE);
    await saveAttribution(attribution);
  }

  if (SHOULD_DOWNLOAD_ALL_SUBDIVISIONS) {
    await downloadAllFirstLevelSubdivisionFlags(attribution);
    await saveAttribution(attribution);
  }

  console.log("\nDone.");
  console.log(`Attribution written to: ${path.join(OUTPUT_DIR, "attribution.json")}`);
}

main().catch((error) => {
  console.error("\nFailed:");
  console.error(error);
  process.exit(1);
});