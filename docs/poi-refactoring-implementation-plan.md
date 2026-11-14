# NavApp — POI Refactoring Implementation Plan

> [!IMPORTANT]
> This plan pairs with [poi-refactoring-prds.md](./poi-refactoring-prds.md) (PRD-1 through PRD-4). Phases 1–5 are implemented; **Phase 6 (Private POIs, Global Promotion & User-to-User Sharing — PRD-4) is planned below and awaits your approval before implementation.**

---

## Architecture Overview

```mermaid
flowchart TD
    Tax["src/core/pois/poiTaxonomy.ts (Canonical 6 Categories & 31 Exclusive Symbols)"] --> Sprites["devops/generate-poi-symbols.mjs (Builds SVG Sprites @1x/@2x + Android Drawables)"]
    Tax --> Classifier["src/core/pois/poiClassifier.ts (Weighted Text-Integrated Classifier)"]
    Tax --> Icons["src/components/pois/PoiCategoryIcon.tsx (Unified React SVG Icons)"]
    Classifier --> Migration["devops/recategorize-pois.mjs & fetch/convert scripts -> Israel*.pois.geojson"]
    Classifier --> Importer["src/core/pois/CommunityPoiImporter.ts"]
    Tax --> PoiMgr["src/core/pois/PoiManager.ts + NavDatabase (poiOverrides + private/shared scope)"]
    Cloud["GlobalPoiCloudService.ts + PrivatePoiCloudService.ts (global_pois vs private_pois)"] --> PoiMgr
    UserDir["UserDirectoryService.ts (/users/{uid})"] --> Cloud
    PoiMgr --> MapUI["App.tsx / PoiInspectorSheet / AddPoiPanel / SharePoiModal / LayerSwitcherSheet"]
    PoiMgr --> Search["PMTilesSearchService.ts"]
    PoiMgr --> CarSync["CarSyncService.ts + NativeMapStore.java + CarMapController.java"]
```

---

## Phase 1: Canonical 1-to-1 Taxonomy & Modern Symbol Asset Pipeline

### 1.1 Canonical Taxonomy Registry
- **[NEW] [src/core/pois/poiTaxonomy.ts](../src/core/pois/poiTaxonomy.ts)**
  - Define exact 6 categories (`water`, `offroad`, `campsite`, `heritage`, `peak`, `user`) and the **31 exclusive symbols** defined in PRD-1 §1.3 (`poi-water-*`, `poi-offroad-*`, `poi-campsite-*`, `poi-heritage-*`, `poi-peak-*`, `poi-user-*`).
  - Export typed helpers:
    - `CATEGORY_META`: colors (day/dark), labelHe, labelEn, defaultSubcategory, defaultSymbolId, silhouetteShape (`circle-drop` | `diamond-shield` | `rounded-square` | `octagon` | `triangle` | `pin-star`).
    - `SYMBOL_DEFINITIONS`: maps each of the 31 symbol IDs to `{ category, defaultSubcategory, aliases, heLabel, iconShapeSpec }` where every symbol belongs to **strictly 1** `PoiCategory`.
    - `resolvePoiSymbolId(category, subcategory)` and `normalizeSubcategoryForCategory(category, subcategory)`: guarantees **zero cross-category symbol leakage** and enforces category-specific fallbacks instead of legacy global `'viewpoint'`.
    - `toCompactSymbolKey` or direct sprite ID mapping for MapLibre expressions.

### 1.2 Modern Symbol Generator & Sprite Pipeline
- **[NEW] [devops/poi-symbols/](../devops/poi-symbols/)** + **[NEW] [devops/generate-poi-symbols.mjs](../devops/generate-poi-symbols.mjs)**
  - Author clean, high-contrast modern SVG definitions (36×36 logical `@1x`, 72×72 `@2x`) for all 31 exclusive symbols with:
    - Distinct per-category outer geometry + rich vibrant fill + crisp `2px` white/light outer halo + subtle shadow for maximum contrast on bright topo, dark topo, and satellite imagery.
  - Script deterministically packs/merges the 31 `poi-*` glyphs into:
    - [public/assets/sprites/sprite.json](../public/assets/sprites/sprite.json) & [public/assets/sprites/sprite.png](../public/assets/sprites/sprite.png)
    - [public/assets/sprites/sprite@2x.json](../public/assets/sprites/sprite@2x.json) & [public/assets/sprites/sprite@2x.png](../public/assets/sprites/sprite@2x.png)
    - Standalone PNG assets (or synced sprite manifest) for Android Auto in `android/app/src/main/assets/` / `res/drawable-nodpi/`.
  - Note: Preserve existing non-POI vector map sprites (trail shields, highway shields, road icons) in the sprite atlas untouched.

