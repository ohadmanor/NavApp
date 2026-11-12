import type { DecodedWay } from '../routing/TileRoadGraphBuilder';

export const TRAIL_ANNOTATION_COLORS = [
  { value: '#dc2626', label: 'Red' },
  { value: '#ea580c', label: 'Orange' },
  { value: '#ca8a04', label: 'Yellow' },
  { value: '#16a34a', label: 'Green' },
  { value: '#2563eb', label: 'Blue' },
  { value: '#7c3aed', label: 'Purple' },
  { value: '#334155', label: 'Black' },
] as const;

export type TrailAnnotationColor = (typeof TRAIL_ANNOTATION_COLORS)[number]['value'];
export type TrailAnnotationStatus = 'active' | 'deleted';
export type TrailAnnotationOperation = 'create' | 'edit' | 'delete' | 'restore' | 'rebind';

export interface TrailAnnotationSnapshot {
  wayIds: string[];
  color: TrailAnnotationColor;
  number: string;
  description: string;
  status: TrailAnnotationStatus;
  geometryPath: string;
  selectionReleaseId: string;
}

export interface TrailAnnotationRecord extends TrailAnnotationSnapshot {
  id: string;
  schemaVersion: 1;
  revision: number;
  lastHistoryId: string;
  createdByUid: string;
  createdAt: string;
  updatedByUid: string;
  updatedAt: string;
}

export interface TrailAnnotationHistoryRecord {
  id: string;
  revision: number;
  operation: TrailAnnotationOperation;
  actorUid: string;
  occurredAt: string;
  previous: TrailAnnotationSnapshot | null;
  next: TrailAnnotationSnapshot;
  reason: string;
}

export interface TrailWayGeometry {
  wayId: string;
  geometry: GeoJSON.MultiLineString;
  releaseId: string;
  layer: number;
  highwayClass: string;
  highwaySubclass: string;
}

export interface TrailWayCandidate {
  wayId: string;
  lon: number;
  lat: number;
  highwayClass: string;
  highwaySubclass: string;
  layer: number;
}

export interface TrailGeometryCacheRecord extends TrailWayGeometry {
  id: string;
}

export interface TrailAnnotationDraftRecord {
  id: string;
  ownerUid: string;
  trailId: string | null;
  wayIds: string[];
  color: TrailAnnotationColor;
  number: string;
  description: string;
  reason: string;
  updatedAt: string;
}

export interface ResolvedTrailWay extends TrailWayGeometry {
  fragments: DecodedWay[];
}

export const TRAIL_ANNOTATION_LIMITS = {
  maxWayIds: 500,
  maxNumberLength: 32,
  maxDescriptionLength: 4000,
  maxReasonLength: 500,
  maxWayTiles: 256,
  maxGeometryBytes: 8 * 1024 * 1024,
} as const;

export function isTrailAnnotationColor(value: unknown): value is TrailAnnotationColor {
  return TRAIL_ANNOTATION_COLORS.some((color) => color.value === value);
}

export function trailWayIdFromMvtId(featureId: unknown): string | null {
  if (
    (typeof featureId !== 'number' && typeof featureId !== 'string') ||
    !/^[1-9]\d*$/.test(String(featureId))
  ) {
    return null;
  }
  const parsed = Number(featureId);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return `osm:way:${parsed}`;
}

export function parseTrailWayId(wayId: string): number | null {
  const match = /^osm:way:([1-9]\d*)$/.exec(wayId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export function validateTrailAnnotationInput(input: {
  wayIds: string[];
  color: unknown;
  number: string;
  description: string;
  reason?: string;
}): string | null {
  if (!Array.isArray(input.wayIds) || input.wayIds.length === 0) {
    return 'Select at least one complete highway way.';
  }
  if (input.wayIds.length > TRAIL_ANNOTATION_LIMITS.maxWayIds) {
    return `A trail can include at most ${TRAIL_ANNOTATION_LIMITS.maxWayIds} ways.`;
  }
  if (new Set(input.wayIds).size !== input.wayIds.length) {
    return 'A highway way cannot be added more than once.';
  }
  if (input.wayIds.some((wayId) => parseTrailWayId(wayId) === null)) {
    return 'One or more selected highway IDs are invalid.';
  }
  if (!isTrailAnnotationColor(input.color)) return 'Choose a supported trail color.';
  const number = input.number.trim();
  if (!number || number.length > TRAIL_ANNOTATION_LIMITS.maxNumberLength) {
    return `Enter a trail number (up to ${TRAIL_ANNOTATION_LIMITS.maxNumberLength} characters).`;
  }
  if (input.description.length > TRAIL_ANNOTATION_LIMITS.maxDescriptionLength) {
    return `Description must be at most ${TRAIL_ANNOTATION_LIMITS.maxDescriptionLength} characters.`;
  }
  if ((input.reason?.length ?? 0) > TRAIL_ANNOTATION_LIMITS.maxReasonLength) {
    return `Edit reason must be at most ${TRAIL_ANNOTATION_LIMITS.maxReasonLength} characters.`;
  }
  return null;
}

export function getTrailGeometryCacheId(releaseId: string, wayId: string): string {
  return `${releaseId}|${wayId}`;
}
