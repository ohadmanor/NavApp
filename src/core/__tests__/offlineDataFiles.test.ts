import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DATA_FALLBACK_ORIGIN,
  REMOTE_DATA_ORIGIN,
  REMOTE_DEM_HOSTING_ORIGIN,
  bundledDataUrl,
  getDemCandidateUrls,
  isAndroidNativePlatform,
  isLocalDevServer,
  pmtilesUrl,
  remoteDataUrl,
  unwrapAndroidRemoteProxyUrl,
  wrapAndroidRemoteProxyUrl,
} from '../dataUrls';
import {
  clearDataFileMeta,
  probeRemoteDataFile,
  readDataFileMeta,
  writeDataFileMeta,
} from '../pmtiles/dataFileProbe';
import {
  OFFLINE_DATA_FILE_NAMES,
  OfflineDataFilesManager,
} from '../pmtiles/OfflineDataFiles';
import { OpfsStorageAdapter } from '../pmtiles/OpfsStorageAdapter';
import { NativeOfflineStorage } from '../pmtiles/NativeOfflineStorage';
import { PMTilesRegistry } from '../pmtiles/PMTilesRegistry';
import { buildIsraelOutdoorStyle, DEFAULT_LAYER_VISIBILITY } from '../style/israelOutdoorStyle';