### 1.3 React UI Icon Component & Emoji Replacement
- **[NEW] [src/components/pois/PoiCategoryIcon.tsx](../src/components/pois/PoiCategoryIcon.tsx)**
  - Crisp inline SVG component rendering any `(category, subcategory)` pair using the exact visual geometry and palette as MapLibre map markers (with size presets `xs` | `sm` | `md` | `lg`).
- **[MODIFY] [src/components/ui/themeTokens.ts](../src/components/ui/themeTokens.ts)**
  - Align `POI_CATEGORY_META` colors/badges with `poiTaxonomy.ts` and preserve optional text fallback labels without relying on raw OS emojis in primary badges.
- **[MODIFY] UI Consumers:**
  - [src/components/map/LayerSwitcherSheet.tsx](../src/components/map/LayerSwitcherSheet.tsx) (6 category toggles render `<PoiCategoryIcon />`).
  - [src/components/pois/AddPoiPanel.tsx](../src/components/pois/AddPoiPanel.tsx) (6 category selector buttons + exclusive subcategory/symbol chips for the chosen category).
  - [src/components/search/SearchBar.tsx](../src/components/search/SearchBar.tsx) & [src/components/navigation/ElevationProfileDrawer.tsx](../src/components/navigation/ElevationProfileDrawer.tsx) & [src/App.tsx](../src/App.tsx) nearby cards (render `<PoiCategoryIcon />` next to POI items).

### 1.4 MapLibre Styling Cleanup
- **[MODIFY] [src/App.tsx](../src/App.tsx)**
  - Replace legacy sprite mapping & tiny 24×24 canvas icons (`offroad-pass`, `offroad-blocked`, `offroad-danger`) with a clean `poiIconExpression` generated directly from `poiTaxonomy.ts` mapping each category + exclusive subcategory strictly to `poi-<cat>-<slug>` with per-category exclusive fallback (`['match', ['get', 'category'], 'water', 'poi-water-spring', 'offroad', 'poi-offroad-pass', ...]`).
  - Precompute or embed `symbolId` cleanly in `toCompactMapGeoJSON` so MapLibre doesn't even duplicate complex giant `match` trees unless needed as fallback.
- **[MODIFY] [src/core/style/israelOutdoorStyle.ts](../src/core/style/israelOutdoorStyle.ts)**
  - Audit base vector tile POI layers (`navappLayer.json`) under `applyOutdoorStylePreferences` so built-in tile icons never contradict user category overrides/deletions or confuse category toggles.

---

## Phase 2: Text-Integrated POI Classifier & Dataset Migration

### 2.1 Shared Text-Integrated Classification Engine
- **[NEW] [src/core/pois/poiClassifier.ts](../src/core/pois/poiClassifier.ts)**
  - Pure TypeScript module with zero browser-only dependencies (runs identically in Vitest, browser runtime, and Node scripts via `npx tsx`).
  - Implements the PRD-2 multi-signal scoring pipeline across `nameHe`, `nameEn`, `descHe`, `descEn`, `waterStatus`, `difficulty4x4`, `wikipedia`, and `existingCategory`/`existingSubcategory`:
    - Text cleaning (strips HTML tags, BBCode/URLs, escaped `\n`, niqqud).
    - **Title Head-Noun Parser**: prioritizes leading ontological nouns (`תצפית`, `מצפור`, `עין`, `מעיין`, `גב`, `בור`, `מפל`, `מעלה`, `שער`, `מערה`, `חורבה`, `אנדרטה`, `חניון לילה`, `חניון`, `הר`, `פסגת`, `תל`).
    - **Relational Preposition Guard**: dampens nouns inside spatial references (`מעל `, `מול `, `לכיוון `, `משקיף על `, `ליד `, `סמוך ל`, `בדרך ל`, `קרוב ל`) inside descriptions so viewpoints overlooking a spring remain `heritage:viewpoint`.
    - **Negative & Municipal Guards**: excludes city/settlement names (`באר שבע`, `מעלה אדומים`, `ראש העין`, `גבעתיים`) unless qualified by nature/4x4 terms; prevents dry ruined cisterns (`אמה יבשה`, `שרידי בריכה`) from falsely becoming active `water` points unless `waterStatus` indicates water.
    - **Off-Road Community Text Mining**: disambiguates `offroad_poi` / `offroad_photo` using description predicates (`בוץ/שקיעה` → `offroad:mud`, `שער נעול/חסום` → `offroad:blocked`, `מדרגת סלע/הצלבה` → `offroad:danger`, `דלק/פנצ'ריה` → `offroad:fuel_4x4`, `בריכה/גב/מעיין` → `water:*`, `מדורה/לינה/חניון` → `campsite:*`, `תצפית/פריחה/חורבה/מערה/אנדרטה` → `heritage:*`).
    - Outputs `{ category, subcategory, symbolId, confidence, reason }` guaranteed valid against `poiTaxonomy.ts`.

