import { type RangeResponse, type Source } from 'pmtiles';
import { CachedFetchSource } from './CachedFetchSource';

/**
 * Immutable bundled-asset PMTiles source (e.g. `/assets/world-globe/world-basemap.pmtiles`).
 * Prefers HTTP 206 Byte-Range streaming + Cache Storage via `CachedFetchSource`, and falls back
 * transparently to a single in-memory `ArrayBuffer` fetch if a static host or Capacitor WebView
 * returns HTTP 200 without Byte-Range support.
 */
export class BundledAssetPMTilesSource implements Source {
  private readonly rangeSource: CachedFetchSource;
  private fullBufferPromise: Promise<ArrayBuffer> | null = null;

  constructor(private readonly url: string) {
    this.rangeSource = new CachedFetchSource(url, { immutable: true });
  }

  getKey(): string {
    return this.url;
  }

  private loadFullAsset(): Promise<ArrayBuffer> {
    if (!this.fullBufferPromise) {
      this.fullBufferPromise = fetch(this.url)
        .then(async (resp) => {
          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} loading ${this.url}`);
          }
          const contentType = resp.headers.get('content-type') || '';
          if (contentType.includes('text/html')) {
            throw new Error(`Received HTML instead of PMTiles binary for ${this.url}`);
          }
          const buf = await resp.arrayBuffer();
          if (buf.byteLength < 2) {
            throw new Error(`Empty PMTiles asset: ${this.url}`);
          }
          const u8 = new Uint8Array(buf);
          if (u8[0] !== 0x50 || u8[1] !== 0x4d) {
            throw new Error(`Invalid PMTiles magic bytes for ${this.url}`);
          }
          return buf;
        })
        .catch((err) => {
          this.fullBufferPromise = null;
          throw err;
        });
    }
    return this.fullBufferPromise;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    if (this.fullBufferPromise) {
      const buf = await this.fullBufferPromise;
      return { data: buf.slice(offset, offset + length) };
    }

    try {
      return await this.rangeSource.getBytes(offset, length, signal, etag);
    } catch (err: any) {
      if (err?.name === 'AbortError' && signal?.aborted) {
        throw err;
      }
      // Hosts such as Capacitor WebView asset servers often return HTTP 200 without Range support
      const buf = await this.loadFullAsset();
      return { data: buf.slice(offset, offset + length) };
    }
  }
}
