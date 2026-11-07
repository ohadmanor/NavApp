import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  buildIsraelOutdoorStyle,
  DEFAULT_LAYER_VISIBILITY,
} from '../style/israelOutdoorStyle';
import {
  convertLineToVisualOrder,
  processBidirectionalText,
  processStyledBidirectionalText,
  sanitizeToHebrewOrEnglish,
  applyArabicShaping,
} from '../style/hebrewBidiProcessor';
import { NativeSliceSource } from '../pmtiles/NativeSliceSource';
import { RouteManager } from '../navigation/RouteManager';
import { MilitaryGridService } from '../navigation/MilitaryGridService';

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
});
