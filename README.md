# Selantra WebScrape

**webscrape.selantra.co.za** — find businesses with no website in any city.

Type a city → get location + phone / email / WhatsApp for businesses without a real website.

## Live URL (after deploy)

https://webscrape.selantra.co.za

## Deploy online

See **[deploy/DEPLOY.md](deploy/DEPLOY.md)** for VPS + DNS setup at domains.co.za.

Quick version:

```bash
git clone https://github.com/HMalepe/Google-website-no-website-scraper.git
cd Google-website-no-website-scraper
cp .env.example .env   # set ACCESS_PASSWORD
docker compose up -d --build
```

DNS: `webscrape.selantra.co.za` → A record → your VPS IP.

## Local dev

```powershell
.\start-dashboard.ps1
```

## Engine

[gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) — free, self-hosted.

## License

MIT
