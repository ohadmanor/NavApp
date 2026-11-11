import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import maplibregl from 'maplibre-gl';
import {
  buildCarSyncPayload,
  carSyncService,
  selectCarSyncablePois,
  serializeCarRoute,
} from '../car/CarSyncService';
import {
  arrayBufferToBase64,
  NativeOfflineStorage,
} from '../pmtiles/NativeOfflineStorage';
import { OpfsStorageAdapter } from '../pmtiles/OpfsStorageAdapter';
import { PMTilesRegistry } from '../pmtiles/PMTilesRegistry';
import { DEFAULT_LAYER_VISIBILITY } from '../style/israelOutdoorStyle';
import type { PoiRecord, SavedRouteRecord } from '../db/NavDatabase';

function makeRoute(overrides: Partial<SavedRouteRecord> = {}): SavedRouteRecord {
  return {
    id: 'route-1',
    name: 'נחל עקב מעגלי',
    sourceFormat: 'gpx',
    distanceKm: 12.4,
    ascentMeters: 340,
    descentMeters: 340,
    minEle: 210,
    maxEle: 510,
    color: '#f97316',
    visible: true,
    createdAt: '2026-11-11T10:00:00.000Z',
    gpxXml: '<gpx><trk><name>huge-raw-xml</name></trk></gpx>',
    elevationProfile: [
      { distKm: 0, ele: 210, lon: 34.81, lat: 30.83 },
      { distKm: 12.4, ele: 210, lon: 34.82, lat: 30.84 },
    ],
    geojson: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [34.81, 30.83],
              [34.82, 30.84],
            ],
          },
        },
      ],
    },
    ...overrides,
  };
}

function makePoi(overrides: Partial<PoiRecord> = {}): PoiRecord {
  return {
    id: 'poi-base-1',
    name: 'עין עקב',
    nameHe: 'עין עקב',
    nameEn: 'Ein Akev',
    category: 'water',
    subcategory: 'spring',
    lon: 34.812,
    lat: 30.831,
    ele: 410,
    waterStatus: 'פעיל כל השנה',
    difficulty4x4: null,
    descHe: 'גב מים קריר ונקי',
    descEn: 'Cold desert spring',
    source: 'ihm',
    wikipedia: null,
    priority: 10,
    ...overrides,
  };
}

function mockFetchForPmtiles(filePath: string) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, 'r');
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://localhost/__native_maps__/Israel.osm.pmtiles')) {
      return new Response('', { status: 404 });
    }
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'content-length': String(stat.size),
      etag: `"${stat.size}-${stat.mtimeMs}"`,
      'last-modified': stat.mtime.toUTCString(),
    });
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    const reqHeaders = new Headers(init?.headers);
    const range = reqHeaders.get('range') || 'bytes=0-16383';
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match ? Math.min(Number(match[2]), stat.size - 1) : 16383;
    const len = end - start + 1;
    const buf = Buffer.allocUnsafe(len);
    const readLen = fs.readSync(fd, buf, 0, len, start);
    const slice = buf.buffer.slice(buf.byteOffset, buf.byteOffset + readLen);
    return new Response(slice, {
      status: 206,
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'content-length': String(readLen),
        'content-range': `bytes ${start}-${start + readLen - 1}/${stat.size}`,
      }),
    });
  });

  return {
    stat,
    restore: () => {
      fetchSpy.mockRestore();
      fs.closeSync(fd);
    },
  };
}

