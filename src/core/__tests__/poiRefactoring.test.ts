import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POI_CATEGORIES,
  POI_CATEGORY_SPECS,
  POI_CATEGORY_ZOOM_RULES,
  POI_SYMBOL_BY_ID,
  POI_SYMBOL_LIST,
  POI_SYMBOLS_BY_CATEGORY,
  buildPoiIconExpression,
  buildPoiIconSizeExpression,
  buildPoiTextColorExpression,
  normalizeSubcategoryForCategory,
  resolvePoiSymbolId,
} from '../pois/poiTaxonomy';
import { classifyPoiWithText } from '../pois/poiClassifier';
import { CommunityPoiImporter } from '../pois/CommunityPoiImporter';
import { PoiManager } from '../pois/PoiManager';
import { db, type PoiOverrideRecord, type PoiRecord } from '../db/NavDatabase';
import { PMTilesSearchService } from '../search/PMTilesSearchService';
import {
  mergeUserStates,
  sanitizePoiOverrides,
  type PersistedUserState,
} from '../preferences/UserStateSyncService';
import {
  buildIsraelOutdoorStyle,
  buildPoiTieredLayerFilter,
  DEFAULT_LAYER_VISIBILITY,
} from '../style/israelOutdoorStyle';
import { BUILT_IN_USER_ICONS } from '../navigation/UserLocationIconService';
import { buildCarSyncPayload, selectCarSyncablePois } from '../car/CarSyncService';

function createPoi(overrides: Partial<PoiRecord> = {}): PoiRecord {
  return {
    id: 'osm-test-1',
    name: 'עין עקב',
    nameHe: 'עין עקב',
    nameEn: 'Ein Akev',
    category: 'water',
    subcategory: 'spring',
    lon: 34.8134,
    lat: 30.8281,
    ele: 410,
    waterStatus: 'פעיל כל השנה',
    difficulty4x4: null,
    descHe: 'מעיין איתן במדבר',
    descEn: 'Perennial desert spring',
    source: 'IsraelHiking / OSM',
    wikipedia: null,
    priority: 100,
    ...overrides,
  };
}

