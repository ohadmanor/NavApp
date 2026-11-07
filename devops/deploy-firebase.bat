@echo off
setlocal
title NavApp Israel Outdoor - Serverless Firebase Hosting Deployment

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Serverless Firebase Hosting Deployment
echo   Working Directory: %CD%
echo ============================================================================

echo [1/4] Updating offline PWA assets and POI dataset...
call node devops\generate-offline-assets.mjs
if not exist "data\Israel.pois.geojson" (
    call node devops\fetch-israel-pois.mjs
)

echo [2/4] Building production PWA bundle ^(dist\^)...
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] Production build failed!
    pause
    exit /b 1
)

echo [3/4] Copying all map data ^(Israel.pois.geojson, Israel.trails.geojson, Israel.osm.pmtiles, Israel.dem.pmtiles^) into dist\data\...
if not exist "dist\data" mkdir "dist\data"
if exist "data\Israel.pois.geojson" copy /Y "data\Israel.pois.geojson" "dist\data\Israel.pois.geojson" >nul
if exist "data\Israel.trails.geojson" copy /Y "data\Israel.trails.geojson" "dist\data\Israel.trails.geojson" >nul
if exist "data\Israel.osm.pmtiles" copy /Y "data\Israel.osm.pmtiles" "dist\data\Israel.osm.pmtiles" >nul
if exist "data\Israel.dem.pmtiles" copy /Y "data\Israel.dem.pmtiles" "dist\data\Israel.dem.pmtiles" >nul

echo [4/4] Deploying to Firebase Hosting...
call npx.cmd firebase-tools deploy --only hosting
if errorlevel 1 (
    echo.
    echo [INFO] If you are not logged into Firebase CLI yet, run:
    echo        npx firebase-tools login
    echo        npx firebase-tools use --add
    pause
    exit /b 1
)

echo.
echo ============================================================================
echo   [SUCCESS] NavApp deployed to Firebase Hosting!
echo ============================================================================
pause
endlocal

