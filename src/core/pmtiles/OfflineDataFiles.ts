import { remoteDataUrl } from '../dataUrls';
import { OpfsStorageAdapter } from './OpfsStorageAdapter';
import { NativeOfflineStorage } from './NativeOfflineStorage';
import {
  clearDataFileMeta,
  probeLocalDataServer,
  probeRemoteDataFile,
  readDataFileMeta,
  writeDataFileMeta,
} from './dataFileProbe';

export const OFFLINE_DATA_FILE_NAMES = [
  'Israel.pois.geojson',
  'Israel.offroad.pois.geojson',
  'Israel.search.idx',
] as const;

export type OfflineDataFileName = (typeof OFFLINE_DATA_FILE_NAMES)[number];

export interface OfflineDataFileSpec {
  fileName: OfflineDataFileName;
  labelHe: string;
  defaultSizeBytes: number;
}

export const OFFLINE_DATA_FILE_SPECS: readonly OfflineDataFileSpec[] = [
  {
    fileName: 'Israel.pois.geojson',
    labelHe: 'נקודות עניין רשמיות (OSM)',
    defaultSizeBytes: 4_336_165,
  },
  {
    fileName: 'Israel.offroad.pois.geojson',
    labelHe: 'נקודות עניין קהילת שטח (Off-Road)',
    defaultSizeBytes: 20_481_927,
  },
  {
    fileName: 'Israel.search.idx',
    labelHe: 'אינדקס חיפוש מפה (Search)',
    defaultSizeBytes: 2_294_069,
  },
];

export type DataFileStorageKind =
  | 'native-file'
  | 'opfs'
  | 'local-server'
  | 'remote-url';

export interface OfflineDataFileItemStatus {
  fileName: OfflineDataFileName;
  local: boolean;
  storageKind: DataFileStorageKind;
  sizeBytes: number;
  lastModifiedMs?: number;
}

export interface OfflineDataBundleStatus {
  allLocal: boolean;
  anyLocal: boolean;
  storageKind: DataFileStorageKind;
  totalBytes: number;
  files: OfflineDataFileItemStatus[];
}

export type DataFileUpdatedListener = (fileName: OfflineDataFileName) => void;

const FAIL_BACKOFF_MS = 6 * 3600 * 1000;

function isValidPayloadBuffer(fileName: OfflineDataFileName, buf: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength < 20) return false;
  if (fileName.endsWith('.idx')) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  }
  // Skip UTF-8 BOM / whitespace and check for JSON object opening '{'
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < Math.min(bytes.length, 64)) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
      i++;
      continue;
    }
    return b === 0x7b; // '{'
  }
  return false;
}

function readFailTimestamp(key: string): number {
  try {
    if (typeof localStorage === 'undefined') return 0;
    return Number(localStorage.getItem(key) || 0);
  } catch {
    return 0;
  }
}

function writeFailTimestamp(key: string, ts: number | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (ts === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(ts));
  } catch {
    /* ignore */
  }
}

/**
 * Manages Firebase-hosted POI GeoJSON & search index data files with the exact same
 * offline-first & remote-update model as PMTiles archives:
 *  - Android Native: stored in shared `filesDir/maps/{fileName}` (WebView + Android Auto)
 *  - Web: stored in OPFS `maps/{fileName}`
 *  - Fallback/Initial load: streamed from Vite `/data/` in dev or Firebase `navapp-israel-topo-data.web.app`
 *  - Automatic background size/ETag update checks against Firebase Hosting
 */
export class OfflineDataFilesManager {
  private updateListeners = new Set<DataFileUpdatedListener>();
  private inFlightUpdates = new Map<OfflineDataFileName, Promise<void>>();
  private checkedThisSession = new Set<OfflineDataFileName>();

