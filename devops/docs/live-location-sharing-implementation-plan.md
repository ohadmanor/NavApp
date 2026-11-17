# Live Location Sharing — Implementation Plan

Real-time GPS location sharing for **NavApp**, enabling signed-in users to broadcast their live position either to **specific NavApp users** or **all signed-in NavApp users**, with configurable auto-expiry and on-map visibility controls.

---

## 1. Goals & Requirements

1. **Live Continuous Location Sharing**
   - Broadcast the user's real-time GPS position (`lon`, `lat`, `heading`, `speed`, `altitude`, `accuracy`) while sharing is active.
   - Reflect the user's chosen map icon and accent color from [`UserLocationIconService.ts`](../../src/core/navigation/UserLocationIconService.ts) so peers see the same vehicle/activity icon on their map.
2. **Two Sharing Audiences (+ Off)**
   - **Off (`off`)**: Private — no location data is published.
   - **Specific Users (`shared`)**: Share with selected NavApp users via the existing [`ShareRecipientsPicker.tsx`](../../src/components/sharing/ShareRecipientsPicker.tsx) and [`UserDirectoryService.ts`](../../src/core/firebase/UserDirectoryService.ts) (supporting both registered UIDs and pending Gmail addresses).
   - **All NavApp Users (`public`)**: Public broadcast visible to all signed-in NavApp users who have public peer visibility enabled.
3. **Duration & Auto-Expiry**
   - Selectable presets: **1 hour**, **4 hours**, **8 hours**, or **Until stopped** (`expiresAtMs: null`).
   - Automatic client-side stop when `expiresAtMs` is reached, plus expiry filtering on the viewer side.
4. **On-Map Visibility & Clutter Control**
   - Master toggle to show/hide other users' shared locations on the map (accessible from both the Location Sharing sheet and [`LayerSwitcherSheet.tsx`](../../src/components/map/LayerSwitcherSheet.tsx)).
   - Sub-filter to show **All visible (Shared + Public)** or **Shared with me only** so convoy/group riders can hide public users if desired.
5. **Offline-First & Quota-Conscious**
   - Throttled Firestore writes to avoid excessive battery drain and Firebase Spark-tier write quota usage.
   - Graceful pause when offline (`navigator.onLine === false`).

---

## 2. Architecture & Data Flow

```
LiveGpsService (GPS fix)
   │
   ▼
App.tsx (active sharing state + throttle)
   │
   ▼
LiveLocationCloudService.publishFix()
   │  (throttled Firestore setDoc)
   ▼
Firestore: /live_locations/{uid}
   │
   ├──► Query 1: sharedWithUids array-contains currentUser.uid
   ├──► Query 2: sharedWithEmails array-contains currentUser.emailLower
   └──► Query 3: visibility == 'public' (when public peers enabled)
   │
   ▼
LiveLocationCloudService.subscribeLiveLocations()
   │  (deduplicate, filter expired/self, 30s expiry sweep)
   ▼
MapLibre GL JS Markers + Peer Inspector Sheet
```

---

## 3. Firestore Data Model & Security Rules

### 3.1 Collection: `live_locations/{uid}`

One document per user, keyed by `uid`. Using a single mutable document per user (rather than an append-only history subcollection) keeps read/write counts flat and avoids unbounded storage growth.

```ts
export type LiveLocationVisibility = 'off' | 'shared' | 'public';

export interface LiveLocationRecord {
  uid: string;
  displayName: string;
  email: string | null;
  photoURL: string | null;
  visibility: LiveLocationVisibility;
  active: boolean;
  sharedWith: Array<{ uid: string | null; email: string; displayName: string | null; photoURL: string | null }>;
  sharedWithUids: string[];
  sharedWithEmails: string[]; // lowercased
  lon: number;
  lat: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  iconId: string;
  accentColor: string;
  startedAt: string;   // ISO timestamp
  updatedAt: string;   // ISO timestamp
  expiresAt: string | null;
  expiresAtMs: number | null; // epoch ms, or null for "until stopped"
}
```

### 3.2 Security Rules ([`firestore.rules`](../firebase/firestore.rules))

Add a `match /live_locations/{uid}` block with strict schema validation (`validLiveLocation(data, uid)`):

- **Read (`get`, `list`)**: `signedIn()` AND:
  - `resource.data.uid == request.auth.uid`, OR
  - `resource.data.active == true && resource.data.visibility == 'public'`, OR
  - `resource.data.active == true && resource.data.visibility == 'shared' && (request.auth.uid in resource.data.sharedWithUids || (request.auth.token.email != null && request.auth.token.email.lower() in resource.data.sharedWithEmails))`
  > **Note on Firestore `list` rules:** Queries must include `where('active', '==', true)` alongside `visibility == 'public'`, `sharedWithUids array-contains uid`, or `sharedWithEmails array-contains emailLower` so Firestore can statically prove every query satisfies the rule. Expiry (`expiresAtMs`) is enforced on the client (auto-stop by publisher + 30s sweep by viewer) to avoid `request.time` query-constraint rejections.
