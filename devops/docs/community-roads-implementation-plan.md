# Community Roads (Add / Edit Any Highway & Sync to OSM) — Implementation Plan

## 1. Goal & Scope

Add the ability inside the **סימון שבילים** (Trail Marking) menu to **add a new road/highway** or **edit any existing highway** (both community-added roads and existing OSM highways), **topologically connected to existing roads**, with optional **one-click sync to OpenStreetMap (OSM)** for signed-in NavApp users:

1. **Any Highway Type (Add & Edit)**: Support **all** OSM `highway` types (`motorway`, `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service`, `track`, `path`, `footway`, `cycleway`, `bridleway`, `pedestrian`, `steps`, etc.) — both when creating a new road and when editing an existing OSM or community highway (class, `tracktype`, `surface`, `oneway`, `name`, `4x4`/`foot`/`bicycle` access, and geometry).
2. **Map Visibility**: New and edited highways render immediately on the map (both `topo-light` and `topo-dark`) with highway-appropriate styling, and can optionally be marked with a community trail color/number/description via `trail_annotations`.
3. **Routing Connectivity**: Client-side route planning ([`ClientRoutePlannerEngine.ts`](../../src/core/routing/ClientRoutePlannerEngine.ts)) snaps to new/edited roads and routes **onto, across, and off** them seamlessly through connected intersection nodes in [`TileRoadGraphBuilder.ts`](../../src/core/routing/TileRoadGraphBuilder.ts).
4. **Persistence & Auditability**: Like [`trail-annotations-implementation-plan.md`](./trail-annotations-implementation-plan.md), the base `Israel.osm.pmtiles` archive is **never** modified. Community roads and OSM highway overrides are stored in Firestore with immutable edit history, cached locally in Dexie (IndexedDB) for offline viewing & routing, and survive PMTiles archive updates.
5. **Sync to OpenStreetMap (Phase 5 — External Local PC Tool in `devops/`)**: An external PC CLI tool (`devops/sync-osm-roads.bat` / `devops/script_helpers/sync-osm-roads.mjs`) reads pending community roads/edits from Firestore, pushes them to OpenStreetMap via OSM API v0.6 (the highway itself, trail `colour` if defined, and the signed-in NavApp user attribution — **only** roads created/edited by a logged-in NavApp user are eligible), and marks them synced in Firestore. The NavApp web/mobile app itself does not call OSM APIs directly.
6. **Access Control**: Everyone (including anonymous/offline users with cached data) can view and route over published community roads/edits. Any signed-in NavApp user can create, edit, soft-delete, or sync roads to OSM with full revision history and optimistic concurrency control.

---

## 2. UX & Entry Point in `סימון שבילים`

Currently, toggling `סימון שבילים` in [`App.tsx`](../../src/App.tsx) sets `isTrailMarkingMode = true`, and [`TrailAnnotationsPanel.tsx`](../../src/components/map/TrailAnnotationsPanel.tsx) stays hidden (`isVisible = isMarkingMode && (isEditing || wayCandidates.length > 0)`) until the user clicks an existing OSM highway segment.

### Proposed Mode Flow

When `isTrailMarkingMode` is turned **on**, show a compact floating mode bar (or header strip in `TrailAnnotationsPanel`) with three sub-modes:

1. **סימון שביל קיים** *(default — existing behavior)*: Tap an existing OSM highway or community road on the map to mark/edit its trail color, number, and description.
2. **הוספת דרך חדשה** *(new — Draw Road mode)*:
   - Switches map interaction to **polyline drawing with live road snapping**:
     - **Desktop**: Hover shows a live snap preview (`snapPreview`: green ring + target road label e.g. `מתחבר ל: דרך עפר (2 מ׳)` when within snap radius of an existing OSM/community road; amber dot when placing an un-snapped intermediate vertex). Click adds a vertex; double-click or clicking **"סיום ציור"** finishes the geometry and opens the road metadata form.
     - **Mobile**: Tap adds a vertex (using the same snap logic around the tap point). Floating bottom action bar provides **ביטול נקודה אחרונה (Undo)**, **סיום ציור (Finish)**, and **ביטול (Cancel)**.
   - **Connection Requirement / Validation**:
     - A new road must have at least 2 distinct points and total length ≥ 5 m (max e.g. 2,000 vertices / 50 km per single road segment).
     - **Connection check**: At least one endpoint (and recommended: both endpoints) should be snapped to an existing road (`RoadConnectionAnchor`). If *neither* endpoint is connected to any existing road, show a clear validation warning (`יש לחבר לפחות קצה אחד של הדרך לדרך קיימת במפה`) so isolated floating lines don't pollute the routing network.
