import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  type DocumentData,
} from 'firebase/firestore';
import { getBytes, ref, uploadString } from 'firebase/storage';
import { db, type MapArchiveRecord } from '../db/NavDatabase';
import type { MountedArchiveInfo } from '../pmtiles/PMTilesRegistry';
import {
  getTrailGeometryCacheId,
  isTrailAnnotationColor,
  parseTrailWayId,
  TRAIL_ANNOTATION_LIMITS,
  validateTrailAnnotationInput,
  type TrailAnnotationHistoryRecord,
  type TrailAnnotationOperation,
  type TrailAnnotationRecord,
  type TrailAnnotationSnapshot,
  type TrailAnnotationDraftRecord,
  type TrailGeometryCacheRecord,
  type TrailWayGeometry,
} from '../trails/TrailAnnotationTypes';
import {
  highwayWayGeometryService,
} from '../trails/HighwayWayGeometryService';
import { AuthService, type NavUser } from './AuthService';
import { getFirebaseServices } from './firebaseApp';

const TRAIL_ANNOTATIONS_COLLECTION = 'trail_annotations';
const MAX_PUBLIC_ANNOTATIONS = 200;
const MAX_HISTORY_PAGE_SIZE = 50;

export interface TrailAnnotationLoadResult {
  annotations: TrailAnnotationRecord[];
  source: 'server' | 'cache';
  warning?: string;
}

export interface TrailAnnotationHistoryPage {
  events: TrailAnnotationHistoryRecord[];
  nextRevision: number | null;
}

export interface TrailGeometryResolution {
  ways: TrailWayGeometry[];
  staleWayIds: string[];
}

export interface SaveTrailAnnotationInput {
  trailId: string | null;
  expectedRevision: number;
  user: NavUser;
  wayIds: string[];
  color: string;
  number: string;
  description: string;
  reason: string;
  releaseId: string;
  geometries: TrailWayGeometry[];
}

