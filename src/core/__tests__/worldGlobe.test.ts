import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';
import { PMTiles, TileType } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  DEFAULT_LAYER_VISIBILITY,
  GOOGLE_SATELLITE_LAYER_ID,
  GOVMAP_ORTHO_LAYER_ID,
} from '../style/israelOutdoorStyle';
import {
  WORLD_BASEMAP_ASSET_PATH,
  WORLD_BASEMAP_SOURCE_ID,
  WORLD_BASEMAP_SOURCE_LAYER,
  WORLD_GLOBE_LAYER_IDS,
  WORLD_OCEAN_LAYER_ID,
  WORLD_COUNTRY_LABELS_LAYER_ID,
} from '../style/worldGlobeStyle';
import { sanitizeCamera } from '../preferences/UserStateSyncService';

describe('3D Globe Projection & Offline World Basemap', () => {
  it('enables globe projection and hides regional box bounds by default across all map styles and themes', async () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');
    const validate = styleSpec.validateStyleMin || styleSpec.validate;

    for (const mapStyle of ['ihm', 'nms', 'govmap'] as const) {
      for (const theme of ['topo-day', 'topo-dark'] as const) {
        const style = buildIsraelOutdoorStyle({
          osmProtocolUrl: 'pmtiles://israel-osm',
          demProtocolUrl: 'pmtiles://israel-dem',
          contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
          visibility: { ...DEFAULT_LAYER_VISIBILITY, terrain3d: true },
          theme,
          mapStyle,
        });

        expect(style.projection).toEqual({ type: 'globe' });
        expect((style.layers.find((l) => l.id === 'boundary-country-line') as any)?.minzoom).toBe(5.5);
        expect((style.layers.find((l) => l.id === 'Terrain') as any)?.minzoom).toBe(8);
        expect(style.sources[WORLD_BASEMAP_SOURCE_ID]).toBeDefined();
        expect((style.sources[WORLD_BASEMAP_SOURCE_ID] as any).type).toBe('vector');
        expect((style.sources[WORLD_BASEMAP_SOURCE_ID] as any).url).toContain(
          WORLD_BASEMAP_ASSET_PATH
        );

        const layerIds = style.layers.map((l) => l.id);
        for (const worldId of WORLD_GLOBE_LAYER_IDS) {
          expect(layerIds).toContain(worldId);
        }

        const orthoIdx = layerIds.indexOf(GOVMAP_ORTHO_LAYER_ID);
        const satIdx = layerIds.indexOf(GOOGLE_SATELLITE_LAYER_ID);
        const bgIdx = layerIds.indexOf('background');
        const oceanIdx = layerIds.indexOf(WORLD_OCEAN_LAYER_ID);
        const areaResIdx = layerIds.indexOf('area-residential');
        const placeCityIdx = layerIds.indexOf('place-city');

        expect(satIdx).toBe(bgIdx + 1);
        expect(oceanIdx).toBeGreaterThan(orthoIdx);
        expect(oceanIdx).toBeLessThan(areaResIdx);
        expect(layerIds.indexOf(WORLD_COUNTRY_LABELS_LAYER_ID)).toBeLessThan(placeCityIdx);

        expect(validate(style)).toEqual([]);
      }
    }
  });

  it('hides world globe layers when satellite/ortho is active and restores them in-place when toggled off', () => {
    const satStyle = buildIsraelOutdoorStyle({
      visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true },
      theme: 'topo-day',
    });

    for (const worldId of WORLD_GLOBE_LAYER_IDS) {
      const layer = satStyle.layers.find((l) => l.id === worldId) as any;
      expect(layer?.layout?.visibility).toBe('none');
    }

    const baseStyle = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });
    const setLayoutProperty = vi.fn();
    const mockMap = {
      getStyle: () => baseStyle,
      getLayer: (id: string) => baseStyle.layers.some((l) => l.id === id),
      setLayoutProperty,
      setPaintProperty: vi.fn(),
      getSource: () => null,
      getTerrain: () => null,
      getSky: () => ({}),
    };

    applyLayerVisibilityToMap(mockMap, { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true });
    for (const worldId of WORLD_GLOBE_LAYER_IDS) {
      expect(setLayoutProperty).toHaveBeenCalledWith(worldId, 'visibility', 'none');
    }

    setLayoutProperty.mockClear();
    applyLayerVisibilityToMap(mockMap, DEFAULT_LAYER_VISIBILITY);
    for (const worldId of WORLD_GLOBE_LAYER_IDS) {
      expect(setLayoutProperty).toHaveBeenCalledWith(worldId, 'visibility', 'visible');
    }
  });

  it('supports explicit vertical-perspective (z11..12 blend) and flat Mercator targets (Android Auto)', () => {
    const vpStyle = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      projection: 'vertical-perspective',
    });
    expect(vpStyle.projection).toEqual({
      type: ['interpolate', ['linear'], ['zoom'], 11, 'vertical-perspective', 12, 'mercator'],
    });

    const flatStyle = buildIsraelOutdoorStyle({
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
      projection: 'mercator',
      includeWorldGlobe: false,
    });

    expect(flatStyle.projection).toBeUndefined();
    expect(flatStyle.sources[WORLD_BASEMAP_SOURCE_ID]).toBeUndefined();
    for (const worldId of WORLD_GLOBE_LAYER_IDS) {
      expect(flatStyle.layers.some((l) => l.id === worldId)).toBe(false);
    }
  });

  it('ships valid offline world-basemap.pmtiles (no heavy GeoJSON) precached in the Service Worker', async () => {
    const pmtilesPath = path.resolve('src/public/assets/world-globe/world-basemap.pmtiles');
    const legacyGeojsonPath = path.resolve('src/public/assets/world-globe/world-basemap.geojson');
    expect(fs.existsSync(pmtilesPath)).toBe(true);
    expect(fs.existsSync(legacyGeojsonPath)).toBe(false);

    const fd = fs.openSync(pmtilesPath, 'r');
    try {
      const pm = new PMTiles({
        getKey: () => pmtilesPath,
        async getBytes(offset, length) {
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, offset);
          return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
        },
      });
      const header = await pm.getHeader();
      expect(header.tileType).toBe(TileType.Mvt);
      expect(header.minZoom).toBe(0);
      expect(header.maxZoom).toBeGreaterThanOrEqual(6);

      const meta: any = await pm.getMetadata();
      expect(Array.isArray(meta?.vector_layers)).toBe(true);
      expect(meta.vector_layers.some((v: any) => v.id === WORLD_BASEMAP_SOURCE_LAYER)).toBe(true);

      const kinds = new Set<string>();
      for (const [z, x, y] of [
        [0, 0, 0],
        [2, 2, 1],
        [6, 38, 26],
      ]) {
        const res = await pm.getZxy(z, x, y);
        expect(res?.data).toBeDefined();
        const vt = new VectorTile(new PbfReader(new Uint8Array(res!.data)));
        const layer = vt.layers[WORLD_BASEMAP_SOURCE_LAYER];
        expect(layer).toBeDefined();
        expect(layer.length).toBeGreaterThan(0);
        for (let i = 0; i < layer.length; i++) {
          const kind = layer.feature(i).properties?.kind;
          if (typeof kind === 'string') kinds.add(kind);
        }
      }
      for (const expectedKind of ['ocean', 'coastline', 'border', 'country', 'continent', 'sea', 'graticule']) {
        expect(kinds.has(expectedKind)).toBe(true);
      }
    } finally {
      fs.closeSync(fd);
    }

    const swText = fs.readFileSync(path.resolve('src/public/sw.js'), 'utf-8');
    expect(swText).toContain(WORLD_BASEMAP_ASSET_PATH);
    expect(swText).not.toContain('world-basemap.geojson');
  });

  it('accepts polar globe latitudes up to +-85.05 degrees in sanitizeCamera', () => {
    const polar = sanitizeCamera({ lon: 0, lat: 85.05, zoom: 1.5, bearing: 0, pitch: 0 });
    expect(polar).toEqual({ lon: 0, lat: 85.05, zoom: 1.5, bearing: 0, pitch: 0 });
    expect(sanitizeCamera({ lon: 0, lat: 95, zoom: 1.5, bearing: 0, pitch: 0 })).toBeNull();
  });
});
