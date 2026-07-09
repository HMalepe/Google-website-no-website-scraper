# Selantra WebScrape

**webscrape.selantra.co.za** — find businesses with no website in any city.

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