3. **עריכת דרך קיימת** *(Edit Any Highway)*:
   - Tap any **existing OSM highway** (`osm:way:<id>`) or **community road** (`community:road:<id>`) to open `CommunityRoadEditor` prefilled with its current OSM/community properties and full-way geometry.
   - Users can change **any** highway property (highway type, `tracktype`, `surface`, `oneway`, `name`, `4x4`/`foot`/`bicycle` access) or adjust/extend its geometry vertices, and save it as a non-destructive community override (`kind: 'osm-override'`, `sourceOsmWayId: 'osm:way:<id>'`) or update the `community_roads` record.
   - *(Also accessible directly from the `סימון שביל קיים` candidate/editor sheet via a **"ערוך מאפייני דרך"** button.)*

### Road Metadata Form (`CommunityRoadEditor.tsx`)

- **סוג דרך (`highwayClass` — כל סוגי הדרכים ב-OSM)**:
  Grouped dropdown/selector supporting all OSM `highway` values:
  - **שטח ושבילים**: `track` (דרך עפר / 4x4, עם בחירת `tracktype`: `grade1`–`grade5`), `path` (שביל שטח), `footway` (שביל הולכי רגל), `cycleway` (שביל אופניים), `bridleway` (שביל סוסים), `steps` (מדרגות), `pedestrian` (מדרחוב).
  - **כבישים ורחובות**: `motorway` (כביש מהיר), `trunk` (כביש ראשי/מהיר), `primary` (כביש ראשי), `secondary` (כביש אזורי), `tertiary` (כביש מקומי), `unclassified` (כביש לא מסווג), `residential` (רחוב מגורים), `living_street` (רחוב משולב), `service` (דרך שירות).
- **סוג פני שטח (`surface`)** (optional): `paved`, `asphalt`, `concrete`, `gravel`, `dirt`, `sand`, `rock`, `ground`.
- **הרשאות מעבר (`access`)**: Checkboxes/pills derived from defaults for the chosen `highwayClass`, overridable by user:
  - `4x4` (רכב שטח)
  - `foot` (הליכה)
  - `bicycle` (אופניים)
- **חד-סטרי (`oneway`)**: דו-סטרי (`0`) / חד-סטרי בכיוון הציור (`1`) / חד-סטרי הפוך (`-1`).
- **שם הדרך (`name`)** (optional), **תיאור (`description`)** (optional), **סיבת השינוי (`reason`)** (optional).
- **סטטוס סנכרון ל-OSM**: Displays a read-only status badge (`ממתין לסנכרון ל-OSM` / `סונכרן ל-OSM #changesetId`) updated by the external `devops/` PC sync tool (see Section 6).
- *(Optional convenience)* **"סמן כשביל גם ב'סימון שבילים'"**: Checkbox or follow-up action after saving to attach a `trail_annotations` color/number/description to the road (`community:road:<roadId>` or `osm:way:<id>`).

---

## 3. Data Model & Persistence Architecture

### 3.1 TypeScript Types — `src/core/trails/CommunityRoadTypes.ts`

