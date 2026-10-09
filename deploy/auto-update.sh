#!/bin/bash
# Pull the latest main branch and rebuild the app when it changed.
# Runs from cron every 5 minutes; skips while a scan is running.
#
#   bash deploy/auto-update.sh            # check once now
#   bash deploy/auto-update.sh --install  # add the cron job (idempotent)
set -uo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-/srv/webscrape-data}"
LOG="$HOME/webscrape-auto-update.log"

# Swap gives the VM a cushion so a memory spike slows it down instead of
# freezing it. Idempotent; sudo -n never waits for a password under cron.
ensure_swap() {
  swapon --show --noheadings 2>/dev/null | grep -q . && return 0
  if [ ! -f /swapfile ]; then
    sudo -n fallocate -l 4G /swapfile && sudo -n chmod 600 /swapfile \
      && sudo -n mkswap /swapfile >/dev/null || return 0
  fi
  sudo -n swapon /swapfile || return 0
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo -n tee -a /etc/fstab >/dev/null
  echo "$(date -Is) swap enabled (4G)"
}
ensure_swap

if [ "${1:-}" = "--install" ]; then
  LINE="*/5 * * * * bash $APP_DIR/deploy/auto-update.sh >> $LOG 2>&1"
  ( crontab -l 2>/dev/null | grep -v "deploy/auto-update.sh"; echo "$LINE" ) | crontab -
  echo "Auto-update installed: checks GitHub every 5 minutes. Log: $LOG"
  exit 0
fi

cd "$APP_DIR" || exit 1

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

git fetch -q origin main || exit 0
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

# Rebuilding restarts the dashboard, which would kill a running scan.
if $DOCKER ps --format '{{.Names}}' | grep -q '^gmaps-'; then
  echo "$(date -Is) update waiting: scraper running"
  exit 0
fi
if find "$DATA_DIR/jobs" -name job.json -mmin -3 2>/dev/null \
  | xargs -r grep -lE '"status": "(queued|scraping|filtering)"' | grep -q .; then
  echo "$(date -Is) update waiting: scan in progress"
  exit 0
fi
# Trends checks back off for minutes between writes, hence the longer window.
if find "$DATA_DIR/trends" -name trend.json -mmin -10 2>/dev/null \
  | xargs -r grep -lE '"status": "(queued|running)"' | grep -q .; then
  echo "$(date -Is) update waiting: trends check in progress"
  exit 0
fi

echo "$(date -Is) updating $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
git merge -q --ff-only origin/main || { echo "$(date -Is) merge failed"; exit 1; }
$DOCKER compose up -d --build
# Each rebuild leaves the previous image behind; reclaim the disk space.
$DOCKER image prune -f >/dev/null 2>&1 || true
echo "$(date -Is) update done"
