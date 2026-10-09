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

## Market research tools (`tools/`)

Standalone Python scripts for deciding **where** and **what** to sell. They don't use the dashboard.

```powershell
pip install -r tools/requirements.txt
```

**`tools/market.py`: suburb gaps + competitor complaints** (needs a Google Places API key)

```powershell
$env:GOOGLE_PLACES_API_KEY="your-key"
python tools/market.py --suburbs "Randburg,Sandton,Fourways" --city Johannesburg --category "hair salon"
python tools/market.py --suburbs "Randburg,Sandton" --city Johannesburg --category "nail salon" --reviews
```

It writes `market_suburbs.csv` (suburbs ranked by opportunity: busy market, few strong competitors,
Sunday/evening/website gaps) and `market_salons.csv` (every competitor). With `--reviews` it also
writes `market_complaints.csv` (what customers hate: waiting, booking, price, quality, hygiene…).
`--reviews` uses a pricier API tier, and Google returns at most 5 reviews per place, so the
complaint counts are a sample.

**`tools/trends.py`: what is rising, when demand peaks, where** (free, no key)

```powershell
python tools/trends.py
python tools/trends.py --terms "knotless braids,gel nails,lashes,barber" --geo ZA-GP --timeframe "today 5-y"
```

It writes `trends_summary.csv` (momentum, RISING/FALLING, peak and low month), plus
`trends_over_time.csv`, `trends_regions.csv` and `trends_rising.csv`. It uses the unofficial
`pytrends` library: Google rate-limits it (the script backs off and retries) and it can break
when Google changes things.

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
