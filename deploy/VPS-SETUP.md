# Free / cheap VPS for webscrape.selantra.co.za

Pick **Plan A** if you want $0 forever. Pick **Plan B** if Oracle is full or you want zero hassle.

---

## Plan A — Oracle Cloud FREE (recommended for SA)

| | |
|---|---|
| **Cost** | **R0 / month forever** |
| **Specs** | 2 ARM CPUs, 12 GB RAM, 200 GB storage |
| **Region** | **Johannesburg** (`af-johannesburg-1`) — closest to you |
| **Good for** | Docker scraper + Caddy HTTPS |

Sign up: [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) (ZA page: [oracle.com/za/cloud/free](https://www.oracle.com/za/cloud/free/))

> Needs a debit/credit card for verification — **you are not charged** if you stay on Always Free shapes.

### Step 1 — Create account

1. Go to [oracle.com/cloud/free](https://www.oracle.com/cloud/free/)
2. Click **Start for free**
3. **Home region:** choose **South Africa Central (Johannesburg)**
4. Verify with card (no charge for Always Free)

### Step 2 — Create the VM

1. OCI Console → **Compute** → **Instances** → **Create instance**
2. **Name:** `webscrape`
3. **Image:** Ubuntu 22.04 (aarch64 / ARM)
4. **Shape:** Ampere → **VM.Standard.A1.Flex**
   - OCPUs: **2**
   - Memory: **12 GB**
   - Must show **Always Free-eligible**
5. **Networking:** tick **Assign a public IPv4 address**
6. **SSH keys:** paste your public key (see below if you don't have one)
7. Click **Create**

**"Out of capacity"?** Johannesburg is often full. Try:
- Different **availability domain** (AD-1, AD-2…)
- Retry tomorrow morning
- Or use **Plan B (Hetzner)** — €4/month, works first try

### Step 3 — Open firewall ports (Oracle)

Oracle blocks ports by default. In the console:

1. **Networking** → **Virtual cloud networks** → your VCN
2. **Security Lists** → Default Security List → **Add Ingress Rules**
3. Add three rules:

| Source | Protocol | Port |
|--------|----------|------|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |
| Your IP/32 | TCP | 22 |

### Step 4 — SSH key (Windows, one time)

In PowerShell:

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\oracle_webscrape" -N '""'
Get-Content "$env:USERPROFILE\.ssh\oracle_webscrape.pub"
```

Copy the output → paste into Oracle **SSH keys** when creating the VM.

### Step 5 — Deploy the app

SSH in (replace with your VM public IP):

```powershell
ssh -i $env:USERPROFILE\.ssh\oracle_webscrape ubuntu@YOUR_VM_IP
```

On the server:

```bash
curl -fsSL https://raw.githubusercontent.com/HMalepe/Google-website-no-website-scraper/main/deploy/setup-server.sh | bash
```

Save the **ACCESS_PASSWORD** it prints — that's your login.

### Step 6 — DNS at domains.co.za

| Type | Host | Value |
|------|------|-------|
| **A** | `webscrape` | your VM public IP |

Wait ~15 minutes, then open: **https://webscrape.selantra.co.za**

---

## Plan B — Hetzner CHEAP (~€4–5 / month)

| | |
|---|---|
| **Cost** | **~€4.15/mo** (CX23) or **~€5.19/mo** (CPX22) |
| **Specs** | 2 vCPU, 4 GB RAM, 40 GB NVMe |
| **Region** | Helsinki or Ashburn (US) — add Cloudflare CDN if slow from SA |
| **Good for** | Works first try, 99.9% uptime, no capacity lottery |

Sign up: [hetzner.com/cloud](https://www.hetzner.com/cloud)

### Steps

1. Create account → **Add server**
2. **Location:** Helsinki (cheapest) or Ashburn
3. **Image:** Ubuntu 22.04
4. **Type:** **CX23** (2 vCPU, 4 GB, ~€4.15/mo) — best value
5. **SSH key:** same as above
6. Create server → note the **IPv4 address**
7. SSH in and run the same setup script:

```bash
curl -fsSL https://raw.githubusercontent.com/HMalepe/Google-website-no-website-scraper/main/deploy/setup-server.sh | bash
```

8. DNS: `webscrape` A record → Hetzner IP

---

## Plan C — Contabo (~$4.95 / month)

| | |
|---|---|
| **Cost** | ~$4.95/mo |
| **Specs** | 4 vCPU, 8 GB RAM |
| **Link** | [contabo.com](https://contabo.com) |

Same deploy script after SSH. Good if Hetzner and Oracle both fail.

---

## Comparison

| Provider | Cost | RAM | SA latency | Hassle |
|----------|------|-----|------------|--------|
| **Oracle Johannesburg** | **Free** | 12 GB | Best | Medium (capacity) |
| **Hetzner CX23** | ~€4/mo | 4 GB | OK | Low |
| **Contabo** | ~$5/mo | 8 GB | OK | Low |

**Our pick:** Try **Oracle Johannesburg** first. If "out of capacity", use **Hetzner CX23** for ~€4/month.

---

## After deploy — use the dashboard

1. Open **https://webscrape.selantra.co.za**
2. Log in with your **ACCESS_PASSWORD**
3. Type any city: `Randburg`, `Cape Town`, `Durban`…
4. Click **Find leads**
5. Download CSV

---

## Useful commands (on the server)

```bash
cd ~/Google-website-no-website-scraper

# Status
docker compose ps

# Logs
docker compose logs -f webscrape

# Update app
git pull && docker compose up -d --build

# Restart
docker compose restart
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Oracle "out of capacity" | Retry later or use Hetzner |
| Site not loading | Check DNS + Oracle security list ports 80/443 |
| "Engine offline" | `docker compose restart webscrape` |
| Every scan fails with `read /queries.txt: is a directory` | Old setup — run `git pull && docker compose up -d --build` |
| "Google Maps returned no businesses" | Check spelling; if it repeats for every city, Google is blocking the server IP — wait a few hours |
| Forgot password | `nano .env` → change `ACCESS_PASSWORD` → `docker compose up -d` |
