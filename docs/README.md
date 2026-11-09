# NavApp — Israel Outdoor Map Navigation (Web PWA + Android + iOS)

100% Serverless, Offline-First Cross-Platform Outdoor Map Navigation built with **React 19**, **TypeScript**, **MapLibre GL JS**, **Protomaps PMTiles**, **Turf.js**, **Dexie.js**, and **Ionic Capacitor**.

---

## 1. Folder Structure (`C:\dev\NavApp`)

- **[`docs/`](./)** — All project documentation and architecture diagrams:
  - [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — Full architectural & implementation blueprint.
  - [`architecture-diagram.html`](./architecture-diagram.html) — Interactive 5-layer system architecture & offline data-flow diagram.
  - [`navapp-ui-mockup.html`](./navapp-ui-mockup.html) — Interactive Web Desktop & Mobile UI/UX mockup synced to the shipped application.
  - [`osm-zoom-levels.md`](./osm-zoom-levels.md) — Vector tile & contour zoom-level specification.
  - [`README.md`](./README.md) — User, DevOps & Deployment guide.
- **[`data/`](../data/)** — Offline PMTiles & GeoJSON map data archives:
  - [`Israel.dem.pmtiles`](../data/Israel.dem.pmtiles) (**1.40 GB — Constant / Static DEM**): Terrarium 256px PNG elevation pyramid (`z0–z14`). Installed once; never changes. Powers Hillshade, 3D Terrain, Dynamic Contour Lines (`10m`/`50m`), and Offline Route Elevation Profiles.
  - [`Israel.osm.pmtiles`](../data/Israel.osm.pmtiles) (**112.4 MB — Updatable Vector Map**): OpenMapTiles 19-layer vector archive (`z0–z14`). Periodically updated and hot-swapped in the app without re-downloading the 1.40 GB DEM.
  - [`Israel.pois.geojson`](../data/Israel.pois.geojson) (**Harvested Community & OSM POIs**): Springs (`מעיינות`), water holes (`גבים`), cisterns (`בורות מים`), 4x4 ascents (`מעלות 4x4`), caves, ruins, viewpoints, night campsites (`חניוני לילה`), and mountain peaks with Hebrew & English descriptions.
- **[`devops/`](../devops/)** — All build, local run, POI harvesting, Firebase deploy, and Android security scripts:
  - [`run-local.bat`](../devops/run-local.bat) — Launches the local development server (`http://localhost:5173`) with HTTP `206 Partial Content` byte-range streaming from `data\*.pmtiles`.
  - [`deploy-firebase.bat`](../devops/deploy-firebase.bat) — Builds the production PWA and deploys to **Firebase Hosting (Free Spark Tier)**.
  - [`build-android-apk.bat`](../devops/build-android-apk.bat) — Syncs Capacitor Android, applies Android security & RSA-2048 release keystore signing, and builds an installable `.apk`.
  - [`fetch-israel-pois.mjs`](../devops/fetch-israel-pois.mjs) — Harvests & updates `data/Israel.pois.geojson`.
  - [`configure-android-security.mjs`](../devops/configure-android-security.mjs) — Automates Android Keystore generation, `network_security_config.xml`, GPS permissions, and Gradle v1/v2/v3 APK signing.
- **[`.agents/skills/outdoor-map-navigation/`](../.agents/skills/outdoor-map-navigation/)** — Custom Antigravity Expert Skill in MapLibre + PMTiles outdoor navigation.

---

## 2. Quick Start — Run Locally for Testing

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

