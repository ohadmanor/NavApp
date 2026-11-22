import { EtagMismatch, FetchSource, type Source, type RangeResponse } from 'pmtiles';

const CACHE_NAME = 'pmtiles-range-cache-v4';
const MAX_CACHED_RANGE_BYTES = 2 * 1024 * 1024;
// Generous per-range timeout so queued 6-connection mobile WebView bursts against Firebase Storage
// never abort valid DEM/contour tiles while still failing fast on dead sockets.
const REMOTE_FETCH_TIMEOUT_MS = 25000;
const TRANSIENT_RETRY_DELAY_MS = 300;

/**
 * Validates that an HTTP range payload matches the requested byte window.
 * Rejects truncated (e.g. Android WebView double-skip) and unbounded (e.g. full-file 206) replies.
 */
export function isValidRangeLength(
  offset: number,
  requestedLength: number,
  actualBytes: number
): boolean {
  if (!Number.isFinite(actualBytes) || actualBytes <= 0) return false;
  if (actualBytes > requestedLength) return false;
  if (offset > 0 && actualBytes !== requestedLength) return false;
  return true;
}

function usesCustomAndroidRangeHeader(url: string): boolean {
  return url.includes('/__remote_proxy__/') || url.includes('/__native_maps__/');
}

function validatePmtilesMagicAtOffset0(data: ArrayBuffer): void {
  if (data.byteLength < 2) return;
  const u8 = new Uint8Array(data);
  if (u8[0] !== 0x50 || u8[1] !== 0x4d) {
    throw new Error(
      `Invalid PMTiles magic bytes (received 0x${u8[0].toString(16)} 0x${u8[1].toString(16)}). The file may be missing from the server (returned HTML error page).`
    );
  }
}

function buildRangeHeaders(url: string, start: number, end: number): Record<string, string> {
  const value = `bytes=${start}-${end}`;
  return usesCustomAndroidRangeHeader(url)
    ? { 'x-navapp-range': value }
    : { range: value };
}

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

