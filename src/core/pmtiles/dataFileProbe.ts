import {
  getCustomDataOrigin,
  getCustomDemPmtilesUrl,
  isLocalDevServer,
  REMOTE_DATA_FALLBACK_ORIGIN,
  REMOTE_DATA_ORIGIN,
  wrapAndroidRemoteProxyUrl,
} from '../dataUrls';

export interface LocalDataServerProbe {
  url: string;
  versionedUrl: string;
  size: number;
  etag?: string;
  lastModifiedMs?: number;
}

export interface RemoteDataProbe {
  size: number;
  etag?: string;
  url: string;
}

export interface StoredDataFileMeta {
  size: number;
  etag?: string;
}

export function readDataFileMeta(fileName: string): StoredDataFileMeta | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return JSON.parse(localStorage.getItem(`pmtiles-meta:${fileName}`) || 'null');
  } catch {
    return null;
  }
}

export function writeDataFileMeta(fileName: string, meta: StoredDataFileMeta): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(`pmtiles-meta:${fileName}`, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

export function clearDataFileMeta(fileName: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(`pmtiles-meta:${fileName}`);
  } catch {
    /* ignore */
  }
}

const LOCAL_PROBE_TIMEOUT_MS = 4000;
const REMOTE_PROBE_TIMEOUT_MS = 10000;

export async function probeLocalDataServer(
  fileName: string
): Promise<LocalDataServerProbe | null> {
  if (!isLocalDevServer() || typeof fetch !== 'function') {
    return null;
  }
  const localUrl = `${window.location.origin}/data/${fileName}`;
  try {
    const head = await fetch(localUrl, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS),
    });
    const contentType = head.headers.get('content-type') || '';
    if (!head.ok || contentType.includes('text/html')) {
      return null;
    }
    const size = Number(head.headers.get('content-length') || 0);
    const etag = head.headers.get('etag') || undefined;
    const lastModHeader = head.headers.get('last-modified');
    const parsedLastMod = lastModHeader ? Date.parse(lastModHeader) : NaN;
    const lastModifiedMs = Number.isFinite(parsedLastMod) ? parsedLastMod : undefined;
    const rawTag = etag
      ? etag.replace(/[^a-zA-Z0-9._-]/g, '')
      : size > 0 || lastModifiedMs
        ? `${size}-${lastModifiedMs || 0}`
        : '';
    const versionedUrl = rawTag ? `${localUrl}?v=${encodeURIComponent(rawTag)}` : localUrl;
    return { url: localUrl, versionedUrl, size, etag, lastModifiedMs };
  } catch {
    return null;
  }
}

async function tryHeadProbe(targetUrl: string): Promise<RemoteDataProbe | null> {
  const res = await fetch(targetUrl, {
    method: 'HEAD',
    cache: 'no-store',
    signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    return null;
  }
  const size = Number(res.headers.get('content-length') || 0);
  if (!size) return null;
  return {
    size,
    etag: res.headers.get('etag') || undefined,
    url: targetUrl,
  };
}

async function tryRangeProbe(targetUrl: string): Promise<RemoteDataProbe | null> {
  const res = await fetch(targetUrl, {
    headers: { Range: 'bytes=0-0' },
    cache: 'no-store',
    signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    return null;
  }
  const range = res.headers.get('content-range');
  const size = range ? Number(range.split('/')[1]) : Number(res.headers.get('content-length') || 0);
  if (!size) return null;
  return {
    size,
    etag: res.headers.get('etag') || undefined,
    url: targetUrl,
  };
}

/**
 * Probes Firebase Hosting for a data file's true uncompressed size & ETag.
 * Uses HEAD first for compressed text formats (.geojson/.idx) so CDN gzip Content-Range
 * doesn't report the compressed byte length instead of the decoded byte length.
 */
export async function probeRemoteDataFile(
  fileName: string,
  options: { preferHead?: boolean } = {}
): Promise<RemoteDataProbe | null> {
  if (typeof fetch !== 'function') return null;
  const isPmtiles = fileName.toLowerCase().endsWith('.pmtiles');
  const preferHead = options.preferHead ?? !isPmtiles;

  const candidateUrls: string[] = [];
  if (fileName === 'Israel.dem.pmtiles') {
    const customDemUrl = getCustomDemPmtilesUrl();
    if (customDemUrl) {
      candidateUrls.push(wrapAndroidRemoteProxyUrl(fileName, customDemUrl));
    }
  }
  const customOrigin = getCustomDataOrigin();
  const origins = customOrigin
    ? [customOrigin]
    : [REMOTE_DATA_ORIGIN, REMOTE_DATA_FALLBACK_ORIGIN];
  for (const origin of origins) {
    if (origin) candidateUrls.push(`${origin}/data/${fileName}`);
  }

  for (const targetUrl of candidateUrls) {
    try {
      const first = preferHead ? await tryHeadProbe(targetUrl) : await tryRangeProbe(targetUrl);
      if (first) return first;
      // Avoid falling back to HEAD on large .pmtiles files if Range already failed/returned non-OK
      if (!isPmtiles) {
        const second = await tryRangeProbe(targetUrl);
        if (second) return second;
      }
    } catch {
      // try next candidate URL
    }
  }
  return null;
}
