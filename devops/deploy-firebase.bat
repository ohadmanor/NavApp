@echo off
setlocal
title NavApp Israel Outdoor - Serverless Firebase Hosting Deployment

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Serverless Firebase Hosting Deployment
echo   Working Directory: %CD%
echo ============================================================================

echo [1/4] Updating offline PWA assets, POI dataset, and PMTiles search index...
call node devops\generate-offline-assets.mjs
if not exist "data\Israel.pois.geojson" (
    call node devops\fetch-israel-pois.mjs
)
call node devops\build-pmtiles-search-index.mjs --if-present --if-stale

echo [2/4] Building production PWA bundle ^(dist\^)...
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] Production build failed!
    pause
    exit /b 1
)

echo [3/4] Copying offline vector POIs ^& search index into dist\data\...
if not exist "dist\data" mkdir "dist\data"
if exist "data\Israel.pois.geojson" copy /Y "data\Israel.pois.geojson" "dist\data\Israel.pois.geojson" >nul
if exist "data\Israel.offroad.pois.geojson" copy /Y "data\Israel.offroad.pois.geojson" "dist\data\Israel.offroad.pois.geojson" >nul
if exist "data\Israel.search.idx" copy /Y "data\Israel.search.idx" "dist\data\Israel.search.idx" >nul
echo       [OK] Ready to deploy web app code.

echo [4/4] Deploying Web App to Firebase Hosting (Code only - Map data is independent)...
call npx.cmd firebase-tools deploy --only hosting:app
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

