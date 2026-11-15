import { describe, it, expect, vi } from 'vitest';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  DEFAULT_LAYER_VISIBILITY,
  DEFAULT_MAP_STYLE,
} from '../style/israelOutdoorStyle';
import {
  getDefaultUserConfiguration,
  sanitizeUserConfiguration,
} from '../preferences/UserStateSyncService';
import { buildPoiIconSizeExpression } from '../pois/poiTaxonomy';

describe('Map Style Switcher (IHM vs NMS)', () => {
  it('defaults to NMS and keeps IHM style completely unchanged when mapStyle is "ihm"', () => {
    const defaultStyle = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });
    const explicitNms = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'nms',
    });
    const explicitIhm = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'ihm',
    });

    expect(DEFAULT_MAP_STYLE).toBe('nms');
    expect(defaultStyle).toEqual(explicitNms);

    const bg = explicitIhm.layers.find((l) => l.id === 'background') as any;
    const motorway = explicitIhm.layers.find((l) => l.id === 'road-motorway') as any;
    const trunk = explicitIhm.layers.find((l) => l.id === 'road-trunk') as any;
    const primary = explicitIhm.layers.find((l) => l.id === 'road-primary') as any;
    const placeCity = explicitIhm.layers.find((l) => l.id === 'place-city') as any;

    expect(bg.paint['background-color']).toBe('#FFFFFF');
    expect(motorway.paint['line-color']).toBe('blue');
    expect(trunk.paint['line-color']).toBe('red');
    expect(primary.paint['line-color']).toBe('green');
    expect(placeCity.layout['text-size']).toBe(18);
  });

  it('applies NMS cartographic colors for background, landuse, water, and highways in day & dark modes', () => {
    const nmsDay = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'nms',
    });
    const nmsDark = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-dark',
      mapStyle: 'nms',
    });

    expect(nmsDay.name).toContain('NMS');
    expect((nmsDay.layers.find((l) => l.id === 'background') as any).paint['background-color']).toBe('#FFFFFF');
    expect((nmsDark.layers.find((l) => l.id === 'background') as any).paint['background-color']).toBe('#0b1015');

    const dayMotorway = nmsDay.layers.find((l) => l.id === 'road-motorway') as any;
    const dayTrunk = nmsDay.layers.find((l) => l.id === 'road-trunk') as any;
    const dayPrimary = nmsDay.layers.find((l) => l.id === 'road-primary') as any;
    const darkMotorway = nmsDark.layers.find((l) => l.id === 'road-motorway') as any;
    const darkResidential = nmsDark.layers.find((l) => l.id === 'area-residential') as any;

    expect(dayMotorway.paint['line-color']).toBe('#E56B4E');
    expect(dayTrunk.paint['line-color']).toBe('#F29E4C');
    expect(dayPrimary.paint['line-color']).toBe('#F5C756');
    expect(darkMotorway.paint['line-color']).toBe('#B44B34');
    expect(darkResidential.paint['fill-color']).toBe('#171F2A');
  });

  it('applies zoom-progressive symbol sizing, minzooms, and text halos in NMS', () => {
    const nmsDay = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'nms',
    });

    const placeCity = nmsDay.layers.find((l) => l.id === 'place-city') as any;
    const placeFarm = nmsDay.layers.find((l) => l.id === 'place-farm') as any;
    const namePrimary = nmsDay.layers.find((l) => l.id === 'name-primary') as any;
    const namePath = nmsDay.layers.find((l) => l.id === 'name-path') as any;
    const shieldMotorway = nmsDay.layers.find((l) => l.id === 'shield-motorway') as any;
    const iconFuel = nmsDay.layers.find((l) => l.id === 'icon-fuel') as any;

    expect(Array.isArray(placeCity.layout['text-size'])).toBe(true);
    expect(placeCity.layout['text-size'][0]).toBe('interpolate');
    expect(placeFarm.minzoom).toBe(13);
    expect(Array.isArray(namePrimary.layout['text-size'])).toBe(true);
    expect(namePrimary.layout['symbol-spacing']).toBe(320);
    expect(namePath.minzoom).toBe(14.5);

    // Road shields: compact text-size, no halo smudge inside white shield, tight padding
    expect(shieldMotorway.layout['text-size']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      6,
      9.5,
      10,
      10.5,
      14,
      11.5,
      17,
      12.5,
    ]);
    expect(shieldMotorway.layout['icon-text-fit-padding']).toEqual([1.5, 5, 1.5, 5]);
    expect(shieldMotorway.paint['text-halo-width']).toBe(0);

    // Vector POIs: capped high-zoom icon-size (<= 0.78 at z17.5) & compact text
    expect(iconFuel.minzoom).toBe(14);
    expect(Array.isArray(iconFuel.layout['icon-size'])).toBe(true);
    expect(iconFuel.layout['icon-size'][iconFuel.layout['icon-size'].length - 1]).toBe(0.78);
    expect(Array.isArray(iconFuel.layout['text-size'])).toBe(true);
    expect(iconFuel.paint['text-halo-color']).toBe('#FFFFFF');

    // GeoJSON POI icon size expression: NMS capped at 0.78 multiplier vs IHM 1.28 at z17.5
    const ihmPoiSize = buildPoiIconSizeExpression('ihm');
    const nmsPoiSize = buildPoiIconSizeExpression('nms');
    expect(ihmPoiSize[ihmPoiSize.length - 1]).not.toEqual(nmsPoiSize[nmsPoiSize.length - 1]);
    expect(nmsPoiSize[nmsPoiSize.length - 2]).toBe(17.5);
  });

  it('preserves NMS casing and halo colors during applyLayerVisibilityToMap', () => {
    const nmsDay = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'nms',
    });

    const setPaintProperty = vi.fn();
    const mockMap = {
      getStyle: () => nmsDay,
      getLayer: (id: string) => nmsDay.layers.some((l) => l.id === id),
      setLayoutProperty: vi.fn(),
      setPaintProperty,
      getSource: () => null,
      getTerrain: () => null,
      getSky: () => ({}),
    };

    applyLayerVisibilityToMap(mockMap, {
      ...DEFAULT_LAYER_VISIBILITY,
      hikingTrails: false,
    });

    const minorCasingCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'casing-minor' && prop === 'line-color'
    );
    const localTrailNameHaloCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'name-trail-local' && prop === 'text-halo-color'
    );

    expect(minorCasingCall?.[2]).toBe('#8E8A82');
    expect(localTrailNameHaloCall?.[2]).toBe('#FFFFFF');
  });

  it('persists and sanitizes mapStyle in UserStateSyncService with NMS as default', () => {
    const def = getDefaultUserConfiguration();
    expect(def.mapStyle).toBe('nms');

    const ihmCfg = sanitizeUserConfiguration({ ...def, mapStyle: 'ihm' });
    expect(ihmCfg.mapStyle).toBe('ihm');

    const invalidCfg = sanitizeUserConfiguration({ ...def, mapStyle: 'unknown' as any });
    expect(invalidCfg.mapStyle).toBe('nms');
  });
});
