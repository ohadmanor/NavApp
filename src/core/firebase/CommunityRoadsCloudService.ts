import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  type DocumentData,
} from 'firebase/firestore';
import { db } from '../db/NavDatabase';
import {
  computeRoadBounds,
  getDefaultAccessForHighwayClass,
  isCommunityHighwayClass,
  validateCommunityRoadInput,
  type CommunityHighwayClass,
  type CommunityRoadDraftRecord,
  type CommunityRoadHistoryRecord,
  type CommunityRoadKind,
  type CommunityRoadOperation,
  type CommunityRoadRecord,
  type CommunityRoadSnapshot,
  type CommunityTrackType,
  type OsmSyncMetadata,
  type RoadConnectionAnchor,
} from '../trails/CommunityRoadTypes';
import {
  isTrailAnnotationColor,
  type TrailAnnotationColor,
} from '../trails/TrailAnnotationTypes';
import { AuthService, type NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

const COMMUNITY_ROADS_COLLECTION = 'community_roads';
export const COMMUNITY_ROADS_BOOT_STORAGE_KEY = 'navapp.communityRoadsBoot.v1';
const MAX_PUBLIC_ROADS = 500;
const MAX_HISTORY_PAGE_SIZE = 50;
const MAX_BOOT_STORAGE_CHARS = 1_500_000;

function readBootRoadsFromStorage(): CommunityRoadRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(COMMUNITY_ROADS_BOOT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is CommunityRoadRecord =>
        Boolean(r) &&
        typeof r === 'object' &&
        typeof r.id === 'string' &&
        Array.isArray(r.coordinates) &&
        r.coordinates.length >= 2 &&
        isCommunityHighwayClass(r.highwayClass)
    );
  } catch {
    return [];
  }
}

function writeBootRoadsToStorage(roads: readonly CommunityRoadRecord[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    // Keep active roads plus any unsynced local mutations for synchronous frame-0 map startup
    const compact = roads.filter(
      (r) => r.status === 'active' || r.cloudSyncStatus === 'pending' || r.cloudSyncStatus === 'error'
    );
    let payload = JSON.stringify(compact);
    if (payload.length > MAX_BOOT_STORAGE_CHARS) {
      // Fall back to osm-override records first if total community roads ever grow very large
      const overridesFirst = compact.filter((r) => r.kind === 'osm-override');
      payload = JSON.stringify(overridesFirst);
      if (payload.length > MAX_BOOT_STORAGE_CHARS) return;
    }
    window.localStorage.setItem(COMMUNITY_ROADS_BOOT_STORAGE_KEY, payload);
  } catch {
    // Ignore storage quota or restricted context errors
  }
}

function requireFirestore() {
  const services = getFirebaseServices();
  if (!services) {
    throw new Error('Firebase אינו זמין.');
  }
  return services.firestore;
}

export interface CommunityRoadLoadResult {
  roads: CommunityRoadRecord[];
  source: 'server' | 'cache';
  warning?: string;
}

export interface CommunityRoadHistoryPage {
  events: CommunityRoadHistoryRecord[];
  nextRevision: number | null;
}

export interface SaveCommunityRoadInput {
  roadId: string | null;
  expectedRevision: number;
  user: NavUser | null;
  kind: CommunityRoadKind;
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>;
  highwayClass: CommunityHighwayClass;
  tracktype?: CommunityTrackType;
  surface?: string;
  name: string;
  description: string;
  oneway: -1 | 0 | 1;
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
  anchors: RoadConnectionAnchor[];
  trailColor?: TrailAnnotationColor | '';
  trailNumber?: string;
  trailName?: string;
  reason: string;
  /** Save as a removed-road tombstone (see `CommunityRoadSnapshot.removed`). Omit to save a normal road. */
  removed?: boolean;
}

