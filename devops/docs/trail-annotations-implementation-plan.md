# Community Trail Annotations - Implementation Plan

## 1. Requirements and agreed scope

Allow users to select existing OSM highway ways, combine them into a trail, and
assign a color, trail number, and description.

- Everyone can view published annotations.
- Any signed-in user can create or edit them.
- Every published change records who edited the trail, when, and what changed.
- Selection covers a complete OSM way, not just the rendered tile fragment.
- Replacing the OSM PMTiles archive must not delete annotations or edit history.
- These are NavApp community annotations, not edits submitted to OpenStreetMap.
  They must not change routing permissions, road classification, or access rules.

## Current implementation note

User flow: signed-in users see a "סימון שבילים" toggle (hidden for anonymous
users). Turning it on opens nothing; it switches the map to segment-selection
mode. Clicking a highway segment (or an existing marked trail) opens the editor
prefilled with that segment's trail data — color, number, description — or an
empty form when the segment is not yet marked. The user can update the fields,
replace the color, add more segments, view history, or delete. Toggling the
button off leaves selection mode.

The first implementation now:

- Uses positive numeric `transportation` MVT feature IDs as `osm:way:<id>`,
  requires z14 nearby highway hits, and resolves clipped fragments through
  adjacent tiles before allowing publication. This follows the existing routing
  graph's tile-seam stitching mechanism. The Tilemaker producer/source extract is
  not present in the repository, so the MVT-ID-to-OSM-way provenance still needs
  validation against the source before treating IDs as a guaranteed release-wide
  identity contract.
- Stores each published revision's full-way geometry as an immutable, public-read
  Firebase Storage JSON object. Firestore contains compact trail metadata and a
  transactionally paired immutable history event; the PMTiles archive is never
  modified.
- Re-resolves saved way IDs against a newly mounted archive using the last saved
  geometry as a starting point. Missing or clipped ways remain visible as stale
  geometry rather than being silently attached elsewhere.
- Identifies a mounted release using its file name, metadata `createdUtc`, and
  byte size. This is a practical fallback, not a cryptographic archive checksum;
  add the immutable release manifest/checksum contract from section 3 to the
  producer pipeline before relying on it for automated long-term reconciliation.
- Limits public metadata refresh to the newest 200 annotations and history pages
  to 50 events. Scale-out spatial querying, map selection behavior on Android Auto,
  moderation, and offline publication are not part of this first implementation.

**Recommended MVP boundary:** offline viewing of downloaded annotations and
geometry; publishing requires an authenticated online connection. Offline form
changes may be saved as explicitly labeled local drafts, not published edits.
Offline publication queues, moderation workflows, and Android Auto annotation
rendering are separate follow-up work.

## 2. Current project foundations and critical prerequisite

Reuse the existing infrastructure:

| Foundation | Existing location | Intended integration |
| --- | --- | --- |
| Google login and auth subscription | [AuthService.ts](../src/core/firebase/AuthService.ts) | Gate editor entry and every save |
| Firebase client | [firebaseApp.ts](../src/core/firebase/firebaseApp.ts) | Public annotation reads; authenticated transactions |
| Dexie database, currently schema version 5 | [NavDatabase.ts](../src/core/db/NavDatabase.ts) | Add annotation, geometry-cache, and draft tables |
| PMTiles mount/update lifecycle | [PMTilesRegistry.ts](../src/core/pmtiles/PMTilesRegistry.ts) | Invalidate geometry resolution after archive changes |
| Trail colors from `colour` / `osmc_symbol` | [israelOutdoorStyle.ts](../src/core/style/israelOutdoorStyle.ts) | Keep base styling; add a separate community overlay |
| Tile decoding and clipping | [TileRoadGraphBuilder.ts](../src/core/routing/TileRoadGraphBuilder.ts) | Reuse decoding/coordinate helpers where appropriate |
| Map click handling and style reloads | [App.tsx](../src/App.tsx) | Add an explicit trail-edit mode without breaking POI selection or route planning |
| Firestore authorization | [firestore.rules](../firestore.rules) | Add narrow annotation/history matches; preserve existing route rules |

