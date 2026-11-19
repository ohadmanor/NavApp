/**
 * Central resolver for map data URLs.
 *
 * - Local Web Dev/Preview (localhost / 127.0.0.1, non-native): data is served from local `data/` (`/data/...`).
 * - Deployed Web & Native Android/iOS (Capacitor): Firebase Hosting data site (`navapp-israel-topo-data.web.app`)
 *   is the single source of truth for all 4 data files:
 *     - Israel.dem.pmtiles
 *     - Israel.osm.pmtiles
 *     - Israel.pois.geojson
 *     - Israel.search.idx
 */
export const REMOTE_DATA_ORIGIN = 'https://navapp-israel-topo-data.web.app';
export const REMOTE_DATA_FALLBACK_ORIGIN = 'https://navapp-israel-topo.web.app';

export function getCustomDataOrigin(): string {
  try {
    // Must reference import.meta.env.VITE_DATA_ORIGIN directly so Vite statically inlines it
    const raw = import.meta.env.VITE_DATA_ORIGIN;
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (trimmed === 'same-origin' && typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin;
    }
    return trimmed;
  } catch {
    return '';
  }
}

export function getEffectiveRemoteDataOrigin(): string {
  return getCustomDataOrigin() || REMOTE_DATA_ORIGIN;
}

export function getCustomDemPmtilesUrl(): string {
  try {
    // Must reference import.meta.env.VITE_DEM_PMTILES_URL directly so Vite statically inlines it in production builds
    const raw = import.meta.env.VITE_DEM_PMTILES_URL;
    return typeof raw === 'string' ? raw.trim() : '';
  } catch {
    return '';
  }
}

export function isNativePlatform(): boolean {
  const cap = (typeof window !== 'undefined' ? (window as any).Capacitor : undefined) as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

export function isLocalDevServer(): boolean {
  return (
    typeof window !== 'undefined' &&
    !isNativePlatform() &&
    (window.location?.hostname === 'localhost' || window.location?.hostname === '127.0.0.1')
  );
}

/**
 * Resolves a Firebase-hosted map/POI/search data file URL:
 * local `/data/{fileName}` in Vite dev/preview, or `REMOTE_DATA_ORIGIN/data/{fileName}` in production & native.
 */
export function remoteDataUrl(fileName: string): string {
  if (isLocalDevServer()) {
    return `${window.location.origin}/data/${fileName}`;
  }
  return `${getEffectiveRemoteDataOrigin()}/data/${fileName}`;
}

/**
 * Large PMTiles archives: served from the dedicated Firebase data site (HTTP 206 Byte-Range streaming).
 */
export function pmtilesUrl(fileName: string): string {
  if (!isLocalDevServer() && fileName === 'Israel.dem.pmtiles') {
    const customDemUrl = getCustomDemPmtilesUrl();
    if (customDemUrl) return customDemUrl;
  }
  return remoteDataUrl(fileName);
}

/**
 * Resolves data files (POIs GeoJSON, search index) using the same Firebase-first source-of-truth policy as PMTiles.
 */
export function bundledDataUrl(fileName: string): string {
  const cleanName = fileName.replace(/^\/?(?:data\/)+/i, '');
  return remoteDataUrl(cleanName);
}