// Cleanup legacy range caches so obsolete or WebView-corrupted PMTiles ranges are never served
if (typeof caches !== 'undefined') {
  caches.delete('pmtiles-range-cache-v1').catch(() => {});
  caches.delete('pmtiles-range-cache-v2').catch(() => {});
  caches.delete('pmtiles-range-cache-v3').catch(() => {});
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
  private inFlight = new Map<
    string,
    { promise: Promise<RangeResponse>; controller: AbortController; refs: number }
  >();
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

  private async fetchDirectRange(
    offset: number,
    length: number,
    signal: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    const customRange = usesCustomAndroidRangeHeader(this.url);
    const cacheMode: RequestCache | undefined =
      customRange || (this.inner as any).mustReload || (this.inner as any).chromeWindowsNoCache
        ? 'no-store'
        : undefined;

    let resp = await fetch(this.url, {
      signal,
      cache: cacheMode,
      headers: buildRangeHeaders(this.url, offset, offset + length - 1),
    });

    if (offset === 0 && resp.status === 416) {
      const contentRange = resp.headers.get('Content-Range');
      if (!contentRange || !contentRange.startsWith('bytes */')) {
        throw new Error('Missing content-length on 416 response');
      }
      const actualLength = +contentRange.slice(8);
      resp = await fetch(this.url, {
        signal,
        cache: 'no-store',
        headers: buildRangeHeaders(this.url, 0, Math.max(0, actualLength - 1)),
      });
    }

    let newEtag = resp.headers.get('Etag');
    if (newEtag?.startsWith('W/')) {
      newEtag = null;
    }

    if (resp.status === 416 || (etag && newEtag && newEtag !== etag)) {
      this.inner.mustReload = true;
      throw new EtagMismatch(
        `Server returned non-matching ETag ${etag} after one retry.`
      );
    }

    if (resp.status >= 300) {
      throw new Error(`Bad response code: ${resp.status}`);
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('Server returned HTML instead of PMTiles binary');
    }

    if (resp.status === 200) {
      const rawCl = resp.headers.get('content-length');
      const numericCl = rawCl ? Number(rawCl) : NaN;
      if (!customRange && (!Number.isFinite(numericCl) || numericCl <= 0 || numericCl > length)) {
        throw new Error(
          'Server returned no content-length header or content-length exceeding request.'
        );
      }
    }

    const data = await resp.arrayBuffer();
    if (!isValidRangeLength(offset, length, data.byteLength)) {
      throw new Error(
        `Unexpected byte length for range ${offset}+${length}: received ${data.byteLength}`
      );
    }
    if (offset === 0) {
      validatePmtilesMagicAtOffset0(data);
    }

    return {
      data,
      etag: newEtag || undefined,
      cacheControl: resp.headers.get('Cache-Control') || undefined,
      expires: resp.headers.get('Expires') || undefined,
    };
  }

  private awaitEntryForCaller(
    key: string,
    entry: { promise: Promise<RangeResponse>; controller: AbortController; refs: number },
    signal?: AbortSignal
  ): Promise<RangeResponse> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    }
    entry.refs++;

    return new Promise<RangeResponse>((resolve, reject) => {
      let settled = false;
      const onCallerAbort = () => {
        if (settled) return;
        settled = true;
        entry.refs--;
        if (entry.refs <= 0 && this.inFlight.get(key) === entry) {
          entry.controller.abort();
        }
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal) {
        signal.addEventListener('abort', onCallerAbort, { once: true });
      }
      entry.promise.then(
        (res) => {
          if (signal) signal.removeEventListener('abort', onCallerAbort);
          if (settled) return;
          settled = true;
          entry.refs--;
          resolve({ ...res, data: res.data.slice(0) });
        },
        (err) => {
          if (signal) signal.removeEventListener('abort', onCallerAbort);
          if (settled) return;
          settled = true;
          entry.refs--;
          reject(err);
        }
      );
    });
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string
  ): Promise<RangeResponse> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    const key = `${offset}-${length}-${etag || ''}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return this.awaitEntryForCaller(key, existing, signal);
    }

    const sharedController = new AbortController();
    const sharedSignal = sharedController.signal;

    const promise = (async (): Promise<RangeResponse> => {
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

      const readValidCachedHit = async (): Promise<RangeResponse | null> => {
        if (!cachedHit) return null;
        const hitEtag = cachedHit.headers.get('x-etag') || undefined;
        if (etag && hitEtag && hitEtag !== etag) {
          return null;
        }
        const buf = await cachedHit.arrayBuffer();
        if (!isValidRangeLength(offset, length, buf.byteLength)) {
          cache?.delete(req).catch(() => {});
          cachedHit = undefined;
          return null;
        }
        if (offset === 0) {
          try {
            validatePmtilesMagicAtOffset0(buf);
          } catch {
            cache?.delete(req).catch(() => {});
            cachedHit = undefined;
            return null;
          }
        }
        return { data: buf, etag: hitEtag };
      };

      // For immutable archives, serve cached header immediately if present.
      // For mutable archives, revalidate offset 0 (header) with a short timeout when online.
      const shouldRevalidateHeader =
        offset === 0 &&
        !etag &&
        (!this.immutable || !cachedHit) &&
        (typeof navigator === 'undefined' || navigator.onLine !== false);

      if (shouldRevalidateHeader) {
        const reqSignal = createTimeoutSignal(sharedSignal);
        try {
          const customRange = usesCustomAndroidRangeHeader(this.url);
          const freshResp = await fetch(this.url, {
            signal: reqSignal,
            cache: 'no-store',
            headers: buildRangeHeaders(this.url, 0, length - 1),
          });
          const rawCl = freshResp.headers.get('content-length');
          const respLen = rawCl ? Number(rawCl) : NaN;
          if (
            freshResp.ok &&
            (freshResp.status === 206 ||
              (freshResp.status === 200 &&
                (customRange || (Number.isFinite(respLen) && respLen > 0 && respLen <= length))))
          ) {
            const contentType = freshResp.headers.get('content-type') || '';
            if (contentType.includes('text/html')) {
              throw new Error('Server returned HTML instead of PMTiles binary');
            }
            const data = await freshResp.arrayBuffer();
            if (!isValidRangeLength(0, length, data.byteLength)) {
              throw new Error(
                `Unexpected header byte length (${data.byteLength} for requested ${length})`
              );
            }
            validatePmtilesMagicAtOffset0(data);
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
          if (err?.name === 'AbortError' && sharedSignal.aborted) throw err;
          const validHit = await readValidCachedHit();
          if (validHit) return validHit;
          // Do not double-retry a timed-out or 5xx offset-0 header fetch via inner.getBytes
          throw err;
        }
      }

      const validHit = await readValidCachedHit();
      if (validHit) return validHit;

      const fetchOnce = async (): Promise<RangeResponse> => {
        const timeoutSignal = createTimeoutSignal(sharedSignal);
        if (usesCustomAndroidRangeHeader(this.url)) {
          return this.fetchDirectRange(offset, length, timeoutSignal, etag);
        }
        const innerRes = await this.inner.getBytes(offset, length, timeoutSignal, etag);
        if (!innerRes?.data || !isValidRangeLength(offset, length, innerRes.data.byteLength)) {
          throw new Error(
            `Unexpected range byte length (${innerRes?.data?.byteLength ?? 0} for ${offset}+${length})`
          );
        }
        if (offset === 0) {
          validatePmtilesMagicAtOffset0(innerRes.data);
        }
        return innerRes;
      };

      let res: RangeResponse;
      try {
        res = await fetchOnce();
      } catch (firstErr: any) {
        const msg = String(firstErr?.message || '');
        const nonTransient =
          sharedSignal.aborted ||
          /Bad response code: 40[0134]/i.test(msg) ||
          /ETagMismatch/i.test(firstErr?.name || msg);
        if (nonTransient) throw firstErr;
        await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
        if (sharedSignal.aborted) throw firstErr;
        res = await fetchOnce();
      }

      if (cache && res.data && isValidRangeLength(offset, length, res.data.byteLength)) {
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

    const entry = { promise, controller: sharedController, refs: 0 };
    this.inFlight.set(key, entry);
    return this.awaitEntryForCaller(key, entry, signal);
  }

  /** Drops all cached ranges (e.g. when the remote archive was replaced). */
  static async clear(): Promise<void> {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => {});
  }
}

