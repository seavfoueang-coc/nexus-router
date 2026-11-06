@echo off
rem User portal + public API gateway for OmniRoute.
rem   portal.cmd        run it (start.cmd does this for you)
rem   portal.cmd stop   stop it
set "DATA_DIR=%~dp0data"
if /i "%~1"=="stop" goto stop
node --no-warnings "%~dp0tools\portal.mjs"
goto :eof

:stop
powershell -NoProfile -Command "$n=0; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'tools\\portal\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $n++ }; Remove-Item (Join-Path $env:DATA_DIR 'portal.pid') -Force -EA 0; if($n){ 'User portal stopped.' }"