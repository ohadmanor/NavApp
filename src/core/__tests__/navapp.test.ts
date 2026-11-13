import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import maplibregl from 'maplibre-gl';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  PMTilesSearchService,
} from '../search/PMTilesSearchService';
import {
  extractRawRecordsFromVectorTile,
  getPmtilesArchiveFingerprint,
  normalizeSearchText,
  parseSearchIndexBytes,
  SearchIndexBuilder,
  serializeSearchIndexPayload,
} from '../search/pmtilesSearchCore.js';
import { db, type PoiRecord, type SavedRouteRecord } from '../db/NavDatabase';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  buildPoiLayerFilter,
  DEFAULT_LAYER_VISIBILITY,
  GOOGLE_SATELLITE_LAYER_ID,
  GOOGLE_SATELLITE_SOURCE_ID,
  GOOGLE_SATELLITE_TILE_URL,
  HIGHWAY_LAYER_IDS,
  NON_HIGHWAY_TRANSPORTATION_LAYER_IDS,
  POI_STYLE_LAYER_IDS,
  isHighwayStyleLayerId,
  isPoiStyleLayerId,
  countActivePoiCategories,
  isMasterPoiActive,
  toggleMasterPoiVisibility,
  togglePoiCategoryVisibility,
  enableAllPoiVisibility,
} from '../style/israelOutdoorStyle';
import { PoiManager, getPoiSortPriority } from '../pois/PoiManager';
import {
  convertLineToVisualOrder,
  processBidirectionalText,
  processStyledBidirectionalText,
  sanitizeToHebrewOrEnglish,
  applyArabicShaping,
} from '../style/hebrewBidiProcessor';
import { NativeSliceSource } from '../pmtiles/NativeSliceSource';
import { CachedFetchSource } from '../pmtiles/CachedFetchSource';
import { OpfsStorageAdapter } from '../pmtiles/OpfsStorageAdapter';
import {
  PMTilesRegistry,
  getEmptyTerrariumTileBlob,
  wrapManagerWithSafeContourBuffers,
} from '../pmtiles/PMTilesRegistry';
import { Capacitor } from '@capacitor/core';
import { RouteManager } from '../navigation/RouteManager';
import {
  LiveGpsService,
  normalizeGpsPosition,
  type LiveGpsFix,
} from '../navigation/LiveGpsService';
import { ScreenWakeLockService } from '../navigation/ScreenWakeLockService';
import {
  BUILT_IN_USER_ICONS,
  UserLocationIconService,
  sanitizeSvgMarkup,
} from '../navigation/UserLocationIconService';
import {
  NavigationHeadingService,
  DEFAULT_NAV_ORIENTATION,
  computeBearingBetweenCoords,
  computeScreenRotationDeg,
  extractRouteTangentHeading,
  shortestAngleDeltaDeg,
  smoothHeadingDeg,
} from '../navigation/NavigationHeadingService';
import { MilitaryGridService } from '../navigation/MilitaryGridService';
import { getSurfaceTheme, POI_CATEGORY_META } from '../../components/ui/themeTokens';
import { formatDuration } from '../../components/navigation/TrackRecorderPanel';

