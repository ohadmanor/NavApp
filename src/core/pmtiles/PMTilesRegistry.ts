import maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import {
  PMTiles,
  Protocol,
  FetchSource,
  FileSource,
  SharedPromiseCache,
  type Header,
  type Source,
  type RangeResponse,
} from 'pmtiles';
import { db, type MapArchiveRecord } from '../db/NavDatabase';
import {
  getDemCandidateUrls,
  pmtilesUrl,
  REMOTE_DATA_FALLBACK_ORIGIN,
  REMOTE_DATA_ORIGIN,
  REMOTE_DEM_HOSTING_ORIGIN,
} from '../dataUrls';
import { OpfsStorageAdapter } from './OpfsStorageAdapter';
import { NativeOfflineStorage } from './NativeOfflineStorage';
import { CachedFetchSource } from './CachedFetchSource';
import { BundledAssetPMTilesSource } from './BundledAssetPMTilesSource';
import { WORLD_BASEMAP_ASSET_PATH } from '../style/worldGlobeStyle';
import {
  probeLocalDataServer,
  probeRemoteDataFile,
  readDataFileMeta,
  writeDataFileMeta,
} from './dataFileProbe';
import { registerOfflineGlyphsProtocol } from '../style/offlineGlyphsProtocol';
import { registerOfflineRtlTextPlugin } from '../style/hebrewBidiProcessor';
import { registerTacticalGridProtocol } from '../navigation/TacticalGridTileProtocol';

export interface MountedArchiveInfo {
  id: 'israel-dem' | 'israel-osm';
  protocolUrl: string;
  contourProtocolUrl?: string;
  pmtiles: PMTiles;
  record: MapArchiveRecord;
  vectorLayers: string[];
  hasTrailColorSchema?: boolean;
}

export type ArchiveUpdateListener = (
  id: 'israel-dem' | 'israel-osm',
  info: MountedArchiveInfo
) => void;

export type DownloadProgressListener = (
  fileName: string,
  loaded: number,
  total: number
) => void;

/**
 * SharedPromiseCache clears aborted pendingFetches, but leaves rejected promises
 * cached when getHeader/getDirectory fails transiently. Evict rejected entries so retries succeed.
 */
class TransientSafePromiseCache extends SharedPromiseCache {
  override async getHeader(source: Source): Promise<Header> {
    try {
      return await super.getHeader(source);
    } catch (err) {
      this.cache.delete(source.getKey());
      throw err;
    }
  }

  override async getDirectory(
    source: Source,
    offset: number,
    length: number,
    header: Header,
    signal?: AbortSignal
  ) {
    try {
      return await super.getDirectory(source, offset, length, header, signal);
    } catch (err) {
      const cacheKey = `${source.getKey()}|${header.etag || ''}|${offset}|${length}`;
      this.cache.delete(cacheKey);
      (this as any).pendingFetches?.delete?.(cacheKey);
      throw err;
    }
  }
}

const EMPTY_TERRARIUM_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAA1UlEQVR42u3BMQEAAADCoPVP7WULoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAGwEtAAGey8LtAAAAAElFTkSuQmCC';

let cachedEmptyTerrariumBlob: Blob | null = null;

/**
 * Valid 256x256 RGB(0,0,0) PNG representing -32768m in Terrarium encoding.
 * maplibre-contour treats elevations below -12000m as invalid (NaN) and skips them cleanly
 * without failing neighboring valid tiles along borders or coastlines.
 */
export function getEmptyTerrariumTileBlob(): Blob {
  if (!cachedEmptyTerrariumBlob) {
    const raw =
      typeof atob === 'function'
        ? atob(EMPTY_TERRARIUM_PNG_BASE64)
        : Buffer.from(EMPTY_TERRARIUM_PNG_BASE64, 'base64').toString('binary');
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    cachedEmptyTerrariumBlob = new Blob([bytes], { type: 'image/png' });
  }
  return cachedEmptyTerrariumBlob;
}

/**
 * Wraps LocalDemManager.fetchContourTile so each response returns an independent ArrayBuffer copy.
 * MapLibre transfers protocol response ArrayBuffers to its Web Worker via postMessage (detaching them);
 * without slicing, subsequent loads of cached tiles (style reload, theme switch, pan-back) receive a
 * detached 0-byte ArrayBuffer and fail with "ArrayBuffer at index 0 is already detached".
 */
export function wrapManagerWithSafeContourBuffers(manager: any): void {
  if (!manager || typeof manager.fetchContourTile !== 'function' || manager.__navappSafeContours) {
    return;
  }
  const rawFetchContourTile = manager.fetchContourTile.bind(manager);
  manager.fetchContourTile = async (
    z: number,
    x: number,
    y: number,
    options: any,
    parentAbortController?: AbortController,
    timer?: any
  ) => {
    const res = await rawFetchContourTile(z, x, y, options, parentAbortController, timer);
    if (!res || !res.arrayBuffer) {
      return { arrayBuffer: new ArrayBuffer(0) };
    }
    return {
      ...res,
      arrayBuffer: res.arrayBuffer.slice(0),
    };
  };
  manager.__navappSafeContours = true;
}

let contourDecodeCanvas: HTMLCanvasElement | null = null;
let contourDecodeCtx: CanvasRenderingContext2D | null = null;

function getContourDecodeContext(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  if (typeof document === 'undefined') return null;
  if (!contourDecodeCanvas) {
    contourDecodeCanvas = document.createElement('canvas');
    contourDecodeCtx = contourDecodeCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!contourDecodeCtx) return null;
  return { canvas: contourDecodeCanvas, ctx: contourDecodeCtx };
}

function decodeRgbaElevationGrid(
  width: number,
  height: number,
  encoding: string,
  rgba: Uint8ClampedArray
): { width: number; height: number; data: Float32Array } {
  const data = new Float32Array(width * height);
  if (encoding === 'mapbox') {
    for (let i = 0; i < rgba.length; i += 4) {
      data[i >> 2] =
        rgba[i + 3] === 0
          ? NaN
          : -10000 + (rgba[i] * 256 * 256 + rgba[i + 1] * 256 + rgba[i + 2]) * 0.1;
    }
  } else {
    for (let i = 0; i < rgba.length; i += 4) {
      data[i >> 2] =
        rgba[i + 3] === 0 ? NaN : rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
    }
  }
  return { width, height, data };
}

