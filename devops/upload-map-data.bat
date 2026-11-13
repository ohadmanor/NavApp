@echo off
setlocal
title NavApp Israel Outdoor - Map Data Storage Uploader

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Map Data Storage Uploader (Dedicated Data Site)
echo   Target: https://navapp-israel-topo-data.web.app
echo   Files:  Israel.dem.pmtiles, Israel.osm.pmtiles,
echo           Israel.pois.geojson, Israel.offroad.pois.geojson, Israel.search.idx
echo   Working Directory: %CD%
echo ============================================================================

call node devops\upload-map-data.mjs %*
if errorlevel 1 (
    echo.
    echo [ERROR] Map data upload failed! Check your internet connection or Firebase login.
    pause
    exit /b 1
)

echo.
echo ============================================================================
echo   [SUCCESS] Map data successfully uploaded to Firebase Hosting!
echo   Data Origin: https://navapp-israel-topo-data.web.app
echo   Note: Web code deployments (deploy-firebase.bat) will NEVER touch these files!
echo ============================================================================
pause
endlocal
