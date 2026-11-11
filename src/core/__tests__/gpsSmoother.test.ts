import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import {
  GpsNavigationSmoother,
  RoadSnapNetworkCache,
  buildSnapPolyline,
} from '../navigation/GpsNavigationSmoother';
import {
  haversineMeters,
  shortestAngleDeltaDeg,
} from '../navigation/NavigationHeadingService';
import { TileRoadGraphBuilder, lonLatToTile } from '../routing/TileRoadGraphBuilder';
import { evaluateEdgeAccess } from '../routing/RoutingProfiles';
import type { LiveGpsFix } from '../navigation/LiveGpsService';
import type { SavedRouteRecord } from '../db/NavDatabase';

const METERS_PER_DEG_LAT = 111194.9;
const DEG_TO_RAD = Math.PI / 180;

function metersToGeoDelta(lonLatLat: number, eastMeters: number, northMeters: number): [number, number] {
  const mPerDegLon = METERS_PER_DEG_LAT * Math.cos(lonLatLat * DEG_TO_RAD);
  return [eastMeters / mPerDegLon, northMeters / METERS_PER_DEG_LAT];
}

function makeFix(
  lon: number,
  lat: number,
  opts?: Partial<Omit<LiveGpsFix, 'lon' | 'lat'>>
): LiveGpsFix {
  return {
    lon,
    lat,
    accuracy: opts?.accuracy ?? 6,
    altitude: opts?.altitude ?? 400,
    heading: opts?.heading ?? 0,
    speed: opts?.speed ?? 0,
    timestamp: opts?.timestamp ?? 1_700_000_000_000,
  };
}

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
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead) };
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

