import {
  deleteObject,
  getDownloadURL,
  listAll,
  ref,
  uploadString,
} from 'firebase/storage';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc,
} from 'firebase/firestore';
import { db, type SavedRouteRecord } from '../db/NavDatabase';
import { LEGACY_PLANNED_COLORS, RouteManager } from '../navigation/RouteManager';
import { PLANNING_ROUTE_COLOR } from '../routing/RoutingProfiles';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

export const FIREBASE_PLANNING_FOLDER = 'planing_tracks';
export const DELETED_PLANNED_ROUTES_STORAGE_KEY = 'navapp.deletedPlannedRoutes.v1';

const STORAGE_UPLOAD_TIMEOUT_MS = 3500;
let storageUnavailableForSession = false;

export function resetPlannedCloudSessionStateForTesting(): void {
  storageUnavailableForSession = false;
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

export interface PlannedRouteJsonPayload {
  id: string;
  name: string;
  sourceFormat: 'planned';
  planningMode: SavedRouteRecord['planningMode'];
  distanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
  color: string;
  colorCustomized?: boolean;
  waypoints: SavedRouteRecord['waypoints'];
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: SavedRouteRecord['elevationProfile'];
  gpxXml: string;
  ownerUid: string;
  ownerEmail: string | null;
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

  return {
    id: route.id,
    name: route.name,
    sourceFormat: 'planned',
    planningMode: route.planningMode || 'foot',
    distanceKm: route.distanceKm,
    ascentMeters: route.ascentMeters,
    descentMeters: route.descentMeters,
    minEle: route.minEle,
    maxEle: route.maxEle,
    color: route.color,
    colorCustomized: route.colorCustomized,
    waypoints: route.waypoints || [],
    geojson: route.geojson,
    elevationProfile: route.elevationProfile,
    gpxXml,
    ownerUid: user.uid,
    ownerEmail: user.email,
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

  const { color, colorCustomized } = resolvePlannedColorFromData(data);
  parsedGeojson = normalizePlannedGeojsonColor(parsedGeojson, color);

  return {
    id: String(data.id),
    name: data.name || 'מסלול מתוכנן',
    sourceFormat: 'planned',
    planningMode: data.planningMode || 'foot',
    waypoints: Array.isArray(data.waypoints) ? data.waypoints : [],
    distanceKm: Number(data.distanceKm || 0),
    ascentMeters: Number(data.ascentMeters || 0),
    descentMeters: Number(data.descentMeters || 0),
    minEle: Number(data.minEle || 0),
    maxEle: Number(data.maxEle || 0),
    color,
    colorCustomized,
    visible: typeof data.visible === 'boolean' ? data.visible : true,
    geojson: parsedGeojson,
    elevationProfile: Array.isArray(data.elevationProfile) ? data.elevationProfile : [],
    gpxXml: data.gpxXml,
    ownerUid: data.ownerUid || user.uid,
    ownerEmail: data.ownerEmail || user.email,
    cloudSyncStatus: 'synced',
    cloudStoragePath: data.cloudStoragePath,
    cloudJsonPath: data.cloudJsonPath,
    cloudDownloadUrl: data.cloudDownloadUrl ?? undefined,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
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
    user: NavUser
  ): Promise<CloudSyncResult> {
    const services = getFirebaseServices();
    if (!services) {
      const updated =
        (await RouteManager.updateRouteCloudSync(route.id, {
          ownerUid: user.uid,
          ownerEmail: user.email,
          cloudSyncStatus: 'pending',
          cloudError: 'Firebase SDK config missing',
        })) || route;
      return { synced: false, route: updated, backend: 'none', error: 'Firebase אינו מוגדר' };
    }

    const payload = buildPlannedRouteJsonPayload(route, user);
    const { gpxPath, jsonPath } = buildPlaningTracksPaths(user.uid, route.id);

    // 1. Write to Firestore FIRST (fast, reliable, avoids blocking 8s on CORS/unconfigured Storage bucket)
    let firestoreOk = false;
    let firestoreError: string | undefined;
    try {
      const routeDocRef = doc(
        services.firestore,
        FIREBASE_PLANNING_FOLDER,
        user.uid,
        'routes',
        route.id
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
              routeId: route.id,
              routeName: route.name,
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
            route.id
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

    if (storageOk || firestoreOk) {
      clearPlannedRouteDeleted(route.id);
      const updated =
        (await RouteManager.updateRouteCloudSync(route.id, {
          ownerUid: user.uid,
          ownerEmail: user.email,
          cloudSyncStatus: 'synced',
          cloudStoragePath: storageOk ? gpxPath : undefined,
          cloudJsonPath: storageOk
            ? jsonPath
            : `firestore:${FIREBASE_PLANNING_FOLDER}/${user.uid}/routes/${route.id}`,
          cloudDownloadUrl: downloadUrl,
          cloudError: undefined,
          updatedAt: route.updatedAt || payload.updatedAt,
        })) || route;
      return {
        synced: true,
        route: updated,
        backend: storageOk ? 'storage' : 'firestore',
      };
    }

    const errMsg =
      [firestoreError, storageError].filter(Boolean).join(' | ') || 'Cloud upload failed';
    const updated =
      (await RouteManager.updateRouteCloudSync(route.id, {
        ownerUid: user.uid,
        ownerEmail: user.email,
        cloudSyncStatus: 'error',
        cloudError: errMsg,
      })) || route;
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
    const allRoutes = await db.routes.toArray();
    const pending = allRoutes.filter(
      (r) =>
        !deletedIds.has(r.id) &&
        r.sourceFormat === 'planned' &&
        (r.cloudSyncStatus === 'pending' || r.cloudSyncStatus === 'error') &&
        (!r.ownerUid || r.ownerUid === user.uid)
    );

    let syncedCount = 0;
    for (const r of pending) {
      const res = await this.savePlannedRouteToFirebase(r, user);
      if (res.synced) syncedCount++;
    }
    return syncedCount;
  }

  static async fetchUserPlannedRoutes(user: NavUser): Promise<SavedRouteRecord[]> {
    const services = getFirebaseServices();
    if (!services) return [];

    const deletedIds = getDeletedPlannedRouteIds();
    const localRows = await db.routes.toArray();
    const localById = new Map(localRows.map((r) => [r.id, r]));
    const imported: SavedRouteRecord[] = [];

    const considerRemoteRecord = (rec: SavedRouteRecord | null) => {
      if (!rec) return;
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
      const snap = await getDocs(colRef);
      snap.forEach((docSnap) => {
        considerRemoteRecord(deserializeFirestorePlannedRoute(docSnap.data(), user));
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
              geojson: normalizePlannedGeojsonColor(data.geojson, color),
              elevationProfile: data.elevationProfile || [],
              gpxXml: data.gpxXml,
              ownerUid: data.ownerUid || user.uid,
              ownerEmail: data.ownerEmail || user.email,
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

    if (imported.length > 0) {
      await db.routes.bulkPut(imported);
    }
    return imported;
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
}