export class TrailAnnotationConflictError extends Error {
  constructor(message = 'This trail was edited by someone else. Reload it before saving.') {
    super(message);
    this.name = 'TrailAnnotationConflictError';
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function asIsoString(value: unknown): string {
  if (value && typeof value === 'object' && 'toDate' in value) {
    const date = (value as { toDate: () => Date }).toDate();
    return date.toISOString();
  }
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

function normalizeAnnotation(id: string, value: DocumentData): TrailAnnotationRecord {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.wayIds) ||
    !isTrailAnnotationColor(value.color) ||
    typeof value.number !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.geometryPath !== 'string' ||
    typeof value.selectionReleaseId !== 'string' ||
    (value.status !== 'active' && value.status !== 'deleted') ||
    !Number.isInteger(value.revision) ||
    typeof value.lastHistoryId !== 'string' ||
    typeof value.createdByUid !== 'string' ||
    typeof value.updatedByUid !== 'string'
  ) {
    throw new Error(`Trail annotation "${id}" has an unsupported or invalid format.`);
  }
  return {
    id,
    schemaVersion: 1,
    wayIds: value.wayIds.map(String),
    color: value.color,
    number: value.number,
    description: value.description,
    status: value.status,
    revision: value.revision,
    lastHistoryId: value.lastHistoryId,
    geometryPath: value.geometryPath,
    selectionReleaseId: value.selectionReleaseId,
    createdByUid: value.createdByUid,
    createdAt: asIsoString(value.createdAt),
    updatedByUid: value.updatedByUid,
    updatedAt: asIsoString(value.updatedAt),
  };
}

function snapshot(annotation: TrailAnnotationRecord): TrailAnnotationSnapshot {
  return {
    wayIds: annotation.wayIds,
    color: annotation.color,
    number: annotation.number,
    description: annotation.description,
    status: annotation.status,
    geometryPath: annotation.geometryPath,
    selectionReleaseId: annotation.selectionReleaseId,
  };
}

export function getTrailMapReleaseId(
  info: MountedArchiveInfo | MapArchiveRecord | null | undefined
): string {
  if (!info) return 'osm:unavailable';
  const record = 'record' in info ? info.record : info;
  return `osm:${record.fileName}:${record.createdUtc}:${record.sizeBytes}`;
}

function isValidWayGeometry(value: unknown, expectedWayId: string): value is TrailWayGeometry {
  if (!value || typeof value !== 'object') return false;
  const way = value as TrailWayGeometry;
  return (
    way.wayId === expectedWayId &&
    typeof way.releaseId === 'string' &&
    way.geometry?.type === 'MultiLineString' &&
    Array.isArray(way.geometry.coordinates) &&
    way.geometry.coordinates.every(
      (line) =>
        Array.isArray(line) &&
        line.length >= 2 &&
        line.every(
          (point) =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(point[0]) &&
            Number.isFinite(point[1])
        )
    ) &&
    Number.isInteger(way.layer) &&
    typeof way.highwayClass === 'string' &&
    typeof way.highwaySubclass === 'string'
  );
}

function annotationGeometryCollection(
  annotation: TrailAnnotationRecord,
  ways: TrailWayGeometry[],
  staleWayIds: Set<string>
): GeoJSON.FeatureCollection<GeoJSON.MultiLineString, Record<string, unknown>> {
  const geometryById = new Map(ways.map((way) => [way.wayId, way]));
  return {
    type: 'FeatureCollection',
    features: annotation.wayIds.flatMap((wayId) => {
      const way = geometryById.get(wayId);
      if (!way) return [];
      return [
        {
          type: 'Feature' as const,
          id: `${annotation.id}:${wayId}`,
          geometry: way.geometry,
          properties: {
            trailId: annotation.id,
            wayId,
            number: annotation.number,
            color: annotation.color,
            updatedAt: annotation.updatedAt,
            stale: staleWayIds.has(wayId),
          },
        },
      ];
    }),
  };
}

export class TrailAnnotationsCloudService {
  async loadPublishedAnnotations(): Promise<TrailAnnotationLoadResult> {
    const services = getFirebaseServices();
    if (!services) {
      return {
        annotations: await db.trailAnnotations.toArray(),
        source: 'cache',
        warning: 'Firebase is not configured; showing only annotations saved on this device.',
      };
    }

    try {
      const snapshots = await getDocs(
        query(
          collection(services.firestore, TRAIL_ANNOTATIONS_COLLECTION),
          orderBy('updatedAt', 'desc'),
          limit(MAX_PUBLIC_ANNOTATIONS)
        )
      );
      const annotations = snapshots.docs.map((entry) =>
        normalizeAnnotation(entry.id, entry.data())
      );
      await db.trailAnnotations.bulkPut(annotations);
      return { annotations, source: 'server' };
    } catch (error) {
      const cached = await db.trailAnnotations.toArray();
      if (cached.length === 0) throw error;
      return {
        annotations: cached,
        source: 'cache',
        warning: 'Could not refresh shared annotations; showing the saved local copy.',
      };
    }
  }

  async loadHistory(trailId: string, beforeRevision?: number): Promise<TrailAnnotationHistoryPage> {
    const services = getFirebaseServices();
    if (!services) throw new Error('Firebase is required to load trail edit history.');
    const historyCollection = collection(
      services.firestore,
      TRAIL_ANNOTATIONS_COLLECTION,
      trailId,
      'history'
    );
    const historyQuery =
      beforeRevision === undefined
        ? query(historyCollection, orderBy('revision', 'desc'), limit(MAX_HISTORY_PAGE_SIZE))
        : query(
            historyCollection,
            orderBy('revision', 'desc'),
            startAfter(beforeRevision),
            limit(MAX_HISTORY_PAGE_SIZE)
          );
    const page = await getDocs(historyQuery);
    const events = page.docs.map((entry) => {
      const value = entry.data();
      return {
        id: entry.id,
        revision: Number(value.revision),
        operation: value.operation as TrailAnnotationOperation,
        actorUid: String(value.actorUid),
        occurredAt: asIsoString(value.occurredAt),
        previous: (value.previous ?? null) as TrailAnnotationSnapshot | null,
        next: value.next as TrailAnnotationSnapshot,
        reason: String(value.reason || ''),
      };
    });
    const lastRevision = events.length === MAX_HISTORY_PAGE_SIZE
      ? events[events.length - 1].revision
      : null;
    return { events, nextRevision: lastRevision };
  }

