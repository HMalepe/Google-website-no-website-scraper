# Google Website / No-Website Scraper

Find **local businesses with no real website**, their **location**, and **any contact info** (phone, email, or WhatsApp).

## Dashboard (recommended)

Double-click **`start-dashboard.bat`** or run:

```powershell
.\start-dashboard.ps1
```

Opens **http://localhost:3847** in your browser.

1. Set location (default: **Randburg**)
2. Pick business types (plumbers, electricians, etc.)
3. Click **Start scrape**
4. View leads in the table and **Download CSV**

Requires **Docker Desktop** to be running.

## What you get

| Priority | Field |
|----------|-------|
| No website | Only businesses without a proper site (Facebook-only counts as no website) |
| Location | `location`, `address`, GPS |
| Contact | `phone`, `email`, `whatsapp` |

## CLI (optional)

```powershell
.\scripts\run.ps1
```

## Engine

Built on [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) — free, self-hosted, no API keys.

## License

MIT
