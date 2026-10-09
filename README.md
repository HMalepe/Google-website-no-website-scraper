# Selantra WebScrape

**webscrape.selantra.co.za** — find businesses with no website in any city.

## What it finds (best leads first)

| Lead type | Score | Meaning |
|-----------|-------|---------|
| No website | 95–100 | No site listed, or a dead Google Business Site (`*.business.site`) |
| Social only | 90 | Only a Facebook / Instagram / Linktree / WhatsApp link |
| Weak website | ≤ 85 | Outdated, broken, parked or dead site (only with **outdated websites** ticked) |
| Free subdomain | 70 | Wix / Google Sites / Weebly subdomain, no own domain |

Ties are broken by review count, so busy businesses come first.

**Get more leads:**
- **Suburbs to sweep:** each business type is searched in every suburb, so you
  reach businesses a city-wide search never shows. Duplicates are removed.
- **Search depth:** how far each Google Maps result list is scrolled. Deep (10) is the default.
- **Outdated websites:** audits every listed site (HTTPS, mobile, copyright year,
  legacy HTML, old jQuery/WordPress, dead/parked domains). Sites behind bot
  protection are skipped, not counted as leads.

Downloads: `leads.csv` (all lead types, ranked). The filter also writes
`no-website-leads.csv` (no website + social only).

## Market insights (free, no API keys)

**Market gaps (every scan).** After each scan, the dashboard analyses the businesses it found.
For each business type and suburb it shows:

- competitors, and how many are strong (4.5★ or more with 20+ reviews)
- customer activity (total reviews)
- the percentage with no website, open on Sundays and open in the evening
- an opportunity score, where busy areas with service gaps rank highest
- a plain-English angle, e.g. "busy but few strong players; evening hours are a gap"

It also lists **what customers complain about**, mined from low-star reviews: waiting, booking,
price, quality, hygiene, staff attitude and so on. You can download it as a CSV (`market.csv`).
The scraper keeps about 8 reviews per business, so the complaints are a sample.

CLI: `node scripts/market-insights.mjs output/results.csv output`

**Google Trends tab.** Enter up to 10 search terms (e.g. `knotless braids, gel nails, lashes`).
For South Africa it shows:

- which terms are **RISING** or **FALLING** right now (last 4 weeks vs the 8 before)
- the peak and low months
- the top provinces or cities
- breakout related searches

It uses the unofficial `pytrends` library. Google rate-limits it, so if a check fails, wait 10–15
minutes and try again. CLI: `pip install -r tools/requirements.txt`, then `python tools/trends.py`.

## Go live (free or cheap VPS)

**Start here:** [deploy/VPS-SETUP.md](deploy/VPS-SETUP.md)

| Plan | Cost | Best for |
|------|------|----------|
| **Oracle Cloud Johannesburg** | **Free forever** | SA users, 12 GB RAM |
| **Hetzner CX23** | ~€4/mo | If Oracle is full |

One command on the server after signup:

```bash
curl -fsSL https://raw.githubusercontent.com/HMalepe/Google-website-no-website-scraper/main/deploy/setup-server.sh | bash
```

DNS at domains.co.za: `webscrape` → A record → your VPS IP.

## Local dev

```powershell
.\start-dashboard.ps1

# CLI: scrape queries.txt, then filter (add -Audit for weak-website leads)
.\scripts\run.ps1 -Depth 10 -Audit
```

## License

MIT
