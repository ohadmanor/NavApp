/**
 * Central resolver for map data URLs.
 *
 * - Web: data is served from the same origin (`/data/...`).
 * - Native Android/iOS (Capacitor): the web app is served from `https://localhost`, which does NOT
 *   contain the 1.4 GB PMTiles. Large archives are therefore streamed (HTTP Range) from the hosted
 *   Firebase site, unless the user mounted local files (OPFS / file picker) in the Maps Manager.
 *   Small GeoJSON files are bundled inside the APK (`public/data`).
 */
export const REMOTE_DATA_ORIGIN = 'https://navapp-israel-topo.web.app';

export function isNativePlatform(): boolean {
  const cap = (typeof window !== 'undefined' ? (window as any).Capacitor : undefined) as
    | { isNativePlatform?: () => boolean }
    | undefined;
  return !!cap?.isNativePlatform?.();
}

/** Large PMTiles archives: remote on native, same-origin on web. */
export function pmtilesUrl(fileName: string): string {
  const base = isNativePlatform() ? REMOTE_DATA_ORIGIN : window.location.origin;
  return `${base}/data/${fileName}`;
}

/** Small bundled data files (GeoJSON): always local so they work offline. */
export function bundledDataUrl(fileName: string): string {
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';
  return `${origin}/data/${fileName}`;
}
