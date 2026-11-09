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
import type { PoiRecord, SavedRouteRecord } from '../db/NavDatabase';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  DEFAULT_LAYER_VISIBILITY,
  countActivePoiCategories,
  isMasterPoiActive,
  toggleMasterPoiVisibility,
  togglePoiCategoryVisibility,
  enableAllPoiVisibility,
} from '../style/israelOutdoorStyle';
import { PoiManager } from '../pois/PoiManager';
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
import { RouteManager } from '../navigation/RouteManager';
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
    expect(PoiManager.toGeoJSON(samplePois, noUser).features.map((f) => f.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
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

    // 2. Turning ALL 4 switches OFF keeps every base path, track, cycleway, and firing boundary visible in default colors
    const allColorSwitchesOff = {
      ...DEFAULT_LAYER_VISIBILITY,
      militaryZones: false,
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
    expect(elapsedMs).toBeLessThan(200);
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
});
