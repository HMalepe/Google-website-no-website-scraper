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
