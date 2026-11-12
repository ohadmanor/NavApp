import {
  deleteObject,
  getDownloadURL,
  listAll,
  ref,
  uploadString,
} from 'firebase/storage';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
} from 'firebase/firestore';
import {
  type RouteOwnership,
  type RouteShareRecipient,
  type SavedRouteRecord,
} from '../db/NavDatabase';
import {
  LEGACY_PLANNED_COLORS,
  RouteManager,
  computeRouteBounds,
} from '../navigation/RouteManager';
import { PLANNING_ROUTE_COLOR } from '../routing/RoutingProfiles';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

export const FIREBASE_PLANNING_FOLDER = 'planing_tracks';
export const DELETED_PLANNED_ROUTES_STORAGE_KEY = 'navapp.deletedPlannedRoutes.v1';
export const DISMISSED_SHARED_ROUTES_STORAGE_KEY = 'navapp.dismissedSharedRoutes.v1';
export const PLANNED_SYNC_WATERMARK_KEY_PREFIX = 'navapp.plannedSyncWatermark.v1.';

const STORAGE_UPLOAD_TIMEOUT_MS = 3500;
const PENDING_UPLOAD_CONCURRENCY = 3;
let storageUnavailableForSession = false;
const sharedReconcileQueues = new Map<string, Promise<unknown>>();

export function resetPlannedCloudSessionStateForTesting(): void {
  storageUnavailableForSession = false;
  sharedReconcileQueues.clear();
}

function enqueueSharedReconcile<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  const prev = sharedReconcileQueues.get(uid) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  sharedReconcileQueues.set(uid, next);
  return next.finally(() => {
    if (sharedReconcileQueues.get(uid) === next) {
      sharedReconcileQueues.delete(uid);
    }
  });
}

export function getPlannedSyncWatermark(uid: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage || !uid) return null;
  try {
    const val = window.localStorage.getItem(`${PLANNED_SYNC_WATERMARK_KEY_PREFIX}${uid}`);
    return val && val.trim() ? val : null;
  } catch {
    return null;
  }
}

export function setPlannedSyncWatermark(uid: string, updatedAtIso: string): void {
  if (typeof window === 'undefined' || !window.localStorage || !uid || !updatedAtIso) return;
  try {
    window.localStorage.setItem(`${PLANNED_SYNC_WATERMARK_KEY_PREFIX}${uid}`, updatedAtIso);
  } catch {
    // Ignore storage errors
  }
}

export function clearPlannedSyncWatermark(uid: string): void {
  if (typeof window === 'undefined' || !window.localStorage || !uid) return;
  try {
    window.localStorage.removeItem(`${PLANNED_SYNC_WATERMARK_KEY_PREFIX}${uid}`);
  } catch {
    // Ignore storage errors
  }
}