- **Create / Update**: `signedIn() && request.auth.uid == uid && validLiveLocation(request.resource.data, uid)`
  - Validate `uid == request.resource.data.uid`, `visibility in ['off', 'shared', 'public']`, `active is bool`, `lon` in `[-180, 180]`, `lat` in `[-90, 90]`, `sharedWith.size() <= 50`, `sharedWithUids.size() <= 50`, `sharedWithEmails.size() <= 50`, and `keys().hasOnly(...)` / `keys().hasAll(...)`.
- **Delete**: `signedIn() && request.auth.uid == uid`.

### 3.3 Composite Indexes ([`firestore.indexes.json`](../firebase/firestore.indexes.json))

Add composite indexes on `live_locations` if combining `active == true` with:
- `(active ASC, visibility ASC)`
- `(active ASC, sharedWithUids ARRAY_CONTAINS)`
- `(active ASC, sharedWithEmails ARRAY_CONTAINS)`

---

## 4. Core Service (`src/core/firebase/LiveLocationCloudService.ts`)

### 4.1 Publishing & Throttling
- **Start sharing (`startSharing`)**: Immediately writes `/live_locations/{uid}` with `active: true`, chosen `visibility`, `sharedWith*` arrays, `expiresAt`/`expiresAtMs`, current `LiveGpsFix`, and `UserLocationIconPreference`. Persists active session config to `localStorage` (`navapp.liveLocationShare.v1`) so a page reload within the expiry window seamlessly resumes sharing.
- **Publish GPS fix (`publishFix`)**:
  - Throttled: writes only if `(elapsed >= 8000ms)` OR `(elapsed >= 3000ms && distanceMoved >= 25m)`.
  - Skips if `navigator.onLine === false` or Firebase is unconfigured.
  - Checks `expiresAtMs`: if expired, automatically calls `stopSharing(uid)` and invokes an `onExpired` callback to update UI state.
- **Update settings (`updateSharingConfig`)**: Updates `visibility`, `sharedWith`, or `expiresAtMs` in place without losing the current fix.
- **Stop sharing (`stopSharing`)**: Writes `{ active: false, visibility: 'off', updatedAt }` (or deletes doc) and clears `localStorage` session config. Also called automatically on sign-out.

### 4.2 Subscribing & Filtering
- **`subscribeLiveLocations(currentUser, { includePublic }, onPeersChange, onError)`**:
  - Attaches `onSnapshot` listeners for:
    1. `where('active', '==', true), where('sharedWithUids', 'array-contains', currentUser.uid)`
    2. `where('active', '==', true), where('sharedWithEmails', 'array-contains', emailLower)` (when `currentUser.email` exists)
    3. `where('active', '==', true), where('visibility', '==', 'public')` (only when `includePublic` is `true`)
  - Merges and deduplicates results by `uid`, excluding `currentUser.uid`.
  - Filters out any record whose `expiresAtMs !== null && expiresAtMs <= Date.now()`.
  - Runs a 30-second interval sweep to evict newly expired peers even if no Firestore snapshot fires.

---

## 5. Map Rendering & Peer Interaction

### 5.1 Own Location Marker Indicator (Active Sharing)
- When the current user is actively sharing their location (`visibility !== 'off'`), render a **red frame/ring** around their own map location icon in [`UserLocationIconService.renderMarkerElement()`](../../src/core/navigation/UserLocationIconService.ts) (e.g. a crisp `#ef4444` / `red-500` outer ring with subtle pulse/glow) so it is immediately obvious on the map that live broadcasting is active.

### 5.2 Peer Map Markers (`src/core/navigation/LiveLocationMarkersManager.ts` or inside `src/App.tsx`)
- Render each visible peer as a MapLibre `Marker` keyed by `uid`:
  - Reuse [`UserLocationIconService.renderMarkerElement()`](../../src/core/navigation/UserLocationIconService.ts) with the peer's `iconId`, `accentColor`, `heading`, and `mapBearing`.
  - Add a compact, high-contrast name badge below the marker (`displayName`, plus a subtle green dot if updated within 60s or amber/dimmed styling if stale > 2 minutes).
  - Clicking a peer marker opens the **Peer Location Inspector**.

