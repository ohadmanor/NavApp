# NavApp — Planning Trail DB (Separate Hierarchical Library) Implementation Plan

## 1. Executive Summary & Product Architecture

**Planning Trail DB** (`מאגר תכנון מסלולים`) is a **new, dedicated menu and database** added **alongside** NavApp's existing **Routes** menu ([`ElevationProfileDrawer.tsx`](../../src/components/navigation/ElevationProfileDrawer.tsx)) — **not** a replacement for it.

### Two-Tier Workflow: Planning DB ↔ Active Routes
1. **Planning Trail DB (New Menu — Long-Term Large Archive)**:
   - Holds **hundreds to thousands of planned/collected trails** in one large unified database.
   - Organized into **nested folders & subfolders**, **categories**, and **4 difficulty levels** (`קל / Light`, `בינוני / Medium`, `קשה / Hard`, `אקסטרים / Extreme`).
   - Used for browsing, filtering, organizing trips by region/season, and previewing entire folders on the map.
   - Action on any trail: **"📤 שלח למסלולים"** (`Send to Active Routes`) — copies the trail (with its geometry/elevation/waypoints) into the existing Routes menu so the user can navigate with it, edit waypoints, or share it.
2. **Routes Menu (Existing "Old" Menu — Active Workspace)**:
   - Remains unchanged as the focused workspace for **active navigation, waypoint editing, GPX export, and sharing** ([`ElevationProfileDrawer.tsx`](../../src/components/navigation/ElevationProfileDrawer.tsx) + [`RoutePlannerPanel.tsx`](../../src/components/navigation/RoutePlannerPanel.tsx)).
   - Gains one new action on every route: **"🗂️ שלח למאגר תכנון"** (`Send to Planning DB`), which lets the user pick a destination **Folder / Subfolder**, **Category**, and **Difficulty** (`light`, `medium`, `hard`, `extreme`) to store the route in the Planning Trail DB.

---

## 2. Current Codebase Integration Points

| Component | Existing Role | New Integration |
|---|---|---|
| **App Shell** ([`App.tsx`](../../src/App.tsx)) | `DesktopDrawerMode` (`'routes'`, `'plan-route'`, etc.) & `MobileTab` (`'explore'`, `'routes'`, `'record'`, `'offline'`). | Add `'planning-db'` to `DesktopDrawerMode` and `'planning-db'` to `MobileTab` (or dedicated top/nav entry) without altering `'routes'`. |
| **Existing Routes Menu** ([`ElevationProfileDrawer.tsx`](../../src/components/navigation/ElevationProfileDrawer.tsx)) | Lists `SavedRouteRecord[]` for navigation, editing, GPX export, sharing. | Add **"שלח למאגר תכנון"** button on the selected route card / action bar. |
| **Local DB** ([`NavDatabase.ts`](../../src/core/db/NavDatabase.ts)) | Dexie v7 (`routes`, `routePayloads`). | Upgrade to Dexie v8 adding `planningFolders`, `planningTrails`, and `planningTrailPayloads` (isolated from `routes` so the active Routes menu stays fast and uncluttered). |
| **Map Display Policy** ([`RouteDisplayPolicy.ts`](../../src/core/navigation/RouteDisplayPolicy.ts)) | Controls when `routes` render on the map. | Add `planningPreviewTrailIds` (up to 25 trails) when the user clicks **"הצג תיקייה על המפה"** inside the Planning Trail DB. |
| **Cloud Sync** ([`PlannedTracksCloudService.ts`](../../src/core/firebase/PlannedTracksCloudService.ts)) | Syncs `users/{uid}/planned_tracks`. | Add incremental sync for `users/{uid}/planning_folders` and `users/{uid}/planning_trails` (plus lazy payload download). |

---

## 3. Data Model & Storage Architecture (Dexie v8)

Keeping `planningTrails` separate from `routes` guarantees zero regression to existing navigation/editing flows and allows independent scaling to **5,000+ archived trails**.

### 3.1 Difficulty & Category Types (`src/core/navigation/PlanningTrailTaxonomy.ts`)

