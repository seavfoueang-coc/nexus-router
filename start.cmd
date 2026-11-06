@echo off
rem Router now runs on the VPS (Coolify project "Router"). Starting it here too would run a second
rem Cloudflare Tunnel connector and split users between two different databases.
rem See DEPLOY.md. To run on this PC anyway (e.g. after moving back), use start-local.cmd.
echo Router runs on the VPS now (https://api.nexus-api.tech). Not starting it on this PC.
echo Admin dashboard: see DEPLOY.md (SSH tunnel), or run start-local.cmd if you really moved back.
exit /b 1