export class CommunityRoadConflictError extends Error {
  constructor(message = 'דרך זו עודכנה על ידי משתמש אחר. יש לטעון מחדש לפני שמירה.') {
    super(message);
    this.name = 'CommunityRoadConflictError';
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function asIsoString(value: unknown): string {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

function decodeCoord(raw: unknown): [number, number] | null {
  if (Array.isArray(raw) && raw.length >= 2 && Number.isFinite(raw[0]) && Number.isFinite(raw[1])) {
    return [Number(raw[0]), Number(raw[1])];
  }
  if (
    raw &&
    typeof raw === 'object' &&
    'lon' in raw &&
    'lat' in raw &&
    Number.isFinite((raw as { lon: unknown }).lon) &&
    Number.isFinite((raw as { lat: unknown }).lat)
  ) {
    return [Number((raw as { lon: number }).lon), Number((raw as { lat: number }).lat)];
  }
  return null;
}

function encodeCoord(coord: [number, number]): { lon: number; lat: number } {
  return { lon: Number(coord[0].toFixed(6)), lat: Number(coord[1].toFixed(6)) };
}

function decodeAnchor(raw: unknown): RoadConnectionAnchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const coord = decodeCoord(obj.coord);
  if (!coord || typeof obj.targetWayId !== 'string') return null;
  return {
    vertexIndex: Number(obj.vertexIndex || 0),
    targetWayId: obj.targetWayId,
    coord,
    gx: Number(obj.gx || 0),
    gy: Number(obj.gy || 0),
    snapType: obj.snapType === 'vertex' ? 'vertex' : 'segment',
  };
}

function encodeAnchor(anchor: RoadConnectionAnchor): Record<string, unknown> {
  return {
    vertexIndex: anchor.vertexIndex,
    targetWayId: anchor.targetWayId,
    coord: encodeCoord(anchor.coord),
    gx: anchor.gx,
    gy: anchor.gy,
    snapType: anchor.snapType,
  };
}

function normalizeOsmSync(raw: unknown): OsmSyncMetadata | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  if (!Number.isFinite(obj.changesetId) || !Number.isFinite(obj.osmWayId)) return undefined;
  return {
    changesetId: Number(obj.changesetId),
    osmWayId: Number(obj.osmWayId),
    osmVersion: Number(obj.osmVersion || 1),
    syncedRevision: Number(obj.syncedRevision || 1),
    syncedAt: asIsoString(obj.syncedAt),
    syncedByUid: String(obj.syncedByUid || ''),
    syncedByName: String(obj.syncedByName || ''),
    ...(typeof obj.osmUsername === 'string' ? { osmUsername: obj.osmUsername } : {}),
  };
}

function normalizeCommunityRoad(id: string, value: DocumentData): CommunityRoadRecord {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.coordinates) ||
    !isCommunityHighwayClass(value.highwayClass) ||
    typeof value.revision !== 'number'
  ) {
    throw new Error(`Invalid community road document ${id}`);
  }
  const coordinates = value.coordinates
    .map(decodeCoord)
    .filter((pt): pt is [number, number] => pt !== null);
  if (coordinates.length < 2) {
    throw new Error(`Community road ${id} has invalid coordinates`);
  }
  const anchors = Array.isArray(value.anchors)
    ? value.anchors.map(decodeAnchor).filter((a): a is RoadConnectionAnchor => a !== null)
    : [];
  const bounds: [number, number, number, number] =
    Array.isArray(value.bounds) && value.bounds.length === 4
      ? [
          Number(value.bounds[0]),
          Number(value.bounds[1]),
          Number(value.bounds[2]),
          Number(value.bounds[3]),
        ]
      : computeRoadBounds(coordinates);

  const trailColor = isTrailAnnotationColor(value.trailColor) ? value.trailColor : '';

  return {
    id,
    schemaVersion: 1,
    kind: value.kind === 'osm-override' ? 'osm-override' : 'new',
    ...(typeof value.sourceOsmWayId === 'string' ? { sourceOsmWayId: value.sourceOsmWayId } : {}),
    coordinates,
    bounds,
    highwayClass: value.highwayClass,
    tracktype: typeof value.tracktype === 'string' ? (value.tracktype as CommunityTrackType) : '',
    surface: typeof value.surface === 'string' ? value.surface : '',
    name: typeof value.name === 'string' ? value.name : '',
    description: typeof value.description === 'string' ? value.description : '',
    oneway: value.oneway === 1 ? 1 : value.oneway === -1 ? -1 : 0,
    allow4x4: Boolean(value.allow4x4),
    allowFoot: Boolean(value.allowFoot),
    allowBicycle: Boolean(value.allowBicycle),
    anchors,
    trailColor,
    trailNumber: typeof value.trailNumber === 'string' ? value.trailNumber : '',
    trailName: typeof value.trailName === 'string' ? value.trailName : '',
    status: value.status === 'deleted' ? 'deleted' : 'active',
    ...(value.removed === true ? { removed: true } : {}),
    revision: value.revision,
    lastHistoryId: String(value.lastHistoryId || ''),
    createdByUid: String(value.createdByUid || ''),
    createdAt: asIsoString(value.createdAt),
    updatedByUid: String(value.updatedByUid || ''),
    updatedAt: asIsoString(value.updatedAt),
    cloudSyncStatus: 'synced',
    ...(value.osmSync ? { osmSync: normalizeOsmSync(value.osmSync) } : {}),
  };
}

