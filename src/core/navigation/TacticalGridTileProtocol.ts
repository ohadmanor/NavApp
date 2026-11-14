import maplibregl from 'maplibre-gl';
import { PbfWriter } from 'pbf';
import { MilitaryGridService } from './MilitaryGridService';

export const TACTICAL_GRID_PROTOCOL = 'tactical-grid';
export const TACTICAL_GRID_TILE_URL = `${TACTICAL_GRID_PROTOCOL}://{z}/{x}/{y}`;
export const TACTICAL_GRID_SOURCE_LAYER = 'grid';

const MVT_EXTENT = 4096;
const CLIP_BUFFER = 128;
const TILE_URL_RE = /^tactical-grid:\/\/(\d+)\/(\d+)\/(\d+)/;
const MAX_CACHE_TILES = 128;

const tileCache = new Map<string, Uint8Array>();

interface MvtGridFeature {
  id: number;
  kind: 'major' | 'minor';
  axis: 'easting' | 'northing';
  label: string;
  showLabel: boolean;
  coords: Array<[number, number]>;
}

type MvtPropValue = string | boolean | number;

function zigzag(n: number): number {
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function encodeLineGeometry(coords: ReadonlyArray<[number, number]>): number[] {
  if (coords.length < 2) return [];
  const geom: number[] = [];
  const startX = Math.round(coords[0][0]);
  const startY = Math.round(coords[0][1]);
  geom.push((1 << 3) | 1, zigzag(startX), zigzag(startY)); // MoveTo(1)

  let curX = startX;
  let curY = startY;
  const deltas: number[] = [];
  for (let i = 1; i < coords.length; i++) {
    const x = Math.round(coords[i][0]);
    const y = Math.round(coords[i][1]);
    const dx = x - curX;
    const dy = y - curY;
    if (dx !== 0 || dy !== 0) {
      deltas.push(zigzag(dx), zigzag(dy));
      curX = x;
      curY = y;
    }
  }
  const lineToCount = deltas.length / 2;
  if (lineToCount < 1) return [];

  geom.push((lineToCount << 3) | 2, ...deltas); // LineTo(lineToCount)
  return geom;
}

function clipSegmentToRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): [number, number, number, number] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;

  const checks: Array<[number, number]> = [
    [-dx, x0 - minX],
    [dx, maxX - x0],
    [-dy, y0 - minY],
    [dy, maxY - y0],
  ];

  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }

  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

function clipPolylineToTile(
  points: ReadonlyArray<[number, number]>,
  minCoord: number,
  maxCoord: number
): Array<Array<[number, number]>> {
  const runs: Array<Array<[number, number]>> = [];
  let active: Array<[number, number]> = [];

  for (let i = 0; i < points.length - 1; i++) {
    const seg = clipSegmentToRect(
      points[i][0],
      points[i][1],
      points[i + 1][0],
      points[i + 1][1],
      minCoord,
      minCoord,
      maxCoord,
      maxCoord
    );
    if (!seg) {
      if (active.length >= 2) runs.push(active);
      active = [];
      continue;
    }

    const ax = Math.round(seg[0]);
    const ay = Math.round(seg[1]);
    const bx = Math.round(seg[2]);
    const by = Math.round(seg[3]);

    if (active.length === 0) {
      active.push([ax, ay]);
    } else {
      const last = active[active.length - 1];
      if (last[0] !== ax || last[1] !== ay) {
        if (Math.abs(last[0] - ax) > 1 || Math.abs(last[1] - ay) > 1) {
          if (active.length >= 2) runs.push(active);
          active = [[ax, ay]];
        } else {
          active.push([ax, ay]);
        }
      }
    }

    const tail = active[active.length - 1];
    if (tail[0] !== bx || tail[1] !== by) {
      active.push([bx, by]);
    }
  }

  if (active.length >= 2) runs.push(active);
  return runs;
}