describe('Firebase data source (GeoJSON POIs + search index + PMTiles)', () => {
  const origWindow = (globalThis as any).window;
  const origFetch = globalThis.fetch;
  const origLocalStorage = (globalThis as any).localStorage;
  const origNavigator = (globalThis as any).navigator;

  function setupMockLocalStorage() {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    return store;
  }

  beforeEach(() => {
    setupMockLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    (globalThis as any).window = origWindow;
    globalThis.fetch = origFetch;
    (globalThis as any).localStorage = origLocalStorage;
    Object.defineProperty(globalThis, 'navigator', {
      value: origNavigator,
      configurable: true,
      writable: true,
    });
  });

  it('treats Capacitor localhost native origin as non-local dev server and builds Firebase URLs', () => {
    expect(remoteDataUrl('Israel.pois.geojson')).toBe(
      `${REMOTE_DATA_ORIGIN}/data/Israel.pois.geojson`
    );
    expect(pmtilesUrl('Israel.osm.pmtiles')).toBe(
      `${REMOTE_DATA_ORIGIN}/data/Israel.osm.pmtiles`
    );

    // Capacitor Android WebView runs on https://localhost with Capacitor.isNativePlatform() === true
    (globalThis as any).window = {
      location: { origin: 'https://localhost', hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    };
    expect(isLocalDevServer()).toBe(false);
    expect(bundledDataUrl('data/Israel.search.idx')).toBe(
      `${REMOTE_DATA_ORIGIN}/data/Israel.search.idx`
    );

    // Desktop Vite dev server serves local data/ via /data/* middleware
    (globalThis as any).window = {
      location: { origin: 'http://localhost:5173', hostname: 'localhost' },
    };
    expect(isLocalDevServer()).toBe(true);
    expect(bundledDataUrl('data/Israel.search.idx')).toBe(
      'http://localhost:5173/data/Israel.search.idx'
    );

    // Deployed web app always loads from Firebase data origin
    (globalThis as any).window = {
      location: { origin: 'https://navapp-israel-topo.web.app', hostname: 'navapp-israel-topo.web.app' },
    };
    expect(isLocalDevServer()).toBe(false);
    expect(bundledDataUrl('data/Israel.search.idx')).toBe(
      `${REMOTE_DATA_ORIGIN}/data/Israel.search.idx`
    );
  });

  it('probes GeoJSON and .idx files using HEAD Content-Length and falls back cleanly on HTML/404', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (url.startsWith(REMOTE_DATA_ORIGIN)) {
        // Simulate Firebase primary missing
        return { ok: false, status: 404, headers: new Headers() } as unknown as Response;
      }
      if (url.startsWith(REMOTE_DATA_FALLBACK_ORIGIN)) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/geo+json',
            'content-length': '4336165',
            etag: '"abc123"',
          }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const probe = await probeRemoteDataFile('Israel.pois.geojson', { preferHead: true });
    expect(calls[0]).toEqual({
      url: `${REMOTE_DATA_ORIGIN}/data/Israel.pois.geojson`,
      method: 'HEAD',
    });
    expect(probe).toEqual({
      url: `${REMOTE_DATA_FALLBACK_ORIGIN}/data/Israel.pois.geojson`,
      size: 4336165,
      etag: '"abc123"',
    });
  });

  it('downloads from Firebase when absent locally and writes OPFS + sync metadata', async () => {
    (globalThis as any).window = {
      location: { origin: 'https://navapp-israel-topo.web.app', hostname: 'navapp-israel-topo.web.app' },
    };
    vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(false);
    vi.spyOn(OpfsStorageAdapter, 'isSupported').mockReturnValue(true);
    vi.spyOn(OpfsStorageAdapter, 'getStoredFile').mockResolvedValue(null);
    const saveSpy = vi
      .spyOn(OpfsStorageAdapter, 'saveOrReplaceFromStream')
      .mockImplementation(async (_name, source) => ({
        name: 'Israel.pois.geojson',
        size: typeof source === 'string' ? source.length : source.size,
        lastModified: Date.now(),
      }) as unknown as File);

    const payload = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'poi-1',
          geometry: { type: 'Point', coordinates: [35.2, 31.7] },
          properties: { nameHe: 'מעיין בדיקה' },
        },
      ],
    });
    const payloadBytes = new TextEncoder().encode(payload);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe(`${REMOTE_DATA_ORIGIN}/data/Israel.pois.geojson`);
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          etag: '"v1"',
        }),
        arrayBuffer: async () => payloadBytes.buffer.slice(0),
      } as unknown as Response;
    });

    const mgr = new OfflineDataFilesManager();
    const json = await mgr.loadJson('Israel.pois.geojson');
    expect(json?.features).toHaveLength(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);

    // Wait microtask for fire-and-forget OPFS save metadata write
    await new Promise((r) => setTimeout(r, 15));
    expect(readDataFileMeta('Israel.pois.geojson')).toEqual({
      size: payloadBytes.byteLength,
      etag: '"v1"',
    });
  });

  it('serves cached OPFS file immediately and triggers background update when Firebase ETag changes', async () => {
    (globalThis as any).window = {
      location: { origin: 'https://navapp-israel-topo.web.app', hostname: 'navapp-israel-topo.web.app' },
    };
    vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(false);
    vi.spyOn(OpfsStorageAdapter, 'isSupported').mockReturnValue(true);

    const oldJson = JSON.stringify({ type: 'FeatureCollection', features: [{ id: 'old' }] });
    const newJson = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ id: 'new-1' }, { id: 'new-2' }],
    });
    const oldBytes = new TextEncoder().encode(oldJson);
    const newBytes = new TextEncoder().encode(newJson);

    const opfsFile = {
      name: 'Israel.pois.geojson',
      size: oldBytes.byteLength,
      lastModified: 1_700_000_000_000,
      arrayBuffer: async () => oldBytes.buffer.slice(0),
    } as unknown as File;

    vi.spyOn(OpfsStorageAdapter, 'getStoredFile').mockResolvedValue(opfsFile);
    const saveSpy = vi
      .spyOn(OpfsStorageAdapter, 'saveOrReplaceFromStream')
      .mockResolvedValue({
        name: 'Israel.pois.geojson',
        size: newBytes.byteLength,
        lastModified: 1_700_000_100_000,
      } as unknown as File);

    writeDataFileMeta('Israel.pois.geojson', {
      size: oldBytes.byteLength,
      etag: '"v1"',
    });

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method || 'GET').toUpperCase() === 'HEAD') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/json',
            'content-length': String(newBytes.byteLength),
            etag: '"v2"',
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          'content-length': String(newBytes.byteLength),
          etag: '"v2"',
        }),
        arrayBuffer: async () => newBytes.buffer.slice(0),
      } as unknown as Response;
    });

    const mgr = new OfflineDataFilesManager();
    const updatedFiles: string[] = [];
    mgr.onDataFileUpdated((fileName) => updatedFiles.push(fileName));

    const firstLoad = await mgr.loadJson('Israel.pois.geojson');
    expect(firstLoad.features[0].id).toBe('old');

    // Allow background Firebase check + download to finish
    await new Promise((r) => setTimeout(r, 40));
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(updatedFiles).toEqual(['Israel.pois.geojson']);
    expect(readDataFileMeta('Israel.pois.geojson')?.etag).toBe('"v2"');
  });

  it('prefers native Android storage for search index and clears all 3 files on removeOfflineBundle', async () => {
    (globalThis as any).window = {
      location: { origin: 'https://localhost', hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    };
    vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(true);
    vi.spyOn(OpfsStorageAdapter, 'isSupported').mockReturnValue(false);

    const idxContent = new TextEncoder().encode(
      JSON.stringify({ v: 1, fingerprint: 'abc', totalFeatures: 1, layers: [], classes: [], rows: [] })
    );

    vi.spyOn(NativeOfflineStorage, 'getArchiveStatus').mockResolvedValue({
      supported: true,
      freeBytes: 2_000_000_000,
      totalBytes: 32_000_000_000,
      files: {
        'Israel.search.idx': {
          exists: true,
          valid: true,
          sizeBytes: idxContent.byteLength,
          lastModifiedMs: 1_700_000_000_000,
          nativeUrl: 'https://localhost/__native_maps__/Israel.search.idx',
          localPath: '/files/maps/Israel.search.idx',
        },
      },
    });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://localhost/__native_maps__/Israel.search.idx')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => idxContent.buffer.slice(0),
        } as unknown as Response;
      }
      if ((init?.method || 'GET') === 'HEAD') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/octet-stream',
            'content-length': String(idxContent.byteLength),
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, headers: new Headers() } as unknown as Response;
    });

    const mgr = new OfflineDataFilesManager();
    const bytes = await mgr.loadBytes('Israel.search.idx');
    expect(bytes?.byteLength).toBe(idxContent.byteLength);

    const removeNativeSpy = vi.spyOn(NativeOfflineStorage, 'removeArchive').mockResolvedValue();
    const removeOpfsSpy = vi.spyOn(OpfsStorageAdapter, 'removeFile').mockResolvedValue();
    writeDataFileMeta('Israel.pois.geojson', { size: 123 });

    await mgr.removeOfflineBundle();

    for (const fileName of OFFLINE_DATA_FILE_NAMES) {
      expect(removeNativeSpy).toHaveBeenCalledWith(fileName);
      expect(removeOpfsSpy).toHaveBeenCalledWith(fileName);
    }
    expect(readDataFileMeta('Israel.pois.geojson')).toBeNull();
    clearDataFileMeta('Israel.search.idx');
  });

  it('devops/map-data-common defines all Firebase data files and validates file formats', async () => {
    // @ts-expect-error ESM devops helper has no .d.ts declaration
    const commonMod: any = await import('../../../devops/script_helpers/map-data-common.mjs');
    expect(commonMod.MAP_DATA_FILES.map((f: any) => f.fileName)).toEqual([
      'Israel.dem.pmtiles',
      'Israel.osm.pmtiles',
      'Israel.pois.geojson',
      'Israel.search.idx',
      'Israel.trails.json',
    ]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navapp-data-test-'));
    try {
      const goodGeo = path.join(tmpDir, 'Israel.pois.geojson');
      const badGeo = path.join(tmpDir, 'bad.geojson');
      const goodIdx = path.join(tmpDir, 'Israel.search.idx');
      const goodPm = path.join(tmpDir, 'Israel.osm.pmtiles');

      fs.writeFileSync(goodGeo, JSON.stringify({ type: 'FeatureCollection', features: [] }));
      fs.writeFileSync(badGeo, '<!doctype html><html><body>404</body></html>');
      fs.writeFileSync(goodIdx, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.alloc(32)]));
      fs.writeFileSync(goodPm, Buffer.concat([Buffer.from('PMTiles\x03'), Buffer.alloc(128)]));

      expect(commonMod.isValidLocalDataFile(goodGeo, 'Israel.pois.geojson')).toBe(true);
      expect(commonMod.isValidLocalDataFile(badGeo, 'Israel.pois.geojson')).toBe(false);
      expect(commonMod.isValidLocalDataFile(goodIdx, 'Israel.search.idx')).toBe(true);
      expect(commonMod.isValidLocalDataFile(goodPm, 'Israel.osm.pmtiles')).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('routes Android Capacitor Firebase Storage DEM URLs through same-origin /__remote_proxy__/ and unwraps for native downloads', async () => {
    const storageDemUrl =
      'https://firebasestorage.googleapis.com/v0/b/navapp-israel-topo.firebasestorage.app/o/map_data%2FIsrael.dem.pmtiles?alt=media';
    vi.stubEnv('VITE_DEM_PMTILES_URL', storageDemUrl);

    // Non-Android web keeps direct storage URL untouched
    (globalThis as any).window = {
      location: { origin: 'https://navapp-israel-topo.web.app', hostname: 'navapp-israel-topo.web.app' },
    };
    expect(isAndroidNativePlatform()).toBe(false);
    expect(wrapAndroidRemoteProxyUrl('Israel.dem.pmtiles', storageDemUrl)).toBe(storageDemUrl);

    // iOS Capacitor keeps direct URL untouched (iOS does not intercept Android /__remote_proxy__/)
    (globalThis as any).window = {
      location: { origin: 'capacitor://localhost', hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    };
    expect(isAndroidNativePlatform()).toBe(false);
    expect(wrapAndroidRemoteProxyUrl('Israel.dem.pmtiles', storageDemUrl)).toBe(storageDemUrl);

    // Android Capacitor wraps Firebase Storage URL onto same-origin /__remote_proxy__/
    (globalThis as any).window = {
      location: { origin: 'https://localhost', hostname: 'localhost' },
      Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    };
    expect(isAndroidNativePlatform()).toBe(true);
    const wrapped = wrapAndroidRemoteProxyUrl('Israel.dem.pmtiles', storageDemUrl);
    expect(wrapped).toBe(
      `https://localhost/__remote_proxy__/Israel.dem.pmtiles?url=${encodeURIComponent(storageDemUrl)}`
    );
    expect(unwrapAndroidRemoteProxyUrl(wrapped)).toBe(storageDemUrl);
    expect(pmtilesUrl('Israel.dem.pmtiles')).toBe(wrapped);

    // probeRemoteDataFile probes the same-origin proxy URL when running in Android WebView
    const probedUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      probedUrls.push(url);
      if (url === wrapped) {
        return {
          ok: true,
          status: 206,
          headers: new Headers({
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 0-0/1402183369',
            'content-length': '1',
            etag: '"dem-etag"',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, headers: new Headers() } as unknown as Response;
    });

    const probe = await probeRemoteDataFile('Israel.dem.pmtiles');
    expect(probedUrls[0]).toBe(wrapped);
    expect(probe).toEqual({
      url: wrapped,
      size: 1402183369,
      etag: '"dem-etag"',
    });
  });

  it('handles CDN Content-Encoding: br compressed Content-Length without Incomplete download errors or bogus updates', async () => {
    (globalThis as any).window = {
      location: { origin: 'https://navapp-israel-topo.web.app', hostname: 'navapp-israel-topo.web.app' },
    };
    vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(false);

    const opfsFiles = new Map<string, Uint8Array>();
    const makeMockDir = () => ({
      getDirectoryHandle: async () => makeMockDir(),
      getFileHandle: async (name: string) => ({
        createWritable: async () => {
          const chunks: Uint8Array[] = [];
          return {
            write: async (chunk: BufferSource) => {
              const view =
                chunk instanceof ArrayBuffer
                  ? new Uint8Array(chunk)
                  : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              chunks.push(view.slice());
            },
            close: async () => {
              const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
              const out = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                out.set(c, off);
                off += c.byteLength;
              }
              opfsFiles.set(name, out);
            },
            abort: async () => {},
          };
        },
        move: async (targetName: string) => {
          const buf = opfsFiles.get(name);
          if (buf) {
            opfsFiles.delete(name);
            opfsFiles.set(targetName, buf);
          }
        },
        getFile: async () => {
          const data = opfsFiles.get(name);
          if (!data) throw new Error('NotFoundError');
          return {
            name,
            size: data.byteLength,
            lastModified: Date.now(),
            arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          } as unknown as File;
        },
      }),
      removeEntry: async (name: string) => {
        opfsFiles.delete(name);
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { storage: { getDirectory: async () => makeMockDir() } },
      configurable: true,
      writable: true,
    });

    const v1Payload = new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from({ length: 20 }, (_, i) => ({
          type: 'Feature',
          id: `v1-${i}`,
          geometry: { type: 'Point', coordinates: [35.2, 31.7] },
          properties: { nameHe: `נקודה ראשונה ${i}` },
        })),
      })
    );
    const v2Payload = new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from({ length: 12 }, (_, i) => ({
          type: 'Feature',
          id: `v2-${i}`,
          geometry: { type: 'Point', coordinates: [35.3, 31.8] },
          properties: { nameHe: `נקודה מעודכנת ${i}` },
        })),
      })
    );

    opfsFiles.set('Israel.pois.geojson', v1Payload);
    writeDataFileMeta('Israel.pois.geojson', {
      size: v1Payload.byteLength,
      etag: '"same-br"',
    });

    let currentEtag = '"same-br"';
    let currentTransferSize = 312;
    let currentBody = v1Payload;
    let getCount = 0;

    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'HEAD') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'content-type': 'application/geo+json',
            'content-encoding': 'br',
            'content-length': String(currentTransferSize),
            etag: currentEtag,
          }),
        } as unknown as Response;
      }
      getCount += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(currentBody);
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/geo+json',
          'content-encoding': 'br',
          'content-length': String(currentTransferSize),
          etag: currentEtag,
        }),
        body: stream,
      } as unknown as Response;
    });

    // 1. Probe preserves compressedTransfer flag so decoded vs compressed sizes are never confused
    const probeSame = await probeRemoteDataFile('Israel.pois.geojson', { preferHead: true });
    expect(probeSame?.compressedTransfer).toBe(true);
    expect(probeSame?.size).toBe(312);

    // 2. Matching ETag skips bogus background re-download despite HEAD compressed size != decoded OPFS size
    const mgr1 = new OfflineDataFilesManager();
    const res1 = await mgr1.loadJson('Israel.pois.geojson');
    expect(res1.features[0].id).toBe('v1-0');
    await new Promise((r) => setTimeout(r, 30));
    expect(getCount).toBe(0);

    // 3. New ETag streams full decoded body through real OpfsStorageAdapter without Incomplete download
    currentEtag = '"v2-br"';
    currentTransferSize = 188;
    currentBody = v2Payload;
    const mgr2 = new OfflineDataFilesManager();
    const updated: string[] = [];
    mgr2.onDataFileUpdated((f) => updated.push(f));
    await mgr2.loadJson('Israel.pois.geojson');
    await new Promise((r) => setTimeout(r, 40));

    expect(getCount).toBe(1);
    expect(updated).toEqual(['Israel.pois.geojson']);
    expect(opfsFiles.get('Israel.pois.geojson')?.byteLength).toBe(v2Payload.byteLength);
    expect(readDataFileMeta('Israel.pois.geojson')).toEqual({
      size: v2Payload.byteLength,
      transferSize: 188,
      etag: '"v2-br"',
    });
  });

  it('omits unreachable DEM sources cleanly when disableDem is true and validates local DEM PMTiles headers before persisting', async () => {
    const styleSpec = createRequire(import.meta.url)('@maplibre/maplibre-gl-style-spec');
    for (const mapStyle of ['ihm', 'nms', 'govmap'] as const) {
      const style = buildIsraelOutdoorStyle({
        osmProtocolUrl: 'pmtiles://israel-osm',
        demProtocolUrl: null,
        contourProtocolUrl: null,
        disableDem: true,
        visibility: DEFAULT_LAYER_VISIBILITY,
        theme: 'topo-day',
        mapStyle,
      });
      expect(style.sources['israel-dem']).toBeUndefined();
      expect(style.sources['israel-dem-hillshade']).toBeUndefined();
      expect(style.sources['israel-contours']).toBeUndefined();
      expect(styleSpec.validateStyleMin(style)).toEqual([]);
    }

    const registry = new PMTilesRegistry();
    const badHtmlFile = new File(['<html>404</html>'.repeat(10)], 'Israel.dem.pmtiles', {
      type: 'text/html',
    });
    await expect(registry.mountLocalDemArchive(badHtmlFile, undefined, true)).rejects.toThrow(
      'PMTiles'
    );
  });

  it('falls back to dedicated hosting:dem when Firebase Storage is blocked and preserves cached DEM offline', async () => {
    const storageDemUrl =
      'https://firebasestorage.googleapis.com/v0/b/navapp-israel-topo.firebasestorage.app/o/map_data%2FIsrael.dem.pmtiles?alt=media';
    const hostingDemUrl = `${REMOTE_DEM_HOSTING_ORIGIN}/data/Israel.dem.pmtiles`;
    vi.stubEnv('VITE_DEM_PMTILES_URL', storageDemUrl);

    (globalThis as any).window = {
      location: { origin: 'https://navapp-israel-topo.web.app', hostname: 'navapp-israel-topo.web.app' },
    };

    expect(getDemCandidateUrls()).toEqual([
      storageDemUrl,
      hostingDemUrl,
      `${REMOTE_DATA_ORIGIN}/data/Israel.dem.pmtiles`,
      `${REMOTE_DATA_FALLBACK_ORIGIN}/data/Israel.dem.pmtiles`,
    ]);

    // Simulate restricted network blocking firebasestorage.googleapis.com with 403 while hosting:dem responds
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === storageDemUrl) {
        return { ok: false, status: 403, headers: new Headers() } as unknown as Response;
      }
      if (url === hostingDemUrl) {
        return {
          ok: true,
          status: 206,
          headers: new Headers({
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 0-0/1402183369',
            'content-length': '1',
            etag: '"dem-hosting"',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, headers: new Headers() } as unknown as Response;
    });

    const probe = await probeRemoteDataFile('Israel.dem.pmtiles');
    expect(probe).toEqual({
      url: hostingDemUrl,
      size: 1402183369,
      etag: '"dem-hosting"',
    });

    // When offline and probeRemote returns null, cached DEM header keeps DEM mounted instead of disabling elevation
    const origCaches = (globalThis as any).caches;
    try {
      const headerBuf = new Uint8Array(16384);
      headerBuf.set([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03], 0); // PMTiles v3 magic
      const store = new Map<string, Response>([
        [
          `https://pmtiles-range-cache.invalid/${encodeURIComponent('immutable:Israel.dem.pmtiles')}/0-16384`,
          new Response(headerBuf, { headers: { 'x-etag': '"cached-dem"' } }),
        ],
      ]);
      (globalThis as any).caches = {
        open: async () => ({
          match: async (req: Request) => store.get(req.url)?.clone(),
          put: async (req: Request, res: Response) => {
            store.set(req.url, res.clone());
          },
          delete: async (req: Request) => store.delete(req.url),
        }),
        delete: async () => true,
      };

      vi.spyOn(OpfsStorageAdapter, 'getStoredFile').mockResolvedValue(null);
      const registry = new PMTilesRegistry();
      vi.spyOn(registry, 'probeRemote').mockResolvedValue(null);
      registry.initProtocols();
      const defaultDem = registry.getArchive('israel-dem')!;
      vi.spyOn(defaultDem, 'getHeader').mockResolvedValue({
        specVersion: 3,
        rootDirectoryOffset: 127,
        rootDirectoryLength: 256,
        jsonMetadataOffset: 383,
        jsonMetadataLength: 0,
        leafDirectoryOffset: 0,
        leafDirectoryLength: 0,
        tileDataOffset: 1024,
        tileDataLength: 1402182345,
        numAddressedTiles: 1,
        numTileEntries: 1,
        numTileContents: 1,
        clustered: true,
        internalCompression: 2,
        tileCompression: 1,
        tileType: 2,
        minZoom: 0,
        maxZoom: 14,
        minLon: 34.11,
        minLat: 29.41,
        maxLon: 36.01,
        maxLat: 33.39,
        centerZoom: 8,
        centerLon: 35.0,
        centerLat: 31.5,
      });
      vi.spyOn(defaultDem, 'getMetadata').mockResolvedValue({});

      const mounted = await registry.resolveArchive('israel-dem', 'Israel.dem.pmtiles', true);
      expect(mounted).not.toBeNull();
      expect(registry.isDemUnavailable()).toBe(false);
    } finally {
      (globalThis as any).caches = origCaches;
    }
  });
});
