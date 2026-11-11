import type { SavedRouteRecord } from '../db/NavDatabase';
import type { LiveGpsFix } from './LiveGpsService';
import {
  normalizeHeadingDeg,
  shortestAngleDeltaDeg,
} from './NavigationHeadingService';
import { evaluateEdgeAccess, type PlanningMode } from '../routing/RoutingProfiles';
import {
  TileRoadGraphBuilder,
  ROUTING_TILE_ZOOM,
  lonLatToTile,
  type DecodedWay,
  type TileDataFetcher,
} from '../routing/TileRoadGraphBuilder';

const METERS_PER_DEG_LAT = 111194.9;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export interface SmootherOptions {
  maxAcceptedAccuracyMeters?: number;
  maxImpliedSpeedMps?: number;
  stationarySpeedThresholdMps?: number;
  minMovingHeadingSpeedMps?: number;
  fullPredictDurationSec?: number;
  maxPredictDurationSec?: number;
  positionBlendTauSec?: number;
  headingBlendTauSec?: number;
  snapBlendTauSec?: number;
  fullSnapDistanceMeters?: number;
  maxSnapDistanceMeters?: number;
  sameWayHysteresisMeters?: number;
  activeRoutePreferenceMeters?: number;
  planningMode?: PlanningMode;
  enableRoadNetworkMatching?: boolean;
  fetchTileData?: TileDataFetcher;
}

export interface SmoothedNavigationFrame {
  lon: number;
  lat: number;
  rawLon: number;
  rawLat: number;
  kalmanLon: number;
  kalmanLat: number;
  headingDeg: number | null;
  speedMps: number;
  isStationary: boolean;
  isSnapped: boolean;
  snapBlend: number;
  matchedRoadLabel: string | null;
  matchedSource: 'route' | 'road' | null;
  distFromMatchedMeters: number | null;
}

export interface GpsIngestResult {
  accepted: boolean;
  reason?: 'invalid' | 'stale' | 'low-accuracy' | 'outlier-spike';
  kalmanLon: number;
  kalmanLat: number;
  speedMps: number;
  headingDeg: number | null;
}

interface PolylineChunk {
  startIdx: number;
  endIdx: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface SnapPolyline {
  id: string;
  wayKey?: string;
  source: 'route' | 'road';
  coords: Array<[number, number]>;
  cumMeters: Float64Array;
  totalLengthMeters: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  chunks: PolylineChunk[];
  priorityBiasMeters: number;
  roadLabel: string;
  forwardAllowed?: boolean;
  reverseAllowed?: boolean;
}

interface AxisKalmanState {
  p: number;
  v: number;
  p00: number;
  p01: number;
  p11: number;
}

interface CandidateMatch {
  poly: SnapPolyline;
  distMeters: number;
  scoreMeters: number;
  alongMeters: number;
  projLon: number;
  projLat: number;
  segBearingDeg: number;
  orientedBearingDeg: number;
  directionSign: 1 | -1;
  dirAlignErrDeg: number | null;
  clampedAtEnd: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function getDefaultClockMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function metersPerDegLonAt(latDeg: number): number {
  return Math.max(1000, METERS_PER_DEG_LAT * Math.cos(latDeg * DEG_TO_RAD));
}

export function buildSnapPolyline(
  id: string,
  source: 'route' | 'road',
  coords: Array<[number, number]>,
  roadLabel: string,
  priorityBiasMeters: number,
  options?: {
    wayKey?: string;
    forwardAllowed?: boolean;
    reverseAllowed?: boolean;
  }
): SnapPolyline | null {
  if (!coords || coords.length < 2) return null;

  // Deduplicate adjacent identical points
  const clean: Array<[number, number]> = [];
  for (const pt of coords) {
    if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const prev = clean[clean.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) {
      clean.push([pt[0], pt[1]]);
    }
  }
  if (clean.length < 2) return null;

  const cumMeters = new Float64Array(clean.length);
  cumMeters[0] = 0;

  let minLon = clean[0][0];
  let maxLon = clean[0][0];
  let minLat = clean[0][1];
  let maxLat = clean[0][1];

  const refLat = clean[0][1];
  const mLon = metersPerDegLonAt(refLat);

  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1];
    const b = clean[i];
    if (b[0] < minLon) minLon = b[0];
    if (b[0] > maxLon) maxLon = b[0];
    if (b[1] < minLat) minLat = b[1];
    if (b[1] > maxLat) maxLat = b[1];
    const dx = (b[0] - a[0]) * mLon;
    const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
    cumMeters[i] = cumMeters[i - 1] + Math.hypot(dx, dy);
  }

  const totalLengthMeters = cumMeters[clean.length - 1];
  if (totalLengthMeters < 0.5) return null;

  // Build spatial sub-chunks (~32 segments each) so long GPX routes project in O(1)
  const CHUNK_SEGMENTS = 32;
  const chunks: PolylineChunk[] = [];
  const segCount = clean.length - 1;
  for (let start = 0; start < segCount; start += CHUNK_SEGMENTS) {
    const end = Math.min(segCount, start + CHUNK_SEGMENTS);
    let cMinLon = clean[start][0];
    let cMaxLon = clean[start][0];
    let cMinLat = clean[start][1];
    let cMaxLat = clean[start][1];
    for (let k = start + 1; k <= end; k++) {
      const pt = clean[k];
      if (pt[0] < cMinLon) cMinLon = pt[0];
      if (pt[0] > cMaxLon) cMaxLon = pt[0];
      if (pt[1] < cMinLat) cMinLat = pt[1];
      if (pt[1] > cMaxLat) cMaxLat = pt[1];
    }
    chunks.push({
      startIdx: start,
      endIdx: end,
      minLon: cMinLon,
      minLat: cMinLat,
      maxLon: cMaxLon,
      maxLat: cMaxLat,
    });
  }

  return {
    id,
    wayKey: options?.wayKey ?? id,
    source,
    coords: clean,
    cumMeters,
    totalLengthMeters,
    minLon,
    minLat,
    maxLon,
    maxLat,
    chunks,
    priorityBiasMeters,
    roadLabel,
    forwardAllowed: options?.forwardAllowed ?? true,
    reverseAllowed: options?.reverseAllowed ?? true,
  };
}