describe('Android Auto Sync, Native Offline Storage & Car Style Templates', () => {
  beforeEach(() => {
    carSyncService.resetCacheForTesting();
  });

  afterEach(() => {
    carSyncService.resetCacheForTesting();
    vi.restoreAllMocks();
  });

  it('serializes compact routes without bulky rawGpxXml and filters only syncable/edited POIs', () => {
    const route = makeRoute();
    const compact = serializeCarRoute(route);
    expect(compact.id).toBe('route-1');
    expect((compact as any).gpxXml).toBeUndefined();
    expect((compact as any).elevationProfile).toBeUndefined();
    expect(compact.geojson.features).toHaveLength(1);

    const bundledUnedited = makePoi({ id: 'osm-node-123' });
    const bundledEdited = makePoi({ id: 'osm-node-999', userNotes: 'שביל ירד בשטפון' });
    const userPoi = makePoi({ id: 'user-poi-42', category: 'user', nameHe: 'חניון לילה סודי' });
    const importedPoi = makePoi({ id: 'import-gpx-7', category: 'campsite', nameHe: 'נקודת מפגש' });
    const ilCommunityPoi = makePoi({ id: 'il-poi-88', category: 'offroad', nameHe: 'מעלה צין' });

    const selected = selectCarSyncablePois([
      bundledUnedited,
      bundledEdited,
      userPoi,
      importedPoi,
      ilCommunityPoi,
    ]);

    expect(selected.map((p) => p.id)).toEqual([
      'osm-node-999',
      'user-poi-42',
      'import-gpx-7',
      'il-poi-88',
    ]);
    expect(selected[0].userNotes).toBe('שביל ירד בשטפון');
  });

  it('builds consistent CarSync payloads and sends incremental deltas only for changed fields', async () => {
    const route = makeRoute();
    const poi = makePoi({ id: 'user-poi-1', category: 'user', nameHe: 'פינת קפה' });

    const payload = buildCarSyncPayload({
      activeRoute: route,
      routes: [route],
      pois: [poi],
      isNavigationActive: true,
      theme: 'topo-dark',
      visibility: { ...DEFAULT_LAYER_VISIBILITY, googleSatellite: true },
    });

    expect(JSON.parse(payload.activeRouteJson).id).toBe('route-1');
    expect(JSON.parse(payload.savedRoutesJson)).toHaveLength(1);
    expect(JSON.parse(payload.userPoisJson)).toHaveLength(1);
    const carState = JSON.parse(payload.carStateJson);
    expect(carState.isNavigationActive).toBe(true);
    expect(carState.theme).toBe('topo-dark');
    expect(carState.visibility.googleSatellite).toBe(true);
    expect(carState.visibility.poiUser).toBe(true);

    vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(true);
    const syncSpy = vi.spyOn(NativeOfflineStorage, 'syncCarData').mockResolvedValue();

    const snapshot = {
      activeRoute: route,
      routes: [route],
      pois: [poi],
      isNavigationActive: false,
      theme: 'topo-day' as const,
      visibility: DEFAULT_LAYER_VISIBILITY,
    };

    await carSyncService.syncNow(snapshot);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy.mock.calls[0][0].activeRouteJson).toBeDefined();
    expect(syncSpy.mock.calls[0][0].savedRoutesJson).toBeDefined();
    expect(syncSpy.mock.calls[0][0].userPoisJson).toBeDefined();
    expect(syncSpy.mock.calls[0][0].carStateJson).toBeDefined();

    // Toggling only theme must NOT re-send heavy routes or POIs
    await carSyncService.syncNow({
      ...snapshot,
      theme: 'topo-dark',
    });
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy.mock.calls[1][0].activeRouteJson).toBeUndefined();
    expect(syncSpy.mock.calls[1][0].savedRoutesJson).toBeUndefined();
    expect(syncSpy.mock.calls[1][0].userPoisJson).toBeUndefined();
    expect(JSON.parse(syncSpy.mock.calls[1][0].carStateJson!).theme).toBe('topo-dark');
  });

  it('encodes binary slices via arrayBufferToBase64 and forwards download progress/cancellation cleanly', async () => {
    const raw = new Uint8Array([0x50, 0x4d, 0x54, 0x69, 0x6c, 0x65, 0x73, 0x03]); // "PMTiles\x03"
    const encoded = arrayBufferToBase64(raw.buffer);
    expect(Buffer.from(encoded, 'base64')).toEqual(Buffer.from(raw));

    vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(true);
    let capturedProgressCb: ((ev: { fileName: string; loaded: number; total: number }) => void) | null = null;
    const removeListenerSpy = vi.fn().mockResolvedValue(undefined);
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    const mockPlugin = {
      getArchiveStatus: vi.fn(),
      downloadArchive: vi.fn(async (opts: { fileName: string }) => {
        capturedProgressCb?.({ fileName: 'other.pmtiles', loaded: 50, total: 100 });
        capturedProgressCb?.({ fileName: opts.fileName, loaded: 512, total: 1024 });
        return {
          exists: true,
          valid: true,
          sizeBytes: 1024,
          lastModifiedMs: 12345,
          nativeUrl: 'https://localhost/__native_maps__/Israel.osm.pmtiles',
          localPath: '/data/user/0/com.navapp.outdoor.israel/files/maps/Israel.osm.pmtiles',
        };
      }),
      cancelDownload: cancelSpy,
      beginChunkedWrite: vi.fn(),
      appendChunkBase64: vi.fn(),
      finishChunkedWrite: vi.fn(),
      abortChunkedWrite: vi.fn(),
      removeArchive: vi.fn(),
      syncCarData: vi.fn(),
      getCarSyncState: vi.fn(),
      addListener: vi.fn(async (_name: string, cb: any) => {
        capturedProgressCb = cb;
        return { remove: removeListenerSpy };
      }),
    };
    vi.spyOn(NativeOfflineStorage, 'getPlugin').mockReturnValue(mockPlugin as any);

    const ac = new AbortController();
    ac.abort();

    await expect(
      NativeOfflineStorage.downloadArchive(
        'Israel.osm.pmtiles',
        'https://example.com/Israel.osm.pmtiles',
        1000,
        undefined,
        ac.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelSpy).not.toHaveBeenCalled();

    const events: Array<[number, number]> = [];
    const status = await NativeOfflineStorage.downloadArchive(
      'Israel.osm.pmtiles',
      'https://example.com/Israel.osm.pmtiles',
      1024,
      (loaded, total) => events.push([loaded, total])
    );

    expect(events).toEqual([[512, 1024]]);
    expect(removeListenerSpy).toHaveBeenCalledTimes(1);
    expect(status.nativeUrl).toBe('https://localhost/__native_maps__/Israel.osm.pmtiles');

    // In-flight cancellation invokes native cancelDownload and rejects with AbortError
    const inFlightAc = new AbortController();
    mockPlugin.downloadArchive.mockImplementationOnce(async () => {
      inFlightAc.abort();
      throw new Error('Cancelled');
    });
    await expect(
      NativeOfflineStorage.downloadArchive(
        'Israel.osm.pmtiles',
        'https://example.com/Israel.osm.pmtiles',
        1024,
        undefined,
        inFlightAc.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelSpy).toHaveBeenCalledWith({ fileName: 'Israel.osm.pmtiles' });
  });

  it('PMTilesRegistry prefers shared native-file storage on Android and migrates legacy OPFS copies', async () => {
    const pmtilesPath = path.resolve('data/Israel.osm.pmtiles');
    const mockServer = mockFetchForPmtiles(pmtilesPath);
    const addProtoSpy = vi.spyOn(maplibregl, 'addProtocol').mockImplementation(() => {});

    try {
      vi.spyOn(NativeOfflineStorage, 'isAndroidNative').mockReturnValue(true);
      vi.spyOn(NativeOfflineStorage, 'getArchiveStatus').mockResolvedValue({
        supported: true,
        freeBytes: 5_000_000_000,
        totalBytes: 64_000_000_000,
        files: {
          'Israel.osm.pmtiles': {
            exists: true,
            valid: true,
            sizeBytes: mockServer.stat.size,
            lastModifiedMs: 1700000000000,
            nativeUrl: 'https://localhost/__native_maps__/Israel.osm.pmtiles',
            localPath: '/data/data/com.navapp.outdoor.israel/files/maps/Israel.osm.pmtiles',
          },
        },
      });
      const opfsGetSpy = vi.spyOn(OpfsStorageAdapter, 'getStoredFile').mockResolvedValue({
        name: 'Israel.osm.pmtiles',
        size: mockServer.stat.size,
        lastModified: 1700000000000,
      } as unknown as File);
      const opfsRemoveSpy = vi.spyOn(OpfsStorageAdapter, 'removeFile').mockResolvedValue();

      const registry = new PMTilesRegistry();
      const mounted = await registry.resolveArchive('israel-osm', 'Israel.osm.pmtiles', false);

      expect(mounted).not.toBeNull();
      expect(mounted?.record.storageKind).toBe('native-file');
      expect(mounted?.protocolUrl).toContain('https://localhost/__native_maps__/Israel.osm.pmtiles?v=');
      expect(mounted?.hasTrailColorSchema).toBe(true);
      // Duplicate legacy OPFS file is automatically cleaned up once native copy is confirmed
      expect(opfsGetSpy).toHaveBeenCalledWith('Israel.osm.pmtiles');
      expect(opfsRemoveSpy).toHaveBeenCalledWith('Israel.osm.pmtiles');

      // When native copy is missing but OPFS exists, migrates chunked into native storage
      vi.spyOn(NativeOfflineStorage, 'getArchiveStatus').mockResolvedValue({
        supported: true,
        freeBytes: 5_000_000_000,
        totalBytes: 64_000_000_000,
        files: {},
      });
      const rawBytes = fs.readFileSync(pmtilesPath).subarray(0, 65536);
      const opfsBlob = new File([rawBytes], 'Israel.osm.pmtiles', { lastModified: 1700000000000 });
      opfsGetSpy.mockResolvedValue(opfsBlob);
      const saveChunkedSpy = vi.spyOn(NativeOfflineStorage, 'saveBlobChunked').mockResolvedValue({
        exists: true,
        valid: true,
        sizeBytes: mockServer.stat.size,
        lastModifiedMs: 1700000005000,
        nativeUrl: 'https://localhost/__native_maps__/Israel.osm.pmtiles',
        localPath: '/data/data/com.navapp.outdoor.israel/files/maps/Israel.osm.pmtiles',
      });

      const registryMig = new PMTilesRegistry();
      const updatedEvents: any[] = [];
      registryMig.onArchiveUpdated((_id, info) => updatedEvents.push(info));
      // Mock mountFromFile so the partial 64KB test blob doesn't reject while migration proceeds
      vi.spyOn(registryMig, 'mountFromFile').mockResolvedValue({
        id: 'israel-osm',
        protocolUrl: 'pmtiles://opfs',
        pmtiles: {} as any,
        record: {
          id: 'israel-osm',
          fileName: 'Israel.osm.pmtiles',
          role: 'osm-updatable',
          storageKind: 'opfs',
          urlOrPath: 'Israel.osm.pmtiles',
          sizeBytes: rawBytes.length,
          createdUtc: '',
          minZoom: 0,
          maxZoom: 14,
          bounds: [34, 29, 36, 33],
          lastVerifiedAt: '',
          isLockedConstant: false,
        },
        vectorLayers: ['transportation'],
      });

      await registryMig.resolveArchive('israel-osm', 'Israel.osm.pmtiles', false);
      // Wait briefly for queued background migration promise
      await new Promise((r) => setTimeout(r, 150));

      expect(saveChunkedSpy).toHaveBeenCalledWith(
        'Israel.osm.pmtiles',
        opfsBlob,
        expect.any(Function)
      );
      expect(updatedEvents.some((u) => u.record?.storageKind === 'native-file')).toBe(true);
    } finally {
      mockServer.restore();
      addProtoSpy.mockRestore();
    }
  });

  it('emits MapLibre Native v8 car style templates with placeholders and no Web contour sources', async () => {
    const dayPath = path.resolve('android/app/src/main/assets/car_style_day.json');
    const darkPath = path.resolve('android/app/src/main/assets/car_style_dark.json');

    expect(fs.existsSync(dayPath)).toBe(true);
    expect(fs.existsSync(darkPath)).toBe(true);

    for (const stylePath of [dayPath, darkPath]) {
      const parsed = JSON.parse(fs.readFileSync(stylePath, 'utf-8'));
      expect(parsed.version).toBe(8);
      expect(parsed.sprite).toBe('__SPRITE_URL__');
      expect(parsed.glyphs).toBe('__GLYPHS_URL__');
      expect(parsed.sources['israel-osm'].url).toBe('__OSM_URL__');
      expect(parsed.sources['israel-dem-hillshade'].url).toBe('__DEM_URL__');
      expect(parsed.sources['israel-contours']).toBeUndefined();
      expect(parsed.terrain).toBeUndefined();
      expect(parsed.layers.some((l: any) => String(l.id).startsWith('contour-'))).toBe(false);
      expect(parsed.layers.some((l: any) => l.id === 'trail-israel-secondary-')).toBe(true);
      expect(parsed.layers.some((l: any) => l.id === 'Terrain')).toBe(true);
      expect(parsed.layers.length).toBeGreaterThanOrEqual(240);
    }
  });
});
