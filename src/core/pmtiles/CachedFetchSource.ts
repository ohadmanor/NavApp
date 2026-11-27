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
  /** Optional ordered mirror URLs tried automatically if the active URL fails or times out. */
  fallbackUrls?: readonly string[];
  /** Optional canonical Cache Storage namespace shared across mirrors of the same immutable archive. */
  cacheKey?: string;
  /** Optional per-request timeout in ms (defaults to REMOTE_FETCH_TIMEOUT_MS). */
  requestTimeoutMs?: number;
  /** Optional short timeout in ms for offset-0 header checks when fallback mirrors exist. */
  headerTimeoutMs?: number;
}

export class CachedFetchSource implements Source {
  private inner: FetchSource;
  private inFlight = new Map<
    string,
    { promise: Promise<RangeResponse>; controller: AbortController; refs: number }
  >();
  private cachePromise: Promise<Cache | null> | null = null;
  private immutable: boolean;
  private readonly urls: string[];
  private activeUrlIndex = 0;
  private readonly cacheNamespace: string;
  private readonly requestTimeoutMs: number;
  private readonly headerTimeoutMs: number;
  private expectedTotalBytes: number | null = null;

  constructor(private url: string, options: CachedFetchSourceOptions = {}) {
    this.inner = new FetchSource(url);
    this.immutable = Boolean(options.immutable);
    this.urls = Array.from(new Set([url, ...(options.fallbackUrls ?? [])].filter(Boolean)));
    this.cacheNamespace = options.cacheKey || url;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REMOTE_FETCH_TIMEOUT_MS;
    this.headerTimeoutMs =
      options.headerTimeoutMs ?? (this.urls.length > 1 ? 3500 : this.requestTimeoutMs);
  }

  getKey(): string {
    return this.url;
  }

  supportsUrl(targetUrl: string): boolean {
    return this.urls.includes(targetUrl);
  }

  preferUrl(targetUrl: string): void {
    const idx = this.urls.indexOf(targetUrl);
    if (idx >= 0) {
      this.activeUrlIndex = idx;
    }
  }

  getActiveUrl(): string {
    return this.urls[this.activeUrlIndex] ?? this.url;
  }