```ts
export type TrailDifficulty = 'light' | 'medium' | 'hard' | 'extreme';

export const TRAIL_DIFFICULTY_META: Record<
  TrailDifficulty,
  { id: TrailDifficulty; labelHe: string; labelEn: string; color: string; badgeClass: string }
> = {
  light:   { id: 'light',   labelHe: 'קל',       labelEn: 'Light',   color: '#10b981', badgeClass: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  medium:  { id: 'medium',  labelHe: 'בינוני',   labelEn: 'Medium',  color: '#f59e0b', badgeClass: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  hard:    { id: 'hard',    labelHe: 'קשה',      labelEn: 'Hard',    color: '#ef4444', badgeClass: 'bg-red-500/15 text-red-400 border-red-500/30' },
  extreme: { id: 'extreme', labelHe: 'אקסטרים', labelEn: 'Extreme', color: '#a855f7', badgeClass: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
};

export type TrailCategoryId =
  | '4x4'
  | 'hiking'
  | 'bicycle'
  | 'family'
  | 'water'
  | 'overnight'
  | 'scenic'
  | 'custom';
```

### 3.2 Dexie v8 Tables ([`NavDatabase.ts`](../../src/core/db/NavDatabase.ts))

```ts
export interface PlanningFolderRecord {
  id: string;
  name: string;
  parentId: string | null;       // null = root folder
  pathIds: string[];             // ancestor IDs for fast recursive subtree queries
  color?: string;
  defaultCategoryId?: TrailCategoryId;
  defaultDifficulty?: TrailDifficulty;
  sortOrder: number;
  cloudSyncStatus?: CloudSyncStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningTrailRecord {
  id: string;
  name: string;
  folderId: string | null;       // null = "לא ממוין" (Unfiled)
  categoryId: TrailCategoryId;
  customCategoryLabel?: string;
  difficulty: TrailDifficulty;   // required: 'light' | 'medium' | 'hard' | 'extreme'
  planningMode?: PlanningMode;
  sourceFormat: 'gpx' | 'kml' | 'geojson' | 'drawn' | 'planned';
  distanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
  bounds?: [number, number, number, number];
  color: string;
  tags?: string[];
  isStarred?: boolean;
  notes?: string;
  sourceRouteId?: string | null; // optional back-link if sent from Active Routes
  hasFullPayload?: boolean;
  cloudSyncStatus?: CloudSyncStatus;
  cloudStoragePath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningTrailPayloadRecord {
  id: string; // matches PlanningTrailRecord.id
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: Array<{ distKm: number; ele: number; lon: number; lat: number }>;
  waypoints?: PlannedWaypoint[];
  gpxXml?: string;
  updatedAt: string;
}
```

**Dexie v8 Store Indexes**:
```ts
this.version(8).stores({
  // ...existing v7 tables untouched...
  planningFolders: 'id, parentId, sortOrder, cloudSyncStatus, updatedAt, *pathIds',
  planningTrails:
    'id, name, folderId, categoryId, difficulty, isStarred, cloudSyncStatus, updatedAt, *tags',
  planningTrailPayloads: 'id, updatedAt',
});
```

---

## 4. Core Services & Bidirectional Transfer

### 4.1 `PlanningTrailManager.ts` (`src/core/navigation/PlanningTrailManager.ts`)
- **Folder Tree Operations**:
  - `buildFolderTree(folders, trails)` with recursive trail counts & total km.
  - `createFolder({ name, parentId, color, defaultCategoryId, defaultDifficulty })`.
  - `renameFolder(folderId, name)` & `moveFolder(folderId, newParentId)` (with cycle prevention).
  - `deleteFolder(folderId, strategy: 'move-to-parent' | 'move-to-unfiled' | 'delete-trails')`.
- **Trail CRUD & Filtering**:
  - `listTrailSummaries()` (fast metadata load, `< 300ms` for 2,000+ trails).
  - `loadFullTrail(trailId)` (hydrates from `planningTrailPayloads` with bounded LRU cache).
  - `moveTrailsToFolder(trailIds, targetFolderId)`, `updateTrailMetadata(trailId, { categoryId, difficulty, tags, notes })`.
  - Bulk GPX/KML/GeoJSON import directly into a chosen folder + category + difficulty.

### 4.2 Bidirectional Transfer Bridge (`PlanningTrailBridge.ts`)
1. **`sendPlanningTrailToActiveRoutes(trailId)`**:
   - Loads `PlanningTrailRecord` + `PlanningTrailPayloadRecord` (hydrating from cloud if needed).
   - Creates a `SavedRouteRecord` + `RoutePayloadRecord` via `RouteManager` (preserving geometry, elevation profile, waypoints, and color).
   - Sets `activeRoute` to the new route and optionally switches to the **Routes** drawer so the user can immediately **Navigate** or **Edit Waypoints**.
