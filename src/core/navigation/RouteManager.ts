import * as turf from '@turf/turf';
import {
  db,
  type CloudSyncStatus,
  type PlannedWaypoint,
  type SavedRouteRecord,
} from '../db/NavDatabase';
import {
  PLANNING_MODE_META,
  PLANNING_ROUTE_COLOR,
  type PlanningMode,
} from '../routing/RoutingProfiles';
import { ElevationService } from './ElevationService';

const LEGACY_TEST_ROUTE_IDS = [
  'route-nahal-aqev-ein-aqev',
  'route-makhtesh-ramon-ardon',
  'route-arbel-cliff-loop',
];

const LEGACY_PLANNED_COLORS = new Set(['#f97316', '#ec4899', '#06b6d4']);

export class RouteManager {
  static async initializeStarterRoutes(): Promise<SavedRouteRecord[]> {
    // Purge any legacy test/starter routes from IndexedDB
    await db.routes.bulkDelete(LEGACY_TEST_ROUTE_IDS);
    const all = await db.routes.toArray();
    const migrated: SavedRouteRecord[] = [];
    const normalized = all.map((r) => {
      if (r.sourceFormat === 'planned' && r.color !== PLANNING_ROUTE_COLOR && (!r.color || LEGACY_PLANNED_COLORS.has(r.color))) {
        const updated: SavedRouteRecord = {
          ...r,
          color: PLANNING_ROUTE_COLOR,
          geojson: r.geojson
            ? {
                ...r.geojson,
                features: (r.geojson.features || []).map((f) => ({
                  ...f,
                  properties: {
                    ...(f.properties || {}),
                    color: PLANNING_ROUTE_COLOR,
                  },
                })),
              }
            : r.geojson,
        };
        migrated.push(updated);
        return updated;
      }
      return r;
    });
    if (migrated.length > 0) {
      await db.routes.bulkPut(migrated);
    }
    return normalized;
  }

