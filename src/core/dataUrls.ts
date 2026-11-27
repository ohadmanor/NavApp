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
export const REMOTE_DEM_HOSTING_ORIGIN = 'https://navapp-israel-topo-dem.web.app';

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

export function isAndroidNativePlatform(): boolean {
  if (!isNativePlatform()) return false;
  const cap = (typeof window !== 'undefined' ? (window as any).Capacitor : undefined) as
    | { getPlatform?: () => string }
    | undefined;
  const platform = typeof cap?.getPlatform === 'function' ? cap.getPlatform() : '';
  if (platform) return platform === 'android';
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

const ANDROID_REMOTE_PROXY_PREFIX = 'https://localhost/__remote_proxy__/';

/**
 * Rewrites cross-origin Firebase Storage HTTPS URLs onto Capacitor Android's same-origin
 * `/__remote_proxy__/` endpoint so WebView `fetch()` Range requests do not fail CORS on `https://localhost`.
 */
export function wrapAndroidRemoteProxyUrl(fileName: string, targetUrl: string): string {
  if (!isAndroidNativePlatform()) return targetUrl;
  if (!targetUrl.startsWith('https://') || targetUrl.startsWith('https://localhost/')) {
    return targetUrl;
  }
  if (!targetUrl.startsWith('https://firebasestorage.googleapis.com/') && !targetUrl.startsWith('https://storage.googleapis.com/')) {
    return targetUrl;
  }
  return `${ANDROID_REMOTE_PROXY_PREFIX}${encodeURIComponent(fileName)}?url=${encodeURIComponent(targetUrl)}`;
}

/** Extracts the upstream HTTPS URL from an Android `/__remote_proxy__/` URL when needed by native downloaders. */
export function unwrapAndroidRemoteProxyUrl(targetUrl: string): string {
  if (!targetUrl.startsWith(ANDROID_REMOTE_PROXY_PREFIX)) return targetUrl;
  try {
    const parsed = new URL(targetUrl);
    const inner = parsed.searchParams.get('url');
    return inner && inner.startsWith('https://') ? inner : targetUrl;
  } catch {
    return targetUrl;
  }
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
 * Returns the ordered, deduplicated list of candidate URLs for `Israel.dem.pmtiles`.
 * Primary: explicit `VITE_DEM_PMTILES_URL` (Firebase Storage) when set;
 * Fallback: dedicated static `hosting:dem` (`navapp-israel-topo-dem.web.app`) for restricted networks,
 * followed by `hosting:data` and `hosting:app` origins.
 */
export function getDemCandidateUrls(): string[] {
  if (isLocalDevServer()) {
    return [`${window.location.origin}/data/Israel.dem.pmtiles`];
  }
  const candidates: string[] = [];
  const customDemUrl = getCustomDemPmtilesUrl();
  if (customDemUrl) {
    candidates.push(wrapAndroidRemoteProxyUrl('Israel.dem.pmtiles', customDemUrl));
  }
  const customOrigin = getCustomDataOrigin();
  if (customOrigin) {
    candidates.push(`${customOrigin}/data/Israel.dem.pmtiles`);
  } else {
    candidates.push(
      `${REMOTE_DEM_HOSTING_ORIGIN}/data/Israel.dem.pmtiles`,
      `${REMOTE_DATA_ORIGIN}/data/Israel.dem.pmtiles`,
      `${REMOTE_DATA_FALLBACK_ORIGIN}/data/Israel.dem.pmtiles`
    );
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * Large PMTiles archives: served from the dedicated Firebase data/DEM sites (HTTP 206 Byte-Range streaming).
 */
export function pmtilesUrl(fileName: string): string {
  if (!isLocalDevServer() && fileName === 'Israel.dem.pmtiles') {
    const customDemUrl = getCustomDemPmtilesUrl();
    if (customDemUrl) return wrapAndroidRemoteProxyUrl(fileName, customDemUrl);
    if (!getCustomDataOrigin()) {
      return `${REMOTE_DEM_HOSTING_ORIGIN}/data/Israel.dem.pmtiles`;
    }
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