function projectLonLatOntoPolyline(
  lon: number,
  lat: number,
  poly: SnapPolyline,
  travelHeadingDeg: number | null,
  weightAlignment: boolean,
  mLon: number,
  searchMarginLon: number,
  searchMarginLat: number,
  searchRadiusMeters: number
): CandidateMatch | null {
  if (
    lon < poly.minLon - searchMarginLon ||
    lon > poly.maxLon + searchMarginLon ||
    lat < poly.minLat - searchMarginLat ||
    lat > poly.maxLat + searchMarginLat
  ) {
    return null;
  }

  const fwdOk = poly.forwardAllowed !== false;
  const revOk = poly.reverseAllowed !== false;
  if (!fwdOk && !revOk) {
    return null;
  }

  let bestMetric = Infinity;
  let bestDist = Infinity;
  let bestProjLon = lon;
  let bestProjLat = lat;
  let bestAlong = 0;
  let bestBearing = 0;
  let bestSegIdx = 0;
  let bestRawT = 0;
  let bestDirAlignErr: number | null = null;
  let bestDirSign: 1 | -1 = fwdOk ? 1 : -1;

  for (const chunk of poly.chunks) {
    if (
      lon < chunk.minLon - searchMarginLon ||
      lon > chunk.maxLon + searchMarginLon ||
      lat < chunk.minLat - searchMarginLat ||
      lat > chunk.maxLat + searchMarginLat
    ) {
      continue;
    }

    for (let i = chunk.startIdx; i < chunk.endIdx; i++) {
      const a = poly.coords[i];
      const b = poly.coords[i + 1];
      const abx = (b[0] - a[0]) * mLon;
      const aby = (b[1] - a[1]) * METERS_PER_DEG_LAT;
      const apx = (lon - a[0]) * mLon;
      const apy = (lat - a[1]) * METERS_PER_DEG_LAT;
      const abLenSq = abx * abx + aby * aby;
      if (abLenSq < 1e-6) continue;

      const rawT = (apx * abx + apy * aby) / abLenSq;
      const t = clamp(rawT, 0, 1);
      const projX = t * abx;
      const projY = t * aby;
      const dist = Math.hypot(apx - projX, apy - projY);
      if (dist > searchRadiusMeters) continue;

      const segBearing = normalizeHeadingDeg(Math.atan2(abx, aby) * RAD_TO_DEG);
      let segAlignErr: number | null = null;
      let segDirSign: 1 | -1 = fwdOk ? 1 : -1;
      let alignPenalty = 0;

      if (travelHeadingDeg !== null) {
        const fwdErr = fwdOk
          ? Math.abs(shortestAngleDeltaDeg(travelHeadingDeg, segBearing))
          : Infinity;
        const revErr = revOk
          ? Math.abs(shortestAngleDeltaDeg(travelHeadingDeg, normalizeHeadingDeg(segBearing + 180)))
          : Infinity;
        if (fwdErr <= revErr) {
          segAlignErr = fwdErr;
          segDirSign = 1;
        } else {
          segAlignErr = revErr;
          segDirSign = -1;
        }
        if (weightAlignment) {
          alignPenalty = Number.isFinite(segAlignErr) ? (segAlignErr / 45) * 14 : 80;
        }
      }

      const metric = dist + alignPenalty;
      if (metric < bestMetric) {
        bestMetric = metric;
        bestDist = dist;
        bestProjLon = a[0] + t * (b[0] - a[0]);
        bestProjLat = a[1] + t * (b[1] - a[1]);
        const segLen = poly.cumMeters[i + 1] - poly.cumMeters[i];
        bestAlong = poly.cumMeters[i] + t * segLen;
        bestBearing = segBearing;
        bestSegIdx = i;
        bestRawT = rawT;
        bestDirAlignErr = segAlignErr;
        bestDirSign = segDirSign;
      }
    }
  }

  if (!Number.isFinite(bestDist)) return null;

  const orientedBearingDeg =
    bestDirSign === 1 ? bestBearing : normalizeHeadingDeg(bestBearing + 180);
  const lastSegIdx = poly.coords.length - 2;
  const clampedAtEnd =
    travelHeadingDeg !== null &&
    ((bestDirSign === 1 && bestSegIdx === lastSegIdx && bestRawT >= 0.999) ||
      (bestDirSign === -1 && bestSegIdx === 0 && bestRawT <= 0.001));

  return {
    poly,
    distMeters: bestDist,
    scoreMeters: bestDist,
    alongMeters: bestAlong,
    projLon: bestProjLon,
    projLat: bestProjLat,
    segBearingDeg: bestBearing,
    orientedBearingDeg,
    directionSign: bestDirSign,
    dirAlignErrDeg: bestDirAlignErr,
    clampedAtEnd,
  };
}

function samplePolylineAtAlong(
  poly: SnapPolyline,
  alongMeters: number,
  directionSign: 1 | -1,
  mLon: number
): { lon: number; lat: number; bearingDeg: number } {
  const clampedAlong = clamp(alongMeters, 0, poly.totalLengthMeters);
  const cum = poly.cumMeters;
  const n = poly.coords.length;

  // Binary search segment containing clampedAlong
  let lo = 0;
  let hi = n - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= clampedAlong) lo = mid;
    else hi = mid - 1;
  }

  const segStart = cum[lo];
  const segEnd = cum[lo + 1];
  const segLen = segEnd - segStart;
  const t = segLen > 1e-6 ? clamp((clampedAlong - segStart) / segLen, 0, 1) : 0;

  const a = poly.coords[lo];
  const b = poly.coords[lo + 1];
  const lon = a[0] + t * (b[0] - a[0]);
  const lat = a[1] + t * (b[1] - a[1]);

  const dx = (b[0] - a[0]) * mLon;
  const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
  const baseBearing = Math.hypot(dx, dy) > 1e-4 ? normalizeHeadingDeg(Math.atan2(dx, dy) * RAD_TO_DEG) : 0;
  const bearingDeg = directionSign === 1 ? baseBearing : normalizeHeadingDeg(baseBearing + 180);

  return { lon, lat, bearingDeg };
}

function createInitialAxis(p: number, v = 0, sigmaPos = 10): AxisKalmanState {
  return {
    p,
    v,
    p00: sigmaPos * sigmaPos,
    p01: 0,
    p11: 25,
  };
}

function predictAxis(state: AxisKalmanState, dtSec: number, sigmaAccel = 3.2): void {
  if (dtSec <= 0) return;
  const dt = Math.min(dtSec, 6);
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt2 * dt2;
  const qAccel = sigmaAccel * sigmaAccel;

  const q00 = 0.25 * dt4 * qAccel;
  const q01 = 0.5 * dt3 * qAccel;
  const q11 = dt2 * qAccel;

  state.p = state.p + state.v * dt;

  const nextP00 = state.p00 + 2 * dt * state.p01 + dt2 * state.p11 + q00;
  const nextP01 = state.p01 + dt * state.p11 + q01;
  const nextP11 = state.p11 + q11;

  state.p00 = nextP00;
  state.p01 = nextP01;
  state.p11 = nextP11;
}

function updateAxisPosition(state: AxisKalmanState, zPos: number, rPos: number): void {
  const innovation = zPos - state.p;
  const s = state.p00 + rPos;
  if (s <= 1e-9) return;
  const k0 = state.p00 / s;
  const k1 = state.p01 / s;

  state.p += k0 * innovation;
  state.v += k1 * innovation;

  const p00 = state.p00;
  const p01 = state.p01;
  state.p00 = Math.max(0.1, (1 - k0) * p00);
  state.p01 = (1 - k0) * p01;
  state.p11 = Math.max(0.05, state.p11 - k1 * p01);
}

function updateAxisVelocity(state: AxisKalmanState, zVel: number, rVel: number): void {
  const innovation = zVel - state.v;
  const s = state.p11 + rVel;
  if (s <= 1e-9) return;
  const k0 = state.p01 / s;
  const k1 = state.p11 / s;

  state.p += k0 * innovation;
  state.v += k1 * innovation;

  const p01 = state.p01;
  const p11 = state.p11;
  state.p00 = Math.max(0.1, state.p00 - k0 * p01);
  state.p01 = (1 - k1) * p01;
  state.p11 = Math.max(0.05, (1 - k1) * p11);
}

function integrateDecayFactor(
  timeSinceFixSec: number,
  fullPredictSec: number,
  maxPredictSec: number
): { effDtSec: number; decayFactor: number } {
  if (timeSinceFixSec <= 0) {
    return { effDtSec: 0, decayFactor: 1 };
  }
  if (timeSinceFixSec <= fullPredictSec) {
    return { effDtSec: timeSinceFixSec, decayFactor: 1 };
  }
  const taperSpan = Math.max(0.05, maxPredictSec - fullPredictSec);
  if (timeSinceFixSec >= maxPredictSec) {
    return {
      effDtSec: fullPredictSec + 0.5 * taperSpan,
      decayFactor: 0,
    };
  }
  const u = timeSinceFixSec - fullPredictSec;
  const decayFactor = 1 - u / taperSpan;
  const effDtSec = fullPredictSec + u - (u * u) / (2 * taperSpan);
  return { effDtSec, decayFactor };
}

