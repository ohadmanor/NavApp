import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoiOverrideRecord, PoiRecord } from '../db/NavDatabase';
import {
  canUserAddOrEditPoi,
  canUserDeletePoi,
  isLegacyPoiMigrationSourceUser,
  LEGACY_POI_MIGRATION_SOURCE_EMAIL,
  POI_DELETE_ADMIN_EMAILS,
} from '../pois/poiPermissions';

type InMemoryDb = {
  pois: Map<string, PoiRecord>;
  poiOverrides: Map<string, PoiOverrideRecord>;
};

const memDb: InMemoryDb = {
  pois: new Map(),
  poiOverrides: new Map(),
};

function makeTable<T extends { id: string }>(store: Map<string, T>) {
  return {
    get: vi.fn(async (id: string) => store.get(id)),
    put: vi.fn(async (item: T) => {
      store.set(item.id, structuredClone(item));
      return item.id;
    }),
    bulkPut: vi.fn(async (items: T[]) => {
      for (const item of items) {
        store.set(item.id, structuredClone(item));
      }
    }),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    bulkDelete: vi.fn(async (ids: string[]) => {
      for (const id of ids) {
        store.delete(id);
      }
    }),
    clear: vi.fn(async () => {
      store.clear();
    }),
    toArray: vi.fn(async () => Array.from(store.values()).map((x) => structuredClone(x))),
    where: vi.fn((field: keyof T) => ({
      equals: (value: unknown) => ({
        toArray: async () =>
          Array.from(store.values())
            .filter((item) => item[field] === value)
            .map((x) => structuredClone(x)),
        filter: (predicate: (item: T) => boolean) => ({
          toArray: async () =>
            Array.from(store.values())
              .filter((item) => item[field] === value && predicate(item))
              .map((x) => structuredClone(x)),
        }),
      }),
    })),
  };
}

const mockDb = {
  pois: makeTable(memDb.pois),
  poiOverrides: makeTable(memDb.poiOverrides),
  transaction: vi.fn(async (...args: unknown[]) => {
    const fn = args[args.length - 1] as () => Promise<unknown>;
    return fn();
  }),
};

const firestoreStore = {
  docs: new Map<string, Record<string, unknown>>(),
  servicesEnabled: false,
  permissionDeniedKeys: new Set<string>(),
};

const mockGetFirebaseServices = vi.fn(() =>
  firestoreStore.servicesEnabled
    ? ({
        app: {} as never,
        auth: {} as never,
        firestore: { __mock: true } as never,
        storage: {} as never,
      })
    : null
);

vi.mock('../db/NavDatabase', () => ({
  db: mockDb,
}));

vi.mock('../firebase/firebaseApp', () => ({
  getFirebaseServices: () => mockGetFirebaseServices(),
  isFirebaseConfigured: () => firestoreStore.servicesEnabled,
}));

