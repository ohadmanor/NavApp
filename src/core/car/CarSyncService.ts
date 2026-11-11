import type { PoiRecord, SavedRouteRecord } from '../db/NavDatabase';
import type { OutdoorLayerVisibility } from '../style/israelOutdoorStyle';
import type { MapTheme } from '../../components/ui/themeTokens';
import { NativeOfflineStorage } from '../pmtiles/NativeOfflineStorage';

export interface CarSyncSnapshotInput {
  activeRoute: SavedRouteRecord | null;
  routes: SavedRouteRecord[];
  pois: PoiRecord[];
  isNavigationActive: boolean;
  theme: MapTheme;
  visibility: OutdoorLayerVisibility;
}

export interface CompactCarRoute {
  id: string;
  name: string;
  sourceFormat: SavedRouteRecord['sourceFormat'];
  distanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
  color: string;
  visible: boolean;
  geojson: GeoJSON.FeatureCollection;
}

export interface CompactCarPoi {
  id: string;
  nameHe: string;
  nameEn: string;
  category: PoiRecord['category'];
  subcategory: string;
  lon: number;
  lat: number;
  ele: number | null;
  waterStatus: string | null;
  difficulty4x4: string | null;
  descHe: string;
  userNotes: string;
  priority: number;
}

export interface CarSyncStatePayload {
  isNavigationActive: boolean;
  theme: MapTheme;
  visibility: {
    googleSatellite: boolean;
    hillshade: boolean;
    hikingTrails: boolean;
    offroad4x4: boolean;
    pois: boolean;
    poiWater: boolean;
    poiHeritage: boolean;
    poiCampsites: boolean;
    poiOffroad: boolean;
    poiPeaks: boolean;
    poiUser: boolean;
  };
  updatedAt: string;
}

export function serializeCarRoute(route: SavedRouteRecord): CompactCarRoute {
  return {
    id: route.id,
    name: route.name,
    sourceFormat: route.sourceFormat,
    distanceKm: route.distanceKm,
    ascentMeters: route.ascentMeters,
    descentMeters: route.descentMeters,
    minEle: route.minEle,
    maxEle: route.maxEle,
    color: route.color,
    visible: route.visible,
    geojson: route.geojson,
  };
}

/**
 * Extracts user-created POIs, imported community/GPX waypoints, and any bundled POIs
 * whose notes were edited locally so Android Auto can render and search them offline.
 */
export function selectCarSyncablePois(pois: PoiRecord[]): CompactCarPoi[] {
  const result: CompactCarPoi[] = [];
  for (const p of pois) {
    const isCustomOrImported =
      p.category === 'user' ||
      p.id.startsWith('user-poi-') ||
      p.id.startsWith('import-') ||
      p.id.startsWith('il-poi-') ||
      Boolean(p.userNotes && p.userNotes.trim().length > 0);
    if (!isCustomOrImported) continue;
    result.push({
      id: p.id,
      nameHe: p.nameHe || p.name,
      nameEn: p.nameEn || p.name || p.nameHe,
      category: p.category,
      subcategory: p.subcategory || 'poi',
      lon: p.lon,
      lat: p.lat,
      ele: typeof p.ele === 'number' ? p.ele : null,
      waterStatus: p.waterStatus ?? null,
      difficulty4x4: p.difficulty4x4 ?? null,
      descHe: p.descHe || '',
      userNotes: p.userNotes || '',
      priority: typeof p.priority === 'number' ? p.priority : 15,
    });
  }
  return result;
}

export function buildCarSyncPayload(input: CarSyncSnapshotInput): {
  activeRouteJson: string;
  savedRoutesJson: string;
  userPoisJson: string;
  carStateJson: string;
} {
  const activeCompact = input.activeRoute ? serializeCarRoute(input.activeRoute) : null;
  const routesCompact = input.routes.map(serializeCarRoute);
  const userPois = selectCarSyncablePois(input.pois);
  const carState: CarSyncStatePayload = {
    isNavigationActive: input.isNavigationActive,
    theme: input.theme,
    visibility: {
      googleSatellite: !!input.visibility.googleSatellite,
      hillshade: !!input.visibility.hillshade,
      hikingTrails: !!input.visibility.hikingTrails,
      offroad4x4: !!input.visibility.offroad4x4,
      pois: !!input.visibility.pois,
      poiWater: !!input.visibility.poiWater,
      poiHeritage: !!input.visibility.poiHeritage,
      poiCampsites: !!input.visibility.poiCampsites,
      poiOffroad: !!input.visibility.poiOffroad,
      poiPeaks: !!input.visibility.poiPeaks,
      poiUser: input.visibility.poiUser ?? true,
    },
    updatedAt: new Date().toISOString(),
  };

  return {
    activeRouteJson: JSON.stringify(activeCompact),
    savedRoutesJson: JSON.stringify(routesCompact),
    userPoisJson: JSON.stringify(userPois),
    carStateJson: JSON.stringify(carState),
  };
}

class CarSyncServiceImpl {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPayloads = {
    activeRouteJson: '',
    savedRoutesJson: '',
    userPoisJson: '',
    carStateJson: '',
  };

  scheduleSync(input: CarSyncSnapshotInput, debounceMs = 250): void {
    if (!NativeOfflineStorage.isAndroidNative()) return;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow(input);
    }, debounceMs);
  }

  async syncNow(input: CarSyncSnapshotInput): Promise<void> {
    if (!NativeOfflineStorage.isAndroidNative()) return;
    try {
      const next = buildCarSyncPayload(input);
      const delta: {
        activeRouteJson?: string;
        savedRoutesJson?: string;
        userPoisJson?: string;
        carStateJson?: string;
      } = {};
      if (next.activeRouteJson !== this.lastPayloads.activeRouteJson) {
        delta.activeRouteJson = next.activeRouteJson;
      }
      if (next.savedRoutesJson !== this.lastPayloads.savedRoutesJson) {
        delta.savedRoutesJson = next.savedRoutesJson;
      }
      if (next.userPoisJson !== this.lastPayloads.userPoisJson) {
        delta.userPoisJson = next.userPoisJson;
      }
      if (next.carStateJson !== this.lastPayloads.carStateJson) {
        delta.carStateJson = next.carStateJson;
      }
      if (Object.keys(delta).length === 0) return;

      await NativeOfflineStorage.syncCarData(delta);
      this.lastPayloads = next;
    } catch (err) {
      console.warn('[CarSyncService] Failed to sync snapshot to Android Auto storage:', err);
    }
  }

  resetCacheForTesting(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.lastPayloads = {
      activeRouteJson: '',
      savedRoutesJson: '',
      userPoisJson: '',
      carStateJson: '',
    };
  }
}

export const carSyncService = new CarSyncServiceImpl();
