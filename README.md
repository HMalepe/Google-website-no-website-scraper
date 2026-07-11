# Selantra WebScrape

**webscrape.selantra.co.za** — find businesses with no website in any city.

After the no-website filter, each lead gets a **separate web search** for its
company registration / opening date (CIPC-style registration numbers,
"registered on…", "founded/established/opened in…"). Results are sorted
**newest companies first**; leads without a findable date come last. Google
blocks automated searches, so the lookup uses DuckDuckGo and Bing, which index
the same public company pages. Tune it with `ENRICH_MAX`, `ENRICH_DELAY_MS`,
and `ENRICH_TIMEOUT_MS` (see `.env.example`).

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
```

## License

MIT