describe('NavApp Military 1:50k Topographic, 10m Contours & Hebrew RTL Engine Verification', () => {
  it('builds the authentic 247-layer Israel Hiking Map (IHM) StyleSpecification with sprites, zoom stops, road shields, 4x4 grades, and 10m/50m contours', () => {
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, terrain3d: true },
      theme: 'topo-day',
    });

    expect(style.version).toBe(8);
    expect(style.sprite).toContain('/assets/sprites/sprite');
    expect(style.glyphs).toBeUndefined();
    expect(style.sources['israel-osm']).toBeDefined();
    expect(style.sources['israel-dem']).toBeDefined();
    expect(style.sources['israel-contours']).toBeDefined();
    expect(style.terrain?.source).toBe('israel-dem');
    expect(style.layers.length).toBeGreaterThanOrEqual(240);

    const layerIds = style.layers.map((l) => l.id);
    expect(layerIds).toContain('Terrain');
    expect(layerIds).toContain('contour-line-casing');
    expect(layerIds).toContain('contour-line');
    expect(layerIds).toContain('contour-label');
    expect(layerIds).toContain('contour-label-10m');
    expect(layerIds).toContain('area-military');
    expect(layerIds).toContain('boundary-military');
    expect(layerIds).toContain('area-park');
    expect(layerIds).toContain('boundary-park-casing');
    expect(layerIds).toContain('boundary-park');
    expect(layerIds).toContain('name-park');
    expect(layerIds).toContain('track-right-grade5');
    expect(layerIds).toContain('track-left-grade5');
    expect(layerIds).toContain('shield-motorway');
    expect(layerIds).toContain('shield-trunk');
    expect(layerIds).toContain('shield-primary');
    expect(layerIds).toContain('shield-secondary');
    expect(layerIds).toContain('name-peak');
    expect(layerIds).toContain('name-water-point');
    expect(layerIds).toContain('icon-viewpoint');
    expect(layerIds).toContain('icon-cave');
    expect(layerIds).toContain('icon-ruins');
    expect(layerIds).toContain('icon-camp_site');
    expect(layerIds).toContain('place-city');
    expect(layerIds).toContain('place-town');
    expect(layerIds).toContain('place-village');

    // Verify no point symbol layers allow icon overlap (prevents mixing symbols on top of each other)
    const pointOverlapLayers = style.layers.filter(
      (l: any) =>
        l.type === 'symbol' &&
        l.layout?.['symbol-placement'] !== 'line' &&
        l.layout?.['symbol-placement'] !== 'line-center' &&
        l.layout?.['icon-allow-overlap'] === true
    );
    expect(pointOverlapLayers).toEqual([]);

    // Run MapLibre GL JS v5's internal validateStyleMin on the generated style
    const code = fs.readFileSync('node_modules/maplibre-gl/dist/maplibre-gl.js', 'utf8');
    const sharedStart = code.indexOf('define("shared"');
    const workerStart = code.indexOf('define("worker"');
    const sharedExports: any = {};
    vm.runInNewContext(code.slice(sharedStart, workerStart), {
      console,
      setTimeout,
      clearTimeout,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Int8Array,
      Int16Array,
      Int32Array,
      Float32Array,
      Float64Array,
      ArrayBuffer,
      DataView,
      TextDecoder,
      performance,
      Math,
      Object,
      Array,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      Map,
      Set,
      WeakMap,
      Symbol,
      Promise,
      JSON,
      define: (_n: string, _d: string[], factory: any) => factory(sharedExports),
    });

    const validationErrors = sharedExports.F(style);
    expect(validationErrors).toEqual([]);
  });

  it('builds pure PMTiles-only style pointing to Firebase streaming by default when local PMTiles are not yet mounted', () => {
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: null,
      demProtocolUrl: null,
      contourProtocolUrl: null,
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    expect(style.version).toBe(8);
    // Sources strictly come from OSM PMTiles and DEM PMTiles — NO external trail GeoJSON or raster sources!
    expect(style.sources['israel-osm']).toBeDefined();
    expect((style.sources['israel-osm'] as any).url).toContain('Israel.osm.pmtiles');
    expect(style.sources['israel-dem']).toBeDefined();
    expect((style.sources['israel-dem'] as any).url).toContain('Israel.dem.pmtiles');
    expect(style.sources['israel-trails']).toBeUndefined();
    expect((style.sources as any)['osm-online-raster']).toBeUndefined();

    // Contains authentic IHM vector layers wired directly to transportation / transportation_name
    const layerIds = style.layers.map((l) => l.id);
    expect(layerIds).toContain('background');
    expect(layerIds).toContain('Terrain');
    expect(layerIds).toContain('trail-israel-secondary-');
    expect(layerIds).toContain('trail-line-road');
    expect(layerIds).toContain('trail-line-path');
    expect(layerIds).toContain('casing-marked-path');
    expect(layerIds).toContain('path-path');
    expect(layerIds).toContain('track-right');
    expect(layerIds).toContain('track-left');
    expect(layerIds).toContain('name-trail-local');
    expect(layerIds.some((id) => id.startsWith('ihm-marked-'))).toBe(false);
    expect(layerIds).not.toContain('osm-online-raster-layer');

    // Run MapLibre GL JS validator on the immediate fallback style
    const code = fs.readFileSync('node_modules/maplibre-gl/dist/maplibre-gl.js', 'utf8');
    const sharedStart = code.indexOf('define("shared"');
    const workerStart = code.indexOf('define("worker"');
    const sharedExports: any = {};
    vm.runInNewContext(code.slice(sharedStart, workerStart), {
      console,
      setTimeout,
      clearTimeout,
      Uint8Array,
      Uint16Array,
      Uint32Array,
      Int8Array,
      Int16Array,
      Int32Array,
      Float32Array,
      Float64Array,
      ArrayBuffer,
      DataView,
      TextDecoder,
      performance,
      Math,
      Object,
      Array,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      Map,
      Set,
      WeakMap,
      Symbol,
      Promise,
      JSON,
      define: (_n: string, _d: string[], factory: any) => factory(sharedExports),
    });

    const validationErrors = sharedExports.F(style);
    expect(validationErrors).toEqual([]);
  });

  it('accurately processes Hebrew, mixed LTR numbers, and parentheses into visual RTL order', () => {
    // 1. Single Hebrew word: "ירושלים" -> "םילשורי"
    expect(convertLineToVisualOrder('ירושלים').text).toBe('םילשורי');

    // 2. Multi-word Hebrew phrase: "מבשרת ציון" -> "ןויצ תרשבמ"
    expect(convertLineToVisualOrder('מבשרת ציון').text).toBe('ןויצ תרשבמ');

    // 3. Hebrew with embedded LTR 4x4 and mirrored parentheses: "מעלה זיק (4x4)" -> "(4x4) קיז הלעמ"
    expect(convertLineToVisualOrder('מעלה זיק (4x4)').text).toBe('(4x4) קיז הלעמ');

    // 4. Mountain peak with triangle and elevation in meters: "▲ הר מירון 1204m" -> "1204m ןורימ רה ▲"
    expect(convertLineToVisualOrder('▲ הר מירון 1204m').text).toBe('1204m ןורימ רה ▲');

    // 5. Pure LTR contour label remains unchanged: "450m" -> "450m"
    expect(convertLineToVisualOrder('450m').text).toBe('450m');

    // 6. Multi-line splitting and styled BiDi processing
    const lines = processBidirectionalText('עין עקב תחתון', [8]);
    expect(lines).toEqual(['בקע ןיע', 'ןותחת']);

    const styled = processStyledBidirectionalText('הר 90', [1, 1, 0, 2, 2], []);
    expect(styled[0][0]).toBe('90 רה');
    expect(styled[0][1]).toEqual([2, 2, 0, 1, 1]);

    // 7. Strict Hebrew-first / English-fallback filtering (no Arabic or foreign scripts)
    expect(sanitizeToHebrewOrEnglish('ירושלים / القدس / Jerusalem')).toBe('ירושלים');
    expect(
      sanitizeToHebrewOrEnglish('مجلس إقليمي واحة الصحراء\u200B|||Neve Midbar Regional Council')
    ).toBe('Neve Midbar Regional Council');
    expect(sanitizeToHebrewOrEnglish('Wadi Rum / وادي رم')).toBe('Wadi Rum');
    expect(applyArabicShaping('البقار')).toBe('');
    expect(applyArabicShaping('عبدة')).toBe('');
  });

  it('computes accurate ITM (New Israeli Grid), 8-digit IDF Grid, and UTM Zone 36N coordinates', () => {
    const coords = MilitaryGridService.toMilitaryCoords(35.2137, 31.7683);
    expect(coords.itmEasting).toBeGreaterThan(219000);
    expect(coords.itmEasting).toBeLessThan(222000);
    expect(coords.itmNorthing).toBeGreaterThan(629000);
    expect(coords.itmNorthing).toBeLessThan(632000);
    expect(coords.idfGrid8Digit).toMatch(/^\d{4}-\d{4}$/);
    expect(coords.utmZone).toBe('36R');

    const gridGeoJson = MilitaryGridService.buildTacticalGridGeoJSON(34.75, 30.8, 34.85, 30.9, 13);
    expect(gridGeoJson.features.length).toBeGreaterThan(10);
  });

  it('NativeSliceSource slices exact byte ranges without full-file load', async () => {
    const mockBytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const source = new NativeSliceSource('test-local-pmtiles', async (offset, length) => {
      return mockBytes.slice(offset, offset + length).buffer;
    });

    expect(source.getKey()).toBe('test-local-pmtiles');
    const res = await source.getBytes(2, 4);
    expect(Array.from(new Uint8Array(res.data))).toEqual([30, 40, 50, 60]);
  });

  it('detects on-route vs off-route deviation using Turf.js and exports valid GPX', () => {
    const mockRoute = {
      id: 'test-ein-aqev',
      name: 'Ein Aqev Trail',
      sourceFormat: 'gpx' as const,
      distanceKm: 2.5,
      ascentMeters: 120,
      descentMeters: 80,
      minEle: 380,
      maxEle: 500,
      color: '#10b981',
      visible: true,
      createdAt: new Date().toISOString(),
      geojson: {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            properties: {},
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [34.81, 30.83],
                [34.82, 30.83],
              ],
            },
          },
        ],
      },
      elevationProfile: [
        { distKm: 0, ele: 390, lon: 34.81, lat: 30.83 },
        { distKm: 1, ele: 420, lon: 34.82, lat: 30.83 },
      ],
    };

    const onTrail = RouteManager.checkNavigationDeviation(mockRoute, 34.815, 30.83005);
    expect(onTrail.isOffRoute).toBe(false);

    const offTrail = RouteManager.checkNavigationDeviation(mockRoute, 34.815, 30.84);
    expect(offTrail.isOffRoute).toBe(true);
    expect(offTrail.distanceFromTrailMeters).toBeGreaterThan(500);

    const gpx = RouteManager.exportRouteAsGpx(mockRoute);
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('<ele>390</ele>');
  });

  it('provides adaptive day/night surface tokens, full POI category metadata, and HH:MM:SS duration formatting', () => {
    const day = getSurfaceTheme('topo-day');
    const night = getSurfaceTheme('topo-dark');
    expect(day.panel).toContain('bg-white');
    expect(night.panel).toContain('bg-slate-900');

    for (const cat of ['all', 'water', 'offroad', 'campsite', 'heritage', 'peak', 'user'] as const) {
      expect(POI_CATEGORY_META[cat]).toBeDefined();
      expect(POI_CATEGORY_META[cat].label.length).toBeGreaterThan(0);
    }

    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(65)).toBe('00:01:05');
    expect(formatDuration(3661)).toBe('01:01:01');
  });

  it('isolates hillshade raster-dem source from 3D terrain source and toggles 3D terrain cleanly', () => {
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: { ...DEFAULT_LAYER_VISIBILITY, terrain3d: true },
      theme: 'topo-day',
    });

    const terrainLayer = style.layers.find((l) => l.id === 'Terrain') as any;
    expect(terrainLayer).toBeDefined();
    expect(terrainLayer.source).toBe('israel-dem-hillshade');
    expect(style.sources['israel-dem-hillshade']).toBeDefined();
    expect(style.terrain?.source).toBe('israel-dem');

    let currentTerrain: any = null;
    const terrainCalls: any[] = [];
    const mockMap = {
      getStyle: () => ({ layers: [] }),
      getLayer: () => undefined,
      getSource: (id: string) => (id === 'israel-dem' ? { type: 'raster-dem' } : undefined),
      getTerrain: () => currentTerrain,
      setTerrain: (t: any) => {
        currentTerrain = t;
        terrainCalls.push(t);
      },
      setLayoutProperty: () => {},
    };

    applyLayerVisibilityToMap(mockMap, { ...DEFAULT_LAYER_VISIBILITY, terrain3d: true });
    expect(terrainCalls).toEqual([{ source: 'israel-dem', exaggeration: 1.35 }]);

    // Calling again while already enabled should not tear down and recreate terrain mesh
    applyLayerVisibilityToMap(mockMap, { ...DEFAULT_LAYER_VISIBILITY, terrain3d: true });
    expect(terrainCalls.length).toBe(1);

    // Turning off clears terrain cleanly
    applyLayerVisibilityToMap(mockMap, { ...DEFAULT_LAYER_VISIBILITY, terrain3d: false });
    expect(terrainCalls).toEqual([{ source: 'israel-dem', exaggeration: 1.35 }, null]);
  });

  it('checks navigation deviation accurately across multi-segment GeoJSON LineStrings', () => {
    const multiSegRoute = {
      id: 'multi-seg-test',
      name: 'Multi-Seg Trail',
      sourceFormat: 'gpx' as const,
      distanceKm: 4.0,
      ascentMeters: 150,
      descentMeters: 100,
      minEle: 350,
      maxEle: 500,
      color: '#ec4899',
      visible: true,
      createdAt: new Date().toISOString(),
      geojson: {
        type: 'FeatureCollection' as const,
        features: [
          {
            type: 'Feature' as const,
            properties: {},
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [34.81, 30.83],
                [34.82, 30.83],
              ],
            },
          },
          {
            type: 'Feature' as const,
            properties: {},
            geometry: {
              type: 'LineString' as const,
              coordinates: [
                [34.83, 30.84],
                [34.84, 30.84],
              ],
            },
          },
        ],
      },
      elevationProfile: [],
    };

    const nearSecondSeg = RouteManager.checkNavigationDeviation(multiSegRoute, 34.835, 30.84005);
    expect(nearSecondSeg.isOffRoute).toBe(false);
    expect(nearSecondSeg.distanceFromTrailMeters).toBeLessThan(15);

    const farFromAll = RouteManager.checkNavigationDeviation(multiSegRoute, 34.835, 30.86);
    expect(farFromAll.isOffRoute).toBe(true);
    expect(farFromAll.distanceFromTrailMeters).toBeGreaterThan(1000);
  });

  it('orders hillshade beneath contours/trails, wires SPNI trail colors and purple cycleways, and colors secondary roads #db894f', () => {
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, cycleways: true },
      theme: 'topo-day',
    });

    const ids = style.layers.map((l) => l.id);
    const terrainIdx = ids.indexOf('Terrain');
    const contourIdx = ids.indexOf('contour-line');
    const markedPathIdx = ids.indexOf('path-path');
    const trackRightIdx = ids.indexOf('track-right');
    const firstSymbolIdx = style.layers.findIndex((l) => l.type === 'symbol');

    expect(terrainIdx).toBeGreaterThan(-1);
    expect(contourIdx).toBeGreaterThan(-1);
    expect(terrainIdx).toBeLessThan(contourIdx);
    expect(terrainIdx).toBeLessThan(markedPathIdx);
    expect(terrainIdx).toBeLessThan(trackRightIdx);
    expect(markedPathIdx).toBeLessThan(firstSymbolIdx);

    const markedPathCasing = style.layers.find((l) => l.id === 'casing-marked-path') as any;
    expect(markedPathCasing?.source).toBe('israel-osm');
    expect(markedPathCasing?.['source-layer']).toBe('transportation');
    expect(markedPathCasing?.paint?.['line-opacity']).toBe(1);

    const pathLayer = style.layers.find((l) => l.id === 'path-path') as any;
    const trackRight = style.layers.find((l) => l.id === 'track-right') as any;
    expect(JSON.stringify(pathLayer)).toContain('#EAB308');
    expect(JSON.stringify(pathLayer)).toContain('#9333EA');
    expect(JSON.stringify(trackRight)).toContain('#EAB308');
    expect(JSON.stringify(trackRight)).toContain('#9333EA');

    // Dark muddy walking trail fallback (#6B3E26) and sac_scale path overrides (#DC2626 / #00A800) remain absent
    const vectorPaths = style.layers.filter((l) => l.id.includes('path'));
    for (const l of vectorPaths) {
      const serialized = JSON.stringify(l);
      expect(serialized).not.toContain('#6B3E26');
      expect(serialized).not.toContain('#DC2626');
      expect(serialized).not.toContain('#00A800');
    }

    // highway=secondary fill layers render in #db894f across ground, bridges, and tunnels
    for (const secId of [
      'road-secondary',
      'layer-1-road-secondary',
      'layer1-road-secondary',
      'layer2-road-secondary',
    ]) {
      const secLayer = style.layers.find((l) => l.id === secId) as any;
      expect(secLayer?.paint?.['line-color'], `Expected #db894f on ${secId}`).toBe('#db894f');
    }
  });

  it('uses official #AA8166 unmarked walking trail style, purple cycleways/MTB singletracks, 4x4 grade 1-5 colors, and separates path subclasses', () => {
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, cycleways: true },
      theme: 'topo-day',
    });

    const require = createRequire(import.meta.url);
    const styleSpec = require('@maplibre/maplibre-gl-style-spec');
    const byId = new Map<string, any>(style.layers.map((l) => [l.id, l]));

    const evalColor = (layerId: string, props: Record<string, any>, zoom = 16, layerMap = byId) => {
      const layer = layerMap.get(layerId);
      expect(layer).toBeDefined();
      const raw = layer.paint?.['line-color'];
      if (typeof raw === 'string') return raw;
      const compiled = styleSpec.createPropertyExpression(raw, styleSpec.latest.paint_line['line-color']);
      expect(compiled.result).toBe('success');
      const rgba = compiled.value.evaluate({ zoom }, { type: 2, properties: props });
      const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
      return `#${hex(rgba.r)}${hex(rgba.g)}${hex(rgba.b)}`;
    };

    const matches = (layerId: string, feat: { type: number; properties: Record<string, any> }, zoom = 18) => {
      const layer = byId.get(layerId);
      expect(layer).toBeDefined();
      if (!layer.filter) return true;
      return styleSpec.featureFilter(layer.filter).filter({ zoom }, feat);
    };

    // Unmarked walking paths (even with sac_scale/smoothness) stay official IHM #AA8166
    const unmarkedWalkingProps = {
      class: 'path',
      subclass: 'path',
      layer: 0,
      sac_scale: 'demanding_mountain_hiking',
      smoothness: 'good',
    };
    const unmarkedTrackProps = {
      class: 'track',
      layer: 0,
    };

    for (const id of [
      'path-footway',
      'path-path',
      'path-steps-line',
      'layer-1-path-footway',
      'layer-1-path-path',
      'layer-1-path-steps-line',
      'layer1-path-footway',
      'layer1-path-path',
      'layer1-path-steps-line',
      'layer2-path-footway',
      'layer2-path-path',
      'layer3-path-footway',
    ]) {
      expect(evalColor(id, unmarkedWalkingProps)).toBe('#AA8166');
    }

    // Dedicated cycleways, bicycle=designated/mtb paths & tracks, and mtb_scale singletracks render purple (#9333EA) when cycleways ON
    for (const id of ['path-cycleway', 'layer-1-path-cycleway', 'layer1-path-cycleway', 'layer2-path-cycleway']) {
      expect(evalColor(id, { class: 'path', subclass: 'cycleway' })).toBe('#9333EA');
    }
    expect(evalColor('path-path', { class: 'path', subclass: 'path', bicycle: 'designated' })).toBe('#9333EA');
    expect(evalColor('path-path', { class: 'path', subclass: 'path', mtb_scale: '2' })).toBe('#9333EA');
    expect(evalColor('path-footway', { class: 'path', subclass: 'footway', bicycle: 'designated' })).toBe('#9333EA');
    expect(evalColor('track-right', { class: 'track', bicycle: 'designated' })).toBe('#9333EA');
    expect(evalColor('track-right', { class: 'track', mtb_scale: '1' })).toBe('#9333EA');

    // 4x4 grades (1-5) color dirt tracks when offroad4x4 is ON, while unspecified unmarked tracks stay #AA8166
    expect(evalColor('track-right', unmarkedTrackProps)).toBe('#AA8166');
    expect(evalColor('track-left', unmarkedTrackProps)).toBe('#AA8166');
    expect(evalColor('track-right-grade1-2', { class: 'track', tracktype: 'grade1' })).toBe('#64748B');
    expect(evalColor('track-right-grade1-2', { class: 'track', tracktype: 'grade2' })).toBe('#8C6239');
    expect(evalColor('track-right', { class: 'track', tracktype: 'grade3' })).toBe('#B45309');
    expect(evalColor('track-right-grade4', { class: 'track', tracktype: 'grade4' })).toBe('#C2410C');
    expect(evalColor('track-right-grade5', { class: 'track', tracktype: 'grade5' })).toBe('#991B1B');
    expect(evalColor('track-left-grade5', { class: 'track', tracktype: 'grade5' })).toBe('#991B1B');
    expect(evalColor('casing-track', { class: 'track', colour: 'red' })).toBe('#FFFFFF');
    expect(evalColor('casing-track', { class: 'track', tracktype: 'grade5' })).toBe('#F7F4F2');
    expect(evalColor('casing-track', { class: 'track', tracktype: 'grade1' })).toBe('#E8D3B2');

    // Marked SPNI trail colors & dual-color semi-colon splitting still resolve accurately
    expect(evalColor('path-path', { class: 'path', subclass: 'path', colour: 'yellow' })).toBe('#EAB308');
    expect(evalColor('path-footway', { class: 'path', subclass: 'footway', colour: 'red' })).toBe('#FF0000');
    expect(evalColor('track-right', { class: 'track', colour: 'blue;black' })).toBe('#0044FF');
    expect(evalColor('track-left', { class: 'track', colour: 'blue;black' })).toBe('#111111');

    // OpenMapTiles path-path layers must match ONLY subclass=path LineStrings, never footway/cycleway/pedestrian/steps/platform
    for (const pathLayerId of ['path-path', 'layer-1-path-path', 'layer1-path-path', 'layer2-path-path', 'layer3-casing-path']) {
      const baseProps =
        pathLayerId === 'layer-1-path-path'
          ? { brunnel: 'tunnel', layer: -1 }
          : pathLayerId === 'layer1-path-path'
          ? { layer: 1 }
          : pathLayerId.startsWith('layer2-') || pathLayerId.startsWith('layer3-')
          ? { layer: pathLayerId.startsWith('layer2-') ? 2 : 3, brunnel: 'bridge' }
          : {};

      expect(matches(pathLayerId, { type: 2, properties: { ...baseProps, class: 'path', subclass: 'path' } })).toBe(true);
      expect(matches(pathLayerId, { type: 2, properties: { ...baseProps, class: 'path', subclass: 'footway' } })).toBe(false);
      expect(matches(pathLayerId, { type: 2, properties: { ...baseProps, class: 'path', subclass: 'cycleway' } })).toBe(false);
      expect(matches(pathLayerId, { type: 2, properties: { ...baseProps, class: 'path', subclass: 'pedestrian' } })).toBe(false);
      expect(matches(pathLayerId, { type: 2, properties: { ...baseProps, class: 'path', subclass: 'steps' } })).toBe(false);
      expect(matches(pathLayerId, { type: 2, properties: { ...baseProps, class: 'path', subclass: 'platform' } })).toBe(false);
      expect(matches(pathLayerId, { type: 3, properties: { ...baseProps, class: 'path', subclass: 'pedestrian' } })).toBe(false);
    }

    // Pedestrian plaza polygons must NEVER match path-footway, casing-path, or casing-marked-path
    const pedestrianPolygon = { type: 3, properties: { class: 'path', subclass: 'pedestrian', layer: 0 } };
    const markedPedestrianPolygon = { type: 3, properties: { class: 'path', subclass: 'pedestrian', colour: 'red', layer: 0 } };
    expect(matches('casing-path', pedestrianPolygon)).toBe(false);
    expect(matches('path-footway', pedestrianPolygon)).toBe(false);
    expect(matches('path-path', pedestrianPolygon)).toBe(false);
    expect(matches('casing-marked-path', markedPedestrianPolygon)).toBe(false);
    expect(matches('trail-line-path', markedPedestrianPolygon)).toBe(false);

    // Footway LineStrings match only casing-path + path-footway (not path-path or path-cycleway)
    const footwayLine = { type: 2, properties: { class: 'path', subclass: 'footway', layer: 0 } };
    expect(matches('casing-path', footwayLine)).toBe(true);
    expect(matches('path-footway', footwayLine)).toBe(true);
    expect(matches('path-path', footwayLine)).toBe(false);
    expect(matches('path-cycleway', footwayLine)).toBe(false);
  });

  it('isolates contour ArrayBuffers against worker transfer detachment and provides valid empty Terrarium PNGs', async () => {
    const sharedPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const fakeManager: any = {
      fetchContourTile: async () => ({ arrayBuffer: sharedPayload }),
    };

    wrapManagerWithSafeContourBuffers(fakeManager);

    const first = await fakeManager.fetchContourTile(14, 9797, 6699, {});
    expect(first.arrayBuffer).not.toBe(sharedPayload);
    expect(first.arrayBuffer.byteLength).toBe(8);

    // Simulate MapLibre Worker transferring (detaching) the first response ArrayBuffer
    structuredClone(first.arrayBuffer, { transfer: [first.arrayBuffer] });
    expect(first.arrayBuffer.byteLength).toBe(0);

    // Cached underlying buffer and subsequent fetches remain completely intact
    const second = await fakeManager.fetchContourTile(14, 9797, 6699, {});
    expect(second.arrayBuffer.byteLength).toBe(8);
    expect(Array.from(new Uint8Array(second.arrayBuffer))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const emptyBlob = getEmptyTerrariumTileBlob();
    expect(emptyBlob.type).toBe('image/png');
    const pngBytes = new Uint8Array(await emptyBlob.arrayBuffer());
    expect(Array.from(pngBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('replaces stale OPFS Israel.osm.pmtiles with fresher local /data archive and detects trail color schema', async () => {
    const pmtilesPath = 'data/Israel.osm.pmtiles';
    const stat = fs.statSync(pmtilesPath);
    const fd = fs.openSync(pmtilesPath, 'r');

    const origWindow = (globalThis as any).window;
    const origFetch = globalThis.fetch;
    const addProtoSpy = vi.spyOn(maplibregl, 'addProtocol').mockImplementation(() => {});
    const opfsGetSpy = vi
      .spyOn(OpfsStorageAdapter, 'getStoredFile')
      .mockResolvedValue({
        name: 'Israel.osm.pmtiles',
        size: 112434955,
        lastModified: Date.parse('2026-11-07T10:00:00Z'),
      } as unknown as File);
    const opfsRemoveSpy = vi.spyOn(OpfsStorageAdapter, 'removeFile').mockResolvedValue();

    try {
      (globalThis as any).window = {
        location: { origin: 'http://localhost:5173', hostname: 'localhost' },
      };

      globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith('http://localhost:5173/data/Israel.osm.pmtiles')) {
          return new Response('', { status: 404 });
        }
        const headers = new Headers({
          'content-type': 'application/octet-stream',
          'content-length': String(stat.size),
          etag: `"${stat.size}-${stat.mtimeMs}"`,
          'last-modified': stat.mtime.toUTCString(),
        });
        if (init?.method === 'HEAD') {
          return new Response(null, { status: 200, headers });
        }
        const reqHeaders = new Headers(init?.headers);
        const range = reqHeaders.get('range') || 'bytes=0-16383';
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        const start = match ? Number(match[1]) : 0;
        const end = match ? Math.min(Number(match[2]), stat.size - 1) : 16383;
        const len = end - start + 1;
        const buf = Buffer.allocUnsafe(len);
        const readLen = fs.readSync(fd, buf, 0, len, start);
        const slice = buf.buffer.slice(buf.byteOffset, buf.byteOffset + readLen);
        return new Response(slice, {
          status: 206,
          headers: new Headers({
            'content-type': 'application/octet-stream',
            'content-length': String(readLen),
            'content-range': `bytes ${start}-${start + readLen - 1}/${stat.size}`,
            etag: `"${stat.size}-${stat.mtimeMs}"`,
          }),
        });
      }) as any;

      const registry = new PMTilesRegistry();
      const mounted = await registry.resolveArchive('israel-osm', 'Israel.osm.pmtiles', false);

      expect(opfsRemoveSpy).toHaveBeenCalledWith('Israel.osm.pmtiles');
      expect(mounted).not.toBeNull();
      expect(mounted?.record.storageKind).toBe('local-server');
      expect(mounted?.record.sizeBytes).toBe(stat.size);
      expect(mounted?.protocolUrl).toContain('http://localhost:5173/data/Israel.osm.pmtiles?v=');
      expect(mounted?.hasTrailColorSchema).toBe(true);
    } finally {
      fs.closeSync(fd);
      (globalThis as any).window = origWindow;
      globalThis.fetch = origFetch;
      addProtoSpy.mockRestore();
      opfsGetSpy.mockRestore();
      opfsRemoveSpy.mockRestore();
    }
  });

  it('CachedFetchSource revalidates offset-0 header online and invalidates stale ranges on ETag change', async () => {
    const store = new Map<string, Response>();
    let cacheDeleted = false;
    const fakeCache = {
      match: async (req: Request) => store.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => {
        store.set(req.url, res.clone());
      },
    };
    const origCaches = (globalThis as any).caches;
    const origFetch = globalThis.fetch;

    try {
      (globalThis as any).caches = {
        open: async () => fakeCache,
        delete: async (name: string) => {
          if (name === 'pmtiles-range-cache-v3') {
            cacheDeleted = true;
            store.clear();
          }
          return true;
        },
      };

      const url = 'https://navapp-israel-topo-data.web.app/data/Israel.osm.pmtiles';
      // Pre-populate stale v1 header + tile entry
      store.set(
        `https://pmtiles-range-cache.invalid/${encodeURIComponent(url)}/0-16384`,
        new Response(new Uint8Array([0x50, 0x4d, 0x33, 0x01]), {
          headers: { 'x-etag': '"old-etag"' },
        })
      );
      store.set(
        `https://pmtiles-range-cache.invalid/${encodeURIComponent(url)}/16384-100`,
        new Response(new Uint8Array([9, 9, 9]), {
          headers: { 'x-etag': '"old-etag"' },
        })
      );

      globalThis.fetch = vi.fn(async () => {
        return new Response(new Uint8Array([0x50, 0x4d, 0x33, 0x02]), {
          status: 206,
          headers: { etag: '"new-etag"', 'content-length': '4' },
        });
      }) as any;

      const src = new CachedFetchSource(url);
      const res = await src.getBytes(0, 16384);

      expect(cacheDeleted).toBe(true);
      expect(res.etag).toBe('"new-etag"');
      expect(Array.from(new Uint8Array(res.data))).toEqual([0x50, 0x4d, 0x33, 0x02]);
      expect(
        store.has(`https://pmtiles-range-cache.invalid/${encodeURIComponent(url)}/16384-100`)
      ).toBe(false);
    } finally {
      (globalThis as any).caches = origCaches;
      globalThis.fetch = origFetch;
    }
  });

  it('controls master POI visibility and all 6 POI category sub-toggles cleanly in Layers', () => {
    expect(DEFAULT_LAYER_VISIBILITY.pois).toBe(true);
    expect(DEFAULT_LAYER_VISIBILITY.poiWater).toBe(true);
    expect(DEFAULT_LAYER_VISIBILITY.poiOffroad).toBe(true);
    expect(DEFAULT_LAYER_VISIBILITY.poiHeritage).toBe(true);
    expect(DEFAULT_LAYER_VISIBILITY.poiCampsites).toBe(true);
    expect(DEFAULT_LAYER_VISIBILITY.poiPeaks).toBe(true);
    expect(DEFAULT_LAYER_VISIBILITY.poiUser).toBe(true);
    expect(isMasterPoiActive(DEFAULT_LAYER_VISIBILITY)).toBe(true);
    expect(countActivePoiCategories(DEFAULT_LAYER_VISIBILITY)).toBe(6);

    // Filter down to Water + User while master is on, then toggle master OFF and back ON
    let vis = togglePoiCategoryVisibility(DEFAULT_LAYER_VISIBILITY, 'poiOffroad');
    vis = togglePoiCategoryVisibility(vis, 'poiHeritage');
    vis = togglePoiCategoryVisibility(vis, 'poiCampsites');
    vis = togglePoiCategoryVisibility(vis, 'poiPeaks');
    expect(countActivePoiCategories(vis)).toBe(2);
    expect(isMasterPoiActive(vis)).toBe(true);

    const hiddenMaster = toggleMasterPoiVisibility(vis);
    expect(hiddenMaster.pois).toBe(false);
    expect(isMasterPoiActive(hiddenMaster)).toBe(false);
    // Preserves previously chosen subset when toggling master back ON
    const restoredMaster = toggleMasterPoiVisibility(hiddenMaster);
    expect(restoredMaster.pois).toBe(true);
    expect(restoredMaster.poiWater).toBe(true);
    expect(restoredMaster.poiUser).toBe(true);
    expect(restoredMaster.poiOffroad).toBe(false);

    // Clicking a single sub-category while master is OFF activates only that category
    const singleFromOff = togglePoiCategoryVisibility(hiddenMaster, 'poiHeritage');
    expect(singleFromOff.pois).toBe(true);
    expect(singleFromOff.poiHeritage).toBe(true);
    expect(singleFromOff.poiWater).toBe(false);
    expect(singleFromOff.poiUser).toBe(false);

    // Turning off the last active sub-category automatically turns master OFF
    const allOff = togglePoiCategoryVisibility(singleFromOff, 'poiHeritage');
    expect(allOff.pois).toBe(false);
    expect(countActivePoiCategories(allOff)).toBe(0);

    // Toggling master ON when 0 sub-categories are active enables all 6 categories
    const reEnabledAll = toggleMasterPoiVisibility(allOff);
    expect(reEnabledAll.pois).toBe(true);
    expect(countActivePoiCategories(reEnabledAll)).toBe(6);

    const explicitAll = enableAllPoiVisibility(hiddenMaster);
    expect(explicitAll.pois).toBe(true);
    expect(countActivePoiCategories(explicitAll)).toBe(6);
  });

  it('filters PoiManager GeoJSON and MapLibre POI layers using master POI toggle and category sub-toggles', () => {
    const samplePois = [
      { id: '1', category: 'water' as const },
      { id: '2', category: 'offroad' as const },
      { id: '3', category: 'heritage' as const },
      { id: '4', category: 'campsite' as const },
      { id: '5', category: 'peak' as const },
      { id: '6', category: 'user' as const },
    ].map((item) => ({
      ...item,
      name: item.id,
      nameHe: item.id,
      nameEn: item.id,
      subcategory: 'test',
      lon: 34.8,
      lat: 30.8,
      ele: 400,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'test',
      wikipedia: null,
    }));

    expect(PoiManager.toGeoJSON(samplePois, DEFAULT_LAYER_VISIBILITY).features).toHaveLength(6);

    const noMaster = { ...DEFAULT_LAYER_VISIBILITY, pois: false };
    expect(PoiManager.toGeoJSON(samplePois, noMaster).features).toHaveLength(0);

    const onlyUser = {
      ...DEFAULT_LAYER_VISIBILITY,
      poiWater: false,
      poiOffroad: false,
      poiHeritage: false,
      poiCampsites: false,
      poiPeaks: false,
      poiUser: true,
    };
    const userGeoJson = PoiManager.toGeoJSON(samplePois, onlyUser);
    expect(userGeoJson.features).toHaveLength(1);
    expect(userGeoJson.features[0].id).toBe('6');

    const noUser = { ...DEFAULT_LAYER_VISIBILITY, poiUser: false };
    // Ordered deterministically by priority: offroad ('2') -> water ('1') -> campsite ('4') -> heritage ('3') -> peak ('5')
    expect(PoiManager.toGeoJSON(samplePois, noUser).features.map((f) => f.id)).toEqual([
      '2',
      '1',
      '4',
      '3',
      '5',
    ]);

    const hiddenStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: noMaster,
      theme: 'topo-day',
    });
    for (const id of ['name-peak', 'name-water-point', 'icon-camp_site', 'icon-viewpoint', 'icon-parking']) {
      const layer = hiddenStyle.layers.find((l) => l.id === id) as any;
      expect(layer?.layout?.visibility).toBe('none');
    }

    const layoutUpdates: Array<{ id: string; val: string }> = [];
    const mockMap = {
      getStyle: () => ({
        layers: [{ id: 'name-peak' }, { id: 'icon-viewpoint' }, { id: 'icon-parking' }],
      }),
      getLayer: (id: string) =>
        ['name-peak', 'icon-viewpoint', 'icon-parking', 'israel-pois-labels'].includes(id)
          ? { id }
          : undefined,
      getSource: () => undefined,
      getTerrain: () => null,
      setTerrain: () => {},
      setLayoutProperty: (id: string, prop: string, val: string) => {
        if (prop === 'visibility') layoutUpdates.push({ id, val });
      },
    };
    applyLayerVisibilityToMap(mockMap, noMaster);
    expect(layoutUpdates).toEqual([
      { id: 'name-peak', val: 'none' },
      { id: 'icon-viewpoint', val: 'none' },
      { id: 'icon-parking', val: 'none' },
      { id: 'israel-pois-labels', val: 'none' },
    ]);
  });

  it('defaults cycleways switch to OFF, always draws Firing boundary, 4x4 tracks, Hiking paths, and Cycleways in default color, and toggles only colors', () => {
    expect(DEFAULT_LAYER_VISIBILITY.cycleways).toBe(false);
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');

    const evalPaint = (style: any, layerId: string, props: Record<string, any>, zoom = 14) => {
      const layer = style.layers.find((l: any) => l.id === layerId) as any;
      expect(layer, `Missing layer ${layerId}`).toBeDefined();
      const raw = layer.paint?.['line-color'];
      if (typeof raw === 'string') return raw;
      const compiled = styleSpec.createPropertyExpression(raw, styleSpec.latest.paint_line['line-color']);
      expect(compiled.result).toBe('success');
      const rgba = compiled.value.evaluate({ zoom }, { type: 2, properties: props });
      const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
      return `#${hex(rgba.r)}${hex(rgba.g)}${hex(rgba.b)}`;
    };

    // 1. Default state (Cycle OFF) keeps cycleways visible in default #AA8166 without purple overlay, keeping hikingTrails
    const noCycleStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    for (const id of [
      'path-cycleway',
      'casing-cycleway',
      'casing-marked-cycleway',
      'trail-line-cycleway',
      'layer-1-path-cycleway',
      'layer1-path-cycleway',
      'layer2-path-cycleway',
      'path-path',
      'path-footway',
      'casing-path',
      'casing-marked-path',
      'trail-line-path',
      'trail-line-road',
    ]) {
      const layer = noCycleStyle.layers.find((l) => l.id === id) as any;
      expect(layer, `Missing layer ${id}`).toBeDefined();
      expect(layer.layout?.visibility, `Expected ${id} visible`).toBe('visible');
    }
    expect((noCycleStyle.layers.find((l) => l.id === 'trail-line-cycleway-purple') as any)?.layout?.visibility).toBe('none');
    expect((noCycleStyle.layers.find((l) => l.id === 'trail-line-track-cycle') as any)?.layout?.visibility).toBe('none');
    expect(evalPaint(noCycleStyle, 'path-cycleway', { class: 'path', subclass: 'cycleway' })).toBe('#AA8166');
    expect(evalPaint(noCycleStyle, 'path-path', { class: 'path', subclass: 'path', bicycle: 'designated', mtb_scale: '2' })).toBe('#AA8166');
    expect(evalPaint(noCycleStyle, 'path-path', { class: 'path', subclass: 'path', colour: 'red', bicycle: 'designated' })).toBe('#FF0000');

    // 2. Turning ALL switches OFF keeps every base path, track, cycleway, firing boundary, and park boundary visible
    const allColorSwitchesOff = {
      ...DEFAULT_LAYER_VISIBILITY,
      militaryZones: false,
      natureParks: false,
      offroad4x4: false,
      hikingTrails: false,
      cycleways: false,
    };
    const offStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: allColorSwitchesOff,
      theme: 'topo-day',
    });

    // Firing zone keeps red dashed boundary, hides only area fill
    expect((offStyle.layers.find((l) => l.id === 'boundary-military') as any)?.layout?.visibility).toBe('visible');
    expect((offStyle.layers.find((l) => l.id === 'area-military') as any)?.layout?.visibility).toBe('none');

    // Nature reserve keeps polygon boundary from z12+, hides background fill, casing, and labels when natureParks=false
    const onAreaPark = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    }).layers.find((l) => l.id === 'area-park') as any;
    expect(onAreaPark?.minzoom).toBe(13);
    expect(onAreaPark?.paint?.['fill-color']).toBe('#00d188');
    expect(onAreaPark?.paint?.['fill-opacity']).toBe(0.15);
    expect(onAreaPark?.layout?.visibility).toBe('visible');

    const offBoundaryPark = offStyle.layers.find((l) => l.id === 'boundary-park') as any;
    const offNamePark = offStyle.layers.find((l) => l.id === 'name-park') as any;
    expect(offBoundaryPark?.minzoom).toBe(12);
    expect(offNamePark?.minzoom).toBe(12);
    expect(offBoundaryPark?.layout?.visibility).toBe('visible');
    expect((offStyle.layers.find((l) => l.id === 'area-park') as any)?.layout?.visibility).toBe('none');
    expect((offStyle.layers.find((l) => l.id === 'boundary-park-casing') as any)?.layout?.visibility).toBe('none');
    expect(offNamePark?.layout?.visibility).toBe('none');

    // Trail color overlays hide; base geometry layers remain visible
    for (const overlayId of [
      'trail-israel-lowzoom',
      'trail-israel-secondary-',
      'trail-israel-primary+',
      'trail-regional-line',
      'trail-regional-dash',
      'trail-regional-line-purple',
      'trail-line-path',
      'trail-line-cycleway',
      'trail-line-road',
      'trail-line-track',
      'trail-line-cycleway-purple',
      'trail-line-track-cycle',
      'casing-marked-path',
      'casing-marked-cycleway',
      'casing-minor-colour2',
    ]) {
      expect((offStyle.layers.find((l) => l.id === overlayId) as any)?.layout?.visibility, `Expected overlay ${overlayId} hidden`).toBe('none');
    }

    for (const baseId of [
      'path-path',
      'path-footway',
      'path-cycleway',
      'path-steps-line',
      'casing-path',
      'casing-cycleway',
      'track-line-lowzoom',
      'track-line',
      'casing-track',
      'track-right',
      'track-left',
      'track-right-grade4',
      'track-left-grade4',
      'track-right-grade5',
      'track-left-grade5',
      'track-right-grade1-2',
      'track-left-grade1-2',
      'casing-minor',
      'casing-secondary',
    ]) {
      expect(
        (offStyle.layers.find((l) => l.id === baseId) as any)?.layout?.visibility ?? 'visible',
        `Expected base ${baseId} visible`
      ).toBe('visible');
    }

    // Paths, tracks, cycleways & road casings evaluate purely to default colors even on tagged features
    expect(evalPaint(offStyle, 'path-path', { class: 'path', subclass: 'path', colour: 'red', bicycle: 'designated' })).toBe('#AA8166');
    expect(evalPaint(offStyle, 'path-cycleway', { class: 'path', subclass: 'cycleway', colour: 'blue' })).toBe('#AA8166');
    expect(evalPaint(offStyle, 'track-right-grade5', { class: 'track', tracktype: 'grade5', colour: 'red', bicycle: 'designated' })).toBe('#AA8166');
    expect(evalPaint(offStyle, 'track-left-grade5', { class: 'track', tracktype: 'grade5', colour: 'red;green' })).toBe('#AA8166');
    expect(evalPaint(offStyle, 'casing-track', { class: 'track', colour: 'red', tracktype: 'grade4' })).toBe('#F7F4F2');
    expect(evalPaint(offStyle, 'casing-secondary', { class: 'secondary', colour: 'red' })).toBe('#808080');

    // Also validate OFF style passes MapLibre Style Spec v8 completely
    const mlCode = fs.readFileSync('node_modules/maplibre-gl/dist/maplibre-gl.js', 'utf8');
    const sharedExports: any = {};
    vm.runInNewContext(mlCode.slice(mlCode.indexOf('define("shared"'), mlCode.indexOf('define("worker"')), {
      console, setTimeout, clearTimeout, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
      Float32Array, Float64Array, ArrayBuffer, DataView, TextDecoder, performance, Math, Object, Array, String,
      Number, Boolean, RegExp, Error, Map, Set, WeakMap, Symbol, Promise, JSON,
      define: (_n: string, _d: string[], factory: any) => factory(sharedExports),
    });
    expect(sharedExports.F(offStyle)).toEqual([]);

    // 3. In-place toggle via applyLayerVisibilityToMap updates layout AND paint properties cleanly
    const layoutUpdates: Array<{ id: string; val: string }> = [];
    const paintUpdates: Array<{ id: string; prop: string; val: any }> = [];
    const watchedIds = [
      'area-military',
      'boundary-military',
      'area-park',
      'boundary-park-casing',
      'boundary-park',
      'name-park',
      'trail-line-cycleway-purple',
      'trail-line-track',
      'path-cycleway',
      'path-path',
      'track-right-grade5',
      'casing-track',
    ];
    const mockMap = {
      getStyle: () => ({ layers: watchedIds.map((id) => ({ id })) }),
      getLayer: (id: string) => (watchedIds.includes(id) ? { id } : undefined),
      getSource: () => undefined,
      getTerrain: () => null,
      setTerrain: () => {},
      setLayoutProperty: (id: string, prop: string, val: string) => {
        if (prop === 'visibility') layoutUpdates.push({ id, val });
      },
      setPaintProperty: (id: string, prop: string, val: any) => {
        paintUpdates.push({ id, prop, val });
      },
    };
    applyLayerVisibilityToMap(mockMap, allColorSwitchesOff);
    expect(layoutUpdates).toEqual([
      { id: 'area-military', val: 'none' },
      { id: 'boundary-military', val: 'visible' },
      { id: 'area-park', val: 'none' },
      { id: 'boundary-park-casing', val: 'none' },
      { id: 'boundary-park', val: 'visible' },
      { id: 'name-park', val: 'none' },
      { id: 'trail-line-cycleway-purple', val: 'none' },
      { id: 'trail-line-track', val: 'none' },
      { id: 'path-cycleway', val: 'visible' },
      { id: 'path-path', val: 'visible' },
      { id: 'track-right-grade5', val: 'visible' },
      { id: 'casing-track', val: 'visible' },
    ]);
    expect(paintUpdates.find((p) => p.id === 'path-cycleway' && p.prop === 'line-color')?.val).toBe('#AA8166');
    expect(paintUpdates.find((p) => p.id === 'path-path' && p.prop === 'line-color')?.val).toBe('#AA8166');
    expect(paintUpdates.find((p) => p.id === 'track-right-grade5' && p.prop === 'line-color')?.val).toBe('#AA8166');
  });

  it('draws Shvil Israel from zoom 7+, suppresses other trail colors below zoom 11, and renders dashed trails at zoom 11', () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    // 1. Shvil Israel exception draws strictly from zoom 7
    const shvilLowZoom = style.layers.find((l) => l.id === 'trail-israel-lowzoom') as any;
    const shvilSecondary = style.layers.find((l) => l.id === 'trail-israel-secondary-') as any;
    const shvilPrimary = style.layers.find((l) => l.id === 'trail-israel-primary+') as any;
    expect(shvilLowZoom?.minzoom).toBe(7);
    expect(shvilLowZoom?.maxzoom).toBe(9);
    expect(shvilSecondary?.minzoom).toBe(7);
    expect(shvilPrimary?.minzoom).toBe(7);
    const shvilGeo = (style.sources['israel-shvil-lowzoom'] as any)?.data;
    expect(shvilGeo?.features?.[0]?.geometry?.coordinates?.length).toBeGreaterThan(50);

    // 2. No non-Shvil trail color layers draw below zoom 11
    for (const id of [
      'trail-line-path',
      'trail-line-cycleway',
      'trail-line-cycleway-purple',
      'trail-line-track-cycle',
      'trail-line-track',
      'trail-line-road',
      'trail-regional-line',
      'trail-regional-dash',
      'trail-regional-line-purple',
      'casing-marked-path',
      'casing-marked-cycleway',
      'path-path',
      'path-footway',
      'path-cycleway',
      'track-right',
      'track-left',
    ]) {
      const layer = style.layers.find((l) => l.id === id) as any;
      expect(layer?.minzoom ?? 0, `Expected ${id} minzoom >= 11`).toBeGreaterThanOrEqual(11);
    }

    // Even road casings with minzoom < 11 evaluate strictly to neutral gray below z11
    for (const id of ['casing-trunk', 'casing-primary', 'layer-1-casing-trunk', 'layer-1-casing-primary']) {
      const layer = style.layers.find((l) => l.id === id) as any;
      const expr = styleSpec.expression.createExpression(layer.paint['line-color'], { type: 'color' }).value;
      const colAt10 = expr.evaluate(
        { zoom: 10 },
        { type: 2, properties: { class: 'primary', colour: 'red', osmc_symbol: 'red:white:red_stripe' } }
      ).toString();
      expect(['rgba(128,128,128,1)', 'rgba(224,224,224,1)']).toContain(colAt10);
    }

    // Tracks remain drawn at z10..11 via unmarked track-line-lowzoom
    const trackLow = style.layers.find((l) => l.id === 'track-line-lowzoom') as any;
    expect(trackLow?.minzoom).toBe(10);
    expect(trackLow?.maxzoom).toBe(11);

    // 3. At zoom 11, marked trails are dashed (never a single continuous straight line)
    for (const id of [
      'trail-line-road',
      'trail-line-track',
      'trail-line-path',
      'trail-line-cycleway',
      'trail-line-cycleway-purple',
      'trail-line-track-cycle',
    ]) {
      const layer = style.layers.find((l) => l.id === id) as any;
      expect(Array.isArray(layer?.paint?.['line-dasharray'])).toBe(true);
      expect(layer.paint['line-dasharray'].length).toBeGreaterThanOrEqual(2);
      expect(layer?.layout?.['line-cap']).toBe('butt');
    }
  });

  it('adds Google Satellite layer (default OFF) and draws highway and POI objects on top while hiding everything else when ON', () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');

    // 1. Default visibility is OFF
    expect(DEFAULT_LAYER_VISIBILITY.googleSatellite).toBe(false);

    const defaultStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    const satSource = defaultStyle.sources[GOOGLE_SATELLITE_SOURCE_ID] as any;
    expect(satSource).toBeDefined();
    expect(satSource.type).toBe('raster');
    expect(satSource.tiles).toEqual([GOOGLE_SATELLITE_TILE_URL]);
    expect(satSource.tiles[0]).toBe(
      'https://mt0.google.com/vt/lyrs=s&hl=en&src=app&x={x}&y={y}&z={z}&s=Gal'
    );
    expect(satSource.tileSize).toBe(256);

    const defaultSatIdx = defaultStyle.layers.findIndex((l) => l.id === GOOGLE_SATELLITE_LAYER_ID);
    const defaultBgIdx = defaultStyle.layers.findIndex((l) => l.id === 'background');
    expect(defaultSatIdx).toBe(defaultBgIdx + 1);
    expect((defaultStyle.layers[defaultSatIdx] as any).layout?.visibility).toBe('none');
    expect(
      (defaultStyle.layers.find((l) => l.id === 'area-residential') as any)?.layout?.visibility
    ).toBe('visible');
    expect((defaultStyle.layers.find((l) => l.id === 'Terrain') as any)?.layout?.visibility).toBe(
      'visible'
    );

    // 2. When googleSatellite is ON: valid v8 style, satellite visible below all highways & POIs, everything else hidden
    for (const theme of ['topo-day', 'topo-dark'] as const) {
      const satStyle = buildIsraelOutdoorStyle({
        osmProtocolUrl: 'pmtiles://israel-osm',
        demProtocolUrl: 'pmtiles://israel-dem',
        contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
        visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true, cycleways: true, terrain3d: true },
        theme,
      });

      expect(styleSpec.validateStyleMin(satStyle)).toEqual([]);

      const satLayerIdx = satStyle.layers.findIndex((l) => l.id === GOOGLE_SATELLITE_LAYER_ID);
      expect(satLayerIdx).toBeGreaterThanOrEqual(1);
      expect((satStyle.layers[satLayerIdx] as any).layout?.visibility).toBe('visible');

      for (let i = 0; i < satStyle.layers.length; i++) {
        const layer = satStyle.layers[i] as any;
        if (layer.id === GOOGLE_SATELLITE_LAYER_ID) continue;

        if (isHighwayStyleLayerId(layer.id) || isPoiStyleLayerId(layer.id)) {
          expect(layer.layout?.visibility, `Expected highway/POI ${layer.id} visible`).toBe('visible');
          expect(i, `Expected highway/POI ${layer.id} above satellite`).toBeGreaterThan(satLayerIdx);
        } else {
          expect(layer.layout?.visibility, `Expected non-highway/non-POI ${layer.id} hidden`).toBe(
            'none'
          );
        }
      }

      for (const nonHwyTransId of NON_HIGHWAY_TRANSPORTATION_LAYER_IDS) {
        const nonHwyLayer = satStyle.layers.find((l) => l.id === nonHwyTransId) as any;
        expect(nonHwyLayer?.layout?.visibility, `Expected ${nonHwyTransId} hidden`).toBe('none');
      }
      expect(HIGHWAY_LAYER_IDS.size).toBeGreaterThanOrEqual(160);
      expect(POI_STYLE_LAYER_IDS.size).toBe(23);
    }

    // Verify POI category and master switches continue filtering POIs when satellite is ON
    const satNoPeaksStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true, poiPeaks: false },
      theme: 'topo-day',
    });
    expect(
      (satNoPeaksStyle.layers.find((l) => l.id === 'name-peak') as any)?.layout?.visibility
    ).toBe('none');
    expect(
      (satNoPeaksStyle.layers.find((l) => l.id === 'name-water-point') as any)?.layout?.visibility
    ).toBe('visible');

    // Also verify default cycleways=false on satellite still draws base cycleway geometries while hiding purple overlay
    const satDefaultCycleStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true },
      theme: 'topo-day',
    });
    expect(
      (satDefaultCycleStyle.layers.find((l) => l.id === 'path-cycleway') as any)?.layout?.visibility
    ).toBe('visible');
    expect(
      (satDefaultCycleStyle.layers.find((l) => l.id === 'trail-line-cycleway-purple') as any)
        ?.layout?.visibility
    ).toBe('none');

    // 3. In-place toggle ON -> OFF via applyLayerVisibilityToMap keeps highways & POIs visible on satellite, hides rest & grid, never hides user nav routes
    const testLayerIds = [
      'background',
      GOOGLE_SATELLITE_LAYER_ID,
      'Terrain',
      'contour-line',
      'area-residential',
      'water-area',
      'building',
      'place-city',
      'rail-dash',
      'road-primary',
      'road-minor',
      'casing-primary',
      'track-right',
      'path-path',
      'shield-primary',
      'name-primary',
      'name-peak',
      'name-water-point',
      'icon-viewpoint',
      'icon-camp_site',
      'tactical-grid-minor',
      'tactical-grid-major',
      'tactical-grid-labels',
      'israel-pois-labels',
      'active-route-line',
      'saved-routes-line',
    ];
    const currentVisState = new Map<string, string>();
    const appliedFilters: any[] = [];
    const mockMap = {
      getStyle: () => ({ layers: testLayerIds.map((id) => ({ id })) }),
      getLayer: (id: string) => (testLayerIds.includes(id) ? { id } : undefined),
      getSource: () => undefined,
      getTerrain: () => null,
      setTerrain: () => {},
      setLayoutProperty: (id: string, prop: string, val: string) => {
        if (prop === 'visibility') currentVisState.set(id, val);
      },
      setFilter: (_id: string, filter: any) => {
        appliedFilters.push(filter);
      },
    };

    applyLayerVisibilityToMap(mockMap, { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true });
    expect(currentVisState.get(GOOGLE_SATELLITE_LAYER_ID)).toBe('visible');
    for (const onSatId of [
      'road-primary',
      'road-minor',
      'casing-primary',
      'track-right',
      'path-path',
      'shield-primary',
      'name-primary',
      'name-peak',
      'name-water-point',
      'icon-viewpoint',
      'icon-camp_site',
      'israel-pois-labels',
    ]) {
      expect(currentVisState.get(onSatId), `Expected ${onSatId} visible on satellite`).toBe('visible');
    }
    for (const hiddenId of [
      'background',
      'Terrain',
      'contour-line',
      'area-residential',
      'water-area',
      'building',
      'place-city',
      'rail-dash',
      'tactical-grid-minor',
      'tactical-grid-major',
      'tactical-grid-labels',
    ]) {
      expect(currentVisState.get(hiddenId), `Expected ${hiddenId} hidden on satellite`).toBe('none');
    }
    expect(appliedFilters.length).toBeGreaterThan(0);
    expect(currentVisState.has('active-route-line')).toBe(false);
    expect(currentVisState.has('saved-routes-line')).toBe(false);

    // Disabling POIs while Satellite is ON hides POIs on the ortho map without hiding highways
    currentVisState.clear();
    applyLayerVisibilityToMap(mockMap, {
      ...DEFAULT_LAYER_VISIBILITY,
      googleSatellite: true,
      pois: false,
    });
    expect(currentVisState.get('road-primary')).toBe('visible');
    expect(currentVisState.get('name-peak')).toBe('none');
    expect(currentVisState.get('name-water-point')).toBe('none');
    expect(currentVisState.get('icon-viewpoint')).toBe('none');
    expect(currentVisState.get('icon-camp_site')).toBe('none');
    expect(currentVisState.get('israel-pois-labels')).toBe('none');

    // Toggling Satellite back OFF restores all non-highway layers, tactical grid, and POIs
    currentVisState.clear();
    applyLayerVisibilityToMap(mockMap, DEFAULT_LAYER_VISIBILITY);
    expect(currentVisState.get(GOOGLE_SATELLITE_LAYER_ID)).toBe('none');
    for (const restoredId of [
      'background',
      'Terrain',
      'contour-line',
      'area-residential',
      'water-area',
      'building',
      'place-city',
      'rail-dash',
      'name-peak',
      'name-water-point',
      'icon-viewpoint',
      'icon-camp_site',
      'tactical-grid-minor',
      'tactical-grid-major',
      'tactical-grid-labels',
      'israel-pois-labels',
    ]) {
      expect(currentVisState.get(restoredId), `Expected ${restoredId} restored when satellite OFF`).toBe(
        'visible'
      );
    }
  });

  it('scales highway, road, and dirt track widths 1:1 with ground meters (2^Δz) from zoom 16 to 22 using OSM lanes/ramps', () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    const byId = new Map<string, any>(style.layers.map((l) => [l.id, l]));
    const evalLineProp = (
      layerId: string,
      prop: 'line-width' | 'line-offset',
      props: Record<string, any>,
      zoom: number
    ): number => {
      const layer = byId.get(layerId);
      expect(layer, `Missing layer ${layerId}`).toBeDefined();
      const raw = layer.paint?.[prop];
      expect(raw, `Missing ${prop} on ${layerId}`).toBeDefined();
      const compiled = styleSpec.createPropertyExpression(raw, styleSpec.latest.paint_line[prop]);
      expect(compiled.result, `${layerId}.${prop}: ${JSON.stringify(compiled.errors)}`).toBe('success');
      return compiled.value.evaluate({ zoom }, { type: 2, properties: props });
    };

    // 1. Exact 2^(z - 16) scaling from z16 to z22 across paved roads, tunnels, bridges, tracks, paths, and trails
    const proportionalChecks: Array<{
      id: string;
      prop: 'line-width' | 'line-offset';
      props: Record<string, any>;
    }> = [
      { id: 'road-motorway', prop: 'line-width', props: { class: 'motorway', lanes: 3 } },
      { id: 'layer-1-road-motorway', prop: 'line-width', props: { class: 'motorway', brunnel: 'tunnel', lanes: 2 } },
      { id: 'layer1-road-trunk', prop: 'line-width', props: { class: 'trunk', layer: 1, lanes: 2 } },
      { id: 'layer2-road-primary', prop: 'line-width', props: { class: 'primary', layer: 2, brunnel: 'bridge' } },
      { id: 'road-secondary', prop: 'line-width', props: { class: 'secondary' } },
      { id: 'road-tertiary', prop: 'line-width', props: { class: 'tertiary', oneway: 1 } },
      { id: 'road-minor', prop: 'line-width', props: { class: 'minor' } },
      { id: 'casing-minor', prop: 'line-width', props: { class: 'minor' } },
      { id: 'casing-minor-colour2', prop: 'line-width', props: { class: 'minor', colour: 'red;blue' } },
      { id: 'casing-minor-colour2', prop: 'line-offset', props: { class: 'minor', colour: 'red;blue' } },
      { id: 'casing-track', prop: 'line-width', props: { class: 'track' } },
      { id: 'track-right', prop: 'line-width', props: { class: 'track' } },
      { id: 'track-right', prop: 'line-offset', props: { class: 'track' } },
      { id: 'track-left', prop: 'line-offset', props: { class: 'track' } },
      { id: 'track-left-grade5', prop: 'line-offset', props: { class: 'track', tracktype: 'grade5' } },
      { id: 'layer-1-track-left', prop: 'line-offset', props: { class: 'track', brunnel: 'tunnel' } },
      { id: 'path-path', prop: 'line-width', props: { class: 'path', subclass: 'path' } },
      { id: 'path-cycleway', prop: 'line-width', props: { class: 'path', subclass: 'cycleway' } },
      { id: 'path-steps', prop: 'line-width', props: { class: 'path', subclass: 'steps' } },
      { id: 'rail-casing', prop: 'line-width', props: { class: 'rail' } },
      { id: 'trail-israel-secondary-', prop: 'line-width', props: { class: 'path', is_int: 1 } },
      { id: 'trail-regional-line', prop: 'line-offset', props: { class: 'track' } },
      { id: 'trail-regional-line-purple', prop: 'line-offset', props: { class: 'track' } },
    ];

    for (const check of proportionalChecks) {
      const v16 = evalLineProp(check.id, check.prop, check.props, 16);
      expect(Math.abs(v16)).toBeGreaterThan(0);
      for (const z of [17, 18, 19, 20, 21, 22]) {
        const vz = evalLineProp(check.id, check.prop, check.props, z);
        const expected = v16 * Math.pow(2, z - 16);
        expect(vz, `${check.id}.${check.prop} at z${z}`).toBeCloseTo(expected, 4);
      }
    }

    // 2. Lane-based, ramp, oneway, and service z16 ground calibration (~1.02 m/px at 31.5N)
    const mway2 = evalLineProp('road-motorway', 'line-width', { class: 'motorway', lanes: 2 }, 16);
    const mway4 = evalLineProp('road-motorway', 'line-width', { class: 'motorway', lanes: 4 }, 16);
    const mwayRamp = evalLineProp('road-motorway', 'line-width', { class: 'motorway', ramp: 1 }, 16);
    const mwayDefault = evalLineProp('road-motorway', 'line-width', { class: 'motorway', lanes: null }, 16);
    expect(mway4).toBeGreaterThan(mway2);
    expect(mway2).toBeGreaterThan(mwayRamp);
    expect(mwayDefault).toBeCloseTo(mway2, 4);

    const secDefault = evalLineProp('road-secondary', 'line-width', { class: 'secondary' }, 16);
    const sec3Lanes = evalLineProp('road-secondary', 'line-width', { class: 'secondary', lanes: 3 }, 16);
    expect(secDefault).toBeGreaterThanOrEqual(7);
    expect(sec3Lanes).toBeGreaterThan(secDefault);

    const minor2Way = evalLineProp('road-minor', 'line-width', { class: 'minor' }, 16);
    const minor1Way = evalLineProp('road-minor', 'line-width', { class: 'minor', oneway: 1 }, 16);
    const minorRev1Way = evalLineProp('road-minor', 'line-width', { class: 'minor', oneway: -1 }, 16);
    const serviceRoad = evalLineProp('road-minor', 'line-width', { class: 'service' }, 16);
    expect(minor2Way).toBeGreaterThan(minor1Way);
    expect(minorRev1Way).toBeCloseTo(minor1Way, 4);
    expect(minor1Way).toBeGreaterThan(serviceRoad);
    expect(serviceRoad).toBeCloseTo(4.0, 2);

    // 3. Dirt tracks remain ~4m wide at z16 and keep left/right rails symmetric
    const trackCasing16 = evalLineProp('casing-track', 'line-width', { class: 'track' }, 16);
    const trackRightWidth16 = evalLineProp('track-right', 'line-width', { class: 'track' }, 16);
    const trackRightOff16 = evalLineProp('track-right', 'line-offset', { class: 'track' }, 16);
    const trackLeftOff16 = evalLineProp('track-left', 'line-offset', { class: 'track' }, 16);
    expect(trackCasing16).toBeCloseTo(4.6, 2);
    expect(trackRightOff16 + trackRightWidth16 / 2 - (trackLeftOff16 - trackRightWidth16 / 2)).toBeCloseTo(3.8, 2);
    expect(evalLineProp('track-left', 'line-offset', { class: 'track' }, 22)).toBeCloseTo(
      -evalLineProp('track-right', 'line-offset', { class: 'track' }, 22),
      4
    );

    // 4. Bridge/tunnel hierarchy invariant: box > casing > road fill at z16..z22
    for (const z of [16, 18, 20, 22]) {
      const mFill = evalLineProp('layer1-road-motorway', 'line-width', { class: 'motorway', layer: 1, lanes: 4 }, z);
      const mCasing = evalLineProp('layer1-casing-motorway', 'line-width', { class: 'motorway', layer: 1, lanes: 4 }, z);
      const mBox = evalLineProp('layer1-box-highways', 'line-width', { class: 'motorway', layer: 1, lanes: 4 }, z);
      expect(mCasing).toBeGreaterThan(mFill);
      expect(mBox).toBeGreaterThan(mCasing);

      const sFill = evalLineProp('layer2-road-secondary', 'line-width', { class: 'secondary', layer: 2, brunnel: 'bridge', lanes: 2 }, z);
      const sCasing = evalLineProp('layer2-casing-secondary', 'line-width', { class: 'secondary', layer: 2, brunnel: 'bridge', lanes: 2 }, z);
      const sBox = evalLineProp('layer2-box-paved', 'line-width', { class: 'secondary', layer: 2, brunnel: 'bridge', lanes: 2 }, z);
      expect(sCasing).toBeGreaterThan(sFill);
      expect(sBox).toBeGreaterThan(sCasing);
    }
  });

  it('uses a pure white day map background (#FFFFFF) and omits all farmland-class polygons while keeping wood/grass/beach landcover', () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');
    const dayStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });
    const darkStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: null,
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-dark',
    });

    const dayBg = dayStyle.layers.find((l) => l.id === 'background') as any;
    const darkBg = darkStyle.layers.find((l) => l.id === 'background') as any;
    expect(dayBg?.paint?.['background-color']).toBe('#FFFFFF');
    expect(darkBg?.paint?.['background-color']).toBe('#0b1015');

    const landcoverLayer = dayStyle.layers.find((l) => l.id === 'area-landcover-low') as any;
    expect(landcoverLayer).toBeDefined();
    expect(styleSpec.validateStyleMin(dayStyle)).toEqual([]);

    const filterFn = styleSpec.featureFilter(landcoverLayer.filter);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'farmland', subclass: 'farmland' } })).toBe(false);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'farmland', subclass: 'orchard' } })).toBe(false);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'farmland', subclass: 'vineyard' } })).toBe(false);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'orchard' } })).toBe(false);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'wood', subclass: 'forest' } })).toBe(true);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'grass', subclass: 'meadow' } })).toBe(true);
    expect(filterFn.filter({ zoom: 12 }, { type: 3, properties: { class: 'sand', subclass: 'beach' } })).toBe(true);

    const fillExpr = styleSpec.createPropertyExpression(
      landcoverLayer.paint['fill-color'],
      styleSpec.latest.paint_fill['fill-color']
    ).value;
    expect(fillExpr.evaluate({ zoom: 12 }, { type: 3, properties: { class: 'farmland', subclass: 'farmland' } }).a).toBe(0);
    expect(fillExpr.evaluate({ zoom: 12 }, { type: 3, properties: { class: 'farmland', subclass: 'orchard' } }).a).toBe(0);
    expect(fillExpr.evaluate({ zoom: 12 }, { type: 3, properties: { class: 'wood', subclass: 'forest' } }).a).toBe(1);
    expect(fillExpr.evaluate({ zoom: 12 }, { type: 3, properties: { class: 'grass', subclass: 'meadow' } }).a).toBe(1);
    expect(fillExpr.evaluate({ zoom: 12 }, { type: 3, properties: { class: 'sand', subclass: 'beach' } }).a).toBe(1);
  });
});