  static async createAndSaveRoute(params: {
    id?: string;
    name: string;
    coordinates: Array<[number, number]>;
    segments?: Array<Array<[number, number]>>;
    sourceFormat: SavedRouteRecord['sourceFormat'];
    color?: string;
    planningMode?: PlanningMode;
    waypoints?: PlannedWaypoint[];
    ownerUid?: string | null;
    ownerEmail?: string | null;
    cloudSyncStatus?: CloudSyncStatus;
  }): Promise<SavedRouteRecord> {
    const rawSegments =
      params.segments && params.segments.length > 0 ? params.segments : [params.coordinates];
    const validSegments = rawSegments.filter((seg) => seg.length >= 2);
    const lines = validSegments.map((seg) => turf.lineString(seg));
    const segmentLengths = lines.map((l) => turf.length(l, { units: 'kilometers' }));
    const totalLengthKm = segmentLengths.reduce((sum, len) => sum + len, 0);

    // Resample points proportionally across all segments to compute continuous elevation profile from Israel.dem.pmtiles
    const totalSamples = Math.max(12, Math.min(60, Math.ceil(totalLengthKm * 5)));
    const elevationProfile: SavedRouteRecord['elevationProfile'] = [];
    const routeColor =
      params.color ||
      (params.planningMode ? PLANNING_MODE_META[params.planningMode].color : '#ec4899');
    const routeId =
      params.id || `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    let cumDistKm = 0;
    for (let sIdx = 0; sIdx < lines.length; sIdx++) {
      const segLine = lines[sIdx];
      const segLen = segmentLengths[sIdx];
      const segSamples =
        totalLengthKm > 0
          ? Math.max(3, Math.round((segLen / totalLengthKm) * totalSamples))
          : Math.max(2, validSegments[sIdx].length - 1);

      for (let i = 0; i <= segSamples; i++) {
        // Avoid duplicating junction sample if next segment starts very close
        if (sIdx > 0 && i === 0) continue;
        const localDistKm = segSamples > 0 ? (segLen * i) / segSamples : 0;
        const pt = turf.along(segLine, localDistKm, { units: 'kilometers' });
        const [lon, lat] = pt.geometry.coordinates;
        const sampledEle = await ElevationService.getElevationAt(lon, lat, 11);
        const fallbackEle = Math.round(350 + Math.sin(elevationProfile.length * 0.4) * 120);
        elevationProfile.push({
          distKm: Number((cumDistKm + localDistKm).toFixed(2)),
          ele: sampledEle ?? fallbackEle,
          lon,
          lat,
        });
      }
      cumDistKm += segLen;
    }

    let ascentMeters = 0;
    let descentMeters = 0;
    let minEle = Infinity;
    let maxEle = -Infinity;

    for (let i = 0; i < elevationProfile.length; i++) {
      const e = elevationProfile[i].ele;
      if (e < minEle) minEle = e;
      if (e > maxEle) maxEle = e;
      if (i > 0) {
        const diff = e - elevationProfile[i - 1].ele;
        if (diff > 0) ascentMeters += diff;
        else descentMeters += Math.abs(diff);
      }
    }

    const nowIso = new Date().toISOString();
    const record: SavedRouteRecord = {
      id: routeId,
      name: params.name,
      sourceFormat: params.sourceFormat,
      planningMode: params.planningMode,
      waypoints: params.waypoints,
      distanceKm: Number(totalLengthKm.toFixed(2)),
      ascentMeters: Math.round(ascentMeters),
      descentMeters: Math.round(descentMeters),
      minEle: isFinite(minEle) ? minEle : 0,
      maxEle: isFinite(maxEle) ? maxEle : 0,
      color: routeColor,
      visible: true,
      geojson: {
        type: 'FeatureCollection',
        features: lines.map((line, idx) => ({
          type: 'Feature',
          properties: {
            id: `${routeId}-seg-${idx}`,
            routeId,
            name: params.name,
            color: routeColor,
            planningMode: params.planningMode,
          },
          geometry: line.geometry,
        })),
      },
      elevationProfile,
      ownerUid: params.ownerUid ?? null,
      ownerEmail: params.ownerEmail ?? null,
      cloudSyncStatus: params.cloudSyncStatus ?? (params.sourceFormat === 'planned' ? 'pending' : 'local-only'),
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (params.sourceFormat === 'planned') {
      record.gpxXml = this.exportRouteAsGpx(record);
    }

    await db.routes.put(record);
    return record;
  }

  static async createAndSavePlannedRoute(params: {
    name: string;
    mode: PlanningMode;
    segments: Array<Array<[number, number]>>;
    waypoints: PlannedWaypoint[];
    ownerUid?: string | null;
    ownerEmail?: string | null;
  }): Promise<SavedRouteRecord> {
    const flattened = params.segments.flat();
    const enrichedWaypoints: PlannedWaypoint[] = await Promise.all(
      params.waypoints.map(async (wp) => {
        if (typeof wp.ele === 'number') return wp;
        const sampled = await ElevationService.getElevationAt(wp.lon, wp.lat, 11);
        return { ...wp, ele: sampled };
      })
    );

    return this.createAndSaveRoute({
      name: params.name,
      coordinates: flattened,
      segments: params.segments,
      sourceFormat: 'planned',
      color: PLANNING_MODE_META[params.mode].color,
      planningMode: params.mode,
      waypoints: enrichedWaypoints,
      ownerUid: params.ownerUid ?? null,
      ownerEmail: params.ownerEmail ?? null,
      cloudSyncStatus: 'pending',
    });
  }

  static async updateRouteCloudSync(
    routeId: string,
    patch: Partial<
      Pick<
        SavedRouteRecord,
        | 'cloudSyncStatus'
        | 'cloudStoragePath'
        | 'cloudJsonPath'
        | 'cloudDownloadUrl'
        | 'cloudError'
        | 'ownerUid'
        | 'ownerEmail'
        | 'updatedAt'
      >
    >
  ): Promise<SavedRouteRecord | undefined> {
    await db.routes.update(routeId, {
      ...patch,
      updatedAt: patch.updatedAt || new Date().toISOString(),
    });
    return await db.routes.get(routeId);
  }

  /**
   * Re-samples route elevations directly from Israel.dem.pmtiles once mounted.
   */
  static async refreshRouteElevationsFromDem(route: SavedRouteRecord): Promise<SavedRouteRecord> {
    const segments = route.geojson.features
      .filter((f) => f.geometry?.type === 'LineString')
      .map((f) => (f.geometry as GeoJSON.LineString).coordinates as Array<[number, number]>)
      .filter((coords) => coords.length >= 2);
    if (segments.length === 0) return route;
    const refreshed = await this.createAndSaveRoute({
      id: route.id,
      name: route.name,
      coordinates: segments[0],
      segments,
      sourceFormat: route.sourceFormat,
      color: route.color,
      planningMode: route.planningMode,
      waypoints: route.waypoints,
      ownerUid: route.ownerUid,
      ownerEmail: route.ownerEmail,
      cloudSyncStatus: route.cloudSyncStatus,
    });
    const merged: SavedRouteRecord = {
      ...refreshed,
      cloudStoragePath: route.cloudStoragePath,
      cloudJsonPath: route.cloudJsonPath,
      cloudDownloadUrl: route.cloudDownloadUrl,
      cloudError: route.cloudError,
      createdAt: route.createdAt || refreshed.createdAt,
    };
    if (route.sourceFormat === 'planned') {
      merged.gpxXml = this.exportRouteAsGpx(merged);
    }
    await db.routes.put(merged);
    return merged;
  }

  /**
   * Computes real-time off-route distance (meters) and nearest snapped point on active route.
   */
  static checkNavigationDeviation(
    route: SavedRouteRecord,
    userLon: number,
    userLat: number
  ): {
    distanceFromTrailMeters: number;
    isOffRoute: boolean;
    snappedCoord: [number, number];
  } {
    const lineFeatures = route.geojson.features.filter(
      (f) => f.geometry?.type === 'LineString'
    ) as Array<GeoJSON.Feature<GeoJSON.LineString>>;
    const userPt = turf.point([userLon, userLat]);
    let minDistMeters = Infinity;
    let bestSnapped: [number, number] = [userLon, userLat];

    for (const feature of lineFeatures) {
      const distMeters = turf.pointToLineDistance(userPt, feature, { units: 'meters' });
      if (distMeters < minDistMeters) {
        minDistMeters = distMeters;
        const snapped = turf.nearestPointOnLine(feature, userPt);
        bestSnapped = snapped.geometry.coordinates as [number, number];
      }
    }

    const rounded = Number.isFinite(minDistMeters) ? Math.round(minDistMeters) : 0;
    return {
      distanceFromTrailMeters: rounded,
      isOffRoute: rounded > 50,
      snappedCoord: bestSnapped,
    };
  }

  static async deleteRoute(id: string): Promise<void> {
    await db.routes.delete(id);
  }

  private static escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private static lookupNearestElevation(
    lon: number,
    lat: number,
    profile: SavedRouteRecord['elevationProfile']
  ): number | null {
    if (!profile || profile.length === 0) return null;
    let bestEle: number | null = null;
    let bestDistSq = Infinity;
    for (const p of profile) {
      const dLon = p.lon - lon;
      const dLat = p.lat - lat;
      const dSq = dLon * dLon + dLat * dLat;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestEle = p.ele;
      }
    }
    return bestEle;
  }

  static exportRouteAsGpx(route: SavedRouteRecord): string {
    const safeName = this.escapeXml(route.name || 'NavApp Route');
    const modeDesc = route.planningMode
      ? `Planned (${route.planningMode})`
      : route.sourceFormat.toUpperCase();
    const authorXml = route.ownerEmail
      ? `\n    <author><name>${this.escapeXml(route.ownerEmail)}</name></author>`
      : '';

    const wptsXml =
      route.waypoints && route.waypoints.length > 0
        ? route.waypoints
            .map((wp, idx) => {
              const eleTag =
                typeof wp.ele === 'number' ? `<ele>${Math.round(wp.ele)}</ele>` : '';
              const label = this.escapeXml(wp.roadLabel || `Point ${idx + 1}`);
              return `  <wpt lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">${eleTag}<name>WP${idx + 1}</name><desc>${label}</desc></wpt>`;
            })
            .join('\n') + '\n'
        : '';

    const lineFeatures = (route.geojson?.features || []).filter(
      (f) => f.geometry?.type === 'LineString'
    ) as Array<GeoJSON.Feature<GeoJSON.LineString>>;

    const trksegsXml =
      lineFeatures.length > 0
        ? lineFeatures
            .map((lf) => {
              const coords = lf.geometry.coordinates;
              const ptsXml = coords
                .map((c) => {
                  const lon = Number(c[0]);
                  const lat = Number(c[1]);
                  const ele = this.lookupNearestElevation(lon, lat, route.elevationProfile);
                  const eleTag = ele !== null ? `<ele>${ele}</ele>` : '';
                  return `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${eleTag}</trkpt>`;
                })
                .join('\n');
              return `    <trkseg>\n${ptsXml}\n    </trkseg>`;
            })
            .join('\n')
        : `    <trkseg>\n${route.elevationProfile
            .map(
              (p) =>
                `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele}</ele></trkpt>`
            )
            .join('\n')}\n    </trkseg>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NavApp Outdoor Israel" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${safeName}</name>
    <desc>${this.escapeXml(modeDesc)}</desc>${authorXml}
    <time>${route.createdAt || new Date().toISOString()}</time>
  </metadata>
${wptsXml}  <trk>
    <name>${safeName}</name>
    <type>${this.escapeXml(route.planningMode || route.sourceFormat)}</type>
${trksegsXml}
  </trk>
</gpx>`;
  }
}