Local inspection of the current archive found `colour` and `osmc_symbol` in
the `transportation` metadata, but no explicit `osm_id` or OSM element-type field.
A sampled zoom-14 transportation tile contains numeric MVT feature IDs.
**This does not establish that those IDs are OSM way IDs or stable across builds.**
The routing decoder also generates tile-local `anon-{x}-{y}-{index}` IDs when an
ID is absent. Neither tile-local IDs nor routing edge IDs are durable identifiers.

**Release-blocking prerequisite:** establish the actual upstream map-generation
pipeline and verify its feature-ID semantics against its source OSM data.
The repository has consumers/style/search scripts, but those do not establish
the identity contract needed here. If identity is unavailable or ways are merged
without provenance, update the producer before enabling durable highway selection.

## 3. Persistence architecture: never edit the PMTiles file

Keep three independent data layers:

1. **Base map:** replaceable OSM PMTiles plus immutable DEM.
2. **Versioned highway identity/geometry index:** generated from the same OSM
   extract as each base-map release; maps stable OSM way IDs to full geometry.
3. **Community annotations:** authoritative metadata and history in Firestore,
   with a local Dexie cache for offline use.

```text
OSM extract -> PMTiles + highway geometry index + release manifest
                              |
Map selection -> stable OSM way IDs -> Firestore annotation + immutable event
                              |
                     Dexie cache -> GeoJSON overlay
```

Do not key annotations by PMTiles byte offsets, tile coordinates, array positions,
road names, geometry hashes, or generated MVT IDs. Use string keys such as
`osm:way:230594158`, with producer-verified provenance. A trail has its own
application-generated UUID and can reference multiple OSM ways.

### Required data-release contract

- Producer exports explicit OSM way provenance for selectable highway features.
  Selection uses full-detail data; do not require low-zoom generalized features
  to have a one-to-one identity.
- Publish a companion highway index with **full way geometry**, highway
  attributes, layer/bridge/tunnel metadata, bounds, and OSM identity.
  Generate it from the source OSM extract, not by assuming one clipped MVT
  feature contains a complete way.
- Partition the index into deterministic ID-based shards with a lookup manifest.
  Avoid downloading or keeping the entire country's geometry in memory.
- Publish a manifest containing release ID, OSM extract timestamp, schema version,
  PMTiles content checksum, companion-index checksum(s), and URLs.
- Prefer immutable versioned release URLs; a filename, file size, or mount
  timestamp is not a reliable data-version fingerprint.
- Existing/manual imports without compatible identity metadata remain usable
  as base maps, but the UI explicitly disables new durable trail selections.
  Previously downloaded annotations remain available with a stale/unresolved
  warning when their geometry cannot be validated against that archive.

## 4. Data model

### Firestore

Use a new namespace, separate from private planned routes:

```text
trail_annotations/{trailId}
trail_annotations/{trailId}/history/{revision}
```

Annotation document:

| Field | Purpose |
| --- | --- |
| `schemaVersion`, `id` | Versioned contract and stable trail UUID |
| `wayIds: string[]` | Deduplicated complete OSM way references |
| `color: string` | Validated value from the supported color palette |
| `number: string` | Trail identifier; string preserves `001`, `12A`, etc. |
| `description: string` | Plain-text user description, including Hebrew |
| `status: active / deleted` | Soft deletion preserves history |
| `revision: integer` | Optimistic-concurrency token |
| `createdByUid`, `createdAt` | Immutable creator identity and server timestamp |
| `updatedByUid`, `updatedAt` | Most recent authenticated editor and server timestamp |
| `selectionReleaseId` | Dataset against which membership was last explicitly confirmed |

