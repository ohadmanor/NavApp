import { afterEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  getFirebaseServices: vi.fn(),
  doc: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocs: vi.fn(),
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
  setDoc: firebaseMocks.setDoc,
  deleteDoc: firebaseMocks.deleteDoc,
  getDocs: firebaseMocks.getDocs,
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
import { ElevationService } from '../navigation/ElevationService';
import { extractRouteTangentHeading } from '../navigation/NavigationHeadingService';
import { db, type SavedRouteRecord } from '../db/NavDatabase';
import {
  PlannedTracksCloudService,
  clearPlannedRouteDeleted,
  getDeletedPlannedRouteIds,
  markPlannedRouteDeleted,
  resetPlannedCloudSessionStateForTesting,
  serializePlannedRouteForFirestore,
  buildPlannedRouteJsonPayload,
  deserializeFirestorePlannedRoute,
} from '../firebase/PlannedTracksCloudService';
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
});