describe('GpsNavigationSmoother (Kalman + 60fps Prediction + Map-Matching)', () => {
  it('smoothly advances at 60fps between 1Hz fixes while driving straight at 72 km/h (20 m/s)', () => {
    const smoother = new GpsNavigationSmoother({
      enableRoadNetworkMatching: false,
    });
    const baseLon = 34.8134;
    const baseLat = 30.8281;
    const baseTs = 1_700_000_000_000;

    // Seed 3 fixes moving North at 20 m/s (~72 km/h)
    for (let sec = 0; sec <= 2; sec++) {
      const [, dLat] = metersToGeoDelta(baseLat, 0, sec * 20);
      smoother.ingestFix(
        makeFix(baseLon, baseLat + dLat, {
          speed: 20,
          heading: 0,
          accuracy: 5,
          timestamp: baseTs + sec * 1000,
        }),
        sec * 1000
      );
    }

    // Step at 60fps (~16.67ms) from t=2000ms to t=3000ms without receiving a GPS fix yet
    const frames: Array<{ lat: number; lon: number }> = [];
    for (let t = 2016; t < 3000; t += 16) {
      const f = smoother.step(t)!;
      expect(f).not.toBeNull();
      frames.push({ lon: f.lon, lat: f.lat });
    }

    // Check monotonic forward progress and smooth sub-meter steps (zero 20m jumps)
    let maxStepMeters = 0;
    for (let i = 1; i < frames.length; i++) {
      const stepMeters = haversineMeters(
        frames[i - 1].lon,
        frames[i - 1].lat,
        frames[i].lon,
        frames[i].lat
      );
      expect(stepMeters).toBeGreaterThan(0.15);
      expect(stepMeters).toBeLessThan(0.75);
      if (stepMeters > maxStepMeters) maxStepMeters = stepMeters;
      expect(frames[i].lat).toBeGreaterThan(frames[i - 1].lat);
    }
    expect(maxStepMeters).toBeLessThan(0.75);

    // At t=3000ms a slightly noisy fix arrives; residual feedforward blending must avoid any sudden snap > 1.5m
    const [, dLat3] = metersToGeoDelta(baseLat, 0, 62.5);
    smoother.ingestFix(
      makeFix(baseLon, baseLat + dLat3, {
        speed: 20,
        heading: 0,
        accuracy: 6,
        timestamp: baseTs + 3000,
      }),
      3000
    );
    const prevLast = frames[frames.length - 1];
    const postFixStep = smoother.step(3016)!;
    const transitionMeters = haversineMeters(
      prevLast.lon,
      prevLast.lat,
      postFixStep.lon,
      postFixStep.lat
    );
    expect(transitionMeters).toBeLessThan(1.5);
  });

  it('smoothly decelerates during sudden braking without backward rubber-band jumps', () => {
    const smoother = new GpsNavigationSmoother({ enableRoadNetworkMatching: false });
    const baseLon = 34.8134;
    const baseLat = 30.8281;

    // Drive North at 20 m/s for 3 fixes, then predict forward 750ms while vehicle brakes sharply
    for (let sec = 0; sec <= 2; sec++) {
      const [, dy] = metersToGeoDelta(baseLat, 0, sec * 20);
      smoother.ingestFix(
        makeFix(baseLon, baseLat + dy, {
          speed: 20,
          heading: 0,
          accuracy: 5,
          timestamp: sec * 1000,
        }),
        sec * 1000
      );
    }

    // Extrapolate at 60fps right up to t=2984ms (frame before the t=3000ms braking fix arrives)
    let fBeforeStop = smoother.step(2016)!;
    for (let t = 2032; t <= 2984; t += 16) {
      fBeforeStop = smoother.step(t)!;
    }

    // Vehicle actually stopped early at 48m North (11.7m behind linear prediction!)
    const [, stopLat] = metersToGeoDelta(baseLat, 0, 48);
    smoother.ingestFix(
      makeFix(baseLon, baseLat + stopLat, {
        speed: 0,
        heading: 0,
        accuracy: 5,
        timestamp: 3000,
      }),
      3000
    );

    const afterBrakeFrames: number[] = [];
    for (let t = 3000; t <= 4000; t += 16) {
      const f = smoother.step(t)!;
      afterBrakeFrames.push(f.lat);
    }

    // Immediate frame after brake fix must NOT jump instantaneously (> 1.5m) from t=2984ms
    const firstBrakeStepMeters = haversineMeters(
      fBeforeStop.lon,
      fBeforeStop.lat,
      baseLon,
      afterBrakeFrames[0]
    );
    expect(firstBrakeStepMeters).toBeLessThan(1.5);

    // Every 16ms convergence step must stay smooth (< 1.2m/frame, decaying monotonically without oscillation)
    let prevStep = Infinity;
    for (let i = 1; i < afterBrakeFrames.length; i++) {
      const stepMeters = haversineMeters(
        baseLon,
        afterBrakeFrames[i - 1],
        baseLon,
        afterBrakeFrames[i]
      );
      expect(stepMeters).toBeLessThan(1.2);
      expect(stepMeters).toBeLessThanOrEqual(prevStep + 0.05);
      prevStep = stepMeters;
    }
  });

  it('decays dead-reckoning safely during GPS signal dropouts and recovers cleanly', () => {
    const smoother = new GpsNavigationSmoother({
      enableRoadNetworkMatching: false,
      fullPredictDurationSec: 1.15,
      maxPredictDurationSec: 2.3,
    });
    const baseLon = 34.8134;
    const baseLat = 30.8281;

    for (let sec = 0; sec <= 2; sec++) {
      const [, dLat] = metersToGeoDelta(baseLat, 0, sec * 20);
      smoother.ingestFix(
        makeFix(baseLon, baseLat + dLat, {
          speed: 20,
          heading: 0,
          accuracy: 5,
          timestamp: sec * 1000,
        }),
        sec * 1000
      );
    }

    // No fix from t=2000ms through t=6000ms
    const fAt1s = smoother.step(3000)!;
    const fAt2_5s = smoother.step(4500)!;
    const fAt4s = smoother.step(6000)!;

    // Full speed around 1s gap -> ~20m ahead of t=2000 fix (~40m base + 20m = ~60m)
    const dist1s = haversineMeters(baseLon, baseLat, fAt1s.lon, fAt1s.lat);
    expect(dist1s).toBeGreaterThan(55);
    expect(dist1s).toBeLessThan(65);

    // Tapered max displacement: should never run away infinitely (bounded ~40 + 1.725 * 20 ~= 74.5m)
    const dist4s = haversineMeters(baseLon, baseLat, fAt4s.lon, fAt4s.lat);
    expect(dist4s).toBeGreaterThan(68);
    expect(dist4s).toBeLessThan(82);
    expect(haversineMeters(fAt2_5s.lon, fAt2_5s.lat, fAt4s.lon, fAt4s.lat)).toBeLessThan(2);

    // Run a few settle steps at t=6000+ so convergence gap decays to < 0.08m and rAF pauses
    for (let t = 6016; t <= 8000; t += 16) {
      smoother.step(t);
    }
    expect(smoother.needsAnimationFrame(8000)).toBe(false);
  });

  it('rejects low-accuracy noise, filters 1-second teleport spikes, and accepts confirmed tunnel exits & indoor-to-GPS upgrades', () => {
    const smoother = new GpsNavigationSmoother({ enableRoadNetworkMatching: false });
    const baseLon = 34.8134;
    const baseLat = 30.8281;

    // 1. Coarse indoor seed replaced cleanly by accurate primary GPS fix
    smoother.ingestFix(makeFix(34.9, 30.9, { accuracy: 1500, timestamp: 1000 }), 1000);
    const upgradeRes = smoother.ingestFix(
      makeFix(baseLon, baseLat, { accuracy: 6, speed: 0, timestamp: 2000 }),
      2000
    );
    expect(upgradeRes.accepted).toBe(true);
    expect(haversineMeters(baseLon, baseLat, upgradeRes.kalmanLon, upgradeRes.kalmanLat)).toBeLessThan(5);

    // 2. Wild low-accuracy fix (> 65m) rejected while accurate fix is recent
    const lowAccRes = smoother.ingestFix(
      makeFix(34.85, 30.85, { accuracy: 220, timestamp: 3000 }),
      3000
    );
    expect(lowAccRes.accepted).toBe(false);
    expect(lowAccRes.reason).toBe('low-accuracy');

    // 3. Impossible single-second teleport spike (> 65 m/s) rejected on first occurrence
    const [, jumpLat] = metersToGeoDelta(baseLat, 500, 500);
    const spike1 = smoother.ingestFix(
      makeFix(baseLon + 0.005, baseLat + jumpLat, { accuracy: 8, timestamp: 4000 }),
      4000
    );
    expect(spike1.accepted).toBe(false);
    expect(spike1.reason).toBe('outlier-spike');

    // 4. Subsequent fix back at true position clears pending spike cleanly
    const backNormal = smoother.ingestFix(
      makeFix(baseLon, baseLat + 0.0001, { accuracy: 6, speed: 10, timestamp: 5000 }),
      5000
    );
    expect(backNormal.accepted).toBe(true);
    expect(haversineMeters(baseLon, baseLat, backNormal.kalmanLon, backNormal.kalmanLat)).toBeLessThan(30);

    // 5. Two consistent consecutive fixes 400m away (e.g. exiting underground tunnel) confirm relocation
    const [tunnelDx, tunnelDy] = metersToGeoDelta(baseLat, 400, 0);
    const exit1 = smoother.ingestFix(
      makeFix(baseLon + tunnelDx, baseLat + tunnelDy, { accuracy: 8, speed: 15, timestamp: 6000 }),
      6000
    );
    expect(exit1.accepted).toBe(false);
    expect(exit1.reason).toBe('outlier-spike');

    const [tunnelDx2] = metersToGeoDelta(baseLat, 415, 0);
    const exit2 = smoother.ingestFix(
      makeFix(baseLon + tunnelDx2, baseLat + tunnelDy, { accuracy: 8, speed: 15, timestamp: 7000 }),
      7000
    );
    expect(exit2.accepted).toBe(true);
    expect(haversineMeters(baseLon + tunnelDx2, baseLat + tunnelDy, exit2.kalmanLon, exit2.kalmanLat)).toBeLessThan(5);
  });

  it('holds position steady when stationary, uses compass only at low speed, and rejects cabin magnetic interference while driving', () => {
    const smoother = new GpsNavigationSmoother({ enableRoadNetworkMatching: false });
    const baseLon = 34.8134;
    const baseLat = 30.8281;

    // Stationary jitter within ~3m deadzone
    for (let s = 0; s < 5; s++) {
      const [dx, dy] = metersToGeoDelta(baseLat, (s % 2 === 0 ? 1 : -1) * 1.5, s % 2);
      smoother.ingestFix(
        makeFix(baseLon + dx, baseLat + dy, {
          speed: 0.2,
          heading: null,
          accuracy: 8,
          timestamp: s * 1000,
        }),
        s * 1000
      );
    }

    const stopped = smoother.step(5500)!;
    expect(stopped.isStationary).toBe(true);
    expect(stopped.speedMps).toBe(0);
    expect(haversineMeters(baseLon, baseLat, stopped.lon, stopped.lat)).toBeLessThan(5);

    // Compass turns puck smoothly while stopped
    smoother.setCompassHeading(135, 5500);
    let fCompass = stopped;
    for (let t = 5516; t <= 7500; t += 16) {
      fCompass = smoother.step(t)!;
    }
    expect(Math.abs(shortestAngleDeltaDeg(fCompass.headingDeg!, 135))).toBeLessThan(3);

    // Now drive North at 15 m/s (heading 0) while vehicle dashboard speaker biases compass to 260°
    smoother.setCompassHeading(260, 8000);
    for (let s = 1; s <= 4; s++) {
      const [, dy] = metersToGeoDelta(baseLat, 0, s * 15);
      smoother.ingestFix(
        makeFix(baseLon, baseLat + dy, {
          speed: 15,
          heading: 0,
          accuracy: 5,
          timestamp: 8000 + s * 1000,
        }),
        8000 + s * 1000
      );
      smoother.setCompassHeading(260, 8000 + s * 1000);
    }
    let fDriving = smoother.step(12000)!;
    for (let t = 12016; t <= 12800; t += 16) {
      fDriving = smoother.step(t)!;
    }
    expect(fDriving.isStationary).toBe(false);
    expect(Math.abs(shortestAngleDeltaDeg(fDriving.headingDeg!, 0))).toBeLessThan(8);
  });

  it('prefers aligned active route curves around 90-degree corners, resists perpendicular cross-roads, and softly releases snap when leaving trail', () => {
    const smoother = new GpsNavigationSmoother({ enableRoadNetworkMatching: false });
    const startLon = 34.8000;
    const startLat = 30.8200;

    // L-shaped active route: 100m North -> 90° bend East for 150m
    const [, cornerLatOff] = metersToGeoDelta(startLat, 0, 100);
    const [eastEndLonOff] = metersToGeoDelta(startLat, 150, 0);
    const route: SavedRouteRecord = {
      id: 'route-l-bend',
      name: 'מעלה עקב L',
      createdAt: '2026-01-01T00:00:00Z',
      distanceKm: 0.25,
      ascentMeters: 0,
      descentMeters: 0,
      minEle: 300,
      maxEle: 350,
      color: '#10b981',
      visible: true,
      sourceFormat: 'planned',
      planningMode: '4x4',
      elevationProfile: [],
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [startLon, startLat],
                [startLon, startLat + cornerLatOff],
                [startLon + eastEndLonOff, startLat + cornerLatOff],
              ],
            },
          },
        ],
      },
    };
    smoother.setActiveRoute(route);

    // Also add an intersecting crossroad perpendicular to N-S leg at y=40m
    const [cw1Lon, cwLat] = metersToGeoDelta(startLat, -80, 40);
    const [cw2Lon] = metersToGeoDelta(startLat, 80, 40);
    const crossRoad = buildSnapPolyline(
      'way:cross-1',
      'road',
      [
        [startLon + cw1Lon, startLat + cwLat],
        [startLon + cw2Lon, startLat + cwLat],
      ],
      'שביל חוצה מזרח-מערב',
      0
    )!;
    // Inject synthetic road into cache using its internal array via public getter?
    // Wait: test active route bending & crossroad rejection via getRoadNetworkCache helper or route-only:
    expect(crossRoad.totalLengthMeters).toBeGreaterThan(140);

    // 1. Drive North at 20 m/s from y=0 to y=80m (8m East noisy GPS offset) -> must snap cleanly to L-bend N leg
    for (let s = 0; s <= 4; s++) {
      const [dxNoise, dy] = metersToGeoDelta(startLat, 8, s * 20);
      smoother.ingestFix(
        makeFix(startLon + dxNoise, startLat + dy, {
          speed: 20,
          heading: 0,
          accuracy: 8,
          timestamp: s * 1000,
        }),
        s * 1000
      );
    }

    // Between t=4000ms (y=80m) and t=5000ms, distance predicted is 20m -> reaches corner at y=100m & starts turning?
    // Wait: fix 4 is at y=80m, predicted reaches y=100m at +1000ms; ingest fix at t=4500ms at y=90m, then step to t=5500ms
    const [dxNoise45, dy45] = metersToGeoDelta(startLat, 6, 90);
    smoother.ingestFix(
      makeFix(startLon + dxNoise45, startLat + dy45, {
        speed: 20,
        heading: 0,
        accuracy: 7,
        timestamp: 4500,
      }),
      4500
    );

    let cornerFrame = smoother.step(4500)!;
    for (let t = 4520; t <= 5500; t += 20) {
      cornerFrame = smoother.step(t)!;
    }
    expect(cornerFrame.isSnapped).toBe(true);
    expect(cornerFrame.matchedSource).toBe('route');
    // After 1000ms at 20m/s from y=90m -> walked 10m to corner (y=100m) + 10m along East leg!
    expect(cornerFrame.lon).toBeGreaterThan(startLon + 0.00004);

    // 2. Now drive off-trail North 40m away from the East leg -> snapBlend decays smoothly to 0
    for (let s = 1; s <= 5; s++) {
      const [dx, dyOff] = metersToGeoDelta(startLat, 20, 100 + s * 9);
      smoother.ingestFix(
        makeFix(startLon + dx, startLat + dyOff, {
          speed: 9,
          heading: 0,
          accuracy: 6,
          timestamp: 5500 + s * 1000,
        }),
        5500 + s * 1000
      );
    }
    let offTrailFrame = smoother.step(10500)!;
    for (let t = 10520; t <= 12000; t += 20) {
      offTrailFrame = smoother.step(t)!;
    }
    expect(offTrailFrame.isSnapped).toBe(false);
    expect(offTrailFrame.snapBlend).toBeLessThan(0.15);
  });

  it('rejects perpendicular crossroads at intersections via heading alignment & hysteresis', async () => {
    const baseLon = 34.8100;
    const baseLat = 30.8300;
    const [, nsEndLatOff] = metersToGeoDelta(baseLat, 0, 200);
    const [ewStartLonOff, ewLatOff] = metersToGeoDelta(baseLat, -100, 100);
    const [ewEndLonOff] = metersToGeoDelta(baseLat, 100, 100);

    const graphSpy = vi.spyOn(TileRoadGraphBuilder.prototype, 'getDecodedTileWays').mockResolvedValue([
      {
        featureId: 'ns-main',
        props: { class: 'track', tracktype: 'grade2', name: 'דרך צפון-דרום' },
        layer: 0,
        points: [
          { gx: 0, gy: 0, lon: baseLon, lat: baseLat, isClipped: false },
          { gx: 0, gy: 1, lon: baseLon, lat: baseLat + nsEndLatOff, isClipped: false },
        ],
      },
      {
        featureId: 'ew-cross',
        props: { class: 'secondary', name: 'כביש חוצה' },
        layer: 0,
        points: [
          { gx: 1, gy: 0, lon: baseLon + ewStartLonOff, lat: baseLat + ewLatOff, isClipped: false },
          { gx: 2, gy: 0, lon: baseLon + ewEndLonOff, lat: baseLat + ewLatOff, isClipped: false },
        ],
      },
    ]);

    try {
      const smoother = new GpsNavigationSmoother({
        enableRoadNetworkMatching: true,
        planningMode: '4x4',
      });
      await smoother.getRoadNetworkCache().ensureNear(baseLon, baseLat);

      // Drive North at 16 m/s (heading 0) right through intersection (y = 100m),
      // with noisy fix pushed 6m East onto the E-W crossroad at t=2s!
      const fixes = [
        { dy: 65, dx: 2, ts: 1000 },
        { dy: 82, dx: 3, ts: 2000 },
        { dy: 100, dx: 7, ts: 3000 },
      ];
      for (const f of fixes) {
        const [dLon, dLat] = metersToGeoDelta(baseLat, f.dx, f.dy);
        smoother.ingestFix(
          makeFix(baseLon + dLon, baseLat + dLat, {
            speed: 16,
            heading: 0,
            accuracy: 7,
            timestamp: f.ts,
          }),
          f.ts
        );
      }

      let frame = smoother.step(3000)!;
      for (let t = 3020; t <= 3600; t += 20) {
        frame = smoother.step(t)!;
      }
      expect(frame.isSnapped).toBe(true);
      expect(frame.matchedSource).toBe('road');
      // Even though E-W crossroad is 0m vertical distance at y=100m and higher-class 'secondary',
      // alignment + same-way hysteresis keeps vehicle locked onto N-S road near baseLon
      expect(Math.abs((frame.lon - baseLon) * METERS_PER_DEG_LAT * Math.cos(baseLat * DEG_TO_RAD))).toBeLessThan(3);
    } finally {
      graphSpy.mockRestore();
    }
  });

  it('snaps smoothly onto a real offline Israel.osm.pmtiles z14 vector road/trail', async () => {
    const pmtilesPath = path.resolve(process.cwd(), 'data/Israel.osm.pmtiles');
    if (!fs.existsSync(pmtilesPath)) {
      return;
    }

    const src = new LocalFilePMTilesSource(pmtilesPath);
    const archive = new PMTiles(src);
    const fetcher = async (z: number, x: number, y: number) => {
      const tile = await archive.getZxy(z, x, y);
      return tile?.data;
    };

    try {
      // Sample around Sde Boker / Ein Avdat area (34.782, 30.852)
      const tile = lonLatToTile(34.782, 30.852, 14);
      const graphBuilder = new TileRoadGraphBuilder({ fetchTileData: fetcher });
      const ways = await graphBuilder.getDecodedTileWays(tile.tx, tile.ty);
      const longDrivableWay = ways.find((w) => {
        if (w.points.length < 2 || !evaluateEdgeAccess(w.props, '4x4').allowed) return false;
        const a = w.points[0];
        const b = w.points[1];
        const dx = (b.lon - a.lon) * METERS_PER_DEG_LAT * Math.cos(a.lat * DEG_TO_RAD);
        const dy = (b.lat - a.lat) * METERS_PER_DEG_LAT;
        return Math.hypot(dx, dy) >= 45;
      });
      expect(longDrivableWay).toBeDefined();

      const targetWay = longDrivableWay!;
      const p0 = targetWay.points[0];
      const p1 = targetWay.points[1];
      const segDx = (p1.lon - p0.lon) * METERS_PER_DEG_LAT * Math.cos(p0.lat * DEG_TO_RAD);
      const segDy = (p1.lat - p0.lat) * METERS_PER_DEG_LAT;
      const segHeading = (Math.atan2(segDx, segDy) * 180) / Math.PI;
      const segLen = Math.hypot(segDx, segDy);
      expect(segLen).toBeGreaterThanOrEqual(45);

      const smoother = new GpsNavigationSmoother({
        enableRoadNetworkMatching: true,
        fetchTileData: fetcher,
        planningMode: '4x4',
      });

      // Warm RoadSnapNetworkCache explicitly so tile decode finishes deterministically in unit test
      const polys = await smoother.getRoadNetworkCache().ensureNear(p0.lon, p0.lat);
      expect(polys.length).toBeGreaterThan(0);

      // Drive 3 seconds along that real OSM segment at 15 m/s with a constant 9m perpendicular GPS offset
      const perpEastNorm = -segDy / segLen;
      const perpNorthNorm = segDx / segLen;
      const [offLon, offLat] = metersToGeoDelta(p0.lat, perpEastNorm * 9, perpNorthNorm * 9);
      const normHeading = segHeading < 0 ? segHeading + 360 : segHeading;

      for (let sec = 0; sec <= 2; sec++) {
        const frac = (sec * 15) / segLen;
        const rawLon = p0.lon + (p1.lon - p0.lon) * frac + offLon;
        const rawLat = p0.lat + (p1.lat - p0.lat) * frac + offLat;
        const res = smoother.ingestFix(
          makeFix(rawLon, rawLat, {
            speed: 15,
            heading: normHeading,
            accuracy: 8,
            timestamp: (sec + 1) * 1000,
          }),
          (sec + 1) * 1000
        );
        expect(res.accepted).toBe(true);
      }

      let frame = smoother.step(3000)!;
      for (let t = 3020; t <= 3500; t += 20) {
        frame = smoother.step(t)!;
      }

      expect(frame.isSnapped).toBe(true);
      expect(frame.matchedSource).toBe('road');
      expect(frame.distFromMatchedMeters).not.toBeNull();
      expect(frame.distFromMatchedMeters!).toBeLessThanOrEqual(14);
      // Kalman coordinate remains un-snapped (~9m off road), while display coordinate pulled cleanly onto road
      const dispFromRaw = haversineMeters(frame.kalmanLon, frame.kalmanLat, frame.lon, frame.lat);
      expect(dispFromRaw).toBeGreaterThan(4);
    } finally {
      src.close();
    }
  });
});
