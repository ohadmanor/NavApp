import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WORKSPACE_DIR, ensureWorkspace, formatBytes } from '../paths.js';
import type { CountrySpec, LogLevel } from '../types.js';

export interface PbfCacheMeta {
  url: string;
  etag?: string;
  lastModified?: string;
  sizeBytes: number;
  md5?: string;
  downloadedAt: string;
}

export interface PbfDownloadResult {
  pbfPath: string;
  sizeBytes: number;
  fromCache: boolean;
  md5Verified: boolean;
}

type Logger = (level: LogLevel, message: string) => void;

export function getPbfPaths(country: CountrySpec): { pbfPath: string; metaPath: string } {
  const fileName = `${country.key}-latest.osm.pbf`;
  return {
    pbfPath: path.join(WORKSPACE_DIR, fileName),
    metaPath: path.join(WORKSPACE_DIR, `${fileName}.meta.json`),
  };
}

export function readPbfCacheMeta(metaPath: string): PbfCacheMeta | null {
  try {
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PbfCacheMeta;
  } catch {
    return null;
  }
}

async function computeFileMd5(filePath: string): Promise<string> {
  const hash = crypto.createHash('md5');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function fetchExpectedMd5(md5Url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(md5Url, { signal });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    const match = /^([a-fA-F0-9]{32})/.exec(text);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function downloadCountryPbf(
  country: CountrySpec,
  options: { forceDownload?: boolean; signal?: AbortSignal; log: Logger }
): Promise<PbfDownloadResult> {
  ensureWorkspace();
  const { pbfPath, metaPath } = getPbfPaths(country);
  const existingMeta = readPbfCacheMeta(metaPath);

  if (!options.forceDownload && fs.existsSync(pbfPath) && existingMeta?.url === country.pbfUrl) {
    try {
      const head = await fetch(country.pbfUrl, { method: 'HEAD', signal: options.signal });
      const remoteEtag = head.headers.get('etag') || undefined;
      const remoteLen = Number(head.headers.get('content-length') || 0);
      if (
        head.ok &&
        ((remoteEtag && existingMeta.etag && remoteEtag === existingMeta.etag) ||
          (remoteLen > 0 && remoteLen === fs.statSync(pbfPath).size))
      ) {
        options.log('info', `Using cached ${path.basename(pbfPath)} (${formatBytes(fs.statSync(pbfPath).size)}, ETag/size unchanged).`);
        return {
          pbfPath,
          sizeBytes: fs.statSync(pbfPath).size,
          fromCache: true,
          md5Verified: Boolean(existingMeta.md5),
        };
      }
    } catch {
      options.log('warn', 'Could not reach upstream for HEAD check; re-downloading PBF.');
    }
  }

  options.log('info', `Downloading ${country.name} PBF from ${country.pbfUrl}...`);
  const tmpPath = `${pbfPath}.part`;
  const existingPartBytes = !options.forceDownload && fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;

  const headers: Record<string, string> = {};
  if (existingPartBytes > 0) {
    headers['Range'] = `bytes=${existingPartBytes}-`;
    options.log('info', `Resuming partial download from ${formatBytes(existingPartBytes)}...`);
  }

  const res = await fetch(country.pbfUrl, { headers, signal: options.signal });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Failed to download PBF: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error('PBF download response has no body.');
  }

  const isResume = res.status === 206 && existingPartBytes > 0;
  const totalBytes = Number(res.headers.get('content-length') || 0) + (isResume ? existingPartBytes : 0);
  let downloadedBytes = isResume ? existingPartBytes : 0;
  let lastLoggedPct = -1;

  const writeStream = fs.createWriteStream(tmpPath, { flags: isResume ? 'a' : 'w' });
  const nodeReadable = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  nodeReadable.on('data', (chunk: Buffer) => {
    downloadedBytes += chunk.length;
    if (totalBytes > 0) {
      const pct = Math.floor((downloadedBytes / totalBytes) * 10) * 10;
      if (pct !== lastLoggedPct && pct % 20 === 0) {
        lastLoggedPct = pct;
        options.log('info', `Downloading PBF: ${pct}% (${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)})`);
      }
    }
  });

  await pipeline(nodeReadable, writeStream, { signal: options.signal });

  let md5Verified = false;
  let actualMd5: string | undefined;
  if (country.md5Url) {
    const expectedMd5 = await fetchExpectedMd5(country.md5Url, options.signal);
    if (expectedMd5) {
      options.log('info', 'Verifying PBF MD5 checksum...');
      actualMd5 = await computeFileMd5(tmpPath);
      if (actualMd5 !== expectedMd5) {
        fs.unlinkSync(tmpPath);
        throw new Error(`MD5 mismatch for ${country.key}: expected ${expectedMd5}, got ${actualMd5}`);
      }
      md5Verified = true;
      options.log('info', `MD5 verified (${actualMd5}).`);
    }
  }

  fs.renameSync(tmpPath, pbfPath);
  const sizeBytes = fs.statSync(pbfPath).size;
  const meta: PbfCacheMeta = {
    url: country.pbfUrl,
    etag: res.headers.get('etag') || undefined,
    lastModified: res.headers.get('last-modified') || undefined,
    sizeBytes,
    md5: actualMd5,
    downloadedAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  options.log('info', `Saved ${path.basename(pbfPath)} (${formatBytes(sizeBytes)}).`);

  return { pbfPath, sizeBytes, fromCache: false, md5Verified };
}