  onDataFileUpdated(listener: DataFileUpdatedListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  private notifyUpdated(fileName: OfflineDataFileName): void {
    for (const listener of this.updateListeners) {
      try {
        listener(fileName);
      } catch {
        /* ignore listener error */
      }
    }
  }

  private async loadRawPayload<T = any>(
    fileName: OfflineDataFileName
  ): Promise<{ bytes: ArrayBuffer } | { json: T } | null> {
    if (NativeOfflineStorage.isAndroidNative()) {
      const nativeStatus = await NativeOfflineStorage.getArchiveStatus();
      const fileStatus = nativeStatus?.files?.[fileName];
      if (fileStatus?.exists && fileStatus.valid && fileStatus.sizeBytes > 0) {
        try {
          const nativeUrl = `${fileStatus.nativeUrl}?v=${fileStatus.lastModifiedMs || Date.now()}`;
          const res = await fetch(nativeUrl, { cache: 'no-store' });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            if (isValidPayloadBuffer(fileName, buf)) {
              void this.checkForRemoteUpdateInBackground(fileName, fileStatus.sizeBytes);
              return { bytes: buf };
            }
          }
        } catch {
          // Fall through to OPFS / network
        }
      }

      const legacyOpfs = await OpfsStorageAdapter.getStoredFile(fileName).catch(() => null);
      if (legacyOpfs && legacyOpfs.size > 0) {
        const buf = await legacyOpfs.arrayBuffer();
        if (isValidPayloadBuffer(fileName, buf)) {
          void this.migrateFileToNativeInBackground(fileName, legacyOpfs);
          void this.checkForRemoteUpdateInBackground(fileName, legacyOpfs.size);
          return { bytes: buf };
        }
      }

      const remote = await probeRemoteDataFile(fileName, { preferHead: true });
      if (remote) {
        try {
          const saved = await NativeOfflineStorage.downloadArchive(
            fileName,
            remote.url,
            remote.size
          );
          writeDataFileMeta(fileName, { size: remote.size || saved.sizeBytes, etag: remote.etag });
          await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
          const nativeRes = await fetch(`${saved.nativeUrl}?v=${saved.lastModifiedMs || Date.now()}`, {
            cache: 'no-store',
          });
          if (nativeRes.ok) {
            const buf = await nativeRes.arrayBuffer();
            if (isValidPayloadBuffer(fileName, buf)) {
              return { bytes: buf };
            }
          }
        } catch (err) {
          console.warn(`[OfflineDataFiles] Native download fallback for ${fileName}:`, err);
        }
      }
    }

    const opfsSupported = OpfsStorageAdapter.isSupported();
    const [opfsFile, localServer] = await Promise.all([
      opfsSupported ? OpfsStorageAdapter.getStoredFile(fileName).catch(() => null) : Promise.resolve(null),
      probeLocalDataServer(fileName),
    ]);

    if (opfsFile && opfsFile.size > 0) {
      const localSizeDiffers =
        !!localServer && localServer.size > 0 && localServer.size !== opfsFile.size;
      const localServerNewer =
        !!localServer &&
        !!localServer.lastModifiedMs &&
        !!opfsFile.lastModified &&
        localServer.lastModifiedMs > opfsFile.lastModified + 2000;

      if (localServer && (localSizeDiffers || localServerNewer)) {
        await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
      } else {
        const buf = await opfsFile.arrayBuffer();
        if (isValidPayloadBuffer(fileName, buf)) {
          if (!localServer) {
            void this.checkForRemoteUpdateInBackground(fileName, opfsFile.size);
          }
          return { bytes: buf };
        }
        await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
      }
    }

    if (typeof fetch !== 'function') {
      return null;
    }

    const targetUrl = localServer ? localServer.versionedUrl : remoteDataUrl(fileName);
    try {
      const res = await fetch(targetUrl, {
        cache: localServer ? 'no-store' : 'default',
      });
      if (!res.ok) return null;
      const contentType = res.headers?.get?.('content-type') || '';
      if (contentType.includes('text/html')) return null;

      if (typeof res.arrayBuffer !== 'function') {
        if (typeof (res as any).json === 'function') {
          return { json: (await (res as any).json()) as T };
        }
        return null;
      }
      const buf = await res.arrayBuffer();
      if (!isValidPayloadBuffer(fileName, buf)) return null;

      if (opfsSupported && !localServer) {
        const etag = res.headers?.get?.('etag') || undefined;
        const mime = fileName.endsWith('.geojson') ? 'application/json' : 'application/octet-stream';
        const blob = new Blob([buf], { type: mime });
        void OpfsStorageAdapter.saveOrReplaceFromStream(fileName, blob)
          .then((saved) => {
            writeDataFileMeta(fileName, { size: saved.size || buf.byteLength, etag });
          })
          .catch(() => {});
      }

      return { bytes: buf };
    } catch {
      return null;
    }
  }

  async loadBytes(fileName: OfflineDataFileName): Promise<ArrayBuffer | null> {
    const res = await this.loadRawPayload(fileName);
    return res && 'bytes' in res ? res.bytes : null;
  }

