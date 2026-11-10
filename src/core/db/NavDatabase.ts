import Dexie, { type Table } from 'dexie';
import type { PlanningMode } from '../routing/RoutingProfiles';

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
  updatedAt?: string;
}

export interface PlannedWaypoint {
  lon: number;
  lat: number;
  ele?: number | null;
  roadLabel?: string;
  legType?: 'network' | 'straight';
}

export type CloudSyncStatus = 'local-only' | 'pending' | 'synced' | 'error';

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
  visible: boolean;
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: Array<{ distKm: number; ele: number; lon: number; lat: number }>;
  gpxXml?: string;
  ownerUid?: string | null;
  ownerEmail?: string | null;
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

export class NavDatabase extends Dexie {
  mapRegistry!: Table<MapArchiveRecord, string>;
  pois!: Table<PoiRecord, string>;
  routes!: Table<SavedRouteRecord, string>;
  tracks!: Table<RecordedTrackRecord, string>;
  searchIndexCache!: Table<SearchIndexCacheRecord, string>;

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
  }
}

export const db = new NavDatabase();

