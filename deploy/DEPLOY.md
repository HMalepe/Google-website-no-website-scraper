# Deploy `webscrape.selantra.co.za`

Selantra's main site runs on **Vercel**. This scraper needs **Docker**, so it runs on a small VPS with Caddy for HTTPS.

## What you need

- A VPS with Ubuntu 22+ (2 GB RAM minimum, 4 GB better)
- SSH access
- DNS access at **domains.co.za** (where `selantra.co.za` is managed)

Suggested providers: Hetzner, DigitalOcean, Contabo (~$6–12/mo).

---

## 1. Server setup (one time)

```bash
# On the VPS as root or sudo user
apt update && apt upgrade -y
apt install -y docker.io docker-compose-plugin git
systemctl enable --now docker
```

---

## 2. Deploy the app

```bash
git clone https://github.com/HMalepe/Google-website-no-website-scraper.git
cd Google-website-no-website-scraper

cp .env.example .env
nano .env   # set ACCESS_PASSWORD

docker compose up -d --build
```

Check logs:

```bash
docker compose logs -f webscrape
```

---

## 3. DNS at domains.co.za

Add a record for the subdomain:

| Type | Host | Value |
|------|------|-------|
| **A** | `webscrape` | `<your VPS public IP>` |

Full hostname: **webscrape.selantra.co.za**

Wait 5–30 minutes for DNS propagation. Caddy will auto-issue HTTPS.

---

## 4. Use it

Open: **https://webscrape.selantra.co.za**

1. Log in with your `ACCESS_PASSWORD`
2. Type any city (Randburg, Cape Town, Durban…)
3. Click **Find leads**
4. Download CSV when done

---

## Updates

```bash
cd Google-website-no-website-scraper
git pull
docker compose up -d --build
```

---

## Firewall

```bash
ufw allow 22
ufw allow 80
ufw allow 443
ufw enable
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Scraper engine offline" | `docker compose restart webscrape` — check docker socket is mounted |
| No HTTPS | DNS not propagated yet, or ports 80/443 blocked |
| Slow scrape | Normal — each city scans ~10 business types |

---

## Why not Vercel?

The scraper runs `gosom/google-maps-scraper` via Docker. Vercel cannot run Docker jobs. A VPS is the right fit.