```ts
export type CommunityHighwayClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'unclassified'
  | 'residential'
  | 'living_street'
  | 'service'
  | 'track'
  | 'path'
  | 'footway'
  | 'cycleway'
  | 'bridleway'
  | 'pedestrian'
  | 'steps';

export type CommunityRoadKind = 'new' | 'osm-override';
export type CommunityRoadStatus = 'active' | 'deleted';
export type CommunityRoadOperation = 'create' | 'edit' | 'delete' | 'restore' | 'osm-sync';

export interface OsmSyncMetadata {
  changesetId: number;
  osmWayId: number;
  osmVersion: number;
  syncedRevision: number;
  syncedAt: string;
  syncedByUid: string;
  syncedByName: string;
  osmUsername?: string;
}

export interface RoadConnectionAnchor {
  /** Index in `coordinates` (usually 0 or coordinates.length - 1, or intermediate T-junction) */
  vertexIndex: number;
  /** Target way ID: `osm:way:<id>` or `community:road:<id>` */
  targetWayId: string;
  /** Exact snapped coordinate [lon, lat] */
  coord: [number, number];
  /** Precomputed z14 global pixel coordinates for deterministic graph stitching */
  gx: number;
  gy: number;
  snapType: 'vertex' | 'segment';
}

export interface CommunityRoadSnapshot {
  kind: CommunityRoadKind;
  /** Set when `kind === 'osm-override'`, e.g. `osm:way:230594158` */
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>; // [lon, lat], 2..2000 points
  bounds: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
  highwayClass: CommunityHighwayClass;
  tracktype?: 'grade1' | 'grade2' | 'grade3' | 'grade4' | 'grade5' | '';
  surface?: string;
  name: string;
  description: string;
  oneway: -1 | 0 | 1;
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
  anchors: RoadConnectionAnchor[];
  status: CommunityRoadStatus;
}

export interface CommunityRoadRecord extends CommunityRoadSnapshot {
  id: string;
  schemaVersion: 1;
  revision: number;
  lastHistoryId: string;
  createdByUid: string;
  createdAt: string;
  updatedByUid: string;
  updatedAt: string;
  osmSync?: OsmSyncMetadata;
}
```

### 3.2 Firestore & Security Rules

- **Collection**: `community_roads/{roadId}` + immutable subcollection `community_roads/{roadId}/history/{historyId}`.
- **Why store `coordinates` directly in Firestore (no Storage JSON needed)?**
  - A single user-drawn road polyline with up to 2,000 `[lon, lat]` pairs is ~40–60 KB, well under Firestore's 1 MB document limit. Storing it directly in the Firestore document keeps reads/writes atomic in a single `runTransaction` and works without Firebase Storage CORS/latency overhead.
- **Firestore Rules** ([`devops/firebase/firestore.rules`](../../devops/firebase/firestore.rules)):
  - `allow read: if true;`
  - `allow create, update`: require `request.auth != null`, `schemaVersion == 1`, valid `highwayClass` enum, `coordinates.size() >= 2 && coordinates.size() <= 2000`, `bounds.size() == 4`, `revision == 1` on create or `previous.revision + 1` on update, and transactionally paired `history/{lastHistoryId}` document (`allow update, delete: if false;` on `history`).

### 3.3 Offline Storage in Dexie — [`src/core/db/NavDatabase.ts`](../../src/core/db/NavDatabase.ts)

Bump Dexie schema from `version(8)` to `version(9)`:
- `communityRoads: 'id, status, highwayClass, updatedAt'` — caches all downloaded active/deleted community roads for instant offline rendering & routing.
- `communityRoadDrafts: 'id, ownerUid, updatedAt'` — stores in-progress offline road drawings/edits if the user is offline.

### 3.4 Cloud Service — `src/core/firebase/CommunityRoadsCloudService.ts`

Follow the exact pattern of [`TrailAnnotationsCloudService.ts`](../../src/core/firebase/TrailAnnotationsCloudService.ts):
- `loadCommunityRoads()`: Fetch newest active/deleted records from Firestore (with Dexie fallback when offline) and maintain an in-memory spatial cache (`CommunityRoadRecord[]`) accessible synchronously/asynchronously by both the map overlay and `TileRoadGraphBuilder`.
- `saveCommunityRoad(...)`: Transactional create/update with `expectedRevision` optimistic locking (`TrailAnnotationConflictError`-equivalent conflict handling) + immutable `history` event.
- `deleteCommunityRoad(...)`: Soft delete (`status: 'deleted'`) with audit history.
- `loadCommunityRoadHistory(roadId, cursor)`: Paginated audit log.

---

## 4. Topological Connection & Routing Graph Integration