vi.mock('firebase/firestore', () => {
  const docKey = (parts: string[]) => parts.join('/');
  return {
    collection: (_fs: unknown, ...segments: string[]) => ({
      __type: 'collection',
      path: docKey(segments),
    }),
    doc: (_fs: unknown, ...segments: string[]) => ({
      __type: 'doc',
      path: docKey(segments),
      id: segments[segments.length - 1],
    }),
    deleteField: () => ({ __deleteField: true }),
    getDoc: vi.fn(async (ref: { path: string }) => {
      const data = firestoreStore.docs.get(ref.path);
      return {
        exists: () => data !== undefined,
        id: ref.path.split('/').pop(),
        data: () => (data ? structuredClone(data) : undefined),
      };
    }),
    getDocs: vi.fn(async (colRef: { path: string }) => {
      const prefix = `${colRef.path}/`;
      const matched: Array<{ id: string; data: () => Record<string, unknown> }> = [];
      for (const [k, v] of firestoreStore.docs.entries()) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
          matched.push({
            id: k.slice(prefix.length),
            data: () => structuredClone(v),
          });
        }
      }
      return {
        forEach: (cb: (item: { id: string; data: () => Record<string, unknown> }) => void) => {
          matched.forEach(cb);
        },
      };
    }),
    setDoc: vi.fn(
      async (
        ref: { path: string },
        data: Record<string, unknown>,
        options?: { merge?: boolean }
      ) => {
        if (firestoreStore.permissionDeniedKeys.has(ref.path)) {
          const err = new Error('Missing or insufficient permissions');
          (err as Error & { code: string }).code = 'permission-denied';
          throw err;
        }
        const prev = options?.merge ? { ...(firestoreStore.docs.get(ref.path) ?? {}) } : {};
        const next: Record<string, unknown> = { ...prev };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && (v as { __deleteField?: boolean }).__deleteField) {
            delete next[k];
          } else {
            next[k] = structuredClone(v);
          }
        }
        firestoreStore.docs.set(ref.path, next);
      }
    ),
    deleteDoc: vi.fn(async (ref: { path: string }) => {
      if (firestoreStore.permissionDeniedKeys.has(ref.path)) {
        const err = new Error('Missing or insufficient permissions');
        (err as Error & { code: string }).code = 'permission-denied';
        throw err;
      }
      firestoreStore.docs.delete(ref.path);
    }),
    writeBatch: vi.fn(() => {
      const ops: Array<{ type: 'set'; path: string; data: Record<string, unknown> }> = [];
      return {
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          ops.push({ type: 'set', path: ref.path, data });
        },
        commit: async () => {
          for (const op of ops) {
            if (firestoreStore.permissionDeniedKeys.has(op.path)) {
              const err = new Error('Missing or insufficient permissions');
              (err as Error & { code: string }).code = 'permission-denied';
              throw err;
            }
          }
          for (const op of ops) {
            firestoreStore.docs.set(op.path, structuredClone(op.data));
          }
        },
      };
    }),
    onSnapshot: vi.fn(() => () => {}),
  };
});

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

function ensureWindowAndLocalStorage() {
  const ls = createMemoryStorage();
  const g = globalThis as unknown as {
    window?: { localStorage: ReturnType<typeof createMemoryStorage> };
    localStorage?: ReturnType<typeof createMemoryStorage>;
    navigator?: { onLine: boolean };
  };
  g.localStorage = ls;
  if (!g.window) {
    g.window = { localStorage: ls };
  } else {
    g.window.localStorage = ls;
  }
  if (!g.navigator) {
    g.navigator = { onLine: true };
  } else {
    g.navigator.onLine = true;
  }
  return ls;
}

describe('POI permissions', () => {
  it('allows any signed-in user to add or edit POIs, denies signed-out users', () => {
    expect(canUserAddOrEditPoi(null)).toBe(false);
    expect(canUserAddOrEditPoi(undefined)).toBe(false);
    expect(canUserAddOrEditPoi({ uid: '   ' })).toBe(false);
    expect(canUserAddOrEditPoi({ uid: 'user-123' })).toBe(true);
  });

  it('allows ONLY ohad.manor@gmail.com and nabibesk@gmail.com (case-insensitive) to delete POIs', () => {
    expect(POI_DELETE_ADMIN_EMAILS).toEqual(['ohad.manor@gmail.com', 'nabibesk@gmail.com']);
    expect(canUserDeletePoi({ uid: 'u1', email: 'ohad.manor@gmail.com' })).toBe(true);
    expect(canUserDeletePoi({ uid: 'u1', email: '  OHAD.MANOR@GMAIL.COM ' })).toBe(true);
    expect(canUserDeletePoi({ uid: 'u2', email: 'nabibesk@gmail.com' })).toBe(true);
    expect(canUserDeletePoi({ uid: 'u2', email: 'NaBiBeSk@GmAiL.CoM' })).toBe(true);

    expect(canUserDeletePoi({ uid: 'u3', email: 'someone.else@gmail.com' })).toBe(false);
    expect(canUserDeletePoi({ uid: 'u4', email: 'ohad.manor@gamil.com' })).toBe(false);
    expect(canUserDeletePoi({ uid: 'u5', email: null })).toBe(false);
    expect(canUserDeletePoi(null)).toBe(false);
  });

  it('identifies ohad.manor@gmail.com exclusively as the legacy migration source', () => {
    expect(LEGACY_POI_MIGRATION_SOURCE_EMAIL).toBe('ohad.manor@gmail.com');
    expect(isLegacyPoiMigrationSourceUser({ uid: 'u1', email: 'OHAD.MANOR@gmail.com' })).toBe(true);
    expect(isLegacyPoiMigrationSourceUser({ uid: 'u2', email: 'nabibesk@gmail.com' })).toBe(false);
    expect(isLegacyPoiMigrationSourceUser({ uid: 'u3', email: 'other@gmail.com' })).toBe(false);
    expect(isLegacyPoiMigrationSourceUser(null)).toBe(false);
  });
});

