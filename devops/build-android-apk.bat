@echo off
setlocal
title NavApp Israel Outdoor - Android Signed APK Builder

cd /d "%~dp0\.."

echo ============================================================================
echo   NavApp - Android App Builder ^& Security Signer
echo   Working Directory: %CD%
echo ============================================================================

echo [1/5] Generating offline assets and building production web bundle...
if exist "devops\dist\NavApp-Israel-Signed-Release.apk" del /F /Q "devops\dist\NavApp-Israel-Signed-Release.apk" >nul 2>&1
if exist "devops\mobile\android\app\src\main\assets\public\NavApp-Israel-Signed-Release.apk" del /F /Q "devops\mobile\android\app\src\main\assets\public\NavApp-Israel-Signed-Release.apk" >nul 2>&1
call node devops\script_helpers\generate-offline-assets.mjs
if errorlevel 1 (
    echo [ERROR] Offline asset generation failed!
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)
call npm.cmd run build
if errorlevel 1 (
    echo [ERROR] Web production build failed!
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

if "%ANDROID_HOME%"=="" (
    if exist "%LOCALAPPDATA%\Android\Sdk" (
        set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
    )
)
if "%JAVA_HOME%"=="" (
    where java >nul 2>&1
    if errorlevel 1 (
        if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" (
            set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
        )
    )
)

echo [2/5] Syncing web bundle with Capacitor Android native project...
if not exist "devops\mobile\android" (
    call npx.cmd cap add android
)
call npx.cmd cap sync android
if errorlevel 1 (
    echo [ERROR] Capacitor Android sync failed!
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

echo [3/5] Applying Android Security Hardening ^& RSA-2048 Release Signing Keystore...
call node devops\script_helpers\configure-android-security.mjs
if errorlevel 1 (
    echo [ERROR] Android security configuration failed!
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

echo [4/5] Building Signed Release APK via Gradle ^(assembleRelease^)...
cd /d "%~dp0mobile\android"
call ".\gradlew.bat" assembleRelease
if errorlevel 1 (
    echo.
    echo [ERROR] Gradle assembleRelease failed! Ensure Java JDK 17+ and ANDROID_HOME are configured.
    echo         You can also open the pre-configured project in Android Studio:
    echo         npx cap open android
    cd /d "%~dp0\.."
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

echo [5/5] Copying Signed Release APK...
cd /d "%~dp0\.."
set "SIGNED_APK=devops\mobile\android\app\build\outputs\apk\release\app-release.apk"
if exist "%SIGNED_APK%" (
    if not exist "devops\dist" mkdir "devops\dist"
    copy /Y "%SIGNED_APK%" "devops\dist\NavApp-Israel-Signed-Release.apk" >nul
    echo.
    echo ============================================================================
    echo   [SUCCESS] Signed Android APK ready for phone installation:
    echo   %CD%\devops\dist\NavApp-Israel-Signed-Release.apk
    echo.
    echo   NOTE for Android Auto: Sideloading via file manager hides Car apps
    echo   unless installed via ADB with Play Store attribution:
    echo     devops\install-android-auto-apk.bat
    echo ============================================================================
) else (
    echo [ERROR] Expected signed APK was not found at: %SIGNED_APK%
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
)

if /i not "%~1"=="--no-pause" pause
endlocal

