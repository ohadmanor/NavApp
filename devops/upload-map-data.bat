@echo off
setlocal
title NavApp Israel Outdoor - Map Data Storage Uploader

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Map Data Storage Uploader (Dedicated Data Site)
echo   Target: https://navapp-israel-topo-data.web.app
echo   Working Directory: %CD%
echo ============================================================================

if not exist "deploy_data\data" mkdir "deploy_data\data"

REM If user dragged and dropped an existing file onto this script:
if not "%~1"=="" (
    if exist "%~1" (
        echo [ARGUMENT] File provided: %~1
        if /I "%~nx1"=="Israel.dem.pmtiles" (
            copy /Y "%~1" "deploy_data\data\Israel.dem.pmtiles" >nul
            echo   [COPIED] Copied %~1 to deploy_data\data\Israel.dem.pmtiles
        ) else if /I "%~nx1"=="Israel.osm.pmtiles" (
            copy /Y "%~1" "deploy_data\data\Israel.osm.pmtiles" >nul
            echo   [COPIED] Copied %~1 to deploy_data\data\Israel.osm.pmtiles
        ) else (
            echo   [CUSTOM] Detected: %~nx1
            echo   Assuming this is the new updatable vector map: Israel.osm.pmtiles
            copy /Y "%~1" "deploy_data\data\Israel.osm.pmtiles" >nul
        )
    )
)

echo [1/3] Checking map files in data\ and deploy_data\ folder:

set FOUND_ANY=0

if exist "data\Israel.dem.pmtiles" (
    echo   [FOUND] data\Israel.dem.pmtiles (Constant DEM - 1.4 GB)
    copy /Y "data\Israel.dem.pmtiles" "deploy_data\data\Israel.dem.pmtiles" >nul
    set FOUND_ANY=1
) else (
    if exist "deploy_data\data\Israel.dem.pmtiles" (
        echo   [PRESERVED] deploy_data\data\Israel.dem.pmtiles is already present.
        set FOUND_ANY=1
    ) else (
        echo   [SKIP] data\Israel.dem.pmtiles not found in data\
    )
)

if exist "data\Israel.osm.pmtiles" (
    echo   [FOUND] data\Israel.osm.pmtiles (Updatable Vector Map)
    copy /Y "data\Israel.osm.pmtiles" "deploy_data\data\Israel.osm.pmtiles" >nul
    set FOUND_ANY=1
) else (
    if exist "deploy_data\data\Israel.osm.pmtiles" (
        echo   [PRESERVED] deploy_data\data\Israel.osm.pmtiles is already present.
        set FOUND_ANY=1
    ) else (
        echo   [SKIP] data\Israel.osm.pmtiles not found in data\
    )
)

if exist "deploy_data\data\Israel.osm.pmtiles" (
    call node devops\build-pmtiles-search-index.mjs --if-present --input deploy_data\data\Israel.osm.pmtiles
)

if exist "data\Israel.pois.geojson" (
    copy /Y "data\Israel.pois.geojson" "deploy_data\data\Israel.pois.geojson" >nul
)
if exist "data\Israel.search.idx" (
    copy /Y "data\Israel.search.idx" "deploy_data\data\Israel.search.idx" >nul
)

if not exist "deploy_data\data\*.pmtiles" goto :NO_FILES

echo [2/3] Uploading map data to Firebase Hosting (Data site: navapp-israel-topo-data)...
call npx.cmd firebase-tools deploy --only hosting:data
if errorlevel 1 (
    echo.
    echo [ERROR] Map data upload failed! Check your internet connection or login.
    pause
    exit /b 1
)

echo.
echo ============================================================================
echo   [SUCCESS] Map data successfully uploaded to Firebase Storage!
echo   Data Origin: https://navapp-israel-topo-data.web.app
echo   Note: Web code deployments (deploy-firebase.bat) will NEVER touch these files!
echo ============================================================================
pause
endlocal
exit /b 0

:NO_FILES
echo.
echo ============================================================================
echo   [INFO] No .pmtiles map archives found to upload.
echo.
echo   To upload map data to Firebase Storage / Hosting:
echo   1. Place Israel.dem.pmtiles [Constant DEM 1.4 GB] in the data\ folder
echo   2. Place Israel.osm.pmtiles [Vector Map ~112 MB] in the data\ folder
echo      (Or drag-and-drop the .pmtiles file onto this .bat script)
echo   3. Run this script again.
echo ============================================================================
echo.
pause
endlocal
exit /b 0