  async saveAnnotation(
    input: SaveTrailAnnotationInput,
    status: 'active' | 'deleted' = 'active'
  ): Promise<TrailAnnotationRecord> {
    const currentUser = AuthService.getCurrentUser();
    if (!currentUser || currentUser.uid !== input.user.uid) {
      throw new Error('Sign in again before publishing this trail edit.');
    }
    const services = getFirebaseServices();
    if (!services) throw new Error('Firebase is not configured; this edit was not published.');
    if (status === 'active' && (!input.releaseId || input.releaseId === 'osm:unavailable')) {
      throw new Error('A verified offline map is required to publish trail geometry.');
    }
    if (status === 'deleted' && !input.trailId) {
      throw new Error('A new trail cannot be published as deleted.');
    }

    const trailId = input.trailId || randomId();
    const annotationRef = doc(services.firestore, TRAIL_ANNOTATIONS_COLLECTION, trailId);
    const currentSnapshot = await getDoc(annotationRef);
    const current = currentSnapshot.exists()
      ? normalizeAnnotation(currentSnapshot.id, currentSnapshot.data())
      : null;
    if (
      (current?.revision ?? 0) !== input.expectedRevision ||
      (!input.trailId && current !== null) ||
      (input.trailId && current === null)
    ) {
      throw new TrailAnnotationConflictError();
    }
    if (status === 'deleted' && current?.status !== 'active') {
      throw new Error('Only an active community trail can be deleted.');
    }

    const validationError = validateTrailAnnotationInput({
      wayIds: input.wayIds,
      color: input.color,
      number: input.number,
      description: input.description,
      reason: input.reason,
    });
    if (validationError) throw new Error(validationError);

    const revision = input.expectedRevision + 1;
    const historyId = randomId();
    const geometryPath = status === 'deleted' ? current!.geometryPath : `${TRAIL_ANNOTATIONS_COLLECTION}/${trailId}/geometry/${revision}-${historyId}.json`;
    const selectionReleaseId = status === 'deleted' ? current!.selectionReleaseId : input.releaseId;
    if (status === 'active') {
      if (input.geometries.length !== input.wayIds.length) {
        throw new Error('Resolve every selected highway way before publishing.');
      }
      const geometryById = new Map(input.geometries.map((geometry) => [geometry.wayId, geometry]));
      for (const wayId of input.wayIds) {
        const geometry = geometryById.get(wayId);
        if (!geometry || !isValidWayGeometry(geometry, wayId)) {
          throw new Error(`Complete geometry is missing or invalid for ${wayId}.`);
        }
        if (geometry.releaseId !== input.releaseId) {
          throw new Error(`The map changed while resolving ${wayId}. Select it again before saving.`);
        }
      }
      const geometryJson = JSON.stringify({
        schemaVersion: 1,
        releaseId: input.releaseId,
        ways: input.wayIds.map((wayId) => geometryById.get(wayId)),
      });
      const geometryBytes = new TextEncoder().encode(geometryJson).byteLength;
      if (geometryBytes > TRAIL_ANNOTATION_LIMITS.maxGeometryBytes) {
        throw new Error('This trail geometry is too large to publish. Split it into smaller trails.');
      }
      await uploadString(ref(services.storage, geometryPath), geometryJson, 'raw', {
        contentType: 'application/json',
        customMetadata: {
          trailId,
          revision: String(revision),
          releaseId: input.releaseId,
        },
      });
    }

    const previous = current ? snapshot(current) : null;
    const next: TrailAnnotationSnapshot = {
      wayIds: [...input.wayIds],
      color: input.color as TrailAnnotationRecord['color'],
      number: input.number.trim(),
      description: input.description.trim(),
      status,
      geometryPath,
      selectionReleaseId,
    };
    const operation: TrailAnnotationOperation = !current
      ? 'create'
      : status === 'deleted'
        ? 'delete'
        : current.status === 'deleted'
          ? 'restore'
          : current.wayIds.join('|') !== next.wayIds.join('|')
            ? 'rebind'
            : 'edit';
    const historyRef = doc(
      services.firestore,
      TRAIL_ANNOTATIONS_COLLECTION,
      trailId,
      'history',
      historyId
    );

    await runTransaction(services.firestore, async (transaction) => {
      const latestSnapshot = await transaction.get(annotationRef);
      const latest = latestSnapshot.exists()
        ? normalizeAnnotation(latestSnapshot.id, latestSnapshot.data())
        : null;
      if (
        (latest?.revision ?? 0) !== input.expectedRevision ||
        (latest?.lastHistoryId ?? null) !== (current?.lastHistoryId ?? null)
      ) {
        throw new TrailAnnotationConflictError();
      }
      const annotationData = {
        id: trailId,
        schemaVersion: 1,
        ...next,
        revision,
        lastHistoryId: historyId,
        createdByUid: current?.createdByUid || input.user.uid,
        createdAt: current ? currentSnapshot.data()?.createdAt : serverTimestamp(),
        updatedByUid: input.user.uid,
        updatedAt: serverTimestamp(),
      };
      transaction.set(annotationRef, annotationData);
      transaction.set(historyRef, {
        revision,
        operation,
        actorUid: input.user.uid,
        occurredAt: serverTimestamp(),
        previous,
        next,
        reason: input.reason.trim(),
      });
    });

    const now = new Date().toISOString();
    const saved: TrailAnnotationRecord = {
      id: trailId,
      schemaVersion: 1,
      ...next,
      revision,
      lastHistoryId: historyId,
      createdByUid: current?.createdByUid || input.user.uid,
      createdAt: current?.createdAt || now,
      updatedByUid: input.user.uid,
      updatedAt: now,
    };
    await db.trailAnnotations.put(saved);
    await db.trailAnnotationDrafts.delete(`${input.user.uid}:${trailId}`).catch(() => undefined);
    if (status === 'active') {
      for (const way of input.geometries) {
        const cache: TrailGeometryCacheRecord = {
          ...way,
          id: getTrailGeometryCacheId(way.releaseId, way.wayId),
        };
        await db.trailGeometryCache.put(cache);
      }
    }
    return saved;
  }

