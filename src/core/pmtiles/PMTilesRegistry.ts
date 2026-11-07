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
import { pmtilesUrl } from '../dataUrls';
import { OpfsStorageAdapter } from './OpfsStorageAdapter';
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

  constructor() {
    this.protocol = new Protocol({ metadata: true });
  }

  initProtocols(): void {
    if (this.isProtocolRegistered) return;
    maplibregl.addProtocol('pmtiles', this.protocol.tile);
    registerOfflineGlyphsProtocol();
    registerOfflineRtlTextPlugin();
    this.isProtocolRegistered = true;
  }

  /**
   * Boots both Israel.dem.pmtiles (Constant) and Israel.osm.pmtiles (Updatable).
   * Checks OPFS first for any user-updated Israel.osm.pmtiles, falling back to /data/*.pmtiles.
   */
  async initializeDefaultIsraelArchives(): Promise<{
    dem: MountedArchiveInfo;
    osm: MountedArchiveInfo;
  }> {
    this.initProtocols();

    // 1. Mount Constant DEM (Israel.dem.pmtiles)
    const opfsDem = await OpfsStorageAdapter.getStoredFile('Israel.dem.pmtiles');
    const dem = opfsDem
      ? await this.mountFromFile('israel-dem', 'Israel.dem.pmtiles', opfsDem, true)
      : await this.mountFromUrl(
          'israel-dem',
          'Israel.dem.pmtiles',
          pmtilesUrl('Israel.dem.pmtiles'),
          true
        );

    // 2. Mount Updatable OSM (Israel.osm.pmtiles) — prefers OPFS if user already updated it
    const opfsOsm = await OpfsStorageAdapter.getStoredFile('Israel.osm.pmtiles');
    const osm = opfsOsm
      ? await this.mountFromFile('israel-osm', 'Israel.osm.pmtiles', opfsOsm, false)
      : await this.mountFromUrl(
          'israel-osm',
          'Israel.osm.pmtiles',
          pmtilesUrl('Israel.osm.pmtiles'),
          false
        );

    return { dem, osm };
  }

  async mountFromUrl(
    id: 'israel-dem' | 'israel-osm',
    fileName: string,
    url: string,
    isConstant: boolean
  ): Promise<MountedArchiveInfo> {
    this.initProtocols();
    const source = new FetchSource(url);
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
      getBytes: (offset, length, signal, etag) => fileSource.getBytes(offset, length, signal, etag),
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
      Number(header.tileDataOffset + header.tileDataLength) ||
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
