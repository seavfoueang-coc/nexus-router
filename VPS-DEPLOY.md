# OmniRoute key service: full setup and VPS deployment guide

This document describes a working system that currently runs on a Windows PC, and how to move it to a Linux VPS that **also hosts other products**. It is written so another engineer or AI agent can rebuild or migrate it without guessing.

- Sections 1–6 describe the system as it runs today. Treat them as fact.
- Sections 7–13 are the VPS plan. Items marked **TO BUILD** do not exist yet and must be implemented.
- No secrets appear in this file. Section 5 says where each secret lives.

---

## 1. What the system does

An AI API gateway that the owner shares with other people:

- **OmniRoute** (open-source AI gateway, npm package `omniroute`) connects to AI providers (currently one Kiro account) and exposes an OpenAI- and Anthropic-compatible API.
- The owner creates **API keys** for users. Each key has a **token limit** (input + output), a reset period (**once**, daily, weekly or monthly), an optional **expiry date**, and an **allowed-model list**.
- Users check their own balance on a **public balance page** and read **public API docs**.
- The owner manages keys, usage, models and provider credit balance in a private **admin dashboard**.
- Everything is published through a **Cloudflare Tunnel**, so no inbound ports are open.

Public address today: `https://api.nexus-api.tech` (balance page), `/docs` (API docs), `/v1` (API).
Domain: `nexus-api.tech`, on Cloudflare, status active.

---

## 2. Architecture

```
Internet
   │  HTTPS
   ▼
Cloudflare edge ──(outbound tunnel, no open ports)──► cloudflared (tunnel "omniroute")
                                                          │
                       api.nexus-api.tech ───────────────►│──► user portal        127.0.0.1:20130  (tools/portal.mjs)
                       admin.nexus-api.tech  (TO BUILD) ─►│──► admin dashboard    127.0.0.1:20140  (tools/admin.mjs)
                       omni.nexus-api.tech   (TO BUILD) ─►│──► admin.mjs gate ──► OmniRoute dashboard 127.0.0.1:20128
                                                          │
user portal  /v1/* ──► OmniRoute 127.0.0.1:20128 ──► AI providers (Kiro, …)
user portal  /portal/api/usage ──► OmniRoute management API + SQLite (read-only)
admin dashboard ──► OmniRoute management API (CLI token) + SQLite (read-only)
```

### Ports

| Port | Process | Bind | Purpose | Public? |
|---|---|---|---|---|
| 20128 | OmniRoute (Next.js server, `dist/server-ws.mjs`) | **must be 127.0.0.1 on the VPS** (today: 0.0.0.0) | Dashboard, management API `/api/*`, AI API `/v1/*` | Never directly |
| 20131 | OmniRoute | 127.0.0.1 | Internal WebSocket server | Never |
| 20132 | OmniRoute | 127.0.0.1 | Live WebSocket (`LIVE_WS_PORT`) | Never |
| 20130 | `tools/portal.mjs` | 127.0.0.1 | Balance page, docs, `/v1` proxy, one-time budget enforcement | Yes, via `api.` |
| 20140 | `tools/admin.mjs` | 127.0.0.1 | Admin dashboard | Via `admin.` (TO BUILD) |

**Do not use port 20131 for anything else.** The admin dashboard originally used 20131 and failed with `EADDRINUSE`, because OmniRoute owns it.

When co-hosting other products, reserve the range **20128–20140** for this stack and keep a port registry (Section 8).

---

## 3. Components

### 3.1 OmniRoute
- Package: `omniroute@3.8.52`, installed locally in `app/` (not globally).
- `app/.npmrc` must contain (npm 11+ blocks install scripts otherwise):
  ```
  allow-scripts=omniroute,keytar,onnxruntime-node,@parcel/watcher,@swc/core,protobufjs,esbuild
  ```
