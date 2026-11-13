@echo off
setlocal
title NavApp Israel Outdoor - Local Testing Server

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Outdoor Map Navigation (Israel DEM + OSM + POIs)
echo   Working Directory: %CD%
echo ============================================================================

if not exist "node_modules" (
    echo [1/4] Installing npm dependencies...
    call npm.cmd install
) else (
    echo [1/4] Dependencies verified in node_modules.
)

echo [2/4] Checking Map Data Archives ^& POIs in data\ folder:
if exist "data\Israel.dem.pmtiles" (
    echo   [OK] data\Israel.dem.pmtiles  ^(Constant Terrain DEM^)
) else (
    echo   [WARN] data\Israel.dem.pmtiles not found in data\
)
if exist "data\Israel.osm.pmtiles" (
    echo   [OK] data\Israel.osm.pmtiles  ^(Updatable OpenMapTiles Vector Map^)
    call node devops\build-pmtiles-search-index.mjs --if-present --if-stale
) else (
    echo   [WARN] data\Israel.osm.pmtiles not found in data\
)
if exist "data\Israel.pois.geojson" (
    echo   [OK] data\Israel.pois.geojson
) else (
    echo   [WARN] data\Israel.pois.geojson not found in data\
)
if exist "data\Israel.offroad.pois.geojson" (
    echo   [OK] data\Israel.offroad.pois.geojson
) else (
    echo   [WARN] data\Israel.offroad.pois.geojson not found in data\
)
if exist "data\Israel.search.idx" (
    echo   [OK] data\Israel.search.idx
) else (
    echo   [WARN] data\Israel.search.idx not found in data\
)
echo   Tip: Run devops\download-map-data.bat to sync data\ from Firebase Hosting.

echo [3/4] Starting Vite Local Server with HTTP 206 Byte-Range PMTiles Streaming...
echo       Opening http://localhost:5173 in your default browser...
start "" "http://localhost:5173"
call npm.cmd run dev

endlocal

