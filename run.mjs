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

async function downloadTerritoryFlags(attribution) {
  console.log("\nFetching dependent / overseas territory flags...\n");

  // Catch all entities that hold an ISO 3166-1 alpha-2 code (P297) and a flag
  // (P41) but are NOT sovereign countries (Q6256) — those are already handled
  // by the country pass. A type whitelist was previously used here but it
  // silently missed entities whose Wikidata classification fell outside the
  // list (e.g. AX Åland Islands, EH Western Sahara, BQ Caribbean Netherlands).
  // The catch-all approach is both simpler and complete by construction.
  // p:P41/ps:P41 instead of wdt:P41 to include deprecated-rank flag images.
  // Needed for e.g. BQ (Caribbean Netherlands, Q27561), which has a flag but
  // it is marked deprecated in Wikidata, so the standard wdt: shorthand skips it.
  const sparql = `
SELECT DISTINCT ?territory ?territoryLabel ?iso2 ?flag WHERE {
  ?territory wdt:P297 ?iso2;
             p:P41/ps:P41 ?flag.

  # Sovereign countries are already covered by the country pass.
  FILTER NOT EXISTS { ?territory wdt:P31/wdt:P279* wd:Q6256. }

  # Exclude entities that no longer exist (dissolved / abolished / ended).
  FILTER NOT EXISTS { ?territory wdt:P576 ?dissolved. }
  FILTER NOT EXISTS { ?territory wdt:P582 ?endTime. }
  MINUS { ?territory wdt:P31/wdt:P279* wd:Q3024240. }  # historical country

  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
  }
}
ORDER BY ?iso2
`;

  const rows = await wikidataQuery(sparql);

  console.log(`Found ${rows.length} territory flag rows.`);

  if (!attribution.territories) {
    attribution.territories = {};
  }

  let downloaded = 0;
  let failed = 0;

  for (const row of rows) {
    const iso2 = row.iso2?.toLowerCase();

    if (!iso2) {
      console.log(`Skipping territory without ISO2 code: ${row.territoryLabel}`);
      continue;
    }

    // Skip anything already captured by the sovereign-country pass.
    if (attribution.countries?.[iso2]) {
      continue;
    }

    const outputFile = path.join(OUTPUT_DIR, "territories", `${iso2}.svg`);

    try {
      const didDownload = await downloadFlag({
        fileUrl: row.flag,
        outputFile,
        attributionKey: iso2,
        attributionBucket: attribution.territories,
        extraAttribution: {
          wikidataItem: row.territory,
          label: row.territoryLabel,
          iso2
        }
      });

      if (didDownload) downloaded++;
    } catch (error) {
      failed++;
      console.error(`Failed territory flag: ${row.territoryLabel} (${iso2})`);
      console.error(error.message);
    }

    await saveAttribution(attribution);
  }

  console.log(`\nDownloaded/skipped ${downloaded} territory SVG flags.`);
  console.log(`Failed ${failed} territory SVG flags.`);

  return {
    downloaded,
    failed
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