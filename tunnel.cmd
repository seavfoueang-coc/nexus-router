@echo off
rem Cloudflare Tunnel: publishes the user portal at https://api.nexus-api.tech
rem   tunnel.cmd        run it (start.cmd does this for you)
rem   tunnel.cmd stop   stop it
set "DATA_DIR=%~dp0data"
set "CF=%~dp0data\cloudflared"
if /i "%~1"=="stop" goto stop
"%CF%\bin\cloudflared.exe" tunnel --config "%CF%\config.yml" --pidfile "%CF%\tunnel.pid" run omniroute
goto :eof

:stop
powershell -NoProfile -Command "$f=Join-Path $env:CF 'tunnel.pid'; if(Test-Path $f){ $id=[int](Get-Content $f -Raw); $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -EA 0; if($p -and $p.CommandLine -match 'config\.yml'){ Stop-Process -Id $id -Force; 'Tunnel stopped.' }; Remove-Item $f -Force -EA 0 }"