const GRID_LON_DEG = 0.0012; // ~110m at Israel latitude
const GRID_LAT_DEG = 0.0011; // ~122m
const EMPTY_POLYS: SnapPolyline[] = [];

/**
 * Loads decoded vector tile ways around the current GPS coordinate asynchronously
 * and exposes spatially-indexed SnapPolylines for synchronous 60fps map-matching.
 */
export class RoadSnapNetworkCache {
  private graphBuilder: TileRoadGraphBuilder;
  private activeTileKey = '';
  private cachedPolylines: SnapPolyline[] = [];
  private gridCells = new Map<string, SnapPolyline[]>();
  private widePolylines: SnapPolyline[] = [];
  private loadingTileKey = '';
  private mode: PlanningMode = '4x4';

  constructor(options?: { fetchTileData?: TileDataFetcher; mode?: PlanningMode }) {
    this.graphBuilder = new TileRoadGraphBuilder({
      maxCachedTiles: 48,
      fetchTileData: options?.fetchTileData,
    });
    if (options?.mode) {
      this.mode = options.mode;
    }
  }

  setMode(mode: PlanningMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.activeTileKey = '';
      this.cachedPolylines = [];
      this.gridCells.clear();
      this.widePolylines = [];
    }
  }

  clear(): void {
    this.activeTileKey = '';
    this.loadingTileKey = '';
    this.cachedPolylines = [];
    this.gridCells.clear();
    this.widePolylines = [];
    this.graphBuilder.clearCache();
  }

  getPolylines(): SnapPolyline[] {
    return this.cachedPolylines;
  }

  getPolylinesNear(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number
  ): SnapPolyline[] {
    if (this.gridCells.size === 0 && this.widePolylines.length === 0) {
      return this.cachedPolylines;
    }
    const minCx = Math.floor(minLon / GRID_LON_DEG);
    const maxCx = Math.floor(maxLon / GRID_LON_DEG);
    const minCy = Math.floor(minLat / GRID_LAT_DEG);
    const maxCy = Math.floor(maxLat / GRID_LAT_DEG);

    if (minCx === maxCx && minCy === maxCy && this.widePolylines.length === 0) {
      return this.gridCells.get(`${minCx},${minCy}`) ?? EMPTY_POLYS;
    }
    if ((maxCx - minCx + 1) * (maxCy - minCy + 1) > 25) {
      return this.cachedPolylines;
    }

    const seen = new Set<SnapPolyline>();
    const out: SnapPolyline[] = [];
    for (let i = 0; i < this.widePolylines.length; i++) {
      const p = this.widePolylines[i];
      seen.add(p);
      out.push(p);
    }
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.gridCells.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const p = bucket[i];
          if (!seen.has(p)) {
            seen.add(p);
            out.push(p);
          }
        }
      }
    }
    return out;
  }

  private rebuildSpatialGrid(polys: SnapPolyline[]): void {
    const nextGrid = new Map<string, SnapPolyline[]>();
    const nextWide: SnapPolyline[] = [];
    for (let i = 0; i < polys.length; i++) {
      const poly = polys[i];
      const minCx = Math.floor(poly.minLon / GRID_LON_DEG);
      const maxCx = Math.floor(poly.maxLon / GRID_LON_DEG);
      const minCy = Math.floor(poly.minLat / GRID_LAT_DEG);
      const maxCy = Math.floor(poly.maxLat / GRID_LAT_DEG);
      if ((maxCx - minCx + 1) * (maxCy - minCy + 1) > 64) {
        nextWide.push(poly);
        continue;
      }
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const cellKey = `${cx},${cy}`;
          let bucket = nextGrid.get(cellKey);
          if (!bucket) {
            bucket = [];
            nextGrid.set(cellKey, bucket);
          }
          bucket.push(poly);
        }
      }
    }
    this.gridCells = nextGrid;
    this.widePolylines = nextWide;
  }

  /**
   * Ensures road/trail polylines for the z14 tile containing (lon, lat) — plus adjacent border
   * tiles and speed-based ahead lookahead tile — are decoded and spatially indexed for map-matching.
   */
  async ensureNear(
    lon: number,
    lat: number,
    speedMps = 0,
    headingDeg: number | null = null
  ): Promise<SnapPolyline[]> {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return this.cachedPolylines;

    const center = lonLatToTile(lon, lat, ROUTING_TILE_ZOOM);
    const n = 1 << ROUTING_TILE_ZOOM;
    const xFrac = ((lon + 180) / 360) * n - center.tx;
    const latRad = lat * DEG_TO_RAD;
    const yFrac =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - center.ty;

    const borderFrac = 0.14; // ~300m at Israel latitude
    const dxList = [0];
    const dyList = [0];
    if (xFrac < borderFrac && center.tx > 0) dxList.push(-1);
    if (xFrac > 1 - borderFrac && center.tx < n - 1) dxList.push(1);
    if (yFrac < borderFrac && center.ty > 0) dyList.push(-1);
    if (yFrac > 1 - borderFrac && center.ty < n - 1) dyList.push(1);

    const tileCoords: Array<{ tx: number; ty: number }> = [];
    const seenTiles = new Set<string>();
    const addTile = (tx: number, ty: number) => {
      const tk = `${tx},${ty}`;
      if (!seenTiles.has(tk)) {
        seenTiles.add(tk);
        tileCoords.push({ tx, ty });
      }
    };

    for (const dx of dxList) {
      for (const dy of dyList) {
        addTile(center.tx + dx, center.ty + dy);
      }
    }

    if (speedMps >= 10 && headingDeg !== null && Number.isFinite(headingDeg)) {
      const lookaheadMeters = clamp(speedMps * 12, 200, 550);
      const mLon = metersPerDegLonAt(lat);
      const rad = headingDeg * DEG_TO_RAD;
      const aheadLon = lon + (lookaheadMeters * Math.sin(rad)) / mLon;
      const aheadLat = lat + (lookaheadMeters * Math.cos(rad)) / METERS_PER_DEG_LAT;
      const aheadTile = lonLatToTile(aheadLon, aheadLat, ROUTING_TILE_ZOOM);
      addTile(aheadTile.tx, aheadTile.ty);
    }

    const key =
      `${this.mode}:` +
      tileCoords
        .map((t) => `${t.tx},${t.ty}`)
        .sort()
        .join('|');

    if (key === this.activeTileKey || key === this.loadingTileKey) {
      return this.cachedPolylines;
    }

    this.loadingTileKey = key;
    try {
      const waysArrays = await Promise.all(
        tileCoords.map((t) => this.graphBuilder.getDecodedTileWays(t.tx, t.ty))
      );
      if (this.loadingTileKey !== key) {
        return this.cachedPolylines;
      }

      const nextPolys: SnapPolyline[] = [];
      for (let tileIdx = 0; tileIdx < waysArrays.length; tileIdx++) {
        const tc = tileCoords[tileIdx];
        const ways = waysArrays[tileIdx];
        for (let seq = 0; seq < ways.length; seq++) {
          const poly = this.wayToSnapPolyline(ways[seq], tc.tx, tc.ty, seq);
          if (poly) nextPolys.push(poly);
        }
      }

      this.activeTileKey = key;
      this.cachedPolylines = nextPolys;
      this.rebuildSpatialGrid(nextPolys);
      return this.cachedPolylines;
    } catch {
      return this.cachedPolylines;
    } finally {
      if (this.loadingTileKey === key) {
        this.loadingTileKey = '';
      }
    }
  }

  private wayToSnapPolyline(
    way: DecodedWay,
    tx: number,
    ty: number,
    seq: number
  ): SnapPolyline | null {
    if (!way.points || way.points.length < 2) return null;
    const access = evaluateEdgeAccess(way.props, this.mode);
    const cls = typeof way.props.class === 'string' ? way.props.class.trim().toLowerCase() : '';
    const subclass =
      typeof way.props.subclass === 'string' ? way.props.subclass.trim().toLowerCase() : '';

    let biasMeters = 0;
    let forwardAllowed = access.forwardAllowed;
    let reverseAllowed = access.reverseAllowed;

    if (access.allowed) {
      biasMeters = cls === 'path' ? 4 : 0;
    } else if (
      this.mode === '4x4' &&
      cls === 'path' &&
      subclass !== 'footway' &&
      subclass !== 'steps' &&
      subclass !== 'pedestrian' &&
      subclass !== 'platform'
    ) {
      // Allow rough off-road trails/paths during free-driving, but prefer adjacent drivable tracks/roads
      biasMeters = 5;
      forwardAllowed = true;
      reverseAllowed = true;
    } else {
      return null;
    }

    const coords = way.points.map((pt) => [pt.lon, pt.lat] as [number, number]);
    const roadLabel = access.roadLabel || (cls === 'path' ? 'שביל שטח' : 'דרך');
    const uniqueId = `way:${tx},${ty}:${seq}:${way.featureId}`;
    const wayKey = way.featureId ? `fid:${way.featureId}` : uniqueId;
    return buildSnapPolyline(uniqueId, 'road', coords, roadLabel, biasMeters, {
      wayKey,
      forwardAllowed,
      reverseAllowed,
    });
  }
}