- Runtime: Node.js 24 (tested with v24.22.1). Uses `node:sqlite`.
- Start: `DATA_DIR=<data dir> app/node_modules/.bin/omniroute serve`
- Data dir (`DATA_DIR`) holds `storage.sqlite` (+ `-wal`, `-shm`), `.env`, logs and the CLI token salt.
- OmniRoute loads env files in this order (first one wins per key): `$DATA_DIR/.env`, then `~/.omniroute/.env`, then the cwd `.env`, then the package `.env`. **Keep all config in `$DATA_DIR/.env`.** The package `.env` is replaced on every reinstall.
- Important `.env` values today:
  - `PORT=20128`
  - `REQUIRE_API_KEY=true` (**required**; without it, `/v1` accepted requests with no key and no limits applied)
  - `NODE_ENV=production`
  - `ALLOW_API_KEY_REVEAL=false`
  - `BASE_URL=http://localhost:20128`, `NEXT_PUBLIC_BASE_URL=http://localhost:20128`
  - `PROVIDER_LIMITS_SYNC_INTERVAL_MINUTES=70`
  - `STORAGE_ENCRYPTION_KEY` is **not set**, so provider credentials are stored in plaintext. See 11.4.
- Dashboard password: stored as a bcrypt hash in the database (settings). `INITIAL_PASSWORD` in `.env` is ignored once a password is saved. The owner changed the password away from the default `CHANGEME`, so it migrates with the database.
- **Never use OmniRoute's built-in tunnel feature** (`omniroute tunnel create`, or the tunnel button in its dashboard). It publishes port 20128, the whole dashboard. It was found running once and was shut down. `omniroute tunnel stop` hangs on Windows. If one ever runs, kill the `cloudflared ... --url http://127.0.0.1:20128` process.

### 3.2 User portal — `tools/portal.mjs` (+ `tools/portal/index.html`, `tools/portal/docs.html`)
Plain Node `http` server, no dependencies.
- Env: `DATA_DIR`, `PORT` (OmniRoute port, default 20128), `PORTAL_HOST` (default 127.0.0.1), `PORTAL_PORT` (default 20130).
- Routes:
  - `GET /` serves the balance page (`index.html`). The user pastes a key and sees tokens left, input/output used, reset time, expiry and allowed models. The key can be remembered in `localStorage`. It auto-refreshes every 60 s.
  - `GET /docs` serves the API docs (`docs.html`). It uses `location.origin` to show the real base URL.
  - `POST /portal/api/usage` with body `{key}` returns usage for that key only. It hashes the key with SHA-256, matches `api_keys.key_hash`, and is rate-limited to 30 lookups/min/IP.
  - `ANY /v1/*` is proxied to OmniRoute. It strips `cookie` and `x-omniroute-cli-token`, sets `x-forwarded-for` from `cf-connecting-ip` (only trusted from loopback), rejects `..`/encoded traversal with 400, rewrites 429 `token_limit_exceeded` bodies into a friendly "Out of tokens…" message, and supports streaming (SSE).
  - Everything else returns 404. **The OmniRoute dashboard and management API are not reachable through the portal.** Verified: `/dashboard`, `/login`, `/api/keys` and `/admin/api/keys` all return 404, and `/v1/../api/keys` returns 400.
- **One-time budget enforcement** (see 4.2): it checks before forwarding, and sweeps every 30 s to disable exhausted keys.
- CSP blocks the Cloudflare Web Analytics beacon. Harmless; turn off Web Analytics in Cloudflare to remove the console warning.

