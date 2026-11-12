import { afterEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  getFirebaseServices: vi.fn(),
  doc: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  collectionGroup: vi.fn((_fs: unknown, name: string) => ({ collectionGroup: name })),
  query: vi.fn((colRef: unknown, ...constraints: unknown[]) => ({ colRef, constraints })),
  where: vi.fn((field: string, op: string, val: unknown) => ({ field, op, val })),
  limit: vi.fn((n: number) => ({ limit: n })),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  ref: vi.fn(() => ({})),
  uploadString: vi.fn(),
  getDownloadURL: vi.fn(),
  listAll: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('../firebase/firebaseApp', () => ({
  getFirebaseServices: firebaseMocks.getFirebaseServices,
}));
vi.mock('firebase/firestore', () => ({
  doc: firebaseMocks.doc,
  collection: firebaseMocks.collection,
  collectionGroup: firebaseMocks.collectionGroup,
  query: firebaseMocks.query,
  where: firebaseMocks.where,
  limit: firebaseMocks.limit,
  setDoc: firebaseMocks.setDoc,
  deleteDoc: firebaseMocks.deleteDoc,
  getDocs: firebaseMocks.getDocs,
  onSnapshot: firebaseMocks.onSnapshot,
}));
vi.mock('firebase/storage', () => ({
  ref: firebaseMocks.ref,
  uploadString: firebaseMocks.uploadString,
  getDownloadURL: firebaseMocks.getDownloadURL,
  listAll: firebaseMocks.listAll,
  deleteObject: firebaseMocks.deleteObject,
}));

import { CommunityPoiImporter } from '../pois/CommunityPoiImporter';
import { ClientRoutePlannerEngine } from '../routing/ClientRoutePlannerEngine';
import {
  TileRoadGraphBuilder,
  TILE_EXTENT,
  globalPixelToLonLat,
  type DecodedWay,
} from '../routing/TileRoadGraphBuilder';
import { RouteManager, resolveRouteDisplayColor } from '../navigation/RouteManager';
import { resolveMapRouteDisplay } from '../navigation/RouteDisplayPolicy';
import { ElevationService } from '../navigation/ElevationService';
import { extractRouteTangentHeading } from '../navigation/NavigationHeadingService';
import { db, type RoutePayloadRecord, type SavedRouteRecord } from '../db/NavDatabase';
import {
  PlannedTracksCloudService,
  PLANNED_SYNC_WATERMARK_KEY_PREFIX,
  buildSharedLocalRouteId,
  clearPlannedRouteDeleted,
  clearPlannedSyncWatermark,
  clearSharedRouteDismissed,
  getDeletedPlannedRouteIds,
  getDismissedSharedRouteIds,
  getPlannedSyncWatermark,
  markPlannedRouteDeleted,
  markSharedRouteDismissed,
  normalizeShareRecipients,
  resetPlannedCloudSessionStateForTesting,
  serializePlannedRouteForFirestore,
  buildPlannedRouteJsonPayload,
  deserializeFirestorePlannedRoute,
} from '../firebase/PlannedTracksCloudService';
import {
  UserDirectoryService,
  resetDirectorySessionForTesting,
} from '../firebase/UserDirectoryService';
import { PLANNING_ROUTE_COLOR } from '../routing/RoutingProfiles';
import type { NavUser } from '../firebase/AuthService';

function createMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

function makeMockFile(content: string | Uint8Array, name: string): File {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const textVal = typeof content === 'string' ? content : new TextDecoder().decode(bytes);
  return {
    name,
    size: bytes.byteLength,
    type: '',
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => textVal,
  } as unknown as File;
}

describe('Route Planning, Import, Edit & Display Bug Fixes', () => {
  afterEach(() => {
    resetPlannedCloudSessionStateForTesting();
    resetDirectorySessionForTesting();
    RouteManager.clearHydratedCacheForTesting();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('imports GeoJSON 3D LineString/MultiLineString & text TWL (WGS84 + ITM) while rejecting binary TWL cleanly', async () => {
    vi.spyOn(db.pois, 'bulkPut').mockResolvedValue(undefined as any);

    // 1. GeoJSON 3D coordinates preserve elevation profiles
    const geojsonContent = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'נחל צין 3D' },
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [34.81, 30.83, 380],
                [34.82, 30.84, 435],
              ],
              [
                [34.82, 30.84, 435],
                [34.83, 30.85, 510],
              ],
            ],
          },
        },
      ],
    });
    const gjRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(
      makeMockFile(geojsonContent, 'zin-3d.geojson')
    );
    expect(gjRes.extractedRoutes).toHaveLength(1);
    expect(gjRes.extractedRoutes[0].name).toBe('נחל צין 3D');
    expect(gjRes.extractedRoutes[0].segments).toHaveLength(2);
    expect(gjRes.extractedRoutes[0].pointElevations).toEqual([
      [380, 435],
      [435, 510],
    ]);

    // 2. Text TWL supports WGS84 + elevation + Hebrew names and 6-digit ITM grid
    const twlText = [
      '# Naviguide ASCII export',
      '30.8350, 34.8134, 392, עין עקב תחתון',
      '181300, 527000, 460, מצפה עקב',
      '30.8450, 34.8280, 515',
    ].join('\n');
    const twlRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(
      makeMockFile(twlText, 'ein-aqev.twl')
    );
    expect(twlRes.extractedRoutes).toHaveLength(1);
    expect(twlRes.extractedRoutes[0].segments[0]).toHaveLength(3);
    expect(twlRes.extractedRoutes[0].pointElevations?.[0]).toEqual([392, 460, 515]);
    expect(twlRes.importedPois.map((p) => p.nameHe)).toContain('עין עקב תחתון');
    expect(twlRes.importedPois.map((p) => p.nameHe)).toContain('מצפה עקב');

    // 3. Binary TWL is rejected with a clear message
    const binaryBytes = new Uint8Array([0x01, 0x00, 0x02, 0x00, 0x4e, 0x61, 0x76, 0x00]);
    await expect(
      CommunityPoiImporter.importWaypointsAndRoutesFromFile(
        makeMockFile(binaryBytes, 'naviguide-bin.twl')
      )
    ).rejects.toThrow(/TWL בינארי/);
  });

  it('sanitizes bare ampersands & recovers malformed/self-closing GPX and KML tracks cleanly', async () => {
    vi.spyOn(db.pois, 'bulkPut').mockResolvedValue(undefined as any);

    // Verify sanitizeXmlText handles bare '&' and injects gx: namespace while preserving CDATA
    const dirtyKml = `noise<kml><Document><Placemark><name>גב & מעיין</name><description><![CDATA[<b>A & B</b>]]></description><gx:Track><gx:coord>34.81 30.83 400</gx:coord></gx:Track></Placemark></Document></kml>`;
    const sanitized = (CommunityPoiImporter as any).sanitizeXmlText(dirtyKml) as string;
    expect(sanitized.startsWith('<kml')).toBe(true);
    expect(sanitized).toContain('גב &amp; מעיין');
    expect(sanitized).toContain('<![CDATA[<b>A & B</b>]]>');
    expect(sanitized).toContain('xmlns:gx="http://www.google.com/kml/ext/2.2"');

    // Verify GPX parsing preserves bare-& text, <ele>, and self-closing <trkpt/> tags via fallback
    const malformedGpx = `
      <gpx version="1.1">
        <wpt lat="30.8350" lon="34.8134"><ele>395</ele><name>עין עקב & גבים</name></wpt>
        <trk>
          <name>מסלול שטח &amp; מים</name>
          <trkseg>
            <trkpt lat="30.8350" lon="34.8134"><ele>395</ele></trkpt>
            <trkpt lat="30.8410" lon="34.8195"/>
            <trkpt lat="30.8480" lon="34.8260"><ele>475</ele></trkpt>
          </trkseg>
        </trk>
      </gpx>
    `;
    const gpxRes = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(
      makeMockFile(malformedGpx, 'dirty-track.gpx')
    );
    expect(gpxRes.importedPois).toHaveLength(1);
    expect(gpxRes.importedPois[0].nameHe).toBe('עין עקב & גבים');
    expect(gpxRes.importedPois[0].ele).toBe(395);
    expect(gpxRes.extractedRoutes).toHaveLength(1);
    expect(gpxRes.extractedRoutes[0].segments[0]).toHaveLength(3);
    expect(gpxRes.extractedRoutes[0].pointElevations?.[0]).toEqual([395, null, 475]);
  });

  it('snaps across z14 tile seams when a closer road lies in the adjacent unloaded tile', async () => {
    const builder = new TileRoadGraphBuilder();
    const txA = 9797;
    const txB = 9798;
    const ty = 6699;
    const seamX = txB * TILE_EXTENT;
    const yMid = ty * TILE_EXTENT + 2000;

    const pt = (gx: number, gy: number) => {
      const [lon, lat] = globalPixelToLonLat(gx, gy);
      return { gx, gy, lon, lat, isClipped: false };
    };

    // Click at xFrac = 1884/4096 = 0.46 (> edgeMargin 0.45, ~966m right of seam):
    // Primary pass loads only txB and sees 'secondary' road 1966 units (~1008m -> out of 1000m or ~990m away);
    // Neighbor pass expands to 3x3 because minUnloadedEdgeDist (~966m) <= 1000m and closer than best hit -> finds closer 'track' in txA!
    const tileAWays: DecodedWay[] = [
      {
        featureId: 'closer-neighbor',
        props: { class: 'track', tracktype: 'grade2' },
        layer: 0,
        points: [pt(seamX - 10, yMid - 400), pt(seamX - 10, yMid + 400)],
      },
    ];
    const tileBWays: DecodedWay[] = [
      {
        featureId: 'farther-local',
        props: { class: 'secondary' },
        layer: 0,
        points: [pt(seamX + 3820, yMid - 400), pt(seamX + 3820, yMid + 400)],
      },
    ];

    vi.spyOn(builder, 'getDecodedTileWays').mockImplementation(async (tx, tyReq) => {
      if (tx === txA && tyReq === ty) return tileAWays;
      if (tx === txB && tyReq === ty) return tileBWays;
      return [];
    });

    const engine = new ClientRoutePlannerEngine();
    (engine as any).graphBuilder = builder;

    const [clickLon, clickLat] = globalPixelToLonLat(seamX + 1884, yMid);
    const snap = await engine.snapToNearestHighway(clickLon, clickLat, '4x4', 1000);
    expect(snap).not.toBeNull();
    expect(snap!.roadClass).toBe('track');
  });

  it('interpolates real file elevations without fake sine waves and computes accurate multi-segment remaining distance & heading', async () => {
    vi.spyOn(ElevationService, 'getElevationAt').mockResolvedValue(null);
    vi.spyOn(db.routes, 'put').mockResolvedValue('id' as any);
    vi.spyOn(db.routes, 'get').mockImplementation((async () => undefined) as any);

    // 1. Uses real file elevations rather than Math.sin() synthetic fallback
    const saved = await RouteManager.createAndSaveRoute({
      name: 'ציר עם גבהים מהקובץ',
      sourceFormat: 'gpx',
      coordinates: [
        [34.81, 30.83],
        [34.82, 30.84],
      ],
      segments: [
        [
          [34.81, 30.83],
          [34.815, 30.835],
        ],
        [
          [34.815, 30.835],
          [34.82, 30.84],
        ],
      ],
      segmentElevations: [
        [200, 300],
        [300, 400],
      ],
    });
    expect(saved.minEle).toBe(200);
    expect(saved.maxEle).toBe(400);
    expect(saved.ascentMeters).toBe(200);
    expect(saved.descentMeters).toBe(0);

    // 2. Without DEM or file elevations, remains flat 0 (no bogus oscillating hills)
    const noEleRoute = await RouteManager.createAndSaveRoute({
      name: 'ציר ללא DEM',
      sourceFormat: 'gpx',
      coordinates: [
        [34.81, 30.83],
        [34.82, 30.84],
      ],
    });
    expect(noEleRoute.minEle).toBe(0);
    expect(noEleRoute.maxEle).toBe(0);
    expect(noEleRoute.ascentMeters).toBe(0);

    // 3. Preserves file elevations if refreshRouteElevationsFromDem finds no DEM coverage
    const refreshed = await RouteManager.refreshRouteElevationsFromDem(saved);
    expect(refreshed.minEle).toBe(200);
    expect(refreshed.maxEle).toBe(400);
    expect(refreshed.ascentMeters).toBe(200);

    // 4. Multi-segment remaining distance & tangent heading (segment 1 heads East ~90°, segment 2 heads North ~0°)
    const lShapeRoute: SavedRouteRecord = {
      ...saved,
      distanceKm: 2.0,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.81, 30.83],
                [34.82, 30.83],
              ],
            },
          },
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.82, 30.83],
                [34.82, 30.84],
              ],
            },
          },
        ],
      },
    };
    const remNearStart = RouteManager.computeRemainingDistanceKm(lShapeRoute, 34.811, 30.83);
    const remSecondSeg = RouteManager.computeRemainingDistanceKm(lShapeRoute, 34.82, 30.836);
    expect(remNearStart).toBeGreaterThan(1.5);
    expect(remSecondSeg).toBeLessThan(0.7);

    const headingOnLeg2 = extractRouteTangentHeading(lShapeRoute, 34.82, 30.835);
    expect(headingOnLeg2).not.toBeNull();
    // Leg 2 runs due North (around 0° / 360°)
    expect(headingOnLeg2! < 10 || headingOnLeg2! > 350).toBe(true);
  });

  it('supports route editing (rename, custom color preservation, visibility toggle, reverse direction, updatePlannedRoute)', async () => {
    const store = new Map<string, SavedRouteRecord>();
    vi.spyOn(db.routes, 'put').mockImplementation((async (rec: SavedRouteRecord) => {
      store.set(rec.id, rec);
      return rec.id;
    }) as any);
    vi.spyOn(db.routes, 'get').mockImplementation((async (id: string) => store.get(id)) as any);
    vi.spyOn(db.routes, 'bulkDelete').mockResolvedValue(undefined as any);
    vi.spyOn(db.routes, 'toArray').mockImplementation((async () => Array.from(store.values())) as any);
    vi.spyOn(db.routes, 'bulkPut').mockImplementation((async (recs: readonly SavedRouteRecord[]) => {
      recs.forEach((r) => store.set(r.id, r));
      return [] as any;
    }) as any);
    vi.spyOn(ElevationService, 'getElevationAt').mockResolvedValue(null);

    const planned: SavedRouteRecord = {
      id: 'route-edit-1',
      name: 'תכנון ראשוני',
      sourceFormat: 'planned',
      planningMode: 'foot',
      waypoints: [
        { lon: 34.81, lat: 30.83, ele: 300, roadLabel: 'נקודה א' },
        { lon: 34.815, lat: 30.835, ele: 360, roadLabel: 'נקודה ב', legType: 'network' },
        { lon: 34.82, lat: 30.84, ele: 320, roadLabel: 'נקודה ג', legType: 'straight' },
      ],
      distanceKm: 1.5,
      ascentMeters: 60,
      descentMeters: 40,
      minEle: 300,
      maxEle: 360,
      color: PLANNING_ROUTE_COLOR,
      visible: true,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { color: PLANNING_ROUTE_COLOR },
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.81, 30.83],
                [34.815, 30.835],
              ],
            },
          },
          {
            type: 'Feature',
            properties: { color: PLANNING_ROUTE_COLOR },
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.815, 30.835],
                [34.82, 30.84],
              ],
            },
          },
        ],
      },
      elevationProfile: [
        { distKm: 0, ele: 300, lon: 34.81, lat: 30.83 },
        { distKm: 0.75, ele: 360, lon: 34.815, lat: 30.835 },
        { distKm: 1.5, ele: 320, lon: 34.82, lat: 30.84 },
      ],
      cloudSyncStatus: 'synced',
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    store.set(planned.id, planned);

    // 1. Rename & customize color to magenta (#ec4899) -> marks colorCustomized & pending sync
    const renamed = await RouteManager.updateRouteDetails(planned.id, {
      name: 'שביל חדש',
      color: '#ec4899',
    });
    expect(renamed?.name).toBe('שביל חדש');
    expect(renamed?.color).toBe('#ec4899');
    expect(renamed?.colorCustomized).toBe(true);
    expect(renamed?.cloudSyncStatus).toBe('pending');
    expect(resolveRouteDisplayColor(renamed)).toBe('#ec4899');

    // Legacy migration in initializeStarterRoutes must NOT overwrite customized #ec4899!
    const reloaded = await RouteManager.initializeStarterRoutes();
    expect(reloaded[0].color).toBe('#ec4899');
    expect(reloaded[0].colorCustomized).toBe(true);

    // 2. Toggle visibility twice
    const hidden = await RouteManager.toggleRouteVisibility(planned.id);
    expect(hidden?.visible).toBe(false);
    const shown = await RouteManager.toggleRouteVisibility(planned.id);
    expect(shown?.visible).toBe(true);

    // 3. Reverse direction flips coords, elevation profile, swaps ascent<->descent, and remaps incoming legType
    const reversed = await RouteManager.reverseRoute(planned.id);
    expect(reversed).toBeDefined();
    expect(reversed!.ascentMeters).toBe(40);
    expect(reversed!.descentMeters).toBe(60);
    expect(reversed!.elevationProfile[0].distKm).toBe(0);
    expect(reversed!.elevationProfile[0].ele).toBe(320);
    expect(reversed!.geojson.features[0].geometry).toMatchObject({
      type: 'LineString',
      coordinates: [
        [34.82, 30.84],
        [34.815, 30.835],
      ],
    });
    expect(reversed!.waypoints![0].roadLabel).toBe('נקודה ג');
    expect(reversed!.waypoints![0].legType).toBeUndefined();
    expect(reversed!.waypoints![1].roadLabel).toBe('נקודה ב');
    expect(reversed!.waypoints![1].legType).toBe('straight');
    expect(reversed!.waypoints![2].roadLabel).toBe('נקודה א');
    expect(reversed!.waypoints![2].legType).toBe('network');

    // 4. Updating existing planned route keeps same ID, createdAt, and custom color
    const updatedPlan = await RouteManager.updatePlannedRoute(planned.id, {
      name: 'שביל מעודכן',
      mode: '4x4',
      segments: [
        [
          [34.82, 30.84],
          [34.81, 30.83],
        ],
      ],
      waypoints: [
        { lon: 34.82, lat: 30.84, roadLabel: 'התחלה' },
        { lon: 34.81, lat: 30.83, roadLabel: 'סיום', legType: 'straight' },
      ],
    });
    expect(updatedPlan.id).toBe(planned.id);
    expect(updatedPlan.createdAt).toBe('2026-11-10T08:00:00.000Z');
    expect(updatedPlan.color).toBe('#ec4899');
    expect(updatedPlan.colorCustomized).toBe(true);
    expect(updatedPlan.gpxXml).toContain('שביל מעודכן');
  });

  it('persists deletion tombstones, merges remote routes by updatedAt, and survives Storage CORS failure cleanly', async () => {
    const memStorage = createMemoryLocalStorage();
    vi.stubGlobal('window', { localStorage: memStorage });

    const user: NavUser = {
      uid: 'u1',
      email: 'u1@example.com',
      displayName: 'User 1',
      photoURL: null,
    };

    const routeBase: SavedRouteRecord = {
      id: 'cloud-r1',
      name: 'מסלול ענן',
      sourceFormat: 'planned',
      planningMode: '4x4',
      distanceKm: 1.1,
      ascentMeters: 50,
      descentMeters: 20,
      minEle: 300,
      maxEle: 350,
      color: '#ef4444',
      colorCustomized: true,
      visible: false,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { color: '#ef4444' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.81, 30.83],
                [34.82, 30.84],
              ],
            },
          },
        ],
      },
      elevationProfile: [
        { distKm: 0, ele: 300, lon: 34.81, lat: 30.83 },
        { distKm: 1.1, ele: 350, lon: 34.82, lat: 30.84 },
      ],
      cloudSyncStatus: 'synced',
      createdAt: '2026-11-11T10:00:00.000Z',
      updatedAt: '2026-11-11T10:00:00.000Z',
    };

    // Custom color round-trip through Firestore serialize/deserialize
    const fsPayload = serializePlannedRouteForFirestore(buildPlannedRouteJsonPayload(routeBase, user));
    const roundTripped = deserializeFirestorePlannedRoute(fsPayload, user);
    expect(roundTripped?.color).toBe('#ef4444');
    expect(roundTripped?.colorCustomized).toBe(true);

    // Tombstone API works reliably
    markPlannedRouteDeleted('deleted-r99');
    expect(getDeletedPlannedRouteIds().has('deleted-r99')).toBe(true);

    // Mock Firestore & Storage to verify:
    // 1. Storage CORS / storage/unknown doesn't block Firestore sync
    // 2. Deleted tombstone prevents resurrection + local visible:false is preserved on remote update
    firebaseMocks.getFirebaseServices.mockReturnValue({
      firestore: {},
      storage: {},
    });
    firebaseMocks.setDoc.mockResolvedValue(undefined);
    firebaseMocks.deleteDoc.mockResolvedValue(undefined);
    firebaseMocks.uploadString.mockRejectedValue(
      Object.assign(new Error('CORS blocked'), { code: 'storage/unknown' })
    );

    vi.spyOn(db.routes, 'update').mockResolvedValue(1 as any);
    vi.spyOn(db.routes, 'get').mockResolvedValue({ ...routeBase, cloudSyncStatus: 'synced' } as any);

    const saveRes = await PlannedTracksCloudService.savePlannedRouteToFirebase(routeBase, user);
    expect(saveRes.synced).toBe(true);
    expect(saveRes.backend).toBe('firestore');

    // Now test fetchUserPlannedRoutes with 1 tombstoned route and 1 newer remote route
    vi.spyOn(db.routes, 'toArray').mockResolvedValue([routeBase] as any);
    const bulkPutSpy = vi.spyOn(db.routes, 'bulkPut').mockResolvedValue([] as any);

    const newerRemotePayload = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(
        {
          ...routeBase,
          name: 'שם מהענן',
          updatedAt: '2026-11-12T09:00:00.000Z',
        },
        user
      )
    );
    const deletedRemotePayload = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(
        {
          ...routeBase,
          id: 'deleted-r99',
          name: 'אסור שיחזור',
        },
        user
      )
    );

    firebaseMocks.getDocs.mockResolvedValue({
      forEach: (cb: (snap: { data: () => any }) => void) => {
        cb({ data: () => deletedRemotePayload });
        cb({ data: () => newerRemotePayload });
      },
    });

    const fetched = await PlannedTracksCloudService.fetchUserPlannedRoutes(user);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].id).toBe('cloud-r1');
    expect(fetched[0].name).toBe('שם מהענן');
    expect(fetched[0].visible).toBe(false); // local visibility preserved
    expect(bulkPutSpy).toHaveBeenCalledTimes(1);

    clearPlannedRouteDeleted('deleted-r99');
    expect(getDeletedPlannedRouteIds().has('deleted-r99')).toBe(false);
  });

  it('enforces deterministic route map display policy across idle, planning, selecting, editing, and navigation (PRD 2)', () => {
    const mkRoute = (id: string, visible = true): SavedRouteRecord => ({
      id,
      name: `Route ${id}`,
      sourceFormat: 'planned',
      planningMode: '4x4',
      distanceKm: 4.2,
      ascentMeters: 90,
      descentMeters: 45,
      minEle: 100,
      maxEle: 190,
      color: PLANNING_ROUTE_COLOR,
      visible,
      geojson: { type: 'FeatureCollection', features: [] },
      elevationProfile: [],
      createdAt: '2026-11-12T08:00:00.000Z',
    });

    const r1 = mkRoute('r1', false); // legacy visible=false should NOT block explicit select/navigate
    const r2 = mkRoute('r2', true);
    const r3 = mkRoute('r3', true);
    const allRoutes = [r1, r2, r3];

    // 1. Idle map: 0 routes displayed even with activeRoute retained and routes having visible=true
    const idleRes = resolveMapRouteDisplay(allRoutes, r1, {
      isPlanning: false,
      isEditing: false,
      isSelecting: false,
      isNavigating: false,
      pinnedBackgroundIds: ['r2'],
    });
    expect(idleRes.mode).toBe('idle');
    expect(idleRes.activeRouteToDisplay).toBeNull();
    expect(idleRes.backgroundRoutesToDisplay).toEqual([]);
    expect(idleRes.shouldShowPlanOverlay).toBe(false);

    // 2. Selecting in Routes drawer: activeRoute displays (even if visible=false); unpinned routes stay hidden; pinned r2 renders in background
    const selectRes = resolveMapRouteDisplay(allRoutes, r1, {
      isPlanning: false,
      isEditing: false,
      isSelecting: true,
      isNavigating: false,
      pinnedBackgroundIds: ['r1', 'r2'],
    });
    expect(selectRes.mode).toBe('selecting');
    expect(selectRes.activeRouteToDisplay?.id).toBe('r1');
    expect(selectRes.backgroundRoutesToDisplay.map((r) => r.id)).toEqual(['r2']); // r1 excluded because already primary, r3 excluded because unpinned
    expect(selectRes.shouldShowPlanOverlay).toBe(false);

    // 3. Planning mode: planner overlay shows; background routes respect showBackgroundWhilePlanning toggle
    const planWithBg = resolveMapRouteDisplay(allRoutes, r1, {
      isPlanning: true,
      isEditing: false,
      isSelecting: false,
      isNavigating: false,
      pinnedBackgroundIds: ['r2', 'r3'],
      showBackgroundWhilePlanning: true,
    });
    expect(planWithBg.mode).toBe('planning');
    expect(planWithBg.shouldShowPlanOverlay).toBe(true);
    expect(planWithBg.activeRouteToDisplay).toBeNull();
    expect(planWithBg.backgroundRoutesToDisplay.map((r) => r.id)).toEqual(['r2', 'r3']);

    const planHiddenBg = resolveMapRouteDisplay(allRoutes, r1, {
      isPlanning: true,
      isEditing: false,
      isSelecting: false,
      isNavigating: false,
      pinnedBackgroundIds: ['r2', 'r3'],
      showBackgroundWhilePlanning: false,
    });
    expect(planHiddenBg.backgroundRoutesToDisplay).toEqual([]);

    // 4. Editing existing route r1: hides static r1 & suppresses duplicate even if r1 was pinned
    const editRes = resolveMapRouteDisplay(allRoutes, r1, {
      isPlanning: true,
      isEditing: true,
      isSelecting: false,
      isNavigating: false,
      editingRouteId: 'r1',
      pinnedBackgroundIds: ['r1', 'r2'],
      showBackgroundWhilePlanning: true,
    });
    expect(editRes.mode).toBe('editing');
    expect(editRes.editingHiddenId).toBe('r1');
    expect(editRes.activeRouteToDisplay).toBeNull();
    expect(editRes.backgroundRoutesToDisplay.map((r) => r.id)).toEqual(['r2']);
    expect(editRes.shouldShowPlanOverlay).toBe(true);

    // 5. Navigating: activeRoute r1 is forced visible even when drawer/planner are closed; background clutter cleared
    const navRes = resolveMapRouteDisplay(allRoutes, r1, {
      isPlanning: false,
      isEditing: false,
      isSelecting: false,
      isNavigating: true,
      pinnedBackgroundIds: ['r2'],
    });
    expect(navRes.mode).toBe('navigating');
    expect(navRes.activeRouteToDisplay?.id).toBe('r1');
    expect(navRes.backgroundRoutesToDisplay).toEqual([]);
    expect(navRes.shouldShowPlanOverlay).toBe(false);
  });

  it('splits route metadata vs payloads, caches up to 25 hydrated routes, and duplicates shared routes as editable mine copies (PRD 1 + PRD 3)', async () => {
    const summaryStore = new Map<string, SavedRouteRecord>();
    const payloadStore = new Map<string, RoutePayloadRecord>();

    vi.spyOn(ElevationService, 'getElevationAt').mockResolvedValue(320);
    vi.spyOn(db.routes, 'put').mockImplementation((async (rec: SavedRouteRecord) => {
      summaryStore.set(rec.id, rec);
      return rec.id;
    }) as any);
    vi.spyOn(db.routes, 'get').mockImplementation((async (id: string) => summaryStore.get(id)) as any);
    vi.spyOn(db.routes, 'toArray').mockImplementation((async () =>
      Array.from(summaryStore.values())
    ) as any);
    vi.spyOn(db.routes, 'delete').mockImplementation((async (id: string) => {
      summaryStore.delete(id);
    }) as any);
    vi.spyOn(db.routes, 'bulkPut').mockImplementation((async (recs: readonly SavedRouteRecord[]) => {
      recs.forEach((r) => summaryStore.set(r.id, r));
      return [] as any;
    }) as any);

    vi.spyOn(db.routePayloads, 'put').mockImplementation((async (rec: RoutePayloadRecord) => {
      payloadStore.set(rec.id, rec);
      return rec.id;
    }) as any);
    vi.spyOn(db.routePayloads, 'get').mockImplementation((async (id: string) =>
      payloadStore.get(id)
    ) as any);
    vi.spyOn(db.routePayloads, 'delete').mockImplementation((async (id: string) => {
      payloadStore.delete(id);
    }) as any);
    vi.spyOn(db.routePayloads, 'bulkPut').mockImplementation((async (recs: readonly RoutePayloadRecord[]) => {
      recs.forEach((r) => payloadStore.set(r.id, r));
      return [] as any;
    }) as any);

    // 1. Save full route -> db.routes keeps stripped summary with bounds, db.routePayloads stores geometry + GPX
    const created = await RouteManager.createAndSavePlannedRoute({
      id: 'split-1',
      name: 'מסלול מפוצל',
      mode: '4x4',
      segments: [
        [
          [34.81, 30.83],
          [34.83, 30.85],
        ],
      ],
      waypoints: [
        { lon: 34.81, lat: 30.83, roadLabel: 'התחלה' },
        { lon: 34.83, lat: 30.85, roadLabel: 'סיום', legType: 'network' },
      ],
      ownerUid: 'u1',
      ownerEmail: 'u1@example.com',
      ownerDisplayName: 'אוהד',
    });

    expect(created.hasFullPayload).toBe(true);
    expect(created.geojson.features).toHaveLength(1);
    const storedSummary = summaryStore.get('split-1')!;
    const storedPayload = payloadStore.get('split-1')!;
    expect(storedSummary.hasFullPayload).toBe(false);
    expect(storedSummary.geojson.features).toHaveLength(0);
    expect(storedSummary.elevationProfile).toHaveLength(0);
    expect(storedSummary.bounds).toEqual([34.81, 30.83, 34.83, 30.85]);
    expect(storedPayload.geojson.features).toHaveLength(1);
    expect(storedPayload.gpxXml).toContain('מסלול מפוצל');

    // Clear LRU and re-hydrate from summary + routePayloads
    RouteManager.clearHydratedCacheForTesting();
    const summaries = await RouteManager.listRouteSummaries();
    expect(summaries).toHaveLength(1);
    expect(RouteManager.isHydratedRoute(summaries[0])).toBe(false);

    const hydrated = await RouteManager.loadFullRoute(summaries[0]);
    expect(hydrated?.hasFullPayload).toBe(true);
    expect(hydrated?.geojson.features).toHaveLength(1);
    expect(RouteManager.getCachedFullRoute('split-1')?.id).toBe('split-1');

    // 2. Shared route duplication creates editable 'mine' copy without sender attribution
    const sharedIncoming: SavedRouteRecord = {
      ...created,
      id: 'shared-from-friend',
      name: 'שביל חברים',
      ownership: 'shared',
      ownerUid: 'friend-1',
      ownerEmail: 'friend@gmail.com',
      ownerDisplayName: 'דני',
      sharedByUid: 'friend-1',
      sharedByName: 'דני',
      sharedByEmail: 'friend@gmail.com',
      cloudStoragePath: 'planing_tracks/friend-1/r.gpx',
    };
    const cloned = await RouteManager.duplicateRouteToMine(sharedIncoming, {
      uid: 'me-1',
      email: 'me@gmail.com',
      displayName: 'אוהד',
    });
    expect(cloned.id).not.toBe(sharedIncoming.id);
    expect(cloned.name).toBe('שביל חברים (עותק)');
    expect(cloned.ownership).toBe('mine');
    expect(cloned.ownerUid).toBe('me-1');
    expect(cloned.ownerEmail).toBe('me@gmail.com');
    expect(cloned.sharedByUid).toBeUndefined();
    expect(cloned.cloudSyncStatus).toBe('pending');
    expect(cloned.geojson.features).toHaveLength(1);

    // 3. deleteRoute cleans both tables + LRU
    await RouteManager.deleteRoute('split-1');
    expect(summaryStore.has('split-1')).toBe(false);
    expect(payloadStore.has('split-1')).toBe(false);
    expect(RouteManager.getCachedFullRoute('split-1')).toBeUndefined();
  });

  it('registers users in Firestore /users directory, searches by email or display name, and performs incremental watermark cloud sync (PRD 1.3 + PRD 3.1)', async () => {
    const memStorage = createMemoryLocalStorage();
    vi.stubGlobal('window', { localStorage: memStorage });
    vi.stubGlobal('navigator', { onLine: true });

    firebaseMocks.getFirebaseServices.mockReturnValue({
      firestore: {},
      storage: {},
    });
    firebaseMocks.setDoc.mockResolvedValue(undefined);

    const me: NavUser = {
      uid: 'u-me',
      email: 'Ohad.Manor@gmail.com',
      displayName: 'Ohad Manor',
      photoURL: 'https://example.com/p.jpg',
    };

    const ok = await UserDirectoryService.registerCurrentUser(me);
    expect(ok).toBe(true);
    expect(firebaseMocks.setDoc).toHaveBeenCalledTimes(1);
    const [, savedProfile] = firebaseMocks.setDoc.mock.calls[0];
    expect(savedProfile).toMatchObject({
      uid: 'u-me',
      email: 'Ohad.Manor@gmail.com',
      emailLower: 'ohad.manor@gmail.com',
      displayName: 'Ohad Manor',
      displayNameLower: 'ohad manor',
    });

    // Duplicate registration in same session is deduplicated
    await UserDirectoryService.registerCurrentUser(me);
    expect(firebaseMocks.setDoc).toHaveBeenCalledTimes(1);

    // Directory search by exact email & name prefix (excludes current user)
    firebaseMocks.getDocs.mockResolvedValue({
      forEach: (cb: (snap: { data: () => any }) => void) => {
        cb({
          data: () => ({
            uid: 'u-me',
            email: 'Ohad.Manor@gmail.com',
            emailLower: 'ohad.manor@gmail.com',
            displayName: 'Ohad Manor',
            displayNameLower: 'ohad manor',
          }),
        });
        cb({
          data: () => ({
            uid: 'u-friend',
            email: 'dani@gmail.com',
            emailLower: 'dani@gmail.com',
            displayName: 'Dani Cohen',
            displayNameLower: 'dani cohen',
          }),
        });
      },
    });

    const emailMatches = await UserDirectoryService.searchUsers('dani@gmail.com', 'u-me');
    expect(emailMatches).toHaveLength(1);
    expect(emailMatches[0].uid).toBe('u-friend');
    expect(firebaseMocks.where).toHaveBeenCalledWith('emailLower', '==', 'dani@gmail.com');

    firebaseMocks.where.mockClear();
    const nameMatches = await UserDirectoryService.searchUsers('Dani', 'u-me');
    expect(nameMatches).toHaveLength(1);
    expect(firebaseMocks.where).toHaveBeenCalledWith('displayNameLower', '>=', 'dani');

    // Incremental watermark sync: when local planned route + watermark exist, fetchUserPlannedRoutes queries updatedAt > watermark
    const existingLocal: SavedRouteRecord = {
      id: 'inc-r1',
      name: 'קיים מקומית',
      sourceFormat: 'planned',
      planningMode: 'foot',
      distanceKm: 2,
      ascentMeters: 40,
      descentMeters: 40,
      minEle: 100,
      maxEle: 140,
      color: PLANNING_ROUTE_COLOR,
      visible: true,
      hasFullPayload: false,
      geojson: { type: 'FeatureCollection', features: [] },
      elevationProfile: [],
      ownership: 'mine',
      ownerUid: 'u-me',
      cloudSyncStatus: 'synced',
      createdAt: '2026-11-10T08:00:00.000Z',
      updatedAt: '2026-11-10T09:00:00.000Z',
    };
    vi.spyOn(db.routes, 'toArray').mockResolvedValue([existingLocal] as any);
    vi.spyOn(db.routePayloads, 'bulkPut').mockRejectedValue(new Error('no idb'));
    vi.spyOn(db.routes, 'bulkPut').mockResolvedValue([] as any);

    memStorage.setItem(
      `${PLANNED_SYNC_WATERMARK_KEY_PREFIX}u-me`,
      '2026-11-10T09:00:00.000Z'
    );

    const deltaRoute = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(
        {
          ...existingLocal,
          id: 'inc-r2',
          name: 'מסלול חדש בדלתא',
          geojson: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [34.81, 30.83],
                    [34.82, 30.84],
                  ],
                },
              },
            ],
          },
          updatedAt: '2026-11-12T10:30:00.000Z',
        },
        me
      )
    );

    firebaseMocks.where.mockClear();
    firebaseMocks.getDocs.mockResolvedValue({
      forEach: (cb: (snap: { data: () => any }) => void) => {
        cb({ data: () => deltaRoute });
      },
    });

    const deltaFetched = await PlannedTracksCloudService.fetchUserPlannedRoutes(me);
    expect(firebaseMocks.where).toHaveBeenCalledWith(
      'updatedAt',
      '>',
      '2026-11-10T09:00:00.000Z'
    );
    expect(deltaFetched).toHaveLength(1);
    expect(deltaFetched[0].id).toBe('inc-r2');
    expect(getPlannedSyncWatermark('u-me')).toBe('2026-11-12T10:30:00.000Z');
    clearPlannedSyncWatermark('u-me');
  });

  it('supports PRD 4 route sharing normalization, collectionGroup shared inbox reconciliation, dismiss tombstones, revocation & live listener', async () => {
    const memStorage = createMemoryLocalStorage();
    vi.stubGlobal('window', { localStorage: memStorage });
    resetPlannedCloudSessionStateForTesting();

    const ownerUser: NavUser = {
      uid: 'u-owner',
      email: 'Owner@Gmail.com',
      displayName: 'אורי המדריך',
      photoURL: null,
    };

    const recipientUser: NavUser = {
      uid: 'u-recip',
      email: 'Recip@Gmail.com',
      displayName: 'דני',
      photoURL: null,
    };

    // 1. normalizeShareRecipients lowercases emails & deduplicates by uid/email
    const norm = normalizeShareRecipients([
      { uid: 'u-recip', email: 'Recip@Gmail.com', displayName: 'דני', sharedAt: '2026-11-12T08:00:00.000Z' },
      { uid: 'u-recip', email: 'recip@gmail.com', displayName: 'דני', sharedAt: '2026-11-12T08:05:00.000Z' },
      { uid: null, email: ' PendingFriend@Gmail.com ', displayName: null, sharedAt: '2026-11-12T08:01:00.000Z' },
    ]);
    expect(norm.sharedWith).toHaveLength(2);
    expect(norm.sharedWithUids).toEqual(['u-recip']);
    expect(norm.sharedWithEmails).toEqual(['recip@gmail.com', 'pendingfriend@gmail.com']);

    // 2. updateRouteSharing uploads & preserves imported GPX routes as well as planned routes
    firebaseMocks.getFirebaseServices.mockReturnValue({ firestore: {}, storage: {} });
    firebaseMocks.setDoc.mockResolvedValue(undefined);
    firebaseMocks.uploadString.mockRejectedValue(
      Object.assign(new Error('storage offline'), { code: 'storage/unknown' })
    );

    const routeMap = new Map<string, SavedRouteRecord>();
    const payloadMap = new Map<string, RoutePayloadRecord>();
    vi.spyOn(db.routes, 'put').mockImplementation((async (rec: SavedRouteRecord) => {
      routeMap.set(rec.id, rec);
      return rec.id;
    }) as any);
    vi.spyOn(db.routes, 'bulkPut').mockImplementation((async (recs: SavedRouteRecord[]) => {
      recs.forEach((r) => routeMap.set(r.id, r));
      return [] as any;
    }) as any);
    vi.spyOn(db.routes, 'get').mockImplementation((async (id: string) => routeMap.get(id)) as any);
    vi.spyOn(db.routes, 'toArray').mockImplementation((async () =>
      Array.from(routeMap.values())
    ) as any);
    vi.spyOn(db.routes, 'update').mockImplementation((async (id: string, patch: any) => {
      const prev = routeMap.get(id);
      if (prev) routeMap.set(id, { ...prev, ...patch });
      return 1;
    }) as any);
    vi.spyOn(db.routes, 'delete').mockImplementation((async (id: string) => {
      routeMap.delete(id);
    }) as any);
    vi.spyOn(db.routePayloads, 'put').mockImplementation((async (p: RoutePayloadRecord) => {
      payloadMap.set(p.id, p);
      return p.id;
    }) as any);
    vi.spyOn(db.routePayloads, 'bulkPut').mockImplementation((async (ps: RoutePayloadRecord[]) => {
      ps.forEach((p) => payloadMap.set(p.id, p));
      return [] as any;
    }) as any);
    vi.spyOn(db.routePayloads, 'get').mockImplementation((async (id: string) =>
      payloadMap.get(id)
    ) as any);
    vi.spyOn(db.routePayloads, 'delete').mockImplementation((async (id: string) => {
      payloadMap.delete(id);
    }) as any);

    const gpxImported: SavedRouteRecord = {
      id: 'gpx-import-1',
      name: 'שביל נחל דוד מיובא',
      sourceFormat: 'gpx',
      distanceKm: 4.5,
      ascentMeters: 180,
      descentMeters: 170,
      minEle: -380,
      maxEle: -200,
      color: '#e11d48',
      visible: true,
      hasFullPayload: true,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [35.38, 31.46],
                [35.39, 31.47],
              ],
            },
          },
        ],
      },
      elevationProfile: [
        { distKm: 0, ele: -380, lon: 35.38, lat: 31.46 },
        { distKm: 4.5, ele: -200, lon: 35.39, lat: 31.47 },
      ],
      ownership: 'mine',
      createdAt: '2026-11-12T08:00:00.000Z',
    };
    await RouteManager.persistFullRoute(gpxImported);

    const shareRes = await PlannedTracksCloudService.updateRouteSharing(
      gpxImported,
      norm.sharedWith,
      ownerUser
    );
    expect(shareRes.synced).toBe(true);
    expect(shareRes.route.sourceFormat).toBe('gpx');
    expect(shareRes.route.sharedWithEmails).toEqual(['recip@gmail.com', 'pendingfriend@gmail.com']);
    expect(firebaseMocks.setDoc).toHaveBeenCalledTimes(1);
    const writtenDoc = firebaseMocks.setDoc.mock.calls[0][1] as Record<string, any>;
    expect(writtenDoc.sourceFormat).toBe('gpx');
    expect(writtenDoc.sharedWithUids).toEqual(['u-recip']);
    expect(writtenDoc.sharedWithEmails).toEqual(['recip@gmail.com', 'pendingfriend@gmail.com']);

    // 3. Recipient fetchSharedWithMeRoutes deduplicates UID+Email queries, respects dismissed IDs, revokes dropped shares, & keeps personal clones!
    const sharedDoc1 = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(shareRes.route, ownerUser)
    );
    const sharedDocDismissed = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(
        {
          ...shareRes.route,
          id: 'gpx-dismissed-2',
          name: 'מסלול שהוסר מקומית',
        },
        ownerUser
      )
    );
    const dismissedLocalId = buildSharedLocalRouteId(ownerUser.uid, 'gpx-dismissed-2');
    markSharedRouteDismissed(dismissedLocalId);
    expect(getDismissedSharedRouteIds().has(dismissedLocalId)).toBe(true);

    // Pre-existing revoked remote share + a cloned personal copy ('mine') in local DB
    const revokedLocalId = buildSharedLocalRouteId(ownerUser.uid, 'old-revoked');
    routeMap.set(revokedLocalId, {
      ...gpxImported,
      id: revokedLocalId,
      ownership: 'shared',
      sharedByUid: ownerUser.uid,
    });
    const clonedPersonal = await RouteManager.duplicateRouteToMine(
      routeMap.get(revokedLocalId)!,
      recipientUser
    );
    expect(clonedPersonal.ownership).toBe('mine');

    firebaseMocks.getDocs
      .mockResolvedValueOnce({
        forEach: (cb: (snap: { id: string; ref: { path: string }; data: () => any }) => void) => {
          cb({
            id: 'gpx-import-1',
            ref: { path: 'planing_tracks/u-owner/routes/gpx-import-1' },
            data: () => sharedDoc1,
          });
          cb({
            id: 'gpx-dismissed-2',
            ref: { path: 'planing_tracks/u-owner/routes/gpx-dismissed-2' },
            data: () => sharedDocDismissed,
          });
        },
      })
      .mockResolvedValueOnce({
        forEach: (cb: (snap: { id: string; ref: { path: string }; data: () => any }) => void) => {
          // Same doc returned by sharedWithEmails -> must deduplicate cleanly
          cb({
            id: 'gpx-import-1',
            ref: { path: 'planing_tracks/u-owner/routes/gpx-import-1' },
            data: () => sharedDoc1,
          });
        },
      });

    const fetched = await PlannedTracksCloudService.fetchSharedWithMeRoutes(recipientUser);
    expect(firebaseMocks.collectionGroup).toHaveBeenCalledWith(expect.anything(), 'routes');
    expect(fetched.allShared).toHaveLength(1);
    expect(fetched.allShared[0].id).toBe(buildSharedLocalRouteId(ownerUser.uid, 'gpx-import-1'));
    expect(fetched.allShared[0].ownership).toBe('shared');
    expect(fetched.allShared[0].sharedByName).toBe('אורי המדריך');
    expect(fetched.newlyArrived).toHaveLength(1);
    expect(fetched.revokedIds).toEqual([revokedLocalId]);
    // Revoked shared route deleted, dismissed route skipped, cloned personal copy preserved!
    expect(routeMap.has(revokedLocalId)).toBe(false);
    expect(routeMap.has(dismissedLocalId)).toBe(false);
    expect(routeMap.has(clonedPersonal.id)).toBe(true);

    // 4. subscribeSharedWithMeRoutes streams real-time arrivals
    const listeners: Array<(snap: any) => void> = [];
    const unsubSpy = vi.fn();
    firebaseMocks.onSnapshot.mockImplementation((_q: unknown, onNext: (s: any) => void) => {
      listeners.push(onNext);
      return unsubSpy;
    });

    const events: Array<{ isInitial: boolean; newlyArrivedCount: number; total: number }> = [];
    const unsub = PlannedTracksCloudService.subscribeSharedWithMeRoutes(
      recipientUser,
      (ev) => {
        events.push({
          isInitial: ev.isInitial,
          newlyArrivedCount: ev.newlyArrived.length,
          total: ev.allShared.length,
        });
      }
    );
    expect(listeners).toHaveLength(2);

    // Initial snapshots arrive
    listeners[0]({
      forEach: (cb: any) =>
        cb({
          id: 'gpx-import-1',
          ref: { path: 'planing_tracks/u-owner/routes/gpx-import-1' },
          data: () => sharedDoc1,
        }),
    });
    listeners[1]({ forEach: () => undefined });
    await new Promise((r) => setTimeout(r, 15));

    // New shared route arrives in real time!
    const sharedDocLive = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(
        {
          ...shareRes.route,
          id: 'live-share-3',
          name: 'מסלול לייב',
          updatedAt: '2026-11-12T11:00:00.000Z',
        },
        ownerUser
      )
    );
    listeners[0]({
      forEach: (cb: any) => {
        cb({
          id: 'gpx-import-1',
          ref: { path: 'planing_tracks/u-owner/routes/gpx-import-1' },
          data: () => sharedDoc1,
        });
        cb({
          id: 'live-share-3',
          ref: { path: 'planing_tracks/u-owner/routes/live-share-3' },
          data: () => sharedDocLive,
        });
      },
    });
    await new Promise((r) => setTimeout(r, 15));

    expect(events.length).toBeGreaterThanOrEqual(2);
    const lastEv = events[events.length - 1];
    expect(lastEv.isInitial).toBe(false);
    expect(lastEv.newlyArrivedCount).toBe(1);
    expect(lastEv.total).toBe(2);

    unsub();
    expect(unsubSpy).toHaveBeenCalledTimes(2);
    clearSharedRouteDismissed(dismissedLocalId);

    // 5. updateRouteSharing must NOT report synced=true if Firestore write fails (even if Storage succeeds)
    firebaseMocks.setDoc.mockRejectedValueOnce(new Error('firestore permission-denied'));
    firebaseMocks.uploadString.mockResolvedValue({} as any);
    firebaseMocks.getDownloadURL.mockResolvedValue('https://example.com/route.gpx');
    const failedShareRes = await PlannedTracksCloudService.updateRouteSharing(
      gpxImported,
      norm.sharedWith,
      ownerUser
    );
    expect(failedShareRes.synced).toBe(false);
    expect(failedShareRes.error).toContain('firestore permission-denied');

    // 6. fetchSharedWithMeRoutes surfaces Firestore permission/index errors when all queries fail
    firebaseMocks.getDocs.mockRejectedValue(new Error('failed-precondition: requires index'));
    const errFetch = await PlannedTracksCloudService.fetchSharedWithMeRoutes(recipientUser);
    expect(errFetch.allShared).toEqual([]);
    expect(errFetch.error).toContain('failed-precondition');

    // 7. Concurrent reconcileSharedRoutes calls serialize cleanly without duplicating newlyArrived
    const routeLiveRec = {
      ...shareRes.route,
      id: buildSharedLocalRouteId(ownerUser.uid, 'concurrent-1'),
      ownership: 'shared' as const,
      sharedByUid: ownerUser.uid,
      sharedForUid: recipientUser.uid,
    };
    const [r1, r2] = await Promise.all([
      PlannedTracksCloudService.reconcileSharedRoutes([routeLiveRec], recipientUser),
      PlannedTracksCloudService.reconcileSharedRoutes([routeLiveRec], recipientUser),
    ]);
    expect(r1.newlyArrived.length + r2.newlyArrived.length).toBe(1);

    // 8. subscribeSharedWithMeRoutes automatically schedules a retry on failed-precondition (index building)
    vi.useFakeTimers();
    const errorCbs: Array<(e: any) => void> = [];
    const retryUnsubSpy = vi.fn();
    firebaseMocks.onSnapshot.mockImplementation(
      (_q: unknown, _onNext: (s: any) => void, onErr?: (e: any) => void) => {
        if (onErr) errorCbs.push(onErr);
        return retryUnsubSpy;
      }
    );
    const seenErrors: string[] = [];
    const subStop = PlannedTracksCloudService.subscribeSharedWithMeRoutes(
      recipientUser,
      () => undefined,
      (msg) => seenErrors.push(msg)
    );
    expect(errorCbs).toHaveLength(2);
    errorCbs[0](Object.assign(new Error('That index is not ready yet'), { code: 'failed-precondition' }));
    expect(seenErrors).toEqual(['failed-precondition']);
    vi.advanceTimersByTime(10000);
    // Retried listener attaches again automatically
    expect(errorCbs.length).toBeGreaterThanOrEqual(3);
    subStop();
    vi.useRealTimers();
  });

  it('isolates routes per signed-in account when switching users or signing out', async () => {
    const routeStore = new Map<string, SavedRouteRecord>();
    const payloadStore = new Map<string, RoutePayloadRecord>();

    vi.spyOn(db.routes, 'toArray').mockImplementation((async () =>
      Array.from(routeStore.values())
    ) as any);
    vi.spyOn(db.routes, 'bulkPut').mockImplementation((async (recs: SavedRouteRecord[]) => {
      recs.forEach((r) => routeStore.set(r.id, r));
      return [] as any;
    }) as any);
    vi.spyOn(db.routes, 'bulkDelete').mockImplementation((async (ids: string[]) => {
      ids.forEach((id) => routeStore.delete(id));
    }) as any);
    vi.spyOn(db.routePayloads, 'bulkDelete').mockImplementation((async (ids: string[]) => {
      ids.forEach((id) => payloadStore.delete(id));
    }) as any);

    const baseGeojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [34.81, 30.83],
              [34.82, 30.84],
            ],
          },
        },
      ],
    };

    const anonLegacyGpx: SavedRouteRecord = {
      id: 'legacy-gpx',
      name: 'מסלול GPX מקומי',
      sourceFormat: 'gpx',
      distanceKm: 2,
      ascentMeters: 30,
      descentMeters: 20,
      minEle: 100,
      maxEle: 130,
      color: '#ec4899',
      visible: true,
      hasFullPayload: false,
      geojson: baseGeojson,
      elevationProfile: [],
      ownership: 'mine',
      createdAt: '2026-11-10T08:00:00.000Z',
    };
    const userASyncedRoute: SavedRouteRecord = {
      ...anonLegacyGpx,
      id: 'ua-route-1',
      name: 'מסלול משתמש א',
      sourceFormat: 'planned',
      ownerUid: 'uid-a',
      cloudSyncStatus: 'synced',
    };
    const userASharedInbox: SavedRouteRecord = {
      ...anonLegacyGpx,
      id: 'shared_u_sender_r1',
      name: 'שותף עם משתמש א',
      ownership: 'shared',
      ownerUid: 'u-sender',
      sharedByUid: 'u-sender',
      sharedForUid: 'uid-a',
      cloudSyncStatus: 'synced',
    };
    const userBRoute: SavedRouteRecord = {
      ...anonLegacyGpx,
      id: 'ub-route-1',
      name: 'מסלול משתמש ב',
      sourceFormat: 'planned',
      ownerUid: 'uid-b',
      cloudSyncStatus: 'synced',
    };

    routeStore.set(anonLegacyGpx.id, anonLegacyGpx);
    routeStore.set(userASyncedRoute.id, userASyncedRoute);
    routeStore.set(userASharedInbox.id, userASharedInbox);

    // 1. User A signs in -> claims legacy unowned GPX route + sees only User A routes
    const claimed = await RouteManager.claimUnownedRoutesForUser({
      uid: 'uid-a',
      email: 'a@gmail.com',
      displayName: 'User A',
    });
    expect(claimed).toBe(1);
    expect(routeStore.get('legacy-gpx')?.ownerUid).toBe('uid-a');

    const aVisible = await RouteManager.listRouteSummaries('uid-a');
    expect(aVisible.map((r) => r.id).sort()).toEqual([
      'legacy-gpx',
      'shared_u_sender_r1',
      'ua-route-1',
    ]);

    // 2. Signed out (null) -> sees NONE of User A's routes or shared routes
    expect(await RouteManager.listRouteSummaries(null)).toEqual([]);

    // 3. Switch to User B -> purges User A's synced & shared routes and hides any remaining User A routes
    const purged = await RouteManager.purgeOtherUsersCachedRoutes('uid-b');
    expect(purged).toContain('ua-route-1');
    expect(purged).toContain('shared_u_sender_r1');

    routeStore.set(userBRoute.id, userBRoute);
    const bVisible = await RouteManager.listRouteSummaries('uid-b');
    expect(bVisible.map((r) => r.id)).toEqual(['ub-route-1']);
  });
});
