@echo off
setlocal
cd /d "%~dp0.."
node devops\script_helpers\sync-osm-roads.mjs %*
endlocal