### 3.3 Admin dashboard — `tools/admin.mjs` (+ `tools/admin/index.html`)
Plain Node `http` server.
- Env: `DATA_DIR`, `PORT` (OmniRoute), `ADMIN_PORT` (default 20140), `PORTAL_PORT`.
- Binds 127.0.0.1. Today it only accepts `Host` values `127.0.0.1:20140` / `localhost:20140` (anti DNS-rebinding), and non-GET requests need `Origin` from those hosts plus the header `x-admin-request: 1` (CSRF).
- **Login uses the OmniRoute dashboard password.** It forwards to `POST http://127.0.0.1:20128/api/auth/login`; 200 means success. Sessions: random 32-byte token, `HttpOnly; SameSite=Strict` cookie `omr_admin`, 12 h sliding expiry, in memory (restart signs everyone out). Login is limited to 10 attempts per 5 minutes, globally.
- Pages: **Overview** (today/7d/30d tokens, a 30-day chart, top keys and models, "needs attention", and a provider "tokens left" card), **API keys** (create, edit, enable/disable, delete with typed confirmation, a usage drawer with per-model usage and recent requests), **Models** (the full catalog from `/v1/models`, usage, and per-key on/off toggles), **Providers** (live credit balance and an estimated tokens-left figure). The sidebar shows the provider tokens-left count.
- API (all under `/admin/api/`, session required except `session` and `login`):
  `GET session`, `POST login`, `POST logout`, `GET overview`, `GET keys`, `POST keys`, `GET keys/:id`, `PATCH keys/:id`, `DELETE keys/:id`, `POST keys/:id/enable|disable`, `GET models[?refresh=1]`, `GET providers[?refresh=1]`.
- Config file `$DATA_DIR/admin.json`:
  - `catalogKeyId`, `catalogSecret`: an internal OmniRoute API key named `admin-model-catalog (internal, list models only)`, restricted to the `models` endpoint category. It is used to read `/v1/models` exactly as clients see it. It is hidden from all key lists. If it is deleted, a new one is created automatically.
  - `publicUrl`: `https://api.nexus-api.tech`. Shown in the "send this to the user" message after a key is created.