### 5.3 Peer Location Inspector Sheet (`src/components/sharing/PeerLocationInspector.tsx`)
- Displays:
  - Peer avatar / icon badge, `displayName`, and sharing scope badge (`משותף איתך` vs `ציבורי`).
  - Freshness (`עודכן לפני X שנ׳ / דק׳`), distance & bearing from current user, elevation, and speed (when > 0).
- Actions:
  - **מרכז מפה** — Fly/center map to peer's coordinates.
  - **נווט אליו** — Set peer's current coordinates as destination in [`RoutePlannerPanel.tsx`](../../src/components/navigation/RoutePlannerPanel.tsx).
  - **סגור** — Close inspector.

---

## 6. UI Components & Integration

### 6.1 Share Location Modal (`src/components/sharing/ShareLocationModal.tsx`)
- **Unauthenticated state**: Prompts Google Sign-In (`onSignInGoogle`), matching [`ShareRouteModal.tsx`](../../src/components/navigation/ShareRouteModal.tsx).
- **Audience selector** (3-way segmented control):
  - `כבוי (פרטי)`
  - `משתמשים נבחרים` — embeds [`ShareRecipientsPicker.tsx`](../../src/components/sharing/ShareRecipientsPicker.tsx)
  - `כל משתמשי NavApp` — shows a clear privacy note that all signed-in users can see your live position
- **Duration selector**:
  - `שעה` (1h) | `4 שעות` (4h) | `8 שעות` (8h) | `עד שאפסיק`
  - Live countdown badge when active + primary **הפסק שיתוף** button.
- **Map visibility section ("מיקומים על המפה")**:
  - Toggle: `הצג מיקומי משתמשים על המפה` (`showPeerLocations`)
  - Toggle: `כלול שיתופים ציבוריים (כלל המשתמשים)` (`showPublicPeerLocations`)
  - Compact list of currently active peers on the map with distance and click-to-center.

### 6.2 Map Controls & Layer Switcher Integration
- **Desktop & Mobile Action Buttons ([`App.tsx`](../../src/App.tsx))**:
  - Add a **Location Share** button near the GPS / Account buttons (`Radio` or `Users` icon):
    - Shows a pulsing red indicator/frame when actively broadcasting.
    - Shows a small count badge when peers are visible on the map.
  - Also reflect active sharing on the user's own **User Location Icon** button / map marker with the red frame.
- **Layer Switcher ([`LayerSwitcherSheet.tsx`](../../src/components/map/LayerSwitcherSheet.tsx))**:
  - Add a `peerLocations` toggle in the map layers section (and `OutdoorLayerVisibility` in [`israelOutdoorStyle.ts`](../../src/core/style/israelOutdoorStyle.ts) / [`UserStateSyncService.ts`](../../src/core/preferences/UserStateSyncService.ts)) so visibility preference persists across sessions.

---

## 7. Phased Rollout

| Phase | Scope | Key Files |
|---|---|---|
| **Phase 1: Backend & Rules** | Firestore rules, composite indexes, and rules unit tests | `devops/firebase/firestore.rules`, `devops/firebase/firestore.indexes.json`, `src/core/__tests__/liveLocations.rules.test.ts` |
| **Phase 2: Core Cloud Service** | `LiveLocationCloudService` (publish, throttle, expiry, subscribe) + unit tests | `src/core/firebase/LiveLocationCloudService.ts`, `src/core/__tests__/liveLocationCloudService.test.ts` |
| **Phase 3: UI & Map Integration** | `ShareLocationModal`, `PeerLocationInspector`, MapLibre markers, `App.tsx` buttons, `LayerSwitcherSheet` toggle | `src/components/sharing/ShareLocationModal.tsx`, `src/components/sharing/PeerLocationInspector.tsx`, `src/components/map/LayerSwitcherSheet.tsx`, `src/App.tsx` |
| **Phase 4: Verification** | Typecheck, Vitest unit tests, Firestore emulator rules tests, manual two-account E2E check | `npm run typecheck`, `npm test`, `npm run test:firestore-rules` |

---

## 8. Verification Plan

1. **TypeScript**: `npm run typecheck` passes with 0 errors.
2. **Unit Tests**: `npm test` — test `LiveLocationCloudService` throttling, distance threshold, auto-expiry, offline skip, and peer deduplication.
3. **Firestore Rules Tests**: `npm run test:firestore-rules` (and/or `vitest run src/core/__tests__/liveLocations.rules.test.ts`) verifying:
   - Owner can create/update/delete only their own `live_locations/{uid}`.
   - `shared` locations are readable only by `uid`s in `sharedWithUids` or `email`s in `sharedWithEmails`.
   - `public` locations are readable by any signed-in user, and rejected for unauthenticated users.
   - Invalid coordinates or oversized `sharedWith` arrays are rejected.