export class GpsNavigationSmoother {
  private opts: Required<Omit<SmootherOptions, 'fetchTileData'>>;
  private roadNetwork: RoadSnapNetworkCache;

  // Local tangent plane origin
  private hasOrigin = false;
  private originLon = 0;
  private originLat = 0;
  private metersPerDegLon = METERS_PER_DEG_LAT;

  // Kalman state anchored at lastFixClockMs
  private axisX: AxisKalmanState | null = null;
  private axisY: AxisKalmanState | null = null;
  private lastFixClockMs = 0;
  private lastFixTimestamp = -Infinity;
  private lastFixAccuracy: number | null = null;
  private lastFixRawHeading: number | null = null;
  private lastFixRawSpeed: number | null = null;
  private lastRawLon = 0;
  private lastRawLat = 0;

  // Outlier confirmation state
  private pendingSpike: { fix: LiveGpsFix; clockMs: number } | null = null;

  // Stationary deadzone anchor
  private stationaryAnchorX = 0;
  private stationaryAnchorY = 0;
  private isStationary = false;

  // External heading context
  private compassHeading: number | null = null;
  private compassUpdatedAtMs = 0;
  private routeFallbackHeading: number | null = null;

  // Active route snap polylines
  private routePolylines: SnapPolyline[] = [];

  // Map-matching & smooth display state
  private matchedPolyRef: SnapPolyline | null = null;
  private matchedWayKey: string | null = null;
  private anchorPolyRef: SnapPolyline | null = null;
  private anchorAlongMeters = 0;
  private anchorInitEffDtSec = 0;
  private anchorDirectionSign: 1 | -1 = 1;
  private snapBlend = 0;

  private hasDisplayInit = false;
  private dispX = 0;
  private dispY = 0;
  private dispHeadingDeg: number | null = null;
  private hasStepClock = false;
  private lastStepClockMs = 0;
  private lastConvergenceGapMeters = 0;
  private lastHeadingErrorDeg = 0;
  private latestFrame: SmoothedNavigationFrame | null = null;

  constructor(options?: SmootherOptions) {
    this.opts = {
      maxAcceptedAccuracyMeters: options?.maxAcceptedAccuracyMeters ?? 65,
      maxImpliedSpeedMps: options?.maxImpliedSpeedMps ?? 65,
      stationarySpeedThresholdMps: options?.stationarySpeedThresholdMps ?? 0.7,
      minMovingHeadingSpeedMps: options?.minMovingHeadingSpeedMps ?? 1.3,
      fullPredictDurationSec: options?.fullPredictDurationSec ?? 1.4,
      maxPredictDurationSec: options?.maxPredictDurationSec ?? 2.8,
      positionBlendTauSec: options?.positionBlendTauSec ?? 0.26,
      headingBlendTauSec: options?.headingBlendTauSec ?? 0.16,
      snapBlendTauSec: options?.snapBlendTauSec ?? 0.35,
      fullSnapDistanceMeters: options?.fullSnapDistanceMeters ?? 14,
      maxSnapDistanceMeters: options?.maxSnapDistanceMeters ?? 32,
      sameWayHysteresisMeters: options?.sameWayHysteresisMeters ?? 12,
      activeRoutePreferenceMeters: options?.activeRoutePreferenceMeters ?? 5,
      planningMode: options?.planningMode ?? '4x4',
      enableRoadNetworkMatching: options?.enableRoadNetworkMatching ?? true,
    };

    this.roadNetwork = new RoadSnapNetworkCache({
      fetchTileData: options?.fetchTileData,
      mode: this.opts.planningMode,
    });
  }

  reset(): void {
    this.hasOrigin = false;
    this.axisX = null;
    this.axisY = null;
    this.lastFixClockMs = 0;
    this.lastFixTimestamp = -Infinity;
    this.lastFixAccuracy = null;
    this.lastFixRawHeading = null;
    this.lastFixRawSpeed = null;
    this.pendingSpike = null;
    this.isStationary = false;
    this.matchedPolyRef = null;
    this.matchedWayKey = null;
    this.anchorPolyRef = null;
    this.anchorInitEffDtSec = 0;
    this.snapBlend = 0;
    this.hasDisplayInit = false;
    this.dispHeadingDeg = null;
    this.hasStepClock = false;
    this.lastStepClockMs = 0;
    this.lastConvergenceGapMeters = 0;
    this.lastHeadingErrorDeg = 0;
    this.latestFrame = null;
  }

  clearRoadNetworkCache(): void {
    this.roadNetwork.clear();
  }

  setPlanningMode(mode: PlanningMode): void {
    this.opts.planningMode = mode;
    this.roadNetwork.setMode(mode);
  }

  setActiveRoute(route: SavedRouteRecord | null): void {
    if (!route?.geojson?.features) {
      this.routePolylines = [];
      this.routeFallbackHeading = null;
      return;
    }

    const nextPolys: SnapPolyline[] = [];
    let fIdx = 0;
    for (const feature of route.geojson.features) {
      if (feature.geometry?.type === 'LineString') {
        const coords = feature.geometry.coordinates as Array<[number, number]>;
        const poly = buildSnapPolyline(
          `route:${route.id}:${fIdx}`,
          'route',
          coords,
          route.name || 'מסלול ניווט',
          -this.opts.activeRoutePreferenceMeters
        );
        if (poly) nextPolys.push(poly);
        fIdx++;
      } else if (feature.geometry?.type === 'MultiLineString') {
        const parts = feature.geometry.coordinates as Array<Array<[number, number]>>;
        for (const part of parts) {
          const poly = buildSnapPolyline(
            `route:${route.id}:${fIdx}`,
            'route',
            part,
            route.name || 'מסלול ניווט',
            -this.opts.activeRoutePreferenceMeters
          );
          if (poly) nextPolys.push(poly);
          fIdx++;
        }
      }
    }
    this.routePolylines = nextPolys;
    if (route.planningMode) {
      this.setPlanningMode(route.planningMode);
    }
  }

