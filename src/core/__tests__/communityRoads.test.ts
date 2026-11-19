import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/NavDatabase';
import {
  communityRoadsCloudService,
  CommunityRoadsCloudService,
} from '../firebase/CommunityRoadsCloudService';
import {
  buildOsmAuthorizeUrl,
  buildOsmSyncRoadItems,
  completeOsmOAuthCallback,
  getStoredOsmSession,
  syncRoadToOsmFromBrowser,
} from '../trails/OsmBrowserSyncService';
import {
  extractSyncedWayFromDiffResult,
  pushRoadToOsmApi,
} from '../trails/osmSyncCore.js';
import {
  COMMUNITY_HIGHWAY_CLASSES,
  computeRoadBounds,
  validateCommunityRoadInput,
  type CommunityRoadRecord,
} from '../trails/CommunityRoadTypes';
import {
  lonLatToGlobalPixel,
  lonLatToTile,
  TileRoadGraphBuilder,
} from '../routing/TileRoadGraphBuilder';
import { ClientRoutePlannerEngine } from '../routing/ClientRoutePlannerEngine';
import {
  applyLayerVisibilityToMap,
  buildIsraelOutdoorStyle,
  DEFAULT_LAYER_VISIBILITY,
  GOOGLE_SATELLITE_LAYER_ID,
  HIGHWAY_LAYER_IDS,
} from '../style/israelOutdoorStyle';
import { sanitizeVisibility } from '../preferences/UserStateSyncService';
import {
  buildChangesetXml,
  buildOsmChangeXml,
  mapTrailColorToOsmName,
  parseOsmWayFullXml,
  // @ts-expect-error ESM devops helper script without TypeScript declarations
} from '../../../devops/script_helpers/sync-osm-roads.mjs';

