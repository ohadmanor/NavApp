import Dexie, { type Table } from 'dexie';
import type { PlanningMode } from '../routing/RoutingProfiles';
import type {
  TrailAnnotationDraftRecord,
  TrailAnnotationRecord,
  TrailGeometryCacheRecord,
} from '../trails/TrailAnnotationTypes';

export interface MapArchiveRecord {
  id: 'israel-dem' | 'israel-osm';
  fileName: string;
  role: 'dem-constant' | 'osm-updatable';
  storageKind: 'local-server' | 'opfs' | 'user-file' | 'remote-url' | 'native-file';
  urlOrPath: string;
  sizeBytes: number;
  createdUtc: string;
  minZoom: number;
  maxZoom: number;
  bounds: [number, number, number, number];
  lastVerifiedAt: string;
  isLockedConstant: boolean;
}

export type PoiCategory = 'water' | 'heritage' | 'campsite' | 'offroad' | 'peak' | 'user';
export type PoiVisibility = 'private' | 'global';
export type PoiOwnership = 'mine' | 'shared';

export interface PoiShareRecipient {
  uid?: string | null;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
  sharedAt: string;
}

export interface PoiRecord {
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
  wikipedia: string | null;
  externalUrl?: string | null;
  likes?: number;
  priority?: number;
  userNotes?: string;
  visibility?: PoiVisibility;
  ownership?: PoiOwnership;
  ownerUid?: string | null;
  ownerEmail?: string | null;
  ownerDisplayName?: string | null;
  sharedByUid?: string | null;
  sharedByName?: string | null;
  sharedByEmail?: string | null;
  sharedForUid?: string | null;
  sharedWith?: PoiShareRecipient[];
  sharedWithUids?: string[];
  sharedWithEmails?: string[];
  createdByUid?: string;
  createdAt?: string;
  updatedByUid?: string;
  updatedAt?: string;
}

export interface PoiOverrideRecord {
  id: string;
  deleted?: boolean;
  category?: PoiCategory | null;
  subcategory?: string | null;
  updatedByUid?: string;
  updatedAt: string;
}

export interface PlannedWaypoint {
  lon: number;
  lat: number;
  ele?: number | null;
  roadLabel?: string;
  legType?: 'network' | 'straight';
}

export type CloudSyncStatus = 'local-only' | 'pending' | 'synced' | 'error';
export type RouteOwnership = 'mine' | 'shared';

export interface RouteShareRecipient {
  uid?: string | null;
  email: string;
  displayName?: string | null;
  photoURL?: string | null;
  sharedAt: string;
}

export interface RoutePayloadRecord {
  id: string;
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: Array<{ distKm: number; ele: number; lon: number; lat: number }>;
  waypoints?: PlannedWaypoint[];
  gpxXml?: string;
  updatedAt: string;
}

export interface SavedRouteRecord {
  id: string;
  name: string;
  sourceFormat: 'gpx' | 'kml' | 'geojson' | 'drawn' | 'planned';
  planningMode?: PlanningMode;
  waypoints?: PlannedWaypoint[];
  distanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
  color: string;
  colorCustomized?: boolean;
  visible: boolean;
  bounds?: [number, number, number, number];
  hasFullPayload?: boolean;
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: Array<{ distKm: number; ele: number; lon: number; lat: number }>;
  gpxXml?: string;
  ownership?: RouteOwnership;
  ownerUid?: string | null;
  ownerEmail?: string | null;
  ownerDisplayName?: string | null;
  sharedByUid?: string | null;
  sharedByName?: string | null;
  sharedByEmail?: string | null;
  sharedForUid?: string | null;
  sharedWith?: RouteShareRecipient[];
  sharedWithUids?: string[];
  sharedWithEmails?: string[];
  cloudSyncStatus?: CloudSyncStatus;
  cloudStoragePath?: string;
  cloudJsonPath?: string;
  cloudDownloadUrl?: string;
  cloudError?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface RecordedTrackRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  distanceKm: number;
  ascentMeters: number;
  coordinates: Array<[number, number, number, number]>; // [lon, lat, ele, timestamp]
}

export interface SearchIndexCacheRecord {
  fingerprint: string;
  createdUtc: string;
  payloadBytes: Uint8Array;
  totalFeatures: number;
}

function computeGeoJsonBounds(
  geojson?: GeoJSON.FeatureCollection | null
): [number, number, number, number] | undefined {
  if (!geojson?.features?.length) return undefined;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const visitCoord = (c: unknown) => {
    if (!Array.isArray(c) || c.length < 2) return;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  for (const f of geojson.features) {
    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'LineString') {
      geom.coordinates.forEach(visitCoord);
    } else if (geom.type === 'MultiLineString') {
      geom.coordinates.forEach((ring) => ring.forEach(visitCoord));
    } else if (geom.type === 'Point') {
      visitCoord(geom.coordinates);
    }
  }

  return Number.isFinite(minLon) && Number.isFinite(minLat)
    ? [minLon, minLat, maxLon, maxLat]
    : undefined;
}

