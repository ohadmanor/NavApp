import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import {
  db,
  type PoiCategory,
  type PoiRecord,
  type PoiShareRecipient,
} from '../db/NavDatabase';
import type { DeletedPoiUndoSnapshot } from '../pois/PoiManager';
import { PoiManager } from '../pois/PoiManager';
import {
  canUserAddOrEditPoi,
  isOwnedPrivatePoi,
  normalizeUserEmail,
} from '../pois/poiPermissions';
import { isValidPoiCategory, normalizeSubcategoryForCategory } from '../pois/poiTaxonomy';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';
import {
  GLOBAL_POIS_COLLECTION,
  GlobalPoiCloudService,
  toFirestoreGlobalPoi,
  toSafeFirestorePoiId,
} from './GlobalPoiCloudService';

export const PRIVATE_POIS_COLLECTION = 'private_pois';

const PENDING_PRIVATE_POIS_KEY = 'navapp.pendingPrivatePois.v1';
const PENDING_PRIVATE_POI_DELETES_KEY = 'navapp.pendingPrivatePoiDeletes.v1';
const DISMISSED_SHARED_POIS_KEY = 'navapp.dismissedSharedPois.v1';

interface PendingPrivatePoiOp {
  poi: PoiRecord;
  actorUid: string;
  queuedAt: string;
}

interface PendingPrivateDeleteOp {
  poiId: string;
  actorUid: string;
  queuedAt: string;
}

export interface FirestorePrivatePoiDoc {
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
  visibility: 'private';
  ownerUid: string;
  ownerEmail: string | null;
  ownerDisplayName: string | null;
  sharedWith: PoiShareRecipient[];
  sharedWithUids: string[];
  sharedWithEmails: string[];
  createdByUid: string;
  createdAt: string;
  updatedByUid: string;
  updatedAt: string;
}