describe('Community Roads (Add / Edit Any Highway & OSM Sync)', () => {
  it('validates all OSM highway types, connection anchors, and osm-override rules', () => {
    for (const cls of COMMUNITY_HIGHWAY_CLASSES) {
      const err = validateCommunityRoadInput({
        kind: 'new',
        coordinates: [
          [35.2, 31.77],
          [35.202, 31.771],
        ],
        highwayClass: cls,
        anchors: [
          {
            vertexIndex: 0,
            targetWayId: 'osm:way:101',
            coord: [35.2, 31.77],
            gx: 100,
            gy: 100,
            snapType: 'vertex',
          },
        ],
        allow4x4: true,
        allowFoot: true,
        allowBicycle: true,
      });
      expect(err).toBeNull();
    }

    const noAnchorErr = validateCommunityRoadInput({
      kind: 'new',
      coordinates: [
        [35.2, 31.77],
        [35.202, 31.771],
      ],
      highwayClass: 'track',
      anchors: [],
      allow4x4: true,
      allowFoot: true,
      allowBicycle: true,
    });
    expect(noAnchorErr).toContain('לפחות קצה אחד');

    const overrideOk = validateCommunityRoadInput({
      kind: 'osm-override',
      sourceOsmWayId: 'osm:way:230594158',
      coordinates: [
        [35.2, 31.77],
        [35.202, 31.771],
      ],
      highwayClass: 'secondary',
      anchors: [],
      allow4x4: true,
      allowFoot: true,
      allowBicycle: true,
    });
    expect(overrideOk).toBeNull();
  });

  it('connects a new community road mid-segment (T-junction) in TileRoadGraphBuilder and routes across it', async () => {
    // Two parallel east-west community tracks connected by a north-south shortcut snapped mid-segment
    const trackACoords: Array<[number, number]> = [
      [35.200, 31.770],
      [35.210, 31.770],
    ];
    const trackBCoords: Array<[number, number]> = [
      [35.200, 31.774],
      [35.210, 31.774],
    ];
    const midA: [number, number] = [35.205, 31.770];
    const midB: [number, number] = [35.205, 31.774];
    const pxA = lonLatToGlobalPixel(midA[0], midA[1]);
    const pxB = lonLatToGlobalPixel(midB[0], midB[1]);

    const roadA: CommunityRoadRecord = {
      id: 'road-a',
      schemaVersion: 1,
      kind: 'new',
      coordinates: trackACoords,
      bounds: computeRoadBounds(trackACoords),
      highwayClass: 'track',
      name: 'Track A',
      description: '',
      oneway: 0,
      allow4x4: true,
      allowFoot: true,
      allowBicycle: true,
      anchors: [],
      status: 'active',
      revision: 1,
      lastHistoryId: '1-a',
      createdByUid: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedByUid: 'u1',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const roadB: CommunityRoadRecord = {
      ...roadA,
      id: 'road-b',
      name: 'Track B',
      coordinates: trackBCoords,
      bounds: computeRoadBounds(trackBCoords),
    };
    const connector: CommunityRoadRecord = {
      ...roadA,
      id: 'road-conn',
      name: 'Connector',
      coordinates: [midA, midB],
      bounds: computeRoadBounds([midA, midB]),
      anchors: [
        {
          vertexIndex: 0,
          targetWayId: 'community:road:road-a',
          coord: midA,
          gx: pxA.gx,
          gy: pxA.gy,
          snapType: 'segment',
        },
        {
          vertexIndex: 1,
          targetWayId: 'community:road:road-b',
          coord: midB,
          gx: pxB.gx,
          gy: pxB.gy,
          snapType: 'segment',
        },
      ],
    };

    const builder = new TileRoadGraphBuilder({
      fetchTileData: async () => undefined,
    });
    const tile = lonLatToTile(35.205, 31.772);
    const graph = await builder.buildGraphForTiles([tile], '4x4', [roadA, roadB, connector]);

    // Both T-junction nodes should exist and have >= 3 incident edges (split A, split B, connector)
    const nodeAKey = `0:${pxA.gx},${pxA.gy}`;
    const nodeBKey = `0:${pxB.gx},${pxB.gy}`;
    expect(graph.adjacency.get(nodeAKey)?.length).toBeGreaterThanOrEqual(3);
    expect(graph.adjacency.get(nodeBKey)?.length).toBeGreaterThanOrEqual(3);

    // Route from Track A west end to Track B east end using ClientRoutePlannerEngine
    const origBuild = builder.buildGraphForTiles.bind(builder);
    builder.buildGraphForTiles = (tiles, mode) => origBuild(tiles, mode, [roadA, roadB, connector]);
    const engine = new ClientRoutePlannerEngine({ fetchTileData: async () => undefined });
    (engine as unknown as { graphBuilder: TileRoadGraphBuilder }).graphBuilder = builder;
    const startSnap = await engine.snapToNearestHighway(35.201, 31.770, '4x4');
    const endSnap = await engine.snapToNearestHighway(35.209, 31.774, '4x4');
    expect(startSnap).not.toBeNull();
    expect(endSnap).not.toBeNull();
    const leg = await engine.routeBetweenSnappedPoints(startSnap!, endSnap!, '4x4');
    expect(leg.found).toBe(true);
    expect(leg.legType).toBe('network');
    expect(leg.roadLabels).toContain('Connector');
  });

  it('generates in-place <modify> OsmChange XML for edited OSM ways and <create> with colour for new roads', () => {
    expect(mapTrailColorToOsmName('#dc2626')).toBe('red');
    expect(mapTrailColorToOsmName('#16a34a')).toBe('green');

    const sampleOsmFullXml = `
      <osm version="0.6">
        <node id="10" lat="31.7700000" lon="35.2000000" version="1"/>
        <node id="11" lat="31.7700000" lon="35.2100000" version="1"/>
        <way id="555" version="4">
          <nd ref="10"/>
          <nd ref="11"/>
          <tag k="highway" v="unclassified"/>
          <tag k="lanes" v="2"/>
          <tag k="source" v="survey"/>
        </way>
      </osm>
    `;

    const parsed = parseOsmWayFullXml(sampleOsmFullXml, 555);
    expect(parsed.version).toBe(4);
    expect(parsed.ndRefs).toEqual([10, 11]);

    // 1. Editing existing OSM way emits <modify> with exact ID & preserved tags/nodes
    const modifyXml = buildOsmChangeXml({
      changesetId: 9001,
      road: {
        id: 'override-1',
        kind: 'osm-override',
        sourceOsmWayId: 'osm:way:555',
        highwayClass: 'track',
        tracktype: 'grade2',
        surface: 'gravel',
        name: 'דרך הגבעה',
        description: '',
        oneway: 0,
        allow4x4: true,
        allowFoot: true,
        allowBicycle: true,
        coordinates: [
          [35.200, 31.770],
          [35.210, 31.770],
        ],
        anchors: [],
        updatedByUid: 'nav-user-123',
      },
      trailAnnotation: { color: '#16a34a', number: '4120' },
      existingTargetWays: new Map([[555, parsed]]),
    });

    expect(modifyXml).toContain('<modify>');
    expect(modifyXml).not.toContain('<create>');
    expect(modifyXml).toContain('<way id="555" version="4" changeset="9001">');
    expect(modifyXml).toContain('<nd ref="10"/>');
    expect(modifyXml).toContain('<tag k="lanes" v="2"/>');
    expect(modifyXml).toContain('<tag k="highway" v="track"/>');
    expect(modifyXml).toContain('<tag k="colour" v="green"/>');
    expect(modifyXml).toContain('<tag k="ref" v="4120"/>');

    // 1b. Editing geometry of existing OSM way creates/modifies nodes and updates way ndRefs
    const geomModifyXml = buildOsmChangeXml({
      changesetId: 9002,
      road: {
        id: 'override-2',
        kind: 'osm-override',
        sourceOsmWayId: 'osm:way:555',
        highwayClass: 'track',
        name: '',
        description: '',
        oneway: 0,
        allow4x4: true,
        allowFoot: true,
        allowBicycle: true,
        coordinates: [
          [35.200, 31.770],
          [35.205, 31.772], // newly inserted middle vertex
          [35.210, 31.770],
        ],
        anchors: [],
        updatedByUid: 'nav-user-123',
      },
      existingTargetWays: new Map([[555, parsed]]),
    });
    expect(geomModifyXml).toContain('<create>');
    expect(geomModifyXml).toContain('<node id="-1"');
    expect(geomModifyXml).toContain('<nd ref="10"/>');
    expect(geomModifyXml).toContain('<nd ref="-1"/>');
    expect(geomModifyXml).toContain('<nd ref="11"/>');

    // 2. Changeset carries NavApp user attribution
    const csXml = buildChangesetXml({
      comment: 'Update track',
      userUid: 'nav-user-123',
      userName: 'Ohad',
    });
    expect(csXml).toContain('k="navapp:user_uid" v="nav-user-123"');

    // 3. Also allows syncing roads from any user even if updatedByUid is empty
    const communityXml = buildOsmChangeXml({
      changesetId: 9003,
      road: {
        id: 'any-user-1',
        kind: 'new',
        highwayClass: 'path',
        coordinates: [
          [35.2, 31.77],
          [35.201, 31.771],
        ],
        anchors: [],
        allow4x4: false,
        allowFoot: true,
        allowBicycle: false,
        updatedByUid: '',
      },
    });
    expect(communityXml).toContain('<create>');
    expect(communityXml).toContain('<tag k="highway" v="path"/>');
  });

  it('hides all highway layers when external map is active and hideRoadsOnExternalMap is enabled', () => {
    expect(DEFAULT_LAYER_VISIBILITY.hideRoadsOnExternalMap).toBe(false);
    expect(sanitizeVisibility({ hideRoadsOnExternalMap: true }).hideRoadsOnExternalMap).toBe(true);

    const style = buildIsraelOutdoorStyle({
      theme: 'topo-day',
      mapStyle: 'nms',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true, hideRoadsOnExternalMap: true },
    });
    const layers = style.layers as Array<{ id: string; layout?: { visibility?: string } }>;
    const satLayer = layers.find((l) => l.id === GOOGLE_SATELLITE_LAYER_ID);
    expect(satLayer?.layout?.visibility).toBe('visible');

    const roadLayerSample = layers.filter((l) => HIGHWAY_LAYER_IDS.has(l.id));
    expect(roadLayerSample.length).toBeGreaterThan(20);
    for (const l of roadLayerSample) {
      expect(l.layout?.visibility).toBe('none');
    }

    // Switching hideRoadsOnExternalMap back to false makes roads visible again via applyLayerVisibilityToMap
    const visibilityUpdates: Record<string, string> = {};
    applyLayerVisibilityToMap(
      {
        getStyle: () => style,
        getLayer: (id: string) => layers.find((l) => l.id === id),
        getSource: () => undefined,
        getTerrain: () => null,
        setTerrain: () => {},
        setLayoutProperty: (id: string, prop: string, val: string) => {
          if (prop === 'visibility') visibilityUpdates[id] = val;
        },
        setPaintProperty: () => {},
      },
      { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true, hideRoadsOnExternalMap: false }
    );
    expect(visibilityUpdates['trail-israel-lowzoom']).toBe('visible');
    expect(visibilityUpdates[GOOGLE_SATELLITE_LAYER_ID]).toBe('visible');
  });

  it('saves road edits and trailColor locally first (even offline/without Firebase) and marks pending sync', async () => {
    const store = new Map<string, CommunityRoadRecord>();
    vi.spyOn(db.communityRoads, 'toArray').mockImplementation((async () =>
      Array.from(store.values())) as unknown as typeof db.communityRoads.toArray);
    vi.spyOn(db.communityRoads, 'get').mockImplementation((async (id: string) =>
      store.get(id)) as unknown as typeof db.communityRoads.get);
    vi.spyOn(db.communityRoads, 'put').mockImplementation((async (rec: CommunityRoadRecord) => {
      store.set(rec.id, rec);
      return rec.id;
    }) as unknown as typeof db.communityRoads.put);

    const service = new CommunityRoadsCloudService();
    const saved = await service.saveCommunityRoad({
      roadId: null,
      expectedRevision: 0,
      user: null,
      kind: 'osm-override',
      sourceOsmWayId: 'osm:way:302750594',
      coordinates: [
        [35.2, 31.77],
        [35.202, 31.772],
      ],
      highwayClass: 'path',
      name: '',
      description: '',
      oneway: 0,
      allow4x4: false,
      allowFoot: true,
      allowBicycle: true,
      anchors: [],
      trailColor: '#334155',
      trailNumber: '',
      trailName: '',
      reason: 'local edit',
    });

    expect(saved.cloudSyncStatus).toBe('pending');
    expect(saved.trailColor).toBe('#334155');
    expect(store.get(saved.id)?.trailColor).toBe('#334155');
    expect(service.getCachedActiveRoads().some((r) => r.id === saved.id && r.trailColor === '#334155')).toBe(true);
  });

  it('extracts created vs modified way IDs from multi-way OSM diffResult and closes changeset on upload failure', async () => {
    const multiWayDiff = `
      <diffResult generator="OpenStreetMap server" version="0.6">
        <node old_id="-1" new_id="90001" new_version="1"/>
        <way old_id="444" new_id="444" new_version="7"/>
        <way old_id="-2" new_id="88888" new_version="1"/>
      </diffResult>
    `;
    expect(
      extractSyncedWayFromDiffResult(multiWayDiff, { kind: 'new' })
    ).toEqual({ osmWayId: 88888, osmVersion: 1 });
    expect(
      extractSyncedWayFromDiffResult(multiWayDiff, {
        kind: 'osm-override',
        sourceOsmWayId: 'osm:way:444',
      })
    ).toEqual({ osmWayId: 444, osmVersion: 7 });

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/changeset/create')) {
        return new Response('777', { status: 200 });
      }
      if (url.endsWith('/changeset/777/upload')) {
        return new Response('Conflict', { status: 409, statusText: 'Conflict' });
      }
      if (url.endsWith('/changeset/777/close')) {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await expect(
      pushRoadToOsmApi({
        road: {
          id: 'road-err-1',
          kind: 'new',
          highwayClass: 'track',
          coordinates: [
            [35.2, 31.77],
            [35.202, 31.772],
          ],
          allow4x4: true,
          allowFoot: true,
          allowBicycle: true,
          anchors: [],
        },
        osmApiBase: 'https://api.openstreetmap.org',
        osmToken: 'tok-123',
        actorUid: 'u1',
      })
    ).rejects.toThrow('OSM API 409');

    expect(calls).toEqual([
      'PUT https://api.openstreetmap.org/api/0.6/changeset/create',
      'POST https://api.openstreetmap.org/api/0.6/changeset/777/upload',
      'PUT https://api.openstreetmap.org/api/0.6/changeset/777/close',
    ]);
  });

  it('completes browser PKCE OAuth flow and syncs road via OSM API v0.6 + Firestore markRoadOsmSynced', async () => {
    const createMemoryStorage = (): Storage => {
      const map = new Map<string, string>();
      return {
        get length() {
          return map.size;
        },
        clear: () => map.clear(),
        getItem: (k: string) => map.get(k) ?? null,
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        removeItem: (k: string) => {
          map.delete(k);
        },
        setItem: (k: string, v: string) => {
          map.set(k, v);
        },
      };
    };

    const sessionStorage = createMemoryStorage();
    const localStorage = createMemoryStorage();
    vi.stubGlobal('window', {
      location: { origin: 'https://navapp.example.com' },
      sessionStorage,
      localStorage,
    });

    const authUrlStr = await buildOsmAuthorizeUrl({
      clientId: 'client-abc',
      sandbox: true,
      returnPath: '/osm-sync',
      isPopup: true,
    });
    const authUrl = new URL(authUrlStr);
    expect(authUrl.origin).toBe('https://master.apis.dev.openstreetmap.org');
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://navapp.example.com/osm-callback');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authUrl.searchParams.get('state')!;

    // Simulate OAuth callback returning in a popup/new tab where sessionStorage is empty
    // while localStorage retains the state-keyed PKCE entry
    sessionStorage.clear();

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'https://master.apis.dev.openstreetmap.org/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'osm-tok-xyz' }), { status: 200 });
      }
      if (url === 'https://master.apis.dev.openstreetmap.org/api/0.6/user/details') {
        return new Response('<osm><user display_name="TrailMapper"/></osm>', { status: 200 });
      }
      if (url === 'https://master.apis.dev.openstreetmap.org/api/0.6/changeset/create') {
        expect(init?.headers && (init.headers as Record<string, string>).Authorization).toBe('Bearer osm-tok-xyz');
        return new Response('5150', { status: 200 });
      }
      if (url === 'https://master.apis.dev.openstreetmap.org/api/0.6/changeset/5150/upload') {
        return new Response('<diffResult><way old_id="-1" new_id="99123" new_version="1"/></diffResult>', {
          status: 200,
        });
      }
      if (url === 'https://master.apis.dev.openstreetmap.org/api/0.6/changeset/5150/close') {
        return new Response('', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const callbackRes = await completeOsmOAuthCallback(
      new URLSearchParams({ code: 'auth-code-1', state })
    );
    expect(callbackRes.returnPath).toBe('/osm-sync');
    expect(callbackRes.isPopup).toBe(true);
    expect(callbackRes.session.osmUser).toBe('TrailMapper');
    expect(getStoredOsmSession()?.accessToken).toBe('osm-tok-xyz');

    await expect(
      completeOsmOAuthCallback(new URLSearchParams({ state: 's1' }))
    ).rejects.toThrow('פרמטר code');
    await expect(
      completeOsmOAuthCallback(new URLSearchParams({ code: 'c1', state: 'unknown-state' }))
    ).rejects.toThrow('PKCE');

    const road: CommunityRoadRecord = {
      id: 'road-browser-1',
      schemaVersion: 1,
      kind: 'new',
      coordinates: [
        [35.2, 31.77],
        [35.202, 31.772],
      ],
      bounds: computeRoadBounds([
        [35.2, 31.77],
        [35.202, 31.772],
      ]),
      highwayClass: 'track',
      name: 'שביל הבשור',
      description: '',
      oneway: 0,
      allow4x4: true,
      allowFoot: true,
      allowBicycle: true,
      anchors: [],
      status: 'active',
      revision: 1,
      lastHistoryId: '1-init',
      createdByUid: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedByUid: 'u1',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const items = buildOsmSyncRoadItems([road], []);
    expect(items).toHaveLength(1);
    expect(items[0].synced).toBe(false);

    const markSpy = vi
      .spyOn(communityRoadsCloudService, 'markRoadOsmSynced')
      .mockResolvedValue({
        ...road,
        revision: 2,
        osmSync: {
          changesetId: 5150,
          osmWayId: 99123,
          osmVersion: 1,
          syncedRevision: 2,
          syncedAt: '2026-01-01T00:01:00Z',
          syncedByUid: 'u1',
          syncedByName: 'Mapper',
          osmUsername: 'TrailMapper',
        },
      });

    const syncRes = await syncRoadToOsmFromBrowser(items[0], {
      osmSession: callbackRes.session,
      user: { uid: 'u1', email: 'mapper@example.com', displayName: 'Mapper', photoURL: null },
      sandbox: true,
    });

    expect(syncRes.ok).toBe(true);
    expect(syncRes.changesetId).toBe(5150);
    expect(syncRes.osmWayId).toBe(99123);
    expect(markSpy).toHaveBeenCalledWith({
      roadId: 'road-browser-1',
      user: { uid: 'u1', email: 'mapper@example.com', displayName: 'Mapper', photoURL: null },
      changesetId: 5150,
      osmWayId: 99123,
      osmVersion: 1,
      osmUsername: 'TrailMapper',
    });

    const confAuthUrl = new URL(
      await buildOsmAuthorizeUrl({
        clientId: 'conf-client',
        sandbox: false,
        returnPath: '/osm-sync',
      })
    );
    const confState = confAuthUrl.searchParams.get('state')!;
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_client',
          error_description:
            'Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.',
        }),
        { status: 401 }
      )
    );
    await expect(
      completeOsmOAuthCallback(new URLSearchParams({ code: 'c-conf', state: confState }))
    ).rejects.toThrow('Confidential');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
