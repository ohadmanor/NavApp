import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  setDoc,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import { db, type PoiCategory, type PoiOverrideRecord, type PoiRecord } from '../db/NavDatabase';
import type { DeletedPoiUndoSnapshot } from '../pois/PoiManager';
import { PoiManager } from '../pois/PoiManager';
import {
  canUserAddOrEditPoi,
  canUserDeletePoi,
  isLegacyPoiMigrationSourceUser,
} from '../pois/poiPermissions';
import { isValidPoiCategory, normalizeSubcategoryForCategory } from '../pois/poiTaxonomy';
import {
  USER_SETTINGS_COLLECTION,
  USER_SETTINGS_DOC_ID,
  USER_SETTINGS_SUBCOLLECTION,
  UserStateSyncService,
  sanitizePoiOverrides,
} from '../preferences/UserStateSyncService';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

export const GLOBAL_POIS_COLLECTION = 'global_pois';
export const POI_OVERRIDES_COLLECTION = 'poi_overrides';

export function toSafeFirestorePoiId(rawId: string): string {
  const cleaned = String(rawId || '')
    .trim()
    .replace(/\//g, '_')
    .slice(0, 128);
  return cleaned || 'poi-unknown';
}

const PENDING_GLOBAL_POIS_KEY = 'navapp.pendingGlobalPois.v1';
const PENDING_GLOBAL_POI_OVERRIDES_KEY = 'navapp.pendingGlobalPoiOverrides.v1';
const PENDING_GLOBAL_POI_DELETES_KEY = 'navapp.pendingGlobalPoiDeletes.v1';
const OHAD_MIGRATION_DONE_KEY = 'navapp.ohadGlobalPoiMigrated.v1';
const LEGACY_POI_BACKUP_KEY = 'navapp.legacyPoiBackup.v1';

interface PendingGlobalPoiOp {
  poi: PoiRecord;
  actorUid: string;
  queuedAt: string;
}

interface PendingGlobalOverrideOp {
  override: PoiOverrideRecord;
  actorUid: string;
  userPoiUpdate?: PoiRecord;
  queuedAt: string;
}

interface PendingGlobalDeleteOp {
  poiId: string;
  isUserPoi: boolean;
  actorUid: string;
  queuedAt: string;
}

interface LegacyPoiBackupPayload {
  overrides: PoiOverrideRecord[];
  userPois: PoiRecord[];
  capturedAt: string;
}

function isOnlineNow(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as { code?: unknown })?.code || '').toLowerCase();
  const message = String((err as { message?: unknown })?.message || '').toLowerCase();
  return code === 'permission-denied' || message.includes('permission-denied') || message.includes('missing or insufficient permissions');
}

function readLocalJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota / restricted context errors
  }
}

