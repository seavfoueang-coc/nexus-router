# OmniRoute key service in one container: OmniRoute + user portal + admin dashboard + Cloudflare Tunnel.
# They must share one network namespace: the portal/admin talk to OmniRoute with the CLI token, which OmniRoute
# only accepts from loopback. Deployed by Coolify from docker-compose.yml. Data lives in the /data volume.
FROM node:24-bookworm-slim

ARG CLOUDFLARED_VERSION=2026.9.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini tzdata sqlite3 procps \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64" \
 && chmod 755 /usr/local/bin/cloudflared \
 && cloudflared --version

# Same layout as on the PC: /opt/router/{app,tools}, so the tools find app/node_modules/omniroute.
RUN mkdir -p /opt/router/app /data && chown -R node:node /opt/router /data
USER node
WORKDIR /opt/router

# OmniRoute pinned by the lock file (3.8.52). .npmrc allows its install scripts (npm 11 blocks them otherwise).
COPY --chown=node:node app/package.json app/package-lock.json app/.npmrc ./app/
RUN cd app && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node tools ./tools
COPY --chown=node:node docker ./docker
RUN chmod 755 docker/*.sh

ENV DATA_DIR=/data \
    PORT=20128 \
    NODE_ENV=production \
    OMNIROUTE_HEADLESS=true \
    TZ=Asia/Phnom_Penh

VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/router/docker/start.sh"]
