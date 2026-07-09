#!/bin/bash
# One-command setup for webscrape.selantra.co.za on Ubuntu 22.04/24.04 (x86 or ARM)
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/Google-website-no-website-scraper}"
REPO="https://github.com/HMalepe/Google-website-no-website-scraper.git"

echo "==> Installing Docker..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if ! groups "$USER" | grep -q docker; then
  sudo usermod -aG docker "$USER"
  echo "Added $USER to docker group. You may need to log out and back in."
fi

echo "==> Cloning app..."
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git pull origin main || true

echo "==> Configuring environment..."
if [ ! -f .env ]; then
  cp .env.example .env
  PASS="$(openssl rand -base64 18 2>/dev/null || date +%s | sha256sum | head -c 24)"
  sed -i "s/ACCESS_PASSWORD=change-me-to-a-strong-password/ACCESS_PASSWORD=$PASS/" .env
  echo ""
  echo "Generated ACCESS_PASSWORD: $PASS"
  echo "Save this — you'll need it to log in at webscrape.selantra.co.za"
  echo ""
fi

echo "==> Firewall (UFW)..."
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 22/tcp || true
  sudo ufw allow 80/tcp || true
  sudo ufw allow 443/tcp || true
  echo "y" | sudo ufw enable || true
fi

echo "==> Starting containers..."
docker compose pull 2>/dev/null || true
docker compose up -d --build

echo ""
echo "Done. Check status:"
docker compose ps
echo ""
echo "Point DNS: webscrape.selantra.co.za -> $(curl -4 -s ifconfig.me || echo 'YOUR_SERVER_IP')"
echo "Then open: https://webscrape.selantra.co.za"