export function getDeletedPlannedRouteIds(): Set<string> {
  if (typeof window === 'undefined' || !window.localStorage) return new Set();
  try {
    const raw = window.localStorage.getItem(DELETED_PLANNED_ROUTES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function markPlannedRouteDeleted(routeId: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const set = getDeletedPlannedRouteIds();
    set.add(routeId);
    window.localStorage.setItem(
      DELETED_PLANNED_ROUTES_STORAGE_KEY,
      JSON.stringify(Array.from(set).slice(-250))
    );
  } catch {
    // Ignore storage quota / restricted context errors
  }
}

export function clearPlannedRouteDeleted(routeId: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const set = getDeletedPlannedRouteIds();
    if (!set.delete(routeId)) return;
    window.localStorage.setItem(
      DELETED_PLANNED_ROUTES_STORAGE_KEY,
      JSON.stringify(Array.from(set))
    );
  } catch {
    // Ignore storage errors
  }
}

export function getDismissedSharedRouteIds(): Set<string> {
  if (typeof window === 'undefined' || !window.localStorage) return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_SHARED_ROUTES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function markSharedRouteDismissed(routeId: string): void {
  if (typeof window === 'undefined' || !window.localStorage || !routeId) return;
  try {
    const set = getDismissedSharedRouteIds();
    set.add(routeId);
    window.localStorage.setItem(
      DISMISSED_SHARED_ROUTES_STORAGE_KEY,
      JSON.stringify(Array.from(set).slice(-300))
    );
  } catch {
    // Ignore storage errors
  }
}

export function clearSharedRouteDismissed(routeId: string): void {
  if (typeof window === 'undefined' || !window.localStorage || !routeId) return;
  try {
    const set = getDismissedSharedRouteIds();
    if (!set.delete(routeId)) return;
    window.localStorage.setItem(
      DISMISSED_SHARED_ROUTES_STORAGE_KEY,
      JSON.stringify(Array.from(set))
    );
  } catch {
    // Ignore storage errors
  }
}

export function normalizeShareRecipients(recipients?: RouteShareRecipient[]): {
  sharedWith: RouteShareRecipient[];
  sharedWithUids: string[];
  sharedWithEmails: string[];
} {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { sharedWith: [], sharedWithUids: [], sharedWithEmails: [] };
  }

  const deduped = new Map<string, RouteShareRecipient>();
  for (const item of recipients) {
    if (!item) continue;
    const emailLower = typeof item.email === 'string' ? item.email.trim().toLowerCase() : '';
    const uid = typeof item.uid === 'string' && item.uid.trim() ? item.uid.trim() : null;
    if (!uid && !emailLower) continue;

    const key = uid ? `uid:${uid}` : `email:${emailLower}`;
    const prev = deduped.get(key);
    deduped.set(key, {
      uid: uid ?? prev?.uid ?? null,
      email: emailLower || prev?.email || '',
      displayName: item.displayName ?? prev?.displayName ?? null,
      sharedAt: item.sharedAt || prev?.sharedAt || new Date().toISOString(),
    });
  }

  const sharedWith = Array.from(deduped.values());
  const sharedWithUids = Array.from(
    new Set(sharedWith.map((r) => r.uid).filter((u): u is string => Boolean(u)))
  );
  const sharedWithEmails = Array.from(
    new Set(
      sharedWith
        .map((r) => (r.email || '').trim().toLowerCase())
        .filter((e): e is string => Boolean(e))
    )
  );

  return { sharedWith, sharedWithUids, sharedWithEmails };
}

export function buildSharedLocalRouteId(ownerUid: string, remoteRouteId: string): string {
  const safeOwner = (ownerUid || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeRemote = (remoteRouteId || 'route').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `shared_${safeOwner}_${safeRemote}`;
}

export interface PlannedRouteJsonPayload {
  id: string;
  name: string;
  sourceFormat: SavedRouteRecord['sourceFormat'];
  planningMode: SavedRouteRecord['planningMode'];
  distanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
  color: string;
  colorCustomized?: boolean;
  bounds?: [number, number, number, number];
  waypoints: SavedRouteRecord['waypoints'];
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: SavedRouteRecord['elevationProfile'];
  gpxXml: string;
  ownership?: RouteOwnership;
  ownerUid: string;
  ownerEmail: string | null;
  ownerDisplayName?: string | null;
  sharedWith?: RouteShareRecipient[];
  sharedWithUids?: string[];
  sharedWithEmails?: string[];
  cloudStoragePath: string;
  cloudJsonPath: string;
  createdAt: string;
  updatedAt: string;
}

export function buildPlaningTracksPaths(uid: string, routeId: string): {
  gpxPath: string;
  jsonPath: string;
} {
  const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeId = routeId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    gpxPath: `${FIREBASE_PLANNING_FOLDER}/${safeUid}/${safeId}.gpx`,
    jsonPath: `${FIREBASE_PLANNING_FOLDER}/${safeUid}/${safeId}.json`,
  };
}

export function buildPlannedRouteJsonPayload(
  route: SavedRouteRecord,
  user: NavUser
): PlannedRouteJsonPayload {
  const { gpxPath, jsonPath } = buildPlaningTracksPaths(user.uid, route.id);
  const gpxXml =
    route.gpxXml ||
    RouteManager.exportRouteAsGpx({
      ...route,
      ownerUid: user.uid,
      ownerEmail: user.email,
    });
  const nowIso = new Date().toISOString();
  const bounds =
    route.bounds || computeRouteBounds(route.geojson, route.elevationProfile);
  const normalizedShares = normalizeShareRecipients(route.sharedWith);

  return {
    id: route.id,
    name: route.name,
    sourceFormat: route.sourceFormat || 'planned',
    planningMode: route.planningMode || (route.sourceFormat === 'planned' ? 'foot' : undefined),
    distanceKm: route.distanceKm,
    ascentMeters: route.ascentMeters,
    descentMeters: route.descentMeters,
    minEle: route.minEle,
    maxEle: route.maxEle,
    color: route.color,
    colorCustomized: route.colorCustomized,
    bounds,
    waypoints: route.waypoints || [],
    geojson: route.geojson,
    elevationProfile: route.elevationProfile,
    gpxXml,
    ownership: 'mine',
    ownerUid: user.uid,
    ownerEmail: user.email,
    ownerDisplayName: route.ownerDisplayName ?? user.displayName ?? null,
    sharedWith: normalizedShares.sharedWith,
    sharedWithUids: normalizedShares.sharedWithUids,
    sharedWithEmails: normalizedShares.sharedWithEmails,
    cloudStoragePath: gpxPath,
    cloudJsonPath: jsonPath,
    createdAt: route.createdAt || nowIso,
    updatedAt: route.updatedAt || nowIso,
  };
}

export interface CloudSyncResult {
  synced: boolean;
  route: SavedRouteRecord;
  backend: 'storage' | 'firestore' | 'none';
  error?: string;
}

function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Firestore rejects nested arrays (such as GeoJSON LineString `coordinates: [[lon, lat], ...]`)
 * and `undefined` property values. Serialize `geojson` as a JSON string for Firestore storage
 * while keeping Storage `.json` uploads in standard GeoJSON object form.
 */
export function serializePlannedRouteForFirestore(
  payload: PlannedRouteJsonPayload,
  downloadUrl?: string
): Record<string, unknown> {
  const { geojson, ...rest } = payload;
  return stripUndefinedDeep({
    ...rest,
    geojsonJson: JSON.stringify(geojson),
    cloudDownloadUrl: downloadUrl || null,
  });
}

function resolvePlannedColorFromData(data: {
  color?: unknown;
  colorCustomized?: unknown;
}): { color: string; colorCustomized: boolean | undefined } {
  const rawColor = typeof data.color === 'string' && data.color ? data.color : '';
  const isCustomized = data.colorCustomized === true;
  if (isCustomized && rawColor) {
    return {
      color: rawColor === '#10b981' ? '#14b8a6' : rawColor,
      colorCustomized: true,
    };
  }
  if (!rawColor || LEGACY_PLANNED_COLORS.has(rawColor) || rawColor === '#10b981') {
    return { color: PLANNING_ROUTE_COLOR, colorCustomized: undefined };
  }
  return { color: rawColor, colorCustomized: undefined };
}

function normalizePlannedGeojsonColor(
  geojson: GeoJSON.FeatureCollection,
  targetColor: string
): GeoJSON.FeatureCollection {
  return {
    ...geojson,
    features: (geojson.features || []).map((f) => ({
      ...f,
      properties: {
        ...(f.properties || {}),
        color: targetColor,
      },
    })),
  };
}

export function deserializeFirestorePlannedRoute(
  data: Record<string, any>,
  user: NavUser
): SavedRouteRecord | null {
  if (!data?.id) return null;

  const sourceFormat: SavedRouteRecord['sourceFormat'] =
    data.sourceFormat === 'gpx' ||
    data.sourceFormat === 'kml' ||
    data.sourceFormat === 'geojson' ||
    data.sourceFormat === 'drawn' ||
    data.sourceFormat === 'planned'
      ? data.sourceFormat
      : 'planned';

  let parsedGeojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: [],
  };
  if (typeof data.geojsonJson === 'string' && data.geojsonJson.trim()) {
    try {
      parsedGeojson = JSON.parse(data.geojsonJson) as GeoJSON.FeatureCollection;
    } catch {
      // Keep empty FeatureCollection fallback if malformed
    }
  } else if (data.geojson && typeof data.geojson === 'object') {
    parsedGeojson = data.geojson as GeoJSON.FeatureCollection;
  }

  const { color, colorCustomized } =
    sourceFormat === 'planned'
      ? resolvePlannedColorFromData(data)
      : {
          color: typeof data.color === 'string' && data.color ? data.color : '#e11d48',
          colorCustomized: data.colorCustomized === true ? true : undefined,
        };
  parsedGeojson = normalizePlannedGeojsonColor(parsedGeojson, color);

  const parsedBounds: [number, number, number, number] | undefined =
    Array.isArray(data.bounds) &&
    data.bounds.length === 4 &&
    data.bounds.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
      ? [data.bounds[0], data.bounds[1], data.bounds[2], data.bounds[3]]
      : computeRouteBounds(parsedGeojson, Array.isArray(data.elevationProfile) ? data.elevationProfile : []);

  return {
    id: String(data.id),
    name: data.name || 'מסלול מתוכנן',
    sourceFormat,
    planningMode: data.planningMode || (sourceFormat === 'planned' ? 'foot' : undefined),
    waypoints: Array.isArray(data.waypoints) ? data.waypoints : [],
    distanceKm: Number(data.distanceKm || 0),
    ascentMeters: Number(data.ascentMeters || 0),
    descentMeters: Number(data.descentMeters || 0),
    minEle: Number(data.minEle || 0),
    maxEle: Number(data.maxEle || 0),
    color,
    colorCustomized,
    visible: typeof data.visible === 'boolean' ? data.visible : true,
    bounds: parsedBounds,
    hasFullPayload: true,
    geojson: parsedGeojson,
    elevationProfile: Array.isArray(data.elevationProfile) ? data.elevationProfile : [],
    gpxXml: data.gpxXml,
    ownership: 'mine',
    ownerUid: data.ownerUid || user.uid,
    ownerEmail: data.ownerEmail || user.email,
    ownerDisplayName: data.ownerDisplayName ?? user.displayName ?? null,
    sharedWith: Array.isArray(data.sharedWith) ? data.sharedWith : undefined,
    sharedWithUids: Array.isArray(data.sharedWithUids) ? data.sharedWithUids : undefined,
    sharedWithEmails: Array.isArray(data.sharedWithEmails) ? data.sharedWithEmails : undefined,
    cloudSyncStatus: 'synced',
    cloudStoragePath: data.cloudStoragePath,
    cloudJsonPath: data.cloudJsonPath,
    cloudDownloadUrl: data.cloudDownloadUrl ?? undefined,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
}

export function deserializeFirestoreSharedRoute(
  data: Record<string, any>,
  fallbackOwnerUid: string,
  fallbackRouteId: string
): SavedRouteRecord | null {
  const remoteRouteId = String(data?.id || fallbackRouteId || '').trim();
  const ownerUid = String(data?.ownerUid || fallbackOwnerUid || '').trim();
  if (!remoteRouteId || !ownerUid) return null;

  const base = deserializeFirestorePlannedRoute(
    { ...data, id: remoteRouteId, ownerUid },
    { uid: ownerUid, email: data?.ownerEmail || null, displayName: data?.ownerDisplayName || null, photoURL: null }
  );
  if (!base) return null;

  const senderName =
    typeof data.ownerDisplayName === 'string' && data.ownerDisplayName.trim()
      ? data.ownerDisplayName.trim()
      : typeof data.ownerEmail === 'string' && data.ownerEmail.trim()
        ? data.ownerEmail.trim()
        : null;

  return {
    ...base,
    id: buildSharedLocalRouteId(ownerUid, remoteRouteId),
    visible: false,
    ownership: 'shared',
    ownerUid,
    ownerEmail: typeof data.ownerEmail === 'string' ? data.ownerEmail : null,
    ownerDisplayName: senderName,
    sharedByUid: ownerUid,
    sharedByName: senderName,
    sharedByEmail: typeof data.ownerEmail === 'string' ? data.ownerEmail : null,
    cloudSyncStatus: 'synced',
  };
}

function parseTimestampMs(iso?: string): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class PlannedTracksCloudService {
  static async savePlannedRouteToFirebase(
    route: SavedRouteRecord,
    user: NavUser,
    options?: { requireFirestore?: boolean }
  ): Promise<CloudSyncResult> {
    const hydratedRoute = RouteManager.isHydratedRoute(route)
      ? route
      : (await RouteManager.loadFullRoute(route)) || route;

    const services = getFirebaseServices();
    if (!services) {
      const updated =
        (await RouteManager.updateRouteCloudSync(hydratedRoute.id, {
          ownerUid: user.uid,
          ownerEmail: user.email,
          ownerDisplayName: hydratedRoute.ownerDisplayName ?? user.displayName ?? null,
          cloudSyncStatus: 'pending',
          cloudError: 'Firebase SDK config missing',
        })) || hydratedRoute;
      return { synced: false, route: updated, backend: 'none', error: 'Firebase אינו מוגדר' };
    }

    const payload = buildPlannedRouteJsonPayload(hydratedRoute, user);
    const { gpxPath, jsonPath } = buildPlaningTracksPaths(user.uid, hydratedRoute.id);

    // 1. Write to Firestore FIRST (fast, reliable, avoids blocking 8s on CORS/unconfigured Storage bucket)
    let firestoreOk = false;
    let firestoreError: string | undefined;
    try {
      const routeDocRef = doc(
        services.firestore,
        FIREBASE_PLANNING_FOLDER,
        user.uid,
        'routes',
        hydratedRoute.id
      );
      await setDoc(routeDocRef, serializePlannedRouteForFirestore(payload));
      firestoreOk = true;
    } catch (err: any) {
      firestoreError = err?.message || String(err);
    }

    // 2. Optionally upload GPX + JSON to Firebase Storage if bucket is active in this session
    let storageOk = false;
    let downloadUrl: string | undefined;
    let storageError: string | undefined;

    if (!storageUnavailableForSession) {
      try {
        const gpxRef = ref(services.storage, gpxPath);
        await withTimeout(
          uploadString(gpxRef, payload.gpxXml, 'raw', {
            contentType: 'application/gpx+xml;charset=utf-8',
            customMetadata: {
              routeId: hydratedRoute.id,
              routeName: hydratedRoute.name,
              planningMode: String(payload.planningMode || 'foot'),
              ownerUid: user.uid,
              ownerEmail: user.email || '',
            },
          }),
          STORAGE_UPLOAD_TIMEOUT_MS,
          'storage-gpx-upload'
        );
        downloadUrl = await getDownloadURL(gpxRef).catch(() => undefined);

        const jsonRef = ref(services.storage, jsonPath);
        await withTimeout(
          uploadString(jsonRef, JSON.stringify(payload, null, 2), 'raw', {
            contentType: 'application/json;charset=utf-8',
          }),
          STORAGE_UPLOAD_TIMEOUT_MS,
          'storage-json-upload'
        );
        storageOk = true;

        if (downloadUrl && firestoreOk) {
          const routeDocRef = doc(
            services.firestore,
            FIREBASE_PLANNING_FOLDER,
            user.uid,
            'routes',
            hydratedRoute.id
          );
          await setDoc(routeDocRef, { cloudDownloadUrl: downloadUrl }, { merge: true }).catch(
            () => undefined
          );
        }
      } catch (err: any) {
        storageError = err?.message || String(err);
        // If Storage bucket is missing/CORS-blocked/unauthorized on this host, avoid retrying on every route save in this session
        const code = String(err?.code || '');
        if (
          code.includes('storage/unknown') ||
          code.includes('storage/unauthorized') ||
          code.includes('storage/bucket-not-found') ||
          code.includes('storage/retry-limit-exceeded') ||
          (storageError ?? '').includes('timeout')
        ) {
          storageUnavailableForSession = true;
        }
      }
    }

    if ((options?.requireFirestore ? firestoreOk : storageOk || firestoreOk)) {
      clearPlannedRouteDeleted(hydratedRoute.id);
      const updated =
        (await RouteManager.updateRouteCloudSync(hydratedRoute.id, {
          ownerUid: user.uid,
          ownerEmail: user.email,
          ownerDisplayName: hydratedRoute.ownerDisplayName ?? user.displayName ?? null,
          cloudSyncStatus: 'synced',
          cloudStoragePath: storageOk ? gpxPath : undefined,
          cloudJsonPath: firestoreOk
            ? `firestore:${FIREBASE_PLANNING_FOLDER}/${user.uid}/routes/${hydratedRoute.id}`
            : jsonPath,
          cloudDownloadUrl: downloadUrl,
          cloudError: undefined,
          updatedAt: hydratedRoute.updatedAt || payload.updatedAt,
        })) || hydratedRoute;
      return {
        synced: true,
        route: updated,
        backend: firestoreOk ? 'firestore' : 'storage',
      };
    }

    const errMsg =
      [firestoreError, storageError].filter(Boolean).join(' | ') || 'Cloud upload failed';
    const updated =
      (await RouteManager.updateRouteCloudSync(hydratedRoute.id, {
        ownerUid: user.uid,
        ownerEmail: user.email,
        cloudSyncStatus: 'error',
        cloudError: errMsg,
      })) || hydratedRoute;
    return { synced: false, route: updated, backend: 'none', error: errMsg };
  }

  static async flushPendingDeletes(user: NavUser): Promise<void> {
    const services = getFirebaseServices();
    if (!services) return;
    const deletedIds = getDeletedPlannedRouteIds();
    if (deletedIds.size === 0) return;

    for (const routeId of deletedIds) {
      try {
        await deleteDoc(
          doc(services.firestore, FIREBASE_PLANNING_FOLDER, user.uid, 'routes', routeId)
        );
        if (!storageUnavailableForSession) {
          const { gpxPath, jsonPath } = buildPlaningTracksPaths(user.uid, routeId);
          await Promise.allSettled([
            deleteObject(ref(services.storage, gpxPath)),
            deleteObject(ref(services.storage, jsonPath)),
          ]);
        }
        clearPlannedRouteDeleted(routeId);
      } catch {
        // Keep tombstone for next online retry so deleted route never resurrects
      }
    }
  }

  static async syncPendingRoutesForUser(user: NavUser): Promise<number> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 0;
    }
    await this.flushPendingDeletes(user);
    const deletedIds = getDeletedPlannedRouteIds();
    const allRoutes = await RouteManager.listRouteSummaries(user.uid);
    const pending = allRoutes.filter(
      (r) =>
        !deletedIds.has(r.id) &&
        r.ownership !== 'shared' &&
        (r.sourceFormat === 'planned' || Boolean(r.sharedWith && r.sharedWith.length > 0)) &&
        (r.cloudSyncStatus === 'pending' || r.cloudSyncStatus === 'error') &&
        (!r.ownerUid || r.ownerUid === user.uid)
    );

    if (pending.length === 0) return 0;

    let syncedCount = 0;
    for (let i = 0; i < pending.length; i += PENDING_UPLOAD_CONCURRENCY) {
      const batch = pending.slice(i, i + PENDING_UPLOAD_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (summary) => {
          const hydrated = (await RouteManager.loadFullRoute(summary)) || summary;
          return this.savePlannedRouteToFirebase(hydrated, user);
        })
      );
      for (const res of results) {
        if (res.synced) syncedCount++;
      }
    }
    return syncedCount;
  }

  static async fetchUserPlannedRoutes(
    user: NavUser,
    options?: { forceFull?: boolean }
  ): Promise<SavedRouteRecord[]> {
    const services = getFirebaseServices();
    if (!services) return [];

    const deletedIds = getDeletedPlannedRouteIds();
    const localRows = await RouteManager.listRouteSummaries(user.uid);
    const localById = new Map(localRows.map((r) => [r.id, r]));
    const hasLocalUserPlanned = localRows.some(
      (r) =>
        r.sourceFormat === 'planned' &&
        r.ownership !== 'shared' &&
        (!r.ownerUid || r.ownerUid === user.uid)
    );
    const watermarkIso =
      !options?.forceFull && hasLocalUserPlanned ? getPlannedSyncWatermark(user.uid) : null;
    let maxRemoteUpdatedAt = watermarkIso || '';
    const imported: SavedRouteRecord[] = [];

    const considerRemoteRecord = (rec: SavedRouteRecord | null) => {
      if (!rec) return;
      if (rec.updatedAt && parseTimestampMs(rec.updatedAt) > parseTimestampMs(maxRemoteUpdatedAt)) {
        maxRemoteUpdatedAt = rec.updatedAt;
      }
      if (deletedIds.has(rec.id)) {
        // Opportunistically delete remotely without bringing it back
        void this.deleteRemotePlannedRoute(rec, user);
        return;
      }
      const existing = localById.get(rec.id);
      if (!existing) {
        imported.push(rec);
        return;
      }
      if (existing.cloudSyncStatus === 'pending') {
        return;
      }
      const remoteMs = parseTimestampMs(rec.updatedAt);
      const localMs = parseTimestampMs(existing.updatedAt);
      if (remoteMs > localMs) {
        imported.push({
          ...rec,
          visible: existing.visible,
        });
      }
    };

    try {
      const colRef = collection(
        services.firestore,
        FIREBASE_PLANNING_FOLDER,
        user.uid,
        'routes'
      );
      let snap: Awaited<ReturnType<typeof getDocs>> | undefined;
      if (
        watermarkIso &&
        typeof query === 'function' &&
        typeof where === 'function'
      ) {
        try {
          const deltaQuery = query(colRef, where('updatedAt', '>', watermarkIso));
          if (deltaQuery) {
            snap = await getDocs(deltaQuery);
          }
        } catch {
          snap = undefined;
        }
      }
      if (!snap) {
        snap = await getDocs(colRef);
      }
      snap.forEach((docSnap) => {
        considerRemoteRecord(
          deserializeFirestorePlannedRoute(docSnap.data() as Record<string, any>, user)
        );
      });
    } catch {
      if (!storageUnavailableForSession) {
        try {
          const folderRef = ref(
            services.storage,
            `${FIREBASE_PLANNING_FOLDER}/${user.uid}`
          );
          const listRes = await listAll(folderRef);
          for (const item of listRes.items) {
            if (!item.name.endsWith('.json')) continue;
            const url = await getDownloadURL(item);
            const res = await fetch(url);
            if (!res.ok) continue;
            const data = (await res.json()) as PlannedRouteJsonPayload;
            if (!data?.id) continue;
            const { color, colorCustomized } = resolvePlannedColorFromData(data);
            const normalizedGeojson = normalizePlannedGeojsonColor(data.geojson, color);
            considerRemoteRecord({
              id: data.id,
              name: data.name || 'מסלול מתוכנן',
              sourceFormat: 'planned',
              planningMode: data.planningMode || 'foot',
              waypoints: data.waypoints || [],
              distanceKm: Number(data.distanceKm || 0),
              ascentMeters: Number(data.ascentMeters || 0),
              descentMeters: Number(data.descentMeters || 0),
              minEle: Number(data.minEle || 0),
              maxEle: Number(data.maxEle || 0),
              color,
              colorCustomized,
              visible: true,
              bounds: data.bounds || computeRouteBounds(normalizedGeojson, data.elevationProfile),
              hasFullPayload: true,
              geojson: normalizedGeojson,
              elevationProfile: data.elevationProfile || [],
              gpxXml: data.gpxXml,
              ownership: 'mine',
              ownerUid: data.ownerUid || user.uid,
              ownerEmail: data.ownerEmail || user.email,
              ownerDisplayName: data.ownerDisplayName ?? user.displayName ?? null,
              sharedWith: data.sharedWith,
              sharedWithUids: data.sharedWithUids,
              sharedWithEmails: data.sharedWithEmails,
              cloudSyncStatus: 'synced',
              cloudStoragePath: data.cloudStoragePath,
              cloudJsonPath: data.cloudJsonPath,
              createdAt: data.createdAt || new Date().toISOString(),
              updatedAt: data.updatedAt || new Date().toISOString(),
            });
          }
        } catch {
          // Ignore when offline or Storage not initialized
        }
      }
    }

    if (maxRemoteUpdatedAt) {
      setPlannedSyncWatermark(user.uid, maxRemoteUpdatedAt);
    }

    if (imported.length > 0) {
      return await RouteManager.persistRoutesBulk(imported);
    }
    return [];
  }

  static async deleteRemotePlannedRoute(
    route: SavedRouteRecord,
    user: NavUser
  ): Promise<void> {
    markPlannedRouteDeleted(route.id);
    const services = getFirebaseServices();
    if (!services) return;
    const { gpxPath, jsonPath } = buildPlaningTracksPaths(user.uid, route.id);
    const tasks: Promise<unknown>[] = [
      deleteDoc(doc(services.firestore, FIREBASE_PLANNING_FOLDER, user.uid, 'routes', route.id)),
    ];
    if (!storageUnavailableForSession) {
      tasks.push(
        deleteObject(ref(services.storage, route.cloudStoragePath || gpxPath)),
        deleteObject(ref(services.storage, route.cloudJsonPath || jsonPath))
      );
    }
    const results = await Promise.allSettled(tasks);
    if (results[0]?.status === 'fulfilled') {
      clearPlannedRouteDeleted(route.id);
    }
  }

  static async updateRouteSharing(
    route: SavedRouteRecord,
    recipients: RouteShareRecipient[],
    user: NavUser
  ): Promise<CloudSyncResult> {
    const hydrated = RouteManager.isHydratedRoute(route)
      ? route
      : (await RouteManager.loadFullRoute(route)) || route;

    if (hydrated.ownership === 'shared') {
      return {
        synced: false,
        route: hydrated,
        backend: 'none',
        error: 'לא ניתן לשתף מסלול משותף — יש לשמור עותק אישי תחילה',
      };
    }

    const normalized = normalizeShareRecipients(recipients);
    const updatedLocal = await RouteManager.persistFullRoute({
      ...hydrated,
      ownership: 'mine',
      ownerUid: hydrated.ownerUid || user.uid,
      ownerEmail: hydrated.ownerEmail || user.email,
      ownerDisplayName: hydrated.ownerDisplayName ?? user.displayName ?? null,
      sharedWith: normalized.sharedWith,
      sharedWithUids: normalized.sharedWithUids,
      sharedWithEmails: normalized.sharedWithEmails,
      cloudSyncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    });

    return this.savePlannedRouteToFirebase(updatedLocal, user, { requireFirestore: true });
  }

  static async reconcileSharedRoutes(
    remoteRecords: SavedRouteRecord[],
    user: NavUser,
    options?: { allowRevoke?: boolean }
  ): Promise<{
    allShared: SavedRouteRecord[];
    newlyArrived: SavedRouteRecord[];
    revokedIds: string[];
  }> {
    if (!user?.uid) {
      return { allShared: [], newlyArrived: [], revokedIds: [] };
    }
    return enqueueSharedReconcile(user.uid, async () => {
      const dismissedIds = getDismissedSharedRouteIds();
      const deduped = new Map<string, SavedRouteRecord>();
      for (const rec of remoteRecords) {
        if (!rec?.id) continue;
        if (rec.sharedByUid && rec.sharedByUid === user.uid) continue;
        if (dismissedIds.has(rec.id)) continue;
        const stamped: SavedRouteRecord = {
          ...rec,
          sharedForUid: user.uid,
        };
        const existingRemote = deduped.get(rec.id);
        if (
          !existingRemote ||
          parseTimestampMs(stamped.updatedAt) > parseTimestampMs(existingRemote.updatedAt)
        ) {
          deduped.set(rec.id, stamped);
        }
      }

      const localSummaries = await RouteManager.listRouteSummaries();
      const foreignSharedIds = localSummaries
        .filter((r) => r.ownership === 'shared' && r.sharedForUid && r.sharedForUid !== user.uid)
        .map((r) => r.id);
      if (foreignSharedIds.length > 0) {
        await Promise.all(foreignSharedIds.map((id) => RouteManager.deleteRoute(id)));
      }

      const localSharedById = new Map(
        localSummaries
          .filter((r) => r.ownership === 'shared' && (!r.sharedForUid || r.sharedForUid === user.uid))
          .map((r) => [r.id, r])
      );

      const toPersist: SavedRouteRecord[] = [];
      const newlyArrived: SavedRouteRecord[] = [];
      const revokedIds: string[] = [];

      for (const remote of deduped.values()) {
        const existing = localSharedById.get(remote.id);
        if (!existing) {
          toPersist.push(remote);
          newlyArrived.push(remote);
        } else if (parseTimestampMs(remote.updatedAt) > parseTimestampMs(existing.updatedAt)) {
          toPersist.push({
            ...remote,
            visible: existing.visible,
          });
        }
      }

      if (toPersist.length > 0) {
        await RouteManager.persistRoutesBulk(toPersist);
      }

      if (options?.allowRevoke) {
        for (const localShared of localSharedById.values()) {
          // Only revoke routes originating from Firestore sharing (have sharedByUid)
          if (localShared.sharedByUid && !deduped.has(localShared.id)) {
            revokedIds.push(localShared.id);
          }
        }
        if (revokedIds.length > 0) {
          await Promise.all(revokedIds.map((id) => RouteManager.deleteRoute(id)));
        }
      }

      const allSummaries = await RouteManager.listRouteSummaries(user.uid);
      const allShared = allSummaries.filter((r) => r.ownership === 'shared');
      return { allShared, newlyArrived, revokedIds };
    });
  }

  static async fetchSharedWithMeRoutes(user: NavUser): Promise<{
    allShared: SavedRouteRecord[];
    newlyArrived: SavedRouteRecord[];
    revokedIds: string[];
    error?: string;
  }> {
    const services = getFirebaseServices();
    if (!services || !user?.uid) {
      return { allShared: [], newlyArrived: [], revokedIds: [] };
    }

    const cgRef = collectionGroup(services.firestore, 'routes');
    const normalizedEmail = (user.email || '').trim().toLowerCase();
    const queries: Array<Promise<Awaited<ReturnType<typeof getDocs>>>> = [
      getDocs(query(cgRef, where('sharedWithUids', 'array-contains', user.uid))),
    ];
    if (normalizedEmail) {
      queries.push(
        getDocs(query(cgRef, where('sharedWithEmails', 'array-contains', normalizedEmail)))
      );
    }

    const results = await Promise.allSettled(queries);
    const rejectedReasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String((r.reason as any)?.code || (r.reason as any)?.message || r.reason || ''));
    const anySucceeded = results.some((r) => r.status === 'fulfilled');
    const allSucceeded = results.every((r) => r.status === 'fulfilled');
    if (!anySucceeded) {
      const error = rejectedReasons.filter(Boolean).join(' | ') || 'shared_query_failed';
      console.warn('[PlannedTracksCloudService] fetchSharedWithMeRoutes error:', error);
      return { allShared: [], newlyArrived: [], revokedIds: [], error };
    }

    const collected: SavedRouteRecord[] = [];
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      res.value.forEach((docSnap) => {
        const pathParts = docSnap.ref?.path?.split('/') || [];
        const pathOwnerUid = pathParts.length >= 2 ? pathParts[1] : '';
        const mapped = deserializeFirestoreSharedRoute(
          docSnap.data() as Record<string, any>,
          pathOwnerUid,
          docSnap.id
        );
        if (mapped) collected.push(mapped);
      });
    }

    const reconciled = await this.reconcileSharedRoutes(collected, user, {
      allowRevoke: allSucceeded,
    });
    return {
      ...reconciled,
      ...(rejectedReasons.length > 0 ? { error: rejectedReasons.join(' | ') } : {}),
    };
  }

  static subscribeSharedWithMeRoutes(
    user: NavUser,
    onUpdate: (event: {
      allShared: SavedRouteRecord[];
      newlyArrived: SavedRouteRecord[];
      revokedIds: string[];
      isInitial: boolean;
    }) => void,
    onError?: (errorMessage: string) => void
  ): () => void {
    const services = getFirebaseServices();
    if (!services || !user?.uid || typeof onSnapshot !== 'function') {
      return () => undefined;
    }

    const cgRef = collectionGroup(services.firestore, 'routes');
    const normalizedEmail = (user.email || '').trim().toLowerCase();

    const uidMap = new Map<string, SavedRouteRecord>();
    const emailMap = new Map<string, SavedRouteRecord>();
    let uidLoaded = false;
    let emailLoaded = !normalizedEmail;
    let uidHealthy = false;
    let emailHealthy = !normalizedEmail;
    let hasEmittedInitial = false;
    let reconcileSeq = 0;

    const flushMerged = () => {
      const seq = ++reconcileSeq;
      const merged = Array.from(
        new Map<string, SavedRouteRecord>([...uidMap, ...emailMap]).values()
      );
      const allowRevoke = uidLoaded && emailLoaded && uidHealthy && emailHealthy;
      const isInitial = !hasEmittedInitial;
      if (uidLoaded && emailLoaded) {
        hasEmittedInitial = true;
      }

      void this.reconcileSharedRoutes(merged, user, { allowRevoke }).then((res) => {
        if (seq !== reconcileSeq) return;
        onUpdate({
          ...res,
          isInitial,
        });
      });
    };

    const isIndexBuildingError = (err: any): boolean => {
      const code = String(err?.code || '').toLowerCase();
      const message = String(err?.message || '').toLowerCase();
      return (
        code.includes('failed-precondition') ||
        message.includes('not ready yet') ||
        message.includes('failed-precondition')
      );
    };

    let disposed = false;
    let unsubUid: () => void = () => {};
    let unsubEmail: () => void = () => {};
    let uidRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let emailRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let uidRetryCount = 0;
    let emailRetryCount = 0;

    const attachUidListener = () => {
      if (disposed) return;
      unsubUid = onSnapshot(
        query(cgRef, where('sharedWithUids', 'array-contains', user.uid)),
        (snap) => {
          if (disposed) return;
          uidRetryCount = 0;
          uidMap.clear();
          snap.forEach((docSnap) => {
            const pathParts = docSnap.ref?.path?.split('/') || [];
            const pathOwnerUid = pathParts.length >= 2 ? pathParts[1] : '';
            const mapped = deserializeFirestoreSharedRoute(
              docSnap.data() as Record<string, any>,
              pathOwnerUid,
              docSnap.id
            );
            if (mapped) uidMap.set(mapped.id, mapped);
          });
          uidLoaded = true;
          uidHealthy = true;
          flushMerged();
        },
        (err: any) => {
          if (disposed) return;
          const msg = String(err?.code || err?.message || err || '');
          console.warn('[PlannedTracksCloudService] sharedWithUids listener warning:', err);
          uidLoaded = true;
          uidHealthy = false;
          onError?.(msg);
          if (isIndexBuildingError(err) && uidRetryCount < 15) {
            const delayMs = Math.min(30000, 10000 + uidRetryCount * 5000);
            uidRetryCount++;
            try {
              unsubUid();
            } catch {
              // Ignore
            }
            uidRetryTimer = setTimeout(() => {
              uidRetryTimer = null;
              attachUidListener();
            }, delayMs);
          }
        }
      );
    };

    const attachEmailListener = () => {
      if (disposed || !normalizedEmail) return;
      unsubEmail = onSnapshot(
        query(cgRef, where('sharedWithEmails', 'array-contains', normalizedEmail)),
        (snap) => {
          if (disposed) return;
          emailRetryCount = 0;
          emailMap.clear();
          snap.forEach((docSnap) => {
            const pathParts = docSnap.ref?.path?.split('/') || [];
            const pathOwnerUid = pathParts.length >= 2 ? pathParts[1] : '';
            const mapped = deserializeFirestoreSharedRoute(
              docSnap.data() as Record<string, any>,
              pathOwnerUid,
              docSnap.id
            );
            if (mapped) emailMap.set(mapped.id, mapped);
          });
          emailLoaded = true;
          emailHealthy = true;
          flushMerged();
        },
        (err: any) => {
          if (disposed) return;
          const msg = String(err?.code || err?.message || err || '');
          console.warn('[PlannedTracksCloudService] sharedWithEmails listener warning:', err);
          emailLoaded = true;
          emailHealthy = false;
          onError?.(msg);
          if (isIndexBuildingError(err) && emailRetryCount < 15) {
            const delayMs = Math.min(30000, 10000 + emailRetryCount * 5000);
            emailRetryCount++;
            try {
              unsubEmail();
            } catch {
              // Ignore
            }
            emailRetryTimer = setTimeout(() => {
              emailRetryTimer = null;
              attachEmailListener();
            }, delayMs);
          }
        }
      );
    };

    attachUidListener();
    attachEmailListener();

    return () => {
      disposed = true;
      reconcileSeq++;
      if (uidRetryTimer) clearTimeout(uidRetryTimer);
      if (emailRetryTimer) clearTimeout(emailRetryTimer);
      unsubUid();
      unsubEmail();
    };
  }
}