function toSnapshot(road: CommunityRoadSnapshot): CommunityRoadSnapshot {
  return {
    kind: road.kind,
    ...(road.sourceOsmWayId ? { sourceOsmWayId: road.sourceOsmWayId } : {}),
    coordinates: road.coordinates.map(([lon, lat]) => [lon, lat]),
    bounds: [...road.bounds] as [number, number, number, number],
    highwayClass: road.highwayClass,
    tracktype: road.tracktype || '',
    surface: road.surface || '',
    name: road.name,
    description: road.description,
    oneway: road.oneway,
    allow4x4: road.allow4x4,
    allowFoot: road.allowFoot,
    allowBicycle: road.allowBicycle,
    anchors: road.anchors.map((a) => ({ ...a, coord: [...a.coord] as [number, number] })),
    trailColor: road.trailColor || '',
    trailNumber: road.trailNumber || '',
    trailName: road.trailName || '',
    status: road.status,
    ...(road.removed ? { removed: true } : {}),
  };
}

function encodeSnapshotForFirestore(snapshot: CommunityRoadSnapshot): Record<string, unknown> {
  return {
    kind: snapshot.kind,
    ...(snapshot.sourceOsmWayId ? { sourceOsmWayId: snapshot.sourceOsmWayId } : {}),
    coordinates: snapshot.coordinates.map(encodeCoord),
    bounds: snapshot.bounds,
    highwayClass: snapshot.highwayClass,
    tracktype: snapshot.tracktype || '',
    surface: snapshot.surface || '',
    name: snapshot.name,
    description: snapshot.description,
    oneway: snapshot.oneway,
    allow4x4: snapshot.allow4x4,
    allowFoot: snapshot.allowFoot,
    allowBicycle: snapshot.allowBicycle,
    anchors: snapshot.anchors.map(encodeAnchor),
    trailColor: snapshot.trailColor || '',
    trailNumber: snapshot.trailNumber || '',
    trailName: snapshot.trailName || '',
    status: snapshot.status,
    ...(snapshot.removed ? { removed: true } : {}),
  };
}

function normalizeHistorySnapshot(raw: unknown): CommunityRoadSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const coordinates = Array.isArray(obj.coordinates)
    ? obj.coordinates.map(decodeCoord).filter((pt): pt is [number, number] => pt !== null)
    : [];
  const bounds: [number, number, number, number] =
    Array.isArray(obj.bounds) && obj.bounds.length === 4
      ? [Number(obj.bounds[0]), Number(obj.bounds[1]), Number(obj.bounds[2]), Number(obj.bounds[3])]
      : computeRoadBounds(coordinates);
  const anchors = Array.isArray(obj.anchors)
    ? obj.anchors.map(decodeAnchor).filter((a): a is RoadConnectionAnchor => a !== null)
    : [];
  if (!isCommunityHighwayClass(obj.highwayClass)) return null;
  return {
    kind: obj.kind === 'osm-override' ? 'osm-override' : 'new',
    ...(typeof obj.sourceOsmWayId === 'string' ? { sourceOsmWayId: obj.sourceOsmWayId } : {}),
    coordinates,
    bounds,
    highwayClass: obj.highwayClass,
    tracktype: typeof obj.tracktype === 'string' ? (obj.tracktype as CommunityTrackType) : '',
    surface: typeof obj.surface === 'string' ? obj.surface : '',
    name: typeof obj.name === 'string' ? obj.name : '',
    description: typeof obj.description === 'string' ? obj.description : '',
    oneway: obj.oneway === 1 ? 1 : obj.oneway === -1 ? -1 : 0,
    allow4x4: Boolean(obj.allow4x4),
    allowFoot: Boolean(obj.allowFoot),
    allowBicycle: Boolean(obj.allowBicycle),
    anchors,
    trailColor: isTrailAnnotationColor(obj.trailColor) ? obj.trailColor : '',
    trailNumber: typeof obj.trailNumber === 'string' ? obj.trailNumber : '',
    trailName: typeof obj.trailName === 'string' ? obj.trailName : '',
    status: obj.status === 'deleted' ? 'deleted' : 'active',
    ...(obj.removed === true ? { removed: true } : {}),
  };
}

export class CommunityRoadsCloudService {
  private memoryCache: CommunityRoadRecord[] = [];
  private lastCacheJson = '';
  private listeners = new Set<(roads: CommunityRoadRecord[]) => void>();
  private syncInFlight = false;
  private serverSynced = false;
  private localMutated = false;
  private loadInFlight: Promise<CommunityRoadLoadResult> | null = null;

