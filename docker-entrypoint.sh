#!/bin/sh
set -e

if [ -S /var/run/docker.sock ]; then
  echo "Pulling latest scraper engine image..."
  docker pull gosom/google-maps-scraper || true
fi

exec "$@"
