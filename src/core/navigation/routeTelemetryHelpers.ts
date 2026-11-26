import type { PoiRecord, SavedRouteRecord } from '../db/NavDatabase';
import { POI_CATEGORY_META } from '../../components/ui/themeTokens';

const KM_PER_DEG_LAT = 111.32;

export interface RouteChartPoint {
  lon: number;
  lat: number;
  ele: number;
  distKm: number;
  label?: string;
}

export interface RoutePointOption extends RouteChartPoint {
  id: string;
  label: string;
  emoji: string;
  kind: 'start' | 'end' | 'peak' | 'wpt';
  poiCategory?: PoiRecord['category'];
  subcategory?: string;
}

function approxDistKmPointToSegment(
  pLon: number,
  pLat: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
  kmPerDegLon: number
): number {
  const ax = (aLon - pLon) * kmPerDegLon;
  const ay = (aLat - pLat) * KM_PER_DEG_LAT;
  const bx = (bLon - pLon) * kmPerDegLon;
  const by = (bLat - pLat) * KM_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    return Math.hypot(ax, ay);
  }
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

function approxDistKmPointToCoordList(
  lon: number,
  lat: number,
  coords: Array<[number, number]>,
  kmPerDegLon: number
): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) {
    return Math.hypot((coords[0][0] - lon) * kmPerDegLon, (coords[0][1] - lat) * KM_PER_DEG_LAT);
  }
  let minKm = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = approxDistKmPointToSegment(lon, lat, a[0], a[1], b[0], b[1], kmPerDegLon);
    if (d < minKm) {
      minKm = d;
    }
  }
  return minKm;
}

/**
 * Computes ordered start, nearby POIs, peak elevation, and end options along a route or recorded track.
 */
