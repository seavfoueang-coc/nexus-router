@echo off
set "DATA_DIR=%~dp0data"
call "%~dp0tunnel.cmd" stop
call "%~dp0portal.cmd" stop
call "%~dp0admin.cmd" stop
"%~dp0app\node_modules\.bin\omniroute.cmd" stop
