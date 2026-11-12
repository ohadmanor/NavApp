import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import {
  evaluateEdgeAccess,
  PLANNING_MODE_META,
  PLANNING_ROUTE_COLOR,
} from '../routing/RoutingProfiles';
import {
  TileRoadGraphBuilder,
  ROUTING_TILE_ZOOM,
  TILE_EXTENT,
  lonLatToTile,
  globalPixelToLonLat,
  haversineMeters,
  type DecodedWay,
} from '../routing/TileRoadGraphBuilder';
import { ClientRoutePlannerEngine } from '../routing/ClientRoutePlannerEngine';
import { RouteManager } from '../navigation/RouteManager';
import { HighwayWayGeometryService } from '../trails/HighwayWayGeometryService';
import { trailWayIdFromMvtId } from '../trails/TrailAnnotationTypes';
import {
  FIREBASE_PLANNING_FOLDER,
  buildPlaningTracksPaths,
  buildPlannedRouteJsonPayload,
  serializePlannedRouteForFirestore,
  deserializeFirestorePlannedRoute,
} from '../firebase/PlannedTracksCloudService';
import { db, type SavedRouteRecord } from '../db/NavDatabase';
import type { NavUser } from '../firebase/AuthService';

class LocalFilePMTilesSource implements Source {
  private fd: number;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
  }

  getKey(): string {
    return this.filePath;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(this.fd, buf, 0, length, offset);
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
    return { data: arrayBuffer };
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

function createRealIsraelOsmFetcher() {
  const pmtilesPath = path.resolve(process.cwd(), 'data/Israel.osm.pmtiles');
  const src = new LocalFilePMTilesSource(pmtilesPath);
  const archive = new PMTiles(src);
  return {
    pmtilesPath,
    fetcher: async (z: number, x: number, y: number) => {
      const tile = await archive.getZxy(z, x, y);
      return tile?.data;
    },
    close: () => src.close(),
  };
}

describe('Client-Side Route Planner (4x4, Foot, Bicycle) & Firebase planing_tracks', () => {
  it('enforces accurate edge access, oneway directions, and preferences across 4x4, foot, and bicycle profiles', () => {
    // Dirt track grade4 -> allowed for all, bidirectional even if oneway tagged, no road steps/footway for 4x4
    const dirtTrack = evaluateEdgeAccess({ class: 'track', tracktype: 'grade4', oneway: 1 }, '4x4');
    expect(dirtTrack.allowed).toBe(true);
    expect(dirtTrack.forwardAllowed).toBe(true);
    expect(dirtTrack.reverseAllowed).toBe(true);
    expect(dirtTrack.roadLabel).toContain('grade4');

    const footwayFor4x4 = evaluateEdgeAccess({ class: 'path', subclass: 'footway' }, '4x4');
    expect(footwayFor4x4.allowed).toBe(false);

    const stepsFor4x4 = evaluateEdgeAccess({ class: 'path', subclass: 'steps' }, '4x4');
    expect(stepsFor4x4.allowed).toBe(false);

    const noMotorTrack = evaluateEdgeAccess(
      { class: 'track', motor_vehicle: 'no' },
      '4x4'
    );
    expect(noMotorTrack.allowed).toBe(false);

    // One-way urban paved street respects direction for 4x4 & bicycle, but foot is always bidirectional
    const onewayRoad = { class: 'residential', oneway: 1 };
    const road4x4 = evaluateEdgeAccess(onewayRoad, '4x4');
    expect(road4x4.allowed).toBe(true);
    expect(road4x4.forwardAllowed).toBe(true);
    expect(road4x4.reverseAllowed).toBe(false);

    const roadBike = evaluateEdgeAccess(onewayRoad, 'bicycle');
    expect(roadBike.allowed).toBe(true);
    expect(roadBike.forwardAllowed).toBe(true);
    expect(roadBike.reverseAllowed).toBe(false);

    const roadFoot = evaluateEdgeAccess(onewayRoad, 'foot');
    expect(roadFoot.allowed).toBe(true);
    expect(roadFoot.forwardAllowed).toBe(true);
    expect(roadFoot.reverseAllowed).toBe(true);

    // Motorway allowed for 4x4, blocked for foot & bicycle unless explicitly permitted
    expect(evaluateEdgeAccess({ class: 'motorway' }, '4x4').allowed).toBe(true);
    expect(evaluateEdgeAccess({ class: 'motorway' }, 'foot').allowed).toBe(false);
    expect(evaluateEdgeAccess({ class: 'motorway' }, 'bicycle').allowed).toBe(false);

    // Foot prefers marked SPNI trail over paved secondary road
    const spniTrail = evaluateEdgeAccess(
      { class: 'path', subclass: 'path', colour: 'red' },
      'foot'
    );
    const pavedSec = evaluateEdgeAccess({ class: 'secondary' }, 'foot');
    expect(spniTrail.allowed).toBe(true);
    expect(pavedSec.allowed).toBe(true);
    expect(spniTrail.costMultiplier).toBeLessThan(pavedSec.costMultiplier);

    // Bicycle allows cycleways & mtb singletracks, rejects steps unless bicycle=yes
    expect(evaluateEdgeAccess({ class: 'path', subclass: 'cycleway', oneway: 1 }, 'bicycle')).toMatchObject({
      allowed: true,
      forwardAllowed: true,
      reverseAllowed: true,
    });
    expect(evaluateEdgeAccess({ class: 'path', subclass: 'path', mtb_scale: '2' }, 'bicycle').allowed).toBe(true);
    expect(evaluateEdgeAccess({ class: 'path', subclass: 'steps' }, 'bicycle').allowed).toBe(false);
    expect(evaluateEdgeAccess({ class: 'path', subclass: 'footway', bicycle: 'no' }, 'bicycle').allowed).toBe(false);
  });

  it('splits intersecting interior vertices, stitches z14 tile seams, isolates bridge overpasses, and detects disconnected components', async () => {
    const builder = new TileRoadGraphBuilder();
    const txA = 9797;
    const txB = 9798;
    const ty = 6699;

    const pt = (gx: number, gy: number, isClipped = false) => {
      const [lon, lat] = globalPixelToLonLat(gx, gy);
      return { gx, gy, lon, lat, isClipped };
    };

    const yMain = ty * TILE_EXTENT + 2000;
    const seamX = txB * TILE_EXTENT; // Shared exact z14 boundary between txA and txB
    const xStart = txA * TILE_EXTENT + 1500;
    const xCross = txA * TILE_EXTENT + 2600;
    const xEnd = txB * TILE_EXTENT + 900;

    // Tile A ways:
    // 1. Horizontal road going from xStart -> xCross -> (seamX - 2 rounded clip mismatch!)
    // 2. Vertical cross street crossing (xCross, yMain) at an INTERIOR vertex!
    // 3. Bridge (layer=1) crossing ABOVE (xStart + 300, yMain) without connecting at intersection, only connected at its unclipped end
    // 4. Isolated disconnected cul-de-sac far away
    const tileAWays: DecodedWay[] = [
      {
        featureId: '100',
        props: { class: 'track', tracktype: 'grade2' },
        layer: 0,
        points: [
          pt(xStart, yMain),
          pt(xCross, yMain),
          pt(seamX, yMain - 2, true), // slight 2-unit tile clip difference vs tile B
        ],
      },
      {
        featureId: '200',
        props: { class: 'tertiary' },
        layer: 0,
        points: [
          pt(xCross, yMain - 700),
          pt(xCross, yMain), // interior junction of way 100
          pt(xCross, yMain + 700),
        ],
      },
      {
        featureId: '300',
        props: { class: 'secondary', oneway: 1 },
        layer: 1,
        points: [
          pt(xStart + 300, yMain - 400),
          pt(xStart + 300, yMain), // overpass above ground, NOT a ground intersection!
          pt(xStart + 300, yMain + 400),
        ],
      },
      {
        featureId: '400',
        props: { class: 'residential' },
        layer: 0,
        points: [pt(xStart + 50, yMain + 1200), pt(xStart + 450, yMain + 1200)],
      },
    ];

    const tileBWays: DecodedWay[] = [
      {
        featureId: '100',
        props: { class: 'track', tracktype: 'grade2' },
        layer: 0,
        points: [
          pt(seamX, yMain, true),
          pt(xEnd, yMain),
        ],
      },
    ];

    vi.spyOn(builder, 'getDecodedTileWays').mockImplementation(async (tx, tyReq) => {
      if (tx === txA && tyReq === ty) return tileAWays;
      if (tx === txB && tyReq === ty) return tileBWays;
      return [];
    });

    const engine = new ClientRoutePlannerEngine();
    (engine as any).graphBuilder = builder;

    // 1. Cross-tile route + turn onto intersecting interior vertex!
    const clickOnStart = globalPixelToLonLat(xStart + 100, yMain - 25);
    const snappedStart = await engine.snapToNearestHighway(clickOnStart[0], clickOnStart[1], '4x4');
    expect(snappedStart).not.toBeNull();
    expect(snappedStart!.distFromClickMeters).toBeLessThan(30);

    // Click near end in adjacent tile txB
    const endCoord = globalPixelToLonLat(xEnd - 50, yMain + 20);
    const snappedEnd = await engine.snapToNearestHighway(endCoord[0], endCoord[1], '4x4');
    expect(snappedEnd).not.toBeNull();

    const crossTileLeg = await engine.routeBetweenSnappedPoints(snappedStart!, snappedEnd!, '4x4');
    expect(crossTileLeg.found).toBe(true);
    expect(crossTileLeg.legType).toBe('network');
    expect(crossTileLeg.coordinates.length).toBeGreaterThanOrEqual(3);

    // 2. Turn at interior shared junction vertex from horizontal track onto vertical tertiary road
    const turnCoord = globalPixelToLonLat(xCross, yMain + 500);
    const snappedTurn = await engine.snapToNearestHighway(turnCoord[0], turnCoord[1], '4x4');
    expect(snappedTurn).not.toBeNull();
    const turnLeg = await engine.routeBetweenSnappedPoints(snappedStart!, snappedTurn!, '4x4');
    expect(turnLeg.found).toBe(true);

    // 3. Same-edge routing works directly between two mid-edge points
    const midCoord = globalPixelToLonLat(xStart + 550, yMain);
    const snappedMid = await engine.snapToNearestHighway(midCoord[0], midCoord[1], '4x4');
    expect(snappedMid).not.toBeNull();
    const sameEdgeLeg = await engine.routeBetweenSnappedPoints(snappedStart!, snappedMid!, '4x4');
    expect(sameEdgeLeg.found).toBe(true);
    expect(sameEdgeLeg.distanceKm).toBeGreaterThan(0);

    // 4. Bridge (layer=1) crossing over ground road is NOT connected to ground road unless an endpoint meets
    const bridgeCoord = globalPixelToLonLat(xStart + 300, yMain - 250);
    const snappedBridge = await engine.snapToNearestHighway(bridgeCoord[0], bridgeCoord[1], '4x4');
    expect(snappedBridge).not.toBeNull();
    const bridgeToGround = await engine.routeBetweenSnappedPoints(snappedStart!, snappedBridge!, '4x4');
    expect(bridgeToGround.found).toBe(false);
    expect(bridgeToGround.reason).toBe('disconnected');

    // 5. Disconnected island street returns disconnected reason
    const isoCoord = globalPixelToLonLat(xStart + 250, yMain + 1200);
    const snappedIso = await engine.snapToNearestHighway(isoCoord[0], isoCoord[1], '4x4');
    expect(snappedIso).not.toBeNull();
    const isoRes = await engine.routeBetweenSnappedPoints(snappedStart!, snappedIso!, '4x4');
    expect(isoRes.found).toBe(false);
    expect(isoRes.reason).toBe('disconnected');

    // 6. Enforce oneway on paved bridge in 4x4 mode (reverse fails, forward succeeds)
    const bridgeTop = await engine.snapToNearestHighway(
      ...globalPixelToLonLat(xStart + 300, yMain - 350),
      '4x4'
    );
    const bridgeBot = await engine.snapToNearestHighway(
      ...globalPixelToLonLat(xStart + 300, yMain + 350),
      '4x4'
    );
    expect((await engine.routeBetweenSnappedPoints(bridgeTop!, bridgeBot!, '4x4')).found).toBe(true);
    expect((await engine.routeBetweenSnappedPoints(bridgeBot!, bridgeTop!, '4x4')).found).toBe(false);
  });

  it('snaps and routes on real Israel.osm.pmtiles vector tiles in Ein Aqev (4x4 & foot) and Jerusalem (foot/bicycle)', async () => {
    const real = createRealIsraelOsmFetcher();
    try {
      const builder = new TileRoadGraphBuilder({ fetchTileData: real.fetcher });
      const engine = new ClientRoutePlannerEngine({ fetchTileData: real.fetcher });

      // Real-data test 1: Ein Aqev desert trails & dirt tracks ([34.8134, 30.835] across 3x3 desert corridor)
      const einCenter = lonLatToTile(34.8134, 30.835, ROUTING_TILE_ZOOM);
      const selectableWay = (await builder.getDecodedTileWays(einCenter.tx, einCenter.ty)).find(
        (way) => /^\d+$/.test(way.featureId) && way.points.length >= 2
      );
      if (!selectableWay) throw new Error('Expected a stable highway feature ID in the PMTiles fixture.');
      const wayId = trailWayIdFromMvtId(selectableWay.featureId);
      if (!wayId) throw new Error('Expected the PMTiles highway ID to be numeric.');
      const selectedPoint = selectableWay.points[Math.floor(selectableWay.points.length / 2)];
      const resolvedWay = await new HighwayWayGeometryService(builder).resolveWayAt(
        wayId,
        selectedPoint.lon,
        selectedPoint.lat,
        'integration-test-release'
      );
      expect(resolvedWay.geometry.coordinates.flat().length).toBeGreaterThanOrEqual(2);

      const einTiles = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          einTiles.push({ tx: einCenter.tx + dx, ty: einCenter.ty + dy });
        }
      }
      const einGraph4x4 = await builder.buildGraphForTiles(einTiles, '4x4');
      expect(einGraph4x4.edges.length).toBeGreaterThanOrEqual(5);

      // Find two adjacent connected edges in Ein Aqev 4x4 graph to verify real-world snapping & multi-edge routing
      const first4x4Edge = einGraph4x4.edges.find(
        (e) =>
          !e.id.startsWith('ramp-') &&
          e.lengthMeters > 40 &&
          (einGraph4x4.adjacency.get(e.toNode)?.some(
            (adj) => adj.edge.id !== e.id && !adj.edge.id.startsWith('ramp-')
          ) ??
            false)
      );
      expect(first4x4Edge).toBeDefined();

      const next4x4Step = einGraph4x4.adjacency
        .get(first4x4Edge!.toNode)!
        .find((adj) => adj.edge.id !== first4x4Edge!.id && !adj.edge.id.startsWith('ramp-'));
      expect(next4x4Step).toBeDefined();

      const p1 = first4x4Edge!.coords[Math.floor(first4x4Edge!.coords.length / 2)];
      const p2 = next4x4Step!.edge.coords[Math.floor(next4x4Step!.edge.coords.length / 2)];

      // Offset simulated user click ~0.00018 deg (~18 meters) off the track to exercise Snap-to-Highway!
      const snap1 = await engine.snapToNearestHighway(p1[0] + 0.00018, p1[1] - 0.00012, '4x4');
      const snap2 = await engine.snapToNearestHighway(p2[0] - 0.00015, p2[1] + 0.00015, '4x4');
      expect(snap1).not.toBeNull();
      expect(snap2).not.toBeNull();
      expect(snap1!.distFromClickMeters).toBeLessThanOrEqual(50);
      expect(snap2!.distFromClickMeters).toBeLessThanOrEqual(50);

      const leg4x4 = await engine.routeBetweenSnappedPoints(snap1!, snap2!, '4x4');
      expect(leg4x4.found).toBe(true);
      expect(leg4x4.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(leg4x4.distanceKm).toBeGreaterThan(0);

      // Verify distance of A* path isn't wildly off straight-line Euclidean minimum
      const straightKm = haversineMeters([snap1!.lon, snap1!.lat], [snap2!.lon, snap2!.lat]) / 1000;
      expect(leg4x4.distanceKm).toBeGreaterThanOrEqual(straightKm * 0.95);

      // Real-data test 2: Foot trail in Ein Aqev must find a hiking path that 4x4 skips
      const einGraphFoot = await builder.buildGraphForTiles(einTiles, 'foot');
      const footOnlyPath = einGraphFoot.edges.find((e) => e.roadClass === 'path');
      expect(footOnlyPath).toBeDefined();
      const fp = footOnlyPath!.coords[Math.floor(footOnlyPath!.coords.length / 2)];
      const snapFoot = await engine.snapToNearestHighway(fp[0] + 0.00005, fp[1], 'foot');
      expect(snapFoot).not.toBeNull();
      expect(snapFoot!.roadClass).toBe('path');

      // Real-data test 3: Jerusalem urban streets (bicycle routing & dense junctions)
      const jerTile = lonLatToTile(35.2137, 31.7683, ROUTING_TILE_ZOOM);
      const jerBikeGraph = await builder.buildGraphForTiles([jerTile], 'bicycle');
      expect(jerBikeGraph.edges.length).toBeGreaterThan(200);

      const bikeStartEdge = jerBikeGraph.edges.find(
        (e) => !e.id.startsWith('ramp-') && e.forwardAllowed && (jerBikeGraph.adjacency.get(e.toNode)?.length || 0) >= 2
      );
      const bikeNextStep = bikeStartEdge
        ? jerBikeGraph.adjacency
            .get(bikeStartEdge.toNode)!
            .find((a) => a.edge.id !== bikeStartEdge.id && !a.edge.id.startsWith('ramp-'))
        : undefined;
      expect(bikeStartEdge).toBeDefined();
      expect(bikeNextStep).toBeDefined();

      const b1 = await engine.snapToNearestHighway(
        bikeStartEdge!.coords[0][0] + 0.0001,
        bikeStartEdge!.coords[0][1],
        'bicycle'
      );
      const b2EdgeCoords = bikeNextStep!.edge.coords;
      const b2 = await engine.snapToNearestHighway(
        b2EdgeCoords[b2EdgeCoords.length - 1][0],
        b2EdgeCoords[b2EdgeCoords.length - 1][1] + 0.0001,
        'bicycle'
      );
      expect(b1).not.toBeNull();
      expect(b2).not.toBeNull();
      const bikeLeg = await engine.routeBetweenSnappedPoints(b1!, b2!, 'bicycle');
      expect(bikeLeg.found).toBe(true);
      expect(bikeLeg.distanceKm).toBeGreaterThan(0);

      // Far offshore point (Mediterranean Sea) should return null snap within default radius
      const seaSnap = await engine.snapToNearestHighway(34.2, 32.1, 'foot');
      expect(seaSnap).toBeNull();
    } finally {
      real.close();
    }
  });

  it('exports high-resolution planned GPX with <wpt> waypoints, <trkseg> geometry, <ele>, and builds Firebase planing_tracks paths', () => {
    const samplePlannedRoute: SavedRouteRecord = {
      id: 'route-planned-test-1',
      name: 'עין עקב & "מעלה" <4x4>',
      sourceFormat: 'planned',
      planningMode: '4x4',
      waypoints: [
        { lon: 34.8134, lat: 30.835, ele: 392, roadLabel: 'דרך עפר (grade3)' },
        { lon: 34.8195, lat: 30.841, ele: 448, roadLabel: 'דרך עפר / 4x4', legType: 'network' },
      ],
      distanceKm: 1.45,
      ascentMeters: 62,
      descentMeters: 6,
      minEle: 392,
      maxEle: 448,
      color: '#f97316',
      visible: true,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [34.8134, 30.835],
                [34.8162, 30.838],
                [34.8195, 30.841],
              ],
            },
          },
        ],
      },
      elevationProfile: [
        { distKm: 0, ele: 392, lon: 34.8134, lat: 30.835 },
        { distKm: 0.72, ele: 418, lon: 34.8162, lat: 30.838 },
        { distKm: 1.45, ele: 448, lon: 34.8195, lat: 30.841 },
      ],
      ownerUid: 'uid_abc_123',
      ownerEmail: 'hiker@gmail.com',
      cloudSyncStatus: 'pending',
      createdAt: '2026-11-09T14:00:00.000Z',
    };

    const gpx = RouteManager.exportRouteAsGpx(samplePlannedRoute);
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('&amp; &quot;מעלה&quot; &lt;4x4&gt;');
    expect(gpx).toContain('<author><name>hiker@gmail.com</name></author>');
    expect(gpx).toContain('<wpt lat="30.835000" lon="34.813400"><ele>392</ele><name>WP1</name>');
    expect(gpx).toContain('<wpt lat="30.841000" lon="34.819500"><ele>448</ele><name>WP2</name>');
    expect(gpx).toContain('<trkpt lat="30.838000" lon="34.816200"><ele>418</ele></trkpt>');
    expect(gpx).toContain('<type>4x4</type>');

    const fakeUser: NavUser = {
      uid: 'gmailUser99',
      email: 'hiker@gmail.com',
      displayName: 'Israel Hiker',
      photoURL: null,
    };

    expect(FIREBASE_PLANNING_FOLDER).toBe('planing_tracks');
    const paths = buildPlaningTracksPaths(fakeUser.uid, samplePlannedRoute.id);
    expect(paths.gpxPath).toBe('planing_tracks/gmailUser99/route-planned-test-1.gpx');
    expect(paths.jsonPath).toBe('planing_tracks/gmailUser99/route-planned-test-1.json');

    const payload = buildPlannedRouteJsonPayload(samplePlannedRoute, fakeUser);
    expect(payload.ownerUid).toBe('gmailUser99');
    expect(payload.ownerEmail).toBe('hiker@gmail.com');
    expect(payload.cloudStoragePath).toBe(paths.gpxPath);
    expect(payload.cloudJsonPath).toBe(paths.jsonPath);
    expect(payload.gpxXml).toContain('<gpx version="1.1"');

    // Verify Firestore serialization flattens nested coordinate arrays & strips undefined values
    const firestoreDoc = serializePlannedRouteForFirestore(payload);
    expect(typeof firestoreDoc.geojsonJson).toBe('string');
    expect(firestoreDoc.geojson).toBeUndefined();
    const assertNoNestedArraysOrUndefined = (val: unknown) => {
      if (Array.isArray(val)) {
        for (const item of val) {
          expect(Array.isArray(item)).toBe(false);
          expect(item).not.toBeUndefined();
          assertNoNestedArraysOrUndefined(item);
        }
      } else if (val !== null && typeof val === 'object') {
        for (const v of Object.values(val as Record<string, unknown>)) {
          expect(v).not.toBeUndefined();
          assertNoNestedArraysOrUndefined(v);
        }
      }
    };
    assertNoNestedArraysOrUndefined(firestoreDoc);

    // Legacy planned route sample retains GeoJSON properties in Firestore JSON payload,
    // and deserializeFirestorePlannedRoute normalizes it to PLANNING_ROUTE_COLOR (blue #2563eb)
    expect(PLANNING_ROUTE_COLOR).toBe('#2563eb');
    expect(PLANNING_MODE_META['4x4'].color).toBe(PLANNING_ROUTE_COLOR);
    expect(PLANNING_MODE_META.foot.color).toBe(PLANNING_ROUTE_COLOR);
    expect(PLANNING_MODE_META.bicycle.color).toBe(PLANNING_ROUTE_COLOR);

    const roundTrip = deserializeFirestorePlannedRoute(firestoreDoc, fakeUser);
    expect(roundTrip).not.toBeNull();
    expect(roundTrip!.color).toBe(PLANNING_ROUTE_COLOR);
    expect((roundTrip!.geojson.features[0].properties as any)?.color).toBe(PLANNING_ROUTE_COLOR);
    expect(roundTrip!.geojson.features[0].geometry).toEqual(samplePlannedRoute.geojson.features[0].geometry);
  });

  it('migrates legacy planned route colors to blue (#2563eb) via RouteManager.initializeStarterRoutes()', async () => {
    const legacyRoute: SavedRouteRecord = {
      id: 'route-planned-legacy-1',
      name: 'Legacy Orange Planned Route',
      sourceFormat: 'planned',
      planningMode: '4x4',
      distanceKm: 1.2,
      ascentMeters: 30,
      descentMeters: 15,
      minEle: 300,
      maxEle: 330,
      color: '#f97316',
      visible: true,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { color: '#f97316' },
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
        { distKm: 1.2, ele: 330, lon: 34.82, lat: 30.84 },
      ],
      createdAt: '2026-11-01T10:00:00.000Z',
    };

    const bulkDelSpy = vi.spyOn(db.routes, 'bulkDelete').mockResolvedValue(undefined as any);
    const toArraySpy = vi.spyOn(db.routes, 'toArray').mockResolvedValue([legacyRoute]);
    const bulkPutSpy = vi.spyOn(db.routes, 'bulkPut').mockResolvedValue([] as any);

    try {
      const normalized = await RouteManager.initializeStarterRoutes();
      expect(normalized).toHaveLength(1);
      expect(normalized[0].color).toBe(PLANNING_ROUTE_COLOR);
      expect((normalized[0].geojson.features[0].properties as any)?.color).toBe(PLANNING_ROUTE_COLOR);
      expect(bulkPutSpy).toHaveBeenCalledTimes(1);
    } finally {
      bulkDelSpy.mockRestore();
      toArraySpy.mockRestore();
      bulkPutSpy.mockRestore();
    }
  });
});