2. **`sendActiveRouteToPlanningDb(routeId, options: { folderId, categoryId, difficulty, tags?, notes? })`**:
   - Loads `SavedRouteRecord` + `RoutePayloadRecord`.
   - Creates a `PlanningTrailRecord` + `PlanningTrailPayloadRecord` in the selected folder/subfolder with the chosen **Category** and **Difficulty** (`light` / `medium` / `hard` / `extreme`).
   - Marks `cloudSyncStatus: 'pending'` for background Firestore sync.

---

## 5. UI/UX Architecture

### 5.1 New Menu Entry: "מאגר תכנון" (Planning Trail DB)
- **Desktop**: Dedicated sidebar icon/button (`🗂️ מאגר תכנון`) next to `מסלולים` (`routes`), opening `PlanningTrailDbDrawer`.
- **Mobile**: Dedicated tab/button in the bottom navigation or top switcher (`מפה` | `מסלולים` | `מאגר תכנון` | `הקלטה` | `מפות`).

### 5.2 Inside `PlanningTrailDbDrawer`
- **Folder Tree (Desktop) / Drill-Down (Mobile)**:
  - Virtual Views: `כל המסלולים`, `מועדפים ⭐`, `לא ממוין`.
  - Nested User Folders & Subfolders with `+ תיקייה חדשה`, rename, move, delete.
  - Breadcrumbs + `"כלול תתי-תיקיות"` toggle + **"הצג תיקייה על המפה"** button.
- **Multi-Dimensional Filters**:
  - Search input (name, tags, notes).
  - **Category Chips**: `הכל`, `4x4`, `הליכה`, `אופניים`, `משפחתי`, `מים וגבים`, `לילה וחניון`, `תצפיות`.
  - **Difficulty Chips / Filter**: `הכל`, `קל (Light)`, `בינוני (Medium)`, `קשה (Hard)`, `אקסטרים (Extreme)`.
  - Sort: `עודכן לאחרונה`, `שם`, `מרחק`, `טיפוס`, `רמת קושי`.
- **Trail Card Actions**:
  - Color-coded **Category Badge** + **Difficulty Pill** (`קל` / `בינוני` / `קשה` / `אקסטרים`).
  - **"📤 שלח למסלולים"** (primary action: sends trail to the existing Routes menu for navigation/editing).
  - **"העבר / ערוך"** (change folder, category, or difficulty).
  - Star ⭐ & Delete.

### 5.3 Inside Existing `ElevationProfileDrawer` ("Old Menu Routes")
- Keeps all existing functionality (Select, Navigate, Edit Waypoints, GPX Export, Share, Color).
- Adds **"🗂️ שלח למאגר תכנון"** button on the active/selected route, opening a compact modal to choose **Folder / Subfolder** (with inline `+ תיקייה חדשה`), **Category**, and **Difficulty** (`קל`, `בינוני`, `קשה`, `אקסטרים`).

---

## 6. Cloud Sync & Firebase Security Rules

- **Firestore**:
  - `users/{uid}/planning_folders/{folderId}`
  - `users/{uid}/planning_trails/{trailId}` (metadata including `folderId`, `categoryId`, `difficulty`, `tags`, `isStarred`)
  - Heavy payloads stored in Firebase Storage (`planning_trails/{uid}/{trailId}.json`) and fetched lazily on demand.
- **Security Rules** ([`devops/firebase/firestore.rules`](../../devops/firebase/firestore.rules)):
  - Owner-only read/write (`request.auth.uid == uid`), strict schema validation for `difficulty in ['light', 'medium', 'hard', 'extreme']`, `categoryId`, `folderId`, and `pathIds` max depth.

---

## 7. Phased Implementation Roadmap

1. **Phase 1 — Dexie v8 & `PlanningTrailManager`**: `planningFolders`, `planningTrails`, `planningTrailPayloads`, `PlanningTrailTaxonomy`, tree/cycle/filter unit tests.
2. **Phase 2 — Bidirectional Bridge & Map Preview**: `PlanningTrailBridge` (`sendPlanningTrailToActiveRoutes`, `sendActiveRouteToPlanningDb`), `RouteDisplayPolicy` folder preview (25-trail cap), bulk GPX/KML folder importer.
3. **Phase 3 — UI Components**: `PlanningTrailDbDrawer` (Desktop split + Mobile drill-down), `SendToPlanningDbModal` inside `ElevationProfileDrawer`, and navigation wiring in `App.tsx`.
4. **Phase 4 — Cloud Sync & Rules**: `planning_folders` & `planning_trails` incremental watermark sync + Firestore rules & emulator tests.

> Interactive prototype: [`planning-trail-db-mockup.html`](./planning-trail-db-mockup.html)
