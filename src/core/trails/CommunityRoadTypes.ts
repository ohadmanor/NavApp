import type { TrailAnnotationColor } from './TrailAnnotationTypes';

export const COMMUNITY_HIGHWAY_GROUPS = [
  {
    groupLabelHe: 'שטח ושבילים',
    items: [
      { value: 'track', labelHe: 'דרך עפר / 4x4 (track)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'path', labelHe: 'שביל שטח (path)', default4x4: false, defaultFoot: true, defaultBicycle: true },
      { value: 'footway', labelHe: 'שביל הולכי רגל (footway)', default4x4: false, defaultFoot: true, defaultBicycle: false },
      { value: 'cycleway', labelHe: 'שביל אופניים (cycleway)', default4x4: false, defaultFoot: true, defaultBicycle: true },
      { value: 'bridleway', labelHe: 'שביל סוסים (bridleway)', default4x4: false, defaultFoot: true, defaultBicycle: true },
      { value: 'steps', labelHe: 'מדרגות (steps)', default4x4: false, defaultFoot: true, defaultBicycle: false },
      { value: 'pedestrian', labelHe: 'מדרחוב (pedestrian)', default4x4: false, defaultFoot: true, defaultBicycle: false },
    ],
  },
  {
    groupLabelHe: 'כבישים ורחובות',
    items: [
      { value: 'service', labelHe: 'דרך שירות (service)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'unclassified', labelHe: 'כביש מקומי לא מסווג (unclassified)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'residential', labelHe: 'רחוב מגורים (residential)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'living_street', labelHe: 'רחוב משולב (living_street)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'tertiary', labelHe: 'כביש מקומי (tertiary)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'secondary', labelHe: 'כביש אזורי (secondary)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'primary', labelHe: 'כביש ראשי (primary)', default4x4: true, defaultFoot: true, defaultBicycle: true },
      { value: 'trunk', labelHe: 'כביש בין-עירוני ראשי (trunk)', default4x4: true, defaultFoot: false, defaultBicycle: false },
      { value: 'motorway', labelHe: 'כביש מהיר (motorway)', default4x4: true, defaultFoot: false, defaultBicycle: false },
    ],
  },
] as const;

export type CommunityHighwayClass =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'unclassified'
  | 'residential'
  | 'living_street'
  | 'service'
  | 'track'
  | 'path'
  | 'footway'
  | 'cycleway'
  | 'bridleway'
  | 'pedestrian'
  | 'steps';

export const COMMUNITY_HIGHWAY_CLASSES: readonly CommunityHighwayClass[] = COMMUNITY_HIGHWAY_GROUPS.flatMap(
  (group) => group.items.map((item) => item.value as CommunityHighwayClass)
);

export const COMMUNITY_TRACK_TYPES = ['grade1', 'grade2', 'grade3', 'grade4', 'grade5'] as const;
export type CommunityTrackType = (typeof COMMUNITY_TRACK_TYPES)[number] | '';

export const COMMUNITY_SURFACE_TYPES = [
  '',
  'paved',
  'asphalt',
  'concrete',
  'gravel',
  'dirt',
  'sand',
  'rock',
  'ground',
] as const;

export type CommunityRoadKind = 'new' | 'osm-override';
export type CommunityRoadStatus = 'active' | 'deleted';
export type CommunityRoadOperation = 'create' | 'edit' | 'delete' | 'restore' | 'osm-sync';
export type CommunityRoadCloudSyncStatus = 'pending' | 'synced' | 'error';

export interface OsmSyncMetadata {
  changesetId: number;
  osmWayId: number;
  osmVersion: number;
  syncedRevision: number;
  syncedAt: string;
  syncedByUid: string;
  syncedByName: string;
  osmUsername?: string;
}

export interface RoadConnectionAnchor {
  vertexIndex: number;
  targetWayId: string;
  coord: [number, number];
  gx: number;
  gy: number;
  snapType: 'vertex' | 'segment';
}

export interface CommunityRoadSnapshot {
  kind: CommunityRoadKind;
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>;
  bounds: [number, number, number, number];
  highwayClass: CommunityHighwayClass;
  tracktype?: CommunityTrackType;
  surface?: string;
  name: string;
  description: string;
  oneway: -1 | 0 | 1;
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
  anchors: RoadConnectionAnchor[];
  trailColor?: TrailAnnotationColor | '';
  trailNumber?: string;
  trailName?: string;
  status: CommunityRoadStatus;
  /**
   * Tombstone for a whole OSM way (`kind === 'osm-override'` only): the way is hidden from the map,
   * routing and snapping, and nothing is drawn in its place. The geometry is kept so it can be restored.
   * Differs from `status: 'deleted'`, which discards the override and brings the original OSM way back.
   */
  removed?: boolean;
}

export interface CommunityRoadRecord extends CommunityRoadSnapshot {
  id: string;
  schemaVersion: 1;
  revision: number;
  lastHistoryId: string;
  createdByUid: string;
  createdAt: string;
  updatedByUid: string;
  updatedAt: string;
  cloudSyncStatus?: CommunityRoadCloudSyncStatus;
  cloudSyncError?: string;
  osmSync?: OsmSyncMetadata;
}

export interface CommunityRoadHistoryRecord {
  id: string;
  revision: number;
  operation: CommunityRoadOperation;
  actorUid: string;
  occurredAt: string;
  previous: CommunityRoadSnapshot | null;
  next: CommunityRoadSnapshot;
  reason: string;
}

export interface CommunityRoadDraftRecord {
  id: string;
  ownerUid: string;
  roadId: string | null;
  kind: CommunityRoadKind;
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>;
  highwayClass: CommunityHighwayClass;
  tracktype: CommunityTrackType;
  surface: string;
  name: string;
  description: string;
  oneway: -1 | 0 | 1;
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
  anchors: RoadConnectionAnchor[];
  reason: string;
  updatedAt: string;
}

export const COMMUNITY_ROAD_LIMITS = {
  minPoints: 2,
  maxPoints: 2000,
  minLengthMeters: 5,
  maxLengthMeters: 50_000,
  maxNameLength: 120,
  maxDescriptionLength: 4000,
  maxReasonLength: 500,
  maxSurfaceLength: 40,
} as const;

export function isCommunityHighwayClass(value: unknown): value is CommunityHighwayClass {
  return typeof value === 'string' && (COMMUNITY_HIGHWAY_CLASSES as readonly string[]).includes(value);
}

export function getDefaultAccessForHighwayClass(cls: CommunityHighwayClass): {
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
} {
  for (const group of COMMUNITY_HIGHWAY_GROUPS) {
    for (const item of group.items) {
      if (item.value === cls) {
        return {
          allow4x4: item.default4x4,
          allowFoot: item.defaultFoot,
          allowBicycle: item.defaultBicycle,
        };
      }
    }
  }
  return { allow4x4: true, allowFoot: true, allowBicycle: true };
}

export function getHighwayClassLabelHe(cls: CommunityHighwayClass): string {
  for (const group of COMMUNITY_HIGHWAY_GROUPS) {
    for (const item of group.items) {
      if (item.value === cls) return item.labelHe;
    }
  }
  return cls;
}

export function communityRoadWayId(roadId: string): string {
  return `community:road:${roadId}`;
}

export function parseCommunityRoadWayId(wayId: string): string | null {
  const match = /^community:road:([A-Za-z0-9_-]{4,128})$/.exec(wayId);
  return match ? match[1] : null;
}

export function computeRoadBounds(coordinates: Array<[number, number]>): [number, number, number, number] {
  if (coordinates.length === 0) return [0, 0, 0, 0];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function haversineMetersLocal(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const h = sinHalfLat * sinHalfLat + Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function computePolylineLengthMeters(coordinates: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    total += haversineMetersLocal(coordinates[i - 1], coordinates[i]);
  }
  return total;
}

export function validateCommunityRoadInput(input: {
  kind: CommunityRoadKind;
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>;
  highwayClass: unknown;
  name?: string;
  description?: string;
  reason?: string;
  surface?: string;
  anchors: RoadConnectionAnchor[];
  allow4x4: boolean;
  allowFoot: boolean;
  allowBicycle: boolean;
}): string | null {
  if (input.kind !== 'new' && input.kind !== 'osm-override') {
    return 'Invalid community road kind.';
  }
  if (input.kind === 'osm-override' && (!input.sourceOsmWayId || !/^osm:way:[1-9]\d*$/.test(input.sourceOsmWayId))) {
    return 'Editing an existing OSM highway requires a valid OSM way ID.';
  }
  if (!Array.isArray(input.coordinates) || input.coordinates.length < COMMUNITY_ROAD_LIMITS.minPoints) {
    return 'יש לשרטט לפחות 2 נקודות עבור הדרך.';
  }
  if (input.coordinates.length > COMMUNITY_ROAD_LIMITS.maxPoints) {
    return `דרך יכולה להכיל עד ${COMMUNITY_ROAD_LIMITS.maxPoints} נקודות.`;
  }
  for (const pt of input.coordinates) {
    if (
      !Array.isArray(pt) ||
      pt.length !== 2 ||
      !Number.isFinite(pt[0]) ||
      !Number.isFinite(pt[1]) ||
      pt[0] < -180 ||
      pt[0] > 180 ||
      pt[1] < -90 ||
      pt[1] > 90
    ) {
      return 'אחת מנקודות הקואורדינטות אינה תקינה.';
    }
  }
  const lengthMeters = computePolylineLengthMeters(input.coordinates);
  if (lengthMeters < COMMUNITY_ROAD_LIMITS.minLengthMeters) {
    return `אורך הדרך חייב להיות לפחות ${COMMUNITY_ROAD_LIMITS.minLengthMeters} מטרים.`;
  }
  if (lengthMeters > COMMUNITY_ROAD_LIMITS.maxLengthMeters) {
    return 'אורך הדרך חורג מהמותר (עד 50 ק"מ למקטע).';
  }
  if (input.kind === 'new' && (!Array.isArray(input.anchors) || input.anchors.length === 0)) {
    return 'יש לחבר לפחות קצה אחד של הדרך החדשה לדרך קיימת במפה.';
  }
  if (!isCommunityHighwayClass(input.highwayClass)) {
    return 'סוג הדרך שנבחר אינו חוקי.';
  }
  if (!input.allow4x4 && !input.allowFoot && !input.allowBicycle) {
    return 'יש לסמן לפחות הרשאת מעבר אחת (4x4, הליכה או אופניים).';
  }
  if ((input.name?.length ?? 0) > COMMUNITY_ROAD_LIMITS.maxNameLength) {
    return `שם הדרך מוגבל ל-${COMMUNITY_ROAD_LIMITS.maxNameLength} תווים.`;
  }
  if ((input.description?.length ?? 0) > COMMUNITY_ROAD_LIMITS.maxDescriptionLength) {
    return `תיאור הדרך מוגבל ל-${COMMUNITY_ROAD_LIMITS.maxDescriptionLength} תווים.`;
  }
  if ((input.reason?.length ?? 0) > COMMUNITY_ROAD_LIMITS.maxReasonLength) {
    return `סיבת השינוי מוגבלת ל-${COMMUNITY_ROAD_LIMITS.maxReasonLength} תווים.`;
  }
  if ((input.surface?.length ?? 0) > COMMUNITY_ROAD_LIMITS.maxSurfaceLength) {
    return `סוג פני השטח מוגבל ל-${COMMUNITY_ROAD_LIMITS.maxSurfaceLength} תווים.`;
  }
  return null;
}

/** True for an active tombstone that removes a whole OSM way from the map and routing. */
export function isRemovedOsmRoad(
  road: Pick<CommunityRoadRecord, 'status' | 'kind' | 'removed'>
): boolean {
  return road.status === 'active' && road.kind === 'osm-override' && road.removed === true;
}

/**
 * Extracts deduplicated positive numeric OSM way IDs overridden by active `osm-override` community roads
 * (including removed-road tombstones, whose OSM way must stay hidden).
 */
export function extractOverriddenOsmWayIds(
  roads: ReadonlyArray<Pick<CommunityRoadRecord, 'status' | 'kind' | 'sourceOsmWayId'>>
): number[] {
  const ids = new Set<number>();
  for (const road of roads) {
    if (road.status !== 'active' || road.kind !== 'osm-override' || !road.sourceOsmWayId) {
      continue;
    }
    const raw = road.sourceOsmWayId.replace('osm:way:', '');
    const id = Number(raw);
    if (Number.isSafeInteger(id) && id > 0) {
      ids.add(id);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

const TRAIL_COLOUR_NAME_BY_HEX: Record<string, string> = {
  '#dc2626': 'red',
  '#2563eb': 'blue',
  '#16a34a': 'green',
  '#334155': 'black',
};

/**
 * Tags a community road the way the base vector tiles tag an OSM highway (`class`, `subclass`,
 * `colour`), so the base-map road layers can draw it exactly like the roads around it.
 */
export function toBaseMapRoadTags(
  road: Pick<CommunityRoadSnapshot, 'highwayClass' | 'trailColor'>
): { class: string; subclass?: string; colour?: string } {
  const colourName = TRAIL_COLOUR_NAME_BY_HEX[road.trailColor || ''];
  const colour = colourName ? { colour: colourName } : {};
  switch (road.highwayClass) {
    case 'unclassified':
    case 'residential':
    case 'living_street':
      return { class: 'minor', subclass: road.highwayClass, ...colour };
    case 'path':
    case 'footway':
    case 'cycleway':
    case 'bridleway':
    case 'steps':
    case 'pedestrian':
      return { class: 'path', subclass: road.highwayClass, ...colour };
    default:
      return { class: road.highwayClass, ...colour };
  }
}

/**
 * Converts active community road records into the GeoJSON FeatureCollection rendered by MapLibre.
 */
export function buildCommunityRoadsGeoJSON(
  roads: readonly CommunityRoadRecord[]
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const road of roads) {
    if (road.status !== 'active' || road.coordinates.length < 2) continue;
    if (isRemovedOsmRoad(road)) continue;
    features.push({
      type: 'Feature',
      properties: {
        ...toBaseMapRoadTags(road),
        roadId: road.id,
        kind: road.kind,
        highwayClass: road.highwayClass,
        tracktype: road.tracktype || '',
        name: road.name || '',
        trailColor: road.trailColor || '',
        trailNumber: road.trailNumber || '',
        trailName: road.trailName || '',
      },
      geometry: {
        type: 'LineString',
        coordinates: road.coordinates,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Removed OSM roads as line features (`role: 'removed-road'`), drawn as ghosts in road-edit mode so
 * they can be selected and restored.
 */
export function buildRemovedRoadFeatures(
  roads: readonly CommunityRoadRecord[],
  excludeRoadId?: string | null
): GeoJSON.Feature[] {
  const features: GeoJSON.Feature[] = [];
  for (const road of roads) {
    if (!isRemovedOsmRoad(road) || road.coordinates.length < 2 || road.id === excludeRoadId) continue;
    features.push({
      type: 'Feature',
      properties: { role: 'removed-road', roadId: road.id },
      geometry: { type: 'LineString', coordinates: road.coordinates },
    });
  }
  return features;
}

/**
 * Filters out community-trail annotation features whose underlying way is superseded by an active community road.
 */
export function filterTrailOverlayByCommunityRoads(
  trailOverlay: GeoJSON.FeatureCollection,
  roads: ReadonlyArray<Pick<CommunityRoadRecord, 'id' | 'status' | 'kind' | 'sourceOsmWayId'>>
): GeoJSON.FeatureCollection {
  const overriddenTrailWayIds = new Set<string>();
  for (const road of roads) {
    if (road.status !== 'active') continue;
    overriddenTrailWayIds.add(`community:road:${road.id}`);
    if (road.kind === 'osm-override' && road.sourceOsmWayId) {
      overriddenTrailWayIds.add(road.sourceOsmWayId);
    }
  }
  if (overriddenTrailWayIds.size === 0) {
    return trailOverlay;
  }
  return {
    type: 'FeatureCollection',
    features: trailOverlay.features.filter((f) => {
      const wid = f.properties?.wayId;
      return typeof wid !== 'string' || !overriddenTrailWayIds.has(wid);
    }),
  };
}
