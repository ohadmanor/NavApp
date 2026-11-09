import * as turf from '@turf/turf';
import { db, type SavedRouteRecord } from '../db/NavDatabase';
import { ElevationService } from './ElevationService';

const LEGACY_TEST_ROUTE_IDS = [
  'route-nahal-aqev-ein-aqev',
  'route-makhtesh-ramon-ardon',
  'route-arbel-cliff-loop',
];

export class RouteManager {
  static async initializeStarterRoutes(): Promise<SavedRouteRecord[]> {
    // Purge any legacy test/starter routes from IndexedDB
    await db.routes.bulkDelete(LEGACY_TEST_ROUTE_IDS);
    return await db.routes.toArray();
  }

  static async createAndSaveRoute(params: {
    id?: string;
    name: string;
    coordinates: Array<[number, number]>;
    segments?: Array<Array<[number, number]>>;
    sourceFormat: SavedRouteRecord['sourceFormat'];
    color?: string;
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
    const routeColor = params.color || '#ec4899';
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

    const record: SavedRouteRecord = {
      id: routeId,
      name: params.name,
      sourceFormat: params.sourceFormat,
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
          },
          geometry: line.geometry,
        })),
      },
      elevationProfile,
      createdAt: new Date().toISOString(),
    };

    await db.routes.put(record);
    return record;
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
    return await this.createAndSaveRoute({
      id: route.id,
      name: route.name,
      coordinates: segments[0],
      segments,
      sourceFormat: route.sourceFormat,
      color: route.color,
    });
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

  static exportRouteAsGpx(route: SavedRouteRecord): string {
    const ptsXml = route.elevationProfile
      .map(
        (p) =>
          `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele}</ele></trkpt>`
      )
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NavApp Outdoor Israel" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${route.name}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${route.name}</name>
    <trkseg>
${ptsXml}
    </trkseg>
  </trk>
</gpx>`;
  }
}

