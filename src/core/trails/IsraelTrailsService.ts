import israelTrailsRaw from './IsraelTrails.json';
import { haversineMeters } from '../routing/TileRoadGraphBuilder';
import type { TrailAnnotationSearchItem } from './TrailAnnotationTypes';

export interface IsraelTrailRecord {
  id: number;
  name: string;
  numbers: string[];
  geoZone: string;
  description: string;
  lon: number;
  lat: number;
}

const ISRAEL_TRAILS = israelTrailsRaw as IsraelTrailRecord[];

let cachedSearchItems: TrailAnnotationSearchItem[] | null = null;

export function getIsraelTrails(): IsraelTrailRecord[] {
  return ISRAEL_TRAILS;
}

/**
 * Finds the best matching Israel trail record by trail number (if provided)
 * or nearest trailhead within 1.5 km.
 */
export function findIsraelTrailMatch(params: {
  number?: string;
  lon: number;
  lat: number;
}): IsraelTrailRecord | null {
  const targetNum = (params.number || '').trim();
  const origin: [number, number] = [params.lon, params.lat];

  if (targetNum) {
    const byNumber = ISRAEL_TRAILS.filter((item) => item.numbers.includes(targetNum));
    if (byNumber.length === 1) return byNumber[0];
    if (byNumber.length > 1) {
      let best = byNumber[0];
      let bestDist = haversineMeters(origin, [best.lon, best.lat]);
      for (let i = 1; i < byNumber.length; i++) {
        const d = haversineMeters(origin, [byNumber[i].lon, byNumber[i].lat]);
        if (d < bestDist) {
          best = byNumber[i];
          bestDist = d;
        }
      }
      return best;
    }
  }

  let nearest: IsraelTrailRecord | null = null;
  let nearestDist = 1500;
  for (const item of ISRAEL_TRAILS) {
    if (Math.abs(item.lon - params.lon) > 0.02 || Math.abs(item.lat - params.lat) > 0.02) {
      continue;
    }
    const d = haversineMeters(origin, [item.lon, item.lat]);
    if (d < nearestDist) {
      nearest = item;
      nearestDist = d;
    }
  }
  return nearest;
}

export function getIsraelTrailSearchItems(): TrailAnnotationSearchItem[] {
  if (cachedSearchItems) return cachedSearchItems;
  cachedSearchItems = ISRAEL_TRAILS.map((item) => ({
    id: `israel-trail:${item.id}`,
    name: item.name,
    number: item.numbers.join(', '),
    color: '#16a34a',
    description: item.description,
    lon: item.lon,
    lat: item.lat,
  }));
  return cachedSearchItems;
}

function normalizeForMatch(value: string): string {
  return String(value || '')
    .replace(/[^\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches a Zofim route seed item against the Israel trails dataset by
 * SPNI trail number first, then by normalized name.
 */
export function matchZofimToIsraelTrail(item: {
  name: string;
  trailMarking?: string;
}): IsraelTrailRecord | null {
  const nums = Array.from(
    String(item.trailMarking || '').matchAll(/\b(\d{3,5})\b/g),
    (m) => m[1]
  );
  const normName = normalizeForMatch(item.name);

  for (const num of nums) {
    const candidates = ISRAEL_TRAILS.filter((m) => m.numbers.includes(num));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      return (
        candidates.find((c) => {
          const cn = normalizeForMatch(c.name);
          return (normName && cn.includes(normName)) || (cn && normName.includes(cn));
        }) ?? candidates[0]
      );
    }
  }

  if (normName.length >= 3) {
    const exactSub = ISRAEL_TRAILS.find((m) => normalizeForMatch(m.name).includes(normName));
    if (exactSub) return exactSub;

    // Token-based fallback: match if all significant words (>= 3 chars) appear in an Israel trail name
    const tokens = normName.split(' ').filter((t) => t.length >= 3);
    if (tokens.length > 0) {
      let bestMatch: IsraelTrailRecord | null = null;
      let bestHits = 0;
      for (const m of ISRAEL_TRAILS) {
        const mn = normalizeForMatch(m.name);
        let hits = 0;
        for (const tk of tokens) {
          if (mn.includes(tk)) hits++;
        }
        if (hits > bestHits && (hits === tokens.length || hits >= 2)) {
          bestHits = hits;
          bestMatch = m;
        }
      }
      if (bestMatch) return bestMatch;
    }
  }
  return null;
}
