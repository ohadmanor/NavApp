import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firestoreMocks = vi.hoisted(() => ({
  getFirebaseServices: vi.fn(),
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, col, id })),
  collection: vi.fn((_db: unknown, col: string) => ({ col })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  setDoc: vi.fn(),
  deleteDoc: vi.fn(),
  onSnapshot: vi.fn(),
  query: vi.fn((...args: unknown[]) => ({ args })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  writeBatch: vi.fn(),
}));

vi.mock('../firebase/firebaseApp', () => ({
  getFirebaseServices: firestoreMocks.getFirebaseServices,
}));

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    doc: firestoreMocks.doc,
    collection: firestoreMocks.collection,
    getDoc: firestoreMocks.getDoc,
    getDocs: firestoreMocks.getDocs,
    setDoc: firestoreMocks.setDoc,
    deleteDoc: firestoreMocks.deleteDoc,
    onSnapshot: firestoreMocks.onSnapshot,
    query: firestoreMocks.query,
    where: firestoreMocks.where,
    writeBatch: firestoreMocks.writeBatch,
  };
});

import { db, type PoiOverrideRecord, type PoiRecord } from '../db/NavDatabase';
import type { NavUser } from '../firebase/AuthService';
import { GlobalPoiCloudService } from '../firebase/GlobalPoiCloudService';
import {
  PRIVATE_POIS_COLLECTION,
  PrivatePoiCloudService,
  fromFirestorePrivatePoi,
  normalizePoiShareRecipients,
  toFirestorePrivatePoi,
} from '../firebase/PrivatePoiCloudService';
import { PoiManager } from '../pois/PoiManager';
import {
  canUserDeletePoi,
  canUserEditPoiCategory,
  canUserShareOrPromotePoi,
  isOwnedPrivatePoi,
  isPrivatePoi,
  isSharedWithMePoi,
} from '../pois/poiPermissions';
import { PMTilesSearchService } from '../search/PMTilesSearchService';
import { DEFAULT_LAYER_VISIBILITY, buildPoiTieredLayerFilter } from '../style/israelOutdoorStyle';

const ALICE: NavUser = {
  uid: 'alice-uid',
  email: 'alice@example.com',
  displayName: 'Alice Hiker',
  photoURL: null,
};

const BOB: NavUser = {
  uid: 'bob-uid',
  email: 'BOB@GMAIL.COM',
  displayName: 'Bob Trail',
  photoURL: null,
};

const ADMIN_OHAD: NavUser = {
  uid: 'ohad-uid',
  email: 'ohad.manor@gmail.com',
  displayName: 'Ohad Manor',
  photoURL: null,
};

function createPoi(overrides: Partial<PoiRecord> = {}): PoiRecord {
  return {
    id: 'user-private-1',
    name: 'מעיין סודי',
    nameHe: 'מעיין סודי',
    nameEn: 'Secret Spring',
    category: 'water',
    subcategory: 'spring',
    lon: 35.1234,
    lat: 31.7654,
    ele: 520,
    waterStatus: null,
    difficulty4x4: null,
    descHe: 'נביעה עונתית',
    descEn: 'Seasonal spring',
    source: 'נקודה פרטית (משתמש)',
    wikipedia: null,
    visibility: 'private',
    ownership: 'mine',
    ownerUid: ALICE.uid,
    ownerEmail: ALICE.email,
    ownerDisplayName: ALICE.displayName,
    createdByUid: ALICE.uid,
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedByUid: ALICE.uid,
    updatedAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
  };
}