function setupInMemoryPoiDb(initialPois: PoiRecord[] = [], initialOverrides: PoiOverrideRecord[] = []) {
  const poisMap = new Map<string, PoiRecord>(initialPois.map((p) => [p.id, { ...p }]));
  const overridesMap = new Map<string, PoiOverrideRecord>(initialOverrides.map((o) => [o.id, { ...o }]));

  const spies = [
    vi.spyOn(db.pois, 'toArray').mockImplementation((async () =>
      Array.from(poisMap.values()).map((r) => ({ ...r }))
    ) as any),
    vi.spyOn(db.pois, 'get').mockImplementation((async (id: string) => {
      const hit = poisMap.get(id);
      return hit ? { ...hit } : undefined;
    }) as any),
    vi.spyOn(db.pois, 'put').mockImplementation((async (item: PoiRecord) => {
      poisMap.set(item.id, { ...item });
      return item.id;
    }) as any),
    vi.spyOn(db.pois, 'bulkPut').mockImplementation((async (items: readonly PoiRecord[]) => {
      for (const item of items) {
        poisMap.set(item.id, { ...item });
      }
    }) as any),
    vi.spyOn(db.pois, 'delete').mockImplementation((async (id: string) => {
      poisMap.delete(id);
    }) as any),
    vi.spyOn(db.pois, 'bulkDelete').mockImplementation((async (ids: readonly string[]) => {
      for (const id of ids) poisMap.delete(id);
    }) as any),
    vi.spyOn(db.pois, 'update').mockImplementation((async (id: string, changes: Partial<PoiRecord>) => {
      const cur = poisMap.get(id);
      if (!cur) return 0;
      poisMap.set(id, { ...cur, ...changes });
      return 1;
    }) as any),
    vi.spyOn(db, 'transaction').mockImplementation((async (...args: any[]) => {
      const fn = args[args.length - 1];
      return await fn();
    }) as any),
    vi.spyOn(db.poiOverrides, 'toArray').mockImplementation((async () =>
      Array.from(overridesMap.values()).map((o) => ({ ...o }))
    ) as any),
    vi.spyOn(db.poiOverrides, 'get').mockImplementation((async (id: string) => {
      const hit = overridesMap.get(id);
      return hit ? { ...hit } : undefined;
    }) as any),
    vi.spyOn(db.poiOverrides, 'put').mockImplementation((async (item: PoiOverrideRecord) => {
      overridesMap.set(item.id, { ...item });
      return item.id;
    }) as any),
    vi.spyOn(db.poiOverrides, 'bulkPut').mockImplementation((async (items: readonly PoiOverrideRecord[]) => {
      for (const item of items) {
        overridesMap.set(item.id, { ...item });
      }
    }) as any),
    vi.spyOn(db.poiOverrides, 'delete').mockImplementation((async (id: string) => {
      overridesMap.delete(id);
    }) as any),
  ];

  return {
    poisMap,
    overridesMap,
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

describe('POI Refactoring: Strict 1-to-1 Symbol Taxonomy, Text Recategorization & Edit/Delete Persistence', () => {
  afterEach(() => {
    PoiManager.clearOffroadCacheForTesting();
    vi.restoreAllMocks();
  });

  it('enforces a strict 1-to-1 symbol-to-category partition with modern sprites & zero legacy icon references', async () => {
    expect(POI_CATEGORIES).toEqual(['water', 'offroad', 'campsite', 'heritage', 'peak', 'user']);
    expect(POI_SYMBOL_LIST).toHaveLength(31);

    const seenIds = new Set<string>();
    const seenAliases = new Map<string, string>();

    for (const spec of POI_SYMBOL_LIST) {
      expect(seenIds.has(spec.id)).toBe(false);
      seenIds.add(spec.id);
      expect(spec.id.startsWith(`poi-${spec.category}-`)).toBe(true);

      // Standalone modern SVG symbol exists on disk
      const svgPath = path.resolve(`public/assets/poi-symbols/${spec.id}.svg`);
      expect(fs.existsSync(svgPath)).toBe(true);
      expect(fs.readFileSync(svgPath, 'utf-8')).toContain('<svg');

      // Zero alias collisions across categories/symbols
      for (const alias of spec.aliases) {
        const key = alias.toLowerCase();
        expect(seenAliases.has(key)).toBe(false);
        seenAliases.set(key, spec.id);
      }

      // Resolving with its own category returns this exact symbol
      expect(resolvePoiSymbolId(spec.category, spec.subcategory)).toBe(spec.id);

      // Passing this subcategory with ANY OTHER category MUST NOT leak this symbol; must fall back to target category's default
      for (const otherCat of POI_CATEGORIES) {
        if (otherCat === spec.category) continue;
        const fallbackSym = resolvePoiSymbolId(otherCat, spec.subcategory);
        expect(POI_SYMBOL_BY_ID[fallbackSym].category).toBe(otherCat);
        expect(fallbackSym).toBe(POI_CATEGORY_SPECS[otherCat].defaultSymbolId);

        const normalizedSub = normalizeSubcategoryForCategory(otherCat, spec.subcategory);
        expect(normalizedSub).toBe(POI_CATEGORY_SPECS[otherCat].defaultSubcategory);
      }
    }

    // Verify all 6 categories have exclusive symbol lists summing to 31
    const groupedTotal = POI_CATEGORIES.reduce(
      (sum, cat) => sum + POI_SYMBOLS_BY_CATEGORY[cat].length,
      0
    );
    expect(groupedTotal).toBe(31);

    // Verify web & Android sprite sheets contain all 31 modern POI sprites
    for (const spriteJsonPath of [
      'public/assets/sprites/sprite.json',
      'public/assets/sprites/sprite@2x.json',
      'android/app/src/main/assets/public/assets/sprites/sprite.json',
      'android/app/src/main/assets/public/assets/sprites/sprite@2x.json',
    ]) {
      expect(fs.existsSync(spriteJsonPath)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(spriteJsonPath, 'utf-8'));
      for (const spec of POI_SYMBOL_LIST) {
        expect(parsed[spec.id]).toBeDefined();
        expect(parsed[spec.id].width).toBeGreaterThan(0);
        expect(parsed[spec.id].height).toBeGreaterThan(0);
      }
    }

    // Verify MapLibre icon/size/color expressions only emit exclusive `poi-*` sprites & zero legacy output sprites
    const iconExpr = buildPoiIconExpression();
    const iconExprJson = JSON.stringify(iconExpr);
    for (const spec of POI_SYMBOL_LIST) {
      expect(iconExprJson).toContain(`"${spec.id}"`);
    }
    for (const legacySprite of ['"offroad-pass"', '"offroad_poi"', '"offroad_photo"', '"jar"', '"dot"']) {
      expect(iconExprJson).not.toContain(legacySprite);
    }
    // Every default + mapped sprite value inside category match branches must start with "poi-"
    const catMatchExpr = iconExpr[3] as any[];
    for (let i = 2; i < catMatchExpr.length - 1; i += 2) {
      const subMatch = catMatchExpr[i + 1] as any[];
      expect(subMatch[subMatch.length - 1]).toMatch(/^poi-/);
      for (let j = 2; j < subMatch.length - 1; j += 2) {
        expect(subMatch[j + 1]).toMatch(/^poi-/);
      }
    }
    expect(catMatchExpr[catMatchExpr.length - 1]).toMatch(/^poi-/);
    const sizeExpr = buildPoiIconSizeExpression();
    expect(sizeExpr[0]).toBe('interpolate');
    expect(sizeExpr[3]).toBe(11.5);
    expect(sizeExpr[sizeExpr.length - 2]).toBe(17.5);
    expect(JSON.stringify(sizeExpr[4])).toContain('0.441');
    expect(JSON.stringify(sizeExpr[sizeExpr.length - 1])).toContain('1.254');
    expect(POI_CATEGORY_SPECS.peak.fillHex).toBe('#000000');
    expect(POI_CATEGORY_SPECS.campsite.fillHex).toBe('#009000');
    expect(POI_CATEGORY_SPECS.water.fillHex).toBe('#0284C7');
    expect(POI_CATEGORY_SPECS.offroad.fillHex).toBe('#E6194B');
    expect(POI_CATEGORY_SPECS.heritage.fillHex).toBe('#FFE119');
    expect(POI_CATEGORY_SPECS.user.fillHex).toBe('#911EB4');
    expect(POI_CATEGORY_ZOOM_RULES).toEqual({
      peak: { iconMinZoom: 11.5, textMinZoom: 12.5 },
      campsite: { iconMinZoom: 13, textMinZoom: 14 },
      heritage: { iconMinZoom: 13, textMinZoom: 14 },
      water: { iconMinZoom: 14, textMinZoom: 14 },
      offroad: { iconMinZoom: 14, textMinZoom: 14 },
      user: { iconMinZoom: 14, textMinZoom: 14 },
    });
    expect(JSON.stringify(buildPoiTextColorExpression(false))).toContain(POI_CATEGORY_SPECS.water.textDayHex);
    expect(JSON.stringify(buildPoiTextColorExpression(true))).toContain(POI_CATEGORY_SPECS.water.textDarkHex);

    // Ensure vector POI layers honor exact minzoom & text-field zoom thresholds without maxzoom cutoffs
    const style = buildIsraelOutdoorStyle({ visibility: DEFAULT_LAYER_VISIBILITY, theme: 'topo-day' });
    const peakVt = style.layers.find((l) => l.id === 'name-peak') as any;
    const campVt = style.layers.find((l) => l.id === 'icon-camp_site') as any;
    const heritageVt = style.layers.find((l) => l.id === 'icon-viewpoint') as any;
    const waterVt = style.layers.find((l) => l.id === 'name-water-point') as any;
    const offroadVt = style.layers.find((l) => l.id === 'icon-parking') as any;
    for (const layer of [peakVt, campVt, heritageVt, waterVt, offroadVt]) {
      expect(layer).toBeDefined();
      expect(layer.maxzoom).toBeUndefined();
    }
    expect(peakVt.minzoom).toBe(11.5);
    expect(peakVt.layout['text-field'].slice(0, 4)).toEqual(['step', ['zoom'], '', 12.5]);
    expect(campVt.minzoom).toBe(13);
    expect(campVt.layout['text-field'].slice(0, 4)).toEqual(['step', ['zoom'], '', 14]);
    expect(heritageVt.minzoom).toBe(13);
    expect(heritageVt.layout['text-field'].slice(0, 4)).toEqual(['step', ['zoom'], '', 14]);
    expect(waterVt.minzoom).toBe(14);
    expect(offroadVt.minzoom).toBe(14);

    // Validate full style + all 3 tiered GeoJSON POI layers against MapLibre style-spec
    // (catches illegal nested ["zoom"] expressions that cause MapLibre to reject layers)
    const specMod: any = await import('@maplibre/maplibre-gl-style-spec');
    const validate = specMod.validateStyleMin || specMod.validate || specMod.default?.validateStyleMin;
    if (typeof validate === 'function') {
      const makePoiLayer = (
        id: string,
        minzoom: number,
        categories: Array<'peak' | 'campsite' | 'heritage' | 'water' | 'offroad' | 'user'>,
        textField: any
      ) => ({
        id,
        type: 'symbol' as const,
        source: 'israel-pois-src',
        minzoom,
        filter: buildPoiTieredLayerFilter(DEFAULT_LAYER_VISIBILITY, categories),
        layout: {
          'icon-image': iconExpr,
          'icon-size': sizeExpr,
          'icon-allow-overlap': ['step', ['zoom'], false, 15.5, true],
          'icon-padding': ['interpolate', ['linear'], ['zoom'], 11.5, 1.5, 14, 1.2, 16, 0.8],
          'text-field': textField,
          'text-offset': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12.5,
            ['literal', [0, 0.72]],
            14,
            ['literal', [0, 0.92]],
            16,
            ['literal', [0, 1.12]],
            17.5,
            ['literal', [0, 1.28]],
          ],
          'text-allow-overlap': false,
          'text-optional': true,
        },
        paint: {
          'text-color': buildPoiTextColorExpression(false),
        },
      });

      const testStyle = {
        ...style,
        sources: {
          ...style.sources,
          'israel-pois-src': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          ...style.layers,
          makePoiLayer('israel-pois-peaks', 11.5, ['peak'], [
            'step',
            ['zoom'],
            '',
            12.5,
            ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
          ]),
          makePoiLayer('israel-pois-midzoom', 13, ['campsite', 'heritage'], [
            'step',
            ['zoom'],
            '',
            14,
            ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
          ]),
          makePoiLayer(
            'israel-pois-labels',
            14,
            ['water', 'offroad', 'user'],
            ['coalesce', ['get', 'nameHe'], ['get', 'name'], '']
          ),
        ],
      };
      const errors = validate(testStyle);
      expect(errors).toEqual([]);
    }
  });

  it('recategorizes POIs cleanly via full text fields without relational false-positives', () => {
    expect(classifyPoiWithText({ nameHe: 'עין עקב תחתון', descHe: 'נביעה קרירה וגב עמוק לרחצה' })).toMatchObject({
      category: 'water',
      subcategory: 'spring',
      symbolId: 'poi-water-spring',
    });

    expect(classifyPoiWithText({ nameHe: 'גב זרחן', descHe: 'גב מים מלא בעונה' })).toMatchObject({
      category: 'water',
      subcategory: 'water_pool',
      symbolId: 'poi-water-pool',
    });

    expect(classifyPoiWithText({ nameHe: 'מפל רז', descHe: 'מפל גיר יבש בדרך כלל' })).toMatchObject({
      category: 'water',
      subcategory: 'waterfall',
      symbolId: 'poi-water-waterfall',
    });

    expect(classifyPoiWithText({ nameHe: 'בור חוורים', descHe: 'בור מים עתיק' })).toMatchObject({
      category: 'water',
      subcategory: 'cistern',
      symbolId: 'poi-water-cistern',
    });

    expect(classifyPoiWithText({ nameHe: 'מעלה עשוש', descHe: 'מדרגת סלע 4x4 קשה', difficulty4x4: 'קשה' })).toMatchObject({
      category: 'offroad',
      subcategory: 'maale',
      symbolId: 'poi-offroad-pass',
    });

    expect(classifyPoiWithText({ nameHe: 'שער סגור בציר הנפט', descHe: 'שער נעול לתנועת רכבים' })).toMatchObject({
      category: 'offroad',
      subcategory: 'blocked_road',
      symbolId: 'poi-offroad-blocked',
    });

    expect(classifyPoiWithText({ nameHe: 'חציית נחל צין - שיטפון', descHe: 'סכנת שקיעה בבוץ והצפה' })).toMatchObject({
      category: 'offroad',
      subcategory: 'mud',
      symbolId: 'poi-offroad-mud',
    });

    expect(classifyPoiWithText({ nameHe: 'חניון לילה בורות לוץ', descHe: 'מקומות לינה, פיתוח רט"ג' })).toMatchObject({
      category: 'campsite',
      subcategory: 'camp_site',
      symbolId: 'poi-campsite-night',
    });

    expect(classifyPoiWithText({ nameHe: 'מחנה צבאי נטוש', descHe: 'בסיס סגור של צה״ל' }).category).not.toBe('campsite');

    expect(classifyPoiWithText({ nameHe: 'שער הגיא', descHe: 'אתר מורשת היסטורי' })).toMatchObject({
      category: 'heritage',
      symbolId: expect.stringMatching(/^poi-heritage-/),
    });

    expect(classifyPoiWithText({ nameHe: 'מצפור שגב', descHe: 'תצפית מדהימה מול עין עקב' })).toMatchObject({
      category: 'heritage',
      subcategory: 'viewpoint',
      symbolId: 'poi-heritage-viewpoint',
    });

    expect(classifyPoiWithText({ nameHe: 'הר מירון', descHe: 'פסגה גבוהה בגליל', ele: 1208 })).toMatchObject({
      category: 'peak',
      subcategory: 'peak',
      symbolId: 'poi-peak-summit',
    });

    expect(classifyPoiWithText({ nameHe: 'גבעת האירוסים', descHe: 'פריחה אביבית ושמורת טבע' })).toMatchObject({
      category: 'heritage',
      subcategory: 'nature_site',
      symbolId: 'poi-heritage-nature',
    });

    expect(
      classifyPoiWithText({
        nameHe: 'גבעת ניל"י',
        descHe: 'גבעת ניל"י היא יישוב קהילתי במועצה האזורית אלונה.',
        existingCategory: 'heritage',
      }).category
    ).toBe('heritage');
  });

  it('classifies GPX, KML, GeoJSON, and TWL imports by text without legacy imported_* subcategories', async () => {
    const mockDb = setupInMemoryPoiDb();
    try {
      const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <wpt lat="30.828" lon="34.813"><name>עין עקב</name><desc>מעיין זורם וצלול</desc><ele>410</ele></wpt>
  <wpt lat="30.720" lon="35.120"><name>מעלה זיק</name><desc>מדרגת סלע 4x4 קשה</desc></wpt>
</gpx>`;
      const gpxFile = new File([gpxXml], 'trip.gpx', { type: 'application/gpx+xml' });
      const gpxRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(gpxFile);
      expect(gpxRes.importedPois).toHaveLength(2);
      expect(gpxRes.importedPois[0]).toMatchObject({ category: 'water', subcategory: 'spring' });
      expect(gpxRes.importedPois[1]).toMatchObject({ category: 'offroad', subcategory: 'maale' });

      const kmlXml = `<?xml version="1.0" encoding="UTF-8"?>
<kml><Document>
  <Placemark><name>חניון לילה גוונים</name><description>קמפינג מוסדר ומדורה</description><Point><coordinates>34.91,30.58,520</coordinates></Point></Placemark>
</Document></kml>`;
      const kmlFile = new File([kmlXml], 'camp.kml', { type: 'application/vnd.google-earth.kml+xml' });
      const kmlRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(kmlFile);
      expect(kmlRes.importedPois).toHaveLength(1);
      expect(kmlRes.importedPois[0]).toMatchObject({ category: 'campsite', subcategory: 'camp_site' });

      const geojsonStr = JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [35.4, 33.0, 1200] },
            properties: { name: 'מצפה החרמון', desc: 'תצפית נוף פתוחה', subcategory: 'imported_geojson' },
          },
        ],
      });
      const geoFile = new File([geojsonStr], 'spots.geojson', { type: 'application/geo+json' });
      const geoRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(geoFile);
      expect(geoRes.importedPois).toHaveLength(1);
      expect(geoRes.importedPois[0]).toMatchObject({ category: 'heritage', subcategory: 'viewpoint' });

      const twlText = '34.8501, 30.8902, בור מים עתיק\n';
      const twlFile = new File([twlText], 'naviguide.twl', { type: 'text/plain' });
      const twlRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(twlFile);
      expect(twlRes.importedPois).toHaveLength(1);
      expect(twlRes.importedPois[0]).toMatchObject({ category: 'water', subcategory: 'cistern' });

      for (const poi of [
        ...gpxRes.importedPois,
        ...kmlRes.importedPois,
        ...geoRes.importedPois,
        ...twlRes.importedPois,
      ]) {
        expect(poi.subcategory).not.toMatch(/^(imported_|offroad_poi|offroad_photo)/);
        const sym = resolvePoiSymbolId(poi.category, poi.subcategory);
        expect(POI_SYMBOL_BY_ID[sym].category).toBe(poi.category);
      }
    } finally {
      mockDb.restore();
    }
  });

  it('audits data/ Israel.pois.geojson and Israel.offroad.pois.geojson for zero legacy subcategories and valid exclusive symbolIds (and ensures public/data/ is not bundled)', () => {
    expect(fs.existsSync('public/data/Israel.pois.geojson')).toBe(false);
    expect(fs.existsSync('public/data/Israel.offroad.pois.geojson')).toBe(false);

    for (const dataRel of [
      'data/Israel.pois.geojson',
      'data/Israel.offroad.pois.geojson',
    ]) {
      if (!fs.existsSync(dataRel)) continue;
      const rawData = fs.readFileSync(dataRel, 'utf-8');

      const parsed = JSON.parse(rawData);
      expect(parsed.features.length).toBeGreaterThan(5000);

      for (const f of parsed.features) {
        const p = f.properties || {};
        expect(POI_CATEGORIES).toContain(p.category);
        expect(p.subcategory).not.toBe('offroad_poi');
        expect(p.subcategory).not.toBe('offroad_photo');
        expect(p.symbolId).toBeDefined();
        const spec = POI_SYMBOL_BY_ID[p.symbolId as keyof typeof POI_SYMBOL_BY_ID];
        expect(spec).toBeDefined();
        expect(spec.category).toBe(p.category);
        expect(resolvePoiSymbolId(p.category, p.subcategory)).toBe(p.symbolId);
      }
    }
  }, 20000);

  it('persists POI deletes, suppresses merged duplicates, supports Undo & category overrides with reset', async () => {
    const mockDb = setupInMemoryPoiDb();
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;

    try {
      (globalThis as any).window = { location: { origin: 'http://localhost:5173', hostname: 'localhost' } };
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('Israel.offroad.pois.geojson')) {
          return {
            ok: true,
            json: async () => ({
              type: 'FeatureCollection',
              metadata: { source: 'Off-Road.io' },
              features: [
                {
                  type: 'Feature',
                  id: 'or-dup-ein-aqev',
                  geometry: { type: 'Point', coordinates: [34.8135, 30.8282] },
                  properties: {
                    id: 'or-dup-ein-aqev',
                    nameHe: 'עין עקב',
                    category: 'water',
                    subcategory: 'spring',
                    priority: 220,
                  },
                },
                {
                  type: 'Feature',
                  id: 'or-distinct-1',
                  geometry: { type: 'Point', coordinates: [35.22, 31.11] },
                  properties: {
                    id: 'or-distinct-1',
                    nameHe: 'מדרגת צין',
                    category: 'offroad',
                    subcategory: 'maale',
                    priority: 230,
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

      const initial = await PoiManager.initializePois();
      expect(initial.map((p) => p.id)).toEqual(['il-poi-ein-aqev', 'or-distinct-1']);

      // 1. Update category & verify override persists across reload
      const targetOffroad = initial.find((p) => p.id === 'or-distinct-1')!;
      const updated = await PoiManager.updatePoiCategory(targetOffroad, 'heritage', 'viewpoint');
      expect(updated.category).toBe('heritage');
      expect(updated.subcategory).toBe('viewpoint');
      expect(updated.difficulty4x4).toBeNull();
      expect(PoiManager.getOverriddenPoiIdsSnapshot()).toContain('or-distinct-1');

      const compact = PoiManager.toCompactMapGeoJSON([updated]);
      expect(compact.features[0].properties).toMatchObject({
        category: 'heritage',
        subcategory: 'viewpoint',
        symbolId: 'poi-heritage-viewpoint',
      });

      const reloadedAfterEdit = await PoiManager.initializePois();
      expect(reloadedAfterEdit.find((p) => p.id === 'or-distinct-1')).toMatchObject({
        category: 'heritage',
        subcategory: 'viewpoint',
      });

      // Reset override restores original category
      await PoiManager.resetPoiOverride('or-distinct-1');
      const reloadedAfterReset = await PoiManager.getAllPois();
      expect(reloadedAfterReset.find((p) => p.id === 'or-distinct-1')).toMatchObject({
        category: 'offroad',
        subcategory: 'maale',
      });

      // 2. Delete merged canonical POI -> suppresses BOTH il-poi-ein-aqev AND duplicate or-dup-ein-aqev on reload
      const einAqev = reloadedAfterReset.find((p) => p.id === 'il-poi-ein-aqev')!;
      const undoSnapshot = await PoiManager.deletePoi(einAqev);
      expect(PoiManager.getDeletedPoiIdsSnapshot()).toContain('il-poi-ein-aqev');
      expect(PoiManager.getDeletedSignatures()).toHaveLength(1);

      const afterDeleteReload = await PoiManager.initializePois();
      expect(afterDeleteReload.some((p) => p.id === 'il-poi-ein-aqev')).toBe(false);
      expect(afterDeleteReload.some((p) => p.id === 'or-dup-ein-aqev')).toBe(false);
      expect(afterDeleteReload.map((p) => p.id)).toEqual(['or-distinct-1']);

      // 3. Undo delete restores POI cleanly
      await PoiManager.restoreDeletedPoi(undoSnapshot);
      const afterUndoReload = await PoiManager.getAllPois();
      expect(afterUndoReload.some((p) => p.id === 'il-poi-ein-aqev')).toBe(true);
      expect(PoiManager.getDeletedPoiIdsSnapshot()).toEqual([]);
    } finally {
      mockDb.restore();
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
    }
  });

  it('suppresses deleted POIs & nearby PMTiles duplicates in search, syncs overrides in UserStateSyncService & CarSyncService', () => {
    // 1. Search suppression (curated + nearby PMTiles vector duplicate within 85m)
    const searchSvc = new PMTilesSearchService();
    const activePoi = createPoi({ id: 'osm-keep-1', nameHe: 'מפל התנור', lon: 35.57, lat: 33.28 });
    const deletedPoi = createPoi({ id: 'osm-del-1', nameHe: 'עין עקב', lon: 34.8134, lat: 30.8281 });
    (searchSvc as any).records = [
      {
        id: 'pmt-dup-1',
        name: 'עין עקב',
        nameNorm: 'עין עקב',
        nameEn: 'Ein Akev',
        nameEnNorm: 'ein akev',
        kind: 'water',
        kindLabelHe: 'מעיין',
        layer: 'poi',
        lon: 34.8136, // ~20m away from deletedPoi
        lat: 30.8282,
        searchBlob: 'עין עקב ein akev',
      },
      {
        id: 'pmt-far-1',
        name: 'מפל דבורה',
        nameNorm: 'מפל דבורה',
        nameEn: 'Dvora Waterfall',
        nameEnNorm: 'dvora waterfall',
        kind: 'water',
        kindLabelHe: 'מפל',
        layer: 'poi',
        lon: 35.72,
        lat: 32.98,
        searchBlob: 'מפל דבורה dvora waterfall',
      },
    ];

    const hits = searchSvc.search('עין עקב', {
      pois: [activePoi], // deletedPoi already removed from state, PMTiles index still has pmt-dup-1
      routes: [],
      referenceCoord: { lon: 34.81, lat: 30.83 },
      deletedSignatures: [
        {
          id: deletedPoi.id,
          normName: 'עין עקב',
          lon: deletedPoi.lon,
          lat: deletedPoi.lat,
        },
      ],
    });
    expect(hits.some((h) => h.id === 'pmt-dup-1' || h.id === deletedPoi.id)).toBe(false);

    // 2. UserStateSyncService override sanitization & per-ID merge
    const sanitized = sanitizePoiOverrides([
      { id: 'osm-1', category: 'water', subcategory: 'camp_site', deleted: false, updatedAt: '2026-11-12T10:00:00Z' },
      { id: 'osm-2', deleted: true, updatedAt: '2026-11-12T11:00:00Z' },
      { id: '', deleted: true, updatedAt: '2026-11-12T11:00:00Z' } as any,
    ]);
    expect(sanitized).toHaveLength(2);
    // Cross-category subcategory normalized safely to water default
    const osm1San = sanitized.find((o) => o.id === 'osm-1')!;
    expect(osm1San.category).toBe('water');
    expect(osm1San.subcategory).toBe('spring');

    const localState: PersistedUserState = {
      version: 1,
      camera: null,
      cameraUpdatedAt: 0,
      config: {
        theme: 'topo-day',
        visibility: { ...DEFAULT_LAYER_VISIBILITY },
        navOrientation: 'heading-up',
        showCenterCrosshair: false,
        planningMode: '4x4',
        userIcon: { icon: BUILT_IN_USER_ICONS[0], accentColor: '#0ea5e9' },
      },
      configUpdatedAt: 0,
      poiOverrides: [
        { id: 'osm-1', category: 'offroad', subcategory: 'maale', deleted: false, updatedAt: '2026-11-12T10:00:00Z' },
      ],
      poiOverridesUpdatedAt: 1000,
      lastUpdatedByDeviceId: 'dev-a',
    };
    const remoteState: Partial<PersistedUserState> = {
      version: 1,
      poiOverrides: [
        { id: 'osm-1', category: 'water', subcategory: 'spring', deleted: false, updatedAt: '2026-11-12T12:00:00Z' },
        { id: 'osm-2', deleted: true, updatedAt: '2026-11-12T12:05:00Z' },
      ],
      poiOverridesUpdatedAt: 2000,
      lastUpdatedByDeviceId: 'dev-b',
    };
    const merged = mergeUserStates(localState, remoteState, 'dev-a');
    expect(merged.applyRemotePoiOverrides).toBe(true);
    expect(merged.merged.poiOverrides?.find((o) => o.id === 'osm-1')?.category).toBe('water');
    expect(merged.merged.poiOverrides?.find((o) => o.id === 'osm-2')?.deleted).toBe(true);

    // 3. CarSyncService includes category-overridden bundled POIs & deletedPoiIdsJson
    const overriddenBundled = createPoi({ id: 'osm-node-777', category: 'campsite', subcategory: 'camp_site' });
    const untouchedBundled = createPoi({ id: 'osm-node-888', category: 'peak', subcategory: 'peak' });
    const carSyncable = selectCarSyncablePois([overriddenBundled, untouchedBundled], ['osm-node-777']);
    expect(carSyncable.map((p) => p.id)).toEqual(['osm-node-777']);

    const carPayload = buildCarSyncPayload({
      activeRoute: null,
      routes: [],
      pois: [overriddenBundled, untouchedBundled],
      overriddenPoiIds: ['osm-node-777'],
      deletedPoiIds: ['or-del-2', 'osm-del-1', 'or-del-2'],
      isNavigationActive: false,
      theme: 'topo-day',
      visibility: DEFAULT_LAYER_VISIBILITY,
    });
    expect(JSON.parse(carPayload.userPoisJson).map((p: any) => p.id)).toEqual(['osm-node-777']);
    expect(JSON.parse(carPayload.deletedPoiIdsJson)).toEqual(['or-del-2', 'osm-del-1'].sort());
  });
});