This is the core technical requirement: **the new road must connect to existing roads in the routing graph**, even when the user taps the **middle of an existing straight road segment** (not just at an existing OSM vertex).

### 4.1 Live Snapping During Drawing

Reuse [`ClientRoutePlannerEngine.ts`](../../src/core/routing/ClientRoutePlannerEngine.ts) (`snapToNearestHighway` / `TileRoadGraphBuilder` z14 tile decoding):
- Add a helper `snapPointToExistingRoads(lon, lat, maxRadiusMeters = 35)` (using `TileRoadGraphBuilder` at z14 across all routable classes + cached `community_roads` within the local bbox):
  1. Project `(lon, lat)` onto nearby OSM `DecodedWay` segments and existing `CommunityRoadRecord` segments.
  2. Prefer snapping to an existing **vertex** if within e.g. 8 m (reusing its exact `(gx, gy)` and `[lon, lat]`), otherwise snap to the nearest **segment projection** point `P` and compute its z14 global pixel coordinates `(gx, gy)` via `lonLatToGlobalPixel(P.lon, P.lat)`.
  3. Return `{ coord: [P.lon, P.lat], gx, gy, targetWayId, roadLabel, distMeters, snapType }`.
- When the user clicks/taps within `maxRadiusMeters` (e.g., 35 m) of an existing road:
  - Snap the vertex to `P` and record a `RoadConnectionAnchor`.
  - Allow holding `Shift` (desktop) or toggling a "Freehand / הצמדה לדרך" pill (mobile/desktop) if the user wants to place an intermediate shape vertex near a road *without* snapping to it.

### 4.2 Graph Injection & Segment Splitting in [`TileRoadGraphBuilder.ts`](../../src/core/routing/TileRoadGraphBuilder.ts)

In [`TileRoadGraphBuilder.ts`](../../src/core/routing/TileRoadGraphBuilder.ts), `buildGraphForTiles(tiles, mode)` currently:
1. Decodes `transportation` MVT features from `Israel.osm.pmtiles` into `DecodedWay[]`.
2. Counts node occurrences (`nodeOccCount`) by `${way.layer}:${cgx},${cgy}` and splits ways into `GraphEdge`s wherever `nodeOccCount >= 2`.

To connect `community_roads` cleanly:
1. **Inject Community Roads as `DecodedWay[]`**:
   - Compute the bounding box of `tiles`.
   - Fetch active `CommunityRoadRecord`s whose `bounds` intersect the tile bbox.
   - Map each `CommunityRoadRecord` to a `DecodedWay` with:
     - `featureId: 'community:road:' + road.id`
     - `layer: 0`
     - `props: { class: road.highwayClass, tracktype: road.tracktype, oneway: road.oneway, name: road.name, _communityAccess: { allow4x4, allowFoot, allowBicycle } }`
     - `points`: converted to z14 `GlobalTilePoint[]` (`gx, gy, lon, lat, isClipped: false`).
