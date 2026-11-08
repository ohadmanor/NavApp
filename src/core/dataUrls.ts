/**
 * Central resolver for map data URLs.
 *
 * - Web: data is served from the same origin (`/data/...`).
 * - Native Android/iOS (Capacitor): the web app is served from `https://localhost`, which does NOT
 *   contain the 1.4 GB PMTiles. Large archives are therefore streamed (HTTP Range) from the hosted
 *   Firebase site, unless the user mounted local files (OPFS / file picker) in the Maps Manager.
 *   Small GeoJSON files are bundled inside the APK (`public/data`).
 */
export const REMOTE_DATA_ORIGIN = 'https://navapp-israel-topo-data.web.app';
export const REMOTE_DATA_FALLBACK_ORIGIN = 'https://navapp-israel-topo.web.app';

export function isNativePlatform(): boolean {
  const cap = (typeof window !== 'undefined' ? (window as any).Capacitor : undefined) as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

/**
 * Large PMTiles archives: served from the dedicated Firebase data site (HTTP 206 Byte-Range streaming).
 */
export function pmtilesUrl(fileName: string): string {
  if (typeof window !== 'undefined' && (window.location?.hostname === 'localhost' || window.location?.hostname === '127.0.0.1')) {
    return `${window.location.origin}/data/${fileName}`;
  }
  return `${REMOTE_DATA_ORIGIN}/data/${fileName}`;
}

/** Small bundled data files (GeoJSON): always local so they work offline. */
export function bundledDataUrl(fileName: string): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';
  return `${origin}/data/${fileName}`;
}