  constructor() {
    const bootRoads = readBootRoadsFromStorage();
    if (bootRoads.length > 0) {
      const sorted = this.sortRoads(bootRoads);
      this.memoryCache = sorted;
      this.lastCacheJson = JSON.stringify(sorted);
    }
    void this.warmCacheFromDexie();
  }

  private sortRoads(roads: readonly CommunityRoadRecord[]): CommunityRoadRecord[] {
    return roads
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  private async warmCacheFromDexie(): Promise<void> {
    try {
      const cached = await db.communityRoads.toArray();
      if (this.serverSynced || this.localMutated) return;
      if (cached.length > 0) {
        this.setMemoryCache(cached);
      }
    } catch {
      // Ignore indexedDB errors during SSR/tests
    }
  }

  private setMemoryCache(roads: CommunityRoadRecord[], options?: { persistBoot?: boolean }): void {
    const sorted = this.sortRoads(roads);
    const nextJson = JSON.stringify(sorted);
    if (nextJson === this.lastCacheJson) {
      return;
    }
    this.memoryCache = sorted;
    this.lastCacheJson = nextJson;
    if (options?.persistBoot !== false) {
      writeBootRoadsToStorage(sorted);
    }
    for (const listener of this.listeners) {
      listener(this.memoryCache);
    }
  }

  private async reconcileServerRoads(
    serverRoads: CommunityRoadRecord[],
    serverWasTruncated: boolean
  ): Promise<CommunityRoadRecord[]> {
    const cached = await db.communityRoads.toArray().catch(() => this.memoryCache);
    const mergedById = new Map<string, CommunityRoadRecord>();
    for (const sRoad of serverRoads) {
      mergedById.set(sRoad.id, sRoad);
    }
    const deletedOnServerIds: string[] = [];
    for (const lRoad of cached) {
      if (lRoad.cloudSyncStatus === 'pending' || lRoad.cloudSyncStatus === 'error') {
        mergedById.set(lRoad.id, lRoad);
      } else if (!mergedById.has(lRoad.id)) {
        if (serverWasTruncated) {
          mergedById.set(lRoad.id, lRoad);
        } else {
          deletedOnServerIds.push(lRoad.id);
        }
      }
    }
    const merged = Array.from(mergedById.values());
    if (deletedOnServerIds.length > 0) {
      await db.communityRoads.bulkDelete(deletedOnServerIds).catch(() => {});
    }
    await db.communityRoads.bulkPut(merged).catch(() => {});
    this.serverSynced = true;
    this.setMemoryCache(merged);
    return this.memoryCache;
  }

  getCachedRoads(): CommunityRoadRecord[] {
    return this.memoryCache;
  }

  getCachedActiveRoads(): CommunityRoadRecord[] {
    return this.memoryCache.filter((r) => r.status === 'active');
  }

  subscribe(listener: (roads: CommunityRoadRecord[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async pushRecordToFirestore(
    localRecord: CommunityRoadRecord,
    user: NavUser,
    reason: string
  ): Promise<CommunityRoadRecord> {
    const firestore = requireFirestore();
    const roadRef = doc(firestore, COMMUNITY_ROADS_COLLECTION, localRecord.id);
    const snapshotToWrite = toSnapshot(localRecord);
    const encodedNext = encodeSnapshotForFirestore(snapshotToWrite);

    const txResult = await runTransaction(firestore, async (tx) => {
      const existingSnap = await tx.get(roadRef);
      let prevRecord: CommunityRoadRecord | null = null;
      let rawCreatedAt: unknown = null;
      let rawOsmSync: unknown = null;
      let operation: CommunityRoadOperation = 'create';
      let revision = 1;

      if (existingSnap.exists()) {
        const rawData = existingSnap.data();
        rawCreatedAt = rawData.createdAt ?? null;
        rawOsmSync = rawData.osmSync ?? null;
        prevRecord = normalizeCommunityRoad(localRecord.id, rawData);
        revision = prevRecord.revision + 1;
        operation =
          localRecord.status === 'deleted'
            ? 'delete'
            : prevRecord.status === 'deleted'
              ? 'restore'
              : 'edit';
      }

      const historyId = `${revision}-${randomId()}`;
      const historyRef = doc(
        firestore,
        COMMUNITY_ROADS_COLLECTION,
        localRecord.id,
        'history',
        historyId
      );
      const encodedPrev = prevRecord ? encodeSnapshotForFirestore(toSnapshot(prevRecord)) : null;

      tx.set(historyRef, {
        revision,
        operation,
        actorUid: user.uid,
        occurredAt: serverTimestamp(),
        previous: encodedPrev,
        next: encodedNext,
        reason: reason.trim(),
      });

      tx.set(roadRef, {
        schemaVersion: 1,
        ...encodedNext,
        ...(rawOsmSync ? { osmSync: rawOsmSync } : {}),
        revision,
        lastHistoryId: historyId,
        createdByUid: prevRecord ? prevRecord.createdByUid : user.uid,
        createdAt: prevRecord ? rawCreatedAt : serverTimestamp(),
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });

      return { revision, historyId, prevRecord };
    });

    const syncedRecord: CommunityRoadRecord = {
      ...localRecord,
      revision: txResult.revision,
      lastHistoryId: txResult.historyId,
      createdByUid: txResult.prevRecord ? txResult.prevRecord.createdByUid : user.uid,
      createdAt: txResult.prevRecord ? txResult.prevRecord.createdAt : localRecord.createdAt,
      updatedByUid: user.uid,
      cloudSyncStatus: 'synced',
      cloudSyncError: undefined,
      ...(txResult.prevRecord?.osmSync ? { osmSync: txResult.prevRecord.osmSync } : {}),
    };

    await db.communityRoads.put(syncedRecord).catch(() => {});
    const updatedList = [syncedRecord, ...this.memoryCache.filter((r) => r.id !== syncedRecord.id)];
    this.setMemoryCache(updatedList);
    return syncedRecord;
  }

  async syncPendingRoads(user: NavUser | null = AuthService.getCurrentUser()): Promise<void> {
    if (!user || !AuthService.isAvailable() || this.syncInFlight) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    this.syncInFlight = true;
    try {
      const localRoads = await db.communityRoads.toArray().catch(() => this.memoryCache);
      const pending = localRoads.filter(
        (r) => r.cloudSyncStatus === 'pending' || r.cloudSyncStatus === 'error'
      );
      for (const road of pending) {
        try {
          await this.pushRecordToFirestore(road, user, 'סנכרון אוטומטי מהמכשיר');
        } catch (err) {
          const errorRecord: CommunityRoadRecord = {
            ...road,
            cloudSyncStatus: 'error',
            cloudSyncError: err instanceof Error ? err.message : String(err),
          };
          await db.communityRoads.put(errorRecord).catch(() => {});
          this.setMemoryCache([
            errorRecord,
            ...this.memoryCache.filter((r) => r.id !== errorRecord.id),
          ]);
        }
      }
    } finally {
      this.syncInFlight = false;
    }
  }

  async loadCommunityRoads(): Promise<CommunityRoadLoadResult> {
    if (this.loadInFlight) {
      return this.loadInFlight;
    }

    const run = async (): Promise<CommunityRoadLoadResult> => {
      const cached = await db.communityRoads.toArray().catch(() => [] as CommunityRoadRecord[]);
      if (!this.serverSynced && !this.localMutated && cached.length > 0) {
        // Emit cached Dexie records immediately so map/UI never blocks on network fetch
        this.setMemoryCache(cached);
      }
      if (!AuthService.isAvailable()) {
        this.setMemoryCache(cached);
        return { roads: this.memoryCache, source: 'cache' };
      }
      try {
        const firestore = requireFirestore();
        const roadsQuery = query(
          collection(firestore, COMMUNITY_ROADS_COLLECTION),
          orderBy('updatedAt', 'desc'),
          limit(MAX_PUBLIC_ROADS)
        );
        const snap = await getDocs(roadsQuery);
        const serverRoads: CommunityRoadRecord[] = [];
        let skippedInvalid = 0;
        for (const docSnap of snap.docs) {
          try {
            serverRoads.push(normalizeCommunityRoad(docSnap.id, docSnap.data()));
          } catch {
            skippedInvalid += 1;
          }
        }
        await this.reconcileServerRoads(serverRoads, snap.docs.length >= MAX_PUBLIC_ROADS);

        // Push any pending local roads in the background
        void this.syncPendingRoads();

        return {
          roads: this.memoryCache,
          source: 'server',
          warning: skippedInvalid > 0 ? `${skippedInvalid} רשומות דרך לא תקינות דולגו.` : undefined,
        };
      } catch {
        if (!this.serverSynced && !this.localMutated && cached.length > 0) {
          this.setMemoryCache(cached);
        }
        return {
          roads: this.memoryCache,
          source: 'cache',
          warning: cached.length > 0 ? 'נטענו דרכים קהילתיות מהמטמון המקומי (אופליין).' : undefined,
        };
      }
    };

    const promise = run().finally(() => {
      if (this.loadInFlight === promise) {
        this.loadInFlight = null;
      }
    });
    this.loadInFlight = promise;
    return promise;
  }

  /**
   * Subscribes to real-time Firestore community road updates so edits made on another device
   * immediately update the map and local boot/Dexie caches.
   */
  subscribeCommunityRoads(): () => void {
    if (!AuthService.isAvailable() || typeof onSnapshot !== 'function') {
      return () => {};
    }
    let disposed = false;
    try {
      const firestore = requireFirestore();
      const roadsQuery = query(
        collection(firestore, COMMUNITY_ROADS_COLLECTION),
        orderBy('updatedAt', 'desc'),
        limit(MAX_PUBLIC_ROADS)
      );
      const unsub = onSnapshot(
        roadsQuery,
        (snap) => {
          if (disposed) return;
          const serverRoads: CommunityRoadRecord[] = [];
          snap.docs.forEach((docSnap) => {
            try {
              serverRoads.push(normalizeCommunityRoad(docSnap.id, docSnap.data()));
            } catch {
              // Skip invalid remote docs
            }
          });
          void this.reconcileServerRoads(serverRoads, snap.docs.length >= MAX_PUBLIC_ROADS);
        },
        (err) => {
          console.warn('[CommunityRoadsCloudService] Snapshot warning:', err);
        }
      );
      return () => {
        disposed = true;
        unsub();
      };
    } catch {
      return () => {};
    }
  }

  /**
   * Local-First Save: writes immediately to Dexie + memoryCache so map & routing update instantly,
   * then syncs to Firebase in the background (never blocks or loses local work if offline/sync fails).
   */
  async saveCommunityRoad(input: SaveCommunityRoadInput): Promise<CommunityRoadRecord> {
    const validationError = validateCommunityRoadInput(input);
    if (validationError) {
      throw new Error(validationError);
    }

    const roadId = input.roadId || randomId();
    const existingLocal =
      this.memoryCache.find((r) => r.id === roadId) ??
      (await db.communityRoads.get(roadId).catch(() => undefined));

    const bounds = computeRoadBounds(input.coordinates);
    const nowIso = new Date().toISOString();
    const uid = input.user?.uid || existingLocal?.updatedByUid || 'local-user';
    const nextRevision = (existingLocal?.revision ?? input.expectedRevision ?? 0) + 1;

    const localRecord: CommunityRoadRecord = {
      id: roadId,
      schemaVersion: 1,
      kind: input.kind,
      ...(input.sourceOsmWayId ? { sourceOsmWayId: input.sourceOsmWayId } : {}),
      coordinates: input.coordinates.map(([lon, lat]) => [
        Number(lon.toFixed(6)),
        Number(lat.toFixed(6)),
      ]),
      bounds,
      highwayClass: input.highwayClass,
      tracktype: input.tracktype || '',
      surface: (input.surface || '').trim(),
      name: input.name.trim(),
      description: input.description.trim(),
      oneway: input.oneway,
      allow4x4: input.allow4x4,
      allowFoot: input.allowFoot,
      allowBicycle: input.allowBicycle,
      anchors: input.anchors,
      trailColor: input.trailColor || '',
      trailNumber: (input.trailNumber || '').trim(),
      trailName: (input.trailName || '').trim(),
      status: 'active',
      ...(input.removed && input.kind === 'osm-override' ? { removed: true } : {}),
      revision: nextRevision,
      lastHistoryId: existingLocal?.lastHistoryId || `${nextRevision}-local`,
      createdByUid: existingLocal?.createdByUid || uid,
      createdAt: existingLocal?.createdAt || nowIso,
      updatedByUid: uid,
      updatedAt: nowIso,
      cloudSyncStatus: 'pending',
    };

    // 1. Save locally FIRST — guaranteed immediate persistence & map update
    this.localMutated = true;
    await db.communityRoads.put(localRecord);
    this.setMemoryCache([localRecord, ...this.memoryCache.filter((r) => r.id !== localRecord.id)]);

    // 2. Sync to Firebase asynchronously (do not fail the local save if offline/Firebase rejects)
    if (input.user && AuthService.isAvailable()) {
      this.pushRecordToFirestore(localRecord, input.user, input.reason).catch((err) => {
        const errorRecord: CommunityRoadRecord = {
          ...localRecord,
          cloudSyncStatus: 'error',
          cloudSyncError: err instanceof Error ? err.message : String(err),
        };
        void db.communityRoads.put(errorRecord).catch(() => {});
        this.setMemoryCache([
          errorRecord,
          ...this.memoryCache.filter((r) => r.id !== errorRecord.id),
        ]);
      });
    }

    return localRecord;
  }

  async deleteCommunityRoad(params: {
    roadId: string;
    expectedRevision: number;
    user: NavUser | null;
    reason?: string;
  }): Promise<CommunityRoadRecord> {
    const existingLocal =
      this.memoryCache.find((r) => r.id === params.roadId) ??
      (await db.communityRoads.get(params.roadId).catch(() => undefined));
    if (!existingLocal) {
      throw new CommunityRoadConflictError('הדרך לא נמצאה במכשיר.');
    }

    const nowIso = new Date().toISOString();
    const uid = params.user?.uid || existingLocal.updatedByUid || 'local-user';
    const nextRevision = existingLocal.revision + 1;
    const deletedLocal: CommunityRoadRecord = {
      ...existingLocal,
      status: 'deleted',
      revision: nextRevision,
      updatedByUid: uid,
      updatedAt: nowIso,
      cloudSyncStatus: 'pending',
    };

    // 1. Save locally FIRST
    this.localMutated = true;
    await db.communityRoads.put(deletedLocal);
    this.setMemoryCache([
      deletedLocal,
      ...this.memoryCache.filter((r) => r.id !== deletedLocal.id),
    ]);

    // 2. Sync to Firebase asynchronously
    if (params.user && AuthService.isAvailable()) {
      this.pushRecordToFirestore(
        deletedLocal,
        params.user,
        params.reason || 'מחיקת דרך קהילתית'
      ).catch((err) => {
        const errorRecord: CommunityRoadRecord = {
          ...deletedLocal,
          cloudSyncStatus: 'error',
          cloudSyncError: err instanceof Error ? err.message : String(err),
        };
        void db.communityRoads.put(errorRecord).catch(() => {});
        this.setMemoryCache([
          errorRecord,
          ...this.memoryCache.filter((r) => r.id !== errorRecord.id),
        ]);
      });
    }

    return deletedLocal;
  }

  /**
   * Removes a whole OSM way from the map, routing and snapping by saving an `osm-override` tombstone
   * (`removed: true`). Local-first like `saveCommunityRoad`. The way is never deleted from OpenStreetMap,
   * and saving the record again without `removed` restores it.
   */
  async removeOsmRoad(params: {
    roadId: string | null;
    expectedRevision: number;
    user: NavUser | null;
    sourceOsmWayId: string;
    coordinates: Array<[number, number]>;
    highwayClass: CommunityHighwayClass;
    name?: string;
    reason?: string;
  }): Promise<CommunityRoadRecord> {
    // Prefer the saved override so unsaved form/geometry edits never end up in the tombstone
    const existing = params.roadId
      ? this.memoryCache.find((r) => r.id === params.roadId) ??
        (await db.communityRoads.get(params.roadId).catch(() => undefined))
      : undefined;
    const highwayClass = existing?.highwayClass ?? params.highwayClass;
    const defaults = getDefaultAccessForHighwayClass(highwayClass);
    return this.saveCommunityRoad({
      roadId: params.roadId,
      expectedRevision: params.expectedRevision,
      user: params.user,
      kind: 'osm-override',
      sourceOsmWayId: params.sourceOsmWayId,
      coordinates: existing?.coordinates ?? params.coordinates,
      highwayClass,
      tracktype: existing?.tracktype ?? '',
      surface: existing?.surface ?? '',
      name: existing?.name ?? params.name ?? '',
      description: existing?.description ?? '',
      oneway: existing?.oneway ?? 0,
      allow4x4: existing?.allow4x4 ?? defaults.allow4x4,
      allowFoot: existing?.allowFoot ?? defaults.allowFoot,
      allowBicycle: existing?.allowBicycle ?? defaults.allowBicycle,
      anchors: existing?.anchors ?? [],
      trailColor: existing?.trailColor ?? '',
      trailNumber: existing?.trailNumber ?? '',
      trailName: existing?.trailName ?? '',
      reason: params.reason || 'הסרת דרך מהמפה',
      removed: true,
    });
  }

  /**
   * Records a completed OSM changeset upload on a community road document via an immutable
   * `osm-sync` history transaction, bumping revision and setting `syncedRevision = revision`.
   */
  async markRoadOsmSynced(params: {
    roadId: string;
    user: NavUser;
    changesetId: number;
    osmWayId: number;
    osmVersion: number;
    osmUsername?: string;
  }): Promise<CommunityRoadRecord> {
    const firestore = requireFirestore();
    const roadRef = doc(firestore, COMMUNITY_ROADS_COLLECTION, params.roadId);
    const actorName = params.user.displayName || params.user.email || params.user.uid;
    const nowIso = new Date().toISOString();

    const updatedRecord = await runTransaction(firestore, async (tx) => {
      const existingSnap = await tx.get(roadRef);
      if (!existingSnap.exists()) {
        throw new CommunityRoadConflictError('הדרך לא נמצאה ב-Firestore.');
      }
      const prevRecord = normalizeCommunityRoad(params.roadId, existingSnap.data());
      if (prevRecord.status !== 'active') {
        throw new CommunityRoadConflictError('לא ניתן לסנכרן דרך שנמחקה.');
      }
      const nextRevision = prevRecord.revision + 1;
      const historyId = `${nextRevision}-${randomId()}`;
      const historyRef = doc(
        firestore,
        COMMUNITY_ROADS_COLLECTION,
        params.roadId,
        'history',
        historyId
      );
      const encodedSnap = encodeSnapshotForFirestore(toSnapshot(prevRecord));
      const osmSyncPayload = {
        changesetId: params.changesetId,
        osmWayId: params.osmWayId,
        osmVersion: params.osmVersion,
        syncedRevision: nextRevision,
        syncedAt: serverTimestamp(),
        syncedByUid: params.user.uid,
        syncedByName: actorName,
        ...(params.osmUsername ? { osmUsername: params.osmUsername } : {}),
      };

      tx.set(historyRef, {
        revision: nextRevision,
        operation: 'osm-sync',
        actorUid: params.user.uid,
        occurredAt: serverTimestamp(),
        previous: encodedSnap,
        next: encodedSnap,
        reason: `סנכרון ל-OSM (changeset #${params.changesetId}, way #${params.osmWayId})`,
      });

      tx.update(roadRef, {
        revision: nextRevision,
        lastHistoryId: historyId,
        updatedByUid: params.user.uid,
        updatedAt: serverTimestamp(),
        osmSync: osmSyncPayload,
      });

      const nextRecord: CommunityRoadRecord = {
        ...prevRecord,
        revision: nextRevision,
        lastHistoryId: historyId,
        updatedByUid: params.user.uid,
        updatedAt: nowIso,
        cloudSyncStatus: 'synced',
        cloudSyncError: undefined,
        osmSync: {
          changesetId: params.changesetId,
          osmWayId: params.osmWayId,
          osmVersion: params.osmVersion,
          syncedRevision: nextRevision,
          syncedAt: nowIso,
          syncedByUid: params.user.uid,
          syncedByName: actorName,
          ...(params.osmUsername ? { osmUsername: params.osmUsername } : {}),
        },
      };
      return nextRecord;
    });

    await db.communityRoads.put(updatedRecord).catch(() => {});
    this.setMemoryCache([
      updatedRecord,
      ...this.memoryCache.filter((r) => r.id !== updatedRecord.id),
    ]);
    return updatedRecord;
  }

  async loadHistoryPage(roadId: string, afterRevision?: number | null): Promise<CommunityRoadHistoryPage> {
    const firestore = requireFirestore();
    const historyCol = collection(firestore, COMMUNITY_ROADS_COLLECTION, roadId, 'history');
    const q = afterRevision
      ? query(historyCol, orderBy('revision', 'desc'), startAfter(afterRevision), limit(MAX_HISTORY_PAGE_SIZE))
      : query(historyCol, orderBy('revision', 'desc'), limit(MAX_HISTORY_PAGE_SIZE));
    const snap = await getDocs(q);
    const events: CommunityRoadHistoryRecord[] = [];
    for (const d of snap.docs) {
      const data = d.data();
      const nextSnap = normalizeHistorySnapshot(data.next);
      if (!nextSnap) continue;
      events.push({
        id: d.id,
        revision: Number(data.revision || 0),
        operation: (data.operation || 'edit') as CommunityRoadOperation,
        actorUid: String(data.actorUid || ''),
        occurredAt: asIsoString(data.occurredAt),
        previous: normalizeHistorySnapshot(data.previous),
        next: nextSnap,
        reason: String(data.reason || ''),
      });
    }
    const nextRevision =
      snap.docs.length === MAX_HISTORY_PAGE_SIZE ? events[events.length - 1]?.revision ?? null : null;
    return { events, nextRevision };
  }

  async saveDraft(draft: CommunityRoadDraftRecord): Promise<void> {
    await db.communityRoadDrafts.put(draft).catch(() => {});
  }

  async loadDraft(id: string): Promise<CommunityRoadDraftRecord | undefined> {
    return db.communityRoadDrafts.get(id).catch(() => undefined);
  }

  async clearDraft(id: string): Promise<void> {
    await db.communityRoadDrafts.delete(id).catch(() => {});
  }
}

export const communityRoadsCloudService = new CommunityRoadsCloudService();