export class NavDatabase extends Dexie {
  mapRegistry!: Table<MapArchiveRecord, string>;
  pois!: Table<PoiRecord, string>;
  poiOverrides!: Table<PoiOverrideRecord, string>;
  routes!: Table<SavedRouteRecord, string>;
  routePayloads!: Table<RoutePayloadRecord, string>;
  tracks!: Table<RecordedTrackRecord, string>;
  searchIndexCache!: Table<SearchIndexCacheRecord, string>;
  trailAnnotations!: Table<TrailAnnotationRecord, string>;
  trailGeometryCache!: Table<TrailGeometryCacheRecord, string>;
  trailAnnotationDrafts!: Table<TrailAnnotationDraftRecord, string>;

  constructor() {
    super('NavAppOutdoorDB');
    this.version(1).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source',
      routes: 'id, name, visible, createdAt',
      tracks: 'id, startedAt',
    });
    this.version(2).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source',
      routes: 'id, name, visible, createdAt, ownerUid, cloudSyncStatus, sourceFormat',
      tracks: 'id, startedAt',
    });
    this.version(3).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source',
      routes: 'id, name, visible, createdAt, ownerUid, cloudSyncStatus, sourceFormat',
      tracks: 'id, startedAt',
      searchIndexCache: 'fingerprint, createdUtc',
    });
    this.version(4)
      .stores({
        mapRegistry: 'id, role, storageKind, createdUtc',
        pois: 'id, category, subcategory, nameHe, nameEn, source',
        routes:
          'id, name, visible, createdAt, updatedAt, ownerUid, ownership, cloudSyncStatus, sourceFormat',
        routePayloads: 'id, updatedAt',
        tracks: 'id, startedAt',
        searchIndexCache: 'fingerprint, createdUtc',
      })
      .upgrade(async (tx) => {
        const routesTable = tx.table<SavedRouteRecord, string>('routes');
        const payloadsTable = tx.table<RoutePayloadRecord, string>('routePayloads');
        const existing = await routesTable.toArray();
        if (existing.length === 0) return;

        const payloads: RoutePayloadRecord[] = [];
        const leanRoutes: SavedRouteRecord[] = [];

        for (const r of existing) {
          const bounds = r.bounds || computeGeoJsonBounds(r.geojson);
          const updatedAt = r.updatedAt || r.createdAt || new Date().toISOString();
          if (
            (r.geojson?.features && r.geojson.features.length > 0) ||
            (r.elevationProfile && r.elevationProfile.length > 0) ||
            r.gpxXml ||
            (r.waypoints && r.waypoints.length > 0)
          ) {
            payloads.push({
              id: r.id,
              geojson: r.geojson || { type: 'FeatureCollection', features: [] },
              elevationProfile: r.elevationProfile || [],
              waypoints: r.waypoints,
              gpxXml: r.gpxXml,
              updatedAt,
            });
          }
          leanRoutes.push({
            ...r,
            bounds,
            ownership: r.ownership || 'mine',
            hasFullPayload: false,
            geojson: { type: 'FeatureCollection', features: [] },
            elevationProfile: [],
            waypoints: undefined,
            gpxXml: undefined,
            updatedAt,
          });
        }

        if (payloads.length > 0) {
          await payloadsTable.bulkPut(payloads);
        }
        await routesTable.bulkPut(leanRoutes);
      });
    this.version(5).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source',
      poiOverrides: 'id, deleted, category, updatedAt',
      routes:
        'id, name, visible, createdAt, updatedAt, ownerUid, ownership, cloudSyncStatus, sourceFormat',
      routePayloads: 'id, updatedAt',
      tracks: 'id, startedAt',
      searchIndexCache: 'fingerprint, createdUtc',
    });
    this.version(6).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source',
      poiOverrides: 'id, deleted, category, updatedAt',
      routes:
        'id, name, visible, createdAt, updatedAt, ownerUid, ownership, cloudSyncStatus, sourceFormat',
      routePayloads: 'id, updatedAt',
      tracks: 'id, startedAt',
      searchIndexCache: 'fingerprint, createdUtc',
      trailAnnotations: 'id, status, updatedAt, selectionReleaseId, *wayIds',
      trailGeometryCache: 'id, wayId, releaseId',
      trailAnnotationDrafts: 'id, ownerUid, updatedAt',
    });
    this.version(7).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source, visibility, ownerUid, ownership',
      poiOverrides: 'id, deleted, category, updatedAt',
      routes:
        'id, name, visible, createdAt, updatedAt, ownerUid, ownership, cloudSyncStatus, sourceFormat',
      routePayloads: 'id, updatedAt',
      tracks: 'id, startedAt',
      searchIndexCache: 'fingerprint, createdUtc',
      trailAnnotations: 'id, status, updatedAt, selectionReleaseId, *wayIds',
      trailGeometryCache: 'id, wayId, releaseId',
      trailAnnotationDrafts: 'id, ownerUid, updatedAt',
    });
  }
}

export const db = new NavDatabase();

