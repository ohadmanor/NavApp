import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const DEPLOY_DATA_DIR = path.join(ROOT_DIR, 'deploy_data', 'data');
export const SYNC_META_PATH = path.join(DATA_DIR, '.firebase-sync-meta.json');

export const REMOTE_DATA_ORIGIN = 'https://navapp-israel-topo-data.web.app';
export const REMOTE_DATA_FALLBACK_ORIGIN = 'https://navapp-israel-topo.web.app';

export const MAP_DATA_FILES = [
  {
    key: 'dem',
    fileName: 'Israel.dem.pmtiles',
    label: 'Terrain DEM (10m/50m contours & hillshade)',
    kind: 'pmtiles',
    constant: true,
  },
  {
    key: 'osm',
    fileName: 'Israel.osm.pmtiles',
    label: 'OpenMapTiles Vector Map',
    kind: 'pmtiles',
    constant: false,
  },
  {
    key: 'pois',
    fileName: 'Israel.pois.geojson',
    label: 'Curated & OSM POIs',
    kind: 'geojson',
    constant: false,
  },
  {
    key: 'offroad',
    fileName: 'Israel.offroad.pois.geojson',
    label: 'Off-Road.io Community POIs',
    kind: 'geojson',
    constant: false,
  },
  {
    key: 'search',
    fileName: 'Israel.search.idx',
    label: 'Full-Map PMTiles Search Index',
    kind: 'idx',
    constant: false,
  },
];

export function findDataFileSpec(nameOrKey) {
  const q = String(nameOrKey || '').trim().toLowerCase();
  return MAP_DATA_FILES.find(
    (item) => item.key === q || item.fileName.toLowerCase() === q
  );
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function readSyncMeta() {
  try {
    if (!fs.existsSync(SYNC_META_PATH)) return {};
    return JSON.parse(fs.readFileSync(SYNC_META_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function writeSyncMeta(meta) {
  fs.mkdirSync(path.dirname(SYNC_META_PATH), { recursive: true });
  fs.writeFileSync(SYNC_META_PATH, JSON.stringify(meta, null, 2), 'utf8');
}

export function isValidLocalDataFile(filePath, fileName) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 20) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      if (n < 2) return false;
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.pmtiles')) {
        return n >= 7 && buf.subarray(0, 7).toString('ascii') === 'PMTiles';
      }
      if (lower.endsWith('.geojson')) {
        const trimmed = buf.subarray(0, n).toString('utf8').trimStart();
        return trimmed.startsWith('{');
      }
      if (lower.endsWith('.idx')) {
        return (buf[0] === 0x1f && buf[1] === 0x8b) || buf.subarray(0, n).toString('utf8').trimStart().startsWith('{');
      }
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function requestHeadersOnce(urlStr, method, headers = {}, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const req = https.request(
      urlStr,
      {
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', () => {
      resolve(null);
    });
    req.end();
  });
}

export async function probeRemoteDataFile(fileName) {
  const origins = [REMOTE_DATA_ORIGIN, REMOTE_DATA_FALLBACK_ORIGIN];
  for (const origin of origins) {
    const url = `${origin}/data/${encodeURIComponent(fileName)}`;
    const head = await requestHeadersOnce(url, 'HEAD', {
      'Accept-Encoding': 'identity',
      'Cache-Control': 'no-cache',
    });
    if (!head || head.statusCode < 200 || head.statusCode >= 300) {
      continue;
    }
    const contentType = String(head.headers['content-type'] || '');
    if (contentType.includes('text/html')) {
      continue;
    }
    const size = Number(head.headers['content-length'] || 0);
    const etag = typeof head.headers.etag === 'string' ? head.headers.etag : undefined;
    const lastModified =
      typeof head.headers['last-modified'] === 'string' ? head.headers['last-modified'] : undefined;
    if (size > 0) {
      return { url, size, etag, lastModified };
    }
  }
  return null;
}

export async function downloadRemoteDataFile(fileName, destPath, remoteInfo) {
  const remote = remoteInfo || (await probeRemoteDataFile(fileName));
  if (!remote) {
    throw new Error(`Remote file not found on Firebase Hosting: ${fileName}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp`;
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  const acceptEncoding = fileName.endsWith('.geojson') ? 'gzip, identity' : 'identity';

  await new Promise((resolve, reject) => {
    const followUrl = (currentUrl, redirectsLeft) => {
      const req = https.get(
        currentUrl,
        {
          headers: {
            'Accept-Encoding': acceptEncoding,
            'Cache-Control': 'no-cache',
          },
          timeout: 60000,
        },
        (res) => {
          const code = res.statusCode || 0;
          if ((code === 301 || code === 302 || code === 307 || code === 308) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            followUrl(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
            return;
          }
          if (code < 200 || code >= 300) {
            res.resume();
            reject(new Error(`HTTP ${code} downloading ${fileName}`));
            return;
          }
          const contentType = String(res.headers['content-type'] || '');
          if (contentType.includes('text/html')) {
            res.resume();
            reject(new Error(`Received HTML fallback instead of ${fileName}`));
            return;
          }

          const isGzip = String(res.headers['content-encoding'] || '').toLowerCase().includes('gzip');
          const wireTotal = Number(res.headers['content-length'] || 0) || remote.size;
          const outStream = fs.createWriteStream(tmpPath);
          let wireLoaded = 0;
          let decodedLoaded = 0;
          let lastPrint = 0;

          const printProgress = (force = false) => {
            const now = Date.now();
            if (!force && now - lastPrint < 300) return;
            lastPrint = now;
            const pct = wireTotal > 0 ? Math.min(100, Math.round((wireLoaded / wireTotal) * 100)) : 0;
            process.stdout.write(
              `\r  Downloading ${fileName}: ${formatBytes(decodedLoaded || wireLoaded)} (${pct}%)   `
            );
          };

          res.on('data', (chunk) => {
            wireLoaded += chunk.length;
            if (!isGzip) decodedLoaded = wireLoaded;
            printProgress(false);
          });

          const finishWithCheck = () => {
            printProgress(true);
            process.stdout.write('\n');
            if (!isValidLocalDataFile(tmpPath, fileName)) {
              reject(new Error(`Downloaded file failed integrity validation: ${fileName}`));
              return;
            }
            const actualSize = fs.statSync(tmpPath).size;
            if (remote.size > 0 && actualSize !== remote.size) {
              reject(new Error(`Incomplete download for ${fileName}: ${actualSize} of ${remote.size} bytes`));
              return;
            }
            resolve();
          };

          outStream.on('error', reject);
          res.on('error', reject);

          if (isGzip) {
            const gunzip = zlib.createGunzip();
            gunzip.on('data', (chunk) => {
              decodedLoaded += chunk.length;
            });
            gunzip.on('error', reject);
            outStream.on('finish', finishWithCheck);
            res.pipe(gunzip).pipe(outStream);
          } else {
            outStream.on('finish', finishWithCheck);
            res.pipe(outStream);
          }
        }
      );
      req.on('timeout', () => req.destroy(new Error(`Timeout downloading ${fileName}`)));
      req.on('error', reject);
    };

    followUrl(remote.url, 3);
  });

  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath);
  }
  fs.renameSync(tmpPath, destPath);
  return {
    size: fs.statSync(destPath).size,
    etag: remote.etag,
  };
}
