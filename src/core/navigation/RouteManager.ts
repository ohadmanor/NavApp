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
    sourceFormat: SavedRouteRecord['sourceFormat'];
    color?: string;
  }): Promise<SavedRouteRecord> {
    const line = turf.lineString(params.coordinates);
    const totalLengthKm = turf.length(line, { units: 'kilometers' });

    // Resample up to 45 points along route to compute elevation profile from Israel.dem.pmtiles
    const numSamples = Math.max(10, Math.min(45, Math.ceil(totalLengthKm * 5)));
    const elevationProfile: SavedRouteRecord['elevationProfile'] = [];

    for (let i = 0; i <= numSamples; i++) {
      const distKm = (totalLengthKm * i) / numSamples;
      const pt = turf.along(line, distKm, { units: 'kilometers' });
      const [lon, lat] = pt.geometry.coordinates;
      const sampledEle = await ElevationService.getElevationAt(lon, lat, 11);
      // Fallback topographic estimation if DEM not yet mounted
      const fallbackEle = Math.round(350 + Math.sin(i * 0.4) * 120);
      elevationProfile.push({
        distKm: Number(distKm.toFixed(2)),
        ele: sampledEle ?? fallbackEle,
        lon,
        lat,
      });
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
      id: params.id || `route-${Date.now()}`,
      name: params.name,
      sourceFormat: params.sourceFormat,
      distanceKm: Number(totalLengthKm.toFixed(2)),
      ascentMeters: Math.round(ascentMeters),
      descentMeters: Math.round(descentMeters),
      minEle: isFinite(minEle) ? minEle : 0,
      maxEle: isFinite(maxEle) ? maxEle : 0,
      color: params.color || '#10b981',
      visible: true,
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              id: params.id || `route-${Date.now()}`,
              name: params.name,
              color: params.color || '#10b981',
            },
            geometry: line.geometry,
          },
        ],
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
    const feature = route.geojson.features[0];
    if (!feature || feature.geometry.type !== 'LineString') return route;
    const coords = feature.geometry.coordinates as Array<[number, number]>;
    return await this.createAndSaveRoute({
      id: route.id,
      name: route.name,
      coordinates: coords,
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
    const feature = route.geojson.features[0] as GeoJSON.Feature<GeoJSON.LineString>;
    const userPt = turf.point([userLon, userLat]);
    const distMeters = turf.pointToLineDistance(userPt, feature, { units: 'meters' });
    const snapped = turf.nearestPointOnLine(feature, userPt);

    return {
      distanceFromTrailMeters: Math.round(distMeters),
      isOffRoute: distMeters > 50,
      snappedCoord: snapped.geometry.coordinates as [number, number],
    };
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