function removeLocalKey(key: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export interface FirestoreGlobalPoiDoc {
  id: string;
  name: string;
  nameHe: string;
  nameEn: string;
  category: PoiCategory;
  subcategory: string;
  lon: number;
  lat: number;
  ele: number | null;
  waterStatus: string | null;
  difficulty4x4: string | null;
  descHe: string;
  descEn: string;
  source: string;
  createdByUid: string;
  createdAt: string;
  updatedByUid: string;
  updatedAt: string;
}

export interface FirestorePoiOverrideDoc {
  id: string;
  deleted: boolean;
  category: PoiCategory | null;
  subcategory: string | null;
  updatedByUid: string;
  updatedAt: string;
}

export function toFirestoreGlobalPoi(
  poi: PoiRecord,
  actorUid: string,
  existingCreatedByUid?: string,
  existingCreatedAt?: string
): FirestoreGlobalPoiDoc {
  const safeCat: PoiCategory = isValidPoiCategory(poi.category) ? poi.category : 'user';
  const safeSub = normalizeSubcategoryForCategory(safeCat, poi.subcategory);
  const nowIso = new Date().toISOString();
  const createdAt = existingCreatedAt || poi.createdAt || poi.updatedAt || nowIso;
  const updatedAt = poi.updatedAt || nowIso;
  const nameHe = String(poi.nameHe || poi.name || 'נקודת עניין').trim().slice(0, 200) || 'נקודת עניין';
  const name = String(poi.name || nameHe).trim().slice(0, 200) || nameHe;
  const nameEn = String(poi.nameEn || nameHe).trim().slice(0, 200);

  return {
    id: toSafeFirestorePoiId(poi.id),
    name,
    nameHe,
    nameEn,
    category: safeCat,
    subcategory: safeSub.slice(0, 64),
    lon: Number(poi.lon),
    lat: Number(poi.lat),
    ele: typeof poi.ele === 'number' && Number.isFinite(poi.ele) ? poi.ele : null,
    waterStatus:
      typeof poi.waterStatus === 'string' && poi.waterStatus.trim()
        ? poi.waterStatus.trim().slice(0, 200)
        : null,
    difficulty4x4:
      typeof poi.difficulty4x4 === 'string' && poi.difficulty4x4.trim()
        ? poi.difficulty4x4.trim().slice(0, 200)
        : null,
    descHe: String(poi.descHe || '').slice(0, 4000),
    descEn: String(poi.descEn || poi.descHe || '').slice(0, 4000),
    source: String(poi.source || 'User Field Report (דיווח מטייל)').slice(0, 200),
    createdByUid: (existingCreatedByUid || poi.createdByUid || actorUid).slice(0, 128),
    createdAt: String(createdAt).slice(0, 64),
    updatedByUid: actorUid.slice(0, 128),
    updatedAt: String(updatedAt).slice(0, 64),
  };
}

export function fromFirestoreGlobalPoi(id: string, data: DocumentData): PoiRecord | null {
  if (!data || typeof data !== 'object') return null;
  const lon = Number(data.lon);
  const lat = Number(data.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const category: PoiCategory = isValidPoiCategory(data.category) ? data.category : 'user';
  const subcategory = normalizeSubcategoryForCategory(
    category,
    typeof data.subcategory === 'string' ? data.subcategory : undefined
  );
  const nameHe = String(data.nameHe || data.name || 'נקודת עניין');
  const nameEn = String(data.nameEn || nameHe);

  return {
    id: String(data.id || id),
    name: String(data.name || nameHe),
    nameHe,
    nameEn,
    category,
    subcategory,
    lon,
    lat,
    ele: typeof data.ele === 'number' && Number.isFinite(data.ele) ? data.ele : null,
    waterStatus: typeof data.waterStatus === 'string' ? data.waterStatus : null,
    difficulty4x4: typeof data.difficulty4x4 === 'string' ? data.difficulty4x4 : null,
    descHe: typeof data.descHe === 'string' ? data.descHe : '',
    descEn: typeof data.descEn === 'string' ? data.descEn : '',
    source:
      typeof data.source === 'string' && data.source.trim()
        ? data.source
        : 'User Field Report (דיווח מטייל)',
    wikipedia: null,
    userNotes: '',
    createdByUid: typeof data.createdByUid === 'string' ? data.createdByUid : undefined,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
    updatedByUid: typeof data.updatedByUid === 'string' ? data.updatedByUid : undefined,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  };
}

export function toFirestorePoiOverride(
  override: PoiOverrideRecord,
  actorUid: string
): FirestorePoiOverrideDoc {
  const hasCat = isValidPoiCategory(override.category);
  const category = hasCat ? override.category! : null;
  const subcategory = hasCat
    ? normalizeSubcategoryForCategory(override.category!, override.subcategory)
    : null;

  return {
    id: toSafeFirestorePoiId(override.id),
    deleted: Boolean(override.deleted),
    category,
    subcategory,
    updatedByUid: (override.updatedByUid || actorUid).slice(0, 128),
    updatedAt: String(override.updatedAt || new Date().toISOString()).slice(0, 64),
  };
}

export function fromFirestorePoiOverride(
  id: string,
  data: DocumentData
): PoiOverrideRecord | null {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.updatedAt !== 'string' || !data.updatedAt.trim()) return null;
  const deleted = Boolean(data.deleted);
  const hasCat = isValidPoiCategory(data.category);
  return {
    id: String(data.id || id),
    deleted,
    category: hasCat ? data.category : null,
    subcategory: hasCat
      ? normalizeSubcategoryForCategory(
          data.category,
          typeof data.subcategory === 'string' ? data.subcategory : undefined
        )
      : null,
    updatedByUid: typeof data.updatedByUid === 'string' ? data.updatedByUid : undefined,
    updatedAt: data.updatedAt,
  };
}

function enqueuePendingPoi(op: PendingGlobalPoiOp): void {
  const list = readLocalJson<PendingGlobalPoiOp[]>(PENDING_GLOBAL_POIS_KEY, []).filter(
    (x) => x?.poi?.id !== op.poi.id
  );
  list.push(op);
  writeLocalJson(PENDING_GLOBAL_POIS_KEY, list);
}

function enqueuePendingOverride(op: PendingGlobalOverrideOp): void {
  const list = readLocalJson<PendingGlobalOverrideOp[]>(PENDING_GLOBAL_POI_OVERRIDES_KEY, []).filter(
    (x) => x?.override?.id !== op.override.id
  );
  list.push(op);
  writeLocalJson(PENDING_GLOBAL_POI_OVERRIDES_KEY, list);
}

function enqueuePendingDelete(op: PendingGlobalDeleteOp): void {
  const pois = readLocalJson<PendingGlobalPoiOp[]>(PENDING_GLOBAL_POIS_KEY, []).filter(
    (x) => x?.poi?.id !== op.poiId
  );
  writeLocalJson(PENDING_GLOBAL_POIS_KEY, pois);

  const overrides = readLocalJson<PendingGlobalOverrideOp[]>(
    PENDING_GLOBAL_POI_OVERRIDES_KEY,
    []
  ).filter((x) => x?.override?.id !== op.poiId);
  writeLocalJson(PENDING_GLOBAL_POI_OVERRIDES_KEY, overrides);

  const deletes = readLocalJson<PendingGlobalDeleteOp[]>(PENDING_GLOBAL_POI_DELETES_KEY, []).filter(
    (x) => x?.poiId !== op.poiId
  );
  deletes.push(op);
  writeLocalJson(PENDING_GLOBAL_POI_DELETES_KEY, deletes);
}

function removePendingDelete(poiId: string): void {
  const deletes = readLocalJson<PendingGlobalDeleteOp[]>(PENDING_GLOBAL_POI_DELETES_KEY, []).filter(
    (x) => x?.poiId !== poiId
  );
  writeLocalJson(PENDING_GLOBAL_POI_DELETES_KEY, deletes);
}

function getPendingIdsForReconcile(): {
  pendingPoiIds: Set<string>;
  pendingOverrideIds: Set<string>;
  pendingDeleteIds: Set<string>;
} {
  const pois = readLocalJson<PendingGlobalPoiOp[]>(PENDING_GLOBAL_POIS_KEY, []);
  const overrides = readLocalJson<PendingGlobalOverrideOp[]>(PENDING_GLOBAL_POI_OVERRIDES_KEY, []);
  const deletes = readLocalJson<PendingGlobalDeleteOp[]>(PENDING_GLOBAL_POI_DELETES_KEY, []);
  return {
    pendingPoiIds: new Set(pois.map((x) => x?.poi?.id).filter((id): id is string => Boolean(id))),
    pendingOverrideIds: new Set(
      overrides.map((x) => x?.override?.id).filter((id): id is string => Boolean(id))
    ),
    pendingDeleteIds: new Set(deletes.map((x) => x?.poiId).filter((id): id is string => Boolean(id))),
  };
}

let legacyBackupAttempted = false;

async function captureLegacyPoiBackupBeforeReconcile(): Promise<void> {
  if (legacyBackupAttempted) return;
  legacyBackupAttempted = true;
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (window.localStorage.getItem(OHAD_MIGRATION_DONE_KEY) === '1') return;
  if (window.localStorage.getItem(LEGACY_POI_BACKUP_KEY)) return;

  try {
    const [localOverrides, localPois] = await Promise.all([
      db.poiOverrides.toArray(),
      db.pois.toArray(),
    ]);
    const stateOverrides = UserStateSyncService.loadLocalState().poiOverrides ?? [];
    const mergedOverrides = sanitizePoiOverrides([...localOverrides, ...stateOverrides]);
    const legacyUserPois = localPois.filter((p) => p.id.startsWith('user-poi-') && !p.createdByUid);

    if (mergedOverrides.length > 0 || legacyUserPois.length > 0) {
      const payload: LegacyPoiBackupPayload = {
        overrides: mergedOverrides,
        userPois: legacyUserPois,
        capturedAt: new Date().toISOString(),
      };
      writeLocalJson(LEGACY_POI_BACKUP_KEY, payload);
    }
  } catch {
    // Ignore IndexedDB unavailability in SSR/tests
  }
}

export class GlobalPoiCloudService {
  static async publishUserPoi(
    poi: PoiRecord,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!canUserAddOrEditPoi(user)) {
      throw new Error('נדרשת התחברות עם Google כדי להוסיף נקודת עניין למפה הגלובלית.');
    }
    if (poi.visibility === 'private') {
      throw new Error('לא ניתן לפרסם נקודה פרטית לאוסף הגלובלי ישירות. יש להפוך אותה לגלובלית קודם.');
    }
    const actor = user!;
    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) {
      enqueuePendingPoi({ poi, actorUid: actor.uid, queuedAt: new Date().toISOString() });
      return { synced: false, queuedOffline: true };
    }

    const safeId = toSafeFirestorePoiId(poi.id);
    const payload = toFirestoreGlobalPoi(poi, actor.uid);
    try {
      await setDoc(doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId), payload);
      const remaining = readLocalJson<PendingGlobalPoiOp[]>(PENDING_GLOBAL_POIS_KEY, []).filter(
        (x) => x?.poi?.id !== poi.id
      );
      writeLocalJson(PENDING_GLOBAL_POIS_KEY, remaining);
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('אין הרשאה להוסיף נקודת עניין גלובלית.');
      }
      enqueuePendingPoi({ poi, actorUid: actor.uid, queuedAt: new Date().toISOString() });
      return { synced: false, queuedOffline: true };
    }
  }

  static async publishCategoryOverride(
    poi: PoiRecord,
    updatedPoi: PoiRecord,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!canUserAddOrEditPoi(user)) {
      throw new Error('נדרשת התחברות עם Google כדי לשנות קטגוריה במפה הגלובלית.');
    }
    const actor = user!;
    const updatedAt = updatedPoi.updatedAt || new Date().toISOString();
    const isUserPoi = poi.id.startsWith('user-poi-');
    const override: PoiOverrideRecord = {
      id: poi.id,
      deleted: false,
      category: updatedPoi.category,
      subcategory: updatedPoi.subcategory,
      updatedByUid: actor.uid,
      updatedAt,
    };

    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) {
      enqueuePendingOverride({
        override,
        actorUid: actor.uid,
        ...(isUserPoi ? { userPoiUpdate: updatedPoi } : {}),
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }

    const safeId = toSafeFirestorePoiId(poi.id);
    try {
      if (isUserPoi) {
        const docPayload = toFirestoreGlobalPoi(
          updatedPoi,
          actor.uid,
          poi.createdByUid,
          poi.createdAt
        );
        await setDoc(doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId), docPayload);
      } else {
        const docPayload = toFirestorePoiOverride(override, actor.uid);
        await setDoc(doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId), docPayload);
      }
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('אין הרשאה לעדכן את קטגוריית הנקודה.');
      }
      enqueuePendingOverride({
        override,
        actorUid: actor.uid,
        ...(isUserPoi ? { userPoiUpdate: updatedPoi } : {}),
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }
  }

  static async publishCategoryReset(
    poiId: string,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!canUserAddOrEditPoi(user)) {
      throw new Error('נדרשת התחברות עם Google כדי לאפס קטגוריה במפה הגלובלית.');
    }
    if (poiId.startsWith('user-poi-') || poiId.startsWith('import-')) {
      return { synced: true, queuedOffline: false };
    }
    const actor = user!;
    const override: PoiOverrideRecord = {
      id: poiId,
      deleted: false,
      category: null,
      subcategory: null,
      updatedByUid: actor.uid,
      updatedAt: new Date().toISOString(),
    };

    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) {
      enqueuePendingOverride({
        override,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }

    try {
      const safeId = toSafeFirestorePoiId(poiId);
      const docPayload = toFirestorePoiOverride(override, actor.uid);
      await setDoc(doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId), docPayload);
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('אין הרשאה לאפס את קטגוריית הנקודה.');
      }
      enqueuePendingOverride({
        override,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }
  }

  static async deleteGlobalPoi(
    poi: PoiRecord,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!canUserDeletePoi(user)) {
      throw new Error('מחיקת נקודות עניין מותרת למשתמשים מורשים בלבד.');
    }
    if (poi.id.startsWith('import-')) {
      return { synced: true, queuedOffline: false };
    }
    const actor = user!;
    const isUserPoi = poi.id.startsWith('user-poi-');
    const services = getFirebaseServices();

    if (!services || !isOnlineNow()) {
      enqueuePendingDelete({
        poiId: poi.id,
        isUserPoi,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }

    try {
      const safeId = toSafeFirestorePoiId(poi.id);
      if (isUserPoi) {
        await deleteDoc(doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId));
        await deleteDoc(doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId)).catch(
          () => undefined
        );
      } else {
        const payload = toFirestorePoiOverride(
          {
            id: safeId,
            deleted: true,
            category: null,
            subcategory: null,
            updatedByUid: actor.uid,
            updatedAt: new Date().toISOString(),
          },
          actor.uid
        );
        await setDoc(doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId), payload);
      }
      removePendingDelete(poi.id);
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('המחיקה נדחתה בשרת: אין לך הרשאת מחיקת נקודות עניין.');
      }
      enqueuePendingDelete({
        poiId: poi.id,
        isUserPoi,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }
  }

  static async restoreDeletedGlobalPoi(
    snapshot: DeletedPoiUndoSnapshot,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!canUserDeletePoi(user)) {
      throw new Error('שחזור נקודות מחוקות מותר למשתמשים מורשים בלבד.');
    }
    const actor = user!;
    const { poi, previousOverride } = snapshot;
    if (poi.id.startsWith('import-')) {
      return { synced: true, queuedOffline: false };
    }

    removePendingDelete(poi.id);
    if (poi.id.startsWith('user-poi-')) {
      return this.publishUserPoi(poi, actor);
    }

    const override: PoiOverrideRecord = previousOverride
      ? {
          ...previousOverride,
          deleted: false,
          updatedByUid: actor.uid,
          updatedAt: new Date().toISOString(),
        }
      : {
          id: poi.id,
          deleted: false,
          category: null,
          subcategory: null,
          updatedByUid: actor.uid,
          updatedAt: new Date().toISOString(),
        };

    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) {
      enqueuePendingOverride({
        override,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }

    try {
      await setDoc(
        doc(services.firestore, POI_OVERRIDES_COLLECTION, toSafeFirestorePoiId(poi.id)),
        toFirestorePoiOverride(override, actor.uid)
      );
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('אין הרשאה לשחזר נקודת עניין מחוקה.');
      }
      enqueuePendingOverride({
        override,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }
  }

  static async flushPendingOperations(user: NavUser | null | undefined): Promise<number> {
    if (!canUserAddOrEditPoi(user) || !isOnlineNow()) return 0;
    const actor = user!;
    const services = getFirebaseServices();
    if (!services) return 0;

    let flushed = 0;

    const pendingPois = readLocalJson<PendingGlobalPoiOp[]>(PENDING_GLOBAL_POIS_KEY, []);
    const remainingPois: PendingGlobalPoiOp[] = [];
    for (const op of pendingPois) {
      if (!op?.poi?.id) continue;
      if (op.actorUid !== actor.uid) {
        remainingPois.push(op);
        continue;
      }
      try {
        const safeId = toSafeFirestorePoiId(op.poi.id);
        await setDoc(
          doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId),
          toFirestoreGlobalPoi(op.poi, actor.uid)
        );
        flushed++;
      } catch (err) {
        if (!isPermissionDeniedError(err)) {
          remainingPois.push(op);
        }
      }
    }
    writeLocalJson(PENDING_GLOBAL_POIS_KEY, remainingPois);

    const pendingOverrides = readLocalJson<PendingGlobalOverrideOp[]>(
      PENDING_GLOBAL_POI_OVERRIDES_KEY,
      []
    );
    const remainingOverrides: PendingGlobalOverrideOp[] = [];
    for (const op of pendingOverrides) {
      if (!op?.override?.id) continue;
      if (op.actorUid !== actor.uid) {
        remainingOverrides.push(op);
        continue;
      }
      if (op.override.deleted && !canUserDeletePoi(actor)) {
        continue;
      }
      try {
        const safeId = toSafeFirestorePoiId(op.override.id);
        if (op.userPoiUpdate && op.override.id.startsWith('user-poi-')) {
          await setDoc(
            doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId),
            toFirestoreGlobalPoi(
              op.userPoiUpdate,
              actor.uid,
              op.userPoiUpdate.createdByUid,
              op.userPoiUpdate.createdAt
            )
          );
        } else {
          await setDoc(
            doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId),
            toFirestorePoiOverride(op.override, actor.uid)
          );
        }
        flushed++;
      } catch (err) {
        if (!isPermissionDeniedError(err)) {
          remainingOverrides.push(op);
        }
      }
    }
    writeLocalJson(PENDING_GLOBAL_POI_OVERRIDES_KEY, remainingOverrides);

    const pendingDeletes = readLocalJson<PendingGlobalDeleteOp[]>(PENDING_GLOBAL_POI_DELETES_KEY, []);
    const remainingDeletes: PendingGlobalDeleteOp[] = [];
    for (const op of pendingDeletes) {
      if (!op?.poiId) continue;
      if (op.actorUid !== actor.uid) {
        remainingDeletes.push(op);
        continue;
      }
      if (!canUserDeletePoi(actor)) {
        continue;
      }
      try {
        const safeId = toSafeFirestorePoiId(op.poiId);
        if (op.isUserPoi) {
          await deleteDoc(doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId));
          await deleteDoc(doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId)).catch(
            () => undefined
          );
        } else {
          await setDoc(
            doc(services.firestore, POI_OVERRIDES_COLLECTION, safeId),
            toFirestorePoiOverride(
              {
                id: safeId,
                deleted: true,
                category: null,
                subcategory: null,
                updatedByUid: actor.uid,
                updatedAt: op.queuedAt || new Date().toISOString(),
              },
              actor.uid
            )
          );
        }
        flushed++;
      } catch (err) {
        if (!isPermissionDeniedError(err)) {
          remainingDeletes.push(op);
        }
      }
    }
    writeLocalJson(PENDING_GLOBAL_POI_DELETES_KEY, remainingDeletes);

    return flushed;
  }

  /**
   * Migrates any legacy per-user POI overrides (from `planing_tracks/{uid}/settings/app_state`,
   * `localStorage`, or IndexedDB) and pre-cloud local `user-poi-*` records owned by
   * `ohad.manor@gmail.com` into the global `poi_overrides` / `global_pois` collections.
   */
  static async migrateLegacyOhadPoiData(
    user: NavUser | null | undefined
  ): Promise<{ migratedOverrides: number; migratedPois: number }> {
    if (!isLegacyPoiMigrationSourceUser(user) || !isOnlineNow()) {
      return { migratedOverrides: 0, migratedPois: 0 };
    }
    const actor = user!;
    const services = getFirebaseServices();
    if (!services) return { migratedOverrides: 0, migratedPois: 0 };

    const settingsRef = doc(
      services.firestore,
      USER_SETTINGS_COLLECTION,
      actor.uid,
      USER_SETTINGS_SUBCOLLECTION,
      USER_SETTINGS_DOC_ID
    );

    const localAlreadyMigrated =
      typeof window !== 'undefined' &&
      window.localStorage?.getItem(OHAD_MIGRATION_DONE_KEY) === '1';

    let cloudOverrides: PoiOverrideRecord[] = [];
    let hasCloudAppStateOverrides = false;
    try {
      const settingsSnap = await getDoc(settingsRef);
      if (settingsSnap.exists()) {
        const data = settingsSnap.data();
        if (!data?.poiOverridesMigratedAt && Array.isArray(data?.poiOverrides)) {
          cloudOverrides = sanitizePoiOverrides(data.poiOverrides);
          hasCloudAppStateOverrides = cloudOverrides.length > 0;
        }
      }
    } catch (err) {
      console.warn('[GlobalPoiCloudService] Failed reading legacy Ohad settings:', err);
    }

    let localOverrides: PoiOverrideRecord[] = [];
    let localUserPois: PoiRecord[] = [];
    if (!localAlreadyMigrated) {
      const backup = readLocalJson<LegacyPoiBackupPayload | null>(LEGACY_POI_BACKUP_KEY, null);
      const [dbOverrides, dbPois] = await Promise.all([
        db.poiOverrides.toArray(),
        db.pois.toArray(),
      ]);
      const stateOverrides = UserStateSyncService.loadLocalState().poiOverrides ?? [];
      localOverrides = sanitizePoiOverrides([
        ...(backup?.overrides ?? []),
        ...stateOverrides,
        ...dbOverrides,
      ]);

      const userPoiById = new Map<string, PoiRecord>();
      for (const p of [...(backup?.userPois ?? []), ...dbPois]) {
        if (p?.id?.startsWith('user-poi-') && !p.createdByUid) {
          userPoiById.set(p.id, p);
        }
      }
      localUserPois = Array.from(userPoiById.values());
    }

    const candidateOverrides = sanitizePoiOverrides([...cloudOverrides, ...localOverrides]);
    if (candidateOverrides.length === 0 && localUserPois.length === 0) {
      if (hasCloudAppStateOverrides) {
        await setDoc(
          settingsRef,
          {
            poiOverridesMigratedAt: new Date().toISOString(),
            poiOverrides: deleteField(),
            poiOverridesUpdatedAt: deleteField(),
          },
          { merge: true }
        ).catch(() => undefined);
      }
      removeLocalKey(LEGACY_POI_BACKUP_KEY);
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(OHAD_MIGRATION_DONE_KEY, '1');
      }
      return { migratedOverrides: 0, migratedPois: 0 };
    }

    const [remotePoiSnap, remoteOvSnap] = await Promise.all([
      getDocs(collection(services.firestore, GLOBAL_POIS_COLLECTION)),
      getDocs(collection(services.firestore, POI_OVERRIDES_COLLECTION)),
    ]);

    const existingRemoteOverrides = new Map<string, PoiOverrideRecord>();
    remoteOvSnap.forEach((docSnap) => {
      const parsed = fromFirestorePoiOverride(docSnap.id, docSnap.data());
      if (parsed) existingRemoteOverrides.set(parsed.id, parsed);
    });

    const existingRemotePoiIds = new Set<string>();
    remotePoiSnap.forEach((docSnap) => {
      existingRemotePoiIds.add(docSnap.id);
    });

    const overridesToWrite: PoiOverrideRecord[] = [];
    for (const ov of candidateOverrides) {
      const existing = existingRemoteOverrides.get(ov.id);
      if (!existing || ov.updatedAt > existing.updatedAt) {
        overridesToWrite.push(ov);
      }
    }

    const deletedIds = new Set(
      [...existingRemoteOverrides.values(), ...overridesToWrite]
        .filter((o) => o.deleted)
        .map((o) => o.id)
    );
    const poisToWrite = localUserPois.filter(
      (p) => !existingRemotePoiIds.has(p.id) && !deletedIds.has(p.id)
    );

    const writeOps: Array<{ col: string; id: string; data: Record<string, unknown> }> = [
      ...overridesToWrite.map((ov) => ({
        col: POI_OVERRIDES_COLLECTION,
        id: toSafeFirestorePoiId(ov.id),
        data: toFirestorePoiOverride(ov, actor.uid) as unknown as Record<string, unknown>,
      })),
      ...poisToWrite.map((p) => ({
        col: GLOBAL_POIS_COLLECTION,
        id: toSafeFirestorePoiId(p.id),
        data: toFirestoreGlobalPoi(p, actor.uid, actor.uid, p.createdAt || p.updatedAt) as unknown as Record<string, unknown>,
      })),
    ];

    for (let i = 0; i < writeOps.length; i += 400) {
      const batch = writeBatch(services.firestore);
      const chunk = writeOps.slice(i, i + 400);
      for (const item of chunk) {
        batch.set(doc(services.firestore, item.col, item.id), item.data);
      }
      await batch.commit();
    }

    if (hasCloudAppStateOverrides) {
      await setDoc(
        settingsRef,
        {
          poiOverridesMigratedAt: new Date().toISOString(),
          poiOverrides: deleteField(),
          poiOverridesUpdatedAt: deleteField(),
        },
        { merge: true }
      ).catch(() => undefined);
    }

    removeLocalKey(LEGACY_POI_BACKUP_KEY);
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(OHAD_MIGRATION_DONE_KEY, '1');
    }

    return {
      migratedOverrides: overridesToWrite.length,
      migratedPois: poisToWrite.length,
    };
  }

  static async fetchAndReconcileGlobalPois(): Promise<boolean> {
    if (!isOnlineNow()) return false;
    const services = getFirebaseServices();
    if (!services) return false;

    await captureLegacyPoiBackupBeforeReconcile();

    const [poiSnap, ovSnap] = await Promise.all([
      getDocs(collection(services.firestore, GLOBAL_POIS_COLLECTION)),
      getDocs(collection(services.firestore, POI_OVERRIDES_COLLECTION)),
    ]);

    const remotePois: PoiRecord[] = [];
    poiSnap.forEach((docSnap) => {
      const parsed = fromFirestoreGlobalPoi(docSnap.id, docSnap.data());
      if (parsed) remotePois.push(parsed);
    });

    const remoteOverrides: PoiOverrideRecord[] = [];
    ovSnap.forEach((docSnap) => {
      const parsed = fromFirestorePoiOverride(docSnap.id, docSnap.data());
      if (parsed) remoteOverrides.push(parsed);
    });

    const pending = getPendingIdsForReconcile();
    const res = await PoiManager.reconcileRemoteGlobalPoisAndOverrides(
      remotePois,
      remoteOverrides,
      pending
    );
    return res.poisChanged || res.overridesChanged;
  }

  static subscribeGlobalPois(onReconciled: (changed: boolean) => void): () => void {
    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) return () => {};

    let latestPois: PoiRecord[] | null = null;
    let latestOverrides: PoiOverrideRecord[] | null = null;
    let disposed = false;

    const tryReconcile = async () => {
      if (disposed || latestPois === null || latestOverrides === null) return;
      await captureLegacyPoiBackupBeforeReconcile();
      const pending = getPendingIdsForReconcile();
      const res = await PoiManager.reconcileRemoteGlobalPoisAndOverrides(
        latestPois,
        latestOverrides,
        pending
      );
      if (!disposed) {
        onReconciled(res.poisChanged || res.overridesChanged);
      }
    };

    const unsubPois = onSnapshot(
      collection(services.firestore, GLOBAL_POIS_COLLECTION),
      (snap) => {
        if (disposed) return;
        const parsed: PoiRecord[] = [];
        snap.forEach((docSnap) => {
          const item = fromFirestoreGlobalPoi(docSnap.id, docSnap.data());
          if (item) parsed.push(item);
        });
        latestPois = parsed;
        void tryReconcile();
      },
      (err) => {
        console.warn('[GlobalPoiCloudService] global_pois snapshot warning:', err);
      }
    );

    const unsubOverrides = onSnapshot(
      collection(services.firestore, POI_OVERRIDES_COLLECTION),
      (snap) => {
        if (disposed) return;
        const parsed: PoiOverrideRecord[] = [];
        snap.forEach((docSnap) => {
          const item = fromFirestorePoiOverride(docSnap.id, docSnap.data());
          if (item) parsed.push(item);
        });
        latestOverrides = parsed;
        void tryReconcile();
      },
      (err) => {
        console.warn('[GlobalPoiCloudService] poi_overrides snapshot warning:', err);
      }
    );

    return () => {
      disposed = true;
      unsubPois();
      unsubOverrides();
    };
  }
}
