@echo off
setlocal
title NavApp Israel Outdoor - Map Data Downloader (Firebase Source of Truth)

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Map Data Downloader (Firebase Source of Truth)
echo   Source: https://navapp-israel-topo-data.web.app/data/
echo   Target: %CD%\data\
echo ============================================================================

call node devops\download-map-data.mjs %*
if errorlevel 1 (
    echo.
    echo [ERROR] Download failed! Check your internet connection.
    pause
    exit /b 1
)

echo.
echo ============================================================================
echo   [SUCCESS] Local data\ folder is synced with Firebase Hosting.
echo ============================================================================
pause
endlocal