function setupInMemoryPoiDb(
  initialPois: PoiRecord[] = [],
  initialOverrides: PoiOverrideRecord[] = []
) {
  const poisMap = new Map<string, PoiRecord>(initialPois.map((p) => [p.id, { ...p }]));
  const overridesMap = new Map<string, PoiOverrideRecord>(
    initialOverrides.map((o) => [o.id, { ...o }])
  );

  const spies = [
    vi.spyOn(db.pois, 'toArray').mockImplementation((async () =>
      Array.from(poisMap.values()).map((r) => ({ ...r }))
    ) as any),
    vi.spyOn(db.pois, 'get').mockImplementation((async (id: string) => {
      const hit = poisMap.get(id);
      return hit ? { ...hit } : undefined;
    }) as any),
    vi.spyOn(db.pois, 'put').mockImplementation((async (item: PoiRecord) => {
      poisMap.set(item.id, { ...item });
      return item.id;
    }) as any),
    vi.spyOn(db.pois, 'bulkPut').mockImplementation((async (items: readonly PoiRecord[]) => {
      for (const item of items) {
        poisMap.set(item.id, { ...item });
      }
    }) as any),
    vi.spyOn(db.pois, 'delete').mockImplementation((async (id: string) => {
      poisMap.delete(id);
    }) as any),
    vi.spyOn(db.pois, 'bulkDelete').mockImplementation((async (ids: readonly string[]) => {
      for (const id of ids) poisMap.delete(id);
    }) as any),
    vi.spyOn(db.pois, 'update').mockImplementation((async (id: string, changes: Partial<PoiRecord>) => {
      const cur = poisMap.get(id);
      if (!cur) return 0;
      poisMap.set(id, { ...cur, ...changes });
      return 1;
    }) as any),
    vi.spyOn(db, 'transaction').mockImplementation((async (...args: any[]) => {
      const fn = args[args.length - 1];
      return await fn();
    }) as any),
    vi.spyOn(db.poiOverrides, 'toArray').mockImplementation((async () =>
      Array.from(overridesMap.values()).map((o) => ({ ...o }))
    ) as any),
    vi.spyOn(db.poiOverrides, 'get').mockImplementation((async (id: string) => {
      const hit = overridesMap.get(id);
      return hit ? { ...hit } : undefined;
    }) as any),
    vi.spyOn(db.poiOverrides, 'put').mockImplementation((async (item: PoiOverrideRecord) => {
      overridesMap.set(item.id, { ...item });
      return item.id;
    }) as any),
    vi.spyOn(db.poiOverrides, 'bulkPut').mockImplementation((async (items: readonly PoiOverrideRecord[]) => {
      for (const item of items) {
        overridesMap.set(item.id, { ...item });
      }
    }) as any),
    vi.spyOn(db.poiOverrides, 'delete').mockImplementation((async (id: string) => {
      overridesMap.delete(id);
    }) as any),
  ];

  return {
    poisMap,
    overridesMap,
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe('Private & User-Shared POIs (PRD-4)', () => {
  beforeEach(() => {
    const mockStorage = createMemoryStorage();
    vi.stubGlobal('window', {
      localStorage: mockStorage,
    });
    vi.stubGlobal('navigator', { onLine: true });

    firestoreMocks.getFirebaseServices.mockReset();
    firestoreMocks.getDoc.mockReset();
    firestoreMocks.getDocs.mockReset();
    firestoreMocks.setDoc.mockReset();
    firestoreMocks.deleteDoc.mockReset();
    firestoreMocks.writeBatch.mockReset();
    firestoreMocks.onSnapshot.mockReset();

    firestoreMocks.getFirebaseServices.mockReturnValue({ firestore: { __mock: true } });
    firestoreMocks.setDoc.mockResolvedValue(undefined);
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('enforces permission rules across owner, shared recipient, other users, and admins', () => {
    const ownPrivate = createPoi();
    const sharedWithBob = createPoi({
      id: 'shared-1',
      ownership: 'shared',
      ownerUid: ALICE.uid,
      sharedByUid: ALICE.uid,
      sharedForUid: BOB.uid,
    });
    const globalByAlice = createPoi({
      id: 'global-1',
      visibility: 'global',
      ownership: undefined,
      ownerUid: undefined,
      createdByUid: ALICE.uid,
    });

    expect(isPrivatePoi(ownPrivate)).toBe(true);
    expect(isOwnedPrivatePoi(ownPrivate, ALICE)).toBe(true);
    expect(isOwnedPrivatePoi(ownPrivate, BOB)).toBe(false);
    expect(isSharedWithMePoi(sharedWithBob, BOB)).toBe(true);
    expect(isSharedWithMePoi(ownPrivate, ALICE)).toBe(false);

    // Delete permissions
    expect(canUserDeletePoi(null, ownPrivate)).toBe(false);
    expect(canUserDeletePoi(ALICE, ownPrivate)).toBe(true);
    expect(canUserDeletePoi(BOB, sharedWithBob)).toBe(false);
    expect(canUserDeletePoi(ALICE, globalByAlice)).toBe(false);
    expect(canUserDeletePoi(ADMIN_OHAD, globalByAlice)).toBe(true);
    expect(canUserDeletePoi(ADMIN_OHAD, sharedWithBob)).toBe(false);

    // Edit category permissions
    expect(canUserEditPoiCategory(ALICE, ownPrivate)).toBe(true);
    expect(canUserEditPoiCategory(BOB, sharedWithBob)).toBe(false);
    expect(canUserEditPoiCategory(BOB, globalByAlice)).toBe(true);

    // Share / Promote permissions
    expect(canUserShareOrPromotePoi(ALICE, ownPrivate)).toBe(true);
    expect(canUserShareOrPromotePoi(BOB, sharedWithBob)).toBe(false);
    expect(canUserShareOrPromotePoi(ADMIN_OHAD, globalByAlice)).toBe(false);
  });

  it('defaults addCustomUserPoi to private and respects explicit global override', async () => {
    const mem = setupInMemoryPoiDb();

    const priv = await PoiManager.addCustomUserPoi({
      nameHe: 'תצפית אישית',
      category: 'peak',
      subcategory: 'viewpoint',
      lon: 35.1,
      lat: 31.8,
      ele: 450,
      descHe: 'נקודה שקטה',
      createdByUid: ALICE.uid,
      ownerUid: ALICE.uid,
      ownerEmail: ALICE.email,
      ownerDisplayName: ALICE.displayName,
    });

    expect(priv.visibility).toBe('private');
    expect(priv.ownership).toBe('mine');
    expect(priv.ownerUid).toBe(ALICE.uid);
    expect(priv.ownerEmail).toBe(ALICE.email);
    expect(priv.ownerDisplayName).toBe(ALICE.displayName);

    const glob = await PoiManager.addCustomUserPoi({
      nameHe: 'בור מים ציבורי',
      category: 'water',
      subcategory: 'cistern',
      lon: 35.2,
      lat: 31.5,
      ele: null,
      descHe: 'פתוח למטיילים',
      visibility: 'global',
      createdByUid: ALICE.uid,
    });

    expect(glob.visibility).toBe('global');
    expect(glob.ownership).toBeUndefined();
    expect(glob.ownerUid).toBeUndefined();
    expect(glob.createdByUid).toBe(ALICE.uid);

    mem.restore();
  });

  it('deletes and restores private POIs without creating global overrides or deleted signatures', async () => {
    const priv = createPoi({ id: 'priv-local-del' });
    const mem = setupInMemoryPoiDb([priv]);

    const snapshot = await PoiManager.deletePoi(priv, ALICE.uid);
    expect(mem.poisMap.has('priv-local-del')).toBe(false);
    expect(mem.overridesMap.size).toBe(0);
    expect(snapshot.previousOverride).toBeUndefined();

    const restored = await PoiManager.restoreDeletedPoi(snapshot, ALICE.uid);
    expect(restored.visibility).toBe('private');
    expect(mem.poisMap.has('priv-local-del')).toBe(true);
    expect(mem.overridesMap.size).toBe(0);

    mem.restore();
  });

  it('preserves local private POIs during global POI reconciliation', async () => {
    const priv = createPoi({ id: 'user-poi-priv-keep-1' });
    const staleGlobal = createPoi({
      id: 'user-poi-global-stale-1',
      visibility: 'global',
      ownership: undefined,
      ownerUid: undefined,
      source: 'User Field Report (דיווח מטייל)',
      createdByUid: ALICE.uid,
    });
    const mem = setupInMemoryPoiDb([priv, staleGlobal]);

    const res = await PoiManager.reconcileRemoteGlobalPoisAndOverrides([], [], {
      pendingPoiIds: new Set(),
      pendingOverrideIds: new Set(),
      pendingDeleteIds: new Set(),
    });

    expect(res.poisChanged).toBe(true);
    expect(mem.poisMap.has('user-poi-priv-keep-1')).toBe(true);
    expect(mem.poisMap.has('user-poi-global-stale-1')).toBe(false);

    mem.restore();
  });

  it('normalizes and deduplicates share recipients by UID and lowercase email', () => {
    const normalized = normalizePoiShareRecipients([
      {
        uid: 'bob-uid',
        email: 'Bob@Gmail.com ',
        displayName: 'Bob',
        photoURL: null,
        sharedAt: '2026-11-10T10:00:00.000Z',
      },
      {
        uid: 'bob-uid',
        email: 'BOB@GMAIL.COM',
        displayName: 'Bob Duplicate',
        photoURL: null,
        sharedAt: '2026-11-10T11:00:00.000Z',
      },
      {
        uid: null,
        email: 'Guest@Example.COM',
        displayName: null,
        photoURL: null,
        sharedAt: '2026-11-10T12:00:00.000Z',
      },
    ]);

    expect(normalized.sharedWith).toHaveLength(2);
    expect(normalized.sharedWithUids).toEqual(['bob-uid']);
    expect(normalized.sharedWithEmails).toEqual(['bob@gmail.com', 'guest@example.com']);
  });

  it('publishes, shares, promotes (with batch delete when private doc exists), and flushes offline queues', async () => {
    const priv = createPoi({ id: 'priv-flow-1' });
    const mem = setupInMemoryPoiDb([priv]);

    // 1. Update sharing -> writes to private_pois with sharedWithUids + sharedWithEmails
    const shareRes = await PrivatePoiCloudService.updatePrivatePoiSharing(
      priv,
      [
        {
          uid: BOB.uid,
          email: 'BOB@Gmail.com',
          displayName: BOB.displayName,
          photoURL: null,
          sharedAt: '2026-11-14T08:00:00.000Z',
        },
      ],
      ALICE
    );
    expect(shareRes.synced).toBe(true);
    expect(shareRes.poi.sharedWithUids).toEqual([BOB.uid]);
    expect(shareRes.poi.sharedWithEmails).toEqual(['bob@gmail.com']);
    expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(1);

    // Verify viewer parsing as Bob sees it read-only shared
    const payload = firestoreMocks.setDoc.mock.calls[0][1];
    const asBob = fromFirestorePrivatePoi(priv.id, payload, BOB.uid);
    expect(asBob?.ownership).toBe('shared');
    expect(asBob?.sharedByName).toBe(ALICE.displayName);
    expect(asBob?.sharedWith).toBeUndefined();

    // 2. Promote private -> global using atomic writeBatch when private_pois doc exists
    const batchSet = vi.fn();
    const batchDelete = vi.fn();
    const batchCommit = vi.fn().mockResolvedValue(undefined);
    firestoreMocks.writeBatch.mockReturnValue({
      set: batchSet,
      delete: batchDelete,
      commit: batchCommit,
    });
    firestoreMocks.getDoc.mockResolvedValue({ exists: () => true });

    const promoteRes = await PrivatePoiCloudService.promotePrivatePoiToGlobal(shareRes.poi, ALICE);
    expect(promoteRes.synced).toBe(true);
    expect(promoteRes.poi.visibility).toBe('global');
    expect(promoteRes.poi.ownership).toBeUndefined();
    expect(promoteRes.poi.sharedWithUids).toBeUndefined();
    expect(batchSet).toHaveBeenCalledTimes(1);
    expect(batchDelete).toHaveBeenCalledTimes(1);
    expect(batchCommit).toHaveBeenCalledTimes(1);
    expect(mem.poisMap.get(priv.id)?.visibility).toBe('global');

    // 3. Offline queue + flushPendingOperations
    vi.stubGlobal('navigator', { onLine: false });
    const offlinePoi = createPoi({ id: 'priv-offline-1', nameHe: 'נקודה באוף-ליין' });
    mem.poisMap.set(offlinePoi.id, offlinePoi);
    const offlineRes = await PrivatePoiCloudService.publishPrivatePoi(offlinePoi, ALICE);
    expect(offlineRes.queuedOffline).toBe(true);

    vi.stubGlobal('navigator', { onLine: true });
    firestoreMocks.setDoc.mockClear();
    const flushedCount = await PrivatePoiCloudService.flushPendingOperations(ALICE);
    expect(flushedCount).toBe(1);
    expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
      expect.objectContaining({ col: PRIVATE_POIS_COLLECTION, id: offlinePoi.id }),
      expect.objectContaining({ visibility: 'private', ownerUid: ALICE.uid })
    );

    // Verify GlobalPoiCloudService rejects private POIs
    await expect(GlobalPoiCloudService.publishUserPoi(offlinePoi, ALICE)).rejects.toThrow();

    mem.restore();
  });

  it('reconciles private/shared POIs with userNotes preservation, revocation, dismiss, and user-switch purge', async () => {
    const existingShared: PoiRecord = createPoi({
      id: 'shared-bob-1',
      ownership: 'shared',
      ownerUid: ALICE.uid,
      ownerDisplayName: ALICE.displayName,
      sharedByUid: ALICE.uid,
      sharedByName: ALICE.displayName,
      sharedForUid: BOB.uid,
      userNotes: 'הערה פרטית של בוב',
    });
    const staleShared: PoiRecord = createPoi({
      id: 'shared-revoked-2',
      ownership: 'shared',
      ownerUid: ALICE.uid,
      sharedByUid: ALICE.uid,
      sharedForUid: BOB.uid,
    });
    const pendingMine: PoiRecord = createPoi({
      id: 'bob-pending-3',
      ownership: 'mine',
      ownerUid: BOB.uid,
      createdByUid: BOB.uid,
    });
    const globalPoi: PoiRecord = createPoi({
      id: 'osm-keep-4',
      visibility: 'global',
      ownership: undefined,
      ownerUid: undefined,
      source: 'IsraelHiking / OSM',
    });

    const mem = setupInMemoryPoiDb([existingShared, staleShared, pendingMine, globalPoi]);

    const updatedShared = { ...existingShared, nameHe: 'מעיין סודי - מעודכן', userNotes: '' };
    const newlyArrived = createPoi({
      id: 'shared-new-5',
      nameHe: 'נקודה חדשה ששותפה',
      ownership: 'shared',
      ownerUid: ALICE.uid,
      sharedByUid: ALICE.uid,
      sharedByName: ALICE.displayName,
      sharedForUid: BOB.uid,
    });
    const dismissedShared = createPoi({
      id: 'shared-dismissed-6',
      ownership: 'shared',
      ownerUid: ALICE.uid,
      sharedByUid: ALICE.uid,
      sharedForUid: BOB.uid,
    });

    const reconcileRes = await PoiManager.reconcilePrivateAndSharedPois({
      ownPrivatePois: [],
      sharedWithMePois: [updatedShared, newlyArrived, dismissedShared],
      activeUid: BOB.uid,
      pendingPrivateIds: new Set(['bob-pending-3']),
      pendingDeleteIds: new Set(),
      dismissedSharedIds: new Set(['shared-dismissed-6']),
      allowRevokeOwn: true,
      allowRevokeShared: true,
    });

    expect(reconcileRes.changed).toBe(true);
    expect(reconcileRes.newlyArrivedShared.map((p) => p.id)).toEqual(['shared-new-5']);
    expect(reconcileRes.revokedSharedIds).toEqual(['shared-revoked-2']);
    expect(mem.poisMap.get('shared-bob-1')?.nameHe).toBe('מעיין סודי - מעודכן');
    expect(mem.poisMap.get('shared-bob-1')?.userNotes).toBe('הערה פרטית של בוב');
    expect(mem.poisMap.has('bob-pending-3')).toBe(true);
    expect(mem.poisMap.has('shared-dismissed-6')).toBe(false);
    expect(mem.poisMap.has('osm-keep-4')).toBe(true);

    // Dismissing hides shared POI cleanly for that user
    await PrivatePoiCloudService.dismissSharedPoi(newlyArrived, BOB);
    expect(mem.poisMap.has('shared-new-5')).toBe(false);

    // Signing out purges all private and shared POIs while leaving global POIs intact
    const purgedCount = await PoiManager.purgePrivateAndSharedPoisForUserSwitch(null);
    expect(purgedCount).toBe(2); // shared-bob-1 & bob-pending-3
    expect(mem.poisMap.has('shared-bob-1')).toBe(false);
    expect(mem.poisMap.has('bob-pending-3')).toBe(false);
    expect(mem.poisMap.has('osm-keep-4')).toBe(true);

    mem.restore();
  });

  it('exposes poiPrivate property in GeoJSON, filters it in map style, and labels private/shared POIs in search', () => {
    const mine = createPoi({ id: 'priv-map-1', nameHe: 'שלי פרטי' });
    const shared = createPoi({
      id: 'shared-map-2',
      nameHe: 'משותף מהקבוצה',
      ownership: 'shared',
      ownerUid: BOB.uid,
      sharedByUid: BOB.uid,
      sharedByName: 'Bob Trail',
    });

    const geo = PoiManager.toGeoJSON([mine, shared], DEFAULT_LAYER_VISIBILITY);
    expect(geo.features[0]?.properties?.visibility).toBe('private');
    expect(geo.features[1]?.properties?.visibility).toBe('private');
    expect(geo.features[1]?.properties?.ownership).toBe('shared');
    const hiddenGeo = PoiManager.toGeoJSON([mine, shared], {
      ...DEFAULT_LAYER_VISIBILITY,
      poiPrivate: false,
    });
    expect(hiddenGeo.features).toHaveLength(0);

    const compact = PoiManager.toCompactMapGeoJSON([mine, shared]);
    expect(compact.features[0]?.properties?.visibility).toBe('private');
    expect(compact.features[1]?.properties?.ownership).toBe('shared');

    const hiddenFilter = JSON.stringify(
      buildPoiTieredLayerFilter(
        { ...DEFAULT_LAYER_VISIBILITY, poiPrivate: false },
        ['water']
      )
    );
    expect(hiddenFilter).toContain('private');

    const searchService = new PMTilesSearchService();
    const hits = searchService.search('שלי', { pois: [mine, shared], limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].sourceLabel).toBe('נקודה פרטית');

    const sharedHits = searchService.search('משותף', { pois: [mine, shared], limit: 10 });
    expect(sharedHits).toHaveLength(1);
    expect(sharedHits[0].sourceLabel).toBe('שותף ע״י Bob Trail');
  });

  it('keeps Firestore security rules wired for /private_pois/{poiId}', () => {
    const rulesPath = path.resolve(process.cwd(), 'firestore.rules');
    const rules = fs.readFileSync(rulesPath, 'utf8');
    expect(rules).toContain('match /private_pois/{poiId}');
    expect(rules).toContain('function validPrivatePoi(data, poiId)');
    expect(rules).toContain('sharedWithUids');
    expect(rules).toContain('sharedWithEmails');

    // Sanity check serialization contract aligns with Firestore rules fields
    const docData = toFirestorePrivatePoi(createPoi(), ALICE);
    expect(docData.visibility).toBe('private');
    expect(docData.ownerUid).toBe(ALICE.uid);
    expect(Array.isArray(docData.sharedWithUids)).toBe(true);
    expect(Array.isArray(docData.sharedWithEmails)).toBe(true);
  });
});