  setRouteFallbackHeading(headingDeg: number | null): void {
    this.routeFallbackHeading =
      typeof headingDeg === 'number' && Number.isFinite(headingDeg)
        ? normalizeHeadingDeg(headingDeg)
        : null;
  }

  setCompassHeading(headingDeg: number | null, nowMs = getDefaultClockMs()): void {
    if (typeof headingDeg === 'number' && Number.isFinite(headingDeg)) {
      this.compassHeading = normalizeHeadingDeg(headingDeg);
      this.compassUpdatedAtMs = nowMs;
    } else {
      this.compassHeading = null;
    }
  }

  /**
   * Inject synthetic road polylines directly (useful for testing without tile archives).
   */
  getRoadNetworkCache(): RoadSnapNetworkCache {
    return this.roadNetwork;
  }

  private toLocal(lon: number, lat: number): [number, number] {
    return [
      (lon - this.originLon) * this.metersPerDegLon,
      (lat - this.originLat) * METERS_PER_DEG_LAT,
    ];
  }

  private toGeo(x: number, y: number): [number, number] {
    return [
      this.originLon + x / this.metersPerDegLon,
      this.originLat + y / METERS_PER_DEG_LAT,
    ];
  }

  private initializeOrigin(
    lon: number,
    lat: number,
    fixClockMs: number,
    stepClockMs: number,
    fix: LiveGpsFix
  ): void {
    this.hasOrigin = true;
    this.originLon = lon;
    this.originLat = lat;
    this.metersPerDegLon = metersPerDegLonAt(lat);

    const sigmaPos = clamp((fix.accuracy ?? 10) * 0.72, 3.5, 28);
    const speed =
      fix.speed !== null && fix.speed >= this.opts.stationarySpeedThresholdMps ? fix.speed : 0;
    const vx =
      speed > 0 && fix.heading !== null ? speed * Math.sin(fix.heading * DEG_TO_RAD) : 0;
    const vy =
      speed > 0 && fix.heading !== null ? speed * Math.cos(fix.heading * DEG_TO_RAD) : 0;

    this.axisX = createInitialAxis(0, vx, sigmaPos);
    this.axisY = createInitialAxis(0, vy, sigmaPos);
    this.stationaryAnchorX = 0;
    this.stationaryAnchorY = 0;
    this.isStationary = speed === 0;
    this.lastFixClockMs = fixClockMs;
    this.lastFixTimestamp = fix.timestamp;
    this.lastFixAccuracy = fix.accuracy;
    this.lastFixRawHeading = fix.heading;
    this.lastFixRawSpeed = fix.speed;
    this.lastRawLon = lon;
    this.lastRawLat = lat;
    this.pendingSpike = null;
    this.matchedPolyRef = null;
    this.matchedWayKey = null;
    this.anchorPolyRef = null;
    this.anchorInitEffDtSec = 0;
    this.snapBlend = 0;
    this.hasDisplayInit = false;
    this.hasStepClock = true;
    this.lastStepClockMs = stepClockMs;
  }