function encodeMvtGridLayer(features: ReadonlyArray<MvtGridFeature>): Uint8Array {
  if (features.length === 0) return new Uint8Array(0);

  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  const values: MvtPropValue[] = [];
  const valIndex = new Map<string, number>();

  const getKeyIdx = (k: string): number => {
    const existing = keyIndex.get(k);
    if (existing !== undefined) return existing;
    const idx = keys.length;
    keys.push(k);
    keyIndex.set(k, idx);
    return idx;
  };

  const getValIdx = (v: MvtPropValue): number => {
    const sig = `${typeof v}:${String(v)}`;
    const existing = valIndex.get(sig);
    if (existing !== undefined) return existing;
    const idx = values.length;
    values.push(v);
    valIndex.set(sig, idx);
    return idx;
  };

  const encodedFeatures: Array<{ id: number; tags: number[]; geom: number[] }> = [];
  for (const feat of features) {
    const geom = encodeLineGeometry(feat.coords);
    if (geom.length === 0) continue;
    const tags: number[] = [
      getKeyIdx('kind'),
      getValIdx(feat.kind),
      getKeyIdx('axis'),
      getValIdx(feat.axis),
      getKeyIdx('showLabel'),
      getValIdx(feat.showLabel),
    ];
    if (feat.showLabel && feat.label) {
      tags.push(getKeyIdx('label'), getValIdx(feat.label));
    }
    encodedFeatures.push({ id: feat.id, tags, geom });
  }

  if (encodedFeatures.length === 0) return new Uint8Array(0);

  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_layerData, layerPbf) => {
      layerPbf.writeVarintField(15, 2); // MVT version 2
      layerPbf.writeStringField(1, TACTICAL_GRID_SOURCE_LAYER);
      for (const ef of encodedFeatures) {
        layerPbf.writeMessage(
          2,
          (f, fpbf) => {
            fpbf.writeVarintField(1, f.id);
            fpbf.writePackedVarint(2, f.tags);
            fpbf.writeVarintField(3, 2); // LINESTRING
            fpbf.writePackedVarint(4, f.geom);
          },
          ef
        );
      }
      for (const k of keys) {
        layerPbf.writeStringField(3, k);
      }
      for (const v of values) {
        layerPbf.writeMessage(
          4,
          (val, vpbf) => {
            if (typeof v === 'string') {
              vpbf.writeStringField(1, v);
            } else if (typeof v === 'boolean') {
              vpbf.writeBooleanField(7, v);
            } else {
              vpbf.writeDoubleField(3, v);
            }
          },
          v
        );
      }
      layerPbf.writeVarintField(5, MVT_EXTENT);
    },
    null
  );

  return pbf.finish();
}

function tileYToLat(yFrac: number, n: number): number {
  const merc = Math.PI - (2 * Math.PI * yFrac) / n;
  return (180 / Math.PI) * Math.atan(Math.sinh(merc));
}

function lonLatToTilePixel(lon: number, lat: number, z: number, x: number, y: number): [number, number] {
  const n = 2 ** z;
  const xFrac = ((lon + 180) / 360) * n - x;
  const latClamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const latRad = (latClamped * Math.PI) / 180;
  const yMerc = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
  const yFrac = yMerc * n - y;
  return [xFrac * MVT_EXTENT, yFrac * MVT_EXTENT];
}

/**
 * Dynamically generates a Mapbox Vector Tile (.pbf) containing true ITM (EPSG:2039)
 * or global UTM metric grid lines and labels for tile `(z, x, y)`.
 */