/**
 * Decodes Terrarium/Mapbox DEM PNG blobs using standard HTMLCanvasElement 2D readback and explicit
 * ImageBitmap disposal so Android System WebView VideoFrame / OffscreenCanvas driver quirks cannot hide contours.
 */
export async function decodeDemPngSafely(
  blob: Blob,
  encoding: string,
  abortController?: AbortController,
  fallbackDecoder?: (
    b: Blob,
    enc: string,
    ac?: AbortController
  ) => Promise<{ width: number; height: number; data: Float32Array } | null>
): Promise<{ width: number; height: number; data: Float32Array } | null> {
  if (abortController?.signal?.aborted) return null;
  const surface = getContourDecodeContext();
  if (!surface) {
    return fallbackDecoder ? fallbackDecoder(blob, encoding, abortController) : null;
  }

  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob);
      if (abortController?.signal?.aborted) return null;
      surface.canvas.width = bitmap.width;
      surface.canvas.height = bitmap.height;
      surface.ctx.clearRect(0, 0, bitmap.width, bitmap.height);
      surface.ctx.drawImage(bitmap, 0, 0);
      const rgba = surface.ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return decodeRgbaElevationGrid(bitmap.width, bitmap.height, encoding, rgba);
    } catch {
      // Fall through to <img> element decode below
    } finally {
      bitmap?.close?.();
    }
  }

  if (typeof Image !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = blob.size ? URL.createObjectURL(blob) : '';
      const cleanup = () => {
        if (objUrl) URL.revokeObjectURL(objUrl);
      };
      const onAbort = () => {
        img.src = '';
        cleanup();
        resolve(null);
      };
      abortController?.signal?.addEventListener('abort', onAbort, { once: true });
      img.onload = () => {
        abortController?.signal?.removeEventListener('abort', onAbort);
        cleanup();
        if (abortController?.signal?.aborted) {
          resolve(null);
          return;
        }
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          surface.canvas.width = w;
          surface.canvas.height = h;
          surface.ctx.clearRect(0, 0, w, h);
          surface.ctx.drawImage(img, 0, 0, w, h);
          const rgba = surface.ctx.getImageData(0, 0, w, h).data;
          resolve(decodeRgbaElevationGrid(w, h, encoding, rgba));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => {
        abortController?.signal?.removeEventListener('abort', onAbort);
        cleanup();
        reject(new Error('Could not decode DEM PNG image.'));
      };
      img.src = objUrl;
    });
  }

  return fallbackDecoder ? fallbackDecoder(blob, encoding, abortController) : null;
}

/**
 * Central PMTiles Engine managing the dual-file Israel architecture:
 *  1. Israel.dem.pmtiles (1.40 GB — CONSTANT / IMMUTABLE Terrarium 256px DEM)
 *     - Powers Hillshade, 3D Terrain, Dynamic 10m/50m Contour Lines, and Offline Elevation Sampling.
 *  2. Israel.osm.pmtiles (112.4 MB — UPDATABLE / HOT-SWAPPABLE OpenMapTiles Vector Archive)
 *     - Powers all 19 vector layers and can be updated/replaced at runtime without touching Israel.dem.pmtiles.
 */
export class PMTilesRegistry {
  private protocol: Protocol;
  private archives = new Map<string, PMTiles>();
  private mountedInfo = new Map<'israel-dem' | 'israel-osm', MountedArchiveInfo>();
  private isProtocolRegistered = false;
  private demContourSource: any = null;
  private activeDemPmtiles: PMTiles | null = null;
  private contourArchiveRef: PMTiles | null = null;
  private defaultContourProtocolUrl?: string;
  private updateListeners = new Set<ArchiveUpdateListener>();
  private progressListeners = new Set<DownloadProgressListener>();
  private activeAutoDownloads = new Set<string>();
  private autoDownloadQueue: Array<'israel-osm' | 'israel-dem'> = [];
  private isAutoDownloading = false;
  private forcedDownloads = new Set<string>();
  private migrationQueue: Promise<void> = Promise.resolve();
  private migratingArchives = new Set<string>();
  private demRemoteUnavailable = false;
  private defaultDemSource: CachedFetchSource | null = null;
  private demRetryPromise: Promise<MountedArchiveInfo | null> | null = null;
  private defaultInitPromise: Promise<{
    dem: MountedArchiveInfo | null;
    osm: MountedArchiveInfo | null;
  }> | null = null;

  constructor() {
    this.protocol = new Protocol({ metadata: true });
  }

  getDefaultOsmProtocolUrl(): string {
    return `pmtiles://${pmtilesUrl('Israel.osm.pmtiles')}`;
  }

  getDefaultDemProtocolUrl(): string {
    return `pmtiles://${pmtilesUrl('Israel.dem.pmtiles')}`;
  }

  getDefaultContourProtocolUrl(): string | undefined {
    return this.defaultContourProtocolUrl;
  }

  isDemUnavailable(): boolean {
    return this.demRemoteUnavailable;
  }

  private async assertPmtilesFileHeader(file: File): Promise<void> {
    if (!file || file.size < 64) {
      throw new Error('הקובץ שנבחר אינו קובץ PMTiles תקין.');
    }
    const magic = new Uint8Array(await file.slice(0, 7).arrayBuffer());
    const text = String.fromCharCode(...magic);
    if (text !== 'PMTiles') {
      throw new Error('הקובץ שנבחר אינו ארכיון PMTiles תקין (חסרה כותרת PMTiles).');
    }
  }

  private getDefaultWorldHttpUrl(): string {
    const origin =
      typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : REMOTE_DATA_ORIGIN;
    return `${origin}${WORLD_BASEMAP_ASSET_PATH}`;
  }

  /**
   * Constant bundled world globe base archive (`world-basemap.pmtiles`), immutable across
   * Israel OSM/DEM updates.
   */
  getDefaultWorldProtocolUrl(): string {
    return `pmtiles://${this.getDefaultWorldHttpUrl()}`;
  }

