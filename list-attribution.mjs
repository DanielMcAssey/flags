#!/usr/bin/env node

// Lists every flag that is NOT in the public domain (i.e. carries a license that
// normally requires attribution / share-alike), as recorded in attribution.json.
//
// Filtering mirrors run.mjs: pass one or more bucket flags to narrow the output,
// or pass none to scan every bucket.
//
//   node list-attribution.mjs                     # all buckets
//   node list-attribution.mjs --countries         # countries only
//   node list-attribution.mjs --territories --organizations
//   node list-attribution.mjs --subdivisions      # all subdivision countries
//   node list-attribution.mjs --json              # machine-readable output
//   node list-attribution.mjs --countries --json

import fs from "node:fs/promises";
import path from "node:path";

const ATTRIBUTION_FILE = path.resolve("public/flags/attribution.json");

// Licenses that are effectively public domain and therefore impose no
// attribution requirement. Anything else is reported.
const PUBLIC_DOMAIN_LICENSES = new Set(["public domain", "cc0"]);

const args = new Set(process.argv.slice(2));

const AS_JSON = args.has("--json");

const SHOULD_LIST_COUNTRIES =
  args.has("--countries") || !hasBucketFilter();
const SHOULD_LIST_TERRITORIES =
  args.has("--territories") || !hasBucketFilter();
const SHOULD_LIST_ORGANIZATIONS =
  args.has("--organizations") || !hasBucketFilter();
const SHOULD_LIST_SUBDIVISIONS =
  args.has("--subdivisions") || !hasBucketFilter();

function hasBucketFilter() {
  return (
    args.has("--countries") ||
    args.has("--territories") ||
    args.has("--organizations") ||
    args.has("--subdivisions")
  );
}

function isPublicDomain(entry) {
  const license = (entry.license || "").trim().toLowerCase();

  // No recorded license tells us nothing reliable; treat as needing review,
  // so do NOT silently mark it public domain.
  if (!license) return false;

  return PUBLIC_DOMAIN_LICENSES.has(license);
}

// Flatten a bucket (which may be one level deep, e.g. countries, or two levels
// deep, e.g. subdivisions keyed by country) into a list of entries.
function collectEntries(bucket, bucketName) {
  const entries = [];

  for (const [key, value] of Object.entries(bucket || {})) {
    if (!value || typeof value !== "object") continue;

    // A territory that flies its parent country's flag carries no flag/license of
    // its own — its attribution (if any) lives on the parent country entry, so
    // skip it here.
    if (value.usesFlag) continue;

    if (value.license !== undefined || value.localFile !== undefined) {
      // A flag record.
      entries.push({ bucket: bucketName, key, entry: value });
    } else {
      // A nested grouping (subdivisions -> countryCode -> flags).
      for (const [subKey, subValue] of Object.entries(value)) {
        if (!subValue || typeof subValue !== "object") continue;
        entries.push({
          bucket: bucketName,
          key: `${key}/${subKey}`,
          entry: subValue
        });
      }
    }
  }

  return entries;
}

async function main() {
  let raw;

  try {
    raw = await fs.readFile(ATTRIBUTION_FILE, "utf8");
  } catch {
    console.error(`Could not read attribution file: ${ATTRIBUTION_FILE}`);
    process.exit(1);
  }

  const attribution = JSON.parse(raw);

  const selected = [];

  if (SHOULD_LIST_COUNTRIES) {
    selected.push(...collectEntries(attribution.countries, "countries"));
  }
  if (SHOULD_LIST_TERRITORIES) {
    selected.push(...collectEntries(attribution.territories, "territories"));
  }
  if (SHOULD_LIST_ORGANIZATIONS) {
    selected.push(...collectEntries(attribution.organizations, "organizations"));
  }
  if (SHOULD_LIST_SUBDIVISIONS) {
    selected.push(...collectEntries(attribution.subdivisions, "subdivisions"));
  }

  const nonPublicDomain = selected
    .filter(({ entry }) => !isPublicDomain(entry))
    .sort(
      (a, b) =>
        a.bucket.localeCompare(b.bucket) || a.key.localeCompare(b.key)
    );

  if (AS_JSON) {
    const output = nonPublicDomain.map(({ bucket, key, entry }) => ({
      bucket,
      key,
      label: entry.label ?? entry.objectName ?? null,
      license: entry.license || null,
      licenseUrl: entry.licenseUrl || null,
      artist: entry.artist || null,
      attribution: entry.attribution || null,
      credit: entry.credit || null,
      localFile: entry.localFile ?? null,
      commonsUrl: entry.commonsUrl ?? null
    }));

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (nonPublicDomain.length === 0) {
    console.log("No non-public-domain flags found for the selected buckets.");
    return;
  }

  let currentBucket = null;

  for (const { bucket, key, entry } of nonPublicDomain) {
    if (bucket !== currentBucket) {
      currentBucket = bucket;
      console.log(`\n${bucket}:`);
    }

    const label = entry.label || entry.objectName || "(no label)";
    console.log(`  ${key.padEnd(16)} ${entry.license.padEnd(16)} ${label}`);
  }

  console.log(`\nTotal: ${nonPublicDomain.length} non-public-domain flag(s).`);
}

main().catch((error) => {
  console.error("\nFailed:");
  console.error(error);
  process.exit(1);
});
