import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  applyLayerVisibilityToMap,
  buildIsraelOutdoorStyle,
  DEFAULT_LAYER_VISIBILITY,
  type MapStyleId,
  type OutdoorLayerVisibility,
} from '../style/israelOutdoorStyle';
import {
  REGIONAL_TRAILS,
  REGIONAL_TRAILS_SOURCE_ID,
  REGIONAL_TRAIL_NAME_LAYER_ID,
  raiseRegionalTrailNamesAbove,
} from '../style/regionalTrails';
import { sanitizeVisibility } from '../preferences/UserStateSyncService';
import { buildCarSyncPayload } from '../car/CarSyncService';

const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');

const REGIONAL_LAYER_IDS = [
  'trail-regional-line',
  'trail-regional-dash',
  'trail-regional-line-purple',
  REGIONAL_TRAIL_NAME_LAYER_ID,
];
const SHVIL_ISRAEL_LAYER_IDS = ['trail-israel-lowzoom', 'trail-israel-secondary-', 'trail-israel-primary+'];

function build(
  visibility: OutdoorLayerVisibility,
  theme: 'topo-day' | 'topo-dark' = 'topo-day',
  mapStyle: MapStyleId = 'ihm'
) {
  return buildIsraelOutdoorStyle({
    osmProtocolUrl: 'pmtiles://israel-osm',
    demProtocolUrl: 'pmtiles://israel-dem',
    contourProtocolUrl: null,
    visibility,
    theme,
    mapStyle,
  });
}

const layerOf = (style: any, id: string) => style.layers.find((l: any) => l.id === id) as any;
const visOf = (style: any, id: string) => layerOf(style, id)?.layout?.visibility;

