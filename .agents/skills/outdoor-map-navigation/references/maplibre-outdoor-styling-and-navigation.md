# MapLibre Outdoor Styling, Terrain & Navigation Reference

## 1. Offline-Ready MapLibre Style Specification
When building an outdoor navigation map that works equally well online and in airplane mode deep in the backcountry, construct the `StyleSpecification` programmatically in TypeScript rather than hardcoding static URLs:

```ts
import type { StyleSpecification } from 'maplibre-gl';

export interface OutdoorStyleOptions {
  baseTilesUrl: string;       // e.g. "pmtiles://israel-base" or "pmtiles://https://.../base.pmtiles"
  contoursTilesUrl?: string;  // e.g. "pmtiles://israel-contours"
  terrainDemUrl?: string;     // e.g. "pmtiles://israel-dem"
  glyphsUrl: string;          // e.g. "/assets/fonts/{fontstack}/{range}.pbf"
  spriteUrl: string;          // e.g. `${window.location.origin}/assets/sprites/outdoor`
  enable3DTerrain?: boolean;
}
```

### Critical Offline Asset Rules
- **`glyphs`**: MapLibre requires PBF-encoded signed distance field (SDF) font stacks (`0-255.pbf`, `256-511.pbf`, etc.). Bundle Noto Sans Regular/Bold (including Hebrew/Arabic/Latin ranges if supporting regions like IsraelHikingMap) in `public/assets/fonts/`.
- **`sprite`**: Bundle custom outdoor SVG icons compiled into sprite sheets (`spring`, `water_tap`, `campsite`, `viewpoint`, `peak`, `cave`, `parking`, `danger`, `trail_blaze`) in `public/assets/sprites/`.

---

## 2. Outdoor Cartography Best Practices (Learned from IsraelHikingMap)
1. **Trail Hierarchy & Blazes**:
   - Distinguish paved roads from 4WD dirt tracks (`highway=track`, `tracktype=grade1..grade5`) using dashed line patterns (`line-dasharray`) where the dash density reflects surface firmness.
   - Render hiking trails (`highway=path`, `highway=footway`, `sac_scale`) with high-contrast casings so trail color markings (blazes) remain legible over green forest or brown contour lines.
   - Render MTB singletracks (`imba`, `mtb:scale`) with dedicated directional arrows or distinct wave/dash styling.
2. **Topographic Contours & Hillshade**:
   - Add a `raster-dem` source (encoding: `"terrarium"` or `"mapbox"`).
   - Add a `hillshade` layer with `hillshade-exaggeration: 0.35` and `hillshade-illumination-direction: 315` below water and trails so relief shading enhances depth without obscuring text or paths.
   - Render minor contours (10m) starting at `minzoom: 13` with low opacity (`0.25`) and major index contours (50m / 100m) starting at `minzoom: 11` with `0.45` opacity and inline elevation labels (`{ele}m`).
3. **Critical Backcountry POIs**:
   - Prioritize water sources (`natural=spring`, `amenity=drinking_water`), shelters, campsites, peaks (`natural=peak` with elevation label), passes (`mountain_pass`), and nature reserve boundaries.

---

## 3. Client-Side DEM Elevation Sampling
When a `raster-dem` PMTiles source is loaded, you can query elevation completely offline in two ways:
1. **Via MapLibre Engine**: `map.queryTerrainElevation(lngLat, { exaggerated: false })` returns elevation in meters at any currently loaded viewport coordinate.
2. **Direct DEM Tile Decoding (Viewport-Independent)**: Fetch the `z/x/y` DEM tile directly from the `PMTiles` instance (`await demPmtiles.getZxy(z, x, y)`), decode the PNG pixel `(r, g, b)` at the fractional tile coordinate, and compute:
   - **Terrarium**: `elevation = (r * 256 + g + b / 256) - 32768`
   - **Mapbox Terrain-RGB**: `elevation = -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1)`
   This enables computing full **Elevation Profiles** for a planned route even at zoom levels or regions not currently rendered on screen!

---

## 4. GPX/KML Route Management & Real-Time Navigation
1. **Route Parsing**: Parse `.gpx`, `.kml`, and `.geojson` files into standard GeoJSON `FeatureCollection` objects stored in IndexedDB (`Dexie.js`).
2. **Interactive Elevation Profile**:
   - Resample route geometry every 25–50 meters using `@turf/along` and `@turf/length`.
   - Synchronize hover/touch on the elevation chart with a live marker on the MapLibre canvas.
3. **Active Navigation & Off-Route Detection**:
   - On each GPS fix (`Position`), compute `turf.nearestPointOnLine(routeLineString, currentUserPoint)`.
   - If distance > `offRouteThresholdMeters` (default `50m`), trigger a visual/haptic/audio off-route alert.
   - Compute distance remaining and remaining ascent (`totalAscentRemaining`) from the snapped vertex to the end of the route.

