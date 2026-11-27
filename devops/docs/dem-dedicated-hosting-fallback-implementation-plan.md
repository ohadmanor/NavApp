# Implementation Plan: Dedicated Static `hosting:dem` Target & Multi-Mirror DEM Resilience

## Problem Statement

1. **Previous Firebase Hosting setup (`hosting:data`)**:
   - **Pro**: Served over `*.web.app`, accessible from restricted corporate/institutional networks.
   - **Con**: `Israel.dem.pmtiles` (1.40 GB, static/immutable) lived in the same Firebase Hosting site (`navapp-israel-topo-data`) as updatable datasets (`Israel.osm.pmtiles`, `Israel.pois.geojson`, `Israel.search.idx`). Every data update required preserving/re-deploying the 1.40 GB DEM file, and before recent client fixes (`immutable: true`, `TransientSafePromiseCache`, `attachInMemoryTileCache`, safe PNG decoding), range bursts on Fastly CDN were unstable.
2. **Current Firebase Storage setup (`VITE_DEM_PMTILES_URL`)**:
   - **Pro**: Completely decoupled from `upload-map-data.bat` and very stable for byte-range streaming.
   - **Con**: Restricted networks block `firebasestorage.googleapis.com` / `?alt=media` as a cloud-storage file download, causing `Israel.dem.pmtiles` probing to fall back to `navapp-israel-topo-data.web.app` / `navapp-israel-topo.web.app` where DEM returns `404`.

---

## Architecture Overview

1. **Three Independent Firebase Hosting Targets** ([`../../firebase.json`](../../firebase.json), [`../../.firebaserc`](../../.firebaserc)):
   - `hosting:app` (`navapp-israel-topo`): Web app shell (`devops/dist/`), deployed via [`../deploy-firebase.bat`](../deploy-firebase.bat).
   - `hosting:data` (`navapp-israel-topo-data`): Updatable datasets (`Israel.osm.pmtiles`, `Israel.pois.geojson`, `Israel.search.idx`, `Israel.trails.json`), deployed via [`../upload-map-data.bat`](../upload-map-data.bat). Continues to exclude `Israel.dem.pmtiles` permanently.
   - `hosting:dem` (`navapp-israel-topo-dem`): Dedicated one-time static site serving only `deploy_dem/data/Israel.dem.pmtiles` with `Cache-Control: public, max-age=31536000, immutable` and full `Range`/CORS headers, deployed once via [`../upload-dem-once.bat`](../upload-dem-once.bat).
2. **Multi-Mirror Resilient Streaming + Offline Cache Sharing**:
   - Primary mirror: Firebase Storage (`VITE_DEM_PMTILES_URL`) — avoids Firebase Hosting's shared 360 MB/day Spark bandwidth limit on open networks.
   - Secondary mirror: `https://navapp-israel-topo-dem.web.app/data/Israel.dem.pmtiles` — automatically takes over on restricted networks that block `firebasestorage.googleapis.com`, and serves as an active per-range failover mirror if any single range request fails transiently.
   - Canonical Cache Storage key (`immutable:Israel.dem.pmtiles`) in [`../../src/core/pmtiles/CachedFetchSource.ts`](../../src/core/pmtiles/CachedFetchSource.ts) ensures cached DEM tiles in `pmtiles-range-cache-v4` work seamlessly across network transitions (e.g., open Wi-Fi to restricted network) and offline reboots.
3. **Startup, Offline & Runtime Stability Fixes**:
   - [`../../src/core/pmtiles/dataFileProbe.ts`](../../src/core/pmtiles/dataFileProbe.ts): Probes Storage and `hosting:dem` concurrently with a short primary grace period (`1500ms`) so firewalled/blackholed Storage connections fail over immediately instead of stalling for `10s`.
   - [`../../src/core/pmtiles/PMTilesRegistry.ts`](../../src/core/pmtiles/PMTilesRegistry.ts): Initializes `defaultDemPmtiles` with both mirrors from `t=0ms`, preserves cached DEM tiles when booting offline, cleans up rejected `pendingFetches` in `TransientSafePromiseCache`, and exposes `retryDemIfUnavailable()` when connectivity recovers.
   - [`../../src/core/navigation/ElevationService.ts`](../../src/core/navigation/ElevationService.ts): Retries transient `getZxy` errors once and falls back to `decodeDemPngSafely` when `createImageBitmap` fails on WebViews.
   - [`../../src/App.tsx`](../../src/App.tsx): Automatically retries DEM mounting on browser `online` events if DEM failed at boot.

---

## Verification Plan

1. Run `npm run typecheck` and `npm test` after all edits.
2. Verify `devops/script_helpers/upload-map-data.mjs --dry-run` still excludes `Israel.dem.pmtiles` from `hosting:data`.
3. Create and deploy `hosting:dem` once using `devops\upload-dem-once.bat`.