  /**
   * Ingests a raw GPS fix, applies accuracy/outlier gating, updates the 2D Kalman filter,
   * and triggers non-blocking tile prefetch for road/trail map-matching.
   */
  ingestFix(fix: LiveGpsFix, nowMs = getDefaultClockMs()): GpsIngestResult {
    const lon = Number(fix?.lon);
    const lat = Number(fix?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      const fallback = this.getKalmanGeo();
      return {
        accepted: false,
        reason: 'invalid',
        kalmanLon: fallback[0],
        kalmanLat: fallback[1],
        speedMps: this.getKalmanSpeedMps(),
        headingDeg: this.dispHeadingDeg,
      };
    }

    const boundedFixAgeMs =
      typeof fix.fixAgeMs === 'number' && Number.isFinite(fix.fixAgeMs) && fix.fixAgeMs >= 0
        ? clamp(fix.fixAgeMs, 0, 1500)
        : 0;
    const effFixClockMs = nowMs - boundedFixAgeMs;

    const prefetchHeading =
      fix.heading ??
      (this.axisX && this.axisY && this.getKalmanSpeedMps() >= this.opts.minMovingHeadingSpeedMps
        ? normalizeHeadingDeg(Math.atan2(this.axisX.v, this.axisY.v) * RAD_TO_DEG)
        : this.dispHeadingDeg);
    const prefetchSpeed = Math.max(fix.speed ?? 0, this.getKalmanSpeedMps());

    if (this.opts.enableRoadNetworkMatching) {
      void this.roadNetwork.ensureNear(lon, lat, prefetchSpeed, prefetchHeading);
    }

    // First valid fix always seeds immediately
    if (!this.hasOrigin || !this.axisX || !this.axisY) {
      this.initializeOrigin(lon, lat, effFixClockMs, nowMs, fix);
      const frame = this.step(nowMs);
      return {
        accepted: true,
        kalmanLon: lon,
        kalmanLat: lat,
        speedMps: frame?.speedMps ?? 0,
        headingDeg: frame?.headingDeg ?? fix.heading,
      };
    }

    // Check stale or duplicate timestamps
    const tsDeltaMs = fix.timestamp - this.lastFixTimestamp;
    const clockDeltaMs = nowMs - this.lastFixClockMs;
    if (tsDeltaMs < -500 && clockDeltaMs < 5000) {
      const kGeo = this.getKalmanGeo();
      return {
        accepted: false,
        reason: 'stale',
        kalmanLon: kGeo[0],
        kalmanLat: kGeo[1],
        speedMps: this.getKalmanSpeedMps(),
        headingDeg: this.dispHeadingDeg,
      };
    }

    const [measX, measY] = this.toLocal(lon, lat);
    const effClockDeltaMs = Math.max(0, effFixClockMs - this.lastFixClockMs);
    // Prefer true GNSS timestamp deltas (20ms..60s) so bursted / GC-delayed deliveries are
    // never misclassified as teleport spikes or under-predicted in Kalman.
    const rawDtMs =
      tsDeltaMs >= 20 && tsDeltaMs <= 60000 ? tsDeltaMs : effClockDeltaMs;
    const fixAgeGapSec = Math.max(0.05, rawDtMs / 1000);
    const timeSinceGoodFixSec = Math.max(0, effClockDeltaMs / 1000);

    // Replace indoor coarse seed cleanly when an accurate primary GPS fix arrives
    const prevWasCoarse = this.lastFixAccuracy !== null && this.lastFixAccuracy > 60;
    const curIsAccurate = fix.accuracy !== null && fix.accuracy <= 50;
    if (prevWasCoarse && curIsAccurate) {
      this.hasDisplayInit = false;
      this.initializeOrigin(lon, lat, effFixClockMs, nowMs, fix);
      const frame = this.step(nowMs);
      return {
        accepted: true,
        kalmanLon: lon,
        kalmanLat: lat,
        speedMps: frame?.speedMps ?? 0,
        headingDeg: frame?.headingDeg ?? fix.heading,
      };
    }

    // Reject wild accuracy degradation while a recent accurate fix exists
    if (
      fix.accuracy !== null &&
      fix.accuracy > this.opts.maxAcceptedAccuracyMeters &&
      timeSinceGoodFixSec < 12
    ) {
      const kGeo = this.getKalmanGeo();
      return {
        accepted: false,
        reason: 'low-accuracy',
        kalmanLon: kGeo[0],
        kalmanLat: kGeo[1],
        speedMps: this.getKalmanSpeedMps(),
        headingDeg: this.dispHeadingDeg,
      };
    }

    // Jump / teleportation spike check with 2-fix confirmation
    const distFromKalman = Math.hypot(measX - this.axisX.p, measY - this.axisY.p);
    if (distFromKalman > 200000) {
      // > 200 km jump: confirm or re-anchor
      if (
        this.pendingSpike &&
        Math.hypot(lon - this.pendingSpike.fix.lon, lat - this.pendingSpike.fix.lat) < 0.01
      ) {
        this.hasDisplayInit = false;
        this.initializeOrigin(lon, lat, effFixClockMs, nowMs, fix);
        const frame = this.step(nowMs);
        return {
          accepted: true,
          kalmanLon: lon,
          kalmanLat: lat,
          speedMps: frame?.speedMps ?? 0,
          headingDeg: frame?.headingDeg ?? fix.heading,
        };
      }
      this.pendingSpike = { fix, clockMs: nowMs };
      const kGeo = this.getKalmanGeo();
      return {
        accepted: false,
        reason: 'outlier-spike',
        kalmanLon: kGeo[0],
        kalmanLat: kGeo[1],
        speedMps: this.getKalmanSpeedMps(),
        headingDeg: this.dispHeadingDeg,
      };
    }

    const impliedSpeed = distFromKalman / fixAgeGapSec;
    if (
      distFromKalman > 100 &&
      impliedSpeed > this.opts.maxImpliedSpeedMps &&
      timeSinceGoodFixSec < 10
    ) {
      if (this.pendingSpike) {
        const [psx, psy] = this.toLocal(this.pendingSpike.fix.lon, this.pendingSpike.fix.lat);
        const pendingTsGap = (fix.timestamp - this.pendingSpike.fix.timestamp) / 1000;
        const confirmDt =
          pendingTsGap >= 0.05 && pendingTsGap <= 60
            ? pendingTsGap
            : Math.max(0.1, (nowMs - this.pendingSpike.clockMs) / 1000);
        const confirmSpeed = Math.hypot(measX - psx, measY - psy) / confirmDt;
        if (confirmSpeed <= this.opts.maxImpliedSpeedMps) {
          // Two consistent fixes confirmed real relocation (e.g. tunnel exit)
          this.pendingSpike = null;
          const sigmaInit = clamp((fix.accuracy ?? 10) * 0.72, 3.5, 28);
          this.axisX = createInitialAxis(measX, 0, sigmaInit);
          this.axisY = createInitialAxis(measY, 0, sigmaInit);
          this.stationaryAnchorX = measX;
          this.stationaryAnchorY = measY;
          this.lastFixClockMs = Math.max(this.lastFixClockMs, effFixClockMs);
          this.lastFixTimestamp = fix.timestamp;
          this.lastFixAccuracy = fix.accuracy;
          this.lastFixRawHeading = fix.heading;
          this.lastFixRawSpeed = fix.speed;
          this.lastRawLon = lon;
          this.lastRawLat = lat;
          this.anchorPolyRef = null;
          const frame = this.step(nowMs);
          return {
            accepted: true,
            kalmanLon: lon,
            kalmanLat: lat,
            speedMps: frame?.speedMps ?? 0,
            headingDeg: frame?.headingDeg ?? fix.heading,
          };
        }
      }
      this.pendingSpike = { fix, clockMs: nowMs };
      const kGeo = this.getKalmanGeo();
      return {
        accepted: false,
        reason: 'outlier-spike',
        kalmanLon: kGeo[0],
        kalmanLat: kGeo[1],
        speedMps: this.getKalmanSpeedMps(),
        headingDeg: this.dispHeadingDeg,
      };
    }
    this.pendingSpike = null;

    // Derive fallback velocity/heading from accurate consecutive fixes when browser/device omits them
    const [prevRawX, prevRawY] = this.toLocal(this.lastRawLon, this.lastRawLat);
    const rawDx = measX - prevRawX;
    const rawDy = measY - prevRawY;
    const rawStepDist = Math.hypot(rawDx, rawDy);

    let effSpeed = fix.speed;
    let effHeading = fix.heading;
    let usingDerivedVel = false;

    const derivDtSec = rawDtMs / 1000;
    const bothAccurate =
      (fix.accuracy ?? 10) <= 25 && (this.lastFixAccuracy ?? 10) <= 25;
    const minMoveDist = Math.max(
      4.5,
      ((fix.accuracy ?? 8) + (this.lastFixAccuracy ?? 8)) * 0.4
    );
    if (
      (effSpeed === null || effHeading === null) &&
      bothAccurate &&
      derivDtSec >= 0.35 &&
      derivDtSec <= 6.0 &&
      rawStepDist >= minMoveDist
    ) {
      const derivedSpeed = rawStepDist / derivDtSec;
      if (derivedSpeed <= this.opts.maxImpliedSpeedMps) {
        const derivedHeading = normalizeHeadingDeg(Math.atan2(rawDx, rawDy) * RAD_TO_DEG);
        if (effSpeed === null) {
          effSpeed = derivedSpeed;
          usingDerivedVel = true;
        }
        if (effHeading === null) {
          effHeading = derivedHeading;
          usingDerivedVel = true;
        }
      }
    }

    // Stationary deadzone check to prevent drift/spiderwebs while stopped
    const distFromAnchor = Math.hypot(measX - this.stationaryAnchorX, measY - this.stationaryAnchorY);
    const deadzoneRadius = clamp((fix.accuracy ?? 8) * 0.85, 5, 14);
    const reportedStationary =
      effSpeed !== null && effSpeed < this.opts.stationarySpeedThresholdMps;

    const dtSec = clamp(rawDtMs / 1000, 0.02, 10);

    // If resuming after a long GPS dropout (> 6s), reset covariance so fresh fix pulls fast
    if (dtSec > 6) {
      this.axisX.p00 = Math.max(this.axisX.p00, 100);
      this.axisX.p11 = Math.max(this.axisX.p11, 25);
      this.axisY.p00 = Math.max(this.axisY.p00, 100);
      this.axisY.p11 = Math.max(this.axisY.p11, 25);
    }

    // 1. Predict Kalman state from last fix time to current fix time
    predictAxis(this.axisX, dtSec);
    predictAxis(this.axisY, dtSec);

    if (reportedStationary && distFromAnchor < deadzoneRadius) {
      this.isStationary = true;
      // Gently anchor position and bleed velocity to 0
      updateAxisPosition(this.axisX, this.stationaryAnchorX, 25);
      updateAxisPosition(this.axisY, this.stationaryAnchorY, 25);
      updateAxisVelocity(this.axisX, 0, 0.5);
      updateAxisVelocity(this.axisY, 0, 0.5);
    } else {
      this.isStationary = false;
      this.stationaryAnchorX = measX;
      this.stationaryAnchorY = measY;

      const sigmaPos = clamp((fix.accuracy ?? 10) * 0.72, 3.5, 28);
      const rPos = sigmaPos * sigmaPos;
      updateAxisPosition(this.axisX, measX, rPos);
      updateAxisPosition(this.axisY, measY, rPos);

      if (effSpeed !== null) {
        if (effSpeed < this.opts.stationarySpeedThresholdMps) {
          updateAxisVelocity(this.axisX, 0, 0.6);
          updateAxisVelocity(this.axisY, 0, 0.6);
        } else if (effHeading !== null) {
          const measVx = effSpeed * Math.sin(effHeading * DEG_TO_RAD);
          const measVy = effSpeed * Math.cos(effHeading * DEG_TO_RAD);
          const sigmaVel = usingDerivedVel
            ? clamp(1.8 + effSpeed * 0.14, 2.0, 5.0)
            : clamp(0.8 + effSpeed * 0.06, 1.0, 2.8);
          const rVel = sigmaVel * sigmaVel;
          updateAxisVelocity(this.axisX, measVx, rVel);
          updateAxisVelocity(this.axisY, measVy, rVel);
        }
      }
    }

    this.lastFixClockMs = Math.max(this.lastFixClockMs, effFixClockMs);
    this.lastFixTimestamp = fix.timestamp;
    this.lastFixAccuracy = fix.accuracy;
    this.lastFixRawHeading = effHeading;
    this.lastFixRawSpeed = effSpeed;
    this.lastRawLon = lon;
    this.lastRawLat = lat;

    // Anchor road progression at the new Kalman state
    this.anchorPolyRef = null;

    const frame = this.step(nowMs);
    const kGeo = this.getKalmanGeo();
    return {
      accepted: true,
      kalmanLon: kGeo[0],
      kalmanLat: kGeo[1],
      speedMps: frame?.speedMps ?? this.getKalmanSpeedMps(),
      headingDeg: frame?.headingDeg ?? this.dispHeadingDeg,
    };
  }

