import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  writeFile: vi.fn(),
}));

const firebaseMocks = vi.hoisted(() => ({
  getFirebaseServices: vi.fn(),
  doc: vi.fn(() => ({})),
  collection: vi.fn(() => ({})),
  collectionGroup: vi.fn((_fs: unknown, name: string) => ({ collectionGroup: name })),
  query: vi.fn((colRef: unknown, ...constraints: unknown[]) => ({ colRef, constraints })),
  where: vi.fn((field: string, op: string, val: unknown) => ({ field, op, val })),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDocs: vi.fn(),
  onSnapshot: vi.fn(),
  ref: vi.fn(() => ({})),
  uploadString: vi.fn(),
  getDownloadURL: vi.fn(),
  listAll: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: capacitorMocks.isNativePlatform,
    },
  };
});

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    Documents: 'DOCUMENTS',
    Data: 'DATA',
  },
  Encoding: {
    UTF8: 'utf8',
  },
  Filesystem: {
    writeFile: capacitorMocks.writeFile,
  },
}));

vi.mock('../firebase/firebaseApp', () => ({
  getFirebaseServices: firebaseMocks.getFirebaseServices,
}));
vi.mock('firebase/firestore', () => ({
  doc: firebaseMocks.doc,
  collection: firebaseMocks.collection,
  collectionGroup: firebaseMocks.collectionGroup,
  query: firebaseMocks.query,
  where: firebaseMocks.where,
  setDoc: firebaseMocks.setDoc,
  deleteDoc: firebaseMocks.deleteDoc,
  getDocs: firebaseMocks.getDocs,
  onSnapshot: firebaseMocks.onSnapshot,
}));
vi.mock('firebase/storage', () => ({
  ref: firebaseMocks.ref,
  uploadString: firebaseMocks.uploadString,
  getDownloadURL: firebaseMocks.getDownloadURL,
  listAll: firebaseMocks.listAll,
  deleteObject: firebaseMocks.deleteObject,
}));

import { db, type RoutePayloadRecord, type SavedRouteRecord } from '../db/NavDatabase';
import { ElevationService } from '../navigation/ElevationService';
import { GpxExportService, sanitizeGpxFileName } from '../navigation/GpxExportService';
import {
  RouteManager,
  isRecordedRoute,
  isRecordedRouteFormat,
} from '../navigation/RouteManager';
import { deriveRecordingMetaFromTimestamps } from '../navigation/routeTelemetryHelpers';
import { CommunityPoiImporter } from '../pois/CommunityPoiImporter';
import {
  PlannedTracksCloudService,
  buildPlannedRouteJsonPayload,
  resetPlannedCloudSessionStateForTesting,
  serializePlannedRouteForFirestore,
} from '../firebase/PlannedTracksCloudService';
import type { NavUser } from '../firebase/AuthService';

function createMemoryStores() {
  const routes = new Map<string, SavedRouteRecord>();
  const payloads = new Map<string, RoutePayloadRecord>();

  vi.spyOn(db.routes, 'put').mockImplementation((async (r: SavedRouteRecord) => {
    routes.set(r.id, r);
    return r.id;
  }) as any);
  vi.spyOn(db.routes, 'bulkPut').mockImplementation((async (rs: SavedRouteRecord[]) => {
    rs.forEach((r) => routes.set(r.id, r));
    return [] as any;
  }) as any);
  vi.spyOn(db.routes, 'get').mockImplementation((async (id: string) => routes.get(id)) as any);
  vi.spyOn(db.routes, 'toArray').mockImplementation((async () =>
    Array.from(routes.values())
  ) as any);
  vi.spyOn(db.routes, 'update').mockImplementation((async (id: string, patch: any) => {
    const prev = routes.get(id);
    if (prev) routes.set(id, { ...prev, ...patch });
    return 1;
  }) as any);
  vi.spyOn(db.routes, 'delete').mockImplementation((async (id: string) => {
    routes.delete(id);
  }) as any);
  vi.spyOn(db.routes, 'bulkDelete').mockImplementation((async (ids: string[]) => {
    ids.forEach((id) => routes.delete(id));
  }) as any);

  vi.spyOn(db.routePayloads, 'put').mockImplementation((async (p: RoutePayloadRecord) => {
    payloads.set(p.id, p);
    return p.id;
  }) as any);
  vi.spyOn(db.routePayloads, 'bulkPut').mockImplementation((async (ps: RoutePayloadRecord[]) => {
    ps.forEach((p) => payloads.set(p.id, p));
    return [] as any;
  }) as any);
  vi.spyOn(db.routePayloads, 'get').mockImplementation((async (id: string) =>
    payloads.get(id)
  ) as any);
  vi.spyOn(db.routePayloads, 'delete').mockImplementation((async (id: string) => {
    payloads.delete(id);
  }) as any);
  vi.spyOn(db.routePayloads, 'bulkDelete').mockImplementation((async (ids: string[]) => {
    ids.forEach((id) => payloads.delete(id));
  }) as any);

  return { routes, payloads };
}

