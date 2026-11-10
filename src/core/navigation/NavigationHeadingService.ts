import type { SavedRouteRecord } from '../db/NavDatabase';

export type MapNavigationOrientation = 'heading-up' | 'north-up';

export const DEFAULT_NAV_ORIENTATION: MapNavigationOrientation = 'heading-up';
const NAV_ORIENTATION_STORAGE_KEY = 'navapp.navOrientation.v1';

export interface HeadingSourcesInput {
  gpsFixHeading: number | null;
  gpsSpeedMps: number | null;
  computedCourseHeading: number | null;
  compassHeading: number | null;
  lastValidHeading: number | null;
  routeFallbackHeading?: number | null;
  nowMs?: number;
  gpsUpdatedAtMs?: number;
  compassUpdatedAtMs?: number;
}

export function normalizeHeadingDeg(deg: number): number {
  const mod = deg % 360;
  return mod < 0 ? mod + 360 : mod;
}

export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  const from = normalizeHeadingDeg(fromDeg);
  const to = normalizeHeadingDeg(toDeg);
  let delta = to - from;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

export function smoothHeadingDeg(
  prevDeg: number | null,
  nextDeg: number,
  alpha = 0.28
): number {
  const normalizedNext = normalizeHeadingDeg(nextDeg);
  if (prevDeg === null || !Number.isFinite(prevDeg)) {
    return normalizedNext;
  }
  const delta = shortestAngleDeltaDeg(prevDeg, normalizedNext);
  return normalizeHeadingDeg(prevDeg + delta * alpha);
}

/**
 * Computes screen-space clockwise rotation of a North-up directional icon
 * given the user's true heading and the map camera's current clockwise bearing.
 */
