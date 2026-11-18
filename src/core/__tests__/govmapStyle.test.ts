import { describe, it, expect, vi } from 'vitest';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  DEFAULT_LAYER_VISIBILITY,
  GOVMAP_ORTHO_LAYER_ID,
  GOVMAP_ORTHO_SOURCE_ID,
  GOVMAP_ORTHO_TILE_URL,
  isHighwayStyleLayerId,
  isPoiStyleLayerId,
} from '../style/israelOutdoorStyle';
import {
  getDefaultUserConfiguration,
  sanitizeUserConfiguration,
  sanitizeVisibility,
} from '../preferences/UserStateSyncService';
import { buildPoiIconSizeExpression } from '../pois/poiTaxonomy';

describe('GovMap 1:25k (Topo25k) Offline Vector Style', () => {
  it('applies Survey of Israel Topo25k palette, flat buildings, magenta parks, and sepia contours', () => {
    const govDay = buildIsraelOutdoorStyle({
      contourProtocolUrl: 'contours://{z}/{x}/{y}',
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'govmap',
    });
    const govDark = buildIsraelOutdoorStyle({
      contourProtocolUrl: 'contours://{z}/{x}/{y}',
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-dark',
      mapStyle: 'govmap',
    });

    expect(govDay.name).toContain('GovMap');

    const bgDay = govDay.layers.find((l) => l.id === 'background') as any;
    const bgDark = govDark.layers.find((l) => l.id === 'background') as any;
    expect(bgDay.paint['background-color']).toBe('#FFFFFF');
    expect(bgDark.paint['background-color']).toBe('#0b1015');

    const building = govDay.layers.find((l) => l.id === 'building') as any;
    expect(building.paint['fill-extrusion-height']).toBe(0);
    expect(building.paint['fill-extrusion-color']).toEqual(['coalesce', ['get', 'colour'], '#6E6556']);

    const areaAb = govDay.layers.find((l) => l.id === 'area-AB') as any;
    expect(areaAb.paint['fill-pattern']).toBeUndefined();
    expect(areaAb.paint['fill-color']).toBe('#F3DCF0');

    const boundaryPark = govDay.layers.find((l) => l.id === 'boundary-park') as any;
    const boundaryParkCasing = govDay.layers.find((l) => l.id === 'boundary-park-casing') as any;
    const namePark = govDay.layers.find((l) => l.id === 'name-park') as any;
    expect(boundaryPark.paint['line-color']).toBe('#B81D8A');
    expect(boundaryParkCasing.paint['line-opacity']).toBe(0);
    expect(namePark.paint['text-color']).toBe('#9D177D');

    const contourLine = govDay.layers.find((l) => l.id === 'contour-line') as any;
    const contourLabel = govDay.layers.find((l) => l.id === 'contour-label') as any;
    const waterArea = govDay.layers.find((l) => l.id === 'water-area') as any;
    const waterLine = govDay.layers.find((l) => l.id === 'water-line-intermittent') as any;
    expect(contourLine.paint['line-color']).toBe('#7A5438');
    expect(contourLabel.paint['text-color']).toBe('#7A5438');
    expect(waterArea.paint['fill-color']).toBe('#D8ECFA');
    expect(waterLine.paint['line-color']).toBe('#3B8AC4');

    const gridMajor = govDay.layers.find((l) => l.id === 'tactical-grid-major') as any;
    expect(gridMajor.paint['line-color']).toBe('#111111');
  });

  it('applies GovMap road colors, black casings, red primary shields, and compact POI scaling', () => {
    const govDay = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'govmap',
    });

    const motorway = govDay.layers.find((l) => l.id === 'road-motorway') as any;
    const primary = govDay.layers.find((l) => l.id === 'road-primary') as any;
    const secondary = govDay.layers.find((l) => l.id === 'road-secondary') as any;
    const minor = govDay.layers.find((l) => l.id === 'road-minor') as any;
    const casingPrimary = govDay.layers.find((l) => l.id === 'casing-primary') as any;
    const casingMinor = govDay.layers.find((l) => l.id === 'casing-minor') as any;
    const shieldPrimary = govDay.layers.find((l) => l.id === 'shield-primary') as any;

    expect(motorway.paint['line-color']).toBe('#4E74A8');
    expect(primary.paint['line-color']).toBe('#B84B31');
    expect(secondary.paint['line-color']).toBe('#B89F8D');
    expect(minor.paint['line-color']).toBe('#F5EE9E');
    expect(casingPrimary.paint['line-color']).toBe('#1A1A1A');
    expect(casingMinor.paint['line-color']).toBe('#1A1A1A');
    expect(shieldPrimary.layout['icon-image']).toBe('shield_red');
    expect(shieldPrimary.paint['text-color']).toBe('#B82925');

    expect(buildPoiIconSizeExpression('govmap')).toEqual(buildPoiIconSizeExpression('nms'));
  });

  it('preserves GovMap black casings and neutral MAPI dashed tracks/paths on live visibility toggles', () => {
    const govDay = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      mapStyle: 'govmap',
    });

    const setPaintProperty = vi.fn();
    const mockMap = {
      getStyle: () => govDay,
      getLayer: (id: string) => govDay.layers.some((l) => l.id === id),
      setLayoutProperty: vi.fn(),
      setPaintProperty,
      getSource: () => null,
      getTerrain: () => null,
      getSky: () => ({}),
    };

    applyLayerVisibilityToMap(mockMap, {
      ...DEFAULT_LAYER_VISIBILITY,
      hikingTrails: false,
      offroad4x4: false,
    });

    const minorCasingCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'casing-minor' && prop === 'line-color'
    );
    const primaryCasingCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'casing-primary' && prop === 'line-color'
    );
    const pathCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'path-path' && prop === 'line-color'
    );
    const trackRightCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'track-right' && prop === 'line-color'
    );
    const trackCasingCall = setPaintProperty.mock.calls.find(
      ([id, prop]) => id === 'casing-track' && prop === 'line-color'
    );

    expect(minorCasingCall?.[2]).toBe('#1A1A1A');
    expect(primaryCasingCall?.[2]).toBe('#1A1A1A');
    expect(pathCall?.[2]).toBe('#1E1E1E');
    expect(trackRightCall?.[2]).toBe('#1E1E1E');
    expect(trackCasingCall?.[2]).toBe('#FFFFFF');
  });

  it('persists and sanitizes "govmap" in UserStateSyncService', () => {
    const def = getDefaultUserConfiguration();
    const cfg = sanitizeUserConfiguration({ ...def, mapStyle: 'govmap' });
    expect(cfg.mapStyle).toBe('govmap');
  });

  it('registers GovMap Orthophoto 2025 raster layer (default OFF, z8-z20) and hides non-highway/POI layers when ON', () => {
    expect(DEFAULT_LAYER_VISIBILITY.govmapOrtho).toBe(false);

    const offStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    const orthoSrc = offStyle.sources[GOVMAP_ORTHO_SOURCE_ID] as any;
    expect(orthoSrc).toBeDefined();
    expect(orthoSrc.type).toBe('raster');
    expect(orthoSrc.tiles).toEqual([GOVMAP_ORTHO_TILE_URL]);
    expect(orthoSrc.minzoom).toBe(8);
    expect(orthoSrc.maxzoom).toBe(20);

    const orthoOffLayer = offStyle.layers.find((l) => l.id === GOVMAP_ORTHO_LAYER_ID) as any;
    expect(orthoOffLayer?.layout?.visibility).toBe('none');

    const onStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, govmapOrtho: true, cycleways: true, regionalTrails: true },
      theme: 'topo-day',
    });

    const orthoOnIdx = onStyle.layers.findIndex((l) => l.id === GOVMAP_ORTHO_LAYER_ID);
    expect((onStyle.layers[orthoOnIdx] as any).layout?.visibility).toBe('visible');

    for (let i = 0; i < onStyle.layers.length; i++) {
      const layer = onStyle.layers[i] as any;
      if (layer.id === GOVMAP_ORTHO_LAYER_ID) continue;
      if (isHighwayStyleLayerId(layer.id) || isPoiStyleLayerId(layer.id)) {
        expect(layer.layout?.visibility).toBe('visible');
        expect(i).toBeGreaterThan(orthoOnIdx);
      } else {
        expect(layer.layout?.visibility).toBe('none');
      }
    }

    const setLayoutProperty = vi.fn();
    const mockMap = {
      getStyle: () => offStyle,
      getLayer: (id: string) => offStyle.layers.some((l) => l.id === id),
      setLayoutProperty,
      setPaintProperty: vi.fn(),
      getSource: () => null,
      getTerrain: () => null,
      getSky: () => ({}),
    };

    applyLayerVisibilityToMap(mockMap, { ...DEFAULT_LAYER_VISIBILITY, govmapOrtho: true });
    expect(setLayoutProperty).toHaveBeenCalledWith(GOVMAP_ORTHO_LAYER_ID, 'visibility', 'visible');
    expect(setLayoutProperty).toHaveBeenCalledWith('tactical-grid-minor', 'visibility', 'none');

    const restoredVis = sanitizeVisibility({ ...DEFAULT_LAYER_VISIBILITY, govmapOrtho: true });
    expect(restoredVis.govmapOrtho).toBe(true);
  });
});
