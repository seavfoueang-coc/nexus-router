@echo off
rem Run any OmniRoute command against this folder, e.g.  omni.cmd keys list
set "DATA_DIR=%~dp0data"
"%~dp0app\node_modules\.bin\omniroute.cmd" %*