function evalLineColor(style: any, layerId: string, props: Record<string, any>): string {
  const compiled = styleSpec.createPropertyExpression(
    layerOf(style, layerId).paint['line-color'],
    styleSpec.latest.paint_line['line-color']
  );
  expect(compiled.result).toBe('success');
  const c = compiled.value.evaluate({ zoom: 14 }, { type: 2, properties: props });
  if (c.a === 0) return 'transparent';
  const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function passesFilter(style: any, layerId: string, props: Record<string, any>): boolean {
  return styleSpec
    .featureFilter(layerOf(style, layerId).filter)
    .filter({ zoom: 14 }, { type: 2, properties: props });
}

describe('Regional long-distance trails layer', () => {
  it('is off by default and leaves Shvil Israel on', () => {
    expect(DEFAULT_LAYER_VISIBILITY.regionalTrails).toBe(false);
    for (const mapStyle of ['ihm', 'nms', 'govmap'] as const) {
      const style = build(DEFAULT_LAYER_VISIBILITY, 'topo-day', mapStyle);
      for (const id of REGIONAL_LAYER_IDS) {
        expect(visOf(style, id), `${mapStyle}: ${id} hidden by default`).toBe('none');
      }
      for (const id of SHVIL_ISRAEL_LAYER_IDS) {
        expect(visOf(style, id), `${mapStyle}: ${id} stays visible`).toBe('visible');
      }
    }
  });

  it('toggles independently of the marked hiking trails switch', () => {
    const regionalOnly = build({ ...DEFAULT_LAYER_VISIBILITY, hikingTrails: false, regionalTrails: true });
    for (const id of REGIONAL_LAYER_IDS) expect(visOf(regionalOnly, id), id).toBe('visible');
    for (const id of SHVIL_ISRAEL_LAYER_IDS) expect(visOf(regionalOnly, id), id).toBe('none');

    const both = build({ ...DEFAULT_LAYER_VISIBILITY, regionalTrails: true });
    for (const id of [...REGIONAL_LAYER_IDS, ...SHVIL_ISRAEL_LAYER_IDS]) {
      expect(visOf(both, id), id).toBe('visible');
    }

    // Still drawn over aerial imagery, like the other trail overlays.
    const onSatellite = build({ ...DEFAULT_LAYER_VISIBILITY, regionalTrails: true, googleSatellite: true });
    for (const id of REGIONAL_LAYER_IDS) expect(visOf(onSatellite, id), id).toBe('visible');
  });

  it('treats saved settings from before the layer existed as off', () => {
    const { regionalTrails: _dropped, ...legacy } = DEFAULT_LAYER_VISIBILITY;
    expect(sanitizeVisibility(legacy).regionalTrails).toBe(false);
    expect(sanitizeVisibility({ ...legacy, regionalTrails: true }).regionalTrails).toBe(true);
    for (const id of REGIONAL_LAYER_IDS) {
      expect(visOf(build(legacy as OutdoorLayerVisibility), id), id).toBe('none');
    }
  });

  it('switches lines and names in place without rebuilding the style', () => {
    const watched = [...REGIONAL_LAYER_IDS, 'name-trail-regional', ...SHVIL_ISRAEL_LAYER_IDS];
    const run = (visibility: OutdoorLayerVisibility) => {
      const updates: Record<string, string> = {};
      applyLayerVisibilityToMap(
        {
          getStyle: () => ({ layers: watched.map((id) => ({ id })) }),
          getLayer: (id: string) => (watched.includes(id) ? { id } : undefined),
          getSource: () => undefined,
          getTerrain: () => null,
          setTerrain: () => {},
          setLayoutProperty: (id: string, prop: string, val: string) => {
            if (prop === 'visibility') updates[id] = val;
          },
          setPaintProperty: () => {},
        },
        visibility
      );
      return updates;
    };

    const off = run(DEFAULT_LAYER_VISIBILITY);
    const on = run({ ...DEFAULT_LAYER_VISIBILITY, regionalTrails: true });
    for (const id of [...REGIONAL_LAYER_IDS, 'name-trail-regional']) {
      expect(off[id], id).toBe('none');
      expect(on[id], id).toBe('visible');
    }
    for (const id of SHVIL_ISRAEL_LAYER_IDS) {
      expect(off[id], id).toBe('visible');
      expect(on[id], id).toBe('visible');
    }
  });

  it('labels every regional trail by name along its route, excluding Shvil Israel', () => {
    const names = REGIONAL_TRAILS.map((t) => t.name);
    expect(names).toEqual([
      'סובב מכתש רמון',
      'מסע מים אל ים',
      'שביל אזורי גליל עליון',
      'שביל בית הכרם',
      'שביל מגידו',
      'שביל ישו',
      'שביל השרון',
      'שביל יזרעאל',
      'שביל עמק המעיינות',
      'שביל סובב כנרת',
      'שביל הגולן',
      'שביל ירושלים',
      'שביל גולני',
      'שביל ואדיות חיפה',
    ]);
    expect(names).not.toContain('שביל ישראל');

    for (const theme of ['topo-day', 'topo-dark'] as const) {
      const style = build({ ...DEFAULT_LAYER_VISIBILITY, regionalTrails: true }, theme);
      expect(styleSpec.validateStyleMin(style)).toEqual([]);

      const features = (style.sources[REGIONAL_TRAILS_SOURCE_ID] as any).data.features;
      expect(features).toHaveLength(REGIONAL_TRAILS.length);
      for (const feature of features) {
        expect(feature.geometry.type).toBe('MultiLineString');
        expect(feature.geometry.coordinates.length).toBeGreaterThan(0);
        for (const line of feature.geometry.coordinates) {
          expect(line.length).toBeGreaterThanOrEqual(2);
          for (const [lon, lat] of line) {
            expect(lon).toBeGreaterThan(34);
            expect(lon).toBeLessThan(36);
            expect(lat).toBeGreaterThan(29.4);
            expect(lat).toBeLessThan(33.5);
          }
        }
      }

      const nameLayer = layerOf(style, REGIONAL_TRAIL_NAME_LAYER_ID);
      expect(nameLayer.type).toBe('symbol');
      expect(nameLayer.source).toBe(REGIONAL_TRAILS_SOURCE_ID);
      expect(nameLayer.minzoom).toBe(layerOf(style, 'trail-regional-line').minzoom);
      expect(nameLayer.layout['symbol-placement']).toBe('line');
      expect(nameLayer.layout['text-field']).toEqual(['get', 'name']);

      // Every trail gets its own symbol colour rather than the neutral fallback.
      const textColor = styleSpec.createPropertyExpression(
        nameLayer.paint['text-color'],
        styleSpec.latest.paint_symbol['text-color']
      );
      expect(textColor.result).toBe('success');
      const fallback = textColor.value.evaluate({ zoom: 14 }, { type: 2, properties: { symbol: '' } }).toString();
      for (const feature of features) {
        expect(
          textColor.value.evaluate({ zoom: 14 }, feature).toString(),
          `${feature.properties.name} label colour`
        ).not.toBe(fallback);
      }
    }
  });

  it('draws every listed trail from its tile symbol, including segments shared with a national route', () => {
    const style = build({ ...DEFAULT_LAYER_VISIBILITY, regionalTrails: true });
    const line = (props: Record<string, any>) => evalLineColor(style, 'trail-regional-line', props);
    const dash = (props: Record<string, any>) => evalLineColor(style, 'trail-regional-dash', props);

    expect(line({ network: 'rwn', osmc_symbol: 'orange:white:orange_stripe' })).toBe('#FFA500');
    expect(line({ network: 'rwn', osmc_symbol: 'blue:blue:white_right:purple_stripe' })).toBe('#1765AD');
    expect(dash({ network: 'rwn', osmc_symbol: 'blue:blue:white_right:purple_stripe' })).toBe('#7B5CA0');
    expect(line({ network: 'rwn', osmc_symbol: 'green:green:white_right:blue_stripe' })).toBe('#00C000');
    expect(dash({ network: 'rwn', osmc_symbol: 'green:green:white_right:blue_stripe' })).toBe('#0000FF');
    expect(line({ network: 'rwn', osmc_symbol: 'yellow:blue:yellow_stripe' })).toBe('#FFD700');

    // Golani Trail is tagged as a national route in the tiles.
    const golani = { network: 'nwn', osmc_symbol: 'yellow:green:yellow_stripe', colour: 'yellow' };
    expect(passesFilter(style, 'trail-regional-line', golani)).toBe(true);
    expect(passesFilter(style, 'trail-regional-dash', golani)).toBe(true);
    expect(line(golani)).toBe('#22C55E');
    expect(dash(golani)).toBe('#EAB308');

    // Haifa Wadis Trail is matched by symbol: the tiles carry no route name.
    const haifa = { network: 'rwn', osmc_symbol: 'green:red:green_left' };
    expect(line(haifa)).toBe('#008000');
    expect(dash(haifa)).toBe('#FF0000');

    // A purple route sharing a path with Shvil Israel keeps its side line...
    const sharedWithShvil = {
      network: 'nwn',
      osmc_symbol: 'orange:orange:white_right:blue_stripe|black:white:black_stripe|purple:white:purple_stripe',
    };
    expect(passesFilter(style, 'trail-regional-line-purple', sharedWithShvil)).toBe(true);

    // ...while Shvil Israel on its own gets no regional line at all.
    const shvilOnly = { network: 'nwn', osmc_symbol: 'orange:orange:white_right:blue_stripe', colour: 'orange' };
    expect(passesFilter(style, 'trail-regional-line-purple', shvilOnly)).toBe(false);
    expect(line(shvilOnly)).toBe('transparent');
    expect(dash(shvilOnly)).toBe('transparent');

    // Plain marked local trails are untouched.
    const local = { network: 'lwn', osmc_symbol: 'red:white:red_stripe', colour: 'red' };
    for (const id of ['trail-regional-line', 'trail-regional-dash', 'trail-regional-line-purple']) {
      expect(passesFilter(style, id, local), id).toBe(false);
    }
  });

  it('keeps the names above runtime POI layers so dense POIs cannot crowd them out', () => {
    const poiIds = ['israel-pois-peaks', 'israel-pois-midzoom', 'israel-pois-labels'];
    const mockMap = (initialOrder: string[]) => {
      let order = [...initialOrder];
      const moves: string[] = [];
      return {
        moves,
        order: () => order,
        getLayer: (id: string) => (order.includes(id) ? { id } : undefined),
        getLayersOrder: () => [...order],
        moveLayer: (id: string) => {
          moves.push(id);
          order = [...order.filter((x) => x !== id), id];
        },
      };
    };

    // POI tiers were just added on top of the base style: names move above them, once.
    const fresh = mockMap(['name-primary', REGIONAL_TRAIL_NAME_LAYER_ID, 'place-city', ...poiIds]);
    raiseRegionalTrailNamesAbove(fresh, poiIds);
    expect(fresh.order().at(-1)).toBe(REGIONAL_TRAIL_NAME_LAYER_ID);
    raiseRegionalTrailNamesAbove(fresh, poiIds);
    expect(fresh.moves).toEqual([REGIONAL_TRAIL_NAME_LAYER_ID]);

    // Overlays added later (routes, markers) are left above the names.
    const settled = mockMap([...poiIds, REGIONAL_TRAIL_NAME_LAYER_ID, 'saved-routes-line']);
    raiseRegionalTrailNamesAbove(settled, poiIds);
    expect(settled.moves).toEqual([]);

    // A style without the name layer is left alone.
    const without = mockMap(['name-primary', ...poiIds]);
    raiseRegionalTrailNamesAbove(without, poiIds);
    expect(without.moves).toEqual([]);
  });

  it('mirrors the switch to Android Auto', () => {
    const payloadFor = (visibility: OutdoorLayerVisibility) =>
      JSON.parse(
        buildCarSyncPayload({
          activeRoute: null,
          routes: [],
          pois: [],
          isNavigationActive: false,
          theme: 'topo-day',
          visibility,
        } as any).carStateJson
      ).visibility;

    expect(payloadFor(DEFAULT_LAYER_VISIBILITY).regionalTrails).toBe(false);
    expect(payloadFor({ ...DEFAULT_LAYER_VISIBILITY, regionalTrails: true }).regionalTrails).toBe(true);
    expect(payloadFor(DEFAULT_LAYER_VISIBILITY).hikingTrails).toBe(true);
  });
});