### 2.2 Dataset Migration & Harvester Alignment
- **[NEW] [devops/recategorize-pois.mjs](../devops/recategorize-pois.mjs)** (executed via `tsx` so it calls `poiClassifier.ts` directly)
  - Reads both [data/Israel.offroad.pois.geojson](../data/Israel.offroad.pois.geojson) (62,233 POIs) and [data/Israel.pois.geojson](../data/Israel.pois.geojson) (6,732 POIs).
  - Recomputes `category` and exclusive `subcategory` using all text/metadata fields, verifies 100% conformance to `poiTaxonomy.ts`, writes updated GeoJSON files cleanly to both `data/` and `public/data/`.
  - Emits a detailed **Migration Audit Report** (`transitionMatrix`, before/after counts by category & subcategory, zero remaining `offroad_poi`/`offroad_photo` assertion, and sample diffs for inspection).
- **[MODIFY] [devops/fetch-israel-pois.mjs](../devops/fetch-israel-pois.mjs)** & **[MODIFY] [devops/convert-offroad-pois.mjs](../devops/convert-offroad-pois.mjs)**
  - Replace legacy ad-hoc regexes with calls to `poiClassifier.ts` so future harvests follow the exact same rules.
- **[MODIFY] [src/core/pois/CommunityPoiImporter.ts](../src/core/pois/CommunityPoiImporter.ts)**
  - Replace the basic `inferCategory()` keyword check with `classifyPoi({ nameHe, nameEn, descHe, descEn })` so user-imported `.gpx`/`.kml`/`.kmz`/`.geojson`/`.twl` waypoints get accurate text-integrated categorization and exclusive symbols immediately.

---

## Phase 3: Persistent Delete & Category Editing Lifecycle

### 3.1 Database & Persistence Layer
- **[MODIFY] [src/core/db/NavDatabase.ts](../src/core/db/NavDatabase.ts)**
  - Bump Dexie schema to `this.version(5)` adding `poiOverrides!: Table<PoiOverrideRecord, string>` (`'id, deleted, category, updatedAt'`).
- **[MODIFY] [src/core/pois/PoiManager.ts](../src/core/pois/PoiManager.ts)**
  - Load `db.poiOverrides` during `initializePois()` and `getAllPois()`.
  - Apply overrides consistently in `mergeWithOffroadCache()`:
    - Exclude any POI ID with `override.deleted === true`.
    - Apply `{ category, subcategory }` overrides (and normalize priority + validate symbol against `poiTaxonomy.ts`).
  - Also run a lightweight migration normalization if an older cached custom/imported record in `db.pois` carries an obsolete subcategory (e.g. `offroad_poi`), upgrading it cleanly on load.
  - Add methods:
    - `updatePoiCategory(poi: PoiRecord, category: PoiCategory, subcategory?: string): Promise<PoiRecord>` — updates `db.pois` directly for `user-poi-*`/`import-*`, or persists `{ id, category, subcategory, updatedAt }` to `db.poiOverrides` (and updates `offroadPoisCache` / `db.pois` cleanly) for bundled POIs (`osm-*`, `il-poi-*`, `or-*`).
    - `resetPoiOverride(poiId: string): Promise<PoiRecord | null>` — restores original bundled category/subcategory for an overridden bundled POI.
    - `deletePoi(poi: PoiRecord): Promise<{ undoToken: PoiUndoSnapshot }>` and `restoreDeletedPoi(snapshot: PoiUndoSnapshot): Promise<PoiRecord>`.
    - `getOverrideState(): Promise<{ deletedIds: Set<string>; deletedSignatures: Array<{ normName: string; lon: number; lat: number }>; overrides: PoiOverrideRecord[] }>`.
  - Update `toCompactMapGeoJSON()` to emit `symbolId: resolvePoiSymbolId(p.category, p.subcategory)` so MapLibre always picks the exact exclusive sprite.

### 3.2 User Interface & App State Integration
- **[MODIFY] [src/components/pois/PoiInspectorSheet.tsx](../src/components/pois/PoiInspectorSheet.tsx)**
  - Render `<PoiCategoryIcon />` in the header badge & compact navigating mini-bar.
  - Add **"שנה קטגוריה / סמל"** expandable picker (6 category pills + exclusive subcategory symbol chips for the chosen category + optional `"אפס למקור"` if overridden).
  - Add **"מחק נקודה"** button with inline two-step confirmation bar (`[אשר מחיקה]` / `[ביטול]`, no blocking browser `confirm()` dialog).
  - Wire `onCategoryChanged(updated)` and `onDeletePoi(poi)` callbacks.