  private getKalmanGeo(): [number, number] {
    if (!this.hasOrigin || !this.axisX || !this.axisY) {
      return [0, 0];
    }
    return this.toGeo(this.axisX.p, this.axisY.p);
  }

  private getKalmanSpeedMps(): number {
    if (!this.axisX || !this.axisY) return 0;
    return Math.hypot(this.axisX.v, this.axisY.v);
  }

  private findBestRoadMatch(
    lon: number,
    lat: number,
    travelHeadingDeg: number | null,
    speedMps: number
  ): CandidateMatch | null {
    const accuracyMargin = this.lastFixAccuracy !== null ? this.lastFixAccuracy * 1.4 : 16;
    const searchRadiusMeters = clamp(
      Math.max(this.opts.maxSnapDistanceMeters, accuracyMargin),
      24,
      42
    );
    const searchMarginLat = (searchRadiusMeters + 10) / METERS_PER_DEG_LAT;
    const searchMarginLon = (searchRadiusMeters + 10) / this.metersPerDegLon;

    const roadCandidates = this.opts.enableRoadNetworkMatching
      ? this.roadNetwork.getPolylinesNear(
          lon - searchMarginLon,
          lat - searchMarginLat,
          lon + searchMarginLon,
          lat + searchMarginLat
        )
      : EMPTY_POLYS;
    if (this.routePolylines.length === 0 && roadCandidates.length === 0) return null;

    let best: CandidateMatch | null = null;
    const weightAlignment =
      travelHeadingDeg !== null && speedMps >= this.opts.minMovingHeadingSpeedMps;

    const evaluateList = (list: SnapPolyline[]) => {
      for (let i = 0; i < list.length; i++) {
        const poly = list[i];
        const hit = projectLonLatOntoPolyline(
          lon,
          lat,
          poly,
          travelHeadingDeg,
          weightAlignment,
          this.metersPerDegLon,
          searchMarginLon,
          searchMarginLat,
          searchRadiusMeters
        );
        if (!hit || hit.distMeters > searchRadiusMeters) continue;

        const polyWayKey = poly.wayKey ?? poly.id;
        const isSameLogicalWay =
          this.matchedPolyRef === poly ||
          Boolean(this.matchedWayKey && polyWayKey === this.matchedWayKey);

        let alignPenalty = 0;
        if (weightAlignment && hit.dirAlignErrDeg !== null) {
          const alignErr = hit.dirAlignErrDeg;
          const isBidirectional = poly.forwardAllowed !== false && poly.reverseAllowed !== false;
          // Reject opposing one-way carriageways (alignErr ~ 180) and perpendicular crossroads while driving
          if (!isBidirectional && alignErr > 95) {
            continue;
          }
          if (!isSameLogicalWay && speedMps >= 3.0 && alignErr > 55) {
            continue;
          }
          alignPenalty = (Math.min(alignErr, 180) / 45) * 14;
        }

        // Release endpoint stickiness at sequential OSM way joints / tile seams
        const hysteresisBonus = isSameLogicalWay
          ? hit.clampedAtEnd
            ? poly.source === 'route'
              ? 4
              : 2
            : this.opts.sameWayHysteresisMeters
          : 0;

        // Active route bonus only when aligned reasonably with route direction
        const sourceBias =
          poly.source === 'route' && alignPenalty > 14 ? 0 : poly.priorityBiasMeters;

        const score = Math.max(0, hit.distMeters + alignPenalty + sourceBias - hysteresisBonus);
        hit.scoreMeters = score;

        if (!best || hit.scoreMeters < best.scoreMeters) {
          best = hit;
        }
      }
    };

    evaluateList(this.routePolylines);
    evaluateList(roadCandidates);

    return best;
  }

