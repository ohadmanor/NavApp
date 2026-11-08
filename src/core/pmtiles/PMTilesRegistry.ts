import maplibregl from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import {
  PMTiles,
  Protocol,
  FetchSource,
  FileSource,
  SharedPromiseCache,
  type Source,
  type RangeResponse,
} from 'pmtiles';
import { db, type MapArchiveRecord } from '../db/NavDatabase';
import { pmtilesUrl, REMOTE_DATA_ORIGIN, isNativePlatform } from '../dataUrls';
import { OpfsStorageAdapter } from './OpfsStorageAdapter';
import { CachedFetchSource } from './CachedFetchSource';
import { registerOfflineGlyphsProtocol } from '../style/offlineGlyphsProtocol';
import { registerOfflineRtlTextPlugin } from '../style/hebrewBidiProcessor';

export interface MountedArchiveInfo {
  id: 'israel-dem' | 'israel-osm';
  protocolUrl: string;
  contourProtocolUrl?: string;
  pmtiles: PMTiles;
  record: MapArchiveRecord;
  vectorLayers: string[];
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
  private defaultContourProtocolUrl?: string;
  private updateListeners = new Set<ArchiveUpdateListener>();
  private progressListeners = new Set<DownloadProgressListener>();
  private activeAutoDownloads = new Set<string>();
  private autoDownloadQueue: Array<'israel-osm' | 'israel-dem'> = [];
  private isAutoDownloading = false;
  private forcedDownloads = new Set<string>();

  constructor() {
    this.protocol = new Protocol({ metadata: true });
  }

  getDefaultOsmProtocolUrl(): string {
    return `pmtiles://${REMOTE_DATA_ORIGIN}/data/Israel.osm.pmtiles`;
  }

  getDefaultDemProtocolUrl(): string {
    return `pmtiles://${REMOTE_DATA_ORIGIN}/data/Israel.dem.pmtiles`;
  }

