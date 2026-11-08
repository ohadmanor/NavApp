import { FetchSource, type Source, type RangeResponse } from 'pmtiles';

const CACHE_NAME = 'pmtiles-range-cache-v1';
const MAX_CACHED_RANGE_BYTES = 2 * 1024 * 1024;

/**
 * HTTP-Range PMTiles source with a persistent Cache Storage layer.
 *  - Every range already streamed from the network (header, directories, tiles) is kept on disk,
 *    so revisiting an area, or restarting the app, costs zero network requests.
 *  - Identical concurrent range requests are de-duplicated.
 * Falls back to plain streaming if Cache Storage is unavailable.
 */
export class CachedFetchSource implements Source {
  private inner: FetchSource;
  private inFlight = new Map<string, Promise<RangeResponse>>();
  private cachePromise: Promise<Cache | null> | null = null;

  constructor(private url: string) {
    this.inner = new FetchSource(url);
  }

  getKey(): string {
    return this.url;
  }

  private getCache(): Promise<Cache | null> {
    if (!this.cachePromise) {
      this.cachePromise =
        typeof caches !== 'undefined'
          ? caches.open(CACHE_NAME).catch(() => null)
          : Promise.resolve(null);
    }
    return this.cachePromise;
  }

  private cacheRequest(offset: number, length: number): Request {
    return new Request(
      `https://pmtiles-range-cache.invalid/${encodeURIComponent(this.url)}/${offset}-${length}`
    );
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    const key = `${offset}-${length}-${etag || ''}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const task = (async (): Promise<RangeResponse> => {
      const cacheable = length <= MAX_CACHED_RANGE_BYTES;
      const cache = cacheable ? await this.getCache() : null;
      const req = this.cacheRequest(offset, length);

      if (cache) {
        try {
          const hit = await cache.match(req);
          if (hit) {
            const hitEtag = hit.headers.get('x-etag') || undefined;
            if (!etag || !hitEtag || hitEtag === etag) {
              return { data: await hit.arrayBuffer(), etag: hitEtag };
            }
          }
        } catch {
          /* fall through to network */
        }
      }

      const res = await this.inner.getBytes(offset, length, signal, etag);
      if (cache && res.data && res.data.byteLength > 0) {
        cache
          .put(
            req,
            new Response(res.data.slice(0), {
              headers: res.etag ? { 'x-etag': res.etag } : {},
            })
          )
          .catch(() => {});
      }
      return res;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, task);
    return task;
  }

  /** Drops all cached ranges (e.g. when the remote archive was replaced). */
  static async clear(): Promise<void> {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => {});
  }
}