export function computeRoutePointsAlongTrack(
  route: SavedRouteRecord | null | undefined,
  pois: PoiRecord[]
): RoutePointOption[] {
  if (!route || route.elevationProfile.length === 0) return [];
  const pts = route.elevationProfile;
  const options: RoutePointOption[] = [];

  options.push({
    id: 'pt-start',
    label: 'נקודת התחלה',
    emoji: '🟢',
    kind: 'start',
    ...pts[0],
  });

  interface PolyChunk {
    coords: Array<[number, number]>;
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  }
  const chunks: PolyChunk[] = [];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const pushCoordChunks = (rawCoords: GeoJSON.Position[]) => {
    if (rawCoords.length < 2) return;
    const CHUNK_SIZE = 80;
    for (let start = 0; start < rawCoords.length - 1; start += CHUNK_SIZE - 1) {
      const slice = rawCoords.slice(start, Math.min(rawCoords.length, start + CHUNK_SIZE));
      if (slice.length < 2) break;
      const coords: Array<[number, number]> = [];
      let cMinLon = Infinity;
      let cMinLat = Infinity;
      let cMaxLon = -Infinity;
      let cMaxLat = -Infinity;
      for (const c of slice) {
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        coords.push([lon, lat]);
        if (lon < cMinLon) cMinLon = lon;
        if (lon > cMaxLon) cMaxLon = lon;
        if (lat < cMinLat) cMinLat = lat;
        if (lat > cMaxLat) cMaxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      if (coords.length >= 2) {
        chunks.push({
          coords,
          minLon: cMinLon,
          maxLon: cMaxLon,
          minLat: cMinLat,
          maxLat: cMaxLat,
        });
      }
    }
  };

  for (const f of route.geojson?.features || []) {
    if (f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 2) {
      pushCoordChunks(f.geometry.coordinates);
    } else if (f.geometry?.type === 'MultiLineString') {
      for (const ring of f.geometry.coordinates) {
        if (Array.isArray(ring) && ring.length >= 2) {
          pushCoordChunks(ring);
        }
      }
    }
  }

  if (chunks.length > 0 && pois.length > 0 && Number.isFinite(minLon)) {
    const padDeg = 0.02;
    const gMinLon = minLon - padDeg;
    const gMaxLon = maxLon + padDeg;
    const gMinLat = minLat - padDeg;
    const gMaxLat = maxLat + padDeg;
    const midLat = (minLat + maxLat) / 2;
    const kmPerDegLon = KM_PER_DEG_LAT * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

    const nearbyWpts: RoutePointOption[] = [];
    for (const poi of pois) {
      if (poi.lon < gMinLon || poi.lon > gMaxLon || poi.lat < gMinLat || poi.lat > gMaxLat) {
        continue;
      }

      const maxRadiusKm = poi.subcategory?.startsWith('imported_') ? 1.5 : 0.35;
      let minLineKm = Infinity;
      for (const chunk of chunks) {
        if (
          poi.lon < chunk.minLon - padDeg ||
          poi.lon > chunk.maxLon + padDeg ||
          poi.lat < chunk.minLat - padDeg ||
          poi.lat > chunk.maxLat + padDeg
        ) {
          continue;
        }
        const d = approxDistKmPointToCoordList(poi.lon, poi.lat, chunk.coords, kmPerDegLon);
        if (d < minLineKm) minLineKm = d;
        if (minLineKm <= 0.03) break;
      }

      if (minLineKm <= maxRadiusKm) {
        let bestSample = pts[0];
        let bestSampleDistSq = Infinity;
        for (const sample of pts) {
          const dx = (sample.lon - poi.lon) * kmPerDegLon;
          const dy = (sample.lat - poi.lat) * KM_PER_DEG_LAT;
          const dSq = dx * dx + dy * dy;
          if (dSq < bestSampleDistSq) {
            bestSampleDistSq = dSq;
            bestSample = sample;
          }
        }
        const meta = POI_CATEGORY_META[poi.category] || POI_CATEGORY_META.heritage;
        nearbyWpts.push({
          id: `pt-wpt-${poi.id}`,
          label: poi.nameHe || poi.name,
          emoji: meta.emoji,
          kind: 'wpt',
          poiCategory: poi.category,
          subcategory: poi.subcategory,
          lon: poi.lon,
          lat: poi.lat,
          ele: poi.ele ?? bestSample.ele,
          distKm: bestSample.distKm,
        });
      }
    }

    nearbyWpts.sort((a, b) => a.distKm - b.distKm);
    const dedupedWpts: RoutePointOption[] = [];
    for (const wp of nearbyWpts) {
      const norm = wp.label.trim().toLowerCase();
      const isDup = dedupedWpts.some(
        (existing) =>
          existing.label.trim().toLowerCase() === norm &&
          Math.abs(existing.distKm - wp.distKm) < 0.8
      );
      if (!isDup) dedupedWpts.push(wp);
    }
    options.push(...dedupedWpts.slice(0, 25));
  }

  if (pts.length >= 3) {
    let peakIdx = 0;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].ele > pts[peakIdx].ele) peakIdx = i;
    }
    if (peakIdx > 0 && peakIdx < pts.length - 1 && route.maxEle > route.minEle) {
      options.push({
        id: 'pt-peak',
        label: `שיא גובה (${pts[peakIdx].ele}m)`,
        emoji: '🏔️',
        kind: 'peak',
        ...pts[peakIdx],
      });
    }
  }

  if (pts.length > 1) {
    options.push({
      id: 'pt-end',
      label: 'נקודת סיום',
      emoji: '🔴',
      kind: 'end',
      ...pts[pts.length - 1],
    });
  }

  return options;
}

/**
 * Extracts summary recording metadata from imported GPX track timestamps if present.
 */
export function deriveRecordingMetaFromTimestamps(
  pointTimestamps?: Array<Array<number | null>>,
  distanceKm = 0
): {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  avgSpeedKmh?: number;
  pointTimestamps?: number[];
} | null {
  if (!pointTimestamps || pointTimestamps.length === 0) return null;
  const flat = pointTimestamps.flat();
  const valid = flat.filter((t): t is number => typeof t === 'number' && Number.isFinite(t));
  if (valid.length < 2) return null;
  const minMs = Math.min(...valid);
  const maxMs = Math.max(...valid);
  const durationSeconds = Math.max(0, Math.round((maxMs - minMs) / 1000));
  const avgSpeedKmh =
    durationSeconds > 0 ? Number((distanceKm / (durationSeconds / 3600)).toFixed(1)) : undefined;
  return {
    startedAt: new Date(minMs).toISOString(),
    endedAt: new Date(maxMs).toISOString(),
    durationSeconds,
    avgSpeedKmh,
    pointTimestamps: flat.map((t) => (typeof t === 'number' && Number.isFinite(t) ? t : minMs)),
  };
}