- Provider balance: reads `GET /api/usage/<connectionId>` (live, cached 2 min) and `GET /api/usage/provider-limits`. The tokens-left estimate is `credits_remaining / credits_spent × tokens_used` over the last 30 days of `usage_history.provider_credits`. It also reports credits used **outside OmniRoute** (the provider's total used minus what OmniRoute recorded).

### 3.4 Shared key logic — `tools/keyops.mjs`, `tools/budgets.mjs`, CLI `tools/keys.mjs`
- `keyops.mjs` handles create/update/enable/disable/delete keys and holds the limit logic. It is used by both `keys.mjs` and `admin.mjs`.
- `budgets.mjs` reads and writes `$DATA_DIR/token-budgets.json` (one-time budgets) with atomic writes, and computes lifetime tokens from SQLite.
- CLI: `DATA_DIR=<data> node tools/keys.mjs <create|edit|list|show|enable|disable|delete|help> …`
  Example: `keys.mjs create friend --tokens 50M --reset once --days 30 --models "kr/claude-opus-5.5"`
- How they talk to OmniRoute: HTTP to `127.0.0.1:20128` with the header `x-omniroute-cli-token`. The token is derived by `app/node_modules/omniroute/bin/cli/utils/cliToken.mjs` from the machine ID plus `$DATA_DIR/cli-token-salt.json`. **OmniRoute only accepts it from loopback and rejects it when `X-Forwarded-For` or `cf-connecting-ip` is present.** On a new machine the token changes automatically; nothing has to be copied.

### 3.5 Cloudflare Tunnel
- Tunnel name `omniroute`, ID `e3f078f4-091c-4aef-9671-e3dfb7891462`.
- Credentials: `$DATA_DIR/cloudflared/omniroute.json` (**secret**). Account cert from `cloudflared tunnel login`: `~/.cloudflared/cert.pem`. It is only needed to create tunnels or DNS routes, not to run them.
- DNS: `api.nexus-api.tech` is a CNAME to the tunnel (created with `cloudflared tunnel route dns omniroute api.nexus-api.tech`).
- Config today (`$DATA_DIR/cloudflared/config.yml`):
  ```yaml
  tunnel: e3f078f4-091c-4aef-9671-e3dfb7891462
  credentials-file: <DATA_DIR>/cloudflared/omniroute.json
  no-autoupdate: true
  ingress:
    - hostname: api.nexus-api.tech
      service: http://127.0.0.1:20130
      originRequest:
        connectTimeout: 30s
        keepAliveTimeout: 10m
    - service: http_status:404
  ```
- Run: `cloudflared tunnel --config config.yml run omniroute`
- The cloudflared token from `tunnel login` **cannot** manage Cloudflare Access (it returned 403). Access would need a separate API token or dashboard setup. The owner chose **not** to use Access, so protection is done in `admin.mjs` (Section 9).

---

## 4. Business rules (must be preserved)

### 4.1 Token limits
- Counted as **input + output (+ reasoning)** tokens. `usage_history.tokens_input` already includes cache-read and cache-write tokens (OmniRoute migration 012), so don't add those columns again.
- **Periodic limits** (daily/weekly/monthly) are OmniRoute's native per-key token limits: `POST /api/usage/token-limits` with `{apiKeyId, scopeType:"global", scopeValue:"*", tokenLimit, resetInterval}`. Windows reset at **00:00 UTC**; weekly resets on Monday, monthly on the 1st. When a key goes over, OmniRoute returns 429 `token_limit_exceeded` before forwarding the request.
  - Known OmniRoute bug: the **first request of each window is counted twice** in its counter. It errs in the safe direction (the user gets slightly less).
- **One-time limits** ("once", never reset) are not supported by OmniRoute. They are implemented here:
  - `token-budgets.json` stores `{ "<keyId>": { mode:"once", tokenLimit, name, createdAt, blockedByLimit } }`.
  - Usage = lifetime sum from `usage_history` for that key (exact, no double counting).
  - The portal blocks the request before forwarding once the budget is used up (429, with OpenAI- or Anthropic-format error bodies).
  - A sweep every 30 s disables exhausted keys in OmniRoute (`isActive:false`, `blockedByLimit:true`), so direct calls fail too.
  - Raising `tokenLimit` above usage re-enables a key that the system disabled. `enable` is refused while the budget is used up.
  - Safety cap: each one-time key also gets an OmniRoute **monthly** limit of **2 × budget**. It only matters if the portal is down; 2× avoids the double-count bug blocking early.
  - **The portal must be running for one-time limits to be exact.**
- Expiry: OmniRoute `expiresAt` on the key (expired keys get 403).
- Allowed models: OmniRoute `modelAccessMode:"restricted"` plus `allowedModels`. Other models get 403. `kr/…` and `kiro/…` are two aliases of the same Kiro models, and **allowing one does not allow the other**.
- Optional per-key request limits exist in OmniRoute (`rateLimits`, `maxRequestsPerMinute`). They aren't used yet; recommended (Section 13).

### 4.2 Statuses shown everywhere
`active`, `out_of_tokens`, `disabled`, `expired`, `revoked`, `banned`.

### 4.3 Provider failover (OmniRoute built-in)
- Between **accounts of the same provider**, failover is automatic: quota preflight, plus a cooldown and the next account on 429/quota errors.
- Between **different providers**, it needs an OmniRoute **combo**, and keys must allow that combo.
- Today there is **only one working account** (Kiro). It has **0 credits until 2026-12-01**: most credits were used outside OmniRoute, probably by the owner's own Kiro app. A second connection, `agy`, is expired (refresh token rejected).

---

## 5. Files and secrets

Current Windows layout (`D:\ALL FILE\PROJECT\Router`):
```
app/                       OmniRoute install (package.json, .npmrc, node_modules)  ~2.1 GB
data/                      DATA_DIR  (~63 MB)
  .env                     OmniRoute config                                SECRET
  storage.sqlite(+wal,shm) keys, usage, providers (plaintext creds!), password hash   SECRET
  cli-token-salt.json      CLI token salt                                  SECRET
  token-budgets.json       one-time budgets
  admin.json               catalog key + publicUrl                         SECRET (catalogSecret)
  cloudflared/omniroute.json   tunnel credentials                          SECRET
  cloudflared/config.yml   tunnel ingress
  cloudflared/bin/cloudflared.exe   Windows only, do not copy
  logs/, call_logs/        logs (call_logs grows; rotate)
tools/                     portal.mjs, admin.mjs, keyops.mjs, budgets.mjs, keys.mjs, portal/*.html, admin/index.html
*.cmd                      Windows scripts (start, stop, portal, admin, tunnel, keys, omni) — replace on Linux
~/.cloudflared/cert.pem    Cloudflare account cert                         SECRET
```
`*.pid`, `login.log*`, `quick-tunnel-*` and `.env.bak-*` don't need to be migrated.

---

## 6. Verified behaviour (as of 2026-11-06)
- Public: `api.nexus-api.tech/` → 200; `/docs` → 200; `/v1/models` without a key → 401; with a fake key → 401.
- Real chat, streaming, `/v1/messages` (both `x-api-key` and Bearer), `/v1/responses` and tool calling all worked through the public address while Kiro had credits.
- Model not allowed → 403. Disabled key → 401. One-time budget used up → 429 "Out of tokens… does not reset", then auto-disabled within 30 s.
- Admin: sign-in, overview, keys CRUD, models, provider balance all OK.
- Current blocker: every AI request returns 429 "All kiro accounts have exhausted their quota", because Kiro has 0 credits.

---

## 7. Target VPS

- Ubuntu 24.04 LTS, at least 2 vCPU / 4 GB RAM / 40 GB disk for this stack plus small co-hosted products. This stack uses about 350 MB RAM at idle (OmniRoute about 285 MB).
- The location barely matters for speed. Every request goes on to the provider (Kiro is in us-east-1), and Cloudflare is in front.
- Test Kiro from the datacenter IP with one small key before announcing the move.

---

## 8. Co-hosting with other products (rules)

1. **One cloudflared tunnel for everything** (recommended). Add every product as another `ingress` hostname in the same `config.yml`, all pointing at `127.0.0.1:<port>`. No inbound HTTP ports are needed on the VPS.
   - If another product already uses Caddy or nginx on 80/443, keep it. Either point a hostname from the tunnel at that proxy, or leave this stack on the tunnel. **Don't publish OmniRoute's 20128 through any proxy.**
2. **Every service binds 127.0.0.1.** The firewall allows SSH only (plus 80/443 only if another product really needs direct access).
3. **Port registry** (keep this table in the repo and add other products to it):

   | Port | Service |
   |---|---|
   | 20128 | omniroute |
   | 20130 | omniroute-portal |
   | 20131, 20132 | omniroute internal WS |
   | 20140 | omniroute-admin |
   | 3000–3999 / 8000–8999 | free for other products (pick and record) |

4. **Separate Linux user per product**, e.g. `omniroute` for this stack, own home dir, no sudo. Files under `/opt/<product>`.
5. **systemd services with limits.** Use `MemoryMax=`/`CPUQuota=` so one product can't starve the others (Section 10).
6. **Node versions:** this stack needs Node 24. If other products need different versions, install Node per product (e.g. separate tarballs under `/opt/node-24`, referenced by absolute path in the unit files) rather than one global version.
7. **Separate backups and logs per product** (`/var/backups/<product>`, journald).
8. **Cookie isolation:** each product gets its own hostname. Use host-only cookies, never `Domain=.nexus-api.tech`, so products never see each other's sessions.

---

## 9. TO BUILD: public but protected admin and OmniRoute dashboards

The owner wants `admin.nexus-api.tech` (admin dashboard) and `omni.nexus-api.tech` (OmniRoute dashboard, used to add providers) reachable from anywhere, **without Cloudflare Access**. Both must be served by `tools/admin.mjs`, so there is a single hardened login in front of OmniRoute.

### 9.1 Config
Add to `$DATA_DIR/admin.json`:
```json
{ "publicAdminHost": "admin.nexus-api.tech", "publicOmniHost": "omni.nexus-api.tech" }
```

### 9.2 Required changes in `tools/admin.mjs`
1. **Hosts:** allow `Host` = `publicAdminHost` and `publicOmniHost`, in addition to the localhost values. Requests for those hosts are trusted only when the TCP peer is loopback (that is, they came from cloudflared). Any other `Host` → 421.
2. **Origin/CSRF:** accept `Origin: https://<publicAdminHost>` for admin API calls. Keep requiring `x-admin-request: 1`.
3. **Client IP:** for public hosts, use `cf-connecting-ip` (only when the peer is loopback).
4. **Brute force:** keep the global limit, and add a per-IP lockout: 5 failed logins → locked for 15 min (respond 429 with retry time). Log failed attempts with IP to the journal.
5. **Cookies on public hosts:** `Secure; HttpOnly; SameSite=Strict; Path=/`, host-only (no `Domain`). Shorter idle timeout, e.g. 2 h sliding, 12 h absolute.
6. **Password guard:** refuse to serve public hosts (show a static "set a new dashboard password first" page) while `CHANGEME` still logs in. Check by calling OmniRoute login at startup and every 10 min, cached. Today the guard passes, since the password was changed.
7. **Omni gate (`Host = publicOmniHost`):**
   - No valid admin session → serve the admin login page on that host (same login code, separate host-only cookie). After login, redirect to the originally requested path.
   - With a valid session → reverse-proxy everything to `http://127.0.0.1:20128`, **including WebSocket upgrades** (`server.on('upgrade')`, pipe both sockets).
   - Request headers to OmniRoute:
     - remove `x-omniroute-cli-token`
     - remove the gate's own `omr_admin` cookie, but keep OmniRoute's own cookies
     - set `X-Forwarded-For: <client ip>` (so OmniRoute's loopback-only trust paths fail closed)
     - set `X-Forwarded-Proto: https`, `X-Forwarded-Host: <publicOmniHost>`
   - Check `Origin` on state-changing requests yourself: it must equal `https://<publicOmniHost>`. If OmniRoute rejects the proxied origin for its own CSRF checks, rewrite `Origin` to `http://127.0.0.1:20128` **only after** that check passes.
   - Response headers: pass OmniRoute's `Set-Cookie` through, but drop any `Domain=` attribute and add `Secure`.
   - OmniRoute still asks for its own password after the gate. That's intended: two locks.
8. **Tests that must pass** (run from outside, through Cloudflare):
   - `https://admin.nexus-api.tech/` without a session → login page; all `/admin/api/*` → 401.
   - 6 wrong passwords from one IP → 429 lockout.
   - `https://omni.nexus-api.tech/dashboard` and `/api/keys` without a gate session → gate login page or 401, never OmniRoute content.
   - With a gate session but no OmniRoute login: `/api/keys` → 401 (OmniRoute's own auth still applies).
   - `x-omniroute-cli-token` sent by the client is ignored (still 401).
   - `https://api.nexus-api.tech` behaves exactly as before.
   - Provider OAuth sign-ins that need a `localhost` callback may not work remotely. API-key providers (Kiro, etc.) must work. Document what fails.

### 9.3 Tunnel ingress after 9.2 is done
```yaml
ingress:
  - hostname: api.nexus-api.tech
    service: http://127.0.0.1:20130
    originRequest: { connectTimeout: 30s, keepAliveTimeout: 10m }
  - hostname: admin.nexus-api.tech
    service: http://127.0.0.1:20140
  - hostname: omni.nexus-api.tech
    service: http://127.0.0.1:20140      # the gate in admin.mjs, NOT 20128
  # other products:
  # - hostname: shop.nexus-api.tech
  #   service: http://127.0.0.1:3000
  - service: http_status:404
```
DNS: `cloudflared tunnel route dns omniroute admin.nexus-api.tech` (same for `omni.` and each product's hostname). This needs `~/.cloudflared/cert.pem`.

---

## 10. TO BUILD: Linux service layout

### 10.1 Directories
```
/opt/omniroute/app/       npm install of omniroute@3.8.52 (+ .npmrc above)
/opt/omniroute/tools/     copied from Windows tools/ unchanged
/opt/omniroute/data/      DATA_DIR (chmod 700, owned by user omniroute)
/etc/cloudflared/config.yml   shared tunnel config (all products), credentials in /etc/cloudflared/omniroute.json (chmod 600)
```

### 10.2 `.env` changes for the VPS
- Add `HOSTNAME=127.0.0.1` so OmniRoute binds loopback only. It binds 0.0.0.0 by default (Next.js `HOSTNAME`). **Verify with `ss -ltnp` that 20128 is on 127.0.0.1.**
- When `omni.` is live: `AUTH_COOKIE_SECURE=true`, and consider `BASE_URL=https://omni.nexus-api.tech`. Test the login after changing.
- Keep `REQUIRE_API_KEY=true`.

### 10.3 systemd units (`/etc/systemd/system/`)
```ini
# omniroute.service
[Unit]
Description=OmniRoute gateway
After=network-online.target
Wants=network-online.target
[Service]
User=omniroute
WorkingDirectory=/opt/omniroute
Environment=DATA_DIR=/opt/omniroute/data
ExecStart=/opt/omniroute/app/node_modules/.bin/omniroute serve
Restart=always
RestartSec=5
MemoryMax=1500M
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```
```ini
# omniroute-portal.service
[Unit]
Description=OmniRoute user portal
After=omniroute.service
[Service]
User=omniroute
WorkingDirectory=/opt/omniroute
Environment=DATA_DIR=/opt/omniroute/data
ExecStart=/usr/bin/node --no-warnings /opt/omniroute/tools/portal.mjs
Restart=always
RestartSec=3
MemoryMax=300M
[Install]
WantedBy=multi-user.target
```
`omniroute-admin.service` is the same with `tools/admin.mjs`.
`cloudflared` installs its own service: `cloudflared service install`, or a unit running `cloudflared --no-autoupdate tunnel --config /etc/cloudflared/config.yml run omniroute`, with `Restart=always`.

Enable everything: `systemctl enable --now omniroute omniroute-portal omniroute-admin cloudflared`.

### 10.4 Replace the Windows scripts
| Windows | Linux |
|---|---|
| `start.cmd` / `stop.cmd` | `systemctl start|stop omniroute omniroute-portal omniroute-admin cloudflared` |
| `keys.cmd …` | `sudo -u omniroute env DATA_DIR=/opt/omniroute/data node /opt/omniroute/tools/keys.mjs …` (make a `/usr/local/bin/omr-keys` wrapper) |
| `omni.cmd …` | `sudo -u omniroute env DATA_DIR=… /opt/omniroute/app/node_modules/.bin/omniroute …` |
| pid files | not needed with systemd. `portal.mjs`/`admin.mjs` still write `*.pid` in DATA_DIR, harmless |
| Logs in `data/logs/*.log` | `journalctl -u <service>` |

---

## 11. TO BUILD: migration runbook (Windows PC → VPS)

1. **Prepare the VPS:** create the `omniroute` user, install Node 24 and cloudflared (Cloudflare apt repo), set up the firewall (`ufw allow OpenSSH; ufw enable`), turn on unattended-upgrades, and use SSH keys only (`PasswordAuthentication no`).
2. **Install OmniRoute** in `/opt/omniroute/app` (`npm install omniroute@3.8.52`, with the `.npmrc` above). Copy `tools/`.
3. **Stop everything on Windows** (`stop.cmd`) so SQLite flushes the WAL. Check that no `cloudflared` or OmniRoute `node` processes remain.
4. **Copy the data**: `storage.sqlite` (+ `-wal`/`-shm` if present), `.env`, `cli-token-salt.json`, `token-budgets.json`, `admin.json`, `cloudflared/omniroute.json`, `~/.cloudflared/cert.pem`. Use `scp`/`rsync` over SSH only. Set ownership `omniroute:omniroute` and permissions `chmod 600` for secrets.
5. **Fix paths:** set `credentials-file` in config.yml to the Linux path, and add `HOSTNAME=127.0.0.1` to `.env`.
6. **Start OmniRoute, the portal and admin first, without the tunnel.** Test locally on the VPS:
   - `curl -s 127.0.0.1:20130/` → 200
   - admin login → 200
   - `node tools/keys.mjs list` shows the same keys and usage as on Windows
   - an existing user key works on `/v1/models` (keys are checked by hash, so they should keep working; **verify**)
7. **Only one tunnel connector may run.** If the Windows tunnel and the VPS tunnel run at the same time, Cloudflare splits traffic between two different databases. Make sure Windows is stopped, then start cloudflared on the VPS.
8. **Test publicly** using everything in Section 6 (and 9.2 once built).
9. **Disable the Windows setup:** don't run `start.cmd` again. Keep the Windows `data/` as a backup copy for a few weeks, then delete it securely.

### 11.4 Storage encryption (do after a successful migration, with a fresh backup)
`STORAGE_ENCRYPTION_KEY` is unset, so the credentials are plaintext. OmniRoute refuses to auto-generate a key when a database already exists. Setting a key on an existing plaintext DB is **untested here**. Test on a copy first: set the key, restart, and check that providers still work and new credentials get the `enc:v1:` prefix. If it fails, the documented fallback is to re-add providers after enabling encryption on a fresh DB. Save the key in a password manager; losing it means losing the credentials.

---

## 12. TO BUILD: operations

- **Backups:** nightly `sqlite3 storage.sqlite ".backup /var/backups/omniroute/storage-$(date +%F).sqlite"`, plus the JSON files and `.env`. Keep 14 days, and copy them off the server (e.g. to object storage).
- **Log rotation:** delete `data/call_logs/*` older than 30 days (cron or a systemd timer).
- **Alerts** (owner wants Telegram or Discord; not chosen yet): Kiro credits below 20%/10%, a key out of tokens or expiring within 3 days, a service down, provider errors. The data is available from the admin API (`/admin/api/overview`, `/admin/api/providers`).
- **Health checks:** an external uptime monitor on `https://api.nexus-api.tech/` and `/v1/models` (expects 401).
- **Updates:** pin `omniroute@3.8.52`. Test new versions on a copy of `data/` first, because the database migrations are one-way.

---

## 13. Known issues and recommendations

| Item | Status | Action |
|---|---|---|
| Kiro has 0 credits until 2026-12-01 | **Blocks all AI requests** | Add another provider account, or wait. Keep the owner's personal Kiro use on a different account |
| Keys can use about 100M tokens; Kiro covers about 22M per month | Over-committed | Watch the Providers page, add accounts |
| `agy` connection expired | Inactive | Re-authenticate or remove it in OmniRoute |
| Selling or sharing Kiro access may break Kiro's terms | Risk of an account ban | Owner decision. Prefer providers that allow resale |
| No per-key request rate limits | Not set | Set e.g. 30 req/min per key in OmniRoute |
| OmniRoute binds 0.0.0.0 on Windows | LAN-reachable today | `HOSTNAME=127.0.0.1` on the VPS |
| Credentials stored in plaintext | `STORAGE_ENCRYPTION_KEY` unset | Section 11.4 |
| Periodic limits double-count the first request per window | OmniRoute bug | Accept, or report upstream |
| One-time limits depend on the portal process | By design | systemd `Restart=always`, plus the 2× monthly safety cap |
| Old global install and `C:\Users\Admin\.omniroute` on the PC | Leftover | Remove after migration |

---

## 14. Quick reference: OmniRoute endpoints used

| Purpose | Request |
|---|---|
| List keys | `GET /api/keys` |
| Create key (returns plaintext once) | `POST /api/keys {name, expiresAt?, modelAccessMode?, allowedModels?}` |
| Update key | `PATCH /api/keys/:id {isActive?, name?, expiresAt?, modelAccessMode?, allowedModels?, allowedEndpoints?}` |
| Delete key | `DELETE /api/keys/:id` |
| Token limit get/set | `GET /api/usage/token-limits?apiKeyId=…`, `POST /api/usage/token-limits {…}` |
| Providers | `GET /api/providers` |
| Live provider quota | `GET /api/usage/:connectionId` |
| Cached provider limits | `GET /api/usage/provider-limits` |
| Dashboard login | `POST /api/auth/login {password}` (send an `Origin` header) |
| Change password | `PATCH /api/settings {currentPassword, newPassword}` (dashboard session cookie) |
| Model catalog | `GET /v1/models` (API key) |

SQLite tables read directly (read-only): `api_keys` (`id`, `key_hash`, …), `usage_history` (`api_key_id`, `connection_id`, `provider`, `model`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `provider_credits`, `timestamp` ISO UTC), `call_logs` (recent requests).
