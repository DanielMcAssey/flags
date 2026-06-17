# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

A static asset collection of SVG flags for countries, dependent territories, international organizations, and country subdivisions. Flags are sourced from Wikidata and Wikimedia Commons via `run.mjs`, a self-contained Node.js script (no dependencies, uses the built-in `fetch`). Node.js 18+ is required.

## Scripts

```bash
# Download countries + territories + organizations (the default)
node run.mjs

# Individual categories
node run.mjs --countries
node run.mjs --territories
node run.mjs --organizations

# Subdivisions for a single country (defaults to US)
node run.mjs --subdivisions
node run.mjs --subdivisions --subdivision-country=GB

# All first-level subdivisions for every country (long-running)
node run.mjs --all-subdivisions

# List flags that require attribution (non-public-domain)
node list-attribution.mjs
node list-attribution.mjs --countries --territories
node list-attribution.mjs --json
```

## Architecture

`run.mjs` is the core script. Its flow per flag:
1. Query Wikidata via SPARQL to get flag file URLs.
2. Fetch Commons metadata (license, artist, credit, download URL) via the MediaWiki API.
3. Download the SVG if it doesn't already exist locally (re-runs are safe).
4. Write/refresh the entry in `attribution.json` after each flag, so progress is never lost.

`list-attribution.mjs` reads `attribution.json` and filters to entries whose `license` field is not in the public-domain set (`"public domain"`, `"cc0"`).

`public/flags/attribution.json` is the source of truth for all licensing metadata. Its structure:
```
{
  "generatedAt": "<ISO timestamp>",
  "countries":     { "<iso2>": { ...metadata } },
  "territories":   { "<iso2>": { ...metadata } },
  "organizations": { "<key>": { ...metadata } },
  "subdivisions":  { "<countryCode>": { "<isoCode>": { ...metadata } } }
}
```

Each metadata entry records: `wikidataItem`, `label`, `commonsUrl`, `downloadUrl`, `user`, `license`, `licenseUrl`, `usageTerms`, `attributionRequired`, `artist`, `credit`, `attribution`, `localFile`.

Territory entries also carry `usesFlag`: `null` when the territory has its own downloaded flag, or the parent country's ISO code (e.g. `"fr"`) when the territory has no distinct flag and flies its sovereign country's flag instead. A `usesFlag` reference has no own SVG (`localFile` is `null`) and no licensing fields — `list-attribution.mjs` skips these, since attribution (if any) lives on the parent country entry.

## Key details

- **`USER_AGENT`** near the top of `run.mjs` must be set to your app name and contact email before running the script seriously against the Wikimedia APIs.
- The downloader applies a fixed 1.5 s delay between requests and exponential backoff with jitter (honoring `Retry-After`) on 403/408/425/429/5xx responses.
- Organization filenames use: ISO 3166-1 code if available → shortest English short name/acronym → slug of full name.
- Subdivision filenames use: ISO 3166-2 code if available → `<COUNTRY>-<slug-of-name>`.
- Non-SVG files returned by Commons are silently skipped.
