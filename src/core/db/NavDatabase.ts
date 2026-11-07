import Dexie, { type Table } from 'dexie';

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
  userNotes?: string;
  updatedAt?: string;
}

export interface SavedRouteRecord {
  id: string;
  name: string;
  sourceFormat: 'gpx' | 'kml' | 'geojson' | 'drawn';
  distanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
  color: string;
  visible: boolean;
  geojson: GeoJSON.FeatureCollection;
  elevationProfile: Array<{ distKm: number; ele: number; lon: number; lat: number }>;
  createdAt: string;
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

export class NavDatabase extends Dexie {
  mapRegistry!: Table<MapArchiveRecord, string>;
  pois!: Table<PoiRecord, string>;
  routes!: Table<SavedRouteRecord, string>;
  tracks!: Table<RecordedTrackRecord, string>;

  constructor() {
    super('NavAppOutdoorDB');
    this.version(1).stores({
      mapRegistry: 'id, role, storageKind, createdUtc',
      pois: 'id, category, subcategory, nameHe, nameEn, source',
      routes: 'id, name, visible, createdAt',
      tracks: 'id, startedAt',
    });
  }
}

export const db = new NavDatabase();

