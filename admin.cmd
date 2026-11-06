@echo off
rem Admin dashboard for API keys, usage and models: http://127.0.0.1:20140 (this PC only).
rem   admin.cmd        run it (start.cmd does this for you)
rem   admin.cmd stop   stop it
set "DATA_DIR=%~dp0data"
if /i "%~1"=="stop" goto stop
node --no-warnings "%~dp0tools\admin.mjs"
goto :eof

:stop
powershell -NoProfile -Command "$n=0; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'tools\\admin\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $n++ }; Remove-Item (Join-Path $env:DATA_DIR 'admin.pid') -Force -EA 0; if($n){ 'Admin dashboard stopped.' }"