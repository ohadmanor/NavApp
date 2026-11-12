@echo off
setlocal
title NavApp - Install APK for Android Auto (ADB Play-Store Installer Flag)

cd /d "%~dp0\.."

set "APK_PATH=%CD%\dist\NavApp-Israel-Signed-Release.apk"
if not exist "%APK_PATH%" (
    echo [ERROR] Signed APK not found at:
    echo         %APK_PATH%
    echo.
    echo Run devops\build-android-apk.bat first.
    pause
    exit /b 1
)

set "ADB_EXE=adb"
where adb >nul 2>&1
if errorlevel 1 (
    if not "%ANDROID_HOME%"=="" (
        if exist "%ANDROID_HOME%\platform-tools\adb.exe" (
            set "ADB_EXE=%ANDROID_HOME%\platform-tools\adb.exe"
        )
    )
)
if "%ADB_EXE%"=="adb" (
    where adb >nul 2>&1
    if errorlevel 1 (
        if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
            set "ADB_EXE=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
        ) else (
            echo [ERROR] adb.exe not found in PATH or Android SDK platform-tools.
            pause
            exit /b 1
        )
    )
)

echo ============================================================================
echo   NavApp - Android Auto Sideload Installer
echo   APK: %APK_PATH%
echo ============================================================================
echo.
echo [1/4] Checking connected Android phone via ADB...
"%ADB_EXE%" devices
echo.
"%ADB_EXE%" get-state >nul 2>&1
if errorlevel 1 (
    echo [ERROR] No authorized Android phone detected over USB/Wireless ADB.
    echo         Enable USB Debugging on your phone, connect via USB, and accept
    echo         the "Allow USB debugging" prompt on the phone screen.
    pause
    exit /b 1
)

echo [2/4] Installing APK with Play Store installer attribution (-i com.android.vending)...
"%ADB_EXE%" install -i "com.android.vending" -r -d "%APK_PATH%"
if errorlevel 1 (
    echo.
    echo [WARN] Reinstall failed ^(possibly signature mismatch with an older build^).
    echo        Trying uninstall + clean install...
    "%ADB_EXE%" uninstall com.navapp.outdoor.israel >nul 2>&1
    "%ADB_EXE%" install -i "com.android.vending" "%APK_PATH%"
    if errorlevel 1 (
        echo [ERROR] ADB install failed!
        pause
        exit /b 1
    )
)

echo.
echo [3/4] Verifying Android Auto CarAppService registration on device...
"%ADB_EXE%" shell pm query-services --components -a "androidx.car.app.CarAppService" | findstr /I "com.navapp.outdoor.israel"
if errorlevel 1 (
    echo [WARN] NavCarAppService was not listed by pm query-services.
) else (
    echo [OK] NavCarAppService is registered with Android PackageManager.
)

echo.
echo [4/4] Refreshing Android Auto cache (force-stopping gearhead)...
"%ADB_EXE%" shell am force-stop com.google.android.projection.gearhead >nul 2>&1

echo.
echo ============================================================================
echo   [DONE] NavApp installed for Android Auto!
echo.
echo   One-time check on your phone if it still does not appear in
echo   Android Auto -^> Customize launcher:
echo     1. Open Phone Settings -^> Apps / Connected devices -^> Android Auto
echo     2. Scroll down and tap "Version" 10 times to enable Developer Mode
echo     3. Tap the 3-dot menu ^(top right^) -^> Developer settings
echo     4. Enable "Unknown sources" ^(and set Application mode = Developer^)
echo     5. Open NavApp once on the phone screen before plugging into the car.
echo ============================================================================
pause
endlocal
