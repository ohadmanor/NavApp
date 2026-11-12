import { describe, expect, it, vi } from 'vitest';
import {
  globalPixelToLonLat,
  TILE_EXTENT,
  TileRoadGraphBuilder,
  type DecodedWay,
} from '../routing/TileRoadGraphBuilder';
import { HighwayWayGeometryService } from '../trails/HighwayWayGeometryService';
import {
  parseTrailWayId,
  trailWayIdFromMvtId,
  validateTrailAnnotationInput,
} from '../trails/TrailAnnotationTypes';

function createWay(
  featureId: string,
  points: Array<{ gx: number; gy: number; clipped?: boolean }>
): DecodedWay {
  return {
    featureId,
    props: { class: 'track', subclass: 'dirt' },
    layer: 0,
    points: points.map(({ gx, gy, clipped }) => {
      const [lon, lat] = globalPixelToLonLat(gx, gy);
      return { gx, gy, lon, lat, isClipped: Boolean(clipped) };
    }),
  };
}

describe('community trail annotation identity and geometry', () => {
  it('accepts only positive numeric highway feature IDs as OSM way references', () => {
    expect(trailWayIdFromMvtId(1234)).toBe('osm:way:1234');
    expect(trailWayIdFromMvtId('1234')).toBe('osm:way:1234');
    expect(trailWayIdFromMvtId(0)).toBeNull();
    expect(trailWayIdFromMvtId('anon-5-7-2')).toBeNull();
    expect(parseTrailWayId('osm:way:9007199254740992')).toBeNull();
  });

  it('stitches a complete way across a PMTiles tile boundary', async () => {
    const tx = 100;
    const ty = 200;
    const seam = (tx + 1) * TILE_EXTENT;
    const y = ty * TILE_EXTENT + 2000;
    const first = createWay('42', [
      { gx: tx * TILE_EXTENT + 400, gy: y },
      { gx: seam, gy: y, clipped: true },
    ]);
    const second = createWay('42', [
      { gx: seam, gy: y, clipped: true },
      { gx: seam + 800, gy: y - 100 },
    ]);
    const builder = new TileRoadGraphBuilder();
    vi.spyOn(builder, 'getDecodedTileWays').mockImplementation(async (x, yTile) => {
      if (x === tx && yTile === ty) return [first];
      if (x === tx + 1 && yTile === ty) return [second];
      return [];
    });
    const [lon, lat] = globalPixelToLonLat(tx * TILE_EXTENT + 500, y);

    const resolved = await new HighwayWayGeometryService(builder).resolveWayAt(
      'osm:way:42',
      lon,
      lat,
      'release-1'
    );

    expect(resolved.geometry.coordinates).toHaveLength(1);
    expect(resolved.geometry.coordinates[0]).toHaveLength(3);
    expect(resolved.releaseId).toBe('release-1');
  });

  it('refuses to publish a clipped fragment when the neighboring tile is missing', async () => {
    const tx = 100;
    const ty = 200;
    const seam = (tx + 1) * TILE_EXTENT;
    const y = ty * TILE_EXTENT + 2000;
    const clipped = createWay('42', [
      { gx: tx * TILE_EXTENT + 400, gy: y },
      { gx: seam, gy: y, clipped: true },
    ]);
    const builder = new TileRoadGraphBuilder();
    vi.spyOn(builder, 'getDecodedTileWays').mockImplementation(async (x, yTile) =>
      x === tx && yTile === ty ? [clipped] : []
    );
    const [lon, lat] = globalPixelToLonLat(tx * TILE_EXTENT + 500, y);

    await expect(
      new HighwayWayGeometryService(builder).resolveWayAt(
        'osm:way:42',
        lon,
        lat,
        'release-1'
      )
    ).rejects.toThrow('clipped or missing');
  });

  it('validates trail fields while preserving leading-zero numbers and Hebrew text', () => {
    expect(
      validateTrailAnnotationInput({
        wayIds: ['osm:way:42'],
        color: '#16a34a',
        number: '001A',
        description: 'שביל קהילתי',
        reason: '',
      })
    ).toBeNull();
    expect(
      validateTrailAnnotationInput({
        wayIds: ['osm:way:42', 'osm:way:42'],
        color: '#16a34a',
        number: '1',
        description: '',
      })
    ).toContain('more than once');
  });
});