function makeMockGpxFile(xml: string, name: string): File {
  const bytes = new TextEncoder().encode(xml);
  return {
    name,
    size: bytes.byteLength,
    type: 'application/gpx+xml',
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => xml,
  } as unknown as File;
}

describe('Navigation Recordings: Auth Isolation, Telemetry, GPX Export/Import & Sharing', () => {
  afterEach(() => {
    resetPlannedCloudSessionStateForTesting();
    RouteManager.clearHydratedCacheForTesting();
    capacitorMocks.isNativePlatform.mockReset().mockReturnValue(false);
    capacitorMocks.writeFile.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requires a signed-in user to save recorded routes and isolates recordings per user', async () => {
    const { routes, payloads } = createMemoryStores();
    vi.spyOn(ElevationService, 'getElevationAt').mockResolvedValue(420);

    await expect(
      RouteManager.createAndSaveRecordedRoute({
        name: 'ללא משתמש',
        coordinates: [
          [34.81, 30.83],
          [34.82, 30.84],
        ],
        startedAt: '2026-11-26T08:00:00.000Z',
        endedAt: '2026-11-26T08:30:00.000Z',
        durationSeconds: 1800,
        ownerUid: '',
      })
    ).rejects.toThrow(/התחברות/);

    const t0 = Date.parse('2026-11-26T08:00:00.000Z');
    const t1 = Date.parse('2026-11-26T08:30:00.000Z');
    const savedA = await RouteManager.createAndSaveRecordedRoute({
      id: 'rec-user-a-1',
      name: 'נחל עקב שישי',
      coordinates: [
        [34.81, 30.83],
        [34.82, 30.84],
      ],
      pointElevations: [390, 450],
      pointTimestamps: [t0, t1],
      startedAt: '2026-11-26T08:00:00.000Z',
      endedAt: '2026-11-26T08:30:00.000Z',
      durationSeconds: 1800,
      notes: 'מעבר חסום בסוף השביל',
      ownerUid: 'uid-a',
      ownerEmail: 'a@gmail.com',
      ownerDisplayName: 'משתמש א',
    });

    expect(isRecordedRoute(savedA)).toBe(true);
    expect(isRecordedRouteFormat('drawn')).toBe(true);
    expect(isRecordedRouteFormat('planned')).toBe(false);
    expect(savedA.sourceFormat).toBe('recorded');
    expect(savedA.cloudSyncStatus).toBe('pending');
    expect(savedA.recordingMeta).toMatchObject({
      startedAt: '2026-11-26T08:00:00.000Z',
      endedAt: '2026-11-26T08:30:00.000Z',
      durationSeconds: 1800,
      pointCount: 2,
      notes: 'מעבר חסום בסוף השביל',
    });
    expect(savedA.recordingMeta?.avgSpeedKmh).toBeGreaterThan(0);

    // Split payload keeps heavy timestamps out of summary and restores them on loadFullRoute
    const summary = routes.get('rec-user-a-1')!;
    const payload = payloads.get('rec-user-a-1')!;
    expect(summary.recordingPointTimestamps).toBeUndefined();
    expect(summary.recordingMeta?.notes).toBe('מעבר חסום בסוף השביל');
    expect(payload.recordingPointTimestamps).toEqual([t0, t1]);
    expect(payload.gpxXml).toContain('<type>recorded</type>');
    expect(payload.gpxXml).toContain('<time>2026-11-26T08:00:00.000Z</time>');

    RouteManager.clearHydratedCacheForTesting();
    const rehydrated = await RouteManager.loadFullRoute('rec-user-a-1');
    expect(rehydrated?.recordingPointTimestamps).toEqual([t0, t1]);

    // Signed-out user sees nothing; User B sees nothing of User A's recording
    expect(await RouteManager.listRouteSummaries(null)).toEqual([]);
    expect(await RouteManager.listRouteSummaries('uid-b')).toEqual([]);
    expect((await RouteManager.listRouteSummaries('uid-a')).map((r) => r.id)).toEqual([
      'rec-user-a-1',
    ]);
  });

  it('exports GPX with readable filename and timestamps across Web & Capacitor Native and preserves metadata on re-import', async () => {
    createMemoryStores();
    vi.spyOn(ElevationService, 'getElevationAt').mockResolvedValue(null);
    vi.spyOn(db.pois, 'bulkPut').mockResolvedValue(undefined as any);

    expect(sanitizeGpxFileName('נחל עקב / שטח: 4x4*', '2026-11-26T08:00:00.000Z')).toBe(
      'נחל_עקב_שטח_4x4_2026-11-26.gpx'
    );

    const t0 = Date.parse('2026-11-26T09:00:00.000Z');
    const t1 = Date.parse('2026-11-26T09:20:00.000Z');
    const rec = await RouteManager.createAndSaveRecordedRoute({
      id: 'rec-export-1',
      name: 'הקלטת מדבר יהודה',
      coordinates: [
        [35.3, 31.4],
        [35.32, 31.42],
      ],
      pointElevations: [120, 240],
      pointTimestamps: [t0, t1],
      startedAt: '2026-11-26T09:00:00.000Z',
      endedAt: '2026-11-26T09:20:00.000Z',
      durationSeconds: 1200,
      notes: 'סימון חדש לפתיחה',
      ownerUid: 'uid-1',
    });

    // 1. Native Capacitor platform writes to Documents/NavApp-Recordings/<filename>
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.writeFile.mockResolvedValueOnce({
      uri: 'file:///storage/emulated/0/Documents/NavApp-Recordings/rec.gpx',
    });
    const nativeRes = await GpxExportService.exportAndSaveRouteGpx(rec);
    expect(nativeRes.method).toBe('native-documents');
    expect(nativeRes.fileName).toBe('הקלטת_מדבר_יהודה_2026-11-26.gpx');
    expect(nativeRes.locationLabelHe).toContain('Documents/NavApp-Recordings/');
    expect(capacitorMocks.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'NavApp-Recordings/הקלטת_מדבר_יהודה_2026-11-26.gpx',
        directory: 'DOCUMENTS',
        encoding: 'utf8',
        recursive: true,
      })
    );

    // 2. Fallback to Directory.Data if Documents fails on legacy Android
    capacitorMocks.writeFile
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce({ uri: 'file:///data/user/0/app/files/NavApp-Recordings/rec.gpx' });
    const fallbackRes = await GpxExportService.exportAndSaveRouteGpx(rec);
    expect(fallbackRes.method).toBe('native-data');

    // 3. Re-importing exported GPX restores recorded type & timestamps
    const parsed = await CommunityPoiImporter.importWaypointsAndRoutesFromFile(
      makeMockGpxFile(nativeRes.gpxXml, nativeRes.fileName)
    );
    expect(parsed.extractedRoutes).toHaveLength(1);
    expect(parsed.extractedRoutes[0].isRecordedTrack).toBe(true);
    expect(parsed.extractedRoutes[0].pointTimestamps?.[0]).toEqual([t0, t1]);

    const derived = deriveRecordingMetaFromTimestamps(
      parsed.extractedRoutes[0].pointTimestamps,
      rec.distanceKm
    );
    expect(derived).toMatchObject({
      startedAt: '2026-11-26T09:00:00.000Z',
      endedAt: '2026-11-26T09:20:00.000Z',
      durationSeconds: 1200,
    });
  });

  it('syncs recorded routes to Firebase per user and delivers in-app shared recordings to recipients', async () => {
    createMemoryStores();
    vi.spyOn(ElevationService, 'getElevationAt').mockResolvedValue(350);
    vi.stubGlobal('navigator', { onLine: true });

    firebaseMocks.getFirebaseServices.mockReturnValue({ firestore: {}, storage: {} });
    firebaseMocks.setDoc.mockResolvedValue(undefined);
    firebaseMocks.uploadString.mockRejectedValue(
      Object.assign(new Error('storage disabled'), { code: 'storage/unknown' })
    );

    const owner: NavUser = {
      uid: 'uid-owner',
      email: 'owner@gmail.com',
      displayName: 'מדריך הטיול',
      photoURL: null,
    };
    const friend: NavUser = {
      uid: 'uid-friend',
      email: 'friend@gmail.com',
      displayName: 'חבר',
      photoURL: null,
    };

    const rec = await RouteManager.createAndSaveRecordedRoute({
      id: 'rec-cloud-1',
      name: 'תצפית גלבוע מוקלט',
      coordinates: [
        [35.41, 32.51],
        [35.42, 32.52],
      ],
      pointElevations: [310, 460],
      pointTimestamps: [1732610000000, 1732610900000],
      startedAt: '2026-11-26T08:33:20.000Z',
      endedAt: '2026-11-26T08:48:20.000Z',
      durationSeconds: 900,
      ownerUid: owner.uid,
      ownerEmail: owner.email,
      ownerDisplayName: owner.displayName,
    });

    // 1. syncPendingRoutesForUser uploads recorded tracks automatically
    const syncedCount = await PlannedTracksCloudService.syncPendingRoutesForUser(owner);
    expect(syncedCount).toBe(1);
    expect(firebaseMocks.setDoc).toHaveBeenCalledTimes(1);

    // 2. Sharing recorded track writes recipient uid/email & recipient receives it via collectionGroup
    const shareRes = await PlannedTracksCloudService.updateRouteSharing(
      rec,
      [
        {
          uid: friend.uid,
          email: friend.email!,
          displayName: friend.displayName,
          sharedAt: '2026-11-26T09:00:00.000Z',
        },
      ],
      owner
    );
    expect(shareRes.synced).toBe(true);
    expect(shareRes.route.sourceFormat).toBe('recorded');

    const sharedDoc = serializePlannedRouteForFirestore(
      buildPlannedRouteJsonPayload(shareRes.route, owner)
    );
    firebaseMocks.getDocs
      .mockResolvedValueOnce({
        forEach: (cb: (snap: { id: string; ref: { path: string }; data: () => any }) => void) => {
          cb({
            id: 'rec-cloud-1',
            ref: { path: 'planing_tracks/uid-owner/routes/rec-cloud-1' },
            data: () => sharedDoc,
          });
        },
      })
      .mockResolvedValueOnce({ forEach: () => undefined });

    const inbox = await PlannedTracksCloudService.fetchSharedWithMeRoutes(friend);
    expect(inbox.allShared).toHaveLength(1);
    expect(inbox.allShared[0].sourceFormat).toBe('recorded');
    expect(inbox.allShared[0].ownership).toBe('shared');
    expect(inbox.allShared[0].recordingMeta?.durationSeconds).toBe(900);

    const copied = await RouteManager.duplicateRouteToMine(inbox.allShared[0], friend);
    expect(copied.ownership).toBe('mine');
    expect(copied.sourceFormat).toBe('recorded');
    expect(copied.ownerUid).toBe(friend.uid);
    expect(copied.cloudSyncStatus).toBe('pending');
  });

  it('wires stop-and-prompt save, signed-in guard, and dedicated Navigation Recordings panel across App & components', () => {
    const appSrc = fs.readFileSync('src/App.tsx', 'utf-8');
    const recorderSrc = fs.readFileSync('src/components/navigation/TrackRecorderPanel.tsx', 'utf-8');
    const saveModalSrc = fs.readFileSync('src/components/navigation/SaveRecordingModal.tsx', 'utf-8');
    const recordingsSrc = fs.readFileSync(
      'src/components/navigation/NavigationRecordingsPanel.tsx',
      'utf-8'
    );

    expect(recorderSrc).toContain('hideCloseButton');
    expect(recorderSrc).toContain('סיים ושמור הקלטה');
    expect(recorderSrc).toContain('הקלטות הניווט שלי');

    expect(saveModalSrc).toContain('שמור הקלטה');
    expect(saveModalSrc).toContain('שמור + GPX');
    expect(saveModalSrc).toContain('המשך הקלטה');

    expect(recordingsSrc).toContain('hideCloseButton');
    expect(recordingsSrc).toContain('ההקלטות שלי');
    expect(recordingsSrc).toContain('שותפו איתי');
    expect(recordingsSrc).toContain('שתף באפליקציה');
    expect(recordingsSrc).toContain('ייצא GPX');
    expect(recordingsSrc).toContain('עדכן מפה מההקלטה');

    expect(appSrc).toContain('openRecordingSavePrompt');
    expect(appSrc).toContain('<SaveRecordingModal');
    expect(appSrc).toContain('<NavigationRecordingsPanel');
    expect(appSrc).toContain('data-testid="menu-recordings-btn"');
  });
});