Recommended initial validation limits: at least one and at most 500 unique way
IDs; number 1-32 characters; description at most 4,000 characters; a supported
color; known fields only. Show limits in the UI and enforce them in rules.
Bound serialized document size well below Firestore's 1 MiB limit. Revisit way
count limits using representative long trails before finalizing them.

Each history event contains `revision`, `operation` (`create`, `edit`, `delete`,
`restore`, or `rebind`), authenticated `actorUid`, server `occurredAt`, previous
and next editable snapshots, and an optional short edit reason. Display the
actual changed fields by comparing snapshots. A restore creates a new revision;
it never rewrites the original event.

Store geometry in versioned companion assets and the local geometry cache, not
as large nested coordinate arrays inside the metadata document. Locally retain
the last confirmed complete geometry so old annotations can still be shown when
a newer dataset cannot resolve their ways.

History is publicly readable under the agreed visibility model. Do not publish
Google emails, photos, or the existing private user-directory documents. The
immutable actor UID is the authoritative identity; a public display alias, if
added, must be separately consented and must not be treated as verified identity.
The MVP may display a shortened account identifier.

### Dexie

Add a new schema version while preserving all existing stores:

- `trailAnnotations`: cached published documents indexed by ID and update time.
- `trailGeometryCache`: geometry and resolution metadata keyed by release and way ID.
- `trailAnnotationDrafts`: drafts scoped to the originating authenticated UID.

Keep sync/resolution states local, separate from published editable fields.
Do not purge these stores during archive replacement or map-cache cleanup.
Local cache loss must not delete the authoritative Firestore data.

## 5. Authentication, trustworthy history, and concurrent editing

Prefer the existing client + Firestore architecture for the MVP; no new backend
is necessary **provided the transaction/rules invariants are proven in tests**.

1. Enable editing only after auth initialization confirms a signed-in user.
   Visitors see details/history and a sign-in action, not an editable form.
2. Recheck auth immediately before publishing. Logout, expired credentials,
   missing Firebase configuration, or denied writes show explicit errors.
3. Publish with a Firestore transaction that reads the current document and
   atomically writes the next annotation revision and its history event.
4. The form carries its original revision. If another user has edited it,
   reject the stale submission and offer reload/compare; do not silently overwrite.
5. Rules allow public reads only in the new namespace and require non-null
   authentication for publication. Never broaden private route/user access.
6. Rules validate field types/limits, actor UID equals `request.auth.uid`,
   timestamps equal `request.time`, immutable creator fields, and exactly one
   revision increment. The history document ID must match that revision.
7. Use `getAfter()` checks on **both** document paths: an annotation change must
   have its matching new history event, and an event must match an actual
   annotation transition. Check its before/after snapshots against old/new
   documents. Deny fabricated history, missing history, event-only writes,
   history updates/deletes, and hard deletion of annotations.
8. Ensure transactions, valid retries, and create/delete/restore transitions
   satisfy those rules within Firestore rule-access limits.

Do not copy private-route last-write-wins sync behavior into this shared editor.
Firestore transactions cannot publish offline. Cache local drafts with explicit
pending status; never report a draft as a committed edit. On account changes,
stop authenticated listeners and do not submit one user's draft as another user.
Public annotation reads can continue while signed out.

This protects history against ordinary clients, not privileged Admin SDK access.
Restrict administrative access and enable appropriate Firestore backup/export
retention. App Check and abuse monitoring are recommended hardening for public
community editing, not substitutes for authentication or rules.

## 6. Selection and editor UX

### Selection

- Add an explicit "Edit trail tags" mode, mutually exclusive with route planning.
- Resolve a tap/click against nearby full-detail highway geometry and present
  candidates when ways overlap. Preserve `layer`/bridge/tunnel distinctions.
- Use rendered-feature queries only as a hit-test accelerator, not as the
  authority for full-way identity or geometry.
- Fetch the selected way's complete geometry from the companion index and
  highlight it. Support add/remove of additional complete ways, undo, and clear.
