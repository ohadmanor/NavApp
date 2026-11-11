#!/usr/bin/env node
/**
 * devops/configure-android-security.mjs
 *
 * Automatically hardens the Capacitor Android project so the built APK meets
 * all Android 13/14/15+ security requirements for direct installation on Android phones:
 *  1. Generates an RSA-2048 Release Signing Keystore (`devops/keystore/navapp-release.jks`) using Java `keytool`.
 *  2. Creates `network_security_config.xml` (TLS/HTTPS enforcement + localhost PMTiles range streaming).
 *  3. Updates `AndroidManifest.xml` with fine/coarse GPS location permissions, foreground service permissions,
 *     and `android:networkSecurityConfig="@xml/network_security_config"`.
 *  4. Configures `android/app/build.gradle` with V1 + V2 + V3 APK signing using the generated keystore.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT_DIR, 'android');
const KEYSTORE_DIR = path.join(__dirname, 'keystore');
const KEYSTORE_FILE = path.join(KEYSTORE_DIR, 'navapp-release.jks');

const KEY_ALIAS = process.env.NAVAPP_KEY_ALIAS || 'navapp_israel_key';
const KEY_PASS = process.env.NAVAPP_KEY_PASS || 'NavAppOutdoor2026!';

function ensureSigningKeystore() {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
  if (fs.existsSync(KEYSTORE_FILE)) {
    console.log(`[Android Security] Release keystore already exists: ${KEYSTORE_FILE}`);
    return;
  }

  console.log('[Android Security] Generating RSA-2048 Android Release Signing Keystore via keytool...');
  const cmd = [
    'keytool',
    '-genkeypair',
    '-v',
    `-keystore "${KEYSTORE_FILE}"`,
    `-alias "${KEY_ALIAS}"`,
    '-keyalg RSA',
    '-keysize 2048',
    '-validity 10000',
    `-storepass "${KEY_PASS}"`,
    `-keypass "${KEY_PASS}"`,
    '-dname "CN=NavApp Outdoor Israel, OU=Mobile, O=NavApp, L=TelAviv, ST=IL, C=IL"',
  ].join(' ');

  execSync(cmd, { stdio: 'inherit' });
  console.log(`[Android Security] Created keystore at ${KEYSTORE_FILE}`);
}

function configureNetworkSecurityXml() {
  const xmlDir = path.join(ANDROID_DIR, 'app', 'src', 'main', 'res', 'xml');
  if (!fs.existsSync( path.join(ANDROID_DIR, 'app'))) return;
  fs.mkdirSync(xmlDir, { recursive: true });

  const netSecXml = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Enforce HTTPS/TLS for all external internet traffic -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
    <!-- Allow local loopback for local PMTiles byte-range server if used -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="true">localhost</domain>
        <domain includeSubdomains="true">127.0.0.1</domain>
    </domain-config>
</network-security-config>
`;
  fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), netSecXml, 'utf-8');
  console.log('[Android Security] Configured res/xml/network_security_config.xml');

  const automotiveDescXml = `<?xml version="1.0" encoding="utf-8"?>
<automotiveApp>
    <uses name="template" />
</automotiveApp>
`;
  fs.writeFileSync(path.join(xmlDir, 'automotive_app_desc.xml'), automotiveDescXml, 'utf-8');
  console.log('[Android Security] Configured res/xml/automotive_app_desc.xml');
}

function configureAndroidManifest() {
  const manifestPath = path.join(ANDROID_DIR, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) return;

  let xml = fs.readFileSync(manifestPath, 'utf-8');

  // Add networkSecurityConfig attribute to <application>
  if (!xml.includes('android:networkSecurityConfig')) {
    xml = xml.replace(
      '<application',
      '<application\n        android:networkSecurityConfig="@xml/network_security_config"\n        android:usesCleartextTraffic="false"'
    );
  }

  // Add Outdoor GPS & Offline Storage Permissions before </manifest>
  const hasInternet = xml.includes('android.permission.INTERNET');
  const permissionsBlock = `
    <!-- NavApp Outdoor GPS & Offline PMTiles Permissions -->${hasInternet ? '' : '\n    <uses-permission android:name="android.permission.INTERNET" />'}
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-feature android:name="android.hardware.location.gps" android:required="false" />
`;

  if (!xml.includes('ACCESS_FINE_LOCATION')) {
    xml = xml.replace('</manifest>', `${permissionsBlock}\n</manifest>`);
  } else if (!xml.includes('android.permission.POST_NOTIFICATIONS')) {
    xml = xml.replace(
      '</manifest>',
      `    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n\n</manifest>`
    );
  }

  // Add Android Auto Car App Library permissions & service metadata
  const carPermissionsBlock = `
    <!-- Android Auto Car App Library (Navigation) -->
    <uses-permission android:name="androidx.car.app.ACCESS_SURFACE" />
    <uses-permission android:name="androidx.car.app.NAVIGATION_TEMPLATES" />
    <uses-permission android:name="androidx.car.app.MAP_TEMPLATES" />
`;

  if (!xml.includes('androidx.car.app.ACCESS_SURFACE')) {
    xml = xml.replace('</manifest>', `${carPermissionsBlock}\n</manifest>`);
  }

  const carAppApplicationBlock = `
        <meta-data
            android:name="com.google.android.gms.car.application"
            android:resource="@xml/automotive_app_desc" />
        <meta-data
            android:name="androidx.car.app.minCarApiLevel"
            android:value="1" />

        <service
            android:name=".car.NavCarAppService"
            android:exported="true"
            android:label="@string/app_name">
            <intent-filter>
                <action android:name="androidx.car.app.CarAppService" />
                <category android:name="androidx.car.app.category.NAVIGATION" />
            </intent-filter>
        </service>

        <service
            android:name=".car.CarNavigationForegroundService"
            android:exported="false"
            android:foregroundServiceType="location" />
`;

  if (!xml.includes('.car.NavCarAppService')) {
    xml = xml.replace('</application>', `${carAppApplicationBlock}\n    </application>`);
  }

  fs.writeFileSync(manifestPath, xml, 'utf-8');
  console.log('[Android Security] Updated AndroidManifest.xml with GPS, Android Auto & Network Security Config');
}

function configureGradleSigning() {
  const gradlePath = path.join(ANDROID_DIR, 'app', 'build.gradle');
  if (!fs.existsSync(gradlePath)) return;

  let gradle = fs.readFileSync(gradlePath, 'utf-8');
  if (gradle.includes('navappReleaseSigning')) {
    console.log('[Android Security] Gradle release signing already configured.');
    return;
  }

  const signingBlock = `
    // navappReleaseSigning: Configured automatically by devops/configure-android-security.mjs
    signingConfigs {
        release {
            storeFile file("../../devops/keystore/navapp-release.jks")
            storePassword "${KEY_PASS}"
            keyAlias "${KEY_ALIAS}"
            keyPassword "${KEY_PASS}"
            enableV1Signing true
            enableV2Signing true
            enableV3Signing true
        }
    }
`;

  gradle = gradle.replace('buildTypes {', `${signingBlock}\n    buildTypes {`);
  gradle = gradle.replace(
    /buildTypes\s*\{\s*release\s*\{/,
    'buildTypes {\n        release {\n            signingConfig signingConfigs.release'
  );

  fs.writeFileSync(gradlePath, gradle, 'utf-8');
  console.log('[Android Security] Injected APK v1/v2/v3 release signing config into android/app/build.gradle');
}

function configureLocalProperties() {
  const localPropsPath = path.join(ANDROID_DIR, 'local.properties');
  if (fs.existsSync(localPropsPath)) return;

  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
  ].filter(Boolean);

  for (const sdkPath of candidates) {
    if (sdkPath && fs.existsSync(sdkPath)) {
      const escaped = sdkPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
      fs.writeFileSync(localPropsPath, `sdk.dir=${escaped}\n`, 'utf-8');
      console.log(`[Android Security] Configured android/local.properties -> ${sdkPath}`);
      return;
    }
  }
}

function configureRootGradleToolchain() {
  const settingsPath = path.join(ANDROID_DIR, 'settings.gradle');
  if (fs.existsSync(settingsPath)) {
    let settings = fs.readFileSync(settingsPath, 'utf-8');
    if (!settings.includes('foojay-resolver-convention')) {
      settings = `plugins {\n    id 'org.gradle.toolchains.foojay-resolver-convention' version '0.8.0'\n}\n\n${settings}`;
      fs.writeFileSync(settingsPath, settings, 'utf-8');
    }
  }

  const rootGradlePath = path.join(ANDROID_DIR, 'build.gradle');
  if (fs.existsSync(rootGradlePath)) {
    let rootGradle = fs.readFileSync(rootGradlePath, 'utf-8');
    if (!rootGradle.includes('JavaLanguageVersion.of(17)')) {
      const subprojectsBlock = `
subprojects {
    afterEvaluate { project ->
        if (project.hasProperty('android')) {
            project.android {
                compileOptions {
                    sourceCompatibility JavaVersion.VERSION_17
                    targetCompatibility JavaVersion.VERSION_17
                }
            }
        }
        if (project.extensions.findByName('kotlin') != null) {
            project.extensions.kotlin.jvmToolchain(17)
        }
        if (project.extensions.findByName('java') != null) {
            project.extensions.java.toolchain {
                languageVersion = JavaLanguageVersion.of(17)
            }
        }
    }
}
`;
      rootGradle = rootGradle.replace('task clean(type: Delete)', `${subprojectsBlock}\ntask clean(type: Delete)`);
      fs.writeFileSync(rootGradlePath, rootGradle, 'utf-8');
    }
  }
}

function main() {
  ensureSigningKeystore();
  if (fs.existsSync(ANDROID_DIR)) {
    configureLocalProperties();
    configureRootGradleToolchain();
    configureNetworkSecurityXml();
    configureAndroidManifest();
    configureGradleSigning();
  } else {
    console.log('[Android Security] Keystore ready. Run npx cap add android to apply Android manifest/gradle security.');
  }
}

main();