export function computeScreenRotationDeg(
  worldHeadingDeg: number,
  mapBearingDeg: number
): number {
  return normalizeHeadingDeg(worldHeadingDeg - mapBearingDeg);
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function haversineMeters(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number
): number {
  const R = 6371000;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(fromLat)) * Math.cos(toRad(toLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Computes forward azimuth [0..360) clockwise from true North between two WGS84 points.
 * Returns null if the points are separated by less than `minDistanceMeters` to avoid stationary GPS jitter.
 */
export function computeBearingBetweenCoords(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
  minDistanceMeters = 3
): number | null {
  if (
    !Number.isFinite(fromLon) ||
    !Number.isFinite(fromLat) ||
    !Number.isFinite(toLon) ||
    !Number.isFinite(toLat)
  ) {
    return null;
  }
  const dist = haversineMeters(fromLon, fromLat, toLon, toLat);
  if (dist < minDistanceMeters) {
    return null;
  }

  const phi1 = toRad(fromLat);
  const phi2 = toRad(toLat);
  const dLambda = toRad(toLon - fromLon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeHeadingDeg(toDeg(Math.atan2(y, x)));
}

/**
 * Computes an initial forward direction along a saved route so starting navigation
 * immediately points the icon/camera down the trail even before the user moves.
 */
export function extractRouteTangentHeading(
  route: SavedRouteRecord | null | undefined,
  lon?: number,
  lat?: number
): number | null {
  const feature = route?.geojson?.features?.find(
    (f) => f?.geometry?.type === 'LineString' || f?.geometry?.type === 'MultiLineString'
  );
  const coords =
    feature?.geometry?.type === 'LineString'
      ? (feature.geometry.coordinates as number[][])
      : feature?.geometry?.type === 'MultiLineString'
        ? (feature.geometry.coordinates[0] as number[][] | undefined) ?? null
        : null;
  if (!coords || coords.length < 2) return null;

  if (typeof lon === 'number' && typeof lat === 'number') {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const d = haversineMeters(lon, lat, coords[i][0], coords[i][1]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    for (let j = bestIdx; j < coords.length - 1; j++) {
      const b = computeBearingBetweenCoords(
        coords[j][0],
        coords[j][1],
        coords[j + 1][0],
        coords[j + 1][1],
        1
      );
      if (b !== null) return b;
    }
  }

  for (let i = 0; i < coords.length - 1; i++) {
    const b = computeBearingBetweenCoords(
      coords[i][0],
      coords[i][1],
      coords[i + 1][0],
      coords[i + 1][1],
      1
    );
    if (b !== null) return b;
  }
  return null;
}

export class NavigationHeadingService {
  static getOrientationPreference(): MapNavigationOrientation {
    if (typeof window === 'undefined' || !window.localStorage) {
      return DEFAULT_NAV_ORIENTATION;
    }
    try {
      const saved = window.localStorage.getItem(NAV_ORIENTATION_STORAGE_KEY);
      if (saved === 'north-up' || saved === 'heading-up') {
        return saved;
      }
    } catch {
      // Ignore storage access restrictions
    }
    return DEFAULT_NAV_ORIENTATION;
  }

  static setOrientationPreference(mode: MapNavigationOrientation): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(NAV_ORIENTATION_STORAGE_KEY, mode);
    } catch {
      // Ignore storage quota errors
    }
  }

  /**
   * Fuses GPS movement heading, displaced course bearing, device compass, and route fallback
   * matching standard turn-by-turn navigation behavior (GPS travel direction while moving,
   * device magnetometer compass while standing/turning on foot).
   */
  static resolveActiveHeading(input: HeadingSourcesInput): number | null {
    const now = input.nowMs ?? Date.now();
    const gpsFresh =
      typeof input.gpsUpdatedAtMs !== 'number' || now - input.gpsUpdatedAtMs <= 12000;
    const compassFresh =
      typeof input.compassUpdatedAtMs !== 'number' || now - input.compassUpdatedAtMs <= 8000;

    const gpsRawHeading =
      typeof input.gpsFixHeading === 'number' && Number.isFinite(input.gpsFixHeading)
        ? normalizeHeadingDeg(input.gpsFixHeading)
        : null;
    const isMoving =
      input.gpsSpeedMps === null ||
      (typeof input.gpsSpeedMps === 'number' &&
        Number.isFinite(input.gpsSpeedMps) &&
        input.gpsSpeedMps >= 0.6);

    const movementHeading =
      gpsFresh && ((isMoving ? gpsRawHeading : null) ?? input.computedCourseHeading) !== null
        ? normalizeHeadingDeg(((isMoving ? gpsRawHeading : null) ?? input.computedCourseHeading)!)
        : null;

    if (movementHeading !== null) {
      return movementHeading;
    }

    if (
      compassFresh &&
      typeof input.compassHeading === 'number' &&
      Number.isFinite(input.compassHeading)
    ) {
      return normalizeHeadingDeg(input.compassHeading);
    }

    if (gpsRawHeading !== null && gpsFresh) {
      return gpsRawHeading;
    }

    if (
      typeof input.lastValidHeading === 'number' &&
      Number.isFinite(input.lastValidHeading)
    ) {
      return normalizeHeadingDeg(input.lastValidHeading);
    }

    if (
      typeof input.routeFallbackHeading === 'number' &&
      Number.isFinite(input.routeFallbackHeading)
    ) {
      return normalizeHeadingDeg(input.routeFallbackHeading);
    }

    return null;
  }

  static async requestCompassPermissionIfNeeded(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const DOE = (window as any).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        return res === 'granted';
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Subscribes to absolute device magnetometer / compass orientation events (iOS & Android/Web),
   * adjusts for screen rotation angle, and applies wrap-around-safe circular smoothing.
   */
  static subscribeCompassHeading(
    onHeading: (headingDeg: number) => void
  ): () => void {
    if (typeof window === 'undefined') {
      return () => {};
    }

    let smoothedHeading: number | null = null;
    let lastEmitTs = 0;

    const getScreenOrientationAngle = (): number => {
      if (typeof screen !== 'undefined' && typeof screen.orientation?.angle === 'number') {
        return screen.orientation.angle;
      }
      const winOrient = (window as any).orientation;
      return typeof winOrient === 'number' ? winOrient : 0;
    };

    const handleEvent = (ev: DeviceOrientationEvent) => {
      let rawCompass: number | null = null;
      const iosHeading = (ev as any).webkitCompassHeading;
      if (typeof iosHeading === 'number' && Number.isFinite(iosHeading)) {
        rawCompass = normalizeHeadingDeg(iosHeading);
      } else if (
        (ev.absolute === true || ev.type === 'deviceorientationabsolute') &&
        typeof ev.alpha === 'number' &&
        Number.isFinite(ev.alpha)
      ) {
        rawCompass = normalizeHeadingDeg(360 - ev.alpha + getScreenOrientationAngle());
      }

      if (rawCompass === null) return;

      smoothedHeading = smoothHeadingDeg(smoothedHeading, rawCompass, 0.25);
      const now = performance.now ? performance.now() : Date.now();
      if (now - lastEmitTs >= 45) {
        lastEmitTs = now;
        onHeading(Number(smoothedHeading.toFixed(1)));
      }
    };

    window.addEventListener('deviceorientationabsolute', handleEvent as EventListener, true);
    window.addEventListener('deviceorientation', handleEvent as EventListener, true);

    return () => {
      window.removeEventListener('deviceorientationabsolute', handleEvent as EventListener, true);
      window.removeEventListener('deviceorientation', handleEvent as EventListener, true);
    };
  }
}
