FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Google Trends tab (free): tools/trends.py runs in its own Python venv.
COPY tools/requirements.txt ./tools/requirements.txt
RUN python3 -m venv /opt/trends \
  && /opt/trends/bin/pip install --no-cache-dir -r tools/requirements.txt
ENV TRENDS_PYTHON=/opt/trends/bin/python

COPY package.json server.mjs ./
COPY public ./public
COPY scripts ./scripts
COPY tools ./tools
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3847

EXPOSE 3847

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
