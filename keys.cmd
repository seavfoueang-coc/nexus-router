@echo off
rem Create and manage OmniRoute API keys with token limits, expiry and allowed models.
rem Run "keys.cmd help" for usage. OmniRoute must be running (start.cmd).
set "DATA_DIR=%~dp0data"
node --no-warnings "%~dp0tools\keys.mjs" %*