  async loadJson<T = any>(fileName: 'Israel.pois.geojson' | 'Israel.offroad.pois.geojson'): Promise<T | null> {
    const res = await this.loadRawPayload<T>(fileName);
    if (!res) return null;
    if ('json' in res) return res.json;
    try {
      const text = new TextDecoder('utf-8').decode(res.bytes);
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async migrateFileToNativeInBackground(
    fileName: OfflineDataFileName,
    opfsFile: File
  ): Promise<void> {
    try {
      const saved = await NativeOfflineStorage.saveBlobChunked(fileName, opfsFile);
      if (saved?.exists && saved.valid) {
        await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
      }
    } catch {
      /* ignore migration failure */
    }
  }

  private checkForRemoteUpdateInBackground(
    fileName: OfflineDataFileName,
    localSize: number
  ): Promise<void> {
    if (this.checkedThisSession.has(fileName)) {
      return Promise.resolve();
    }
    const existing = this.inFlightUpdates.get(fileName);
    if (existing) return existing;

    const task = (async () => {
      try {
        const failKey = `data-dl-fail:${fileName}`;
        const lastFail = readFailTimestamp(failKey);
        if (lastFail && Date.now() - lastFail < FAIL_BACKOFF_MS) return;

        const remote = await probeRemoteDataFile(fileName, { preferHead: true });
        if (!remote) return;
        this.checkedThisSession.add(fileName);

        const meta = readDataFileMeta(fileName);
        const sameSize = remote.size === localSize;
        const sameEtag = !meta?.etag || !remote.etag || meta.etag === remote.etag;
        if (sameSize && sameEtag) {
          if (!meta) writeDataFileMeta(fileName, { size: remote.size, etag: remote.etag });
          return;
        }

        console.log(`[OfflineDataFiles] ${fileName} updated on Firebase. Downloading in background...`);
        await this.downloadSingleFile(fileName, remote);
        writeFailTimestamp(failKey, null);
        this.notifyUpdated(fileName);
      } catch (err) {
        writeFailTimestamp(`data-dl-fail:${fileName}`, Date.now());
        console.warn(`[OfflineDataFiles] Background update failed for ${fileName}:`, err);
      } finally {
        this.inFlightUpdates.delete(fileName);
      }
    })();

    this.inFlightUpdates.set(fileName, task);
    return task;
  }

  private async downloadSingleFile(
    fileName: OfflineDataFileName,
    knownRemote?: { size: number; etag?: string; url: string } | null,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<number> {
    const local = await probeLocalDataServer(fileName);
    const remote = local ? null : knownRemote || (await probeRemoteDataFile(fileName, { preferHead: true }));
    if (!local && !remote) {
      throw new Error(`Data file ${fileName} is not available locally or on Firebase Hosting.`);
    }

    if (NativeOfflineStorage.isAndroidNative()) {
      if (!remote) {
        throw new Error(`Data file ${fileName} is not available on Firebase Hosting.`);
      }
      const saved = await NativeOfflineStorage.downloadArchive(
        fileName,
        remote.url,
        remote.size,
        onProgress,
        signal
      );
      writeDataFileMeta(fileName, { size: remote.size || saved.sizeBytes, etag: remote.etag });
      await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
      return saved.sizeBytes;
    }

    if (!OpfsStorageAdapter.isSupported()) {
      throw new Error('Offline storage (OPFS) is not supported on this device/browser.');
    }

    const url = local ? local.versionedUrl : remote!.url;
    const expectedSize = local ? local.size : remote!.size;
    const etag = local ? local.etag : remote!.etag;
    const saved = await OpfsStorageAdapter.saveOrReplaceFromStream(
      fileName,
      url,
      onProgress,
      signal,
      expectedSize
    );
    writeDataFileMeta(fileName, { size: expectedSize || saved.size, etag });
    return saved.size;
  }

  async downloadOfflineBundle(
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<OfflineDataBundleStatus> {
    const probed = await Promise.all(
      OFFLINE_DATA_FILE_SPECS.map(async (spec) => {
        const local = await probeLocalDataServer(spec.fileName);
        const remote = local ? null : await probeRemoteDataFile(spec.fileName, { preferHead: true });
        return {
          spec,
          local,
          remote,
          size: local?.size || remote?.size || spec.defaultSizeBytes,
        };
      })
    );

    const totalAll = probed.reduce((acc, item) => acc + item.size, 0);
    let completedBefore = 0;

    for (const item of probed) {
      if (signal?.aborted) {
        const abortErr = new Error('Download aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (!item.local && !item.remote) {
        throw new Error(`Data file ${item.spec.fileName} is missing on Firebase Hosting.`);
      }
      const downloadedSize = await this.downloadSingleFile(
        item.spec.fileName,
        item.remote,
        (loaded) => {
          onProgress?.(Math.min(totalAll, completedBefore + loaded), totalAll);
        },
        signal
      );
      completedBefore += downloadedSize || item.size;
      onProgress?.(Math.min(totalAll, completedBefore), totalAll);
      this.notifyUpdated(item.spec.fileName);
    }

    return this.getBundleStatus();
  }

  async replaceLocalDataFile(
    fileName: OfflineDataFileName,
    file: File,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<OfflineDataBundleStatus> {
    const headBuf = await file.slice(0, 64).arrayBuffer();
    if (!isValidPayloadBuffer(fileName, headBuf)) {
      throw new Error(`הקובץ ${file.name} אינו בפורמט תקין עבור ${fileName}.`);
    }

    if (NativeOfflineStorage.isAndroidNative()) {
      const saved = await NativeOfflineStorage.saveBlobChunked(fileName, file, onProgress);
      await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
      writeDataFileMeta(fileName, { size: saved.sizeBytes });
    } else if (OpfsStorageAdapter.isSupported()) {
      const saved = await OpfsStorageAdapter.saveOrReplaceFromStream(fileName, file, onProgress);
      writeDataFileMeta(fileName, { size: saved.size });
    } else {
      throw new Error('Offline storage (OPFS) is not supported on this device/browser.');
    }

    this.notifyUpdated(fileName);
    return this.getBundleStatus();
  }

  async removeOfflineBundle(): Promise<void> {
    await Promise.all(
      OFFLINE_DATA_FILE_NAMES.map(async (fileName) => {
        await Promise.all([
          NativeOfflineStorage.removeArchive(fileName).catch(() => {}),
          OpfsStorageAdapter.removeFile(fileName).catch(() => {}),
        ]);
        clearDataFileMeta(fileName);
      })
    );
  }

  async getBundleStatus(): Promise<OfflineDataBundleStatus> {
    const isAndroid = NativeOfflineStorage.isAndroidNative();
    const nativeStatus = isAndroid ? await NativeOfflineStorage.getArchiveStatus() : null;
    const opfsSupported = OpfsStorageAdapter.isSupported();

    const files: OfflineDataFileItemStatus[] = await Promise.all(
      OFFLINE_DATA_FILE_SPECS.map(async (spec) => {
        if (isAndroid) {
          const ns = nativeStatus?.files?.[spec.fileName];
          if (ns?.exists && ns.valid && ns.sizeBytes > 0) {
            return {
              fileName: spec.fileName,
              local: true,
              storageKind: 'native-file' as const,
              sizeBytes: ns.sizeBytes,
              lastModifiedMs: ns.lastModifiedMs,
            };
          }
        }

        if (opfsSupported) {
          const opfsFile = await OpfsStorageAdapter.getStoredFile(spec.fileName).catch(() => null);
          if (opfsFile && opfsFile.size > 0) {
            return {
              fileName: spec.fileName,
              local: true,
              storageKind: 'opfs' as const,
              sizeBytes: opfsFile.size,
              lastModifiedMs: opfsFile.lastModified,
            };
          }
        }

        const localSrv = await probeLocalDataServer(spec.fileName);
        if (localSrv) {
          return {
            fileName: spec.fileName,
            local: false,
            storageKind: 'local-server' as const,
            sizeBytes: localSrv.size || spec.defaultSizeBytes,
            lastModifiedMs: localSrv.lastModifiedMs,
          };
        }

        return {
          fileName: spec.fileName,
          local: false,
          storageKind: 'remote-url' as const,
          sizeBytes: spec.defaultSizeBytes,
        };
      })
    );

    const allLocal = files.every((f) => f.local);
    const anyLocal = files.some((f) => f.local);
    const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    const storageKind: DataFileStorageKind = files.every((f) => f.storageKind === 'native-file')
      ? 'native-file'
      : files.every((f) => f.storageKind === 'opfs')
        ? 'opfs'
        : files.some((f) => f.storageKind === 'local-server')
          ? 'local-server'
          : 'remote-url';

    return { allLocal, anyLocal, storageKind, totalBytes, files };
  }
}

export const offlineDataFiles = new OfflineDataFilesManager();
