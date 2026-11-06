# Router on the shared VPS (Coolify)

The OmniRoute key service runs as one Coolify app on the same VPS as KHStream (217.15.162.153).
`VPS-DEPLOY.md` explains the system itself; this file is how it is deployed now.

## Shape
- **One container** (`Dockerfile`, `docker/start.sh`): OmniRoute (:20128), user portal (:20130), admin dashboard
  (:20140) and cloudflared. They must share one network namespace, because the portal and admin call OmniRoute's
  management API with the CLI token, which OmniRoute only accepts from loopback.
- **Public address**: `api.nexus-api.tech` through the existing Cloudflare Tunnel, now started inside the container
  (`TUNNEL_ENABLED=true`). No DNS change, no open ports, no Coolify domain.
- **Private dashboards**: 20128 and 20140 are published on the server's loopback only. From the PC:
  ```powershell
  ssh -i $env:USERPROFILE\.ssh\khstream_vps -N -L 20140:127.0.0.1:20140 -L 20128:127.0.0.1:20128 root@217.15.162.153
  ```
  then open http://127.0.0.1:20140 (admin) or http://127.0.0.1:20128 (OmniRoute). Close the window to disconnect.
- **Data**: Docker volume `router-data` mounted at `/data` (= the old `data\` folder): `storage.sqlite`, `.env`
  (holds `STORAGE_ENCRYPTION_KEY`; without it provider credentials can't be decrypted), `cli-token-salt.json`,
  `token-budgets.json`, `admin.json`, `cloudflared/omniroute.json`. Never in Git.
- **Backups**: nightly `sqlite3 .backup` at ~03:30 into `/data/backups`, kept 14 days; call logs older than 30 days
  are deleted. Copy backups off the server regularly.

## Corrections to VPS-DEPLOY.md
- On Linux OmniRoute ignores `HOSTNAME`; the bind setting is `OMNIROUTE_SERVER_HOST`. Inside the container it is
  `0.0.0.0` (the container itself is not reachable from the internet).
- `STORAGE_ENCRYPTION_KEY` **is** set in `data\.env` now (encryption is on). Copy `.env` exactly.
- The CLI token is HMAC(machine id, salt). The container mounts the host's `/etc/machine-id` read-only so the token
  stays stable across redeploys; it is derived at runtime, nothing to copy.

## Switching from the PC (one tunnel connector at a time)
1. Deploy in Coolify with `TUNNEL_ENABLED=false`; check the logs show omniroute, portal and admin up.
2. On the PC run `stop.cmd`, check no OmniRoute `node` / `cloudflared` is left.
3. Copy the data files into the volume (scp over SSH), `chown -R 1000:1000`.
4. Restart the app, test locally on the server (portal 200, `/v1/models` 401, admin login, keys list).
5. Set `TUNNEL_ENABLED=true`, redeploy, test `https://api.nexus-api.tech` from outside.
6. Don't run `start.cmd` on the PC again. Keep the PC's `data\` as a backup for a few weeks.
