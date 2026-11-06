@echo off
set "DATA_DIR=%~dp0data"
cd /d "%~dp0"

rem User portal + public API gateway on http://localhost:20130 (runs in its own minimized window).
call "%~dp0portal.cmd" stop >nul 2>&1
start "OmniRoute user portal" /min cmd /c ""%~dp0portal.cmd" >> "%~dp0data\logs\portal.log" 2>&1"

rem Admin dashboard for API keys, usage and models on http://127.0.0.1:20140 (this PC only).
call "%~dp0admin.cmd" stop >nul 2>&1
start "OmniRoute admin" /min cmd /c ""%~dp0admin.cmd" >> "%~dp0data\logs\admin.log" 2>&1"

rem Cloudflare Tunnel: publishes ONLY the user portal at https://api.nexus-api.tech
call "%~dp0tunnel.cmd" stop >nul 2>&1
start "OmniRoute tunnel" /min cmd /c ""%~dp0tunnel.cmd" >> "%~dp0data\logs\tunnel.log" 2>&1"

rem Open the dashboard in the browser once the server answers (waits up to 3 minutes).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){ try{ Invoke-WebRequest -UseBasicParsing http://localhost:20128 -TimeoutSec 3 | Out-Null; Start-Process 'http://localhost:20128'; break }catch{ Start-Sleep 2 } }"

"%~dp0app\node_modules\.bin\omniroute.cmd" serve %*