describe('PoiManager global reconciliation', () => {
  beforeEach(() => {
    memDb.pois.clear();
    memDb.poiOverrides.clear();
    firestoreStore.docs.clear();
    firestoreStore.permissionDeniedKeys.clear();
    firestoreStore.servicesEnabled = false;
    ensureWindowAndLocalStorage();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconciles remote global POIs and overrides while preserving local personal notes', async () => {
    const { PoiManager } = await import('../pois/PoiManager');

    // Local bundled POI with private field note
    memDb.pois.set('osm-1', {
      id: 'osm-1',
      name: 'Ein Akev',
      nameHe: 'עין עקב',
      nameEn: 'Ein Akev',
      category: 'peak',
      subcategory: 'peak_lookout',
      lon: 34.81,
      lat: 30.82,
      ele: 320,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'OSM',
      wikipedia: null,
      userNotes: 'הערה אישית שלי מהשטח',
    });

    // Local bundled POI that was deleted remotely via override
    memDb.pois.set('osm-2', {
      id: 'osm-2',
      name: 'Old Gate',
      nameHe: 'שער ישן',
      nameEn: 'Old Gate',
      category: 'campsite',
      subcategory: 'campsite_night',
      lon: 34.82,
      lat: 30.83,
      ele: 200,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'OSM',
      wikipedia: null,
      userNotes: 'הערה מקומית לשמירה',
    });

    // Stale remote user POI locally that no longer exists remotely -> pruned
    memDb.pois.set('user-poi-removed', {
      id: 'user-poi-removed',
      name: 'Removed',
      nameHe: 'נמחקה',
      nameEn: 'Removed',
      category: 'water',
      subcategory: 'water_spring',
      lon: 35.1,
      lat: 31.1,
      ele: 100,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: '',
      createdByUid: 'user-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    // Locally modified user POI with personal note whose remote doc was recategorized
    memDb.pois.set('user-poi-shared', {
      id: 'user-poi-shared',
      name: 'Shared Spring',
      nameHe: 'מעיין משותף',
      nameEn: 'Shared Spring',
      category: 'peak',
      subcategory: 'peak_lookout',
      lon: 35.2,
      lat: 31.2,
      ele: 150,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: 'לא לשתף הערה זו',
      createdByUid: 'user-a',
      updatedByUid: 'user-a',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const remotePois: PoiRecord[] = [
      {
        id: 'user-poi-shared',
        name: 'Shared Spring',
        nameHe: 'מעיין משותף',
        nameEn: 'Shared Spring',
        category: 'water',
        subcategory: 'water_spring',
        lon: 35.2,
        lat: 31.2,
        ele: 150,
        waterStatus: null,
        difficulty4x4: null,
        descHe: '',
        descEn: '',
        source: 'User',
        wikipedia: null,
        userNotes: '',
        createdByUid: 'user-a',
        updatedByUid: 'user-b',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'user-poi-new',
        name: 'New Peak',
        nameHe: 'פסגה חדשה',
        nameEn: 'New Peak',
        category: 'peak',
        subcategory: 'peak_mountain',
        lon: 35.5,
        lat: 31.5,
        ele: 900,
        waterStatus: null,
        difficulty4x4: null,
        descHe: '',
        descEn: '',
        source: 'User',
        wikipedia: null,
        userNotes: '',
        createdByUid: 'user-b',
        updatedAt: '2026-02-02T00:00:00.000Z',
      },
    ];

    const remoteOverrides: PoiOverrideRecord[] = [
      {
        id: 'osm-1',
        deleted: false,
        category: 'water',
        subcategory: 'spring',
        updatedByUid: 'user-b',
        updatedAt: '2026-02-03T00:00:00.000Z',
      },
      {
        id: 'osm-2',
        deleted: true,
        category: null,
        subcategory: null,
        updatedByUid: 'ohad-uid',
        updatedAt: '2026-02-04T00:00:00.000Z',
      },
    ];

    const res = await PoiManager.reconcileRemoteGlobalPoisAndOverrides(
      remotePois,
      remoteOverrides
    );

    expect(res.poisChanged).toBe(true);
    expect(res.overridesChanged).toBe(true);

    // Merged view via getAllPois applies overrides & filters deleted POIs while keeping local notes
    const allPois = await PoiManager.getAllPois();
    const byId = new Map(allPois.map((p) => [p.id, p]));

    const effectiveOsm1 = byId.get('osm-1');
    expect(effectiveOsm1?.category).toBe('water');
    expect(effectiveOsm1?.subcategory).toBe('spring');
    expect(effectiveOsm1?.userNotes).toBe('הערה אישית שלי מהשטח');

    // Globally deleted bundled POI excluded from effective POI list & recorded in db.poiOverrides
    expect(byId.has('osm-2')).toBe(false);
    expect(memDb.poiOverrides.get('osm-2')?.deleted).toBe(true);

    // Deleted remote user-poi pruned, new user-poi added, shared user-poi updated + personal notes kept
    expect(byId.has('user-poi-removed')).toBe(false);
    expect(byId.get('user-poi-new')?.nameHe).toBe('פסגה חדשה');
    expect(byId.get('user-poi-shared')?.category).toBe('water');
    expect(byId.get('user-poi-shared')?.userNotes).toBe('לא לשתף הערה זו');
  });

  it('preserves pending offline user POIs and pre-migration local POIs during remote reconciliation', async () => {
    const { PoiManager } = await import('../pois/PoiManager');

    memDb.pois.set('user-poi-pending', {
      id: 'user-poi-pending',
      name: 'Offline Draft',
      nameHe: 'טיוטה אופליין',
      nameEn: 'Offline Draft',
      category: 'campsite',
      subcategory: 'campsite_night',
      lon: 35.0,
      lat: 31.0,
      ele: 120,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: '',
      createdByUid: 'user-1',
      updatedAt: '2026-02-01T00:00:00.000Z',
    });

    memDb.pois.set('user-poi-legacy', {
      id: 'user-poi-legacy',
      name: 'Legacy Local',
      nameHe: 'נקודה מקומית ישנה',
      nameEn: 'Legacy Local',
      category: 'water',
      subcategory: 'water_spring',
      lon: 35.1,
      lat: 31.1,
      ele: 140,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: '',
      updatedAt: '2025-12-01T00:00:00.000Z',
    });

    await PoiManager.reconcileRemoteGlobalPoisAndOverrides([], [], {
      pendingPoiIds: new Set(['user-poi-pending']),
      pendingDeleteIds: new Set(),
      pendingOverrideIds: new Set(),
      preserveUnpublishedLocalUserPois: true,
    });

    expect(memDb.pois.has('user-poi-pending')).toBe(true);
    expect(memDb.pois.has('user-poi-legacy')).toBe(true);
  });
});

describe('GlobalPoiCloudService', () => {
  beforeEach(() => {
    memDb.pois.clear();
    memDb.poiOverrides.clear();
    firestoreStore.docs.clear();
    firestoreStore.permissionDeniedKeys.clear();
    firestoreStore.servicesEnabled = true;
    ensureWindowAndLocalStorage();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes global POIs without leaking private local userNotes', async () => {
    const { toFirestoreGlobalPoi, fromFirestoreGlobalPoi } = await import(
      '../firebase/GlobalPoiCloudService'
    );

    const payload = toFirestoreGlobalPoi(
      {
        id: 'user-poi-123',
        name: 'Hidden Canyon',
        nameHe: 'קניון נסתר',
        nameEn: 'Hidden Canyon',
        category: 'peak',
        subcategory: 'peak_lookout',
        lon: 34.92,
        lat: 30.91,
        ele: 420,
        waterStatus: null,
        difficulty4x4: null,
        descHe: 'תצפית מדהימה',
        descEn: 'Great view',
        source: 'User',
        wikipedia: null,
        userNotes: 'PRIVATE PERSONAL NOTE',
      },
      'creator-uid'
    );

    expect(payload).not.toHaveProperty('userNotes');
    expect(payload.createdByUid).toBe('creator-uid');
    expect(payload.updatedByUid).toBe('creator-uid');

    const roundTripped = fromFirestoreGlobalPoi('user-poi-123', payload);
    expect(roundTripped).not.toBeNull();
    expect(roundTripped?.id).toBe('user-poi-123');
    expect(roundTripped?.nameHe).toBe('קניון נסתר');
    expect(roundTripped?.userNotes).toBe('');
  });

  it('enforces client-side auth guards for create/edit vs delete/restore', async () => {
    const { GlobalPoiCloudService } = await import('../firebase/GlobalPoiCloudService');

    const regularUser = {
      uid: 'regular-uid',
      email: 'regular@example.com',
      displayName: 'Regular',
      photoURL: null,
    };
    const adminUser = {
      uid: 'nabil-uid',
      email: 'nabibesk@gmail.com',
      displayName: 'Nabi',
      photoURL: null,
    };

    const samplePoi: PoiRecord = {
      id: 'user-poi-abc',
      name: 'Test',
      nameHe: 'בדיקה',
      nameEn: 'Test',
      category: 'water',
      subcategory: 'water_spring',
      lon: 35.1,
      lat: 31.5,
      ele: 200,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: '',
    };

    await expect(GlobalPoiCloudService.publishUserPoi(samplePoi, null)).rejects.toThrow();
    await expect(
      GlobalPoiCloudService.publishCategoryOverride(samplePoi, samplePoi, null)
    ).rejects.toThrow();

    // Regular signed-in user CAN publish and edit category
    const pubRes = await GlobalPoiCloudService.publishUserPoi(samplePoi, regularUser);
    expect(pubRes).toEqual({ synced: true, queuedOffline: false });
    expect(firestoreStore.docs.has('global_pois/user-poi-abc')).toBe(true);

    // Regular signed-in user CANNOT delete or restore POIs
    await expect(GlobalPoiCloudService.deleteGlobalPoi(samplePoi, regularUser)).rejects.toThrow();
    await expect(
      GlobalPoiCloudService.restoreDeletedGlobalPoi(
        { poi: samplePoi, previousOverride: null },
        regularUser
      )
    ).rejects.toThrow();

    // Admin user CAN delete the POI globally
    const delRes = await GlobalPoiCloudService.deleteGlobalPoi(samplePoi, adminUser);
    expect(delRes).toEqual({ synced: true, queuedOffline: false });
    expect(firestoreStore.docs.has('global_pois/user-poi-abc')).toBe(false);
  });

  it('queues offline mutations and flushes them when back online for the matching user', async () => {
    const { GlobalPoiCloudService } = await import('../firebase/GlobalPoiCloudService');

    const user = {
      uid: 'hiker-uid',
      email: 'hiker@example.com',
      displayName: 'Hiker',
      photoURL: null,
    };
    const poi: PoiRecord = {
      id: 'user-poi-offline',
      name: 'Offline Camp',
      nameHe: 'חניון אופליין',
      nameEn: 'Offline Camp',
      category: 'campsite',
      subcategory: 'campsite_night',
      lon: 34.7,
      lat: 30.7,
      ele: 300,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: '',
    };

    // Simulate offline
    (globalThis as unknown as { navigator: { onLine: boolean } }).navigator.onLine = false;
    const queued = await GlobalPoiCloudService.publishUserPoi(poi, user);
    expect(queued).toEqual({ synced: false, queuedOffline: true });
    expect(firestoreStore.docs.has('global_pois/user-poi-offline')).toBe(false);

    // Back online -> flush
    (globalThis as unknown as { navigator: { onLine: boolean } }).navigator.onLine = true;
    const flushedCount = await GlobalPoiCloudService.flushPendingOperations(user);
    expect(flushedCount).toBe(1);
    expect(firestoreStore.docs.has('global_pois/user-poi-offline')).toBe(true);
  });

  it('migrates legacy per-user overrides and local POIs ONLY for ohad.manor@gmail.com', async () => {
    const { GlobalPoiCloudService } = await import('../firebase/GlobalPoiCloudService');
    const { UserStateSyncService } = await import('../preferences/UserStateSyncService');

    const ohadUser = {
      uid: 'ohad-uid',
      email: 'ohad.manor@gmail.com',
      displayName: 'Ohad Manor',
      photoURL: null,
    };
    const nabiUser = {
      uid: 'nabi-uid',
      email: 'nabibesk@gmail.com',
      displayName: 'Nabi',
      photoURL: null,
    };

    // Seed legacy per-user app_state in cloud for Ohad
    firestoreStore.docs.set('planing_tracks/ohad-uid/settings/app_state', {
      poiOverrides: [
        {
          id: 'osm-water-9',
          deleted: false,
          category: 'water',
          subcategory: 'cistern',
          updatedAt: '2026-01-10T10:00:00.000Z',
        },
        {
          id: 'osm-bad-gate',
          deleted: true,
          updatedAt: '2026-01-11T10:00:00.000Z',
        },
      ],
      poiOverridesUpdatedAt: '2026-01-11T10:00:00.000Z',
    });

    // Also seed legacy localStorage & IndexedDB items on Ohad's browser
    const prevLocalState = UserStateSyncService.loadLocalState();
    UserStateSyncService.saveLocalState({
      ...prevLocalState,
      poiOverrides: [
        {
          id: 'osm-local-state',
          deleted: false,
          category: 'offroad',
          subcategory: 'offroad_gate',
          updatedAt: '2026-01-12T10:00:00.000Z',
        },
      ],
    });
    memDb.poiOverrides.set('osm-idb-only', {
      id: 'osm-idb-only',
      deleted: false,
      category: 'peak',
      subcategory: 'peak_lookout',
      updatedAt: '2026-01-13T10:00:00.000Z',
    });
    memDb.pois.set('user-poi-ohad-legacy', {
      id: 'user-poi-ohad-legacy',
      name: 'Ohad Secret Spot',
      nameHe: 'הנקודה של אוהד',
      nameEn: 'Ohad Secret Spot',
      category: 'peak',
      subcategory: 'peak_lookout',
      lon: 34.89,
      lat: 30.88,
      ele: 500,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'User',
      wikipedia: null,
      userNotes: 'הערה פרטית של אוהד',
      updatedAt: '2026-01-14T10:00:00.000Z',
    });

    // Non-Ohad admin does NOT trigger migration
    const skipped = await GlobalPoiCloudService.migrateLegacyOhadPoiData(nabiUser);
    expect(skipped).toEqual({ migratedOverrides: 0, migratedPois: 0 });
    expect(firestoreStore.docs.has('global_pois/user-poi-ohad-legacy')).toBe(false);

    // Ohad sign-in triggers one-time global migration
    const migrated = await GlobalPoiCloudService.migrateLegacyOhadPoiData(ohadUser);
    expect(migrated).toEqual({ migratedOverrides: 4, migratedPois: 1 });

    expect(firestoreStore.docs.get('poi_overrides/osm-water-9')).toMatchObject({
      id: 'osm-water-9',
      deleted: false,
      category: 'water',
      subcategory: 'cistern',
      updatedByUid: 'ohad-uid',
    });
    expect(firestoreStore.docs.get('poi_overrides/osm-bad-gate')).toMatchObject({
      id: 'osm-bad-gate',
      deleted: true,
      updatedByUid: 'ohad-uid',
    });
    expect(firestoreStore.docs.get('poi_overrides/osm-local-state')).toMatchObject({
      id: 'osm-local-state',
      category: 'offroad',
    });
    expect(firestoreStore.docs.get('poi_overrides/osm-idb-only')).toMatchObject({
      id: 'osm-idb-only',
      category: 'peak',
    });

    const migratedPoi = firestoreStore.docs.get('global_pois/user-poi-ohad-legacy');
    expect(migratedPoi).toMatchObject({
      id: 'user-poi-ohad-legacy',
      nameHe: 'הנקודה של אוהד',
      createdByUid: 'ohad-uid',
    });
    // Personal notes stay local, never migrated into global doc
    expect(migratedPoi).not.toHaveProperty('userNotes');

    // Legacy per-user cloud app_state cleaned up
    const cleanedAppState = firestoreStore.docs.get('planing_tracks/ohad-uid/settings/app_state');
    expect(cleanedAppState?.poiOverrides).toBeUndefined();
    expect(cleanedAppState?.poiOverridesMigratedAt).toBeTypeOf('string');
  });
});
