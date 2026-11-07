---
name: outdoor-map-navigation
description: >-
  Expert guide and architectural runbook for building cross-platform (Web, Android, iOS)
  outdoor map navigation applications using MapLibre GL JS, Protomaps PMTiles, and Capacitor.
  Use this skill when designing, implementing, or debugging vector/raster/terrain map rendering,
  online/offline PMTiles loading from web or local storage, offline assets (sprites, glyphs),
  GPS track recording, GPX/KML routing, or elevation/hillshade layers.
---

# Outdoor Map Navigation & Offline PMTiles Skill

This skill encapsulates architectural patterns and engineering best practices distilled from:
- **[IsraelHikingMap (Mapeak)](https://github.com/IsraelHikingMap/Site)**: Cross-platform SPA + Capacitor architecture, offline storage with IndexedDB/SQLite/Filesystem, Turf.js spatial analysis, custom hiking/MTB vector styles, contour & hillshade composition, and background geolocation.
- **[MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)**: Custom protocol registration (`addProtocol`), style mutation, 3D terrain (`raster-dem`), hillshading, sprites/glyphs self-hosting, and WebGL performance tuning.
- **[Protomaps PMTiles](https://github.com/protomaps/pmtiles)**: Single-file tile pyramids, HTTP `206 Partial Content` range requests, Hilbert curve spatial clustering, and custom `Source` (`getBytes`) adapters for local files on Web and Mobile.

---

## Core Architectural Principles

### 1. Unified Codebase (Web + Android + iOS)
- Build a single high-performance Web UI (TypeScript + React/Angular/Vue + Vite) and wrap it with **Ionic Capacitor** (`@capacitor/core`, `@capacitor/android`, `@capacitor/ios`).
- Abstract platform-specific capabilities (file system, geolocation, network status, wake lock) behind clean TypeScript service interfaces so the Web app uses Browser APIs (OPFS, File System Access API, `navigator.geolocation`) and Mobile uses Native Capacitor plugins.

### 2. Universal PMTiles Serving (`pmtiles://`)
Never rely on a traditional backend tile server when a single `.pmtiles` archive can serve vector, raster, or terrain tiles directly:
1. **Remote Web Mode (`FetchSource`)**: Fetches byte ranges (`Range: bytes=offset-end`) over HTTPS from static object storage (Cloudflare R2, AWS S3, CDN) with CORS enabled.
2. **Web Local Storage Mode (`FileSource` / OPFS)**: Reads `.pmtiles` files stored in the browser's Origin Private File System (OPFS) or selected via `<input type="file">` / File System Access API using `Blob.slice(offset, offset + length).arrayBuffer()`.
3. **Mobile Local Storage Mode (Android & iOS)**:
   - **Critical Pitfall**: Standard Android/iOS WebViews often fail or load the entire multi-GB file into memory when `fetch()` sends `Range` headers to `capacitor://` or `file://` URLs.
   - **Solution A (Custom `Source` via Native Random-Access File Read / Local HTTP Range Server)**: Implement the `pmtiles` `Source` interface (`getBytes(offset, length)`) backed by a native random-access file reader plugin or a lightweight native local HTTP range server (`127.0.0.1`), or configure Android `WebViewAssetLoader` / custom scheme handler to honour `Range` headers and respond with `HTTP 206 Partial Content`.
   - See [references/pmtiles-storage-architecture.md](./references/pmtiles-storage-architecture.md) and [examples/universal-pmtiles-source.ts](./examples/universal-pmtiles-source.ts).

### 3. True 100% Offline Capability
A `.pmtiles` file only contains tile data (`z/x/y`). MapLibre will still fail offline if any of the following require network access:
- **Style JSON**: Must be generated or rewritten dynamically on the client so source URLs point to the active `pmtiles://` key.
- **Glyphs (Fonts)**: Host PBF font ranges (`{fontstack}/{range}.pbf`) locally inside the app bundle (`/assets/fonts/...`) rather than pointing to `demotiles.maplibre.org` or `protomaps.github.io`.
- **Sprites (Icons/Shields)**: Bundle `sprite.json`, `sprite.png`, `sprite@2x.json`, and `sprite@2x.png` inside `/assets/sprites/`.

---

## Step-by-Step Workflows

### Workflow 1: Registering Hybrid Online/Offline PMTiles in MapLibre
1. Instantiate a single shared `Protocol` from `pmtiles` (`new Protocol({ metadata: true })`) and register it once via `maplibregl.addProtocol('pmtiles', protocol.tile)`.
2. For each `.pmtiles` archive (base vector map, contours, or DEM terrain):
   - Create the appropriate `Source` (`FetchSource` for remote URL, `FileSource` for Web `File`/`Blob`/OPFS, or `CapacitorFileSource` for Android/iOS local storage).
   - Wrap it in `new PMTiles(source)` and register it with `protocol.add(pmtilesInstance)`.
3. In the MapLibre Style Specification, reference the archive using `pmtiles://<source.getKey()>`.
4. Validate header integrity before mounting the layer by calling `await pmtilesInstance.getHeader()` and verifying `tileType`, `minZoom`, `maxZoom`, and bounding box (`minLon`, `minLat`, `maxLon`, `maxLat`).

### Workflow 2: Outdoor Topographic Layer Stack
Outdoor navigation requires more than standard street maps. Compose layers in this order (bottom to top):
1. `background` & landcover/landuse polygons (forests, scrub, rock, scree, glaciers).
2. **Hillshade / Shaded Relief (`hillshade` layer)**: Driven by a `raster-dem` PMTiles source (Terrarium or Mapbox DEM encoding).
3. **Waterways & Waterbodies**: Rivers, intermittent streams (`wadi`), springs/water sources (critical for hikers).
4. **Contour Lines (`line` & `symbol`)**: Major (every 50m/100m) and minor (every 10m/20m) elevation contours with elevation labels oriented along lines (`symbol-placement: line`).
5. **Trails, Tracks & Roads**: Differentiate 4x4 dirt roads, footpaths, via ferrata, MTB singletracks, and regional blazed hiking trails (using custom dash arrays and casing colors, as pioneered in `IsraelHikingMap/VectorMap`).
6. **Dynamic User Overlays**: Loaded GPX/GeoJSON routes, live recorded breadcrumb track, waypoints, and directional GPS puck.
- See [references/maplibre-outdoor-styling-and-navigation.md](./references/maplibre-outdoor-styling-and-navigation.md).

### Workflow 3: Offline Map Downloader & Storage Management
1. **Catalog Discovery**: Fetch a lightweight JSON manifest of regional `.pmtiles` packages (name, bounding box, version, size in bytes, SHA-256 / ETag, download URL).
2. **Download with Progress & Resume**:
   - On **Web**: Stream `fetch()` response body via `ReadableStream` into an OPFS file handle (`FileSystemWritableFileStream`), updating progress and supporting `Range` resume on interruption.
   - On **Android/iOS**: Use native background file transfer into `Directory.Data` (not `Directory.Cache`, which OS can evict when low on disk space).
3. **Metadata Registry**: Record installed archives in IndexedDB (`Dexie.js`) so the app immediately knows which regional maps are available offline at startup.

### Workflow 4: GPS Navigation, Track Recording & Spatial Math
1. Use `@turf/turf` (`pointToLineDistance`, `nearestPointOnLine`, `length`, `along`, `bearing`) for zero-latency client-side spatial calculations:
   - Off-route deviation warning when user location exceeds threshold (e.g. 50 meters) from active route.
   - Remaining distance and elevation gain/loss calculation by sampling DEM or route 3D coordinates.
2. On Android/iOS, use foreground service location tracking (`@capacitor-community/background-geolocation`) with screen wake-lock options so recording never drops when the phone is locked in a hiker's pocket.

### Workflow 5: Community POI Harvesting & Import (IsraelHikingMap / Off-Road / Amud Anan Pattern)
Base vector tiles (`Israel.osm.pmtiles`) often strip long text descriptions (`description:he`, `note`, `wikipedia` summaries) to keep tile sizes small. To provide rich clickable POIs (springs, cisterns, caves, ruins, 4x4 ascents/obstacles, night camps) 100% offline:
1. **Open Data Harvester (`scripts/fetch-israel-pois.mjs`)**:
   - Query the **Overpass API** + **Wikidata / Wikipedia API** for outdoor POIs across Israel (`natural=spring`, `natural=cave_entrance`, `historic=*`, `tourism=viewpoint`, `tourism=camp_site`, `mountain_pass`, `ford=yes`, `barrier=*`, `highway=path/track` hazards).
   - Extract multilingual names (`name:he`, `name:en`, `name`), descriptions (`description`, `description:he`, `note`), Wikipedia summaries, and water/4x4 attributes into a compact `data/Israel.pois.geojson` archive.
2. **Community Format Importer (`.gpx`, `.kml`, `.kmz`, `.geojson`, `.twl`)**:
   - Parse waypoints (`<wpt>` in GPX, `<Placemark>` in KML/KMZ from Amud Anan, Off-Road.io, and Israel Hiking Map) into `Dexie.js` IndexedDB so user-imported POI layers and field reports render offline alongside the base map.

---

## Reference Materials & Examples in this Skill
- [PMTiles Storage & Cross-Platform Architecture](./references/pmtiles-storage-architecture.md)
- [MapLibre Outdoor Styling, Terrain & Navigation Guide](./references/maplibre-outdoor-styling-and-navigation.md)
- [Universal PMTiles Source Reference Implementation](./examples/universal-pmtiles-source.ts)