  async softDelete(
    annotation: TrailAnnotationRecord,
    user: NavUser,
    releaseId: string,
    geometries: TrailWayGeometry[]
  ): Promise<TrailAnnotationRecord> {
    return this.saveAnnotation(
      {
        trailId: annotation.id,
        expectedRevision: annotation.revision,
        user,
        wayIds: annotation.wayIds,
        color: annotation.color,
        number: annotation.number,
        description: annotation.description,
        reason: 'Community annotation deleted',
        releaseId,
        geometries,
      },
      'deleted'
    );
  }

  async resolveAnnotationGeometry(
    annotation: TrailAnnotationRecord,
    releaseId: string
  ): Promise<TrailGeometryResolution> {
    const geometries: TrailWayGeometry[] = [];
    const staleWayIds: string[] = [];
    const services = getFirebaseServices();
    let remoteWays: TrailWayGeometry[] | null = null;

    const fetchRemoteWays = async (): Promise<TrailWayGeometry[]> => {
      if (remoteWays) return remoteWays;
      if (!services) throw new Error('No cached geometry is available while signed out.');
      const bytes = await getBytes(
        ref(services.storage, annotation.geometryPath),
        TRAIL_ANNOTATION_LIMITS.maxGeometryBytes
      );
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
        schemaVersion?: number;
        releaseId?: string;
        ways?: unknown[];
      };
      if (
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.ways) ||
        parsed.ways.length !== annotation.wayIds.length
      ) {
        throw new Error(`Saved geometry for trail ${annotation.number} is invalid.`);
      }
      const ways = parsed.ways.map((way, index) => {
        const wayId = annotation.wayIds[index];
        if (!isValidWayGeometry(way, wayId)) {
          throw new Error(`Saved geometry for ${wayId} is invalid.`);
        }
        return way;
      });
      remoteWays = ways;
      return ways;
    };