- **[MODIFY] [src/components/pois/AddPoiPanel.tsx](../src/components/pois/AddPoiPanel.tsx)**
  - Replace emoji category tiles with `<PoiCategoryIcon />` and add exclusive symbol/subcategory chips under the chosen category (defaulting to the category's default symbol).
- **[MODIFY] [src/App.tsx](../src/App.tsx)**
  - Wire `onCategoryChanged` and `onDeletePoi` handlers across **both** Desktop drawer and Mobile Planning sheet (Mobile Navigating `compactNavigating` keeps `"פרטים"` button which opens the full inspector cleanly).
  - On delete: remove POI from `pois` React state immediately, close POI drawer (`setSelectedPoi(null)`), and trigger an **Undo Toast** (`"הנקודה נמחקה • בטל"`) for 6 seconds calling `PoiManager.restoreDeletedPoi()`.

---

## Phase 4: Search, Cloud Sync, Android Auto & Offline Cache Rebuild

### 4.1 Search Integration
- **[MODIFY] [src/core/search/PMTilesSearchService.ts](../src/core/search/PMTilesSearchService.ts)**
  - Pass deleted POI coordinate/name tombstones from `PoiManager` into `PMTilesSearchService.search()` so deleted curated POIs not only disappear from `curated-poi` results, but also suppress duplicate underlying `pmtiles` vector entries matching within 85m & normalized title.
  - Ensure `POI_CATEGORY_META` / `poiCategory` badges in search results reflect updated categories cleanly.

### 4.2 Cloud Sync (`UserStateSyncService`)
- **[MODIFY] [src/core/preferences/UserStateSyncService.ts](../src/core/preferences/UserStateSyncService.ts)**
  - Optionally include compact `poiOverrides` in `PersistedUserState` (backward-compatible extension with strict max entry cap so Firestore `app_state` stays tiny) so deletions & category edits sync across devices when signed in.

### 4.3 Android Auto Parity
- **[MODIFY] [src/core/car/CarSyncService.ts](../src/core/car/CarSyncService.ts)**
  - Include category/subcategory-overridden bundled POIs in `selectCarSyncablePois()` and add `deletedPoiIdsJson` to `buildCarSyncPayload()`.
  - Ensure native bridge ([NativeOfflineStorage.ts](../src/core/pmtiles/NativeOfflineStorage.ts) / Android plugin) persists `deleted_poi_ids.json`.
- **[MODIFY] [NativeMapStore.java](../android/app/src/main/java/com/navapp/outdoor/israel/NativeMapStore.java)**
  - Filter out `deletedPoiIds` and merge overridden `category`/`subcategory` from `user_pois.json` when building `compact_pois.geojson`.
- **[MODIFY] [CarMapController.java](../android/app/src/main/java/com/navapp/outdoor/israel/car/CarMapController.java)** & **[devops/build-car-styles.mjs](../devops/build-car-styles.mjs)**
  - Mirror the exact 31 exclusive symbol IDs (`poi-<cat>-<slug>`) and per-category fallbacks from `poiTaxonomy.ts` (replacing old procedural 24×24 bitmaps and `'viewpoint'` global fallback).

### 4.4 Offline Service Worker & Capacitor Sync
- **[MODIFY] [devops/generate-offline-assets.mjs](../devops/generate-offline-assets.mjs)**
  - Bump SW cache key and regenerate [public/sw.js](../public/sw.js) precache hashes for updated sprites (`sprite*.{json,png}`) and recategorized GeoJSON datasets.
- Sync web assets cleanly (`npx cap sync android`) if Capacitor native bundle is verified/built.

---

## Phase 5: Verification Plan

### 5.1 Automated Unit & Integration Tests (`npm test`)
Extend [src/core/__tests__/navapp.test.ts](../src/core/__tests__/navapp.test.ts) (and add dedicated POI test suites) covering:
1. **Strict 1-to-1 Symbol Invariant Tests (`poiTaxonomy`):**
   - Every symbol ID in `SYMBOL_DEFINITIONS` maps to strictly 1 `PoiCategory`.
   - Every subcategory alias maps to strictly 1 `PoiCategory`.
   - Every per-category fallback symbol belongs strictly to its own category.
2. **Text-Integrated Classifier Suite (`poiClassifier`):**
   - Benchmark corpus of 30+ real-world & tricky Hebrew/English POIs: viewpoint overlooking a spring, dry ruined cistern vs active spring, `offroad_poi` / `offroad_photo` descriptions with mud/blocked gate/rock step/camp/water, municipal trap names (`באר שבע`, `מעלה אדומים`), and `CommunityPoiImporter` GPX/KML integration.
3. **Dataset Audit Verification (`Israel.pois.geojson` + `Israel.offroad.pois.geojson`):**
   - Verify 0 `offroad_poi` / `offroad_photo` remain; 100% of ~69k features resolve to a valid `(category, subcategory, symbolId)` inside a single category; report transition statistics.
4. **Persistence, Delete, Undo & Category Change Tests (`PoiManager` / `NavDatabase` / `CarSyncService`):**
   - Delete custom POI + delete bundled POI -> survives simulated `PoiManager.initializePois()` restart -> Undo restores cleanly.
   - Change category + subcategory on custom and bundled POIs -> persists across `initializePois()` -> reset override restores bundled classification -> `toCompactMapGeoJSON()` emits exclusive `symbolId`.
   - `CarSyncService.buildCarSyncPayload()` includes `deletedPoiIdsJson` and overridden bundled POIs.
   - `PMTilesSearchService` omits deleted curated POIs and suppresses matching PMTiles duplicates.

### 5.2 Build & Runtime Verification
- Run `npm run build` (TypeScript + Vite production bundle + offline SW generation).
- Run `npx vitest run` — all tests green.
- Start dev server (`npm run dev`) and inspect live MapLibre WebGL rendering via browser across:
  - Light / Dark / Satellite basemaps (verifying high-contrast modern 31-symbol rendering and 6 category toggles).
  - Tapping a POI -> changing category & symbol -> verifying pin icon and color change immediately -> reloading page and verifying persistence.
  - Deleting a POI -> verifying Undo toast -> deleting permanently -> reloading page and verifying POI stays absent from map and search.
- Verify Android compilation (`./gradlew assembleDebug` in `android/` if SDK configured cleanly) after CarMapController / NativeMapStore parity updates.

---

## Phase 6: Private POIs, Global Promotion & User-to-User Sharing (PRD-4)

> [!NOTE]
> **Status:** Planned — no Phase 6 source code edits have been made yet. Builds on the shipped global POI pipeline ([GlobalPoiCloudService.ts](../src/core/firebase/GlobalPoiCloudService.ts)), [poiPermissions.ts](../src/core/pois/poiPermissions.ts), and the `/users/{uid}` directory ([UserDirectoryService.ts](../src/core/firebase/UserDirectoryService.ts)).

### 6.1 Data Model & Permissions
- **[MODIFY] [src/core/db/NavDatabase.ts](../src/core/db/NavDatabase.ts)**
  - Add visibility & sharing types and fields on `PoiRecord`:
    - `export type PoiVisibility = 'private' | 'global';` (absent/`undefined` on bundled & legacy `global_pois` POIs is treated as `'global'`).
    - `export type PoiOwnership = 'mine' | 'shared';` (for private POIs; `'shared'` when received from another user).
    - `visibility?: PoiVisibility`, `ownership?: PoiOwnership`, `ownerUid?: string | null`, `ownerEmail?: string | null`, `ownerDisplayName?: string | null`, `sharedByUid?: string | null`, `sharedByName?: string | null`, `sharedByEmail?: string | null`, `sharedForUid?: string | null`, `sharedWith?: PoiShareRecipient[]`, `sharedWithUids?: string[]`, `sharedWithEmails?: string[]`.
  - Bump Dexie schema to `this.version(7)` adding `visibility, ownerUid, ownership` indexes on `pois` (zero data loss on upgrade from `v6`).
- **[MODIFY] [src/core/pois/poiPermissions.ts](../src/core/pois/poiPermissions.ts)**
  - Keep existing global delete restriction (`POI_DELETE_ADMIN_EMAILS`: `ohad.manor@gmail.com`, `nabibesk@gmail.com`) for `global` and bundled POIs.
  - Add POI-aware helpers:
    - `isPrivatePoi(poi)`: `poi.visibility === 'private'`.
    - `isOwnedPrivatePoi(poi, user)`: `isPrivatePoi(poi) && Boolean(user?.uid) && (poi.ownerUid || poi.createdByUid) === user.uid && poi.ownership !== 'shared'`.
    - `isSharedWithMePoi(poi, user)`: `isPrivatePoi(poi) && poi.ownership === 'shared'` (or `(poi.ownerUid || poi.createdByUid) !== user?.uid`).
    - `canUserDeletePoi(user, poi?)`:
      - If `poi` is an owned private POI (`isOwnedPrivatePoi(poi, user)`): **`true`** for any signed-in owner.
      - If `poi` is a shared-with-me POI: **`false`** for remote delete (recipient uses local dismiss instead).
      - If `poi` is global/bundled (or omitted): **`true` only for `POI_DELETE_ADMIN_EMAILS`**.
    - `canUserEditPoiCategory(user, poi?)`:
      - For `global`/bundled POIs: any signed-in user (`canUserAddOrEditPoi(user)`).
      - For `private` POIs: **owner only** (`isOwnedPrivatePoi(poi, user)`).
    - `canUserShareOrPromotePoi(user, poi)`: `isOwnedPrivatePoi(poi, user)`.

### 6.2 Firestore Collection, Security Rules & Cloud Sync
- **Firestore Collection Choice (`private_pois/{poiId}` top-level collection):**
  - Store private/shared user POIs in a dedicated top-level collection `private_pois/{poiId}` (keeping `global_pois/{poiId}` strictly public/global).
  - **Why top-level `private_pois/{poiId}`:**
    1. Standard Firestore automatic single-field indexes support `where('ownerUid', '==', uid)`, `where('sharedWithUids', 'array-contains', uid)`, and `where('sharedWithEmails', 'array-contains', emailLower)` immediately with **zero `collectionGroup` index provisioning delay**.
    2. Promoting a private POI to global can execute as a single atomic Firestore `writeBatch` (`set` in `global_pois/{poiId}` + `delete` in `private_pois/{poiId}`).
- **[MODIFY] [firestore.rules](../firestore.rules)**
  - Add strict `validPrivatePoi(data, poiId)` validator + rules for `match /private_pois/{poiId}`:
    - `allow get, list: if signedIn() && (resource.data.ownerUid == request.auth.uid || request.auth.uid in resource.data.sharedWithUids || (request.auth.token.email != null && request.auth.token.email.lower() in resource.data.sharedWithEmails));`
    - `allow create: if signedIn() && validPrivatePoi(request.resource.data, poiId) && request.resource.data.ownerUid == request.auth.uid && request.resource.data.createdByUid == request.auth.uid && request.resource.data.updatedByUid == request.auth.uid;`
    - `allow update: if signedIn() && validPrivatePoi(request.resource.data, poiId) && resource.data.ownerUid == request.auth.uid && request.resource.data.ownerUid == resource.data.ownerUid && request.resource.data.createdByUid == resource.data.createdByUid && request.resource.data.createdAt == resource.data.createdAt && request.resource.data.updatedByUid == request.auth.uid;`
    - `allow delete: if signedIn() && resource.data.ownerUid == request.auth.uid;`
  - Keep `global_pois/{poiId}` and `poi_overrides/{poiId}` rules unchanged (including `isPoiDeleteAdmin()` for global deletes).
- **[NEW] [src/core/firebase/PrivatePoiCloudService.ts](../src/core/firebase/PrivatePoiCloudService.ts)**
  - Serialize/deserialize `private_pois` documents (`ownerUid`, `ownerEmail`, `ownerDisplayName`, `sharedWith`, `sharedWithUids`, `sharedWithEmails` normalized lowercase + deduplicated).
  - CRUD & Sharing methods with offline retry queues (keyed in `localStorage` per `actorUid`, parallel to `GlobalPoiCloudService`):
    - `publishPrivatePoi(poi, user)`: writes to `private_pois/{safeId}` (or queues offline).
    - `updatePrivatePoiSharing(poi, recipients, user)`: updates local `db.pois` + `private_pois/{safeId}` (`sharedWith`, `sharedWithUids`, `sharedWithEmails`), or queues offline.
    - `promotePrivatePoiToGlobal(poi, user)`: updates `poi` locally to `visibility: 'global'` (stripping sharing fields), executes atomic `writeBatch` (`set global_pois/{safeId}` + `delete private_pois/{safeId}`), and cancels any queued pending private upload/share/delete for `poi.id` in favor of global publish if offline.
    - `deletePrivatePoi(poi, user)` & `restoreDeletedPrivatePoi(snapshot, user)`: deletes/restores from `private_pois/{safeId}` (or queues offline).
    - `flushPendingOperations(user)`: flushes only queued ops where `op.actorUid === user.uid`.
    - `fetchPrivateAndSharedPois(user)` + `subscribePrivateAndSharedPois(user, onUpdate)`:
      - Subscribes to 3 queries:
        1. `where('ownerUid', '==', user.uid)` (my private POIs)
        2. `where('sharedWithUids', 'array-contains', user.uid)` (shared with me by UID)
        3. `where('sharedWithEmails', 'array-contains', normalizedEmail)` (shared with me by Gmail, including pending pre-login invites)
      - Filters out dismissed shared POI IDs (`navapp.dismissedSharedPois.v1` scoped per UID) and triggers toast notifications for newly arrived shared POIs.

### 6.3 Local Store Reconciliation & Account Isolation
- **[MODIFY] [src/core/pois/PoiManager.ts](../src/core/pois/PoiManager.ts)**
  - Update `addCustomUserPoi(...)`:
    - Accept `visibility?: PoiVisibility` (default `'private'`), `ownerUid`, `ownerEmail`, `ownerDisplayName`, `sharedWith`, `sharedWithUids`, `sharedWithEmails`.
    - Default `visibility` to `'private'` and `ownership` to `'mine'` when `visibility === 'private'`.
  - **Fix `reconcileRemoteGlobalPoisAndOverrides(...)`:**
    - Do **NOT** treat `local.visibility === 'private'` POIs as stale/deleted when reconciling `global_pois`! Only `user-poi-*` records with `(local.visibility ?? 'global') === 'global'` participate in global-collection deletion reconciliation.
  - Add `reconcilePrivateAndSharedPois(...)`:
    - Reconciles `mine` private POIs (`visibility === 'private'`, `ownership !== 'shared'`) and `shared` POIs (`visibility === 'private'`, `ownership === 'shared'`, `sharedForUid === user.uid`) into `db.pois` while preserving local `userNotes` and pending offline edits.
    - Removes revoked shared POIs cleanly on sync when no longer returned by Firestore listeners.
  - Add `purgePrivateAndSharedPoisForUserSwitch(activeUid: string | null)`:
    - Called on sign-out (`activeUid === null`) and on Google account switch (`prevUid !== nextUid`): removes all `visibility === 'private'` POIs not owned by / shared for `activeUid` from `db.pois` immediately so private/shared POIs never leak across users on the same device.
  - Update `updatePoiCategory(...)` & `deletePoi(...)` & `restoreDeletedPoi(...)`:
    - When `poi.visibility === 'private'`, update/delete/restore `db.pois` directly without writing into global `db.poiOverrides` (preventing private POI edits/deletes from leaking into `poi_overrides`).
  - Update `toCompactMapGeoJSON(pois)` to emit `visibility: p.visibility || 'global'` and `ownership: p.ownership || 'global'` in feature `properties` for styling/filtering.

### 6.4 User Interface & App Integration
- **[MODIFY] [src/components/pois/AddPoiPanel.tsx](../src/components/pois/AddPoiPanel.tsx)**
  - Add **Visibility Toggle** defaulting to **`פרטי (רק אני)`** (`visibility = 'private'`), alongside **`גלובלי (כל המשתמשים)`** (`visibility = 'global'`).
  - When `visibility === 'private'`, optionally allow picking initial share recipients inline (or show a `"שמור ושתף"` / `"שתף"` button immediately on save) via the shared recipient picker.
  - Route save flow cleanly:
    - `visibility === 'private'` → `PrivatePoiCloudService.publishPrivatePoi(...)`
    - `visibility === 'global'` → `GlobalPoiCloudService.publishUserPoi(...)`
- **[NEW] [src/components/pois/SharePoiModal.tsx](../src/components/pois/SharePoiModal.tsx)**
  - Modal dialog mirroring [ShareRouteModal.tsx](../src/components/navigation/ShareRouteModal.tsx) (or extracting a shared `RecipientPicker` helper used by both):
    - Autocomplete search via `UserDirectoryService.searchUsers(...)` by in-app display name or Gmail email.
    - Pending invite support for valid emails not yet in `/users`.
    - Active recipients list with one-click revoke (`הסר גישה`), disabled when offline warning shown cleanly.
- **[MODIFY] [src/components/pois/PoiInspectorSheet.tsx](../src/components/pois/PoiInspectorSheet.tsx)**
  - Display clear visibility/ownership pill in the header (`🔒 פרטי`, `👥 פרטי משותף (N)`, `👥 שותף איתי ע״י <שם/אימייל>`, or `🌍 גלובלי`).
  - For **owned private POIs**:
    - Show **`שתף עם משתמשים`** button (opens `SharePoiModal`) + current recipient chips.
    - Show **`הפוך לגלובלי`** button with inline two-step confirmation (`[הפוך לגלובלי]` / `[ביטול]`).
    - Show **`מחק נקודה`** for the owner (even if not a global delete admin).
    - Route category/symbol changes through `PrivatePoiCloudService` instead of `GlobalPoiCloudService`.
  - For **shared-with-me POIs**:
    - Keep read-only protection (hide remote category edit, hide promote-to-global, hide share management, hide remote delete; keep local personal `userNotes`).
    - Provide **`הסר מהמפה שלי`** button to dismiss the shared POI locally.
- **[MODIFY] [src/components/map/LayerSwitcherSheet.tsx](../src/components/map/LayerSwitcherSheet.tsx)** & **[src/App.tsx](../src/App.tsx)**
  - Optional map visibility filter toggles for POI scope (`הצג נקודות פרטיות ומשותפות` alongside category toggles, defaulting ON when signed in).
  - In `App.tsx`:
    - Subscribe to `PrivatePoiCloudService.subscribePrivateAndSharedPois(currentUser, ...)` when signed in & online; purge private/shared POIs immediately on sign-out or user switch (mirroring the route isolation `useEffect` in `App.tsx`).
    - Flush `PrivatePoiCloudService.flushPendingOperations(currentUser)` on sign-in and reconnect.
    - Wire `handleDeletePoi` / `handleUndoDeletePoi` to branch cleanly between `PrivatePoiCloudService` (for owned private POIs) and `GlobalPoiCloudService` (for global/bundled POIs, still gated by `canUserDeletePoi`).
    - Wire `handlePromotePoiToGlobal` and `handleUpdatePoiSharing` callbacks into `PoiInspectorSheet` and `SharePoiModal`.
    - Add a subtle visual indicator on private/shared map markers (e.g., subtle lock/share badge or ring styling in MapLibre symbol layer / `PoiCategoryIcon` while preserving the canonical 6-category symbol).

### 6.5 Search & Android Auto Parity
- **[MODIFY] [src/core/search/PMTilesSearchService.ts](../src/core/search/PMTilesSearchService.ts)**
  - Include `visibility` / `ownership` label in `SearchResultItem.sourceLabel` (e.g., `"נקודה פרטית"` / `"שותף ע״י <שם>"`) so private & shared POIs are clearly labeled in search results.
- **[MODIFY] [src/core/car/CarSyncService.ts](../src/core/car/CarSyncService.ts)**
  - `selectCarSyncablePois` already includes `user-poi-*`; ensure private/shared POIs belonging to the signed-in user sync to Android Auto while logged in and are excluded from `CarSyncService` payload immediately upon sign-out (`purgePrivateAndSharedPoisForUserSwitch`).

### 6.6 Phase 6 Verification Plan
1. **Firestore Rules Unit Tests (`src/core/__tests__/privatePois.rules.test.ts`):**
   - Unauthenticated users cannot read/write `private_pois`.
   - Owner can create, read, update, share (`sharedWithUids` / `sharedWithEmails`), and delete their own `private_pois` (even when NOT in `POI_DELETE_ADMIN_EMAILS`).
   - Recipient in `sharedWithUids` or `sharedWithEmails` (case-insensitive email) can read/list the shared POI, and gets `permission-denied` on update or delete.
   - Non-owner, non-recipient user gets `permission-denied` on read, update, and delete.
   - Non-admin user still gets `permission-denied` when attempting to delete `global_pois`.
2. **Unit & Integration Tests (`src/core/__tests__/privatePois.test.ts`):**
   - `PoiManager.addCustomUserPoi` defaults `visibility` to `'private'`; does not write to `global_pois`.
   - `PoiManager.reconcileRemoteGlobalPoisAndOverrides` preserves local `private` POIs even when absent from `global_pois`.
   - `PrivatePoiCloudService.promotePrivatePoiToGlobal` atomically writes to `global_pois`, deletes from `private_pois`, clears sharing fields, and reconciles offline queues cleanly.
   - Recipient reconciliation handles live arrival, pending email claim, access revocation, local dismiss, and account sign-out / user-switch purge (`purgePrivateAndSharedPoisForUserSwitch`).
   - `canUserDeletePoi` / `canUserEditPoiCategory` permission matrix across anonymous, regular owner, recipient, other user, and global admin.
3. **Manual / Runtime E2E Verification (`npm test`, `npm run build`, Browser & Emulator):**
   - Sign in as Account A -> Add POI (verify default is `פרטי`) -> verify Account B (and signed-out browser) does NOT see it.
   - Account A shares the private POI with Account B (by display name & by Gmail) -> verify Account B sees it live with sender attribution and cannot delete/promote it -> revoke access -> verify it disappears from Account B.
   - Account A promotes a private POI to `גלובלי` -> verify it disappears from `private_pois`, appears in `global_pois`, and becomes visible to Account B and signed-out users (with delete restricted to admins).
   - Account A deletes their own private POI -> verify Undo works and permanent delete persists across reload.
