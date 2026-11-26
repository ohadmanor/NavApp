# NavApp — Navigation Recordings, Debriefing & Map Update Implementation Plan

## 1. Goals & User Requirements

1. **Signed-in User Isolation & Intentional Stop-and-Prompt Save**:
   - Track recording and saving navigation recordings are available **only to signed-in Google users** (`currentUser`), isolated strictly per `ownerUid`.
   - Recordings are **only saved when the user stops recording or stops navigating**, and the app always **asks the user to name the recording** (plus optional debriefing notes and optional immediate GPX export) before persisting.
2. **Dedicated User Recordings Library (`הקלטות ניווט`)**:
   - Every signed-in user has a dedicated **Navigation Recordings** view accessible from the `מסלולים` menu on Desktop (`desktopDrawer === 'recordings'`) and inside the `מסלולים` tab strip on Mobile (`mobileTab === 'recordings'`), plus a shortcut from `TrackRecorderPanel`.
   - Lists the user's own recordings (`ההקלטות שלי`) and recordings shared with them (`שותפו איתי`), with search, sort, date/time, duration, distance, ascent, average speed, cloud sync status, and direct GPX file loading (`טען קובץ GPX`).
3. **Debriefing, Map Updating, In-App Sharing & GPX File Export**:
   - Selecting any recording displays it on the map with an interactive elevation/grade profile (`ElevationChart`), start/end timestamps, duration, average speed, nearby POIs, and editable debriefing notes.
   - **Map Update Workflow**: Users can pin a recording in the background (`השאר במפה`) or click **עדכן מפה מההקלטה** to pin the GPS trace and jump straight into Community Road / Trail editing on top of their recorded track.
   - **In-App Sharing**: Uses `ShareRouteModal` + `PlannedTracksCloudService` (`planing_tracks/{uid}/routes/{id}`) so signed-in users can share recordings by NavApp name or Gmail address with real-time delivery and read-only protection (`שמור עותק אצלי`).
   - **GPX File Export (`GpxExportService`)**: Generates GPX 1.1 with per-point `<ele>` and `<time>` tags, uses a human-readable filename, downloads cleanly on Web, and writes to `Documents/NavApp-Recordings/` via `@capacitor/filesystem` on Android/iOS while informing the user of the exact saved file name and location.

---

## 2. Key Files

| Area | File | Role |
| :--- | :--- | :--- |
| Data schema | [`../../src/core/db/NavDatabase.ts`](../../src/core/db/NavDatabase.ts) | `RecordingTelemetryMeta`, `'recorded'` `sourceFormat`, `recordingPointTimestamps` in `routePayloads` |
| Route persistence & GPX | [`../../src/core/navigation/RouteManager.ts`](../../src/core/navigation/RouteManager.ts) | `isRecordedRoute`, `createAndSaveRecordedRoute`, GPX 1.1 `<time>` export, notes update |
| Cross-platform GPX export | [`../../src/core/navigation/GpxExportService.ts`](../../src/core/navigation/GpxExportService.ts) | Readable filename sanitization, Web download & `@capacitor/filesystem` save |
| Shared telemetry helpers | [`../../src/core/navigation/routeTelemetryHelpers.ts`](../../src/core/navigation/routeTelemetryHelpers.ts) | Shared POI/waypoint matching along route |
| Cloud sync & sharing | [`../../src/core/firebase/PlannedTracksCloudService.ts`](../../src/core/firebase/PlannedTracksCloudService.ts) | Auto-sync `'recorded'`/`'drawn'` routes & sharing metadata across devices |
| GPX `<time>` re-import | [`../../src/core/pois/CommunityPoiImporter.ts`](../../src/core/pois/CommunityPoiImporter.ts) | Extracts `<trkpt><time>` timestamps and `<type>recorded</type>` |
| Save prompt modal | [`../../src/components/navigation/SaveRecordingModal.tsx`](../../src/components/navigation/SaveRecordingModal.tsx) | Prompts user to name recording & add notes on Stop Recording / Stop Navigation |
| Recordings library UI | [`../../src/components/navigation/NavigationRecordingsPanel.tsx`](../../src/components/navigation/NavigationRecordingsPanel.tsx) | Per-user recordings debrief, share, GPX export, GPX load, and map-update flow |
| Shared chart component | [`../../src/components/navigation/ElevationChart.tsx`](../../src/components/navigation/ElevationChart.tsx) | Shared interactive SVG elevation profile chart |
| App wiring | [`../../src/App.tsx`](../../src/App.tsx) | Signed-in guard, per-point timestamps/elevations capture, modal & drawer/tab wiring |