    for (const wayId of annotation.wayIds) {
      const cached = await db.trailGeometryCache.get(getTrailGeometryCacheId(releaseId, wayId));
      if (cached) {
        geometries.push(cached);
        continue;
      }

      const cachedReleases = await db.trailGeometryCache.where('wayId').equals(wayId).toArray();
      const original =
        cachedReleases.sort((a, b) => b.releaseId.localeCompare(a.releaseId))[0] ||
        (await fetchRemoteWays()).find((way) => way.wayId === wayId);
      if (!original) throw new Error(`Saved geometry for ${wayId} is missing.`);
      if (original.releaseId === releaseId) {
        const cache = {
          ...original,
          id: getTrailGeometryCacheId(releaseId, wayId),
        };
        await db.trailGeometryCache.put(cache);
        geometries.push(cache);
        continue;
      }

      const firstPoint = original.geometry.coordinates.find((line) => line.length > 0)?.[0];
      if (!firstPoint) {
        geometries.push(original);
        staleWayIds.push(wayId);
        continue;
      }
      try {
        const refreshed = await highwayWayGeometryService.resolveWayAt(
          wayId,
          firstPoint[0],
          firstPoint[1],
          releaseId
        );
        const { fragments: _fragments, ...cache } = refreshed;
        const record = {
          ...cache,
          id: getTrailGeometryCacheId(releaseId, wayId),
        };
        await db.trailGeometryCache.put(record);
        geometries.push(record);
      } catch {
        geometries.push(original);
        staleWayIds.push(wayId);
      }
    }
    return { ways: geometries, staleWayIds };
  }

  async saveDraft(draft: {
    ownerUid: string;
    trailId: string | null;
    wayIds: string[];
    color: TrailAnnotationRecord['color'];
    number: string;
    description: string;
    reason: string;
  }): Promise<void> {
    const id = `${draft.ownerUid}:${draft.trailId || 'new'}`;
    await db.trailAnnotationDrafts.put({
      ...draft,
      id,
      updatedAt: new Date().toISOString(),
    });
  }

  async loadCachedWayGeometry(
    wayIds: string[],
    releaseId: string
  ): Promise<TrailWayGeometry[]> {
    const records = await Promise.all(
      wayIds.map((wayId) =>
        db.trailGeometryCache.get(getTrailGeometryCacheId(releaseId, wayId))
      )
    );
    return records.filter((record): record is TrailGeometryCacheRecord => Boolean(record));
  }

  async loadDraft(
    ownerUid: string,
    trailId: string | null
  ): Promise<TrailAnnotationDraftRecord | undefined> {
    return db.trailAnnotationDrafts.get(`${ownerUid}:${trailId || 'new'}`);
  }

  toGeoJSON(
    annotations: TrailAnnotationRecord[],
    resolved: Map<string, TrailGeometryResolution>
  ): GeoJSON.FeatureCollection<GeoJSON.MultiLineString, Record<string, unknown>> {
    const features: GeoJSON.Feature<GeoJSON.MultiLineString, Record<string, unknown>>[] = [];
    const ordered = annotations
      .filter((annotation) => annotation.status === 'active')
      .slice()
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
    for (const annotation of ordered) {
      const geometry = resolved.get(annotation.id);
      if (!geometry) continue;
      features.push(...annotationGeometryCollection(
        annotation,
        geometry.ways,
        new Set(geometry.staleWayIds)
      ).features);
    }
    return { type: 'FeatureCollection', features };
  }
}

export const trailAnnotationsCloudService = new TrailAnnotationsCloudService();