  /**
   * Advances display state smoothly to `nowMs` (designed to be called at 60fps via rAF).
   */
  step(nowMs = getDefaultClockMs()): SmoothedNavigationFrame | null {
    if (!this.hasOrigin || !this.axisX || !this.axisY) {
      return null;
    }

    const rawDtSec = this.hasStepClock ? Math.max(0, (nowMs - this.lastStepClockMs) / 1000) : 0;
    this.hasStepClock = true;
    this.lastStepClockMs = nowMs;
    const expDtSec = clamp(rawDtSec, 0, 5);

    const timeSinceFixSec = Math.max(0, (nowMs - this.lastFixClockMs) / 1000);
    const { effDtSec, decayFactor } = integrateDecayFactor(
      timeSinceFixSec,
      this.opts.fullPredictDurationSec,
      this.opts.maxPredictDurationSec
    );

    const baseSpeed = Math.hypot(this.axisX.v, this.axisY.v);
    const instSpeed = this.isStationary ? 0 : baseSpeed * decayFactor;

    const predX = this.axisX.p + (this.isStationary ? 0 : this.axisX.v * effDtSec);
    const predY = this.axisY.p + (this.isStationary ? 0 : this.axisY.v * effDtSec);
    const [predLon, predLat] = this.toGeo(predX, predY);

    const velHeading =
      baseSpeed >= this.opts.minMovingHeadingSpeedMps
        ? normalizeHeadingDeg(Math.atan2(this.axisX.v, this.axisY.v) * RAD_TO_DEG)
        : null;
    const travelHeading = velHeading ?? this.lastFixRawHeading ?? this.dispHeadingDeg;

    const match = this.findBestRoadMatch(predLon, predLat, travelHeading, baseSpeed);
    if (match) {
      this.matchedPolyRef = match.poly;
      this.matchedWayKey = match.poly.wayKey ?? match.poly.id;
    } else if (this.snapBlend < 0.05) {
      this.matchedPolyRef = null;
      this.matchedWayKey = null;
    }

    // Soft snap blend (prevents hard threshold jumps when leaving or entering a trail)
    let targetSnapBlend = 0;
    if (match) {
      const fullDist = this.opts.fullSnapDistanceMeters;
      const maxDist = this.opts.maxSnapDistanceMeters;
      if (match.distMeters <= fullDist) {
        targetSnapBlend = 1;
      } else if (match.distMeters < maxDist) {
        targetSnapBlend = 1 - (match.distMeters - fullDist) / Math.max(1, maxDist - fullDist);
      }
    }

    if (expDtSec > 0) {
      const snapAlpha = 1 - Math.exp(-expDtSec / this.opts.snapBlendTauSec);
      this.snapBlend += (targetSnapBlend - this.snapBlend) * snapAlpha;
    } else if (this.snapBlend === 0 && targetSnapBlend > 0) {
      this.snapBlend = targetSnapBlend;
    }

    let targetX = predX;
    let targetY = predY;
    let targetVx = this.isStationary ? 0 : this.axisX.v * decayFactor;
    let targetVy = this.isStationary ? 0 : this.axisY.v * decayFactor;
    let roadTangentBearing: number | null = null;

    if (match && this.snapBlend > 0.01) {
      // Anchor along-polyline progress by object identity & synchronized effDtSec
      if (this.anchorPolyRef !== match.poly) {
        this.anchorPolyRef = match.poly;
        this.anchorInitEffDtSec = effDtSec;
        this.anchorAlongMeters = match.alongMeters;
        this.anchorDirectionSign = match.directionSign;
      }

      const anchorDeltaEffSec = Math.max(0, effDtSec - this.anchorInitEffDtSec);
      const desiredAlong =
        this.anchorAlongMeters +
        (this.isStationary ? 0 : baseSpeed * anchorDeltaEffSec * this.anchorDirectionSign);

      let roadLon: number;
      let roadLat: number;
      let roadBearing: number;

      if (desiredAlong < 0 || desiredAlong > match.poly.totalLengthMeters) {
        // Past clipped tile end: smoothly extend along endpoint tangent instead of stalling
        const clamped = clamp(desiredAlong, 0, match.poly.totalLengthMeters);
        const overrun = Math.abs(desiredAlong - clamped);
        const endPt = samplePolylineAtAlong(
          match.poly,
          clamped,
          this.anchorDirectionSign,
          this.metersPerDegLon
        );
        const [ex, ey] = this.toLocal(endPt.lon, endPt.lat);
        const extX = ex + overrun * Math.sin(endPt.bearingDeg * DEG_TO_RAD);
        const extY = ey + overrun * Math.cos(endPt.bearingDeg * DEG_TO_RAD);
        [roadLon, roadLat] = this.toGeo(extX, extY);
        roadBearing = endPt.bearingDeg;
      } else {
        const sampled = samplePolylineAtAlong(
          match.poly,
          desiredAlong,
          this.anchorDirectionSign,
          this.metersPerDegLon
        );
        roadLon = sampled.lon;
        roadLat = sampled.lat;
        roadBearing = sampled.bearingDeg;
      }

      roadTangentBearing = roadBearing;
      const [roadX, roadY] = this.toLocal(roadLon, roadLat);

      targetX = predX + (roadX - predX) * this.snapBlend;
      targetY = predY + (roadY - predY) * this.snapBlend;

      const roadVx = instSpeed * Math.sin(roadBearing * DEG_TO_RAD);
      const roadVy = instSpeed * Math.cos(roadBearing * DEG_TO_RAD);
      targetVx = targetVx + (roadVx - targetVx) * this.snapBlend;
      targetVy = targetVy + (roadVy - targetVy) * this.snapBlend;
    } else {
      this.anchorPolyRef = null;
    }

    // Advance display position with bounded feedforward velocity + critically-smooth residual convergence
    if (!this.hasDisplayInit) {
      this.dispX = targetX;
      this.dispY = targetY;
      this.hasDisplayInit = true;
      this.lastConvergenceGapMeters = 0;
    } else {
      const preGap = Math.hypot(targetX - this.dispX, targetY - this.dispY);
      if (preGap > 250) {
        this.dispX = targetX;
        this.dispY = targetY;
        this.lastConvergenceGapMeters = 0;
      } else {
        if (rawDtSec > 0) {
          const ffDt = Math.min(rawDtSec, 0.45);
          this.dispX += targetVx * ffDt;
          this.dispY += targetVy * ffDt;
          const errX = targetX - this.dispX;
          const errY = targetY - this.dispY;
          const errMag = Math.hypot(errX, errY);
          const tau = errMag > 25 ? 0.16 : this.opts.positionBlendTauSec;
          const alpha = 1 - Math.exp(-expDtSec / tau);
          this.dispX += errX * alpha;
          this.dispY += errY * alpha;
        }
        this.lastConvergenceGapMeters = Math.hypot(targetX - this.dispX, targetY - this.dispY);
      }
    }

    // Resolve and smoothly damp heading
    const compassFresh =
      this.compassHeading !== null && nowMs - this.compassUpdatedAtMs <= 8000;
    let desiredHeading: number | null = null;
    if (!this.isStationary && baseSpeed >= this.opts.minMovingHeadingSpeedMps && velHeading !== null) {
      desiredHeading = velHeading;
      if (roadTangentBearing !== null && this.snapBlend > 0.35) {
        const roadDelta = shortestAngleDeltaDeg(desiredHeading, roadTangentBearing);
        desiredHeading = normalizeHeadingDeg(desiredHeading + roadDelta * (this.snapBlend * 0.85));
      }
    } else if (compassFresh) {
      desiredHeading = this.compassHeading;
    } else if (this.dispHeadingDeg !== null) {
      desiredHeading = this.dispHeadingDeg;
    } else if (this.lastFixRawHeading !== null) {
      desiredHeading = this.lastFixRawHeading;
    } else if (this.routeFallbackHeading !== null) {
      desiredHeading = this.routeFallbackHeading;
    }

    if (desiredHeading !== null) {
      if (this.dispHeadingDeg === null) {
        this.dispHeadingDeg = desiredHeading;
        this.lastHeadingErrorDeg = 0;
      } else {
        const delta = shortestAngleDeltaDeg(this.dispHeadingDeg, desiredHeading);
        if (expDtSec > 0) {
          const hAlpha = 1 - Math.exp(-expDtSec / this.opts.headingBlendTauSec);
          this.dispHeadingDeg = normalizeHeadingDeg(this.dispHeadingDeg + delta * hAlpha);
          this.lastHeadingErrorDeg = Math.abs(shortestAngleDeltaDeg(this.dispHeadingDeg, desiredHeading));
        } else {
          this.lastHeadingErrorDeg = Math.abs(delta);
        }
      }
    } else {
      this.lastHeadingErrorDeg = 0;
    }

    const [dispLon, dispLat] = this.toGeo(this.dispX, this.dispY);
    const [kalmanLon, kalmanLat] = this.toGeo(predX, predY);

    const frame: SmoothedNavigationFrame = {
      lon: dispLon,
      lat: dispLat,
      rawLon: this.lastRawLon,
      rawLat: this.lastRawLat,
      kalmanLon,
      kalmanLat,
      headingDeg: this.dispHeadingDeg,
      speedMps: instSpeed,
      isStationary: this.isStationary,
      isSnapped: Boolean(match && this.snapBlend >= 0.3),
      snapBlend: this.snapBlend,
      matchedRoadLabel: match && this.snapBlend >= 0.3 ? match.poly.roadLabel : null,
      matchedSource: match && this.snapBlend >= 0.3 ? match.poly.source : null,
      distFromMatchedMeters: match ? Math.round(match.distMeters) : null,
    };

    this.latestFrame = frame;
    return frame;
  }

  getLatestFrame(): SmoothedNavigationFrame | null {
    return this.latestFrame;
  }

  /**
   * Returns true while the vehicle is actively dead-reckoning or converging toward a target,
   * allowing the caller to pause rAF when stationary & settled to save battery.
   */
  needsAnimationFrame(nowMs = getDefaultClockMs()): boolean {
    if (!this.hasOrigin || !this.axisX || !this.axisY) return false;
    const timeSinceFixSec = Math.max(0, (nowMs - this.lastFixClockMs) / 1000);
    const speed = Math.hypot(this.axisX.v, this.axisY.v);
    const activelyPredicting =
      !this.isStationary && speed >= 0.25 && timeSinceFixSec < this.opts.maxPredictDurationSec;
    const stillConverging =
      this.lastConvergenceGapMeters > 0.08 || this.lastHeadingErrorDeg > 0.25;
    return activelyPredicting || stillConverging;
  }
}
