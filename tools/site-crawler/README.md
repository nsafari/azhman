# Site Crawler (TypeScript)

A TypeScript CLI crawler to download pages, links, and textual content from a website and export translation-ready source files.

Primary target:
- `https://azhman.company/`

## What it exports

Inside the output directory (default `./output`):

- `manifest.json`
  - crawl metadata and page index
- `pages.json`
  - full extracted page payloads (title, description, text, links, assets)
- `links-graph.json`
  - internal/external link graph per page
- `translation-seed.json`
  - compact text source bundle for localization workflows
- `pages/html/*.html`
  - raw downloaded HTML snapshots
- `pages/markdown/*.md`
  - human-readable markdown snapshots of extracted content

## Install

```bash
cd tools/site-crawler
npm install
```

## Run (Azhman default)

```bash
npm run crawl:azhman
```

## Run with custom options

```bash
npm run crawl -- \
  --startUrl=https://azhman.company/ \
  --outputDir=./output \
  --maxPages=250 \
  --concurrency=4 \
  --delayMs=250 \
  --timeoutMs=20000 \
  --includeSubdomains=false
```

## CLI options

- `--startUrl` (default: `https://azhman.company/`)
- `--outputDir` (default: `./output`)
- `--maxPages` (default: `200`)
- `--concurrency` (default: `4`)
- `--delayMs` (default: `250`)
- `--timeoutMs` (default: `20000`)
- `--includeSubdomains` (default: `false`)

## Notes

- This crawler follows internal links recursively and normalizes URLs.
- It removes URL hash fragments and strips `utm_*` query params for deduplication.
- It stores failed requests in `manifest.json > brokenLinks`.
- Respect website terms and robots policies before using at higher scale.