  getDefaultContourProtocolUrl(): string | undefined {
    return this.defaultContourProtocolUrl;
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

  initProtocols(): void {
    if (this.isProtocolRegistered) return;
    maplibregl.addProtocol('pmtiles', this.protocol.tile);
    registerOfflineGlyphsProtocol();
    registerOfflineRtlTextPlugin();

    // Pre-register remote Firebase sources as default fallbacks so MapLibre can stream immediately
    const defaultOsmUrl = `${REMOTE_DATA_ORIGIN}/data/Israel.osm.pmtiles`;
    const defaultOsmSource = new CachedFetchSource(defaultOsmUrl);
    const defaultOsmPmtiles = new PMTiles(defaultOsmSource);
    this.attachInMemoryTileCache(defaultOsmPmtiles, 400);
    this.protocol.add(defaultOsmPmtiles);
    (this.protocol as any).tiles?.set('israel-osm', defaultOsmPmtiles);

    const defaultDemUrl = `${REMOTE_DATA_ORIGIN}/data/Israel.dem.pmtiles`;
    const defaultDemSource = new CachedFetchSource(defaultDemUrl);
    const defaultDemPmtiles = new PMTiles(defaultDemSource);
    this.attachInMemoryTileCache(defaultDemPmtiles, 500);
    this.protocol.add(defaultDemPmtiles);
    (this.protocol as any).tiles?.set('israel-dem', defaultDemPmtiles);
    this.activeDemPmtiles = defaultDemPmtiles;

    this.defaultContourProtocolUrl = this.setupDemContours(defaultDemPmtiles, 14);

    this.isProtocolRegistered = true;
  }

  /**
   * Resolves a PMTiles archive:
   * 1. Checks device storage (OPFS) for local offline file.
   * 2. Checks local development server (/data/{fileName}).
   * 3. If not found locally, automatically connects to Firebase (REMOTE_DATA_ORIGIN)
   *    and triggers an automatic background download to OPFS.
   */
  async resolveArchive(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    isConstant: boolean
  ): Promise<MountedArchiveInfo | null> {
    this.initProtocols();

    // 1. Already stored on this device? Mount instantly and NEVER re-download an identical file.
    try {
      const opfsFile = await OpfsStorageAdapter.getStoredFile(fileName);
      if (opfsFile && opfsFile.size > 0) {
        console.log(`[PMTilesRegistry] Found ${fileName} in local storage. Mounting...`);
        const mounted = await this.mountFromFile(id, fileName, opfsFile, isConstant, 'opfs');
        // Only the updatable OSM archive is re-validated, silently, in the background.
        if (!isConstant) void this.checkForRemoteUpdate(id, fileName, opfsFile.size);
        return mounted;
      }
    } catch (err) {
      console.warn(`[PMTilesRegistry] Local storage lookup warning for ${fileName}:`, err);
    }

    // 2. Check local development server (/data/{fileName}) if on web
    if (typeof window !== 'undefined' && window.location?.origin && !isNativePlatform()) {
      const localUrl = `${window.location.origin}/data/${fileName}`;
      try {
        const head = await fetch(localUrl, { method: 'HEAD', signal: AbortSignal.timeout(1200) });
        const looksLikeArchive =
          head.ok && !(head.headers.get('content-type') || '').includes('text/html');
        if (looksLikeArchive) {
          console.log(`[PMTilesRegistry] Found ${fileName} on local server. Mounting...`);
          return await this.mountFromUrl(id, fileName, localUrl, isConstant);
        }
      } catch {
        // Not on local server
      }
    }

    // 3. Not stored locally -> check if hosted on Firebase
    const remoteUrl = `${REMOTE_DATA_ORIGIN}/data/${fileName}`;
    console.log(`[PMTilesRegistry] Checking Firebase for ${fileName}...`);

    try {
      const remote = await this.probeRemote(fileName);
      if (!remote) {
        console.warn(
          `[PMTilesRegistry] ${fileName} does not exist on Firebase Hosting (404/missing). Base map will be unavailable until uploaded or imported.`
        );
        return null;
      }

      console.log(`[PMTilesRegistry] Streaming ${fileName} from Firebase: ${remoteUrl}`);
      const mounted = await this.mountFromUrl(id, fileName, remoteUrl, isConstant);

      // Only the small OSM archive is saved automatically. The 1.4 GB DEM keeps streaming
      // (range-cached) and is downloaded only when the user asks for it in the Maps Manager.
      if (id === 'israel-osm' && OpfsStorageAdapter.isSupported()) {
        this.triggerAutoDownloadQueue(id, false);
      }

      return mounted;
    } catch (err) {
      console.warn(`[PMTilesRegistry] Could not mount ${fileName} from Firebase:`, err);
      return null;
    }
  }

  /** Reads the real archive size/etag from the server with a 1-byte range request. */
  async probeRemote(fileName: string): Promise<{ size: number; etag?: string } | null> {
    try {
      const res = await fetch(`${REMOTE_DATA_ORIGIN}/data/${fileName}`, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        return null; // SPA rewrite or 404 page, not a binary PMTiles archive
      }
      const range = res.headers.get('content-range');
      const size = range ? Number(range.split('/')[1]) : 0;
      if (!size) return null;
      return { size, etag: res.headers.get('etag') || undefined };
    } catch {
      return null; // offline: keep using what we have
    }
  }

  private readMeta(fileName: string): { size: number; etag?: string } | null {
    try {
      return JSON.parse(localStorage.getItem(`pmtiles-meta:${fileName}`) || 'null');
    } catch {
      return null;
    }
  }

  private writeMeta(fileName: string, meta: { size: number; etag?: string }): void {
    try {
      localStorage.setItem(`pmtiles-meta:${fileName}`, JSON.stringify(meta));
    } catch {
      /* ignore */
    }
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
   * Checks OPFS first -> local server -> automatically downloads from Firebase.
   */
  async initializeDefaultIsraelArchives(): Promise<{
    dem: MountedArchiveInfo | null;
    osm: MountedArchiveInfo | null;
  }> {
    this.initProtocols();

    const [osm, dem] = await Promise.all([
      this.resolveArchive('israel-osm', 'Israel.osm.pmtiles', false),
      this.resolveArchive('israel-dem', 'Israel.dem.pmtiles', true),
    ]);

    return { dem, osm };
  }

  async mountFromUrl(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    url: string,
    isConstant: boolean
  ): Promise<MountedArchiveInfo> {
    this.initProtocols();
    const source = url.startsWith(REMOTE_DATA_ORIGIN) ? new CachedFetchSource(url) : new FetchSource(url);
    return this.registerArchiveSource(id, fileName, source, 'local-server', url, 0, isConstant);
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
   * Hot-swaps Israel.osm.pmtiles from a newly selected local File or remote URL
   * while leaving the 1.40 GB Israel.dem.pmtiles untouched.
   */
  /**
   * Downloads Israel.dem.pmtiles or Israel.osm.pmtiles from the hosted Firebase site into the
   * device's persistent storage (OPFS) on user request, then mounts the local copy so the map
   * works 100% offline.
   */
  async downloadOfflineArchive(
    id: 'israel-dem' | 'israel-osm',
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<MountedArchiveInfo> {
    if (!OpfsStorageAdapter.isSupported()) {
      throw new Error('Offline storage (OPFS) is not supported on this device/browser.');
    }
    const fileName = id === 'israel-dem' ? 'Israel.dem.pmtiles' : 'Israel.osm.pmtiles';
    const url = `${REMOTE_DATA_ORIGIN}/data/${fileName}`;
    const remote = await this.probeRemote(fileName);
    if (!remote) {
      throw new Error(`Archive ${fileName} is not available on Firebase Hosting (404/missing).`);
    }
    OpfsStorageAdapter.getStorageEstimate().catch(() => {}); // also requests persistent storage
    const file = await OpfsStorageAdapter.saveOrReplaceFromStream(
      fileName,
      url,
      onProgress,
      signal,
      remote?.size
    );
    this.writeMeta(fileName, { size: remote?.size || file.size, etag: remote?.etag });
    await CachedFetchSource.clear(); // streamed ranges of the old file are obsolete
    return this.mountFromFile(id, fileName, file, id === 'israel-dem', 'opfs');
  }

  async replaceOsmArchive(
    newSource: { kind: 'file'; file: File; persistToOpfs?: boolean } | { kind: 'url'; url: string },
    onProgress?: (loaded: number, total: number) => void
  ): Promise<MountedArchiveInfo> {
    if (newSource.kind === 'file') {
      let targetFile = newSource.file;
      let storageKind: 'opfs' | 'user-file' = 'user-file';
      if (newSource.persistToOpfs && OpfsStorageAdapter.isSupported()) {
        targetFile = await OpfsStorageAdapter.saveOrReplaceFromStream(
          'Israel.osm.pmtiles',
          newSource.file,
          onProgress
        );
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
        return await this.mountFromFile('israel-osm', 'Israel.osm.pmtiles', savedFile, false, 'opfs');
      }
      return await this.mountFromUrl('israel-osm', 'Israel.osm.pmtiles', newSource.url, false);
    }
  }

  private async registerArchiveSource(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    source: Source,
    storageKind: MapArchiveRecord['storageKind'],
    urlOrPath: string,
    knownSizeBytes: number,
    isConstant: boolean
  ): Promise<MountedArchiveInfo> {
    const directoryCache = new SharedPromiseCache(1000);
    const pmtiles = new PMTiles(source, directoryCache);
    this.attachInMemoryTileCache(pmtiles, id === 'israel-dem' ? 500 : 400);

    const header = await pmtiles.getHeader();
    const metadata: any = await pmtiles.getMetadata().catch(() => ({}));

    this.protocol.add(pmtiles);
    (this.protocol as any).tiles?.set(id, pmtiles);
    this.archives.set(id, pmtiles);

    const createdUtc =
      metadata?.extract?.createdUtc ||
      metadata?.createdUtc ||
      new Date().toISOString();

    const vectorLayers: string[] = Array.isArray(metadata?.vector_layers)
      ? metadata.vector_layers.map((l: any) => l.id)
      : [];

    const sizeBytes =
      knownSizeBytes ||
      Number(header.tileDataOffset + (header.tileDataLength ?? 0)) ||
      (id === 'israel-dem' ? 1402183369 : 112434955);

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

    await db.mapRegistry.put(record).catch(() => {});

    let contourProtocolUrl: string | undefined;
    if (id === 'israel-dem') {
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

      if (!this.demContourSource) {
        this.demContourSource = new DemSource({
          url: 'https://localhost/__dem_pmtiles__/{z}/{x}/{y}.png',
          encoding: 'terrarium',
          maxzoom: maxZoom || 14,
          worker: false,
          cacheSize: 300,
        });

        // Override LocalDemManager.fetchTile to read PNG DEM tiles directly from Israel.dem.pmtiles
        const manager = this.demContourSource.manager;
        if (manager) {
          manager.fetchTile = async (
            z: number,
            x: number,
            y: number,
            parentAbortController?: AbortController
          ) => {
            const activeDem = this.activeDemPmtiles || demPmtiles;
            const tileRes = await activeDem.getZxy(z, x, y, parentAbortController?.signal);
            if (!tileRes || !tileRes.data) {
              throw new Error(`Empty DEM tile ${z}/${x}/${y}`);
            }
            return {
              data: new Blob([tileRes.data], { type: 'image/png' }),
            };
          };
        }

        this.demContourSource.setupMaplibre(maplibregl);
      }

      // Generate contours every 10m (minor, level=0) and every 50m (major index, level=1)
      // overzoom: 1 computes zoom Z contours from zoom Z-1 DEM tiles (4x fewer DEM fetches & 4x faster Marching Squares!)
      return this.demContourSource.contourProtocolUrl({
        thresholds: {
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
