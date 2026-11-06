#!/bin/bash
# Starts the four parts and restarts any that stops. Logs go to stdout (Coolify > Logs).
#   omniroute  AI gateway + its dashboard            :20128
#   portal     balance page, docs, public /v1 proxy  :20130 (published only through the tunnel)
#   admin      key dashboard                         :20140 (host loopback only, open via SSH tunnel)
#   tunnel     cloudflared, only when TUNNEL_ENABLED=true and the credentials file exists
# Plus a nightly SQLite backup and old call-log cleanup.
set -u
cd /opt/router
: "${DATA_DIR:=/data}"
mkdir -p "$DATA_DIR/logs" "$DATA_DIR/backups"
# Stale pid files from another machine confuse the tools and OmniRoute's own launcher.
rm -f "$DATA_DIR"/*.pid "$DATA_DIR/server/.pid" "$DATA_DIR/supervisor/.pid" 2>/dev/null

run() {
  local name=$1; shift
  while true; do
    echo "[start] $name starting"
    "$@" 2>&1 | sed -u "s/^/[$name] /"
    echo "[start] $name stopped (exit ${PIPESTATUS[0]}), restarting in 5 s"
    sleep 5
  done
}

wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -fs -o /dev/null --max-time 3 "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}

trap 'echo "[start] stopping"; kill 0; exit 0' TERM INT

run omniroute /opt/router/app/node_modules/.bin/omniroute serve --headless --no-open --no-tray &
if wait_for "http://127.0.0.1:${PORT:-20128}/api/health" 180 || wait_for "http://127.0.0.1:${PORT:-20128}/" 30; then
  echo "[start] omniroute is up"
else
  echo "[start] omniroute is not answering yet; starting the rest anyway"
fi

run portal node --no-warnings tools/portal.mjs &
run admin node --no-warnings tools/admin.mjs &

if [ "${TUNNEL_ENABLED:-false}" = "true" ]; then
  CRED="$DATA_DIR/cloudflared/omniroute.json"
  if [ -f "$CRED" ]; then
    TUNNEL_ID=$(sed -n 's/.*"TunnelID"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CRED")
    cat > /tmp/cloudflared.yml <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED}
no-autoupdate: true
ingress:
  - hostname: ${TUNNEL_HOSTNAME:-api.nexus-api.tech}
    service: http://127.0.0.1:${PORTAL_PORT:-20130}
    originRequest:
      connectTimeout: 30s
      keepAliveTimeout: 10m
  - service: http_status:404
EOF
    run tunnel cloudflared --no-autoupdate tunnel --config /tmp/cloudflared.yml run &
  else
    echo "[start] TUNNEL_ENABLED=true but $CRED is missing; tunnel not started"
  fi
else
  echo "[start] tunnel off (TUNNEL_ENABLED is not true)"
fi

# Nightly at ~03:30: consistent SQLite copy (safe while running), keep 14 days; delete call logs older than 30 days.
(
  while true; do
    now=$(date +%s); next=$(date -d "$(date +%F) 03:30" +%s)
    [ "$next" -le "$now" ] && next=$((next + 86400))
    sleep $((next - now))
    f="$DATA_DIR/backups/storage-$(date +%F).sqlite"
    if sqlite3 "$DATA_DIR/storage.sqlite" ".backup '$f'"; then echo "[backup] ok $f"; else echo "[backup] FAILED"; fi
    find "$DATA_DIR/backups" -name 'storage-*.sqlite' -mtime +14 -delete
    find "$DATA_DIR/call_logs" -type f -mtime +30 -delete 2>/dev/null
  done
) &

wait
