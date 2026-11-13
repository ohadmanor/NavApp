@echo off
setlocal
title NavApp Israel Outdoor - Android Signed APK Builder

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Android App Builder ^& Security Signer
echo   Working Directory: %CD%
echo ============================================================================

echo [1/5] Generating offline assets and building production web bundle...
if exist "dist\NavApp-Israel-Signed-Release.apk" del /F /Q "dist\NavApp-Israel-Signed-Release.apk" >nul 2>&1
if exist "android\app\src\main\assets\public\NavApp-Israel-Signed-Release.apk" del /F /Q "android\app\src\main\assets\public\NavApp-Israel-Signed-Release.apk" >nul 2>&1
call node devops\generate-offline-assets.mjs
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] Web production build failed!
    pause
    exit /b 1
)

if "%ANDROID_HOME%"=="" (
    if exist "%LOCALAPPDATA%\Android\Sdk" (
        set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
    )
)

echo [2/5] Syncing web bundle with Capacitor Android native project...
if not exist "android" (
    call npx.cmd cap add android
)
call npx.cmd cap sync android
if errorlevel 1 (
    echo [ERROR] Capacitor Android sync failed!
    pause
    exit /b 1
)

echo [3/5] Applying Android Security Hardening ^& RSA-2048 Release Signing Keystore...
call node devops\configure-android-security.mjs
if errorlevel 1 (
    echo [ERROR] Android security configuration failed!
    pause
    exit /b 1
)

echo [4/5] Building Signed Release APK via Gradle ^(assembleRelease^)...
cd /d "%~dp0\..\android"
call gradlew.bat assembleRelease
if errorlevel 1 (
    echo.
    echo [WARN] Gradle assembleRelease requires Android SDK ^(ANDROID_HOME^) configured.
    echo        You can also open the pre-configured project in Android Studio:
    echo        npx cap open android
    cd /d "%~dp0\.."
    pause
    exit /b 1
)

cd /d "%~dp0\.."
set "SIGNED_APK=android\app\build\outputs\apk\release\app-release.apk"
if exist "%SIGNED_APK%" (
    copy /Y "%SIGNED_APK%" "dist\NavApp-Israel-Signed-Release.apk" >nul
    echo.
    echo ============================================================================
    echo   [SUCCESS] Signed Android APK ready for phone installation:
    echo   %CD%\dist\NavApp-Israel-Signed-Release.apk
    echo.
    echo   NOTE for Android Auto: Sideloading via file manager hides Car apps
    echo   unless installed via ADB with Play Store attribution:
    echo     devops\install-android-auto-apk.bat
    echo ============================================================================
) else (
    echo [INFO] Check android\app\build\outputs\apk\release\ for the generated APK.
)

pause
endlocal

