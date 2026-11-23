import { communityRoadsCloudService } from '../firebase/CommunityRoadsCloudService';
import {
  lonLatToGlobalPixel,
  lonLatToTile,
  ROUTING_TILE_ZOOM,
  TileRoadGraphBuilder,
  haversineMeters,
  type DecodedWay,
} from './TileRoadGraphBuilder';
import { evaluateEdgeAccess } from './RoutingProfiles';
import { isRemovedOsmRoad } from '../trails/CommunityRoadTypes';

export interface RoadSnapCandidate {
  coord: [number, number];
  gx: number;
  gy: number;
  targetWayId: string;
  roadLabel: string;
  highwayClass: string;
  distMeters: number;
  snapType: 'vertex' | 'segment';
}

const SNAP_TILE_BUILDER = new TileRoadGraphBuilder({ maxCachedTiles: 128 });

function projectOntoSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { lon: number; lat: number; distMeters: number; t: number } {
  const meanLatRad = (((ay + by) / 2) * Math.PI) / 180;
  const metersPerDegLat = 111132.954;
  const metersPerDegLon = 111319.49 * Math.cos(meanLatRad);
  const abx = (bx - ax) * metersPerDegLon;
  const aby = (by - ay) * metersPerDegLat;
  const apx = (px - ax) * metersPerDegLon;
  const apy = (py - ay) * metersPerDegLat;
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq <= 1e-9) {
    return { lon: ax, lat: ay, distMeters: Math.hypot(apx, apy), t: 0 };
  }
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const lon = ax + t * (bx - ax);
  const lat = ay + t * (by - ay);
  const dx = (px - lon) * metersPerDegLon;
  const dy = (py - lat) * metersPerDegLat;
  return { lon, lat, distMeters: Math.hypot(dx, dy), t };
}

function getTargetWayId(way: DecodedWay): string {
  if (way.featureId.startsWith('community:road:')) return way.featureId;
  if (/^[1-9]\d*$/.test(way.featureId)) return `osm:way:${way.featureId}`;
  return way.featureId;
}

function getWayLabel(way: DecodedWay): string {
  const name = typeof way.props.name === 'string' && way.props.name.trim() ? way.props.name.trim() : '';
  const footAccess = evaluateEdgeAccess(way.props, 'foot');
  const carAccess = evaluateEdgeAccess(way.props, '4x4');
  const label = name || carAccess.roadLabel || footAccess.roadLabel || String(way.props.class || 'דרך');
  return label;
}

/** Max ground distance at which a road-editor point snaps onto an existing road segment. */
export const ROAD_SEGMENT_SNAP_METERS = 2;
/** Max ground distance at which a road-editor point snaps onto an existing road vertex. */
export const ROAD_VERTEX_SNAP_METERS = 2;

export async function snapPointToExistingRoads(
  lon: number,
  lat: number,
  maxRadiusMeters = ROAD_SEGMENT_SNAP_METERS,
  vertexSnapMeters = ROAD_VERTEX_SNAP_METERS,
  excludeCommunityRoadId?: string | null,
  excludeOsmWayId?: string | null
): Promise<RoadSnapCandidate | null> {
  const centerTile = lonLatToTile(lon, lat, ROUTING_TILE_ZOOM);
  const tileWays = await SNAP_TILE_BUILDER.getDecodedTileWays(centerTile.tx, centerTile.ty);

  const activeCommunityRoads = communityRoadsCloudService
    .getCachedActiveRoads()
    .filter((r) => r.id !== excludeCommunityRoadId);
  const overriddenOsmIds = new Set<string>();
  if (excludeOsmWayId) {
    overriddenOsmIds.add(excludeOsmWayId.replace('osm:way:', ''));
  }
  for (const r of activeCommunityRoads) {
    if (r.kind === 'osm-override' && r.sourceOsmWayId) {
      overriddenOsmIds.add(r.sourceOsmWayId.replace('osm:way:', ''));
    }
  }

  const candidateWays: DecodedWay[] = [];
  for (const way of tileWays) {
    if (overriddenOsmIds.has(way.featureId)) continue;
    const cls = String(way.props.class || '').toLowerCase();
    if (!cls || cls === 'rail' || cls === 'ferry' || cls === 'pier' || cls === 'aerialway') continue;
    if (way.points.length >= 2) candidateWays.push(way);
  }
  for (const road of activeCommunityRoads) {
    // Removed roads keep their OSM way excluded above but are not something to snap onto
    if (isRemovedOsmRoad(road)) continue;
    candidateWays.push({
      featureId: `community:road:${road.id}`,
      layer: 0,
      props: { class: road.highwayClass, name: road.name, tracktype: road.tracktype || '' },
      points: road.coordinates.map(([rlon, rlat]) => {
        const { gx, gy } = lonLatToGlobalPixel(rlon, rlat);
        return { gx, gy, lon: rlon, lat: rlat, isClipped: false };
      }),
    });
  }

  let bestVertex: RoadSnapCandidate | null = null;
  let bestSegment: RoadSnapCandidate | null = null;

  for (const way of candidateWays) {
    const targetWayId = getTargetWayId(way);
    const roadLabel = getWayLabel(way);
    const highwayClass = String(way.props.class || '');

    for (const pt of way.points) {
      const dist = haversineMeters([lon, lat], [pt.lon, pt.lat]);
      if (dist <= vertexSnapMeters && (!bestVertex || dist < bestVertex.distMeters)) {
        bestVertex = {
          coord: [pt.lon, pt.lat],
          gx: pt.gx,
          gy: pt.gy,
          targetWayId,
          roadLabel,
          highwayClass,
          distMeters: Math.round(dist),
          snapType: 'vertex',
        };
      }
    }

    for (let i = 0; i < way.points.length - 1; i++) {
      const a = way.points[i];
      const b = way.points[i + 1];
      const proj = projectOntoSegment(lon, lat, a.lon, a.lat, b.lon, b.lat);
      if (proj.distMeters <= maxRadiusMeters && (!bestSegment || proj.distMeters < bestSegment.distMeters)) {
        const { gx, gy } = lonLatToGlobalPixel(proj.lon, proj.lat);
        bestSegment = {
          coord: [Number(proj.lon.toFixed(6)), Number(proj.lat.toFixed(6))],
          gx,
          gy,
          targetWayId,
          roadLabel,
          highwayClass,
          distMeters: Math.round(proj.distMeters),
          snapType: 'segment',
        };
      }
    }
  }

  return bestVertex ?? bestSegment;
}
