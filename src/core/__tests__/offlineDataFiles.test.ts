import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DATA_FALLBACK_ORIGIN,
  REMOTE_DATA_ORIGIN,
  bundledDataUrl,
  isLocalDevServer,
  pmtilesUrl,
  remoteDataUrl,
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

describe('Firebase data source (GeoJSON POIs + search index + PMTiles)', () => {
  const origWindow = (globalThis as any).window;
  const origFetch = globalThis.fetch;
  const origLocalStorage = (globalThis as any).localStorage;

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
    vi.restoreAllMocks();
    (globalThis as any).window = origWindow;
    globalThis.fetch = origFetch;
    (globalThis as any).localStorage = origLocalStorage;
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

  it('devops/map-data-common defines all 5 Firebase files and validates file formats', async () => {
    // @ts-expect-error ESM devops helper has no .d.ts declaration
    const commonMod: any = await import('../../../devops/map-data-common.mjs');
    expect(commonMod.MAP_DATA_FILES.map((f: any) => f.fileName)).toEqual([
      'Israel.dem.pmtiles',
      'Israel.osm.pmtiles',
      'Israel.pois.geojson',
      'Israel.offroad.pois.geojson',
      'Israel.search.idx',
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
});
