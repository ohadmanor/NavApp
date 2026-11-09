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

if not exist "data\Israel.pois.geojson" (
    echo [2/4] Harvesting Israeli outdoor POIs into data\Israel.pois.geojson...
    call node devops\fetch-israel-pois.mjs
) else (
    echo [2/4] Verified data\Israel.pois.geojson exists.
)

echo [3/4] Checking PMTiles Archives in data\ folder:
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

echo [4/4] Starting Vite Local Server with HTTP 206 Byte-Range PMTiles Streaming...
echo       Opening http://localhost:5173 in your default browser...
start "" "http://localhost:5173"
call npm.cmd run dev

endlocal