  async hasCachedHeader(): Promise<boolean> {
    const cache = await this.getCache();
    if (!cache) return false;
    try {
      const hit = await cache.match(this.cacheRequest(0, 16384));
      return Boolean(hit);
    } catch {
      return false;
    }
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
      `https://pmtiles-range-cache.invalid/${encodeURIComponent(this.cacheNamespace)}/${offset}-${length}`
    );
  }

  private parseContentRangeTotal(headers: Headers): number | null {
    const cr = headers.get('content-range');
    if (!cr) return null;
    const slash = cr.lastIndexOf('/');
    if (slash < 0) return null;
    const total = Number(cr.slice(slash + 1).trim());
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  private async fetchDirectRangeForUrl(
    targetUrl: string,
    offset: number,
    length: number,
    signal: AbortSignal,
    etag?: string,
    cacheModeOverride?: RequestCache
  ): Promise<RangeResponse> {
    const customRange = usesCustomAndroidRangeHeader(targetUrl);
    const cacheMode: RequestCache | undefined =
      cacheModeOverride ??
      (customRange || (this.inner as any).mustReload || (this.inner as any).chromeWindowsNoCache
        ? 'no-store'
        : undefined);

    let resp = await fetch(targetUrl, {
      signal,
      cache: cacheMode,
      headers: buildRangeHeaders(targetUrl, offset, offset + length - 1),
    });

    if (offset === 0 && resp.status === 416) {
      const contentRange = resp.headers.get('Content-Range');
      if (!contentRange || !contentRange.startsWith('bytes */')) {
        throw new Error('Missing content-length on 416 response');
      }
      const actualLength = +contentRange.slice(8);
      resp = await fetch(targetUrl, {
        signal,
        cache: 'no-store',
        headers: buildRangeHeaders(targetUrl, 0, Math.max(0, actualLength - 1)),
      });
    }

    let newEtag = resp.headers.get('Etag');
    if (newEtag?.startsWith('W/')) {
      newEtag = null;
    }

    if (resp.status === 416 || (etag && newEtag && newEtag !== etag && !this.immutable)) {
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

    const mirrorTotal = this.parseContentRangeTotal(resp.headers);
    if (mirrorTotal !== null) {
      if (this.expectedTotalBytes !== null && mirrorTotal !== this.expectedTotalBytes) {
        throw new Error(
          `Mirror archive size mismatch for ${targetUrl}: ${mirrorTotal} !== ${this.expectedTotalBytes}`
        );
      }
      if (this.expectedTotalBytes === null) {
        this.expectedTotalBytes = mirrorTotal;
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

  private getOrderedUrlIndices(): number[] {
    const start = this.activeUrlIndex;
    const indices = [start];
    for (let i = 0; i < this.urls.length; i++) {
      if (i !== start) indices.push(i);
    }
    return indices;
  }

  private async fetchWithMirrorFailover(
    offset: number,
    length: number,
    sharedSignal: AbortSignal,
    etag?: string,
    cacheModeOverride?: RequestCache
  ): Promise<RangeResponse> {
    const perAttemptTimeoutMs =
      offset === 0 && !etag ? this.headerTimeoutMs : this.requestTimeoutMs;
    const orderedIndices = this.getOrderedUrlIndices();
    let lastError: unknown;

    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        await new Promise((r) => setTimeout(r, TRANSIENT_RETRY_DELAY_MS));
        if (sharedSignal.aborted) {
          throw lastError ?? new DOMException('The operation was aborted.', 'AbortError');
        }
      }

      for (const idx of orderedIndices) {
        if (sharedSignal.aborted) {
          throw lastError ?? new DOMException('The operation was aborted.', 'AbortError');
        }
        const targetUrl = this.urls[idx];
        const useInnerSingle =
          this.urls.length === 1 &&
          !usesCustomAndroidRangeHeader(targetUrl) &&
          cacheModeOverride === undefined;
        const timeoutSignal = createTimeoutSignal(sharedSignal, perAttemptTimeoutMs);

        try {
          let res: RangeResponse;
          if (useInnerSingle) {
            res = await this.inner.getBytes(offset, length, timeoutSignal, etag);
            if (!res?.data || !isValidRangeLength(offset, length, res.data.byteLength)) {
              throw new Error(
                `Unexpected range byte length (${res?.data?.byteLength ?? 0} for ${offset}+${length})`
              );
            }
            if (offset === 0) {
              validatePmtilesMagicAtOffset0(res.data);
            }
          } else {
            res = await this.fetchDirectRangeForUrl(
              targetUrl,
              offset,
              length,
              timeoutSignal,
              etag,
              pass > 0 ? 'no-store' : cacheModeOverride
            );
          }

          if (idx !== this.activeUrlIndex) {
            this.activeUrlIndex = idx;
          }
          return res;
        } catch (err: any) {
          lastError = err;
          if (sharedSignal.aborted) {
            throw err;
          }
          const msg = String(err?.message || '');
          if (!this.immutable && (err instanceof EtagMismatch || /ETagMismatch/i.test(err?.name || msg))) {
            throw err;
          }
          if (this.urls.length === 1 && /Bad response code: 40[0134]/i.test(msg)) {
            throw err;
          }
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Range fetch failed'));
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
        try {
          const fresh = await this.fetchWithMirrorFailover(0, length, sharedSignal, undefined, 'no-store');
          const prevEtag = cachedHit?.headers.get('x-etag') || undefined;

          if (!this.immutable && cachedHit && fresh.etag && prevEtag !== fresh.etag) {
            // Remote archive changed — drop all cached directory/tile ranges before writing new header
            await CachedFetchSource.clear();
            this.cachePromise = null;
            cache = cacheable ? await this.getCache() : null;
          }
          if (cache && fresh.data.byteLength > 0) {
            cache
              .put(
                req,
                new Response(fresh.data.slice(0), {
                  headers: fresh.etag ? { 'x-etag': fresh.etag } : {},
                })
              )
              .catch(() => {});
          }
          return fresh;
        } catch (err: any) {
          if (err?.name === 'AbortError' && sharedSignal.aborted) throw err;
          const validHit = await readValidCachedHit();
          if (validHit) return validHit;
          throw err;
        }
      }

      const validHit = await readValidCachedHit();
      if (validHit) return validHit;

      const res = await this.fetchWithMirrorFailover(offset, length, sharedSignal, etag);

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