- Never infer trail membership by equal names/colors or by proximity alone.
- A failed/missing identity lookup shows an explanation and blocks saving that
  selection; it must not silently annotate a tile fragment.

### Editor and trail details

- Desktop drawer / mobile bottom sheet using the existing map UI conventions.
- Color swatches with labels, trail-number input, multiline description,
  selection summary, optional edit reason, Save and Cancel.
- Hebrew/RTL support consistent with the app; render descriptions as text,
  not raw HTML.
- Trail details show number, description, last editor/time, and paginated history.
- Signed-in users can open an existing annotation and change its fields or
  selected ways. Preserve draft contents when publication fails.
- Separate "clear my selection" from "delete community annotation".
  Soft deletion requires confirmation and a logged revision.

## 7. Rendering and synchronization

Create a dedicated GeoJSON source and line/number-label layers for community
annotations. Keep OSM colors untouched underneath, and retain routing/selection/
navigation overlays above the community layer as appropriate.

- Build overlay geometry from resolved way memberships, not from the number.
- Apply a visible casing so colors remain legible in day/dark themes.
- Recreate the source/layers and repopulate data after style reload or archive
  replacement. Include a community-overlay visibility toggle.
- Publish completion updates Dexie and the overlay only after server confirmation.
  Public reads refresh published metadata; distinguish cached results from
  server-confirmed results.
- Start with bounded, paginated metadata reads and locally cached visible geometry;
  do not attach an unbounded listener to the entire history collection.
  Define and test a spatial metadata index if community size makes full metadata
  refresh too expensive.
- Fetch history only when the user opens it.
- Multiple trails may share a way. Proposed MVP display: show the most recently
  updated active annotation's stroke/number (trail ID as a deterministic tie-break)
  and list all memberships in details. Confirm this UX before implementation;
  never discard overlapping annotations from storage.

## 8. Preserving information during PMTiles updates

**The metadata and history survive because they are not stored in PMTiles.**
That alone does not guarantee that a changed/deleted OSM way still resolves.

On startup and every OSM archive update:

1. Validate the release manifest and companion-index compatibility.
2. Key all geometry caches by the verified release fingerprint and invalidate
   in-flight work from the previous release. Ignore late old-release responses.
3. Resolve referenced stable way IDs against the new index, lazily by viewport
   with a resumable background pass over locally cached annotations.
4. For an unchanged way ID, refresh its full geometry and display the annotation
   on the current way; keep the previous confirmed snapshot locally.
5. A moved/edited way with the same ID can use current geometry, but flag material
   movement/topology changes for review. Calibrate a proposed 20 m displacement
   threshold against fixtures; persist the algorithm version and tested metrics.
6. For missing/deleted ways, splits, merges, ambiguous provenance, or an
   incompatible archive, retain metadata/history and last-confirmed geometry.
   Mark the affected member unresolved or needing review; do not attach its
   annotation automatically to the nearest replacement road.
7. Display unresolved geometry with a distinct stale style and exclude it from
   authoritative current-way highlighting. Missing geometry without a cached
   snapshot still appears in the trail list, with a clear unavailable warning.
8. An authenticated user can confirm replacement way membership. Publish that
   as a normal `rebind` revision, retaining previous IDs in history.
9. Archive-derived cache refreshes are not user edits and must not fabricate
   history entries or mutate community metadata in the background.

Manual file replacement, background downloads, and startup discovery must all
run this compatibility path. A failed companion-index download must not break
the base map or erase the last working annotation cache.

## 9. Implementation phases and dependencies

