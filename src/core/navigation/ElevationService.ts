import { pmtilesRegistry } from '../pmtiles/PMTilesRegistry';

/**
 * Offline Elevation Service powered directly by C:\dev\NavApp\data\Israel.dem.pmtiles.
 * Decodes Terrarium PNG tiles (256x256) completely client-side:
 *   elevation (meters) = (R * 256 + G + B / 256) - 32768
 */
export class ElevationService {
  private static tilePixelCache = new Map<string, Uint8ClampedArray>();
  private static inFlightRequests = new Map<string, Promise<Uint8ClampedArray | null>>();
  private static sharedCanvas: HTMLCanvasElement | null = null;
  private static sharedCtx: CanvasRenderingContext2D | null = null;

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

  private static getCanvasContext(): CanvasRenderingContext2D | null {
    if (!this.sharedCanvas && typeof document !== 'undefined') {
      this.sharedCanvas = document.createElement('canvas');
      this.sharedCanvas.width = 256;
      this.sharedCanvas.height = 256;
      this.sharedCtx = this.sharedCanvas.getContext('2d', { willReadFrequently: true });
    }
    return this.sharedCtx;
  }

  private static async getDemTilePixels(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.tilePixelCache.get(key);
    if (cached) return cached;

    const inFlight = this.inFlightRequests.get(key);
    if (inFlight) return inFlight;

    const demPmtiles = pmtilesRegistry.getArchive('israel-dem');
    if (!demPmtiles) return null;

    const requestPromise = (async () => {
      try {
        const tileResult = await demPmtiles.getZxy(z, x, y);
        if (!tileResult || !tileResult.data) return null;

        const blob = new Blob([tileResult.data], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        const ctx = this.getCanvasContext();
        if (!ctx) {
          bitmap.close?.();
          return null;
        }

        ctx.clearRect(0, 0, 256, 256);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close?.();
        const pixels = new Uint8ClampedArray(ctx.getImageData(0, 0, 256, 256).data);

        if (this.tilePixelCache.size > 80) {
          const oldestKey = this.tilePixelCache.keys().next().value;
          if (oldestKey) this.tilePixelCache.delete(oldestKey);
        }
        this.tilePixelCache.set(key, pixels);
        return pixels;
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
    const pixels = onlyIfCached
      ? this.tilePixelCache.get(key) ?? null
      : await this.getDemTilePixels(zoom, tileX, tileY);
    if (!pixels) return null;

    const idx = (pixelY * 256 + pixelX) * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];
    if (a === 0) return null;

    const elevation = r * 256 + g + b / 256 - 32768;
    return Math.round(elevation);
  }
}
