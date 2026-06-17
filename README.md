# flags

A collection of SVG flags for countries, dependent territories, international
organizations, and country subdivisions, sourced from
[Wikidata](https://www.wikidata.org/) and
[Wikimedia Commons](https://commons.wikimedia.org/), together with the script
that downloads them and records their licensing/attribution.

## Contents

```
public/flags/
├── attribution.json        # license + attribution metadata for every flag
├── countries/              # sovereign country flags, keyed by ISO 3166-1 alpha-2 (e.g. gb.svg)
├── territories/            # dependent / overseas territories, keyed by ISO 3166-1 alpha-2
├── organizations/          # supranational / intergovernmental orgs (e.g. un.svg, nato.svg)
└── subdivisions/           # first-level subdivisions, grouped by country (e.g. us/us-ca.svg)
```

All flags are stored as `.svg`. Filenames use lowercase codes:

- **Countries / territories** — ISO 3166-1 alpha-2 (`fr.svg`, `jp.svg`).
- **Organizations** — ISO code if available, otherwise an acronym (`un.svg`,
  `eu.svg`), otherwise a slug of the full name.
- **Subdivisions** — ISO 3166-2 code where available (`subdivisions/us/us-ca.svg`),
  otherwise a country-prefixed slug. Grouped into one folder per country.

## Attribution

`public/flags/attribution.json` is the source of truth for licensing. For each
flag it records the Wikidata item, Wikimedia Commons page, original download URL,
uploading user, license (e.g. *Public domain*, *CC BY-SA*), usage terms, and
artist/credit fields.

**Check the license before reusing a flag.** Many are public domain, but some
carry attribution or share-alike requirements. Each entry includes the data you
need to comply.

## Regenerating the flags

`run.mjs` is a standalone Node.js script (no dependencies; uses the built-in
`fetch`). It queries Wikidata via SPARQL, resolves each flag file on Wikimedia
Commons, downloads the SVG, and updates `attribution.json`.

> Requires Node.js 18+ (for global `fetch`).

```bash
# Download countries + territories + organizations (the default)
node run.mjs

# Or select individual categories
node run.mjs --countries
node run.mjs --territories
node run.mjs --organizations

# Subdivisions for a single country (defaults to US)
node run.mjs --subdivisions
node run.mjs --subdivisions --subdivision-country=GB

# First-level subdivisions for every country (long-running)
node run.mjs --all-subdivisions
```

Passing no arguments downloads countries, territories, and organizations.
Subdivisions are only fetched when explicitly requested.

The script is safe to re-run: existing files are skipped (their attribution is
still refreshed), and `attribution.json` is saved incrementally as it goes.

### Politeness & reliability

The downloader is deliberately gentle on the Wikimedia APIs:

- A fixed delay between requests and a longer pause between countries.
- Exponential backoff with jitter, honoring `Retry-After`, on retryable
  statuses (403, 408, 425, 429, 5xx).
- A descriptive `User-Agent` (set `USER_AGENT` near the top of `run.mjs` to your
  own app name and contact email before running it seriously).

Only SVG files are kept; non-SVG flag files returned by Commons are skipped.