function isOnlineNow(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isPermissionDeniedError(err: unknown): boolean {
  const code = String((err as { code?: unknown })?.code || '').toLowerCase();
  const message = String((err as { message?: unknown })?.message || '').toLowerCase();
  return (
    code === 'permission-denied' ||
    message.includes('permission-denied') ||
    message.includes('missing or insufficient permissions')
  );
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

function enqueuePendingPrivatePoi(op: PendingPrivatePoiOp): void {
  const list = readLocalJson<PendingPrivatePoiOp[]>(PENDING_PRIVATE_POIS_KEY, []).filter(
    (x) => !(x?.poi?.id === op.poi.id && x?.actorUid === op.actorUid)
  );
  list.push(op);
  writeLocalJson(PENDING_PRIVATE_POIS_KEY, list);
}

function removePendingPrivatePoi(poiId: string, actorUid?: string): void {
  const list = readLocalJson<PendingPrivatePoiOp[]>(PENDING_PRIVATE_POIS_KEY, []).filter(
    (x) => !(x?.poi?.id === poiId && (!actorUid || x?.actorUid === actorUid))
  );
  writeLocalJson(PENDING_PRIVATE_POIS_KEY, list);
}

function enqueuePendingPrivateDelete(op: PendingPrivateDeleteOp): void {
  removePendingPrivatePoi(op.poiId, op.actorUid);
  const deletes = readLocalJson<PendingPrivateDeleteOp[]>(PENDING_PRIVATE_POI_DELETES_KEY, []).filter(
    (x) => !(x?.poiId === op.poiId && x?.actorUid === op.actorUid)
  );
  deletes.push(op);
  writeLocalJson(PENDING_PRIVATE_POI_DELETES_KEY, deletes);
}

function removePendingPrivateDelete(poiId: string, actorUid?: string): void {
  const deletes = readLocalJson<PendingPrivateDeleteOp[]>(PENDING_PRIVATE_POI_DELETES_KEY, []).filter(
    (x) => !(x?.poiId === poiId && (!actorUid || x?.actorUid === actorUid))
  );
  writeLocalJson(PENDING_PRIVATE_POI_DELETES_KEY, deletes);
}

export function getDismissedSharedPoiIds(uid: string): Set<string> {
  if (!uid) return new Set();
  const map = readLocalJson<Record<string, string[]>>(DISMISSED_SHARED_POIS_KEY, {});
  const list = Array.isArray(map[uid]) ? map[uid] : [];
  return new Set(list.filter((id): id is string => typeof id === 'string' && id.length > 0));
}

export function addDismissedSharedPoiId(uid: string, poiId: string): void {
  if (!uid || !poiId) return;
  const map = readLocalJson<Record<string, string[]>>(DISMISSED_SHARED_POIS_KEY, {});
  const next = new Set(Array.isArray(map[uid]) ? map[uid] : []);
  next.add(poiId);
  map[uid] = Array.from(next);
  writeLocalJson(DISMISSED_SHARED_POIS_KEY, map);
}

export function removeDismissedSharedPoiId(uid: string, poiId: string): void {
  if (!uid || !poiId) return;
  const map = readLocalJson<Record<string, string[]>>(DISMISSED_SHARED_POIS_KEY, {});
  if (!Array.isArray(map[uid])) return;
  map[uid] = map[uid].filter((id) => id !== poiId);
  writeLocalJson(DISMISSED_SHARED_POIS_KEY, map);
}

function getPendingIdsForUser(actorUid: string): {
  pendingPrivateIds: Set<string>;
  pendingDeleteIds: Set<string>;
} {
  const pois = readLocalJson<PendingPrivatePoiOp[]>(PENDING_PRIVATE_POIS_KEY, []);
  const deletes = readLocalJson<PendingPrivateDeleteOp[]>(PENDING_PRIVATE_POI_DELETES_KEY, []);
  return {
    pendingPrivateIds: new Set(
      pois.filter((x) => x?.actorUid === actorUid).map((x) => x.poi.id)
    ),
    pendingDeleteIds: new Set(
      deletes.filter((x) => x?.actorUid === actorUid).map((x) => x.poiId)
    ),
  };
}

export function normalizePoiShareRecipients(
  recipients: PoiShareRecipient[] | undefined | null
): {
  sharedWith: PoiShareRecipient[];
  sharedWithUids: string[];
  sharedWithEmails: string[];
} {
  const byKey = new Map<string, PoiShareRecipient>();
  const uidSet = new Set<string>();
  const emailSet = new Set<string>();

  for (const raw of recipients || []) {
    if (!raw) continue;
    const email = normalizeUserEmail(raw.email);
    const uid = typeof raw.uid === 'string' && raw.uid.trim() ? raw.uid.trim() : null;
    if (!email && !uid) continue;

    const key = uid ? `uid:${uid}` : `email:${email}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        uid,
        email,
        displayName: raw.displayName?.trim() || null,
        photoURL: raw.photoURL || null,
        sharedAt: raw.sharedAt || new Date().toISOString(),
      });
    }
    if (uid) uidSet.add(uid);
    if (email) emailSet.add(email);
  }

  return {
    sharedWith: Array.from(byKey.values()).slice(0, 50),
    sharedWithUids: Array.from(uidSet).slice(0, 50),
    sharedWithEmails: Array.from(emailSet).slice(0, 50),
  };
}

export function toFirestorePrivatePoi(
  poi: PoiRecord,
  actor: Pick<NavUser, 'uid' | 'email' | 'displayName'>
): FirestorePrivatePoiDoc {
  const safeCat: PoiCategory = isValidPoiCategory(poi.category) ? poi.category : 'user';
  const safeSub = normalizeSubcategoryForCategory(safeCat, poi.subcategory);
  const nowIso = new Date().toISOString();
  const createdAt = poi.createdAt || poi.updatedAt || nowIso;
  const updatedAt = poi.updatedAt || nowIso;
  const nameHe = String(poi.nameHe || poi.name || 'נקודת עניין').trim().slice(0, 200) || 'נקודת עניין';
  const name = String(poi.name || nameHe).trim().slice(0, 200) || nameHe;
  const nameEn = String(poi.nameEn || nameHe).trim().slice(0, 200);
  const ownerUid = (poi.ownerUid || poi.createdByUid || actor.uid).slice(0, 128);
  const normalizedShare = normalizePoiShareRecipients(poi.sharedWith);

  const rawOwnerEmail = poi.ownerEmail ?? actor.email ?? null;
  const ownerEmail =
    typeof rawOwnerEmail === 'string' && rawOwnerEmail.trim()
      ? rawOwnerEmail.trim().slice(0, 200)
      : null;
  const rawOwnerName = poi.ownerDisplayName ?? actor.displayName ?? null;
  const ownerDisplayName =
    typeof rawOwnerName === 'string' && rawOwnerName.trim()
      ? rawOwnerName.trim().slice(0, 200)
      : null;

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
    source: String(poi.source || 'נקודה פרטית (משתמש)').slice(0, 200),
    visibility: 'private',
    ownerUid,
    ownerEmail,
    ownerDisplayName,
    sharedWith: normalizedShare.sharedWith,
    sharedWithUids: normalizedShare.sharedWithUids,
    sharedWithEmails: normalizedShare.sharedWithEmails,
    createdByUid: (poi.createdByUid || ownerUid).slice(0, 128),
    createdAt: String(createdAt).slice(0, 64),
    updatedByUid: actor.uid.slice(0, 128),
    updatedAt: String(updatedAt).slice(0, 64),
  };
}

export function fromFirestorePrivatePoi(
  id: string,
  data: DocumentData,
  viewerUid?: string
): PoiRecord | null {
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
  const ownerUid =
    typeof data.ownerUid === 'string' && data.ownerUid.trim()
      ? data.ownerUid.trim()
      : typeof data.createdByUid === 'string'
        ? data.createdByUid.trim()
        : '';
  const ownerEmail = typeof data.ownerEmail === 'string' ? data.ownerEmail : null;
  const ownerDisplayName = typeof data.ownerDisplayName === 'string' ? data.ownerDisplayName : null;
  const isMine = Boolean(viewerUid && ownerUid && ownerUid === viewerUid);
  const sharedWith = Array.isArray(data.sharedWith)
    ? (data.sharedWith as PoiShareRecipient[])
    : [];
  const sharedWithUids = Array.isArray(data.sharedWithUids)
    ? (data.sharedWithUids as string[])
    : [];
  const sharedWithEmails = Array.isArray(data.sharedWithEmails)
    ? (data.sharedWithEmails as string[])
    : [];
  const senderLabel = ownerDisplayName || ownerEmail || null;

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
        : 'נקודה פרטית (משתמש)',
    wikipedia: null,
    userNotes: '',
    visibility: 'private',
    ownership: isMine ? 'mine' : 'shared',
    ownerUid: ownerUid || null,
    ownerEmail,
    ownerDisplayName,
    ...(isMine
      ? {
          sharedWith,
          sharedWithUids,
          sharedWithEmails,
        }
      : {
          sharedByUid: ownerUid || null,
          sharedByName: senderLabel,
          sharedByEmail: ownerEmail,
          sharedForUid: viewerUid || null,
        }),
    createdByUid: typeof data.createdByUid === 'string' ? data.createdByUid : ownerUid || undefined,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
    updatedByUid: typeof data.updatedByUid === 'string' ? data.updatedByUid : undefined,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
  };
}

export class PrivatePoiCloudService {
  static async publishPrivatePoi(
    poi: PoiRecord,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!canUserAddOrEditPoi(user)) {
      throw new Error('נדרשת התחברות עם Google כדי לשמור נקודת עניין פרטית.');
    }
    const actor = user!;
    const stamped: PoiRecord = {
      ...poi,
      visibility: 'private',
      ownership: 'mine',
      ownerUid: poi.ownerUid || poi.createdByUid || actor.uid,
      ownerEmail: poi.ownerEmail ?? actor.email ?? null,
      ownerDisplayName: poi.ownerDisplayName ?? actor.displayName ?? null,
      updatedByUid: actor.uid,
      updatedAt: poi.updatedAt || new Date().toISOString(),
    };

    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) {
      enqueuePendingPrivatePoi({
        poi: stamped,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }

    const safeId = toSafeFirestorePoiId(stamped.id);
    const payload = toFirestorePrivatePoi(stamped, actor);
    try {
      await setDoc(doc(services.firestore, PRIVATE_POIS_COLLECTION, safeId), payload);
      removePendingPrivatePoi(stamped.id, actor.uid);
      removePendingPrivateDelete(stamped.id, actor.uid);
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('אין הרשאה לשמור את נקודת העניין הפרטית.');
      }
      enqueuePendingPrivatePoi({
        poi: stamped,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }
  }

  static async updatePrivatePoiSharing(
    poi: PoiRecord,
    recipients: PoiShareRecipient[],
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean; poi: PoiRecord }> {
    if (!isOwnedPrivatePoi(poi, user)) {
      throw new Error('רק בעל הנקודה הפרטית יכול לשתף אותה.');
    }
    const actor = user!;
    const normalized = normalizePoiShareRecipients(recipients);
    const updatedPoi: PoiRecord = {
      ...poi,
      visibility: 'private',
      ownership: 'mine',
      ownerUid: poi.ownerUid || actor.uid,
      ownerEmail: poi.ownerEmail ?? actor.email ?? null,
      ownerDisplayName: poi.ownerDisplayName ?? actor.displayName ?? null,
      sharedWith: normalized.sharedWith,
      sharedWithUids: normalized.sharedWithUids,
      sharedWithEmails: normalized.sharedWithEmails,
      updatedByUid: actor.uid,
      updatedAt: new Date().toISOString(),
    };

    await db.pois.put(updatedPoi);
    const res = await this.publishPrivatePoi(updatedPoi, actor);
    return { ...res, poi: updatedPoi };
  }

  static async promotePrivatePoiToGlobal(
    poi: PoiRecord,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean; poi: PoiRecord }> {
    if (!isOwnedPrivatePoi(poi, user)) {
      throw new Error('רק בעל הנקודה הפרטית יכול להפוך אותה לגלובלית.');
    }
    const actor = user!;
    const nowIso = new Date().toISOString();
    const promotedPoi: PoiRecord = {
      ...poi,
      visibility: 'global',
      ownership: undefined,
      ownerUid: undefined,
      ownerEmail: undefined,
      ownerDisplayName: undefined,
      sharedByUid: undefined,
      sharedByName: undefined,
      sharedByEmail: undefined,
      sharedForUid: undefined,
      sharedWith: undefined,
      sharedWithUids: undefined,
      sharedWithEmails: undefined,
      source:
        poi.source === 'נקודה פרטית (משתמש)'
          ? 'User Field Report (דיווח מטייל)'
          : poi.source,
      createdByUid: poi.createdByUid || poi.ownerUid || actor.uid,
      updatedByUid: actor.uid,
      updatedAt: nowIso,
    };

    await db.pois.put(promotedPoi);
    removePendingPrivatePoi(poi.id, actor.uid);

    const services = getFirebaseServices();
    if (!services || !isOnlineNow()) {
      enqueuePendingPrivateDelete({
        poiId: poi.id,
        actorUid: actor.uid,
        queuedAt: nowIso,
      });
      const globalRes = await GlobalPoiCloudService.publishUserPoi(promotedPoi, actor);
      return { ...globalRes, poi: promotedPoi };
    }

    const safeId = toSafeFirestorePoiId(promotedPoi.id);
    const privateRef = doc(services.firestore, PRIVATE_POIS_COLLECTION, safeId);
    const globalRef = doc(services.firestore, GLOBAL_POIS_COLLECTION, safeId);
    const globalPayload = toFirestoreGlobalPoi(
      promotedPoi,
      actor.uid,
      promotedPoi.createdByUid,
      promotedPoi.createdAt
    );

    try {
      const privateSnap = await getDoc(privateRef).catch(() => null);
      if (privateSnap && privateSnap.exists()) {
        const batch = writeBatch(services.firestore);
        batch.set(globalRef, globalPayload);
        batch.delete(privateRef);
        await batch.commit();
      } else {
        await setDoc(globalRef, globalPayload);
      }
      removePendingPrivateDelete(poi.id, actor.uid);
      return { synced: true, queuedOffline: false, poi: promotedPoi };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        await db.pois.put(poi).catch(() => undefined);
        throw new Error('אין הרשאה להפוך נקודה זו לגלובלית.');
      }
      enqueuePendingPrivateDelete({
        poiId: poi.id,
        actorUid: actor.uid,
        queuedAt: nowIso,
      });
      const globalRes = await GlobalPoiCloudService.publishUserPoi(promotedPoi, actor);
      return { ...globalRes, poi: promotedPoi };
    }
  }

  static async deletePrivatePoi(
    poi: PoiRecord,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!isOwnedPrivatePoi(poi, user)) {
      throw new Error('רק בעל הנקודה הפרטית יכול למחוק אותה.');
    }
    const actor = user!;
    const services = getFirebaseServices();

    if (!services || !isOnlineNow()) {
      enqueuePendingPrivateDelete({
        poiId: poi.id,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }

    try {
      const safeId = toSafeFirestorePoiId(poi.id);
      await deleteDoc(doc(services.firestore, PRIVATE_POIS_COLLECTION, safeId));
      removePendingPrivateDelete(poi.id, actor.uid);
      return { synced: true, queuedOffline: false };
    } catch (err) {
      if (isPermissionDeniedError(err)) {
        throw new Error('המחיקה נדחתה בשרת: אין הרשאה למחוק נקודה פרטית זו.');
      }
      enqueuePendingPrivateDelete({
        poiId: poi.id,
        actorUid: actor.uid,
        queuedAt: new Date().toISOString(),
      });
      return { synced: false, queuedOffline: true };
    }
  }

  static async restoreDeletedPrivatePoi(
    snapshot: DeletedPoiUndoSnapshot,
    user: NavUser | null | undefined
  ): Promise<{ synced: boolean; queuedOffline: boolean }> {
    if (!isOwnedPrivatePoi(snapshot.poi, user)) {
      throw new Error('רק בעל הנקודה הפרטית יכול לשחזר אותה.');
    }
    const actor = user!;
    removePendingPrivateDelete(snapshot.poi.id, actor.uid);
    return this.publishPrivatePoi(snapshot.poi, actor);
  }

  static async dismissSharedPoi(poi: PoiRecord, user: NavUser | null | undefined): Promise<void> {
    if (!user?.uid || !poi?.id) return;
    addDismissedSharedPoiId(user.uid, poi.id);
    await db.pois.delete(poi.id);
  }

  static async flushPendingOperations(user: NavUser | null | undefined): Promise<number> {
    if (!canUserAddOrEditPoi(user) || !isOnlineNow()) return 0;
    const actor = user!;
    const services = getFirebaseServices();
    if (!services) return 0;

    let flushed = 0;

    const pendingPois = readLocalJson<PendingPrivatePoiOp[]>(PENDING_PRIVATE_POIS_KEY, []);
    const remainingPois: PendingPrivatePoiOp[] = [];
    for (const op of pendingPois) {
      if (!op?.poi?.id) continue;
      if (op.actorUid !== actor.uid) {
        remainingPois.push(op);
        continue;
      }
      try {
        const safeId = toSafeFirestorePoiId(op.poi.id);
        await setDoc(
          doc(services.firestore, PRIVATE_POIS_COLLECTION, safeId),
          toFirestorePrivatePoi(op.poi, actor)
        );
        flushed++;
      } catch (err) {
        if (!isPermissionDeniedError(err)) {
          remainingPois.push(op);
        }
      }
    }
    writeLocalJson(PENDING_PRIVATE_POIS_KEY, remainingPois);

    const pendingDeletes = readLocalJson<PendingPrivateDeleteOp[]>(
      PENDING_PRIVATE_POI_DELETES_KEY,
      []
    );
    const remainingDeletes: PendingPrivateDeleteOp[] = [];
    for (const op of pendingDeletes) {
      if (!op?.poiId) continue;
      if (op.actorUid !== actor.uid) {
        remainingDeletes.push(op);
        continue;
      }
      try {
        const safeId = toSafeFirestorePoiId(op.poiId);
        await deleteDoc(doc(services.firestore, PRIVATE_POIS_COLLECTION, safeId));
        flushed++;
      } catch (err) {
        if (!isPermissionDeniedError(err)) {
          remainingDeletes.push(op);
        }
      }
    }
    writeLocalJson(PENDING_PRIVATE_POI_DELETES_KEY, remainingDeletes);

    return flushed;
  }

  static async fetchPrivateAndSharedPois(user: NavUser | null | undefined): Promise<{
    changed: boolean;
    newlyArrivedShared: PoiRecord[];
    revokedSharedIds: string[];
  }> {
    if (!user?.uid || !isOnlineNow()) {
      return { changed: false, newlyArrivedShared: [], revokedSharedIds: [] };
    }
    const services = getFirebaseServices();
    if (!services) {
      return { changed: false, newlyArrivedShared: [], revokedSharedIds: [] };
    }

    const colRef = collection(services.firestore, PRIVATE_POIS_COLLECTION);
    const normalizedEmail = normalizeUserEmail(user.email);

    const ownPromise = getDocs(query(colRef, where('ownerUid', '==', user.uid)));
    const uidSharedPromise = getDocs(
      query(colRef, where('sharedWithUids', 'array-contains', user.uid))
    );
    const emailSharedPromise = normalizedEmail
      ? getDocs(query(colRef, where('sharedWithEmails', 'array-contains', normalizedEmail)))
      : null;

    const [ownRes, uidRes, emailRes] = await Promise.allSettled([
      ownPromise,
      uidSharedPromise,
      ...(emailSharedPromise ? [emailSharedPromise] : []),
    ]);

    const ownPrivatePois: PoiRecord[] = [];
    if (ownRes.status === 'fulfilled') {
      ownRes.value.forEach((docSnap) => {
        const parsed = fromFirestorePrivatePoi(docSnap.id, docSnap.data(), user.uid);
        if (parsed) ownPrivatePois.push(parsed);
      });
    }

    const sharedById = new Map<string, PoiRecord>();
    for (const res of [uidRes, emailRes]) {
      if (res && res.status === 'fulfilled') {
        res.value.forEach((docSnap) => {
          const parsed = fromFirestorePrivatePoi(docSnap.id, docSnap.data(), user.uid);
          if (parsed && (parsed.ownerUid || parsed.createdByUid) !== user.uid) {
            sharedById.set(parsed.id, parsed);
          }
        });
      }
    }

    const allowRevokeOwn = ownRes.status === 'fulfilled';
    const allowRevokeShared =
      uidRes.status === 'fulfilled' && (!emailSharedPromise || emailRes?.status === 'fulfilled');

    const pending = getPendingIdsForUser(user.uid);
    const dismissedSharedIds = getDismissedSharedPoiIds(user.uid);

    return PoiManager.reconcilePrivateAndSharedPois({
      ownPrivatePois,
      sharedWithMePois: Array.from(sharedById.values()),
      activeUid: user.uid,
      pendingPrivateIds: pending.pendingPrivateIds,
      pendingDeleteIds: pending.pendingDeleteIds,
      dismissedSharedIds,
      allowRevokeOwn,
      allowRevokeShared,
    });
  }

  static subscribePrivateAndSharedPois(
    user: NavUser | null | undefined,
    onReconciled: (event: {
      changed: boolean;
      newlyArrivedShared: PoiRecord[];
      revokedSharedIds: string[];
      isInitial: boolean;
    }) => void
  ): () => void {
    const services = getFirebaseServices();
    if (!services || !user?.uid || !isOnlineNow() || typeof onSnapshot !== 'function') {
      return () => undefined;
    }

    const colRef = collection(services.firestore, PRIVATE_POIS_COLLECTION);
    const normalizedEmail = normalizeUserEmail(user.email);

    let ownLoaded = false;
    let uidLoaded = false;
    let emailLoaded = !normalizedEmail;
    let ownHealthy = false;
    let uidHealthy = false;
    let emailHealthy = !normalizedEmail;
    let hasEmittedInitial = false;
    let disposed = false;
    let reconcileSeq = 0;

    const ownMap = new Map<string, PoiRecord>();
    const uidSharedMap = new Map<string, PoiRecord>();
    const emailSharedMap = new Map<string, PoiRecord>();

    const flush = () => {
      if (disposed) return;
      const seq = ++reconcileSeq;
      const isInitial = !hasEmittedInitial;
      if (ownLoaded && uidLoaded && emailLoaded) {
        hasEmittedInitial = true;
      }

      const sharedMerged = Array.from(
        new Map<string, PoiRecord>([...uidSharedMap, ...emailSharedMap]).values()
      );
      const pending = getPendingIdsForUser(user.uid);
      const dismissedSharedIds = getDismissedSharedPoiIds(user.uid);

      void PoiManager.reconcilePrivateAndSharedPois({
        ownPrivatePois: Array.from(ownMap.values()),
        sharedWithMePois: sharedMerged,
        activeUid: user.uid,
        pendingPrivateIds: pending.pendingPrivateIds,
        pendingDeleteIds: pending.pendingDeleteIds,
        dismissedSharedIds,
        allowRevokeOwn: ownLoaded && ownHealthy,
        allowRevokeShared: uidLoaded && emailLoaded && uidHealthy && emailHealthy,
      }).then((res) => {
        if (disposed || seq !== reconcileSeq) return;
        onReconciled({
          ...res,
          isInitial,
        });
      });
    };

    const unsubOwn = onSnapshot(
      query(colRef, where('ownerUid', '==', user.uid)),
      (snap) => {
        if (disposed) return;
        ownMap.clear();
        snap.forEach((docSnap) => {
          const parsed = fromFirestorePrivatePoi(docSnap.id, docSnap.data(), user.uid);
          if (parsed) ownMap.set(parsed.id, parsed);
        });
        ownLoaded = true;
        ownHealthy = true;
        flush();
      },
      (err) => {
        if (disposed) return;
        console.warn('[PrivatePoiCloudService] own private_pois snapshot warning:', err);
        ownLoaded = true;
        ownHealthy = false;
      }
    );

    const unsubUidShared = onSnapshot(
      query(colRef, where('sharedWithUids', 'array-contains', user.uid)),
      (snap) => {
        if (disposed) return;
        uidSharedMap.clear();
        snap.forEach((docSnap) => {
          const parsed = fromFirestorePrivatePoi(docSnap.id, docSnap.data(), user.uid);
          if (parsed && (parsed.ownerUid || parsed.createdByUid) !== user.uid) {
            uidSharedMap.set(parsed.id, parsed);
          }
        });
        uidLoaded = true;
        uidHealthy = true;
        flush();
      },
      (err) => {
        if (disposed) return;
        console.warn('[PrivatePoiCloudService] sharedWithUids private_pois warning:', err);
        uidLoaded = true;
        uidHealthy = false;
      }
    );

    let unsubEmailShared: () => void = () => undefined;
    if (normalizedEmail) {
      unsubEmailShared = onSnapshot(
        query(colRef, where('sharedWithEmails', 'array-contains', normalizedEmail)),
        (snap) => {
          if (disposed) return;
          emailSharedMap.clear();
          snap.forEach((docSnap) => {
            const parsed = fromFirestorePrivatePoi(docSnap.id, docSnap.data(), user.uid);
            if (parsed && (parsed.ownerUid || parsed.createdByUid) !== user.uid) {
              emailSharedMap.set(parsed.id, parsed);
            }
          });
          emailLoaded = true;
          emailHealthy = true;
          flush();
        },
        (err) => {
          if (disposed) return;
          console.warn('[PrivatePoiCloudService] sharedWithEmails private_pois warning:', err);
          emailLoaded = true;
          emailHealthy = false;
        }
      );
    }

    return () => {
      disposed = true;
      reconcileSeq++;
      unsubOwn();
      unsubUidShared();
      unsubEmailShared();
    };
  }
}