  private ensureBundledWorldBasemap(httpUrl: string): PMTiles {
    const existing = this.protocol.get(httpUrl);
    if (existing) return existing;

    const pmtiles = new PMTiles(
      new BundledAssetPMTilesSource(httpUrl),
      new TransientSafePromiseCache(400)
    );
    this.attachInMemoryTileCache(pmtiles, 600);
    this.protocol.add(pmtiles);
    (this.protocol as any).tiles?.set('world-basemap', pmtiles);
    return pmtiles;
  }

  onArchiveUpdated(listener: ArchiveUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onDownloadProgress(listener: DownloadProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  private notifyArchiveUpdated(id: 'israel-dem' | 'israel-osm', info: MountedArchiveInfo): void {
    for (const l of this.updateListeners) {
      try {
        l(id, info);
      } catch {}
    }
  }

  private notifyDownloadProgress(fileName: string, loaded: number, total: number): void {
    for (const l of this.progressListeners) {
      try {
        l(fileName, loaded, total);
      } catch {}
    }
  }

  private isRemoteArchiveUrl(url: string): boolean {
    return (
      url.includes('/__remote_proxy__/') ||
      url.startsWith(REMOTE_DATA_ORIGIN) ||
      url.startsWith(REMOTE_DATA_FALLBACK_ORIGIN) ||
      url.startsWith(REMOTE_DEM_HOSTING_ORIGIN) ||
      (url.startsWith('https://') &&
        (typeof window === 'undefined' || !url.startsWith(window.location?.origin || 'https://__none__')))
    );
  }

  private createDemRemoteSource(primaryUrl: string): CachedFetchSource {
    const fallbackUrls = getDemCandidateUrls().filter((u) => u !== primaryUrl);
    return new CachedFetchSource(primaryUrl, {
      immutable: true,
      fallbackUrls,
      cacheKey: 'immutable:Israel.dem.pmtiles',
      requestTimeoutMs: 8000,
      headerTimeoutMs: 3500,
    });
  }

  initProtocols(): void {
    if (this.isProtocolRegistered) return;
    const rawTileHandler = this.protocol.tile.bind(this.protocol) as any;
    maplibregl.addProtocol('pmtiles', ((params: any, arg2: any) => {
      const rawUrl = typeof params?.url === 'string' ? params.url : '';
      if (rawUrl.startsWith('pmtiles://')) {
        const stripped = rawUrl.slice('pmtiles://'.length).replace(/\/\d+\/\d+\/\d+$/, '');
        if (stripped.includes('world-basemap.pmtiles')) {
          this.ensureBundledWorldBasemap(stripped);
        }
      }
      return rawTileHandler(params, arg2);
    }) as any);
    this.ensureBundledWorldBasemap(this.getDefaultWorldHttpUrl());
    registerOfflineGlyphsProtocol();
    registerOfflineRtlTextPlugin();
    registerTacticalGridProtocol();

    // Pre-register default local (/data on localhost) or remote Firebase sources so MapLibre can stream immediately
    const defaultOsmUrl = pmtilesUrl('Israel.osm.pmtiles');
    const osmIsRemote = this.isRemoteArchiveUrl(defaultOsmUrl);
    const defaultOsmSource = osmIsRemote
      ? new CachedFetchSource(defaultOsmUrl, { immutable: false })
      : new FetchSource(defaultOsmUrl);
    const defaultOsmPmtiles = new PMTiles(defaultOsmSource, new TransientSafePromiseCache(1000));
    this.attachInMemoryTileCache(defaultOsmPmtiles, 400);
    this.protocol.add(defaultOsmPmtiles);
    (this.protocol as any).tiles?.set('israel-osm', defaultOsmPmtiles);
    if (!this.archives.has('israel-osm')) {
      this.archives.set('israel-osm', defaultOsmPmtiles);
    }

    const defaultDemUrl = pmtilesUrl('Israel.dem.pmtiles');
    const demIsRemote = this.isRemoteArchiveUrl(defaultDemUrl);
    const defaultDemSource = demIsRemote
      ? this.createDemRemoteSource(defaultDemUrl)
      : new FetchSource(defaultDemUrl);
    this.defaultDemSource = defaultDemSource instanceof CachedFetchSource ? defaultDemSource : null;
    const defaultDemPmtiles = new PMTiles(defaultDemSource, new TransientSafePromiseCache(1000));
    this.attachInMemoryTileCache(defaultDemPmtiles, 500);
    this.protocol.add(defaultDemPmtiles);
    (this.protocol as any).tiles?.set('israel-dem', defaultDemPmtiles);
    if (!this.archives.has('israel-dem')) {
      this.archives.set('israel-dem', defaultDemPmtiles);
    }
    this.activeDemPmtiles = defaultDemPmtiles;

    this.defaultContourProtocolUrl = this.setupDemContours(defaultDemPmtiles, 14);

    this.isProtocolRegistered = true;
  }

  private probeLocalServer(fileName: string) {
    return probeLocalDataServer(fileName);
  }

  /**
   * Resolves a PMTiles archive:
   * 1. On native Android: prefers shared native file storage (`filesDir/maps/{fileName}`)
   *    accessible to both the Capacitor WebView and Android Auto CarAppService; migrates
   *    any legacy OPFS copy into native storage once and deletes the OPFS duplicate.
   * 2. On Web: checks local development/preview server (/data/{fileName}) and device storage (OPFS).
   * 3. If not found locally, connects to Firebase (REMOTE_DATA_ORIGIN).
   */
  async resolveArchive(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    isConstant: boolean
  ): Promise<MountedArchiveInfo | null> {
    this.initProtocols();

    if (NativeOfflineStorage.isAndroidNative()) {
      const [nativeStatus, opfsFile] = await Promise.all([
        NativeOfflineStorage.getArchiveStatus(),
        OpfsStorageAdapter.getStoredFile(fileName).catch(() => null),
      ]);
      const fileStatus = nativeStatus?.files?.[fileName];
      if (fileStatus?.exists && fileStatus.valid && fileStatus.sizeBytes > 0) {
        if (opfsFile) {
          void OpfsStorageAdapter.removeFile(fileName).catch(() => {});
        }
        console.log(`[PMTilesRegistry] Found ${fileName} in native Android storage. Mounting...`);
        const mounted = await this.mountNativeArchive(
          id,
          fileName,
          fileStatus.nativeUrl,
          isConstant,
          fileStatus.sizeBytes,
          fileStatus.localPath,
          fileStatus.lastModifiedMs
        );
        if (!isConstant) {
          void this.checkForRemoteUpdate(id, fileName, fileStatus.sizeBytes);
        }
        return mounted;
      }

      if (opfsFile && opfsFile.size > 0) {
        console.log(`[PMTilesRegistry] Found legacy OPFS ${fileName}. Mounting and scheduling native migration...`);
        const mounted = await this.mountFromFile(id, fileName, opfsFile, isConstant, 'opfs');
        this.scheduleOpfsToNativeMigration(id, fileName, opfsFile, isConstant);
        if (!isConstant) {
          void this.checkForRemoteUpdate(id, fileName, opfsFile.size);
        }
        return mounted;
      }
    }

    const [opfsFile, localServer] = await Promise.all([
      OpfsStorageAdapter.getStoredFile(fileName).catch((err) => {
        console.warn(`[PMTilesRegistry] Local storage lookup warning for ${fileName}:`, err);
        return null;
      }),
      this.probeLocalServer(fileName),
    ]);

    // 1. Stored in OPFS? Verify it isn't stale compared to local dev server /data/{fileName}
    if (opfsFile && opfsFile.size > 0) {
      const localSizeDiffers =
        !!localServer && localServer.size > 0 && localServer.size !== opfsFile.size;
      const localServerNewer =
        !!localServer &&
        !isConstant &&
        !!localServer.lastModifiedMs &&
        !!opfsFile.lastModified &&
        localServer.lastModifiedMs > opfsFile.lastModified + 2000;

      if (localServer && (localSizeDiffers || localServerNewer)) {
        console.warn(
          `[PMTilesRegistry] Cached OPFS ${fileName} (${opfsFile.size} bytes) is stale vs local /data (${localServer.size} bytes). Switching to fresh local /data file.`
        );
        await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
        return await this.mountFromUrl(
          id,
          fileName,
          localServer.versionedUrl,
          isConstant,
          localServer.size
        );
      }

      console.log(`[PMTilesRegistry] Found ${fileName} in local storage (OPFS). Mounting...`);
      const mounted = await this.mountFromFile(id, fileName, opfsFile, isConstant, 'opfs');
      if (!isConstant && !localServer) {
        void this.checkForRemoteUpdate(id, fileName, opfsFile.size);
      }
      return mounted;
    }

    // 2. Local development/preview server (/data/{fileName})
    if (localServer) {
      console.log(`[PMTilesRegistry] Found ${fileName} on local server. Mounting...`);
      return await this.mountFromUrl(
        id,
        fileName,
        localServer.versionedUrl,
        isConstant,
        localServer.size
      );
    }

    // 3. Not stored locally -> check if hosted on Firebase (Storage / hosting:dem / hosting:data)
    console.log(`[PMTilesRegistry] Checking Firebase for ${fileName}...`);

    try {
      const remote = await this.probeRemote(fileName);
      if (!remote) {
        if (id === 'israel-dem') {
          const cachedDem = await this.tryMountCachedRemoteDem();
          if (cachedDem) {
            return cachedDem;
          }
          this.demRemoteUnavailable = true;
        }
        console.warn(
          `[PMTilesRegistry] ${fileName} does not exist on Firebase Hosting (404/missing). Base map will be unavailable until uploaded or imported.`
        );
        return null;
      }

      if (id === 'israel-dem') {
        this.demRemoteUnavailable = false;
        const defaultDemPmtiles = this.archives.get('israel-dem');
        if (
          defaultDemPmtiles &&
          this.defaultDemSource &&
          this.defaultDemSource.supportsUrl(remote.url)
        ) {
          this.defaultDemSource.preferUrl(remote.url);
          console.log(`[PMTilesRegistry] Streaming ${fileName} from Firebase: ${remote.url}`);
          return await this.registerArchiveSource(
            id,
            fileName,
            this.defaultDemSource,
            'remote-url',
            remote.url,
            remote.size,
            true,
            defaultDemPmtiles
          );
        }
      }
      console.log(`[PMTilesRegistry] Streaming ${fileName} from Firebase: ${remote.url}`);
      const mounted = await this.mountFromUrl(id, fileName, remote.url, isConstant, remote.size);
      return mounted;
    } catch (err) {
      if (id === 'israel-dem') {
        const cachedDem = await this.tryMountCachedRemoteDem();
        if (cachedDem) {
          return cachedDem;
        }
        this.demRemoteUnavailable = true;
      }
      console.warn(`[PMTilesRegistry] Could not mount ${fileName} from Firebase:`, err);
      return null;
    }
  }

  private async tryMountCachedRemoteDem(): Promise<MountedArchiveInfo | null> {
    const defaultDemPmtiles = this.archives.get('israel-dem');
    if (!defaultDemPmtiles || !this.defaultDemSource) return null;
    if (!(await this.defaultDemSource.hasCachedHeader())) return null;
    try {
      const mounted = await this.registerArchiveSource(
        'israel-dem',
        'Israel.dem.pmtiles',
        this.defaultDemSource,
        'remote-url',
        this.defaultDemSource.getActiveUrl(),
        0,
        true,
        defaultDemPmtiles
      );
      this.demRemoteUnavailable = false;
      console.log('[PMTilesRegistry] Mounted cached Israel.dem.pmtiles ranges for offline viewing.');
      return mounted;
    } catch {
      return null;
    }
  }

  /** Re-attempts remote DEM mounting after an offline/blocked boot once connectivity returns. */
  async retryDemIfUnavailable(): Promise<MountedArchiveInfo | null> {
    const existing = this.mountedInfo.get('israel-dem');
    if (existing) return existing;
    if (!this.demRemoteUnavailable) return null;
    if (this.demRetryPromise) return this.demRetryPromise;
    this.demRetryPromise = this.resolveArchive('israel-dem', 'Israel.dem.pmtiles', true)
      .catch(() => null)
      .finally(() => {
        this.demRetryPromise = null;
      });
    return this.demRetryPromise;
  }

  /** Reads the real archive size/etag from Firebase with a 1-byte range request (checks primary & fallback sites). */
  async probeRemote(fileName: string): Promise<{ size: number; etag?: string; url: string } | null> {
    return probeRemoteDataFile(fileName);
  }

  private readMeta(fileName: string): { size: number; etag?: string } | null {
    return readDataFileMeta(fileName);
  }

  private writeMeta(fileName: string, meta: { size: number; etag?: string }): void {
    writeDataFileMeta(fileName, meta);
  }

  /** Downloads again only if the server's file differs from the stored one. */
  private async checkForRemoteUpdate(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    localSize: number
  ): Promise<void> {
    const remote = await this.probeRemote(fileName);
    if (!remote) return;
    const meta = this.readMeta(fileName);
    const sameSize = remote.size === localSize;
    const sameEtag = !meta?.etag || !remote.etag || meta.etag === remote.etag;
    if (sameSize && sameEtag) {
      if (!meta) this.writeMeta(fileName, { size: remote.size, etag: remote.etag });
      console.log(`[PMTilesRegistry] ${fileName} is up to date. No download needed.`);
      return;
    }
    console.log(`[PMTilesRegistry] ${fileName} changed on server. Updating in background...`);
    this.triggerAutoDownloadQueue(id, true);
  }

  private triggerAutoDownloadQueue(id: 'israel-osm' | 'israel-dem', force: boolean): void {
    if (force) this.forcedDownloads.add(id);
    if (!this.autoDownloadQueue.includes(id) && !this.activeAutoDownloads.has(id)) {
      this.autoDownloadQueue.push(id);
    }
    void this.processAutoDownloadQueue();
  }

  private async processAutoDownloadQueue(): Promise<void> {
    if (this.isAutoDownloading || this.autoDownloadQueue.length === 0) return;
    this.isAutoDownloading = true;

    const nextId = this.autoDownloadQueue.shift()!;
    const forced = this.forcedDownloads.delete(nextId);
    const fileName = nextId === 'israel-osm' ? 'Israel.osm.pmtiles' : 'Israel.dem.pmtiles';
    const failKey = `pmtiles-dl-fail:${fileName}`;

    try {
      if (NativeOfflineStorage.isAndroidNative()) {
        const nativeStatus = await NativeOfflineStorage.getArchiveStatus();
        const fileStatus = nativeStatus?.files?.[fileName];
        if (fileStatus?.exists && fileStatus.valid && fileStatus.sizeBytes > 0 && !forced) {
          return;
        }
      }
      const existing = await OpfsStorageAdapter.getStoredFile(fileName);
      if (existing && existing.size > 0 && !forced) return;

      // Back off for 6h after a failed attempt instead of retrying on every app start.
      const lastFail = Number(localStorage.getItem(failKey) || 0);
      if (lastFail && Date.now() - lastFail < 6 * 3600 * 1000) return;

      this.activeAutoDownloads.add(nextId);
      console.log(`[PMTilesRegistry] Downloading ${fileName} to device storage...`);
      const saved = await this.downloadOfflineArchive(nextId, (loaded, total) => {
        this.notifyDownloadProgress(fileName, loaded, total);
      });
      localStorage.removeItem(failKey);
      console.log(`[PMTilesRegistry] ${fileName} saved to device storage.`);
      this.notifyArchiveUpdated(nextId, saved);
    } catch (err) {
      try {
        localStorage.setItem(failKey, String(Date.now()));
      } catch {
        /* ignore */
      }
      console.warn(`[PMTilesRegistry] Download error for ${fileName}:`, err);
    } finally {
      this.activeAutoDownloads.delete(nextId);
      this.isAutoDownloading = false;
      void this.processAutoDownloadQueue();
    }
  }

  /**
   * Boots both Israel.dem.pmtiles (Constant) and Israel.osm.pmtiles (Updatable).
   * Deduplicates concurrent callers (e.g. React StrictMode) so archives resolve cleanly once.
   */
  async initializeDefaultIsraelArchives(): Promise<{
    dem: MountedArchiveInfo | null;
    osm: MountedArchiveInfo | null;
  }> {
    this.initProtocols();

    if (!this.defaultInitPromise) {
      this.defaultInitPromise = Promise.all([
        this.resolveArchive('israel-osm', 'Israel.osm.pmtiles', false),
        this.resolveArchive('israel-dem', 'Israel.dem.pmtiles', true),
      ])
        .then(([osm, dem]) => ({ dem, osm }))
        .finally(() => {
          this.defaultInitPromise = null;
        });
    }

    return this.defaultInitPromise;
  }

  private scheduleOpfsToNativeMigration(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    opfsFile: File,
    isConstant: boolean
  ): void {
    if (this.migratingArchives.has(fileName)) return;
    this.migratingArchives.add(fileName);
    this.migrationQueue = this.migrationQueue
      .then(async () => {
        try {
          console.log(`[PMTilesRegistry] Migrating ${fileName} from OPFS to shared Android storage...`);
          const saved = await NativeOfflineStorage.saveBlobChunked(
            fileName,
            opfsFile,
            (loaded, total) => this.notifyDownloadProgress(fileName, loaded, total)
          );
          if (saved?.exists && saved.valid && saved.sizeBytes > 0) {
            const migrated = await this.mountNativeArchive(
              id,
              fileName,
              saved.nativeUrl,
              isConstant,
              saved.sizeBytes,
              saved.localPath,
              saved.lastModifiedMs
            );
            await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
            console.log(`[PMTilesRegistry] Migrated ${fileName} to native storage (${saved.localPath}).`);
            this.notifyArchiveUpdated(id, migrated);
          }
        } catch (err) {
          console.warn(`[PMTilesRegistry] OPFS->Native migration warning for ${fileName}:`, err);
        } finally {
          this.migratingArchives.delete(fileName);
        }
      });
  }

  async mountNativeArchive(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    nativeUrl: string,
    isConstant: boolean,
    knownSizeBytes = 0,
    localPath?: string,
    versionTag?: number
  ): Promise<MountedArchiveInfo> {
    this.initProtocols();
    const versionedUrl = `${nativeUrl}?v=${versionTag || Date.now()}`;
    const source = new FetchSource(versionedUrl);
    return this.registerArchiveSource(
      id,
      fileName,
      source,
      'native-file',
      localPath || nativeUrl,
      knownSizeBytes,
      isConstant
    );
  }

  async mountFromUrl(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    url: string,
    isConstant: boolean,
    knownSizeBytes = 0
  ): Promise<MountedArchiveInfo> {
    this.initProtocols();
    const isRemote = this.isRemoteArchiveUrl(url);
    const existingPmtiles = this.protocol.get(url);
    const source = existingPmtiles
      ? existingPmtiles.source
      : isRemote
        ? id === 'israel-dem'
          ? this.createDemRemoteSource(url)
          : new CachedFetchSource(url, { immutable: isConstant })
        : new FetchSource(url);
    return this.registerArchiveSource(
      id,
      fileName,
      source,
      isRemote ? 'remote-url' : 'local-server',
      url,
      knownSizeBytes,
      isConstant,
      existingPmtiles
    );
  }

  async mountFromFile(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    file: File,
    isConstant: boolean,
    storageKind: 'opfs' | 'user-file' = 'opfs'
  ): Promise<MountedArchiveInfo> {
    this.initProtocols();
    const fileSource = new FileSource(file);
    const mountKey = `https://localhost/__pmtiles_local__/${id}/${file.lastModified || 0}-${Date.now()}.pmtiles`;
    const customSource: Source = {
      getKey: () => mountKey,
      getBytes: (offset, length) => fileSource.getBytes(offset, length),
    };
    return this.registerArchiveSource(
      id,
      fileName,
      customSource,
      storageKind,
      file.name,
      file.size,
      isConstant
    );
  }

  /**
   * Downloads Israel.dem.pmtiles or Israel.osm.pmtiles from the local /data server (in dev) or
   * hosted Firebase site into native Android storage (or browser OPFS on Web), then mounts
   * the local copy so the map works 100% offline.
   */
  async downloadOfflineArchive(
    id: 'israel-dem' | 'israel-osm',
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<MountedArchiveInfo> {
    const fileName = id === 'israel-dem' ? 'Israel.dem.pmtiles' : 'Israel.osm.pmtiles';
    const isConstant = id === 'israel-dem';

    if (NativeOfflineStorage.isAndroidNative()) {
      const remote = await this.probeRemote(fileName);
      if (!remote) {
        throw new Error(`Archive ${fileName} is not available on Firebase Hosting (404/missing).`);
      }
      const saved = await NativeOfflineStorage.downloadArchive(
        fileName,
        remote.url,
        remote.size,
        onProgress,
        signal
      );
      this.writeMeta(fileName, { size: remote.size || saved.sizeBytes, etag: remote.etag });
      await OpfsStorageAdapter.removeFile(fileName).catch(() => {});
      await CachedFetchSource.clear();
      return this.mountNativeArchive(
        id,
        fileName,
        saved.nativeUrl,
        isConstant,
        saved.sizeBytes,
        saved.localPath,
        saved.lastModifiedMs
      );
    }

    if (!OpfsStorageAdapter.isSupported()) {
      throw new Error('Offline storage (OPFS) is not supported on this device/browser.');
    }
    const local = await this.probeLocalServer(fileName);
    const remote = local ? null : await this.probeRemote(fileName);
    if (!local && !remote) {
      throw new Error(`Archive ${fileName} is not available locally or on Firebase Hosting (404/missing).`);
    }
    const url = local ? local.versionedUrl : remote!.url;
    const expectedSize = local ? local.size : remote!.size;
    const etag = local ? local.etag : remote!.etag;
    OpfsStorageAdapter.getStorageEstimate().catch(() => {}); // also requests persistent storage
    const file = await OpfsStorageAdapter.saveOrReplaceFromStream(
      fileName,
      url,
      onProgress,
      signal,
      expectedSize
    );
    this.writeMeta(fileName, { size: expectedSize || file.size, etag });
    await CachedFetchSource.clear(); // streamed ranges of the old file are obsolete
    return this.mountFromFile(id, fileName, file, isConstant, 'opfs');
  }

  async replaceOsmArchive(
    newSource: { kind: 'file'; file: File; persistToOpfs?: boolean } | { kind: 'url'; url: string },
    onProgress?: (loaded: number, total: number) => void
  ): Promise<MountedArchiveInfo> {
    await CachedFetchSource.clear();
    if (NativeOfflineStorage.isAndroidNative()) {
      if (newSource.kind === 'file') {
        if (newSource.persistToOpfs) {
          const saved = await NativeOfflineStorage.saveBlobChunked(
            'Israel.osm.pmtiles',
            newSource.file,
            onProgress
          );
          await OpfsStorageAdapter.removeFile('Israel.osm.pmtiles').catch(() => {});
          this.writeMeta('Israel.osm.pmtiles', { size: saved.sizeBytes });
          return this.mountNativeArchive(
            'israel-osm',
            'Israel.osm.pmtiles',
            saved.nativeUrl,
            false,
            saved.sizeBytes,
            saved.localPath,
            saved.lastModifiedMs
          );
        }
        return await this.mountFromFile('israel-osm', 'Israel.osm.pmtiles', newSource.file, false, 'user-file');
      }
      const saved = await NativeOfflineStorage.downloadArchive(
        'Israel.osm.pmtiles',
        newSource.url,
        0,
        onProgress
      );
      await OpfsStorageAdapter.removeFile('Israel.osm.pmtiles').catch(() => {});
      this.writeMeta('Israel.osm.pmtiles', { size: saved.sizeBytes });
      return this.mountNativeArchive(
        'israel-osm',
        'Israel.osm.pmtiles',
        saved.nativeUrl,
        false,
        saved.sizeBytes,
        saved.localPath,
        saved.lastModifiedMs
      );
    }

    if (newSource.kind === 'file') {
      let targetFile = newSource.file;
      let storageKind: 'opfs' | 'user-file' = 'user-file';
      if (newSource.persistToOpfs && OpfsStorageAdapter.isSupported()) {
        targetFile = await OpfsStorageAdapter.saveOrReplaceFromStream(
          'Israel.osm.pmtiles',
          newSource.file,
          onProgress
        );
        this.writeMeta('Israel.osm.pmtiles', { size: targetFile.size });
        storageKind = 'opfs';
      }
      return await this.mountFromFile('israel-osm', 'Israel.osm.pmtiles', targetFile, false, storageKind);
    } else {
      if (OpfsStorageAdapter.isSupported()) {
        const savedFile = await OpfsStorageAdapter.saveOrReplaceFromStream(
          'Israel.osm.pmtiles',
          newSource.url,
          onProgress
        );
        this.writeMeta('Israel.osm.pmtiles', { size: savedFile.size });
        return await this.mountFromFile('israel-osm', 'Israel.osm.pmtiles', savedFile, false, 'opfs');
      }
      return await this.mountFromUrl('israel-osm', 'Israel.osm.pmtiles', newSource.url, false);
    }
  }

  async mountLocalDemArchive(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
    persistToOpfs = false
  ): Promise<MountedArchiveInfo> {
    await this.assertPmtilesFileHeader(file);
    if (NativeOfflineStorage.isAndroidNative()) {
      const saved = await NativeOfflineStorage.saveBlobChunked('Israel.dem.pmtiles', file, onProgress);
      await OpfsStorageAdapter.removeFile('Israel.dem.pmtiles').catch(() => {});
      return this.mountNativeArchive(
        'israel-dem',
        'Israel.dem.pmtiles',
        saved.nativeUrl,
        true,
        saved.sizeBytes,
        saved.localPath,
        saved.lastModifiedMs
      );
    }
    if (persistToOpfs && OpfsStorageAdapter.isSupported()) {
      const savedFile = await OpfsStorageAdapter.saveOrReplaceFromStream(
        'Israel.dem.pmtiles',
        file,
        onProgress
      );
      this.writeMeta('Israel.dem.pmtiles', { size: savedFile.size });
      await CachedFetchSource.clear().catch(() => {});
      return this.mountFromFile('israel-dem', 'Israel.dem.pmtiles', savedFile, true, 'opfs');
    }
    return this.mountFromFile('israel-dem', 'Israel.dem.pmtiles', file, true, 'user-file');
  }

  async removeOfflineArchive(fileName: string): Promise<void> {
    await Promise.all([
      NativeOfflineStorage.removeArchive(fileName).catch(() => {}),
      OpfsStorageAdapter.removeFile(fileName).catch(() => {}),
    ]);
  }

  private async registerArchiveSource(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    source: Source,
    storageKind: MapArchiveRecord['storageKind'],
    urlOrPath: string,
    knownSizeBytes: number,
    isConstant: boolean,
    existingPmtiles?: PMTiles
  ): Promise<MountedArchiveInfo> {
    let pmtiles: PMTiles;
    if (existingPmtiles) {
      pmtiles = existingPmtiles;
    } else {
      const directoryCache = new TransientSafePromiseCache(1000);
      pmtiles = new PMTiles(source, directoryCache);
      this.attachInMemoryTileCache(pmtiles, id === 'israel-dem' ? 500 : 400);
    }

    const header = await pmtiles.getHeader();
    const metadata: any = await pmtiles.getMetadata().catch(() => ({}));

    if (!existingPmtiles) {
      this.protocol.add(pmtiles);
    }
    (this.protocol as any).tiles?.set(id, pmtiles);
    this.archives.set(id, pmtiles);

    const createdUtc =
      metadata?.extract?.createdUtc ||
      metadata?.createdUtc ||
      new Date().toISOString();

    const vectorLayersMeta: any[] = Array.isArray(metadata?.vector_layers)
      ? metadata.vector_layers
      : [];
    const vectorLayers: string[] = vectorLayersMeta.map((l: any) => l.id);

    let hasTrailColorSchema: boolean | undefined;
    if (id === 'israel-osm') {
      const transLayer = vectorLayersMeta.find((l: any) => l?.id === 'transportation');
      if (transLayer?.fields && typeof transLayer.fields === 'object') {
        const fields = Object.keys(transLayer.fields);
        hasTrailColorSchema = fields.includes('colour') || fields.includes('osmc_symbol');
        if (!hasTrailColorSchema) {
          console.warn(
            `[PMTilesRegistry] Mounted ${fileName} (${storageKind}, ${knownSizeBytes || '?'} bytes) lacks 'colour'/'osmc_symbol' in transportation schema — trail colors cannot render from this archive!`
          );
        }
      }
    }

    const sizeBytes =
      knownSizeBytes ||
      Number(header.tileDataOffset + (header.tileDataLength ?? 0)) ||
      (id === 'israel-dem' ? 1402183369 : 112258784);

    const record: MapArchiveRecord = {
      id,
      fileName,
      role: isConstant ? 'dem-constant' : 'osm-updatable',
      storageKind,
      urlOrPath,
      sizeBytes,
      createdUtc,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
      lastVerifiedAt: new Date().toISOString(),
      isLockedConstant: isConstant,
    };

    // Persist registry metadata in the background so IndexedDB contention never delays map boot or 3D DEM mounting.
    void db.mapRegistry.put(record).catch(() => {});

    let contourProtocolUrl: string | undefined;
    if (id === 'israel-dem') {
      this.demRemoteUnavailable = false;
      this.activeDemPmtiles = pmtiles;
      contourProtocolUrl = this.setupDemContours(pmtiles, header.maxZoom);
    }

    const info: MountedArchiveInfo = {
      id,
      protocolUrl: `pmtiles://${source.getKey()}`,
      contourProtocolUrl,
      pmtiles,
      record,
      vectorLayers,
      hasTrailColorSchema,
    };

    this.mountedInfo.set(id, info);
    return info;
  }

  /**
   * Wraps pmtiles.getZxy with an in-memory LRU tile cache + in-flight request deduplication.
   * PMTiles v4 only caches directories by default, NOT individual tile payloads — meaning
   * without this wrapper, Hillshade (raster-dem), Contours (maplibre-contour + neighbors),
   * and ElevationService would each fire duplicate HTTP Range requests for the exact same tile.
   */
  private attachInMemoryTileCache(pmtiles: PMTiles, maxEntries = 450): void {
    const rawGetZxy = pmtiles.getZxy.bind(pmtiles);
    const tileCache = new Map<string, RangeResponse | null>();
    const inFlight = new Map<string, Promise<RangeResponse | undefined>>();

    pmtiles.getZxy = async (
      z: number,
      x: number,
      y: number,
      signal?: AbortSignal
    ): Promise<RangeResponse | undefined> => {
      if (signal?.aborted) return undefined;
      const key = `${z}/${x}/${y}`;

      if (tileCache.has(key)) {
        const cached = tileCache.get(key)!;
        // Refresh LRU order
        tileCache.delete(key);
        tileCache.set(key, cached);
        if (!cached) return undefined;
        return {
          ...cached,
          data: cached.data.slice(0),
        };
      }

      let pending = inFlight.get(key);
      if (!pending) {
        pending = (async () => {
          try {
            // Do not pass individual caller signal so shared tile fetches are not aborted by one consumer
            const res = await rawGetZxy(z, x, y);
            if (tileCache.size >= maxEntries) {
              const oldest = tileCache.keys().next().value;
              if (oldest !== undefined) tileCache.delete(oldest);
            }
            if (res && res.data) {
              tileCache.set(key, {
                ...res,
                data: res.data.slice(0),
              });
            } else {
              tileCache.set(key, null);
            }
            return res;
          } finally {
            inFlight.delete(key);
          }
        })();
        inFlight.set(key, pending);
      }

      const result = await pending;
      if (!result || !result.data) return undefined;
      return {
        ...result,
        data: result.data.slice(0),
      };
    };
  }

  /**
   * Registers maplibre-contour on top of Israel.dem.pmtiles so 10m minor contour lines
   * and 50m major index contour lines (+ elevation numbers) are generated dynamically 100% offline.
   */
  private setupDemContours(demPmtiles: PMTiles, maxZoom: number): string | undefined {
    try {
      const DemSource = (mlcontour as any).DemSource || (mlcontour as any).default?.DemSource;
      if (!DemSource) return undefined;

      const archiveChanged = this.contourArchiveRef !== demPmtiles;
      this.contourArchiveRef = demPmtiles;

      if (!this.demContourSource) {
        this.demContourSource = new DemSource({
          url: 'https://localhost/__dem_pmtiles__/{z}/{x}/{y}.png',
          encoding: 'terrarium',
          maxzoom: maxZoom || 14,
          worker: false,
          cacheSize: 300,
          timeoutMs: 25000,
        });

        // Override LocalDemManager.fetchTile to read PNG DEM tiles directly from Israel.dem.pmtiles
        const manager = this.demContourSource.manager;
        if (manager) {
          const rawDecodeImage =
            typeof manager.decodeImage === 'function' ? manager.decodeImage.bind(manager) : undefined;
          manager.decodeImage = (blob: Blob, encoding: string, abortController?: AbortController) =>
            decodeDemPngSafely(blob, encoding, abortController, rawDecodeImage);

          manager.fetchTile = async (
            z: number,
            x: number,
            y: number,
            parentAbortController?: AbortController
          ) => {
            const sig = parentAbortController?.signal;
            if (sig?.aborted) {
              throw new Error('aborted');
            }
            const activeDem = this.activeDemPmtiles || demPmtiles;
            let tileRes: RangeResponse | undefined;
            const retryDelays = [200, 600];
            for (let attempt = 0; ; attempt++) {
              try {
                tileRes = await activeDem.getZxy(z, x, y, sig);
                break;
              } catch (err) {
                if (sig?.aborted) throw new Error('aborted');
                if (attempt >= retryDelays.length) throw err;
                await new Promise((r) => setTimeout(r, retryDelays[attempt]));
                if (sig?.aborted) throw new Error('aborted');
              }
            }
            if (sig?.aborted) {
              throw new Error('aborted');
            }
            if (!tileRes || !tileRes.data) {
              return { data: getEmptyTerrariumTileBlob() };
            }
            return {
              data: new Blob([tileRes.data], { type: 'image/png' }),
            };
          };
          wrapManagerWithSafeContourBuffers(manager);
        }

        this.demContourSource.setupMaplibre(maplibregl);
      } else {
        const manager = this.demContourSource.manager;
        if (manager) {
          if (maxZoom) manager.maxzoom = maxZoom;
          if (archiveChanged) {
            manager.tileCache?.clear?.();
            manager.parsedCache?.clear?.();
            manager.contourCache?.clear?.();
          }
          wrapManagerWithSafeContourBuffers(manager);
        }
      }

      // Generate contours every 10m (minor, level=0) and every 50m (major index, level=1)
      // overzoom: 1 computes zoom Z contours from zoom Z-1 DEM tiles (4x fewer DEM fetches & 4x faster Marching Squares!)
      return this.demContourSource.contourProtocolUrl({
        thresholds: {
          9: [100, 500],
          10: [50, 250],
          11: [20, 100],
          12: [10, 50],
          13: [10, 50],
          14: [10, 50],
          15: [10, 50],
        },
        overzoom: 1,
        contourLayer: 'contours',
        elevationKey: 'ele',
        levelKey: 'level',
        extent: 4096,
        buffer: 1,
      });
    } catch (err) {
      console.warn('[PMTilesRegistry] Dynamic contour setup skipped:', err);
      return undefined;
    }
  }

  getArchive(id: 'israel-dem' | 'israel-osm'): PMTiles | undefined {
    return this.archives.get(id);
  }

  getMountedInfo(id: 'israel-dem' | 'israel-osm'): MountedArchiveInfo | undefined {
    return this.mountedInfo.get(id);
  }
}

export const pmtilesRegistry = new PMTilesRegistry();
