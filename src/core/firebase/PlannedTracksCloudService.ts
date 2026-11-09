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
import { RouteManager } from '../navigation/RouteManager';
import { PLANNING_ROUTE_COLOR } from '../routing/RoutingProfiles';
import type { NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

export const FIREBASE_PLANNING_FOLDER = 'planing_tracks';

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
  const gpxXml = route.gpxXml || RouteManager.exportRouteAsGpx({
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

function normalizePlannedGeojsonColor(geojson: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  return {
    ...geojson,
    features: (geojson.features || []).map((f) => ({
      ...f,
      properties: {
        ...(f.properties || {}),
        color: PLANNING_ROUTE_COLOR,
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
  parsedGeojson = normalizePlannedGeojsonColor(parsedGeojson);

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
    color: PLANNING_ROUTE_COLOR,
    visible: true,
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

    let storageOk = false;
    let downloadUrl: string | undefined;
    let storageError: string | undefined;

    try {
      const gpxRef = ref(services.storage, gpxPath);
      await uploadString(gpxRef, payload.gpxXml, 'raw', {
        contentType: 'application/gpx+xml;charset=utf-8',
        customMetadata: {
          routeId: route.id,
          routeName: route.name,
          planningMode: String(payload.planningMode || 'foot'),
          ownerUid: user.uid,
          ownerEmail: user.email || '',
        },
      });
      downloadUrl = await getDownloadURL(gpxRef).catch(() => undefined);

      const jsonRef = ref(services.storage, jsonPath);
      await uploadString(jsonRef, JSON.stringify(payload, null, 2), 'raw', {
        contentType: 'application/json;charset=utf-8',
      });
      storageOk = true;
    } catch (err: any) {
      storageError = err?.message || String(err);
    }

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
      await setDoc(routeDocRef, serializePlannedRouteForFirestore(payload, downloadUrl));
      firestoreOk = true;
    } catch (err: any) {
      firestoreError = err?.message || String(err);
    }

    if (storageOk || firestoreOk) {
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
        })) || route;
      return {
        synced: true,
        route: updated,
        backend: storageOk ? 'storage' : 'firestore',
      };
    }

    const errMsg =
      [storageError, firestoreError].filter(Boolean).join(' | ') || 'Cloud upload failed';
    const updated =
      (await RouteManager.updateRouteCloudSync(route.id, {
        ownerUid: user.uid,
        ownerEmail: user.email,
        cloudSyncStatus: 'error',
        cloudError: errMsg,
      })) || route;
    return { synced: false, route: updated, backend: 'none', error: errMsg };
  }

  static async syncPendingRoutesForUser(user: NavUser): Promise<number> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 0;
    }
    const allRoutes = await db.routes.toArray();
    const pending = allRoutes.filter(
      (r) =>
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

    const imported: SavedRouteRecord[] = [];
    const existingIds = new Set((await db.routes.toArray()).map((r) => r.id));

    try {
      const colRef = collection(
        services.firestore,
        FIREBASE_PLANNING_FOLDER,
        user.uid,
        'routes'
      );
      const snap = await getDocs(colRef);
      snap.forEach((docSnap) => {
        const rec = deserializeFirestorePlannedRoute(docSnap.data(), user);
        if (!rec || existingIds.has(rec.id)) return;
        imported.push(rec);
      });
    } catch {
      // Fallback to listing Storage JSON files if Firestore rules aren't deployed
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
          if (!data?.id || existingIds.has(data.id)) continue;
          imported.push({
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
            color: PLANNING_ROUTE_COLOR,
            visible: true,
            geojson: normalizePlannedGeojsonColor(data.geojson),
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

    if (imported.length > 0) {
      await db.routes.bulkPut(imported);
    }
    return imported;
  }

  static async deleteRemotePlannedRoute(
    route: SavedRouteRecord,
    user: NavUser
  ): Promise<void> {
    const services = getFirebaseServices();
    if (!services) return;
    const { gpxPath, jsonPath } = buildPlaningTracksPaths(user.uid, route.id);
    await Promise.allSettled([
      deleteObject(ref(services.storage, route.cloudStoragePath || gpxPath)),
      deleteObject(ref(services.storage, route.cloudJsonPath || jsonPath)),
      deleteDoc(doc(services.firestore, FIREBASE_PLANNING_FOLDER, user.uid, 'routes', route.id)),
    ]);
  }
}
