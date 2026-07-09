# Google Website / No-Website Scraper

Free Google Maps lead scraper focused on finding **local businesses without a website** — ideal for web design, SEO, and digital agency outreach.

Built on top of the industry-standard [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) (MIT, ~4,700 stars, ~120 places/min). No API keys. No per-lead fees.

## What it does

1. **Scrape** Google Maps for your search queries (e.g. `plumbers in Johannesburg`)
2. **Split** results into:
   - `output/no-website-leads.csv` — businesses with **no website** (call them)
   - `output/with-website-leads.csv` — businesses **with a website** (email enrichment if enabled)
3. **Optional** `-Email` pass visits each website to find contact emails

> Businesses without a website rarely have a scrapeable email. For those leads, **phone** from Google Maps is your main outreach channel.

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/Mac/Linux)
- [Node.js](https://nodejs.org/) 18+ (for the filter script)

## Quick start (Windows)

```powershell
cd "Google maps scraper"

# 1. Edit searches (one per line)
copy queries.example.txt queries.txt
notepad queries.txt

# 2. Run full pipeline
.\scripts\run.ps1

# 3. Open your leads
start output\no-website-leads.csv
```

### With email extraction (for businesses that have websites)

```powershell
.\scripts\run.ps1 -Email
```

### Step by step

```powershell
.\scripts\scrape.ps1              # scrape only
node scripts/filter-no-website.mjs   # filter only
```

## Output files

| File | Description |
|------|-------------|
| `output/results.csv` | Raw scrape from gosom |
| `output/no-website-leads.csv` | **Your main target list** |
| `output/with-website-leads.csv` | Businesses with a website |
| `output/summary.json` | Counts + sample rows |

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-Email` | off | Crawl business websites for emails |
| `-Depth` | 1 | Higher = more results per query (slower) |
| `-Concurrency` | 4 | Parallel jobs (`-c` in gosom). Try 8 on a strong PC |

## Example queries (South Africa)

```
plumbers in Johannesburg
dentists in Cape Town
restaurants in Durban
electricians in Pretoria
hair salons in Sandton
```

## Cost

| Item | Cost |
|------|------|
| This tool | **$0** |
| gosom scraper | **$0** (MIT, self-hosted) |
| Docker | **$0** |
| Proxies (optional, high volume) | ~$10–30/mo |

## Legal note

Scrape only **public** business data. Comply with local laws (e.g. POPIA in South Africa) and anti-spam rules before cold outreach. Verify contact details before calling or emailing.

## Credits

- Scraper engine: [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
- Wrapper & no-website filter: this repo

## License

MIT
