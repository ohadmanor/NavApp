import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/NavDatabase';
import { communityRoadsCloudService } from '../firebase/CommunityRoadsCloudService';
import {
  TRAIL_OVERLAY_BOOT_STORAGE_KEY,
  TrailAnnotationsCloudService,
} from '../firebase/TrailAnnotationsCloudService';
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
  getTrailGeometryCacheId,
  parseTrailWayId,
  trailWayIdFromMvtId,
  validateTrailAnnotationInput,
  type TrailAnnotationRecord,
  type TrailGeometryCacheRecord,
} from '../trails/TrailAnnotationTypes';
import { computeRoadBounds, type CommunityRoadRecord } from '../trails/CommunityRoadTypes';
import { PMTilesSearchService } from '../search/PMTilesSearchService';
import { findIsraelTrailMatch } from '../trails/IsraelTrailsService';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it('bootstraps trail overlay synchronously from boot storage, emits Dexie cache before remote sync, and resolves community:road:* from Dexie', async () => {
    const storeMap = new Map<string, string>();
    const memoryStorage: Storage = {
      get length() {
        return storeMap.size;
      },
      clear: () => storeMap.clear(),
      getItem: (key: string) => storeMap.get(key) ?? null,
      key: (idx: number) => Array.from(storeMap.keys())[idx] ?? null,
      removeItem: (key: string) => {
        storeMap.delete(key);
      },
      setItem: (key: string, value: string) => {
        storeMap.set(key, value);
      },
    };
    vi.stubGlobal('window', { localStorage: memoryStorage });

    const service = new TrailAnnotationsCloudService();
    memoryStorage.setItem(
      TRAIL_OVERLAY_BOOT_STORAGE_KEY,
      JSON.stringify({
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              id: 'boot-15129',
              geometry: { type: 'MultiLineString', coordinates: [[[34.98, 30.94], [34.99, 30.95]]] },
              properties: { trailId: 't-15129', wayId: 'osm:way:555', number: '15129', color: '#2563eb' },
            },
          ],
        },
        searchItems: [
          {
            id: 't-15129',
            name: 'חוצה מכתש גדול',
            number: '15129',
            color: '#2563eb',
            description: '',
            lon: 34.98,
            lat: 30.94,
          },
        ],
      })
    );
    const boot = service.getBootOverlaySnapshot();
    expect(boot.geojson.features).toHaveLength(1);
    expect(boot.searchItems[0].number).toBe('15129');

    const cachedAnn: TrailAnnotationRecord = {
      id: 't-15129',
      schemaVersion: 1,
      wayIds: ['osm:way:555'],
      color: '#2563eb',
      name: 'חוצה מכתש גדול',
      number: '15129',
      description: '',
      status: 'active',
      revision: 2,
      lastHistoryId: '2-h',
      geometryPath: 'trail_annotations/t-15129/geometry/2-h.json',
      selectionReleaseId: 'release-1',
      createdByUid: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedByUid: 'u1',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const geomMap = new Map<string, TrailGeometryCacheRecord>([
      [
        getTrailGeometryCacheId('release-1', 'osm:way:555'),
        {
          id: getTrailGeometryCacheId('release-1', 'osm:way:555'),
          wayId: 'osm:way:555',
          releaseId: 'release-1',
          geometry: { type: 'MultiLineString', coordinates: [[[34.981, 30.941], [34.991, 30.951]]] },
          layer: 0,
          highwayClass: 'track',
          highwaySubclass: 'grade3',
        },
      ],
    ]);

    vi.spyOn(db.trailAnnotations, 'toArray').mockResolvedValue([cachedAnn]);
    vi.spyOn(db.trailGeometryCache, 'get').mockImplementation((async (id: string) =>
      geomMap.get(id)) as any);
    vi.spyOn(db.trailGeometryCache, 'where').mockImplementation((() => ({
      equals: () => ({ toArray: async () => [] }),
    })) as any);

    let resolveRemote!: (val: { annotations: TrailAnnotationRecord[]; source: 'server' }) => void;
    vi.spyOn(service, 'loadPublishedAnnotations').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRemote = resolve;
        })
    );

    const emittedCoords: number[][] = [];
    const syncPromise = service.bootstrapAndSyncOverlay('release-1', (overlay) => {
      const feat = overlay.geojson.features[0] as GeoJSON.Feature<GeoJSON.MultiLineString> | undefined;
      if (feat?.geometry?.coordinates?.[0]?.[0]) {
        emittedCoords.push([...feat.geometry.coordinates[0][0]]);
      }
    });

    // Wait briefly for Dexie cached phase to complete while remote fetch is still pending
    await new Promise((r) => setTimeout(r, 20));
    expect(emittedCoords).toHaveLength(1);
    expect(emittedCoords[0][0]).toBeCloseTo(34.981, 4);

    // Update cached geometry and settle remote fetch -> emits refreshed coordinates & persists boot storage
    geomMap.set(getTrailGeometryCacheId('release-1', 'osm:way:555'), {
      id: getTrailGeometryCacheId('release-1', 'osm:way:555'),
      wayId: 'osm:way:555',
      releaseId: 'release-1',
      geometry: { type: 'MultiLineString', coordinates: [[[34.989, 30.949], [34.999, 30.959]]] },
      layer: 0,
      highwayClass: 'track',
      highwaySubclass: 'grade3',
    });
    resolveRemote({ annotations: [{ ...cachedAnn, revision: 3 }], source: 'server' });
    await syncPromise;

    expect(emittedCoords).toHaveLength(2);
    expect(emittedCoords[1][0]).toBeCloseTo(34.989, 4);
    expect((service.getBootOverlaySnapshot().geojson.features[0] as any).geometry.coordinates[0][0][0]).toBeCloseTo(
      34.989,
      4
    );

    // Verify HighwayWayGeometryService resolves community:road:* from Dexie even when memory cache is empty
    vi.spyOn(communityRoadsCloudService, 'getCachedRoads').mockReturnValue([]);
    const dexieRoad: CommunityRoadRecord = {
      id: 'road-15129',
      schemaVersion: 1,
      kind: 'new',
      coordinates: [
        [34.985, 30.942],
        [34.995, 30.952],
      ],
      bounds: computeRoadBounds([
        [34.985, 30.942],
        [34.995, 30.952],
      ]),
      highwayClass: 'track',
      name: 'שביל 15129',
      description: '',
      oneway: 0,
      allow4x4: true,
      allowFoot: true,
      allowBicycle: true,
      anchors: [],
      status: 'active',
      revision: 1,
      lastHistoryId: '1-r',
      createdByUid: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedByUid: 'u1',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    vi.spyOn(db.communityRoads, 'get').mockResolvedValue(dexieRoad);
    const resolvedCommunity = await new HighwayWayGeometryService(new TileRoadGraphBuilder()).resolveWayAt(
      'community:road:road-15129',
      0,
      0,
      'release-1'
    );
    expect(resolvedCommunity.geometry.coordinates[0][0]).toEqual([34.985, 30.942]);
  });
});
