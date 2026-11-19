@echo off
setlocal
title NavApp Israel Outdoor - Serverless Firebase Hosting Deployment

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Serverless Firebase Hosting Deployment
echo   Working Directory: %CD%
echo ============================================================================

echo [1/3] Updating offline PWA assets...
call node devops\script_helpers\generate-offline-assets.mjs

echo [2/3] Cleaning and building production PWA bundle ^(dist\^)...
if exist "dist" (
    rmdir /s /q "dist"
)
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] Production build failed!
    pause
    exit /b 1
)

echo [3/3] Deploying Firestore/Storage Rules + Web App to Firebase Hosting...
call npx.cmd firebase-tools deploy --only firestore,storage,hosting:app
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

