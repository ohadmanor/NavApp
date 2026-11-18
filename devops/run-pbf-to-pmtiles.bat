@echo off
setlocal
cd /d "%~dp0..\tools\pbf-to-pmtiles"

if not exist "node_modules" (
  echo Installing dependencies for NavApp PBF-to-PMTiles Service...
  call npm install
)

if "%1"=="--run" (
  shift
  call npm run cli -- %*
  exit /b %ERRORLEVEL%
)

echo Starting NavApp PBF-to-PMTiles Service on http://127.0.0.1:4322 ...
start "" "http://127.0.0.1:4322"
call npm start
