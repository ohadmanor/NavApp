import { decodeDemPngSafely, pmtilesRegistry } from '../pmtiles/PMTilesRegistry';

/**
 * Offline Elevation Service powered directly by C:\dev\NavApp\data\Israel.dem.pmtiles.
 * Decodes Terrarium PNG tiles (256x256) completely client-side:
 *   elevation (meters) = (R * 256 + G + B / 256) - 32768
 */
export class ElevationService {
  private static tilePixelCache = new Map<string, Float32Array>();
  private static inFlightRequests = new Map<string, Promise<Float32Array | null>>();

  private static lonLatToTilePixel(lon: number, lat: number, zoom: number) {
    const n = Math.pow(2, zoom);
    const xFloat = ((lon + 180) / 360) * n;
    const latRad = (lat * Math.PI) / 180;
    const yFloat =
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;

    const tileX = Math.floor(xFloat);
    const tileY = Math.floor(yFloat);
    const pixelX = Math.min(255, Math.max(0, Math.floor((xFloat - tileX) * 256)));
    const pixelY = Math.min(255, Math.max(0, Math.floor((yFloat - tileY) * 256)));

    return { tileX, tileY, pixelX, pixelY };
  }

  private static async getDemTileElevations(z: number, x: number, y: number): Promise<Float32Array | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.tilePixelCache.get(key);
    if (cached) return cached;

    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) return inFlight;

    const demPmtiles = pmtilesRegistry.getArchive('israel-dem');
    if (!demPmtiles) return null;

    const requestPromise = (async () => {
      try {
        let tileResult = await demPmtiles.getZxy(z, x, y).catch(() => undefined);
        if (!tileResult || !tileResult.data) {
          await new Promise((r) => setTimeout(r, 250));
          tileResult = await demPmtiles.getZxy(z, x, y);
        }
        if (!tileResult || !tileResult.data) return null;

        const blob = new Blob([tileResult.data], { type: 'image/png' });
        const decoded = await decodeDemPngSafely(blob, 'terrarium');
        if (!decoded?.data) return null;

        if (this.tilePixelCache.size > 80) {
          const oldestKey = this.tilePixelCache.keys().next().value;
          if (oldestKey) this.tilePixelCache.delete(oldestKey);
        }
        this.tilePixelCache.set(key, decoded.data);
        return decoded.data;
      } catch {
        return null;
      } finally {
        this.inFlightRequests.delete(key);
      }
    })();

    this.inFlightRequests.set(key, requestPromise);
    return requestPromise;
  }

  /**
   * Queries exact ground elevation in meters at (lon, lat) from Israel.dem.pmtiles offline.
   * Uses zoom 11 by default so it shares the exact same cached DEM tiles as overzoom=1 contours.
   */
  static async getElevationAt(
    lon: number,
    lat: number,
    zoom = 11,
    onlyIfCached = false
  ): Promise<number | null> {
    const { tileX, tileY, pixelX, pixelY } = this.lonLatToTilePixel(lon, lat, zoom);
    const key = `${zoom}/${tileX}/${tileY}`;
    const elevations = onlyIfCached
      ? this.tilePixelCache.get(key) ?? null
      : await this.getDemTileElevations(zoom, tileX, tileY);
    if (!elevations) return null;

    const elevation = elevations[pixelY * 256 + pixelX];
    if (!Number.isFinite(elevation) || elevation <= -12000) return null;

    return Math.round(elevation);
  }
}