| Phase | Work | Exit criteria |
| --- | --- | --- |
| 1. Identity contract | Locate producer; verify IDs; export full-way index and immutable manifests | Same OSM way resolves across two real releases; full geometry spans tile boundaries |
| 2. Persistence and authorization | Typed records, Dexie migration, cloud transaction service, rules, emulator tests | Anonymous writes denied; each successful change has exactly one immutable, correct event |
| 3. Selection and form | Explicit edit mode, complete-way multi-selection, color/number/description UI | Signed-in user creates/edits a multi-way trail without interfering with POIs/planning |
| 4. Overlay and public reads | GeoJSON source, labels, details/history, offline cache | Visitor can view; style/theme reload preserves annotations |
| 5. Update reconciliation | Release-keyed caches, stale states, manual rebind | Replacement archive preserves all metadata/history and resolves or visibly flags every cached member |
| 6. Release verification | Web/PWA and Capacitor phone checks; deploy new rules before enabling editor | Acceptance matrix below passes; existing route/auth/map behavior is unchanged |

Phase 1 is required for durable selection and update reconciliation. Phase 2
can proceed independently once the model is agreed. Phase 3 depends on phases
1 and 2; phase 4 depends on their read/model contracts; phase 5 depends on
phases 1 and 4; release verification depends on all preceding phases.

Suggested focused modules under `src/core/trails/`: identity/index access,
annotation model/service, overlay construction, and release reconciliation.
Add a dedicated cloud service under `src/core/firebase/` and editor/details
components under `src/components/map/`. Keep `App.tsx` changes limited to wiring,
mode arbitration, auth state, and lifecycle hooks.

No PMTiles rewriting and no changes to the routing graph's behavior are needed.
Update [docs/README.md](./README.md), the archive-update documentation, and any
directly affected deployment steps when implementing the feature.

## 10. Verification and acceptance criteria

Use existing Vitest tooling for focused model/geometry/service tests. Add
Firebase Emulator Suite rule tests when implementing phase 2: emulator/testing
dependencies and configuration are justified because this new write/audit
contract must be tested against actual rules, not just mocked client calls.

- **Access:** visitors can read annotations/history but cannot create, edit,
  delete, restore, or inject events through direct Firestore requests.
- **Audit integrity:** reject forged actors/timestamps, missing/mismatched events,
  revision jumps, event-only writes, modified creator fields, and history deletion.
  Test permitted create/edit/delete/restore/rebind paths too.
- **Concurrency:** two editors at the same revision cannot silently overwrite
  each other; transaction retry does not duplicate events.
- **Input:** preserve leading-zero/alphanumeric numbers and Hebrew descriptions;
  reject unsupported colors, oversized input, empty membership, and bad IDs.
- **Geometry:** a selected way crossing multiple tile boundaries is highlighted
  completely; repeated fragments deduplicate; overlapping bridge/tunnel candidates
  are not silently conflated.
- **Updates:** unchanged IDs, moved geometry, split/merged/deleted ways,
  missing/incompatible sidecars, and late prior-release responses never lose
  annotations/history or incorrectly reattach them.
- **Offline/auth:** cached data remains readable; offline/expired-auth publication
  is visibly uncommitted; switching accounts cannot publish another UID's draft.
- **Regression:** PMTiles import/download, DEM, base trail colors, POI clicks,
  route planning, private-route rules, theme/style reload, and navigation work
  as before.
- **Performance:** measure full-way lookup and overlay refresh using the
  supported phone and a dense viewport fixture; establish explicit latency and
  memory budgets before rollout rather than claiming acceptable performance
  from small desktop samples.

During implementation run focused tests, `npx tsc --noEmit`, and `npm run build`.
For this documentation-only plan, no application build or tests are required.

## 11. Decisions and follow-up

- The initial color palette is seven named colors; the trail number is a required
  string, and the description is optional.
- Overlapping trails remain separate records; the current map renderer overlays
  all memberships and uses annotation update order for drawing priority.
- Public history displays a shortened UID only; account emails and photos are not
  published.
- Verify the Tilemaker identity contract and replace the fallback release identity
  with an immutable producer manifest/checksum before relying on IDs across
  releases.
- Future moderation and offline publishing remain out of scope unless requested.

The key guarantee is **durable community metadata and audit history independent
of the map archive**, with explicit review when the underlying OSM identity changes.
