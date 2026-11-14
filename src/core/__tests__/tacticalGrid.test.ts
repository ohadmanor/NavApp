import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import maplibregl from 'maplibre-gl';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { MilitaryGridService } from '../navigation/MilitaryGridService';
import {
  generateTacticalGridMvtTile,
  registerTacticalGridProtocol,
  TACTICAL_GRID_SOURCE_LAYER,
  TACTICAL_GRID_TILE_URL,
} from '../navigation/TacticalGridTileProtocol';
import {
  buildIsraelOutdoorStyle,
  DEFAULT_LAYER_VISIBILITY,
} from '../style/israelOutdoorStyle';

function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

function tilePixelToLonLat(
  px: number,
  py: number,
  z: number,
  x: number,
  y: number,
  extent = 4096
): { lon: number; lat: number } {
  const n = 2 ** z;
  const lon = ((x + px / extent) / n) * 360 - 180;
  const yMerc = y + py / extent;
  const merc = Math.PI - (2 * Math.PI * yMerc) / n;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(merc));
  return { lon, lat };
}

describe('Dynamic Tactical Grid Vector Tile Engine (ITM & UTM)', () => {
  it('generates valid MVT v2 vector tiles aligned to true ITM integer kilometer coordinates', () => {
    // Jerusalem (approx ITM 220km E / 631km N)
    const z = 13;
    const { x, y } = lonLatToTile(35.2137, 31.7683, z);
    const buf = generateTacticalGridMvtTile(z, x, y);
    expect(buf.byteLength).toBeGreaterThan(0);

    const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
    const gridLayer = tile.layers[TACTICAL_GRID_SOURCE_LAYER];
    expect(gridLayer).toBeDefined();
    expect(gridLayer.version).toBe(2);
    expect(gridLayer.extent).toBe(4096);
    expect(gridLayer.length).toBeGreaterThanOrEqual(6);

    let eastingCount = 0;
    let northingCount = 0;

    for (let i = 0; i < gridLayer.length; i++) {
      const feat = gridLayer.feature(i);
      expect(feat.type).toBe(2); // LineString
      const geom = feat.loadGeometry();
      expect(geom.length).toBe(1);
      expect(geom[0].length).toBeGreaterThanOrEqual(2);

      const { axis, kind, label, showLabel } = feat.properties as {
        axis: string;
        kind: string;
        label?: string;
        showLabel: boolean;
      };
      expect(['major', 'minor']).toContain(kind);
      expect(showLabel).toBe(true);
      expect(label).toMatch(/^\d{3}$/);

      const midPt = geom[0][Math.floor(geom[0].length / 2)];
      const { lon, lat } = tilePixelToLonLat(midPt.x, midPt.y, z, x, y);
      const itm = MilitaryGridService.wgs84ToItm(lon, lat);
      const expectedMeters = Number(label) * 1000;

      if (axis === 'easting') {
        eastingCount++;
        // Tile integer quantization at z13 is ~1m; allow <= 15m tolerance
        expect(Math.abs(itm.easting - expectedMeters)).toBeLessThan(15);
      } else if (axis === 'northing') {
        northingCount++;
        expect(Math.abs(itm.northing - expectedMeters)).toBeLessThan(15);
      } else {
        throw new Error(`Unexpected grid axis: ${axis}`);
      }
    }

    expect(eastingCount).toBeGreaterThanOrEqual(3);
    expect(northingCount).toBeGreaterThanOrEqual(3);
  });

  it('produces 100m tactical sub-grid and 1km major lines at z16 and empty tiles below z7', () => {
    const emptyLow = generateTacticalGridMvtTile(6, 38, 26);
    expect(emptyLow.byteLength).toBe(0);

    const z = 16;
    const { x, y } = lonLatToTile(34.8134, 30.8281, z); // Ein Aqev
    const buf = generateTacticalGridMvtTile(z, x, y);
    expect(buf.byteLength).toBeGreaterThan(0);

    const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
    const gridLayer = tile.layers[TACTICAL_GRID_SOURCE_LAYER];
    expect(gridLayer).toBeDefined();

    const kinds = new Set<string>();
    const labels: string[] = [];
    for (let i = 0; i < gridLayer.length; i++) {
      const feat = gridLayer.feature(i);
      kinds.add(String(feat.properties.kind));
      if (feat.properties.showLabel) {
        labels.push(String(feat.properties.label));
      }
    }
    expect(kinds.has('minor')).toBe(true);
    expect(labels.some((l) => /^\d{3}(\.\d)?$/.test(l))).toBe(true);
  });

  it('seamlessly falls back to global UTM grid tiles outside Israel and round-trips UTM inverse', () => {
    // Chamonix, France (UTM Zone 32N)
    const lon = 6.8694;
    const lat = 45.9237;
    const utm = MilitaryGridService.wgs84ToUtm(lon, lat);
    expect(utm.zone).toBe(32);
    expect(utm.isNorthern).toBe(true);

    const inv = MilitaryGridService.utmToWgs84(utm.easting, utm.northing, utm.zone, utm.isNorthern);
    expect(Math.abs(inv.lon - lon)).toBeLessThan(0.0001);
    expect(Math.abs(inv.lat - lat)).toBeLessThan(0.0001);

    // Southern hemisphere (Patagonia, Zone 18S)
    const southUtm = MilitaryGridService.wgs84ToUtm(-72.95, -50.95);
    expect(southUtm.isNorthern).toBe(false);
    const southInv = MilitaryGridService.utmToWgs84(
      southUtm.easting,
      southUtm.northing,
      southUtm.zone,
      false
    );
    expect(Math.abs(southInv.lon - -72.95)).toBeLessThan(0.0001);
    expect(Math.abs(southInv.lat - -50.95)).toBeLessThan(0.0001);

    const z = 13;
    const { x, y } = lonLatToTile(lon, lat, z);
    const buf = generateTacticalGridMvtTile(z, x, y);
    expect(buf.byteLength).toBeGreaterThan(0);

    const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
    const gridLayer = tile.layers[TACTICAL_GRID_SOURCE_LAYER];
    expect(gridLayer).toBeDefined();
    expect(gridLayer.length).toBeGreaterThanOrEqual(6);
  });

  it('returns independent ArrayBuffer copies so MapLibre worker transfers do not detach cached tiles', () => {
    const z = 13;
    const { x, y } = lonLatToTile(35.2137, 31.7683, z);
    const buf1 = generateTacticalGridMvtTile(z, x, y);
    const buf2 = generateTacticalGridMvtTile(z, x, y);
    expect(buf1).not.toBe(buf2);
    expect(buf1.byteLength).toBe(buf2.byteLength);
  });

  it('integrates dynamic tactical-grid vector source and layers into buildIsraelOutdoorStyle cleanly', () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: DEFAULT_LAYER_VISIBILITY,
      theme: 'topo-day',
    });

    expect(styleSpec.validateStyleMin(style)).toEqual([]);

    const gridSource = style.sources['tactical-grid'] as any;
    expect(gridSource).toBeDefined();
    expect(gridSource.type).toBe('vector');
    expect(gridSource.tiles).toEqual([TACTICAL_GRID_TILE_URL]);
    expect(gridSource.minzoom).toBe(7);
    expect(gridSource.maxzoom).toBe(16);

    const minorIdx = style.layers.findIndex((l) => l.id === 'tactical-grid-minor');
    const majorIdx = style.layers.findIndex((l) => l.id === 'tactical-grid-major');
    const labelsIdx = style.layers.findIndex((l) => l.id === 'tactical-grid-labels');
    const placeCityIdx = style.layers.findIndex((l) => l.id === 'place-city');

    expect(minorIdx).toBeGreaterThan(0);
    expect(majorIdx).toBe(minorIdx + 1);
    expect(labelsIdx).toBe(majorIdx + 1);
    expect(labelsIdx).toBeLessThan(placeCityIdx);

    const hiddenGridStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: 'pmtiles://israel-osm',
      demProtocolUrl: 'pmtiles://israel-dem',
      contourProtocolUrl: 'dem-contour://{z}/{x}/{y}',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, tacticalGrid: false },
      theme: 'topo-dark',
    });
    expect(
      (hiddenGridStyle.layers.find((l) => l.id === 'tactical-grid-minor') as any)?.layout?.visibility
    ).toBe('none');
    expect(
      (hiddenGridStyle.layers.find((l) => l.id === 'tactical-grid-labels') as any)?.layout?.visibility
    ).toBe('none');
  });

  it('registers the tactical-grid protocol handler once and serves MVT tile responses', async () => {
    let registeredHandler: ((params: { url: string }) => Promise<{ data: ArrayBuffer }>) | null = null;
    const addProtoSpy = vi
      .spyOn(maplibregl, 'addProtocol')
      .mockImplementation((scheme: string, fn: any) => {
        if (scheme === 'tactical-grid') registeredHandler = fn;
      });

    try {
      registerTacticalGridProtocol();
      registerTacticalGridProtocol();

      expect(addProtoSpy).toHaveBeenCalledTimes(1);
      expect(registeredHandler).not.toBeNull();
      const z = 13;
      const { x, y } = lonLatToTile(35.2137, 31.7683, z);
      const res = await (registeredHandler as any)({
        url: `tactical-grid://${z}/${x}/${y}`,
      });
      expect(res.data).toBeInstanceOf(ArrayBuffer);
      expect(res.data.byteLength).toBeGreaterThan(0);
    } finally {
      addProtoSpy.mockRestore();
    }
  });
});