export function generateTacticalGridMvtTileBytes(z: number, x: number, y: number): Uint8Array {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 7 || z > 22) {
    return new Uint8Array(0);
  }
  const n = 2 ** z;
  if (x < 0 || x >= n || y < 0 || y >= n) {
    return new Uint8Array(0);
  }

  const cacheKey = `${z}/${x}/${y}`;
  const cached = tileCache.get(cacheKey);
  if (cached) {
    // Refresh LRU order
    tileCache.delete(cacheKey);
    tileCache.set(cacheKey, cached);
    return cached;
  }

  const tileWest = (x / n) * 360 - 180;
  const tileEast = ((x + 1) / n) * 360 - 180;
  const tileNorth = tileYToLat(y, n);
  const tileSouth = tileYToLat(y + 1, n);

  const centerLon = (tileWest + tileEast) / 2;
  const centerLat = (tileSouth + tileNorth) / 2;
  if (Math.abs(centerLat) > 84) {
    return new Uint8Array(0);
  }

  const dLon = tileEast - tileWest;
  const dLat = tileNorth - tileSouth;
  const padLon = dLon * 0.1;
  const padLat = dLat * 0.1;

  const w = tileWest - padLon;
  const e = tileEast + padLon;
  const s = Math.max(-84.5, tileSouth - padLat);
  const nn = Math.min(84.5, tileNorth + padLat);

  const useItm = MilitaryGridService.isInsideItmRegion(centerLon, centerLat);
  const utmZone = Math.max(1, Math.min(60, Math.floor((centerLon + 180) / 6) + 1));
  const utmNorthern = centerLat >= 0;

  const toProj = (lon: number, lat: number) =>
    useItm ? MilitaryGridService.wgs84ToItm(lon, lat) : MilitaryGridService.wgs84ToUtm(lon, lat, utmZone);
  const toWgs = (easting: number, northing: number) =>
    useItm
      ? MilitaryGridService.itmToWgs84(easting, northing)
      : MilitaryGridService.utmToWgs84(easting, northing, utmZone, utmNorthern);

  const sampleCoords: Array<[number, number]> = [
    [w, s],
    [e, s],
    [w, nn],
    [e, nn],
    [centerLon, s],
    [centerLon, nn],
    [w, centerLat],
    [e, centerLat],
    [centerLon, centerLat],
  ];

  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const [lon, lat] of sampleCoords) {
    const p = toProj(lon, lat);
    if (p.easting < minE) minE = p.easting;
    if (p.easting > maxE) maxE = p.easting;
    if (p.northing < minN) minN = p.northing;
    if (p.northing > maxN) maxN = p.northing;
  }

  const spec = MilitaryGridService.getGridZoomSpec(z);
  const stepM = spec.minorStepMeters;
  const majorM = spec.majorStepMeters;

  const startE = Math.floor(minE / stepM) * stepM;
  const endE = Math.ceil(maxE / stepM) * stepM;
  const startN = Math.floor(minN / stepM) * stepM;
  const endN = Math.ceil(maxN / stepM) * stepM;

  const maxLinesPerAxis = 80;
  if ((endE - startE) / stepM > maxLinesPerAxis || (endN - startN) / stepM > maxLinesPerAxis) {
    return new Uint8Array(0);
  }

  const spanN = Math.max(stepM, endN - startN);
  const spanE = Math.max(stepM, endE - startE);
  const linePadN = spanN * 0.05;
  const linePadE = spanE * 0.05;
  const steps = 4;
  const clipMin = -CLIP_BUFFER;
  const clipMax = MVT_EXTENT + CLIP_BUFFER;

  const features: MvtGridFeature[] = [];
  let nextId = 1;

  // Easting meridians (roughly North-South)
  for (let easting = startE; easting <= endE + 0.5; easting += stepM) {
    const roundedE = Math.round(easting);
    const isMajor = Math.abs(roundedE % majorM) === 0;
    const showLabel =
      isMajor ||
      spec.labelMinor ||
      (Boolean(spec.labelHalfKm) && Math.abs(roundedE % 500) === 0);
    const label = showLabel ? MilitaryGridService.formatGridLabel(roundedE, useItm) : '';

    const rawPts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const northing = startN - linePadN + ((spanN + 2 * linePadN) * i) / steps;
      const wgs = toWgs(roundedE, northing);
      rawPts.push(lonLatToTilePixel(wgs.lon, wgs.lat, z, x, y));
    }
    for (const run of clipPolylineToTile(rawPts, clipMin, clipMax)) {
      features.push({
        id: nextId++,
        kind: isMajor ? 'major' : 'minor',
        axis: 'easting',
        label,
        showLabel,
        coords: run,
      });
    }
  }

  // Northing parallels (roughly East-West)
  for (let northing = startN; northing <= endN + 0.5; northing += stepM) {
    const roundedN = Math.round(northing);
    const isMajor = Math.abs(roundedN % majorM) === 0;
    const showLabel =
      isMajor ||
      spec.labelMinor ||
      (Boolean(spec.labelHalfKm) && Math.abs(roundedN % 500) === 0);
    const label = showLabel ? MilitaryGridService.formatGridLabel(roundedN, useItm) : '';

    const rawPts: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const easting = startE - linePadE + ((spanE + 2 * linePadE) * i) / steps;
      const wgs = toWgs(easting, roundedN);
      rawPts.push(lonLatToTilePixel(wgs.lon, wgs.lat, z, x, y));
    }
    for (const run of clipPolylineToTile(rawPts, clipMin, clipMax)) {
      features.push({
        id: nextId++,
        kind: isMajor ? 'major' : 'minor',
        axis: 'northing',
        label,
        showLabel,
        coords: run,
      });
    }
  }

  const bytes = encodeMvtGridLayer(features);
  if (tileCache.size >= MAX_CACHE_TILES) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey !== undefined) tileCache.delete(oldestKey);
  }
  tileCache.set(cacheKey, bytes);
  return bytes;
}

/**
 * Generates an independent ArrayBuffer copy of the MVT tile (safe for MapLibre worker transfer).
 */
export function generateTacticalGridMvtTile(z: number, x: number, y: number): ArrayBuffer {
  const bytes = generateTacticalGridMvtTileBytes(z, x, y);
  if (bytes.byteLength === 0) return new ArrayBuffer(0);
  return bytes.slice().buffer;
}

let isGridProtocolRegistered = false;

export function registerTacticalGridProtocol(): void {
  if (isGridProtocolRegistered) return;
  isGridProtocolRegistered = true;

  maplibregl.addProtocol(TACTICAL_GRID_PROTOCOL, async (params) => {
    const match = TILE_URL_RE.exec(params.url);
    if (!match) {
      return { data: new ArrayBuffer(0) };
    }
    const z = parseInt(match[1], 10);
    const x = parseInt(match[2], 10);
    const y = parseInt(match[3], 10);
    const data = generateTacticalGridMvtTile(z, x, y);
    return { data };
  });
}
