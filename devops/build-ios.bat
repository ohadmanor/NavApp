@echo off
setlocal
title NavApp Israel Outdoor - iOS Xcode Project Builder

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - iOS Project Generator ^& Capacitor Sync (Windows)
echo   Working Directory: %CD%
echo ============================================================================

echo [1/4] Generating offline assets and building production web bundle...
if exist "dist\NavApp-Israel-Signed-Release.apk" del /F /Q "dist\NavApp-Israel-Signed-Release.apk" >nul 2>&1
if exist "dist\NavApp-Israel-Unsigned.ipa" del /F /Q "dist\NavApp-Israel-Unsigned.ipa" >nul 2>&1
if exist "dist\NavApp-Israel-Release.ipa" del /F /Q "dist\NavApp-Israel-Release.ipa" >nul 2>&1
call node devops\generate-offline-assets.mjs
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] Web production build failed!
    pause
    exit /b 1
)

echo [2/4] Ensuring @capacitor/ios is installed and syncing Capacitor iOS project...
if not exist "node_modules\@capacitor\ios" (
    call npm.cmd install @capacitor/ios@^7.6.10
    if errorlevel 1 (
        echo [ERROR] Failed to install @capacitor/ios!
        pause
        exit /b 1
    )
)

if not exist "ios" (
    call npx.cmd cap add ios
    if errorlevel 1 (
        echo [ERROR] Failed to initialize Capacitor iOS project!
        pause
        exit /b 1
    )
)

call npx.cmd cap sync ios
if errorlevel 1 (
    echo [ERROR] Capacitor iOS sync failed!
    pause
    exit /b 1
)

echo [3/4] Configuring iOS Info.plist (GPS, Background Location, ATS, AppIcon, Version)...
call node devops\configure-ios.mjs
if errorlevel 1 (
    echo [ERROR] iOS configuration failed!
    pause
    exit /b 1
)

echo [4/4] iOS Xcode Project Ready!
echo.
echo ============================================================================
echo   [SUCCESS] Capacitor iOS Xcode project generated and synced at:
echo   %CD%\ios\App\App.xcworkspace
echo.
echo   Note: Compiling and signing an .ipa requires macOS + Xcode.
echo   Options to build the final .ipa:
echo     1. On a Mac:      bash devops/build-ios-ipa.sh
echo                       (or open ios/App/App.xcworkspace in Xcode)
echo     2. On GitHub CI:  Push to GitHub and run the "Build iOS App (.ipa)"
echo                       workflow in Actions (.github/workflows/build-ios.yml)
echo ============================================================================

pause
endlocal
