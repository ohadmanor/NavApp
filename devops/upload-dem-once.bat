@echo off
setlocal
title NavApp Israel Outdoor - One-Time DEM Hosting Uploader

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - One-Time Static DEM Uploader (Dedicated hosting:dem Site)
echo   Target: https://navapp-israel-topo-dem.web.app/data/Israel.dem.pmtiles
echo   Note:   Run once! Normal updates (upload-map-data.bat) never touch DEM.
echo   Working Directory: %CD%
echo ============================================================================

call node devops\script_helpers\upload-dem-hosting.mjs %*
if errorlevel 1 (
    echo.
    echo [ERROR] DEM upload failed! Check your internet connection or Firebase login.
    pause
    exit /b 1
)

echo.
echo ============================================================================
echo   [SUCCESS] Israel.dem.pmtiles is ready on hosting:dem!
echo   URL: https://navapp-israel-topo-dem.web.app/data/Israel.dem.pmtiles
echo ============================================================================
pause
endlocal
