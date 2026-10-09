# Engineering audit: Selantra WebScrape

**Date:** 2026-10-09 · **Scope:** the whole repository, covering the dashboard server, the frontend,
lead filter and website audit, market analysis, Trends tool, Docker/Caddy, deploy and auto-update
scripts, and the PowerShell CLI.

**Method:** I read every file line by line and traced each request and job path end to end. Every
fix is covered by an automated test that fails when the bug is reintroduced (checked by
re-inserting the bugs and confirming the tests go red).

## Findings

Severity: **High** = data loss, security exposure or the app becoming unusable. **Medium** =
wrong results or degraded service. **Low** = hygiene or maintainability.

| # | Severity | Area | Finding | Status |
|---|----------|------|---------|--------|
| 1 | High | Reliability | A scan running when the server restarted stayed marked "scraping" forever. The dashboard reopened it, kept **Start disabled permanently**, and the orphaned scraper container kept using memory. | Fixed: interrupted work is marked failed at startup and leftover `gmaps-*` containers are removed |
| 2 | High | Security | Login returned the **raw password as the session token** and the browser stored it. Comparisons were not constant-time, and logins were not rate limited. | Fixed: an HMAC-derived token, timing-safe compare, and 10 failures per 15 minutes per IP |
| 3 | High | Security | **Blind SSRF:** the website audit fetched any URL in a Google Maps listing, which anyone can edit, including `169.254.169.254` (cloud metadata), `localhost` and the LAN, and it followed redirects into them. | Fixed: private, loopback, link-local and metadata addresses are refused, and every redirect hop is checked |
| 4 | Medium | Reliability | Two quick "Find leads" requests could both start scans, because the active-job check ran before the `await`s. The same race existed for Trends. | Fixed: the check is repeated just before starting |
| 5 | Medium | Usability | There was no way to stop a running scan. A 400-search sweep could only be stopped by killing the server. | Fixed: a Stop scan endpoint and button; partial results are kept |
| 6 | Medium | Lead quality | **WhatsApp links were generated for landlines** (011…), sending outreach to numbers that can't have WhatsApp. | Fixed: links only for SA mobiles (06x, 07x, 081–084) and foreign `+` numbers |
| 7 | Medium | Deploys | Browsers kept the old JS and CSS after each update, so a hard refresh was needed. | Fixed: `Cache-Control: no-cache` plus an ETag (cheap 304s); the API sends `no-store` |
| 8 | Medium | Reliability | A Trends check had no timeout, so a hang blocked the Trends tab until restart. Retries also fired on non-retryable errors, wasting minutes. | Fixed: 20-minute timeout; retries only on 429 or timeout |
| 9 | Medium | Ops | Auto-update could rebuild in the middle of a Trends check, and every rebuild left an old image behind, slowly filling the 45 GB disk. | Fixed: it waits for running checks and prunes old images |
| 10 | Medium | Portability | `spawn(..., { shell: true })` on Windows broke Docker mounts for paths with spaces and allowed shell metacharacters in arguments. | Fixed: never uses a shell |
| 11 | Low | Performance | The progress monitor re-parsed the whole results CSV, including reviews JSON, every 5 seconds. That's heavy on the 1/8-CPU VM. | Fixed: quote-aware row counter, cached by file size |
| 12 | Low | Performance | Each 2-second poll sent the full job log (up to 500 lines) to the phone. | Fixed: last 80 lines |
| 13 | Low | Robustness | Polling a deleted scan or trend retried forever, and oversized request bodies kept being read. Unexpected 500 errors exposed internal error messages. | Fixed |
| 14 | Low | Security | No HTTP security headers. | Fixed: HSTS, nosniff, frame deny, referrer policy, permissions policy (Caddy) |
| 15 | Low | Hygiene | Python `__pycache__/*.pyc` had been committed, including one for the deleted `market.py`. | Fixed: removed and ignored |
| 16 | Low | Engineering | **No automated tests or CI.** | Fixed: 16 `node:test` tests (unit, CLI, server integration with a stub docker) plus a GitHub Actions workflow (syntax, tests, Docker build) |
| 17 | Low | CLI | `scripts/run.ps1` skipped the market analysis. | Fixed |

## Accepted risks (documented, not changed)

- **Docker socket in the dashboard container.** Starting scraper containers needs it, but it makes
  the dashboard root-equivalent on the VM if it were ever compromised. Mitigated by strong auth,
  rate limiting and no shell use. Possible next step: a filtered socket proxy that only allows
  `run`, `stop` and `ps` for the scraper image.
- **Scraper image unpinned** (`gosom/google-maps-scraper:latest` is pulled at start). This is kept on
  purpose: Google changes Maps often and scraper fixes ship fast. The cost is that a breaking
  upstream change could surface as failed scans.
- **DNS rebinding** could in theory slip past the SSRF check between the lookup and the fetch. Given
  the blind, GET-only, score-only impact, the risk is very low.
- **Single shared password, no user accounts.** That fits a personal tool.
- **pytrends is unofficial.** Google rate limits and format changes can break Trends; failures are
  shown clearly.
- **Scan data is kept indefinitely** under `/srv/webscrape-data`. That's small per scan. Add
  retention if the disk ever fills.
- **The 1 GB E2.1.Micro VM** works, but scans are slow (one browser, shallow depth). The free 4-OCPU
  / 24 GB A1 instance is the recommended upgrade.

## Checklist

- [x] Read every file; trace request and job lifecycles
- [x] Security: session token, timing-safe compare, rate limit, id validation, body limit, error leakage, headers
- [x] SSRF protection in the website audit (including redirects)
- [x] Recovery of interrupted work and orphan container cleanup
- [x] Start race fixed; Stop scan added
- [x] Trends timeout and retry policy; auto-update safety and image pruning
- [x] WhatsApp only for mobiles
- [x] Caching, polling, performance and Windows spawn fixes
- [x] Repo hygiene
- [x] 16 automated tests, each proven to catch its bug; CI workflow
- [x] Browser check: login, scan, market gaps, stop button, reload persistence, no JS errors
- [ ] Live verification on the server after auto-update: login, then a small scan (owner)