describe('Full-Map PMTiles Search Index, Ranking, Coordinates & Runtime Extraction', () => {
  const loadBundledTestPois = (): PoiRecord[] => {
    const raw = JSON.parse(fs.readFileSync('data/Israel.pois.geojson', 'utf8'));
    return (raw.features || []).map((f: any) => {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates || [34.8, 30.8];
      return {
        id: String(p.id || f.id),
        name: p.nameHe || p.name || '',
        nameHe: p.nameHe || p.name || '',
        nameEn: p.nameEn || p.name || '',
        category: p.category || 'heritage',
        subcategory: p.subcategory || 'poi',
        lon: Number(coords[0]),
        lat: Number(coords[1]),
        ele: typeof p.ele === 'number' ? p.ele : null,
        waterStatus: p.waterStatus || null,
        difficulty4x4: p.difficulty4x4 || null,
        descHe: p.descHe || '',
        descEn: p.descEn || '',
        source: p.source || 'IsraelHiking / OSM',
        wikipedia: p.wikipedia || null,
      };
    });
  };

  it('indexes all searchable PMTiles layers inside Israel.search.idx with fingerprint matching Israel.osm.pmtiles', async () => {
    expect(fs.existsSync('public/data/Israel.search.idx')).toBe(false);
    if (!fs.existsSync('data/Israel.search.idx')) return;
    const idxBytes = fs.readFileSync('data/Israel.search.idx');
    const payload = await parseSearchIndexBytes(idxBytes, {
      gunzip: async (b) => new Uint8Array(zlib.gunzipSync(b)),
    });

    expect(payload.totalFeatures).toBeGreaterThan(130_000);
    expect(payload.layers).toEqual(
      expect.arrayContaining([
        'place',
        'admin_area',
        'mountain_peak',
        'park',
        'aerodrome_label',
        'water',
        'flood_defence',
        'poi',
        'road',
        'aeroway',
      ])
    );

    if (fs.existsSync('data/Israel.osm.pmtiles')) {
      const fd = fs.openSync('data/Israel.osm.pmtiles', 'r');
      try {
        const pmtiles = new PMTiles({
          getKey: () => 'data/Israel.osm.pmtiles',
          async getBytes(offset, length) {
            const buf = Buffer.allocUnsafe(length);
            const n = fs.readSync(fd, buf, 0, length, offset);
            return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) };
          },
        });
        const header = await pmtiles.getHeader();
        expect(payload.fingerprint).toBe(getPmtilesArchiveFingerprint(header));
      } finally {
        fs.closeSync(fd);
      }
    } else {
      expect(typeof payload.fingerprint).toBe('string');
      expect(payload.fingerprint.length).toBeGreaterThan(0);
    }

    // Tel Aviv-Yafo city cluster must deduplicate to a single place:city entry
    const placeLayerIdx = payload.layers.indexOf('place');
    const cityClsIdx = payload.classes.indexOf('city');
    const tlvCities = payload.rows.filter(
      (r) =>
        r[0] === placeLayerIdx &&
        r[1] === cityClsIdx &&
        normalizeSearchText(r[4]) === 'תל אביב יפו'
    );
    expect(tlvCities).toHaveLength(1);
  });

  it('ranks cities, peaks, rivers, 4x4 tracks, highways, and multi-token name+locality queries accurately & quickly', async () => {
    if (!fs.existsSync('data/Israel.search.idx') || !fs.existsSync('data/Israel.pois.geojson')) {
      return;
    }
    const idxBytes = fs.readFileSync('data/Israel.search.idx');
    const payload = await parseSearchIndexBytes(idxBytes, {
      gunzip: async (b) => new Uint8Array(zlib.gunzipSync(b)),
    });
    const service = new PMTilesSearchService();
    service.loadPayload(payload, 'bundled');

    const pois = loadBundledTestPois();
    const refCenter = { lon: 34.8134, lat: 30.8281 };

    const t0 = performance.now();
    const jerusalem = service.search('ירושלים', { pois, referenceCoord: refCenter });
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(350);
    const tWarm = performance.now();
    service.search('ירושלים', { pois, referenceCoord: refCenter });
    expect(performance.now() - tWarm).toBeLessThan(150);
    expect(jerusalem[0].title).toBe('ירושלים');
    expect(jerusalem[0].filterGroup).toBe('places');

    // Dash/maqaf normalization: תל אביב / תל-אביב יפו / תל אביב–יפו
    for (const q of ['תל אביב', 'תל-אביב יפו', 'תל אביב–יפו']) {
      const hits = service.search(q, { pois, referenceCoord: refCenter });
      expect(hits[0].title).toContain('תל אביב');
      expect(hits[0].filterGroup).toBe('places');
    }

    // Geresh/gershayim normalization & airport alias
    const airportHits = service.search('נתב"ג', { pois, referenceCoord: refCenter });
    expect(airportHits.some((h) => h.title.includes('בן-גוריון') || h.ref.includes('LLBG'))).toBe(true);
    expect(airportHits.some((h) => h.title.includes('נתב'))).toBe(true);

    // Airport IATA / dash normalization
    const llbgHits = service.search('נמל התעופה בן גוריון', { pois });
    expect(llbgHits[0].ref).toContain('LLBG');

    // Iconic outdoor highlights outrank bus stops & municipal residential streets
    const einAkev = service.search('עין עקב', { pois, referenceCoord: refCenter });
    expect(einAkev[0].kind).toBe('curated-poi');
    expect(einAkev[0].title).toContain('עין עקב');

    const meron = service.search('הר מירון', { pois, referenceCoord: refCenter });
    expect(meron.some((h) => h.title.includes('הר מירון') && h.poiCategory === 'peak')).toBe(true);
    expect(meron[0].categoryLabel).not.toBe('תחנת אוטובוס');

    const tzin = service.search('נחל צין', { filter: 'nature', pois, referenceCoord: refCenter });
    expect(tzin.length).toBeGreaterThan(0);
    expect(tzin[0].title).toContain('נחל צין');

    const maaleZik = service.search('מעלה זיק', { pois, referenceCoord: refCenter });
    expect(maaleZik[0].title).toContain('מעלה זיק');

    // Highway ref matching: "כביש 6" prioritizes motorway ref="6" over Highway 60
    const hwy6 = service.search('כביש 6', { filter: 'roads', pois, referenceCoord: refCenter });
    expect(hwy6.length).toBeGreaterThan(0);
    expect(hwy6[0].ref).toBe('6');

    // Low-zoom-only airbases (Nevatim & Hatzerim) must be indexed
    const hatzerimAirbase = service.search('בסיס חיל האויר חצרים', { pois });
    expect(hatzerimAirbase.some((h) => h.ref.includes('LLHB'))).toBe(true);
    const nevatimAirbase = service.search('נבטים', { pois });
    expect(nevatimAirbase.some((h) => h.ref.includes('LLNV'))).toBe(true);
    expect(service.search('LLNV', { pois })[0].ref).toContain('LLNV');

    // Multi-token "street + locality" (with and without Hebrew 'ב' preposition)
    const herzlHaifa = service.search('הרצל חיפה', { pois });
    expect(herzlHaifa.length).toBeGreaterThan(0);
    expect(herzlHaifa[0].locality).toBe('חיפה');

    const herzlTlv = service.search('הרצל בתל אביב', { pois });
    expect(herzlTlv.length).toBeGreaterThan(0);
    expect(herzlTlv[0].locality).toContain('תל אביב');

    // Category + locality semantic query ("דלק חיפה" finds gas stations in Haifa)
    const fuelHaifa = service.search('דלק חיפה', { pois });
    expect(fuelHaifa.length).toBeGreaterThan(0);
    expect(fuelHaifa[0].locality).toBe('חיפה');

    // Filter tabs isolate routes & places properly
    const sampleRoute: SavedRouteRecord = {
      id: 'route-test-ramon',
      name: 'סובב מכתש רמון ציר צפוני',
      sourceFormat: 'planned',
      distanceKm: 18.4,
      ascentMeters: 420,
      descentMeters: 410,
      minEle: 380,
      maxEle: 820,
      color: '#2563eb',
      visible: true,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.801, 30.61],
                [34.88, 30.63],
              ],
            },
          },
        ],
      },
      elevationProfile: [
        { distKm: 0, ele: 650, lon: 34.801, lat: 30.61 },
        { distKm: 18.4, ele: 510, lon: 34.88, lat: 30.63 },
      ],
      createdAt: new Date().toISOString(),
    };
    const routeHits = service.search('', { filter: 'routes', routes: [sampleRoute] });
    expect(routeHits).toHaveLength(1);
    expect(routeHits[0].kind).toBe('route');
    expect(routeHits[0].routeRecord?.id).toBe('route-test-ramon');

    const placesOnly = service.search('ירושלים', { filter: 'places', pois });
    expect(placesOnly.every((r) => r.filterGroup === 'places')).toBe(true);
  });

  it('parses WGS84 coords, swaps Israel lon/lat, and round-trips IDF 8-digit & 12-digit ITM grid searches', () => {
    const service = new PMTilesSearchService();

    // Forward -> Inverse 12-digit ITM accuracy (< 5m)
    const sampleLon = 34.8134;
    const sampleLat = 30.8281;
    const mil = MilitaryGridService.toMilitaryCoords(sampleLon, sampleLat);
    const inv = MilitaryGridService.itmToWgs84(mil.itmEasting, mil.itmNorthing);
    expect(Math.abs(inv.lon - sampleLon)).toBeLessThan(0.0001);
    expect(Math.abs(inv.lat - sampleLat)).toBeLessThan(0.0001);

    // 8-digit IDF tactical grid search ("1813-5828" or formatted grid)
    const idfHits = service.search(mil.idfGrid8Digit);
    expect(idfHits[0].kind).toBe('coord');
    expect(Math.abs(idfHits[0].lon - sampleLon)).toBeLessThan(0.002);
    expect(Math.abs(idfHits[0].lat - sampleLat)).toBeLessThan(0.002);

    // Decimal WGS84 (standard lat, lon AND swapped lon, lat in Israel bounds)
    const wgsHits = service.search('31.7683, 35.2137');
    expect(wgsHits[0].kind).toBe('coord');
    expect(wgsHits[0].lat).toBeCloseTo(31.7683, 4);
    expect(wgsHits[0].lon).toBeCloseTo(35.2137, 4);

    const swappedHits = service.search('34.8134, 30.8281');
    expect(swappedHits[0].kind).toBe('coord');
    expect(swappedHits[0].lat).toBeCloseTo(30.8281, 4);
    expect(swappedHits[0].lon).toBeCloseTo(34.8134, 4);

    // 12-digit ITM meters
    const itmQuery = `${mil.itmEasting} / ${mil.itmNorthing}`;
    const itmHits = service.search(itmQuery);
    expect(itmHits[0].kind).toBe('coord');
    expect(Math.abs(itmHits[0].lon - sampleLon)).toBeLessThan(0.0001);
    expect(Math.abs(itmHits[0].lat - sampleLat)).toBeLessThan(0.0001);
  });

  it('extracts, serializes, and parses runtime vector tiles from PMTiles cleanly', async () => {
    const fd = fs.openSync('data/Israel.osm.pmtiles', 'r');
    try {
      const pmtiles = new PMTiles({
        getKey: () => 'data/Israel.osm.pmtiles',
        async getBytes(offset, length) {
          const buf = Buffer.allocUnsafe(length);
          const n = fs.readSync(fd, buf, 0, length, offset);
          return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) };
        },
      });
      // Center of Jerusalem at z14: x=9794, y=6672
      const tileResp = await pmtiles.getZxy(14, 9794, 6672);
      expect(tileResp?.data).toBeDefined();
      const rawBytes = new Uint8Array(tileResp!.data);
      const mvtBytes =
        rawBytes[0] === 0x1f && rawBytes[1] === 0x8b
          ? new Uint8Array(zlib.gunzipSync(rawBytes))
          : rawBytes;
      const vt = new VectorTile(new PbfReader(mvtBytes));
      const records = extractRawRecordsFromVectorTile(vt, 14, 9794, 6672);
      expect(records.length).toBeGreaterThan(20);

      const builder = new SearchIndexBuilder({ fingerprint: 'runtime-test-fp' });
      builder.ingestRecords(records);
      const payload = builder.buildPayload();
      expect(payload.totalFeatures).toBeGreaterThan(10);

      const compressed = await serializeSearchIndexPayload(payload, {
        gzip: true,
        gzipFn: async (b) => new Uint8Array(zlib.gzipSync(b)),
      });
      const parsed = await parseSearchIndexBytes(compressed, {
        gunzip: async (b) => new Uint8Array(zlib.gunzipSync(b)),
      });
      expect(parsed.fingerprint).toBe('runtime-test-fp');
      expect(parsed.totalFeatures).toBe(payload.totalFeatures);
    } finally {
      fs.closeSync(fd);
    }
  });

  it('streams continuous GPS position fixes via LiveGpsService and cleans up watch on stop', () => {
    expect(
      normalizeGpsPosition({
        timestamp: 1700000000000,
        coords: {
          longitude: 35.2137,
          latitude: 31.7683,
          accuracy: 6.5,
          altitude: 785,
          heading: 45,
          speed: 1.4,
        },
      })
    ).toEqual({
      lon: 35.2137,
      lat: 31.7683,
      accuracy: 6.5,
      altitude: 785,
      heading: 45,
      speed: 1.4,
      timestamp: 1700000000000,
    });
    expect(normalizeGpsPosition({ coords: { longitude: Number.NaN, latitude: 31.7 } })).toBeNull();

    const origNavigator = (globalThis as any).navigator;
    const activeCbs: Array<(pos: any) => void> = [];
    const clearWatchSpy = vi.fn();
    const watchPositionSpy = vi.fn((successCb: (pos: any) => void, _errorCb?: any, _opts?: any) => {
      activeCbs.push(successCb);
      return 42;
    });

    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          geolocation: {
            watchPosition: watchPositionSpy,
            clearWatch: clearWatchSpy,
          },
        },
      });

      const received: LiveGpsFix[] = [];
      const stop = LiveGpsService.startContinuousWatch((fix) => {
        received.push(fix);
      });

      expect(watchPositionSpy).toHaveBeenCalledTimes(1);
      expect(watchPositionSpy.mock.calls[0][2]).toMatchObject({
        enableHighAccuracy: true,
        maximumAge: 0,
      });

      activeCbs[0]?.({
        timestamp: 1000,
        coords: { longitude: 34.81, latitude: 30.83, heading: 90 },
      });
      activeCbs[0]?.({
        timestamp: 2000,
        coords: { longitude: 34.811, latitude: 30.831, heading: 92 },
      });
      activeCbs[0]?.({
        timestamp: 3000,
        coords: { longitude: 34.812, latitude: 30.832, heading: 95 },
      });

      expect(received).toHaveLength(3);
      expect(received[0]).toMatchObject({ lon: 34.81, lat: 30.83, heading: 90 });
      expect(received[2]).toMatchObject({ lon: 34.812, lat: 30.832, heading: 95 });

      stop();
      expect(clearWatchSpy).toHaveBeenCalledWith(42);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNavigator,
      });
    }
  });

  it('prefers NativeGps on Android native with fixAgeMs and uses short active interval if falling back to Geolocation', async () => {
    expect(
      normalizeGpsPosition({
        timestamp: 1700000000000,
        fixAgeMs: 240,
        coords: {
          longitude: 34.91,
          latitude: 31.90,
          accuracy: 5,
          altitude: 120,
          heading: 180,
          speed: 29.5,
        },
      })
    ).toEqual({
      lon: 34.91,
      lat: 31.90,
      accuracy: 5,
      altitude: 120,
      heading: 180,
      speed: 29.5,
      timestamp: 1700000000000,
      fixAgeMs: 240,
    });

    const isNativeSpy = vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    const platformSpy = vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    const availSpy = vi.spyOn(Capacitor, 'isPluginAvailable').mockReturnValue(true);
    const capPlugins = (Capacitor as any).Plugins as Record<string, any>;
    const origNativeGps = capPlugins.NativeGps;
    const origGeo = capPlugins.Geolocation;

    try {
      // 1. Primary path: NativeGps is used directly with 500ms interval and fixAgeMs preserved
      const nativeWatchSpy = vi.fn(async (_opts: any, cb: any) => {
        cb({
          timestamp: 5000,
          fixAgeMs: 165,
          coords: { longitude: 34.91, latitude: 31.91, accuracy: 4, speed: 30, heading: 0 },
        });
        return 'native-watch-1';
      });
      const nativeClearSpy = vi.fn(async () => {});
      capPlugins.NativeGps = {
        checkPermissions: vi.fn(async () => ({ location: 'granted' })),
        requestPermissions: vi.fn(async () => ({ location: 'granted' })),
        getCurrentPosition: vi.fn(async () => {
          throw new Error('no seed');
        }),
        watchPosition: nativeWatchSpy,
        clearWatch: nativeClearSpy,
      };
      capPlugins.Geolocation = {
        checkPermissions: vi.fn(async () => ({ location: 'granted' })),
        watchPosition: vi.fn(async () => 'geo-should-not-run'),
        clearWatch: vi.fn(async () => {}),
      };

      const fixes1: LiveGpsFix[] = [];
      const stop1 = LiveGpsService.startContinuousWatch((f) => fixes1.push(f), undefined, {
        timeout: 10000,
        minimumUpdateInterval: 500,
      });
      await vi.waitFor(() => expect(fixes1).toHaveLength(1));
      expect(nativeWatchSpy).toHaveBeenCalledTimes(1);
      expect(fixes1[0]).toMatchObject({ speed: 30, fixAgeMs: 165 });
      stop1();
      await vi.waitFor(() => expect(nativeClearSpy).toHaveBeenCalledWith({ id: 'native-watch-1' }));

      // 2. Fallback path: NativeGps UNIMPLEMENTED -> Geolocation receives short timeout (500ms, NOT 10000ms)
      const geoWatchSpy = vi.fn(async (_opts: any, cb: any) => {
        cb({
          timestamp: 6000,
          coords: { longitude: 34.92, latitude: 31.92, accuracy: 6, speed: 25, heading: 10 },
        });
        return 'geo-watch-2';
      });
      const geoClearSpy = vi.fn(async () => {});
      capPlugins.NativeGps = {
        checkPermissions: vi.fn(async () => {
          throw { code: 'UNIMPLEMENTED', message: 'not implemented' };
        }),
      };
      capPlugins.Geolocation = {
        checkPermissions: vi.fn(async () => ({ location: 'granted' })),
        requestPermissions: vi.fn(async () => ({ location: 'granted' })),
        getCurrentPosition: vi.fn(async () => {
          throw new Error('no seed');
        }),
        watchPosition: geoWatchSpy,
        clearWatch: geoClearSpy,
      };

      const fixes2: LiveGpsFix[] = [];
      const stop2 = LiveGpsService.startContinuousWatch((f) => fixes2.push(f), undefined, {
        timeout: 10000,
        minimumUpdateInterval: 500,
      });
      await vi.waitFor(() => expect(fixes2).toHaveLength(1));
      expect(geoWatchSpy).toHaveBeenCalledTimes(1);
      expect(geoWatchSpy.mock.calls[0][0]).toMatchObject({
        timeout: 500,
        minimumUpdateInterval: 500,
      });
      stop2();
      await vi.waitFor(() => expect(geoClearSpy).toHaveBeenCalledWith({ id: 'geo-watch-2' }));
    } finally {
      capPlugins.NativeGps = origNativeGps;
      capPlugins.Geolocation = origGeo;
      isNativeSpy.mockRestore();
      platformSpy.mockRestore();
      availSpy.mockRestore();
    }
  });

  it('acquires Screen Wake Lock during navigation and releases cleanly on exit', async () => {
    const origNavigator = (globalThis as any).navigator;
    const releaseSpy = vi.fn(async () => {});
    const requestSpy = vi.fn(async () => ({
      released: false,
      release: releaseSpy,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          wakeLock: {
            request: requestSpy,
          },
        },
      });

      const states: boolean[] = [];
      const stopWakeLock = ScreenWakeLockService.acquireNavigationWakeLock((active) => {
        states.push(active);
      });

      await Promise.resolve();
      await Promise.resolve();

      expect(requestSpy).toHaveBeenCalledWith('screen');
      expect(states).toEqual([true]);

      stopWakeLock();
      await Promise.resolve();

      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(states).toEqual([true, false]);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNavigator,
      });
    }
  });

  it('bundles web-fetched outdoor SVG icons offline, sanitizes SVG markup, and searches web icons', async () => {
    // Verify all 15 web-fetched SVG icons exist in public/assets/user-icons/
    const svgIcons = BUILT_IN_USER_ICONS.filter((i) => i.id !== 'gps-puck');
    expect(svgIcons.length).toBeGreaterThanOrEqual(15);
    for (const icon of svgIcons) {
      const diskPath = `public${icon.svgUrl}`;
      expect(fs.existsSync(diskPath), `Missing ${diskPath}`).toBe(true);
      const content = fs.readFileSync(diskPath, 'utf-8');
      expect(content).toContain('<svg');
    }

    // Verify SVG sanitizer strips scripts/event handlers while forcing crisp white badge rendering
    const cleaned = sanitizeSvgMarkup(
      '<svg viewBox="0 0 24 24" onclick="alert(1)"><script>evil()</script><path d="M0 0"/></svg>'
    );
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('onclick');
    expect(cleaned).toContain('color:#ffffff');

    // Verify web icon search parses Iconify API response cleanly
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ icons: ['tabler:helicopter', 'mdi:kayak'] }),
      })) as any;

      const results = await UserLocationIconService.searchWebIcons('helicopter');
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        id: 'web-tabler-helicopter',
        category: 'web',
        svgUrl: 'https://api.iconify.design/tabler/helicopter.svg?width=32&height=32',
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    // Verify sanitizeSvgMarkup strips leading XML declaration & defaults monochrome icons to currentColor
    const xmlIcon = sanitizeSvgMarkup('<?xml version="1.0"?><svg viewBox="0 0 24 24"><path d="M1 1h5"/></svg>');
    expect(xmlIcon.startsWith('<svg')).toBe(true);
    expect(xmlIcon).toContain('fill="currentColor"');
    const strokeIcon = sanitizeSvgMarkup('<svg fill="none" viewBox="0 0 24 24"><path d="M1 1h5"/></svg>');
    expect(strokeIcon).toContain('fill="none"');
  });

  it('preserves MapLibre marker positioning classes, avoids full DOM teardown on ticks, and injects SVG icons', async () => {
    const origDocument = (globalThis as any).document;

    class MockClassList {
      private set = new Set<string>();
      constructor(private syncToOwner: () => void) {}
      loadFromString(str: string) {
        this.set = new Set(str.split(/\s+/).filter(Boolean));
      }
      toString() {
        return Array.from(this.set).join(' ');
      }
      add(...tokens: string[]) {
        for (const t of tokens) if (t) this.set.add(t);
        this.syncToOwner();
      }
      remove(...tokens: string[]) {
        for (const t of tokens) this.set.delete(t);
        this.syncToOwner();
      }
      contains(token: string) {
        return this.set.has(token);
      }
    }

    class MockElement {
      private _className = '';
      classList: MockClassList;
      dataset: Record<string, string> = {};
      style: Record<string, string> = {};
      children: MockElement[] = [];
      private attrs = new Map<string, string>();
      private _innerHTML = '';

      constructor(public tagName: string) {
        this.classList = new MockClassList(() => {
          this._className = this.classList.toString();
        });
      }
      get className() {
        return this._className;
      }
      set className(val: string) {
        this._className = val;
        this.classList.loadFromString(val);
      }
      get innerHTML() {
        return this._innerHTML;
      }
      set innerHTML(val: string) {
        this._innerHTML = val;
        if (val === '') this.children = [];
      }
      appendChild(child: MockElement) {
        this.children.push(child);
        return child;
      }
      contains(target: MockElement): boolean {
        if (target === this) return true;
        return this.children.some((c) => c.contains(target));
      }
      setAttribute(k: string, v: string) {
        this.attrs.set(k, v);
      }
      getAttribute(k: string) {
        return this.attrs.get(k) ?? null;
      }
      querySelector(selector: string): MockElement | null {
        const m = /^\[data-role="([^"]+)"\]$/.exec(selector);
        if (!m) return null;
        const role = m[1];
        const visit = (node: MockElement): MockElement | null => {
          for (const ch of node.children) {
            if (ch.dataset.role === role) return ch;
            const nested = visit(ch);
            if (nested) return nested;
          }
          return null;
        };
        return visit(this);
      }
    }

    try {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          createElement: (tag: string) => new MockElement(tag),
        },
      });

      const root = new MockElement('div');
      root.className = 'maplibregl-marker maplibregl-marker-anchor-center';

      const iconWithInlineSvg = {
        ...BUILT_IN_USER_ICONS[1],
        inlineSvg: '<svg viewBox="0 0 24 24"><path d="M5 5h10"/></svg>',
      };
      const pref = { icon: iconWithInlineSvg, accentColor: '#10b981' };

      UserLocationIconService.renderMarkerElement(root as unknown as HTMLElement, pref, 45);

      expect(root.classList.contains('maplibregl-marker')).toBe(true);
      expect(root.classList.contains('maplibregl-marker-anchor-center')).toBe(true);
      expect(root.classList.contains('relative')).toBe(false);
      expect(root.style.position).toBe('absolute');
      expect(root.style.top).toBe('0');
      expect(root.style.left).toBe('0');
      expect(root.style.zIndex).toBe('20');
      expect(root.style.width).toBe('76px');
      expect(root.style.height).toBe('76px');

      const innerContainer = root.children[0];
      expect(innerContainer.classList.contains('relative')).toBe(true);

      const headingWrap = (root as unknown as HTMLElement).querySelector('[data-role="heading"]') as any;
      expect(headingWrap).not.toBeNull();
      expect(headingWrap.style.display).toBe('flex');
      expect(headingWrap.style.transform).toBe('rotate(45deg)');

      const badge = (root as unknown as HTMLElement).querySelector('[data-role="badge"]') as any;
      expect(badge).not.toBeNull();
      expect(badge.children[0].innerHTML).toContain('color:#ffffff');
      // car-4wd has rotateWithHeading: true so badge turns along heading
      expect(badge.style.transform).toBe('rotate(45deg)');

      // Second 1s GPS tick in Heading-Up (mapBearing === heading) points beam/badge straight up (0deg) without recreating DOM subtree
      UserLocationIconService.renderMarkerElement(root as unknown as HTMLElement, pref, 135, 135, true);
      expect(root.children[0]).toBe(innerContainer);
      expect(headingWrap.style.transform).toBe('rotate(0deg)');
      expect(badge.style.transform).toBe('rotate(0deg)');
      expect(root.classList.contains('maplibregl-marker')).toBe(true);

      // North-Up (mapBearing 0deg, heading 135deg) turns cone and rotating icon to 135deg
      UserLocationIconService.updateMarkerDirection(root as unknown as HTMLElement, pref, 135, 0, true);
      expect(headingWrap.style.transform).toBe('rotate(135deg)');
      expect(badge.style.transform).toBe('rotate(135deg)');

      // Default gps-puck shows directional chevron inside badge during navigation and dot when stationary without heading
      const puckRoot = new MockElement('div');
      const puckPref = { icon: BUILT_IN_USER_ICONS[0], accentColor: '#0ea5e9' };
      UserLocationIconService.renderMarkerElement(puckRoot as unknown as HTMLElement, puckPref, 90, 0, true);
      expect(puckRoot.style.width).toBe('72px');
      const puckCoreDot = (puckRoot as unknown as HTMLElement).querySelector('[data-role="puck-core-dot"]') as any;
      const puckNavArrow = (puckRoot as unknown as HTMLElement).querySelector('[data-role="puck-nav-arrow"]') as any;
      const puckBadge = (puckRoot as unknown as HTMLElement).querySelector('[data-role="badge"]') as any;
      expect(puckCoreDot.style.display).toBe('none');
      expect(puckNavArrow.style.display).toBe('flex');
      expect(puckBadge.style.transform).toBe('rotate(90deg)');

      // Side-view icon (car-suv, rotateWithHeading: false) turns directional beam while badge remains upright
      const suvRoot = new MockElement('div');
      const suvIcon = BUILT_IN_USER_ICONS.find((i) => i.id === 'car-suv')!;
      const suvPref = {
        icon: { ...suvIcon, inlineSvg: '<svg viewBox="0 0 24 24"><path d="M2 2h8"/></svg>' },
        accentColor: '#f59e0b',
      };
      UserLocationIconService.renderMarkerElement(suvRoot as unknown as HTMLElement, suvPref, 120, 0, true);
      const suvHeading = (suvRoot as unknown as HTMLElement).querySelector('[data-role="heading"]') as any;
      const suvBadge = (suvRoot as unknown as HTMLElement).querySelector('[data-role="badge"]') as any;
      expect(suvHeading.style.transform).toBe('rotate(120deg)');
      expect(suvBadge.style.transform).toBe('');
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: origDocument,
      });
    }
  });

  it('seeds fast initial GPS location and falls back to coarse watch indoors before primary fix arrives', () => {
    const origNavigator = (globalThis as any).navigator;
    const seedSuccessCbs: Array<(pos: any) => void> = [];
    const watchCallbacks: Array<{ success: (pos: any) => void; error?: (err: any) => void }> = [];
    const clearWatchSpy = vi.fn();

    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          geolocation: {
            getCurrentPosition: vi.fn((successCb: (pos: any) => void) => {
              seedSuccessCbs.push(successCb);
            }),
            watchPosition: vi.fn((successCb: (pos: any) => void, errorCb?: (err: any) => void) => {
              watchCallbacks.push({ success: successCb, error: errorCb });
              return watchCallbacks.length * 10;
            }),
            clearWatch: clearWatchSpy,
          },
        },
      });

      const fixes: LiveGpsFix[] = [];
      const errors: any[] = [];
      const stop = LiveGpsService.startContinuousWatch(
        (fix) => fixes.push(fix),
        (err) => errors.push(err)
      );

      // Immediate coarse seed resolves while primary GPS warms up
      seedSuccessCbs[0]?.({ timestamp: 100, coords: { longitude: 34.78, latitude: 32.08 } });
      expect(fixes).toHaveLength(1);
      expect(fixes[0]).toMatchObject({ lon: 34.78, lat: 32.08 });

      // Primary high-accuracy timeout spawns coarse watch fallback without false error
      watchCallbacks[0].error?.({ code: 3, message: 'Timeout' });
      expect(errors).toHaveLength(0);
      expect(watchCallbacks).toHaveLength(2);

      // Coarse fallback keeps updating position
      watchCallbacks[1].success({ timestamp: 200, coords: { longitude: 34.79, latitude: 32.09 } });
      expect(fixes).toHaveLength(2);

      // Primary high-accuracy fix takes over and clears coarse fallback watch (id 20)
      watchCallbacks[0].success({ timestamp: 300, coords: { longitude: 34.8, latitude: 32.1 } });
      expect(fixes).toHaveLength(3);
      expect(clearWatchSpy).toHaveBeenCalledWith(20);

      // Late seed is ignored once primary fix arrived
      seedSuccessCbs[0]?.({ timestamp: 400, coords: { longitude: 34.0, latitude: 31.0 } });
      expect(fixes).toHaveLength(3);

      stop();
      expect(clearWatchSpy).toHaveBeenCalledWith(10);
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNavigator,
      });
    }
  });

  it('defaults navigation orientation to heading-up, switches cleanly to north-up, and resolves live heading + screen arrow rotation', () => {
    const origWindow = (globalThis as any).window;
    const store = new Map<string, string>();
    try {
      (globalThis as any).window = {
        localStorage: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => store.set(k, v),
        },
      };

      expect(DEFAULT_NAV_ORIENTATION).toBe('heading-up');
      expect(NavigationHeadingService.getOrientationPreference()).toBe('heading-up');

      NavigationHeadingService.setOrientationPreference('north-up');
      expect(NavigationHeadingService.getOrientationPreference()).toBe('north-up');
      NavigationHeadingService.setOrientationPreference('heading-up');
      expect(NavigationHeadingService.getOrientationPreference()).toBe('heading-up');

      // Shortest wrap-around delta & smoothing across 355 <-> 5 deg North seam
      expect(shortestAngleDeltaDeg(355, 5)).toBe(10);
      expect(shortestAngleDeltaDeg(5, 355)).toBe(-10);
      expect(smoothHeadingDeg(355, 5, 0.5)).toBe(0);
      expect(smoothHeadingDeg(10, 350, 0.5)).toBe(0);

      // Screen rotation: heading-up (mapBearing == worldHeading => 0deg straight ahead), north-up (mapBearing == 0 => worldHeading)
      expect(computeScreenRotationDeg(90, 90)).toBe(0);
      expect(computeScreenRotationDeg(90, 0)).toBe(90);
      expect(computeScreenRotationDeg(350, 30)).toBe(320);

      // Course bearing: ignores < 3m jitter and returns cardinal azimuths
      expect(computeBearingBetweenCoords(34.8, 30.8, 34.80001, 30.80001, 3)).toBeNull();
      const northDeg = computeBearingBetweenCoords(34.8, 30.8, 34.8, 30.802, 3);
      const eastDeg = computeBearingBetweenCoords(34.8, 30.8, 34.802, 30.8, 3);
      const southDeg = computeBearingBetweenCoords(34.8, 30.802, 34.8, 30.8, 3);
      expect(northDeg).toBeCloseTo(0, 1);
      expect(eastDeg!).toBeGreaterThan(89);
      expect(eastDeg!).toBeLessThan(91);
      expect(southDeg).toBeCloseTo(180, 1);

      // Sensor fusion hierarchy: GPS while moving -> Compass while stationary -> sticky last heading -> route tangent
      const now = 1_000_000;
      expect(
        NavigationHeadingService.resolveActiveHeading({
          gpsFixHeading: 120,
          gpsSpeedMps: 3.5,
          computedCourseHeading: 118,
          compassHeading: 240,
          lastValidHeading: 300,
          routeFallbackHeading: 10,
          nowMs: now,
          gpsUpdatedAtMs: now - 500,
          compassUpdatedAtMs: now - 200,
        })
      ).toBe(120);

      expect(
        NavigationHeadingService.resolveActiveHeading({
          gpsFixHeading: 120,
          gpsSpeedMps: 0.1,
          computedCourseHeading: null,
          compassHeading: 245,
          lastValidHeading: 120,
          routeFallbackHeading: 10,
          nowMs: now,
          gpsUpdatedAtMs: now - 500,
          compassUpdatedAtMs: now - 200,
        })
      ).toBe(245);

      const sampleRoute: SavedRouteRecord = {
        id: 'route-heading-test',
        name: 'East Trail',
        distanceKm: 1.5,
        ascentMeters: 20,
        descentMeters: 10,
        minEle: 300,
        maxEle: 320,
        visible: true,
        sourceFormat: 'planned',
        color: '#2563eb',
        createdAt: new Date(now).toISOString(),
        elevationProfile: [],
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: [
                  [34.8, 30.8],
                  [34.81, 30.8],
                ],
              },
            },
          ],
        },
      };
      const tangent = extractRouteTangentHeading(sampleRoute, 34.8, 30.8);
      expect(tangent).not.toBeNull();
      expect(tangent!).toBeCloseTo(90, 0);

      expect(
        NavigationHeadingService.resolveActiveHeading({
          gpsFixHeading: null,
          gpsSpeedMps: null,
          computedCourseHeading: null,
          compassHeading: null,
          lastValidHeading: null,
          routeFallbackHeading: tangent,
          nowMs: now,
        })
      ).toBeCloseTo(90, 0);
    } finally {
      (globalThis as any).window = origWindow;
    }
  });

  it('classifies outdoor OSM POIs accurately, excludes urban streets/transit, and enforces Israel + Golan + Judea & Samaria boundary', async () => {
    // @ts-expect-error Node MJS devops script lacks .d.ts declaration
    const harvester: any = await import('../../../devops/fetch-israel-pois.mjs');
    const { classifyOsmElement, computePoiPriority, createIsraelBoundaryChecker } = harvester;

    // Urban residential street starting with "מעלה " MUST be rejected; 4x4 track accepted
    expect(
      classifyOsmElement({
        type: 'way',
        id: 1001,
        tags: { highway: 'residential', name: 'מעלה השלום' },
      })
    ).toBeNull();
    expect(
      classifyOsmElement({
        type: 'way',
        id: 1002,
        tags: { highway: 'track', name: 'מעלה זיק', tracktype: 'grade5' },
      })
    ).toMatchObject({ category: 'offroad', subcategory: '4x4_pass', nameHe: 'מעלה זיק' });

    // Public transit shelters, urban speed camera hazards, and unnamed ruins must be rejected
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1003,
        tags: { amenity: 'shelter', shelter_type: 'public_transport', name: 'תחנת אוטובוס' },
      })
    ).toBeNull();
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1004,
        tags: { hazard: 'speed_camera', name: 'מצלמה' },
      })
    ).toBeNull();
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1005,
        tags: { historic: 'ruins' },
      })
    ).toBeNull();
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1008,
        tags: { ford: 'yes' },
      })
    ).toBeNull();
    expect(
      classifyOsmElement({
        type: 'way',
        id: 1009,
        tags: { ford: 'yes', highway: 'secondary', name: 'שדרות שמואל מאיר' },
      })
    ).toBeNull();
    expect(
      classifyOsmElement({
        type: 'way',
        id: 1010,
        tags: { historic: 'archaeological_site', barrier: 'wall', name: 'תל אפק' },
      })
    ).toMatchObject({ category: 'heritage', subcategory: 'archaeological_site', nameHe: 'תל אפק' });
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1011,
        tags: { amenity: 'shelter', name: 'מקלט ציבורי 4' },
      })
    ).toBeNull();

    // Springs, desert cisterns, and named ruins classify cleanly
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1006,
        tags: { natural: 'waterhole', name: 'גב חצרה', 'name:en': 'Gev Hatzera' },
      })
    ).toMatchObject({ category: 'water', subcategory: 'waterhole', nameHe: 'גב חצרה' });
    expect(
      classifyOsmElement({
        type: 'node',
        id: 1007,
        tags: { man_made: 'cistern' },
      })
    ).toMatchObject({ category: 'water', subcategory: 'cistern', nameHe: 'בור מים', hasExplicitName: false });

    // Priority ordering strictly ranks curated < offroad < water < campsite < heritage < peak
    const pCurated = computePoiPriority({ isCurated: true, curatedIndex: 0, category: 'water', subcategory: 'spring' });
    const pOffroad = computePoiPriority({ category: 'offroad', subcategory: '4x4_pass', nameHe: 'מעלה עוזי' });
    const pWater = computePoiPriority({ category: 'water', subcategory: 'spring', nameHe: 'עין אורחות' });
    const pCamp = computePoiPriority({ category: 'campsite', subcategory: 'camp_site', nameHe: 'חניון בורוט' });
    const pHeritage = computePoiPriority({ category: 'heritage', subcategory: 'ruins', nameHe: 'חורבת מדרס' });
    const pHighPeak = computePoiPriority({ category: 'peak', subcategory: 'peak', ele: 1200, wikipedia: 'he:הר מירון', nameHe: 'הר מירון' });
    const pLowPeak = computePoiPriority({ category: 'peak', subcategory: 'peak', ele: 150, nameHe: 'גבעת יונה' });
    expect(pCurated).toBeLessThan(pOffroad);
    expect(pOffroad).toBeLessThan(pWater);
    expect(pWater).toBeLessThan(pCamp);
    expect(pCamp).toBeLessThan(pHeritage);
    expect(pHeritage).toBeLessThan(pHighPeak);
    expect(pHighPeak).toBeLessThan(pLowPeak);

    // Real PMTiles admin_area boundary enforcement
    const boundary = await createIsraelBoundaryChecker('data/Israel.osm.pmtiles');
    try {
      expect(boundary.usesPolygonBoundary).toBe(true);
      expect(await boundary.isInside(35.1045, 33.0858)).toBe(true); // Rosh HaNikra IL
      expect(await boundary.isInside(35.7865, 33.3075)).toBe(true); // Hermon Mitzpe Shlagim
      expect(await boundary.isInside(35.3492, 31.8384)).toBe(true); // Ein Qelt J&S
      expect(await boundary.isInside(34.9225, 29.5085)).toBe(true); // Eilat Coral Beach

      expect(await boundary.isInside(35.4444, 30.3285)).toBe(false); // Petra JO
      expect(await boundary.isInside(35.0063, 29.5321)).toBe(false); // Aqaba JO
      expect(await boundary.isInside(34.4667, 31.5017)).toBe(false); // Gaza City
      expect(await boundary.isInside(34.89, 29.49)).toBe(false); // Taba Sinai EG
      expect(await boundary.isInside(35.8255, 33.1256)).toBe(false); // Quneitra SY
      expect(await boundary.isInside(35.1964, 33.2705)).toBe(false); // Tyre LB
      expect(await boundary.isInside(34.3, 32.1)).toBe(false); // Open Mediterranean Sea
    } finally {
      boundary.close();
    }
  }, 20000);

  it('orders POIs by priority, emits sorted GeoJSON with zoom >= 13 search targets, and prunes stale OSM POIs while keeping user data', async () => {
    const makePoi = (overrides: Partial<PoiRecord>): PoiRecord => ({
      id: 'osm-n1',
      name: 'POI',
      nameHe: 'נקודה',
      nameEn: 'POI',
      category: 'heritage',
      subcategory: 'ruins',
      lon: 34.8,
      lat: 30.8,
      ele: 300,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'OSM',
      wikipedia: null,
      ...overrides,
    });

    const userPoi = makePoi({ id: 'user-poi-1', category: 'user', nameHe: 'נקודת משתמש' });
    const importedPoi = makePoi({ id: 'import-gpx-1', category: 'water', nameHe: 'נקודה מיובאת' });
    const notedPoi = makePoi({ id: 'osm-n99', category: 'peak', userNotes: 'שביל תלול', nameHe: 'גבעה' });
    const curatedPoi = makePoi({ id: 'il-poi-ein-aqev', category: 'water', priority: 100, nameHe: 'עין עקב' });
    const offroadPoi = makePoi({ id: 'osm-n10', category: 'offroad', priority: 190, nameHe: 'מעלה נח' });
    const peakPoi = makePoi({ id: 'osm-n20', category: 'peak', priority: 580, nameHe: 'הר חלק' });

    const geo = PoiManager.toGeoJSON(
      [peakPoi, curatedPoi, userPoi, notedPoi, importedPoi, offroadPoi],
      DEFAULT_LAYER_VISIBILITY
    );
    const ids = geo.features.map((f) => f.properties?.id);
    // user/noted both share priority 10, followed by imported (20), curated (100), offroad (190), peak (580)
    expect(ids.slice(2)).toEqual(['import-gpx-1', 'il-poi-ein-aqev', 'osm-n10', 'osm-n20']);
    for (const f of geo.features) {
      expect(typeof f.properties?.priority).toBe('number');
    }
    expect(getPoiSortPriority(offroadPoi)).toBeLessThan(getPoiSortPriority(peakPoi));

    // Verify search index integration recommends zoom >= 13 for POIs
    const searchSvc = new PMTilesSearchService();
    const searchHits = searchSvc.search('מעלה נח', {
      pois: [offroadPoi],
      routes: [],
      referenceCoord: { lon: 34.8, lat: 30.8 },
    });
    const poiHit = searchHits.find((r) => r.id === 'osm-n10');
    expect(poiHit).toBeDefined();
    expect(poiHit!.recommendedZoom).toBeGreaterThanOrEqual(13);

    // Verify PoiManager.initializePois prunes stale osm-* POIs while preserving userNotes, user-poi-*, and import-*
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;
    const stored: PoiRecord[] = [
      makePoi({ id: 'osm-stale-1', nameHe: 'עץ שנמחק' }),
      makePoi({ id: 'osm-noted-1', nameHe: 'עין עם הערה', userNotes: 'מים זורמים בחורף' }),
      userPoi,
      importedPoi,
      makePoi({ id: 'il-poi-ein-aqev', nameHe: 'עין עקב תחתון', userNotes: 'בריכה מדהימה' }),
    ];

    const toArraySpy = vi
      .spyOn(db.pois, 'toArray')
      .mockImplementation((async () => stored.map((r) => ({ ...r }))) as any);
    const overridesToArraySpy = vi
      .spyOn(db.poiOverrides, 'toArray')
      .mockImplementation((async () => []) as any);
    const bulkDeleteSpy = vi.spyOn(db.pois, 'bulkDelete').mockImplementation((async (
      keys: string[]
    ) => {
      const delSet = new Set(keys);
      for (let i = stored.length - 1; i >= 0; i--) {
        if (delSet.has(stored[i].id)) stored.splice(i, 1);
      }
    }) as any);
    const bulkPutSpy = vi.spyOn(db.pois, 'bulkPut').mockImplementation((async (
      items: readonly PoiRecord[]
    ) => {
      for (const item of items) {
        const idx = stored.findIndex((s) => s.id === item.id);
        if (idx >= 0) stored[idx] = { ...item };
        else stored.push({ ...item });
      }
    }) as any);
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation((async (...args: any[]) => {
      const fn = args[args.length - 1];
      return await fn();
    }) as any);

    try {
      (globalThis as any).window = { location: { origin: 'http://localhost:5173', hostname: 'localhost' } };
      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'il-poi-ein-aqev',
              geometry: { type: 'Point', coordinates: [34.8134, 30.8281] },
              properties: {
                id: 'il-poi-ein-aqev',
                nameHe: 'עין עקב תחתון',
                nameEn: 'Ein Aqev',
                category: 'water',
                subcategory: 'spring',
                priority: 100,
              },
            },
          ],
        }),
      })) as any;

      const result = await PoiManager.initializePois();
      expect(bulkDeleteSpy).toHaveBeenCalledWith(['osm-stale-1']);
      expect(result.some((p) => p.id === 'osm-stale-1')).toBe(false);
      expect(result.some((p) => p.id === 'osm-noted-1')).toBe(true);
      expect(result.some((p) => p.id === 'user-poi-1')).toBe(true);
      expect(result.some((p) => p.id === 'import-gpx-1')).toBe(true);
      expect(result.find((p) => p.id === 'il-poi-ein-aqev')?.userNotes).toBe('בריכה מדהימה');
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
      toArraySpy.mockRestore();
      overridesToArraySpy.mockRestore();
      bulkDeleteSpy.mockRestore();
      bulkPutSpy.mockRestore();
      txSpy.mockRestore();
    }
  });

  it('validates priority-sorted, boundary-pure Israel.pois.geojson in data/ without bundling public/data/', async () => {
    expect(fs.existsSync('public/data/Israel.pois.geojson')).toBe(false);
    if (!fs.existsSync('data/Israel.pois.geojson')) return;
    const rawData = fs.readFileSync('data/Israel.pois.geojson', 'utf-8');

    const parsed = JSON.parse(rawData);
    expect(parsed.metadata?.minRenderZoom).toBe(13);
    expect(Array.isArray(parsed.features)).toBe(true);
    expect(parsed.features.length).toBeGreaterThan(2000);

    const categories = new Set<string>();
    const ids = new Set<string>();
    let prevPriority = -Infinity;
    for (const f of parsed.features) {
      expect(f.geometry?.type).toBe('Point');
      const [lon, lat] = f.geometry.coordinates;
      expect(Number.isFinite(lon)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
      const p = f.properties || {};
      categories.add(p.category);
      ids.add(p.id);
      expect(typeof p.priority).toBe('number');
      expect(p.priority).toBeGreaterThanOrEqual(prevPriority);
      prevPriority = p.priority;
    }

    for (const expectedCat of ['water', 'offroad', 'campsite', 'heritage', 'peak']) {
      expect(categories.has(expectedCat)).toBe(true);
    }
    expect(ids.has('il-poi-ein-aqev')).toBe(true);
    expect(ids.has('il-poi-ein-kelt')).toBe(true);
    expect(ids.has('il-poi-maale-zik')).toBe(true);

    // Verify all bundled POI coordinates strictly satisfy Israel + Golan + Judea & Samaria boundary
    // @ts-expect-error Node MJS devops script lacks .d.ts declaration
    const harvester: any = await import('../../../devops/fetch-israel-pois.mjs');
    const boundary = await harvester.createIsraelBoundaryChecker('data/Israel.osm.pmtiles');
    try {
      const outsideIds: string[] = [];
      for (const f of parsed.features) {
        const id = String(f.properties?.id || f.id);
        if (id.startsWith('il-poi-')) continue;
        const [lon, lat] = f.geometry.coordinates;
        if (!(await boundary.isInside(lon, lat))) {
          outsideIds.push(`${id}@${lon},${lat}`);
        }
      }
      expect(outsideIds).toEqual([]);
    } finally {
      boundary.close();
    }
  }, 20000);

  it('converts Off-Road POIs, extracts Wikipedia ?curid= links, filters noise/non-Hebrew blankers, and loads overlay without bloating IndexedDB', async () => {
    // @ts-expect-error Node MJS devops script lacks .d.ts declaration
    const converter: any = await import('../../../devops/convert-offroad-pois.mjs');
    const { classifyOffroadItem, sanitizeExternalUrl } = converter;

    // 1. URL sanitization & Wikipedia curid + slug extraction
    expect(sanitizeExternalUrl('https://he.wikipedia.org/?curid=309722')).toEqual({
      url: 'https://he.wikipedia.org/?curid=309722',
      wikipedia: 'he:?curid=309722',
    });
    expect(sanitizeExternalUrl('https://he.m.wikipedia.org/wiki/%D7%A2%D7%99%D7%9F_%D7%A2%D7%A7%D7%91')).toEqual({
      url: 'https://he.m.wikipedia.org/wiki/%D7%A2%D7%99%D7%9F_%D7%A2%D7%A7%D7%91',
      wikipedia: 'he:עין עקב',
    });
    expect(sanitizeExternalUrl('https://www.inature.info/wiki/nahal_zin')).toEqual({
      url: 'https://www.inature.info/wiki/nahal_zin',
      wikipedia: null,
    });
    expect(sanitizeExternalUrl('http://ליד חירבת ריבו')).toEqual({ url: null, wikipedia: null });
    expect(sanitizeExternalUrl('NULL')).toEqual({ url: null, wikipedia: null });

    // 2. Quality/Noise filtering + classification
    expect(classifyOffroadItem({ id: '1', title: 'test', mapItemType: 'POI' })).toBeNull();
    expect(classifyOffroadItem({ id: '2', title: 'A008', mapItemType: 'DirectionCustom' })).toBeNull();
    expect(classifyOffroadItem({ id: '3', title: 'عفولي', mapItemType: 'POI' })).toBeNull();
    expect(
      classifyOffroadItem({ id: '4', title: 'נקודה מחוקה', mapItemType: 'POI', requestToDelet: 2, likes: 0 })
    ).toBeNull();

    // Preserves anchor 6518653317545984 even with requestToDelet: 2 because it has likes: 1 & desc
    const anchor = classifyOffroadItem({
      id: '6518653317545984',
      title: 'מדרגה גבוהה רצוי עם הכוונה בירידה',
      description: 'בינוני +',
      mapItemType: 'Upward',
      likes: 1,
      unlikes: 0,
      requestToDelet: 2,
      updated: '2026-01-03T10:00:00Z',
    });
    expect(anchor).toMatchObject({
      id: 'or-6518653317545984',
      category: 'offroad',
      subcategory: 'upward',
      difficulty4x4: 'בינוני +',
    });

    // Keyword refinement & edge-case guards for POI classification
    expect(classifyOffroadItem({ id: '5', title: 'פריחת אירוסים מדהימה', mapItemType: 'POI' })).toMatchObject({
      category: 'heritage',
      subcategory: 'nature_site',
    });
    expect(classifyOffroadItem({ id: '6', title: 'גשר הרכבת העתיק', mapItemType: 'POI' })).toMatchObject({
      category: 'heritage',
      subcategory: 'archaeological_site',
    });
    expect(classifyOffroadItem({ id: '7', title: 'חניון לילה עין עקב', mapItemType: 'POI' })).toMatchObject({
      category: 'campsite',
      subcategory: 'camp_site',
    });
    expect(classifyOffroadItem({ id: '8', title: 'פניה שמאלה לגבי פרס', mapItemType: 'Fountain' })).toMatchObject({
      category: 'offroad',
      subcategory: '4x4_pass',
    });
    expect(classifyOffroadItem({ id: '9', title: 'מעקף מפל', mapItemType: 'Fountain' })).toMatchObject({
      category: 'offroad',
      subcategory: '4x4_pass',
    });
    expect(
      classifyOffroadItem({
        id: '10',
        title: 'גבעת ניל"י',
        description: 'גבעת ניל"י היא יישוב קהילתי במועצה האזורית אלונה.',
        mapItemType: 'Wiki',
      })
    ).toMatchObject({
      category: 'heritage',
      subcategory: 'archaeological_site',
    });
    expect(classifyOffroadItem({ id: '11', title: 'גבעת המורה', mapItemType: 'Wiki' })).toMatchObject({
      category: 'peak',
      subcategory: 'peak',
    });
    expect(classifyOffroadItem({ id: '12', title: 'חורבת עתרי', mapItemType: 'POI' })).toMatchObject({
      category: 'heritage',
      subcategory: 'ruins',
    });

    // 3. Unified layer visibility & category filter helpers for israel-pois-labels
    expect(isMasterPoiActive(DEFAULT_LAYER_VISIBILITY)).toBe(true);
    expect(
      isMasterPoiActive({ ...DEFAULT_LAYER_VISIBILITY, pois: false })
    ).toBe(false);
    expect(buildPoiLayerFilter({ ...DEFAULT_LAYER_VISIBILITY, poiPeaks: false })).toEqual([
      'in',
      ['get', 'category'],
      ['literal', ['water', 'offroad', 'heritage', 'campsite', 'user']],
    ]);

    const filterUpdates: Array<{ id: string; filter: any }> = [];
    const layoutUpdates: Array<{ id: string; prop: string; val: any }> = [];
    applyLayerVisibilityToMap(
      {
        getStyle: () => ({ layers: [] }),
        getLayer: (id: string) => (id === 'israel-pois-labels' ? { id } : undefined),
        getSource: () => undefined,
        getTerrain: () => null,
        setLayoutProperty: (id: string, prop: string, val: any) =>
          layoutUpdates.push({ id, prop, val }),
        setFilter: (id: string, filter: any) => filterUpdates.push({ id, filter }),
      },
      { ...DEFAULT_LAYER_VISIBILITY, pois: false }
    );
    expect(layoutUpdates).toEqual([
      { id: 'israel-pois-labels', prop: 'visibility', val: 'none' },
    ]);
    expect(filterUpdates).toHaveLength(1);

    // 4. Unified PoiManager initialization merges overlapping OSM + Off-Road POIs, keeps Off-Road out of db.pois bulkPut, and persists userNotes
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;
    const stored: PoiRecord[] = [];
    const toArraySpy = vi
      .spyOn(db.pois, 'toArray')
      .mockImplementation((async () => stored.map((r) => ({ ...r }))) as any);
    const overridesToArraySpy = vi
      .spyOn(db.poiOverrides, 'toArray')
      .mockImplementation((async () => []) as any);
    const bulkDeleteSpy = vi.spyOn(db.pois, 'bulkDelete').mockImplementation((async () => {}) as any);
    const bulkPutSpy = vi.spyOn(db.pois, 'bulkPut').mockImplementation((async (
      items: readonly PoiRecord[]
    ) => {
      stored.push(...items.map((r) => ({ ...r })));
    }) as any);
    const updateSpy = vi.spyOn(db.pois, 'update').mockImplementation((async () => 0) as any);
    const putSpy = vi.spyOn(db.pois, 'put').mockImplementation((async (item: PoiRecord) => {
      stored.push({ ...item });
      return item.id;
    }) as any);
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation((async (...args: any[]) => {
      const fn = args[args.length - 1];
      return await fn();
    }) as any);

    try {
      (globalThis as any).window = { location: { origin: 'http://localhost:5173', hostname: 'localhost' } };
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('Israel.offroad.pois.geojson')) {
          return {
            ok: true,
            json: async () => ({
              type: 'FeatureCollection',
              metadata: { source: 'Off-Road.io Community Export (Unified with OSM in NavApp)' },
              features: [
                {
                  type: 'Feature',
                  id: 'or-dup-ein-aqev',
                  geometry: { type: 'Point', coordinates: [34.8135, 30.8282] },
                  properties: {
                    nameHe: 'עין עקב',
                    category: 'water',
                    subcategory: 'spring',
                    waterStatus: 'דיווח מים מלאים / זורמים (קהילה)',
                    descHe: 'בריכה עמוקה וצוננת',
                    likes: 28,
                    priority: 215,
                  },
                },
                {
                  type: 'Feature',
                  id: 'or-camp-ein-aqev',
                  geometry: { type: 'Point', coordinates: [34.8135, 30.8282] },
                  properties: {
                    nameHe: 'חניון לילה עין עקב',
                    category: 'campsite',
                    subcategory: 'camp_site',
                    priority: 320,
                  },
                },
                {
                  type: 'Feature',
                  id: 'or-6518653317545984',
                  geometry: { type: 'Point', coordinates: [35.241116, 30.934793] },
                  properties: {
                    nameHe: 'מדרגה גבוהה רצוי עם הכוונה בירידה',
                    category: 'offroad',
                    subcategory: 'upward',
                    difficulty4x4: 'בינוני +',
                    priority: 207,
                  },
                },
              ],
            }),
          } as any;
        }
        return {
          ok: true,
          json: async () => ({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                id: 'il-poi-ein-aqev',
                geometry: { type: 'Point', coordinates: [34.8134, 30.8281] },
                properties: {
                  id: 'il-poi-ein-aqev',
                  nameHe: 'עין עקב',
                  category: 'water',
                  subcategory: 'spring',
                  priority: 100,
                },
              },
            ],
          }),
        } as any;
      }) as any;

      const loaded = await PoiManager.initializePois();
      // Overlapping same-category POI (or-dup-ein-aqev) merged into il-poi-ein-aqev; distinct campsite kept separate
      expect(loaded.map((p) => p.id)).toEqual([
        'il-poi-ein-aqev',
        'or-6518653317545984',
        'or-camp-ein-aqev',
      ]);
      const mergedSpring = loaded.find((p) => p.id === 'il-poi-ein-aqev')!;
      expect(mergedSpring.source).toContain('Off-Road.io');
      expect(mergedSpring.waterStatus).toBe('דיווח מים מלאים / זורמים (קהילה)');
      expect(mergedSpring.likes).toBe(28);
      // IndexedDB only receives Curated/OSM, NOT or-* bulk puts
      expect(stored.some((p) => p.id.startsWith('or-'))).toBe(false);

      const orRec = loaded.find((p) => p.id === 'or-6518653317545984')!;
      const compact = PoiManager.toCompactMapGeoJSON([orRec]);
      expect(Object.keys(compact.features[0].properties || {}).sort()).toEqual([
        'category',
        'id',
        'nameHe',
        'priority',
        'subcategory',
        'symbolId',
      ]);

      await PoiManager.saveUserNote('or-6518653317545984', 'עביר עם נעילה אחורית', orRec);
      const afterNote = await PoiManager.getAllPois();
      expect(afterNote.find((p) => p.id === 'or-6518653317545984')?.userNotes).toBe(
        'עביר עם נעילה אחורית'
      );
    } finally {
      PoiManager.clearOffroadCacheForTesting();
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
      toArraySpy.mockRestore();
      overridesToArraySpy.mockRestore();
      bulkDeleteSpy.mockRestore();
      bulkPutSpy.mockRestore();
      updateSpy.mockRestore();
      putSpy.mockRestore();
      txSpy.mockRestore();
    }
  });

  it(
    'validates priority-sorted, boundary-pure Israel.offroad.pois.geojson in data/ without bundling public/data/',
    async () => {
      expect(fs.existsSync('public/data/Israel.offroad.pois.geojson')).toBe(false);
      if (!fs.existsSync('data/Israel.offroad.pois.geojson')) return;
      const rawData = fs.readFileSync('data/Israel.offroad.pois.geojson', 'utf-8');

      const parsed = JSON.parse(rawData);
      expect(parsed.metadata?.minRenderZoom).toBe(13);
      expect(Array.isArray(parsed.features)).toBe(true);
      expect(parsed.features.length).toBeGreaterThan(50000);

      const categories = new Set<string>();
      let foundAnchor: any = null;
      let prevPriority = -Infinity;
      for (const f of parsed.features) {
        expect(f.geometry?.type).toBe('Point');
        const [lon, lat] = f.geometry.coordinates;
        expect(Number.isFinite(lon)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
        expect(String(f.id).startsWith('or-')).toBe(true);
        const p = f.properties || {};
        categories.add(p.category);
        expect(typeof p.priority).toBe('number');
        expect(p.priority).toBeGreaterThanOrEqual(prevPriority);
        prevPriority = p.priority;
        expect(/[\u0590-\u05FFA-Za-z]/.test(String(p.nameHe || ''))).toBe(true);
        if (f.id === 'or-6518653317545984') foundAnchor = f;
      }

      for (const expectedCat of ['water', 'offroad', 'campsite', 'heritage', 'peak']) {
        expect(categories.has(expectedCat)).toBe(true);
      }
      expect(foundAnchor).not.toBeNull();
      expect(foundAnchor.properties).toMatchObject({
        category: 'offroad',
        subcategory: 'maale',
        symbolId: 'poi-offroad-pass',
        difficulty4x4: 'בינוני +',
      });

      // Verify all bundled Off-Road POI coordinates strictly satisfy Israel + Golan + Judea & Samaria boundary
      // @ts-expect-error Node MJS devops script lacks .d.ts declaration
      const harvester: any = await import('../../../devops/fetch-israel-pois.mjs');
      const boundary = await harvester.createIsraelBoundaryChecker('data/Israel.osm.pmtiles');
      try {
        const outsideIds: string[] = [];
        for (const f of parsed.features) {
          const [lon, lat] = f.geometry.coordinates;
          if (!(await boundary.isInside(lon, lat))) {
            outsideIds.push(`${f.id}@${lon},${lat}`);
          }
        }
        expect(outsideIds).toEqual([]);
      } finally {
        boundary.close();
      }
    },
    30000
  );

  it('keeps Android Capacitor captureInput disabled and WebView input IME handling safe for Hebrew & predictive keyboards', () => {
    const rootCapConfig = JSON.parse(fs.readFileSync('capacitor.config.json', 'utf-8'));
    expect(rootCapConfig.android?.captureInput).toBe(false);

    const androidAssetsConfigPath = 'android/app/src/main/assets/capacitor.config.json';
    if (fs.existsSync(androidAssetsConfigPath)) {
      const androidCapConfig = JSON.parse(fs.readFileSync(androidAssetsConfigPath, 'utf-8'));
      expect(androidCapConfig.android?.captureInput).toBe(false);
    }

    const indexCss = fs.readFileSync('src/index.css', 'utf-8');
    expect(indexCss).toMatch(/input,\s*textarea\s*\{[^}]*user-select:\s*text/i);

    const searchBarSrc = fs.readFileSync('src/components/search/SearchBar.tsx', 'utf-8');
    expect(searchBarSrc).toContain('onCompositionStart');
    expect(searchBarSrc).toContain('onCompositionEnd');
    expect(searchBarSrc).toContain('select-text');
  });
});
