# NavApp — Israel Outdoor Map Navigation (Web PWA + Android + iOS)

100% Serverless, Offline-First Cross-Platform Outdoor Map Navigation built with **React 19**, **TypeScript**, **MapLibre GL JS**, **Protomaps PMTiles**, **Turf.js**, **Dexie.js**, and **Ionic Capacitor**.

---

## 1. Folder Structure (`C:\dev\NavApp`)

- **[`docs/`](./)** — All project documentation, implementation plans, and architecture diagrams:
  - [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — Full architectural & implementation blueprint.
  - [`decoupled-storage-implementation-plan.md`](./decoupled-storage-implementation-plan.md) — Decoupling code deployments (`deploy-firebase.bat`) from Firebase map data storage.
  - [`route-planning-implementation-plan.md`](./route-planning-implementation-plan.md) — Client-side route planning (4x4, Foot, Bicycle) & Firebase `planing_tracks` sync design.
  - [`trail-annotations-implementation-plan.md`](./trail-annotations-implementation-plan.md) — Community highway/trail colors, numbers, descriptions, authenticated editing, audit history, and persistence across PMTiles updates.
  - [`route-planning-v2-implementation-plan.md`](./route-planning-v2-implementation-plan.md) — Route Planning v2 (scalable 100s+ route library, map visibility rules, My/Shared split, and user-to-user sharing).
  - [`poi-refactoring-prds.md`](./poi-refactoring-prds.md) — Product Requirements Documents (PRDs) for strict 6-category POI taxonomy, text-integrated classifier, and POI edit/delete lifecycle.
  - [`poi-refactoring-implementation-plan.md`](./poi-refactoring-implementation-plan.md) — Implementation plan for POI refactoring across Web, Search, Cloud Sync, and Android Auto.
  - [`architecture-diagram.html`](./architecture-diagram.html) — Interactive 5-layer system architecture & offline data-flow diagram.
  - [`navapp-ui-mockup.html`](./navapp-ui-mockup.html) — Interactive Web Desktop & Mobile UI/UX mockup synced to the shipped application.
  - [`osm-zoom-levels.md`](./osm-zoom-levels.md) — Vector tile & contour zoom-level specification.
  - [`tilemaker-nature-reserves-fix.md`](./tilemaker-nature-reserves-fix.md) — Tilemaker nature reserves rendering fix documentation.
  - [`android-auto-distribution.md`](./android-auto-distribution.md) — Publishing & installing NavApp for Android Auto (Play Internal Testing, Production, and Sideloading).
  - [`README.md`](./README.md) — User, DevOps & Deployment guide.
- **[`data/`](../data/)** — Offline PMTiles & GeoJSON map data archives:
  - [`Israel.dem.pmtiles`](../data/Israel.dem.pmtiles) (**1.40 GB — Constant / Static DEM**): Terrarium 256px PNG elevation pyramid (`z0–z14`). Installed once; never changes. Powers Hillshade, 3D Terrain, Dynamic Contour Lines (`10m`/`50m`), and Offline Route Elevation Profiles.
  - [`Israel.osm.pmtiles`](../data/Israel.osm.pmtiles) (**112.4 MB — Updatable Vector Map**): OpenMapTiles 19-layer vector archive (`z0–z14`). Periodically updated and hot-swapped in the app without re-downloading the 1.40 GB DEM.
  - [`Israel.pois.geojson`](../data/Israel.pois.geojson) (**Harvested Community & OSM POIs**): Springs (`מעיינות`), water holes (`גבים`), cisterns (`בורות מים`), 4x4 ascents (`מעלות 4x4`), caves, ruins, viewpoints, night campsites (`חניוני לילה`), and mountain peaks with Hebrew & English descriptions.
- **[`devops/`](../devops/)** — All build, local run, POI harvesting, Firebase deploy, and Android security scripts:
  - [`run-local.bat`](../devops/run-local.bat) — Launches the local development server (`http://localhost:5173`) with HTTP `206 Partial Content` byte-range streaming from `data\*.pmtiles`.
  - [`deploy-firebase.bat`](../devops/deploy-firebase.bat) — Builds the production PWA and deploys to **Firebase Hosting (Free Spark Tier)**.
  - [`build-android-apk.bat`](../devops/build-android-apk.bat) — Syncs Capacitor Android, applies Android security & RSA-2048 release keystore signing, and builds an installable `.apk`.
  - [`build-ios.bat`](../devops/build-ios.bat) — Generates & syncs the Capacitor iOS Xcode project (`ios/App/App.xcworkspace`) on Windows and applies iOS permissions/security/icon config.
  - [`build-ios-ipa.sh`](../devops/build-ios-ipa.sh) — Full macOS iOS builder (`pod install` + `xcodebuild`) producing an unsigned/signed `.ipa` or Simulator `.app.zip`.
  - [`fetch-israel-pois.mjs`](../devops/fetch-israel-pois.mjs) — Harvests & updates `data/Israel.pois.geojson`.
  - [`configure-android-security.mjs`](../devops/configure-android-security.mjs) — Automates Android Keystore generation, `network_security_config.xml`, GPS permissions, and Gradle v1/v2/v3 APK signing.
  - [`configure-ios.mjs`](../devops/configure-ios.mjs) — Automates `Info.plist` GPS/background permissions, Files app sharing, ATS HTTPS security, Xcode version sync, and 1024x1024 AppIcon generation.
- **[`.agents/skills/outdoor-map-navigation/`](../.agents/skills/outdoor-map-navigation/)** — Custom Antigravity Expert Skill in MapLibre + PMTiles outdoor navigation.

---

## 2. Quick Start — Run Locally for Testing

### Configure Firebase sign-in

Before signing in locally, create the root `.env` from the supplied template:
```bat
copy .env.example .env
```

Open `.env` and fill in `VITE_FIREBASE_API_KEY` and `VITE_FIREBASE_APP_ID` from
Firebase Console → **Project settings** → **Your apps** → your Web app. The
template contains the project defaults for the other Firebase settings. These
values are required by the client app; `.env` is ignored by Git and should not
be committed. Restart the Vite server after changing the file.

If Google sign-in still fails after setup, make sure Google is enabled under
Firebase Console → **Authentication** → **Sign-in method**. For an
`auth/unauthorized-domain` error, add the local hostname shown in your browser
to **Authentication** → **Settings** → **Authorized domains**.

Double-click or run from terminal:
```bat
C:\dev\NavApp\devops\run-local.bat
```
This script:
1. Verifies `node_modules` and `data\Israel.pois.geojson`.
2. Checks `data\Israel.dem.pmtiles` (1.40 GB) and `data\Israel.osm.pmtiles` (112 MB).
3. Starts Vite with custom HTTP `206 Partial Content` byte-range middleware at `http://localhost:5173`.

---

## 3. Deploy Serverless to Firebase Hosting (Free Tier)

1. Log in once to Firebase CLI and link your Firebase project:
   ```bat
   npx firebase-tools login
   npx firebase-tools use --add
   ```
2. Run the deployment script:
   ```bat
   C:\dev\NavApp\devops\deploy-firebase.bat
   ```

---

## 4. Build Signed Android APK for Phone Installation

Run:
```bat
C:\dev\NavApp\devops\build-android-apk.bat
```
### Android Security Configured Automatically:
- **RSA-2048 Release Keystore**: Generated at `devops/keystore/navapp-release.jks` (`V1 + V2 + V3` APK signatures enabled so Android 11–15+ phones allow direct installation).
- **Network Security Config (`res/xml/network_security_config.xml`)**: Enforces HTTPS/TLS for external connections while allowing local loopback byte-range streaming.
- **Granular Permissions (`AndroidManifest.xml`)**: Configures `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `FOREGROUND_SERVICE`, and `FOREGROUND_SERVICE_LOCATION`.
- **Transferring Map Files to Phone**: Copy `Israel.dem.pmtiles` and `Israel.osm.pmtiles` to your phone (or SD card) and select them once inside the app's **PMTiles Storage Manager (`מפות וייבוא`)**.

### Installing for Android Auto (Sideloading)
Android Auto hides sideloaded `CarAppService` navigation apps installed from a file manager/browser. To make Android Auto recognize the sideloaded APK on your phone:
1. Connect your phone via USB (with USB Debugging enabled) and run:
   ```bat
   C:\Develop\github\NavApp\devops\install-android-auto-apk.bat
   ```
   *(Runs `adb install -i "com.android.vending" -r dist\NavApp-Israel-Signed-Release.apk` so Android registers Google Play installer provenance, and refreshes Android Auto.)*
2. On your phone, enable **Android Auto Developer Mode** (one-time):
   - Open **Settings → Android Auto** → scroll to **Version** and tap it **10 times**.
   - Open the top-right **⋮ menu → Developer settings** → enable **Unknown sources** (and set **Application mode** to **Developer**).
3. Open **NavApp** once on the phone before connecting to your car or Desktop Head Unit (DHU).

---

## 5. Build iOS Version (`.ipa` / Xcode Project)

### Generate & Sync the Xcode Project on Windows
Run:
```bat
C:\Develop\github\NavApp\devops\build-ios.bat
```
This builds the offline assets and web bundle (`dist/`), syncs Capacitor iOS (`ios/App`), and runs [`configure-ios.mjs`](../devops/configure-ios.mjs) to configure:
- **GPS & Background Location (`Info.plist`)**: `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription`, and `UIBackgroundModes` (`location`).
- **Files App Access & Export Compliance**: `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`, and `ITSAppUsesNonExemptEncryption=false`.
- **Network Security (ATS)**: Enforces HTTPS/TLS while allowing local networking (`NSAllowsLocalNetworking=true`).
- **Version & 1024×1024 App Icon**: Syncs `MARKETING_VERSION` from [`package.json`](../package.json) and generates an opaque RGB `AppIcon-512@2x.png` from [`public/icon-512.png`](../public/icon-512.png).

### Compile the `.ipa` on macOS or GitHub Actions
Compiling an `.ipa` requires macOS + Xcode:
- **On a Mac**:
  ```bash
  bash devops/build-ios-ipa.sh                # Produces dist/NavApp-Israel-Unsigned.ipa
  bash devops/build-ios-ipa.sh --simulator    # Produces dist/NavApp-Israel-Simulator.app.zip
  IOS_TEAM_ID=YOUR_TEAM_ID bash devops/build-ios-ipa.sh --ad-hoc   # Signed .ipa
  ```
- **From Windows via GitHub Actions**: Trigger the **Build iOS App (.ipa)** workflow ([`.github/workflows/build-ios.yml`](../.github/workflows/build-ios.yml)) on `macos-latest` from the repository's **Actions** tab and download the generated `.ipa` artifact.

