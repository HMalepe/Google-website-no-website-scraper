# Google Website / No-Website Scraper

Find **local businesses with no real website**, their **location**, and **any contact info** (phone, email, or WhatsApp).

Built on [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) — free, fast, no API keys.

## What you get (in priority order)

1. **No website** — only businesses without a proper website  
   (Facebook / Instagram / Linktree alone still counts as *no website*)
2. **Location** — full address + GPS coordinates
3. **Any contact** — phone, email, and/or WhatsApp link (whatever is available)

Main output: **`output/no-website-leads.csv`**

| Column | What it is |
|--------|------------|
| `business_name` | Business name |
| `has_website` | Always `no` |
| `location` | Best available location string |
| `address` | Street / full address |
| `latitude` / `longitude` | GPS coords |
| `phone` | Phone from Google Maps |
| `email` | Email if found anywhere |
| `whatsapp` | WhatsApp link (`wa.me/...`) from phone or listing text |
| `all_contacts` | Combined contact summary |

Leads with **no contact at all** go to `output/no-website-no-contact.csv`.

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js](https://nodejs.org/) 18+

## Quick start

```powershell
cd "Google maps scraper"

copy queries.example.txt queries.txt
notepad queries.txt

.\scripts\run.ps1

start output\no-website-leads.csv
```

## Example queries

```
plumbers in Johannesburg
dentists in Cape Town
restaurants in Durban
electricians in Pretoria
hair salons in Sandton
```

## How contact info is found

| Source | Method |
|--------|--------|
| **Phone** | From Google Maps listing |
| **Email** | From Maps text + linked pages (gosom `-email` pass) |
| **WhatsApp** | From listing text, or auto-built from SA mobile numbers |

> Most no-website businesses only have a **phone number**. That is normal — call or open the WhatsApp link.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `-Depth` | 1 | More results per search (slower) |
| `-Concurrency` | 4 | Parallel jobs. Try `8` on a strong PC |

## Cost

**$0** — self-hosted, no per-lead fees.

## Legal note

Use only for public business data. Follow POPIA and anti-spam rules before outreach.

## License

MIT
