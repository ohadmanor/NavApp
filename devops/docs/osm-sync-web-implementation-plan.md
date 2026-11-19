# Static Web OSM Sync UI (Nginx & Firebase Hosting) — Implementation Plan

## 1. Goal & Scope

Provide a 100% static, browser-based OpenStreetMap (OSM) Sync UI built directly into the NavApp web bundle (`dist/`), so it runs identically behind **Nginx** ([`devops/nginx/navapp.conf`](../nginx/navapp.conf)) or **Firebase Hosting** (`hosting:app`) with **zero server-side Node.js daemon or Cloud Functions**, while keeping the existing local PC CLI/UI tool ([`devops/sync-osm-roads.bat`](../sync-osm-roads.bat) + [`devops/script_helpers/sync-osm-roads.mjs`](../script_helpers/sync-osm-roads.mjs)) working unchanged.

---

## 2. Architecture Overview

1. **Shared Pure OSM XML & API v0.6 Core (`src/core/trails/osmSyncCore.js` + `.d.ts`)**:
   - Extracts all environment-agnostic OSM logic (`mapTrailColorToOsmName`, `xmlEscape`, `parseOsmWayFullXml`, `buildChangesetXml`, `buildOsmChangeXml`, `osmFetch`, `prepareRoadOsmContext`, `pushRoadToOsmApi`) out of [`devops/script_helpers/sync-osm-roads.mjs`](../script_helpers/sync-osm-roads.mjs).
   - Both the local Node script (`devops/script_helpers/sync-osm-roads.mjs`) and the browser web app import from `src/core/trails/osmSyncCore.js` without duplicating logic.
   - `sync-osm-roads.mjs` re-exports the XML helpers so existing CLI workflows and unit tests ([`src/core/__tests__/communityRoads.test.ts`](../../src/core/__tests__/communityRoads.test.ts)) continue working unchanged.

2. **Browser OAuth 2.0 PKCE + Sync Service (`src/core/trails/OsmBrowserSyncService.ts`)**:
   - Uses Web Crypto (`crypto.subtle`) to run OAuth 2.0 Authorization Code + PKCE (`scope=write_api`) directly against OpenStreetMap (`www.openstreetmap.org` or `master.apis.dev.openstreetmap.org` for sandbox).
   - Fixed callback URL `${window.location.origin}/osm-callback` (works under Vite dev, Nginx `try_files $uri $uri/ /index.html;`, and Firebase Hosting SPA rewrites).
   - Stores PKCE state and active OSM token in `sessionStorage`, and per-environment Client IDs in `localStorage` (with optional defaults via `VITE_OSM_CLIENT_ID` / `VITE_OSM_SANDBOX_CLIENT_ID` in `.env`).
   - Calls OSM API v0.6 directly via `fetch()` (enabled by OSM's `Access-Control-Allow-Origin: *` CORS headers).

3. **Firestore `osmSync` Persistence & Security Rules**:
   - Updates [`devops/firebase/firestore.rules`](../firebase/firestore.rules) so `community_roads/{roadId}` `allow update` supports `operation: 'osm-sync'` when road geometry/tags are unchanged, `osmSync` metadata is valid (`syncedRevision == revision`, `syncedAt == request.time`, `syncedByUid == request.auth.uid`), and a paired immutable `history/{historyId}` record is written.
   - Adds `markRoadOsmSynced(...)` in [`src/core/firebase/CommunityRoadsCloudService.ts`](../../src/core/firebase/CommunityRoadsCloudService.ts) (and updates [`devops/script_helpers/sync-osm-roads.mjs`](../script_helpers/sync-osm-roads.mjs) to use the same valid transaction format when signed into Firebase) so synced status propagates across all devices without relying on local `data/.osm-synced.json`.
   - Preserves prior `osmSync` metadata across subsequent road edits (`pushRecordToFirestore`), so `syncedRevision < revision` automatically flips the road back to pending re-sync.

4. **Static Web UI & Service Worker Handling**:
   - New lazy-loaded component [`src/components/map/OsmSyncPanel.tsx`](../../src/components/map/OsmSyncPanel.tsx) supporting:
     - Google/Firebase authentication status & sign-in (needed to persist `osmSync` to Firestore).
     - OSM OAuth 2.0 PKCE login/logout, one-time Client ID configuration, and Sandbox toggle.
     - Selection list for pending/synced `community_roads` (with trail annotation swatch/number), `OsmChange` XML preview, and batch upload to OSM.
   - Accessible both via direct route (`/osm-sync` and `/osm-callback`) and via an entry button inside `סימון שבילים` in [`src/App.tsx`](../../src/App.tsx).
   - Updates [`devops/script_helpers/generate-offline-assets.mjs`](../script_helpers/generate-offline-assets.mjs) (`src/public/sw.js`) so `/osm-callback` and OAuth query responses are never cached by the Service Worker.

---

## 3. Verification

- TypeScript check (`npm run typecheck`) and unit tests (`npm test`) covering `osmSyncCore`, `OsmBrowserSyncService`, `CommunityRoadsCloudService.markRoadOsmSynced`, and `sync-osm-roads.mjs` compatibility.
- Firestore Emulator rules test ([`src/core/__tests__/communityRoads.rules.test.ts`](../../src/core/__tests__/communityRoads.rules.test.ts)) validating create, edit, delete, restore, `osm-sync` transactions, and tampering rejections.
- Production Vite build (`npm run build`) verifying static bundle output for Nginx (`dist/`) and Firebase Hosting.