2. **Split Existing Ways at T-Junction Anchors**:
   - Collect all `RoadConnectionAnchor` points `(gx, gy)` (plus any community road endpoint within e.g. 3 m of another way's segment).
   - For each `DecodedWay` (OSM or community) in `filteredWays`:
     - If an anchor's `(gx, gy)` is not already in `way.points`, check if the anchor's `[lon, lat]` projects onto any segment `(i, i+1)` of `way.points` within a tight tolerance (e.g. ≤ 3 m).
     - If so, **insert** a `GlobalTilePoint` at `(gx, gy)` between `i` and `i+1` (ordered by projection `t` along the segment if multiple anchors land on the same segment).
   - **Result**: Because the anchor's `(gx, gy)` now appears in **both** the existing `DecodedWay` and the new community `DecodedWay`, `nodeOccCount.get('0:gx,gy') >= 2` is guaranteed! `TileRoadGraphBuilder` will automatically split the existing road edge into `A -> P` and `P -> B` and join the new road `P -> ...` at node `0:gx,gy` — with full support for A* routing, bidirectional/oneway rules, and elevation profiles.
3. **Access Profile Integration in [`RoutingProfiles.ts`](../../src/core/routing/RoutingProfiles.ts)**:
   - In `evaluateEdgeAccess(props, mode)`, check `props._communityAccess`: if present, honor `allow4x4`, `allowFoot`, and `allowBicycle` directly alongside `oneway`.

---

## 5. Map Rendering & Trail Annotation Integration

### 5.1 MapLibre Layers in [`App.tsx`](../../src/App.tsx)

Add a dedicated GeoJSON source `community-roads-src` and layers placed **below** `community-trails-casing` and `saved-routes-line`:
- `community-roads-casing`: subtle dark/light casing for contrast.
- `community-roads-line`: styled with a `match` expression on `highwayClass`:
  - `track`: dashed brown/ochre line (`#92400e` / `#d97706`)
  - `path` / `footway`: fine dotted line
  - `cycleway`: dashed teal/blue line
  - `service` / `unclassified`: solid light road fill with casing
- `community-roads-label`: optional symbol layer showing `name` at zoom ≥ 14.
- **Draft Preview Source (`community-road-draft-src`)**:
  - Dashed emerald/cyan preview line for the road currently being drawn, vertex circles, and a snap target indicator ring.

### 5.2 Integration with `trail_annotations` (Optional Trail Marking on New Roads)

Update [`TrailAnnotationTypes.ts`](../../src/core/trails/TrailAnnotationTypes.ts) and [`HighwayWayGeometryService.ts`](../../src/core/trails/HighwayWayGeometryService.ts):
- Extend `parseTrailWayId(wayId)` to accept both `osm:way:<id>` and `community:road:<uuid>`.
- When `handleTrailMapClick` in `App.tsx` is in `סימון שבילים` select mode, include `community-roads-line` in the queried layers:
  - Clicking a community road lets the user choose **"עריכת הדרך"** (open `CommunityRoadEditor` to edit geometry/class/access/history) OR **"סימון שביל על דרך זו"** (create/edit a `trail_annotations` entry referencing `community:road:<id>`).

---

## 6. Phase 5 — External Local PC Tool: Sync to OpenStreetMap (`devops/`)

The OSM sync runs **externally on a PC** as a local CLI tool in `devops/` (alongside [`poi-sync.mjs`](../../devops/script_helpers/poi-sync.mjs) and [`upload-map-data.mjs`](../../devops/script_helpers/upload-map-data.mjs)), **not** inside the NavApp web/mobile client.

### 6.1 Tool Files, Selection UI & CLI Workflow
- **Launcher**: `devops/sync-osm-roads.bat`
- **Script**: `devops/script_helpers/sync-osm-roads.mjs`
- **Local Selection UI (`--ui`, default when run without CLI action flags)**:
  - Starts a local web server (`http://127.0.0.1:4199`) and opens it in the PC browser.
  - Displays all `community_roads` with checkboxes so the user can **select/deselect** exactly what to sync and what not to sync (`בחר הכל` / `בטל בחירה`), inspect each road's type, trail `colour`, NavApp user attribution, and preview its OsmChange XML before clicking **"סנכרן נבחרים ל-OSM"**.
- **CLI Flags**:
  - `--ui`: Explicitly launches the local browser selection UI (default).
  - `--dry-run`: Queries pending roads, builds the OsmChange XML, and prints the exact diff without uploading to OSM or modifying Firestore.
  - `--sandbox`: Targets OSM Dev API (`https://master.apis.dev.openstreetmap.org`) instead of production (`https://api.openstreetmap.org`).
  - `--id <roadId>`: Syncs a single `community_roads` document; otherwise processes all active pending records (`!osmSync || osmSync.syncedRevision < revision`).
  - `--yes`: Skips interactive confirmation prompt.

### 6.2 Strict Logged-In NavApp User Verification & OSM Auth
- **NavApp Logged-In User Gate**:
  - Firestore rules ensure only signed-in NavApp users can write `community_roads` (`createdByUid` / `updatedByUid` must be a non-empty authenticated Firebase UID).
  - The local tool additionally verifies each candidate record has a valid `updatedByUid` (rejecting any record missing user attribution) and looks up the NavApp user's display name/email from Firebase Auth / Firestore user profile for changeset attribution.
- **OSM API v0.6 Authentication (PC-side)**:
  - Uses an OSM OAuth 2.0 bearer token (`write_api` scope) configured in local `.env` (`OSM_ACCESS_TOKEN`) or obtained via a one-time local OAuth 2.0 PKCE loopback login in the CLI tool.
  - Reads Firebase via local Firebase Admin SDK / service account credentials (matching existing `devops/script_helpers/` tools).

### 6.3 What Gets Synced to OSM
1. **The Highway Itself (Geometry, Topology & Tags)**:
   - **New Highway (`kind: 'new'`)**:
     - Creates `<node>` elements for intermediate/unconnected vertices.
     - For each `RoadConnectionAnchor` on an existing `osm:way:<id>`:
       - Fetches `GET /api/0.6/way/{id}/full`.
       - If `snapType === 'vertex'`, reuses the matching existing OSM `<nd ref="..."/>` node ID so the ways share a true OSM junction node.
       - If `snapType === 'segment'`, creates the junction `<node>` and **inserts `<nd ref="..."/>` into the existing OSM way** (incrementing its `version`) within the same OsmChange upload so OSM maintains a valid connected intersection.
     - Creates the new `<way>` with `<tag k="highway" v="<highwayClass>"/>`, plus optional `name`, `tracktype`, `surface`, `oneway=yes` (or `-1`), `description`, and access tags (`motor_vehicle`, `foot`, `bicycle`) when overridden.
   - **Edited Existing Highway (`kind: 'osm-override'`) — In-Place Update (Never Duplicate)**:
     - Uses the exact existing OSM way ID (`sourceOsmWayId` → numeric `osmWayId`) and emits **`<modify><way id="{osmWayId}" version="{currentVersion}">...</way></modify>`** in the OsmChange payload — **never** `<create>`.
     - Fetches `GET /api/0.6/way/{osmWayId}/full` first to:
       1. Read the latest `version` (if OSM returns `409 Conflict` on upload, logs the conflict and skips that record without overwriting).
       2. **Preserve all untouched existing OSM tags** (e.g., `maxspeed`, `lanes`, `bridge`, `tunnel`, `width`, `source`) and only update/add the tags modified in NavApp (`highway`, `name`, `tracktype`, `surface`, `oneway`, access tags, and `colour`/`osmc:symbol` if defined).
       3. **Preserve existing `<nd ref="..."/>` node IDs** if geometry was not changed; if vertices were moved/inserted, emits `<modify>` for moved nodes or `<create>` for newly inserted nodes while keeping unchanged node IDs intact.
2. **Trail Color (If Defined)**:
   - Queries Firestore `trail_annotations` for any active annotation referencing `community:road:<id>` or `osm:way:<id>`.
   - If a color is defined, maps `TrailAnnotationColor` hex to OSM standard color names (`#dc2626` → `red`, `#ea580c` → `orange`, `#ca8a04` → `yellow`, `#16a34a` → `green`, `#2563eb` → `blue`, `#7c3aed` → `purple`, `#334155` → `black`) and includes:
     - `<tag k="colour" v="<colorName>"/>`
     - `<tag k="osmc:symbol" v="<colorName>:white:<colorName>_stripe"/>` (and `<tag k="ref" v="<trailNumber>"/>` if a trail number is defined).
3. **Changeset Attribution & Firestore Audit Update**:
   - Opens changeset (`PUT /api/0.6/changeset/create`) with tags:
     - `created_by=NavApp-Tools`
     - `comment=<reason or "Add/update highway via NavApp">`
     - `source=NavApp community survey`
     - `navapp:user_uid=<updatedByUid>`
     - `navapp:user_name=<userDisplayName || userEmail || updatedByUid>`
   - Uploads OsmChange (`POST /api/0.6/changeset/{id}/upload`) and closes (`PUT /api/0.6/changeset/{id}/close`).
   - Writes `osmSync: { changesetId, osmWayId, osmVersion, syncedRevision: record.revision, syncedAt, syncedByUid: updatedByUid, syncedByName, osmUsername }` back to Firestore `community_roads/{roadId}` (with a `history` event `operation: 'osm-sync'`) so the NavApp UI shows `סונכרן ל-OSM #changesetId` and subsequent runs skip already-synced revisions.

---

## 7. Verification & Testing Plan

### Unit Tests (`vitest`)
1. **Graph Connection & Splitting (`TileRoadGraphBuilder.test.ts`)**:
   - Verify a community road snapped to an **existing OSM vertex** connects and routes in `ClientRoutePlannerEngine`.
   - Verify a community road snapped to the **midpoint of an existing straight OSM segment** (T-junction) inserts the split point, creates `nodeOccCount >= 2`, and routes seamlessly from OSM road → community road → another OSM road.
   - Verify `allow4x4` / `allowFoot` / `allowBicycle`, `oneway`, and `osm-override` highway edits are respected per `PlanningMode`.
2. **Validation & Types (`CommunityRoadTypes.test.ts`)**:
   - Accept all OSM `highway` classes; reject < 2 points, > 2000 points, unconnected new roads (0 anchors), invalid `highwayClass`.
3. **Firestore Rules (`communityRoads.rules.test.ts`)**:
   - Mirror `src/core/__tests__/trailAnnotations.rules.test.ts`: test public read, authenticated create/update with valid revision + history transaction, rejection of unauthenticated writes, and rejection of history tampering.
4. **External OSM Sync Tool (`sync-osm-roads.test.ts`)**:
   - Verify OsmChange XML generation for new roads (node sharing + existing way T-junction split), in-place `<modify>` for edited OSM ways (preserving untouched tags & node IDs), `colour`/`osmc:symbol` tag mapping when trail color is defined, and rejection of records without valid logged-in NavApp user attribution.

### Manual / UI & CLI Verification
- Toggle `סימון שבילים` → select **"הוספת דרך חדשה"** → draw a shortcut connecting two existing dirt tracks → verify snap indicator → save as `track` (`4x4` + `foot`).
- Select an existing OSM road → **"ערוך מאפייני דרך"** → change `highwayClass` / `tracktype` / `name` → verify map style and routing reflect the edit.
- Open **תכנון מסלול** (`4x4` mode) → place start on Track A and end on Track B → verify route plans **through** the newly added community road.
- Run `devops\sync-osm-roads.bat --dry-run --sandbox` on PC → inspect generated OsmChange XML (highway tags, `colour`, NavApp user attribution, and `<modify>` for edited OSM ways) → run with `--sandbox` and verify changeset on OSM Dev API + `osmSync` badge update in NavApp.
- Refresh page & test offline mode → verify the road persists from Dexie, renders on the map, and routes offline.

---

## 8. Phased Rollout

| Phase | Deliverable | Key Files |
|---|---|---|
| **Phase 1** | Data model (all OSM highway types + `osm-override`), validation, Dexie v9 tables, Firestore rules, `CommunityRoadsCloudService` | `src/core/trails/CommunityRoadTypes.ts`, `src/core/db/NavDatabase.ts`, `src/core/firebase/CommunityRoadsCloudService.ts`, `devops/firebase/firestore.rules` |
| **Phase 2** | Routing graph injection, T-junction segment splitting, `osm-override` replacement, and access evaluation | `src/core/routing/TileRoadGraphBuilder.ts`, `src/core/routing/ClientRoutePlannerEngine.ts`, `src/core/routing/RoutingProfiles.ts` |
| **Phase 3** | MapLibre layers, interactive Draw + Snap mode & Edit Any Highway mode in `סימון שבילים`, and `CommunityRoadEditor` UI | `src/App.tsx`, `src/components/map/TrailAnnotationsPanel.tsx`, `src/components/map/CommunityRoadEditor.tsx` |
| **Phase 4** | Optional trail marking on `community:road:<id>`, unit tests, and Firestore rules tests | `src/core/trails/TrailAnnotationTypes.ts`, `src/core/trails/HighwayWayGeometryService.ts`, `src/core/__tests__/` |
| **Phase 5** | External local PC CLI tool in `devops/` to sync pending roads/edits + `colour` + logged-in NavApp user attribution to OSM API v0.6 | `devops/sync-osm-roads.bat`, `devops/script_helpers/sync-osm-roads.mjs` |
