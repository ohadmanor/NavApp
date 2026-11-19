import { describe, expect, it, vi } from 'vitest';
import {
  globalPixelToLonLat,
  TILE_EXTENT,
  TileRoadGraphBuilder,
  type DecodedWay,
} from '../routing/TileRoadGraphBuilder';
import { HighwayWayGeometryService } from '../trails/HighwayWayGeometryService';
import {
  detectTrailColorFromProps,
  detectTrailNameFromProps,
  detectTrailNumberFromProps,
  parseTrailWayId,
  trailWayIdFromMvtId,
  validateTrailAnnotationInput,
} from '../trails/TrailAnnotationTypes';
import { PMTilesSearchService } from '../search/PMTilesSearchService';
import { findIsraelTrailMatch } from '../trails/IsraelTrailsService';

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
        wayIds: ['osm:way:42'],
        color: '#16a34a',
        number: '',
        description: 'שביל קהילתי ללא מספר',
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

  it('detects trail colors from OSM colour and osmc_symbol tags', async () => {
    expect(detectTrailColorFromProps({ colour: 'blue' })).toBe('#2563eb');
    expect(detectTrailColorFromProps({ colour: 'green;black' })).toBe('#16a34a');
    expect(detectTrailColorFromProps({ osmc_symbol: 'blue:white:blue_stripe' })).toBe('#2563eb');
    expect(detectTrailColorFromProps({ class: 'path' })).toBeUndefined();

    const tx = 100;
    const ty = 200;
    const y = ty * TILE_EXTENT + 2000;
    const coloredWay = createWay('77', [
      { gx: tx * TILE_EXTENT + 400, gy: y },
      { gx: tx * TILE_EXTENT + 800, gy: y },
    ]);
    coloredWay.props.colour = 'blue';
    const builder = new TileRoadGraphBuilder();
    vi.spyOn(builder, 'getDecodedTileWays').mockResolvedValue([coloredWay]);
    const [lon, lat] = globalPixelToLonLat(tx * TILE_EXTENT + 500, y);

    const resolved = await new HighwayWayGeometryService(builder).resolveWayAt(
      'osm:way:77',
      lon,
      lat,
      'release-1'
    );
    expect(resolved.detectedColor).toBe('#2563eb');
  });

  it('detects trail name/ref from OSM props and searches trail annotations by name and number', () => {
    expect(detectTrailNameFromProps({ 'name:he': 'נחל כזיב', name: 'Nahal Kziv' })).toBe('נחל כזיב');
    expect(detectTrailNumberFromProps({ ref: '02341' })).toBe('02341');

    const service = new PMTilesSearchService();
    const trailAnnotations = [
      {
        id: 'trail-1',
        name: 'נחל כזיב',
        number: '02341',
        color: '#16a34a' as const,
        description: 'שביל ירוק בנחל כזיב',
        lon: 35.2,
        lat: 33.04,
      },
    ];
    const byName = service.search('כזיב', { trailAnnotations });
    expect(byName.length).toBeGreaterThanOrEqual(1);
    expect(byName[0].id).toBe('trail-annotation:trail-1');
    expect(byName[0].kind).toBe('trail-annotation');
    expect(byName[0].title).toBe('נחל כזיב (02341)');

    const byNumber = service.search('02341', { trailAnnotations });
    expect(byNumber).toHaveLength(1);
    expect(byNumber[0].trailAnnotationId).toBe('trail-1');

    const israelMatch = findIsraelTrailMatch({ number: '11420', lon: 35.374, lat: 31.107 });
    expect(israelMatch).not.toBeNull();
    expect(israelMatch!.name).toContain('סדום');

    const israelSearch = service.search('11420', { filter: 'routes' });
    expect(israelSearch.some((r) => r.id.startsWith('israel-trail:') && r.ref.includes('11420'))).toBe(true);
  });
});
