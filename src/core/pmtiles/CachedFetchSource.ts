import { FetchSource, type Source, type RangeResponse } from 'pmtiles';

const CACHE_NAME = 'pmtiles-range-cache-v3';
const MAX_CACHED_RANGE_BYTES = 2 * 1024 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 8000;

function createTimeoutSignal(parentSignal?: AbortSignal, timeoutMs = REMOTE_FETCH_TIMEOUT_MS): AbortSignal {
  const timeoutSignal =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  if (!parentSignal) return timeoutSignal as AbortSignal;
  if (!timeoutSignal) return parentSignal;
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any([parentSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal.reason || timeoutSignal.reason);
  if (parentSignal.aborted || timeoutSignal.aborted) {
    onAbort();
  } else {
    parentSignal.addEventListener('abort', onAbort, { once: true });
    timeoutSignal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

// Cleanup legacy range caches so obsolete PMTiles archives (e.g. without trail colors) are never served
if (typeof caches !== 'undefined') {
  caches.delete('pmtiles-range-cache-v1').catch(() => {});
  caches.delete('pmtiles-range-cache-v2').catch(() => {});
}

/**
 * HTTP-Range PMTiles source with a persistent Cache Storage layer.
 *  - Every range already streamed from the network (header, directories, tiles) is kept on disk,
 *    so revisiting an area, or restarting the app, costs zero network requests.
 *  - Identical concurrent range requests are de-duplicated.
 * Falls back to plain streaming if Cache Storage is unavailable.
 */
export interface CachedFetchSourceOptions {
  /** Immutable archives (e.g. Israel.dem.pmtiles) skip online header revalidation when already cached. */
  immutable?: boolean;
}

export class CachedFetchSource implements Source {
  private inner: FetchSource;
  private inFlight = new Map<string, Promise<RangeResponse>>();
  private cachePromise: Promise<Cache | null> | null = null;
  private immutable: boolean;

  constructor(private url: string, options: CachedFetchSourceOptions = {}) {
    this.inner = new FetchSource(url);
    this.immutable = Boolean(options.immutable);
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
    if (pending) {
      return pending.then((r) => ({ ...r, data: r.data.slice(0) }));
    }

    const task = (async (): Promise<RangeResponse> => {
      const cacheable = length <= MAX_CACHED_RANGE_BYTES;
      let cache = cacheable ? await this.getCache() : null;
      const req = this.cacheRequest(offset, length);

      let cachedHit: Response | undefined;
      if (cache) {
        try {
          cachedHit = await cache.match(req);
        } catch {
          cachedHit = undefined;
        }
      }

      // For immutable archives, serve cached header immediately if present.
      // For mutable archives, revalidate offset 0 (header) with a short timeout when online.
      const shouldRevalidateHeader =
        offset === 0 &&
        !etag &&
        (!this.immutable || !cachedHit) &&
        (typeof navigator === 'undefined' || navigator.onLine !== false);

      if (shouldRevalidateHeader) {
        const reqSignal = createTimeoutSignal(signal);
        try {
          const freshResp = await fetch(this.url, {
            signal: reqSignal,
            cache: 'no-cache',
            headers: { range: `bytes=0-${length - 1}` },
          });
          const respLen = Number(freshResp.headers.get('content-length') || 0);
          if (freshResp.ok && (freshResp.status === 206 || (respLen > 0 && respLen <= length))) {
            const contentType = freshResp.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
              throw new Error('Server returned HTML instead of PMTiles binary');
            }
            const data = await freshResp.arrayBuffer();
            if (data.byteLength >= 2) {
              const u8 = new Uint8Array(data);
              if (u8[0] !== 0x50 || u8[1] !== 0x4d) {
                throw new Error(
                  `Invalid PMTiles magic bytes (received 0x${u8[0].toString(16)} 0x${u8[1].toString(16)}).`
                );
              }
            }
            let newEtag = freshResp.headers.get('etag') || undefined;
            if (newEtag?.startsWith('W/')) newEtag = undefined;
            const prevEtag = cachedHit?.headers.get('x-etag') || undefined;

            if (cachedHit && newEtag && prevEtag !== newEtag) {
              // Remote archive changed — drop all cached directory/tile ranges before writing new header
              await CachedFetchSource.clear();
              this.cachePromise = null;
              cache = cacheable ? await this.getCache() : null;
            }
            if (cache && data.byteLength > 0) {
              cache
                .put(
                  req,
                  new Response(data.slice(0), {
                    headers: newEtag ? { 'x-etag': newEtag } : {},
                  })
                )
                .catch(() => {});
            }
            return { data, etag: newEtag };
          }
          if (freshResp.status >= 500) {
            throw new Error(`HTTP ${freshResp.status} from ${this.url}`);
          }
        } catch (err: any) {
          if (err?.name === 'AbortError' && signal?.aborted) throw err;
          if (cachedHit) {
            const hitEtag = cachedHit.headers.get('x-etag') || undefined;
            return { data: await cachedHit.arrayBuffer(), etag: hitEtag };
          }
          // Do not double-retry a timed-out or 5xx offset-0 header fetch via inner.getBytes
          throw err;
        }
      }

      if (cachedHit) {
        const hitEtag = cachedHit.headers.get('x-etag') || undefined;
        if (!etag || !hitEtag || hitEtag === etag) {
          return { data: await cachedHit.arrayBuffer(), etag: hitEtag };
        }
      }

      const rangeSignal = createTimeoutSignal(signal);
      const res = await this.inner.getBytes(offset, length, rangeSignal, etag);

      // Validate header magic bytes (PM) at offset 0 so HTML error pages are never parsed or cached
      if (offset === 0 && res.data && res.data.byteLength >= 2) {
        const u8 = new Uint8Array(res.data);
        if (u8[0] !== 0x50 || u8[1] !== 0x4d) {
          throw new Error(
            `Invalid PMTiles magic bytes (received 0x${u8[0].toString(16)} 0x${u8[1].toString(16)}). The file may be missing from the server (returned HTML error page).`
          );
        }
      }

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
    return task.then((r) => ({ ...r, data: r.data.slice(0) }));
  }

  /** Drops all cached ranges (e.g. when the remote archive was replaced). */
  static async clear(): Promise<void> {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => {});
  }
}

