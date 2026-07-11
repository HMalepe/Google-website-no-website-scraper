# Selantra WebScrape

**webscrape.selantra.co.za** — find businesses with no website in any city.

After the no-website filter, each lead gets a **separate web search** for its
company registration / opening date (CIPC-style registration numbers,
"registered on…", "founded/established/opened in…"). Results are sorted
**newest companies first**; leads without a findable date come last. Google
blocks automated searches, so the lookup uses DuckDuckGo and Bing, which index
the same public company pages. Tune it with `ENRICH_MAX`, `ENRICH_DELAY_MS`,
and `ENRICH_TIMEOUT_MS` (see `.env.example`).

Each lead also gets:

- **social_profile** — the Facebook/Instagram/TikTok page a business runs
  instead of a website (proves they care about being online)
- **suggested_domain / domain_available** — a DNS check whether
  `businessname.co.za` is still unregistered (a ready-made pitch line)
- **lead_score (0–100)** — company newness + social-only presence + review
  sweet spot (4★+, real traffic, no site) + free domain + hiring signal +
  contactability
- **hiring_signal** — "now hiring / vacancies / join our team" spotted in the
  same search snippets (growth = budget)

A second lead list, **bad-website-leads.csv**, audits businesses that *do*
have a website and flags dead weight: lapsed domain, unreachable site, no
SSL, not mobile-friendly, outdated copyright year, no analytics installed.
Set `PAGESPEED_API_KEY` (free, official Google API) to also flag slow mobile
scores. Tune with `AUDIT_MAX` / `AUDIT_TIMEOUT_MS`.

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
