import * as turf from '@turf/turf';
import {
  db,
  type CloudSyncStatus,
  type PlannedWaypoint,
  type RouteOwnership,
  type RoutePayloadRecord,
  type RouteShareRecipient,
  type SavedRouteRecord,
} from '../db/NavDatabase';
import {
  PLANNING_MODE_META,
  PLANNING_ROUTE_COLOR,
  type PlanningMode,
} from '../routing/RoutingProfiles';
import { ElevationService } from './ElevationService';

const MAX_HYDRATED_CACHE = 25;
const hydratedRouteCache = new Map<string, SavedRouteRecord>();

function touchHydratedCache(record: SavedRouteRecord): void {
  hydratedRouteCache.delete(record.id);
  hydratedRouteCache.set(record.id, record);
  while (hydratedRouteCache.size > MAX_HYDRATED_CACHE) {
    const oldestKey = hydratedRouteCache.keys().next().value;
    if (oldestKey === undefined) break;
    hydratedRouteCache.delete(oldestKey);
  }
}

export function computeRouteBounds(
  geojson?: GeoJSON.FeatureCollection | null,
  elevationProfile?: SavedRouteRecord['elevationProfile']
): [number, number, number, number] | undefined {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const visit = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  };

  for (const f of geojson?.features || []) {
    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'LineString') {
      for (const c of geom.coordinates) visit(Number(c[0]), Number(c[1]));
    } else if (geom.type === 'MultiLineString') {
      for (const ring of geom.coordinates) {
        for (const c of ring) visit(Number(c[0]), Number(c[1]));
      }
    } else if (geom.type === 'Point') {
      visit(Number(geom.coordinates[0]), Number(geom.coordinates[1]));
    }
  }

  if (!Number.isFinite(minLon) && elevationProfile?.length) {
    for (const p of elevationProfile) {
      visit(p.lon, p.lat);
    }
  }

  return Number.isFinite(minLon) && Number.isFinite(minLat)
    ? [minLon, minLat, maxLon, maxLat]
    : undefined;
}

const LEGACY_TEST_ROUTE_IDS = [
  'route-nahal-aqev-ein-aqev',
  'route-makhtesh-ramon-ardon',
  'route-arbel-cliff-loop',
];

export const LEGACY_PLANNED_COLORS = new Set(['#f97316', '#ec4899', '#06b6d4']);

export const ROUTE_COLOR_PALETTE = [
  '#2563eb', // כחול
  '#ec4899', // ורוד-מג׳נטה
  '#f59e0b', // כתום-ענבר
  '#ef4444', // אדום
  '#9333ea', // סגול
  '#06b6d4', // תכלת
  '#14b8a6', // טורקיז
] as const;

export function resolveRouteDisplayColor(
  route: Pick<SavedRouteRecord, 'color' | 'sourceFormat' | 'colorCustomized'> | null | undefined
): string {
  if (!route) return '#ec4899';
  if (route.colorCustomized && route.color) {
    return route.color === '#10b981' ? '#14b8a6' : route.color;
  }
  if (route.sourceFormat === 'planned') {
    if (!route.color || LEGACY_PLANNED_COLORS.has(route.color) || route.color === '#10b981') {
      return PLANNING_ROUTE_COLOR;
    }
    return route.color;
  }
  if (!route.color || route.color === '#10b981') {
    return '#ec4899';
  }
  return route.color;
}

function interpolateSegmentElevationAtDist(
  segCoords: Array<[number, number]>,
  segEles: Array<number | null> | undefined,
  targetLocalDistKm: number
): number | null {
  if (!segEles || segEles.length !== segCoords.length || segCoords.length < 2) {
    return null;
  }

  const cumDist: number[] = [0];
  for (let i = 1; i < segCoords.length; i++) {
    const step = turf.distance(turf.point(segCoords[i - 1]), turf.point(segCoords[i]), {
      units: 'kilometers',
    });
    cumDist.push(cumDist[i - 1] + step);
  }

  let prevKnownIdx = -1;
  let nextKnownIdx = -1;

  for (let i = 0; i < segCoords.length; i++) {
    const ele = segEles[i];
    if (typeof ele !== 'number' || !Number.isFinite(ele)) continue;
    if (cumDist[i] <= targetLocalDistKm + 1e-6) {
      prevKnownIdx = i;
    }
    if (cumDist[i] >= targetLocalDistKm - 1e-6 && nextKnownIdx === -1) {
      nextKnownIdx = i;
    }
  }

  if (prevKnownIdx !== -1 && nextKnownIdx !== -1) {
    if (prevKnownIdx === nextKnownIdx) {
      return Math.round(segEles[prevKnownIdx]!);
    }
    const d0 = cumDist[prevKnownIdx];
    const d1 = cumDist[nextKnownIdx];
    const span = d1 - d0;
    if (span <= 1e-6) return Math.round(segEles[prevKnownIdx]!);
    const t = Math.max(0, Math.min(1, (targetLocalDistKm - d0) / span));
    return Math.round(segEles[prevKnownIdx]! + (segEles[nextKnownIdx]! - segEles[prevKnownIdx]!) * t);
  }
  if (prevKnownIdx !== -1) return Math.round(segEles[prevKnownIdx]!);
  if (nextKnownIdx !== -1) return Math.round(segEles[nextKnownIdx]!);
  return null;
}

function fillMissingElevations(
  rawSamples: Array<{ distKm: number; ele: number | null; lon: number; lat: number }>
): SavedRouteRecord['elevationProfile'] {
  if (rawSamples.length === 0) return [];
  const filled = rawSamples.map((s) => ({ ...s }));

  // Forward pass: carry last known value
  let lastKnown: number | null = null;
  for (let i = 0; i < filled.length; i++) {
    if (filled[i].ele !== null) {
      lastKnown = filled[i].ele;
    } else if (lastKnown !== null) {
      filled[i].ele = lastKnown;
    }
  }

  // Backward pass for leading nulls
  let nextKnown: number | null = null;
  for (let i = filled.length - 1; i >= 0; i--) {
    if (rawSamples[i].ele !== null) {
      nextKnown = rawSamples[i].ele;
    } else if (rawSamples[i].ele === null && filled[i].ele === null && nextKnown !== null) {
      filled[i].ele = nextKnown;
    }
  }

  return filled.map((s) => ({
    distKm: s.distKm,
    ele: s.ele ?? 0,
    lon: s.lon,
    lat: s.lat,
  }));
}

function summarizeElevationProfile(profile: SavedRouteRecord['elevationProfile']): {
  ascentMeters: number;
  descentMeters: number;
  minEle: number;
  maxEle: number;
} {
  let ascentMeters = 0;
  let descentMeters = 0;
  let minEle = Infinity;
  let maxEle = -Infinity;

  for (let i = 0; i < profile.length; i++) {
    const e = profile[i].ele;
    if (e < minEle) minEle = e;
    if (e > maxEle) maxEle = e;
    if (i > 0) {
      const diff = e - profile[i - 1].ele;
      if (diff > 0) ascentMeters += diff;
      else descentMeters += Math.abs(diff);
    }
  }

  return {
    ascentMeters: Math.round(ascentMeters),
    descentMeters: Math.round(descentMeters),
    minEle: isFinite(minEle) ? minEle : 0,
    maxEle: isFinite(maxEle) ? maxEle : 0,
  };
}

function extractLineStringsFromRoute(
  route: SavedRouteRecord
): Array<GeoJSON.Feature<GeoJSON.LineString>> {
  const result: Array<GeoJSON.Feature<GeoJSON.LineString>> = [];
  for (const f of route.geojson?.features || []) {
    if (f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 2) {
      result.push(f as GeoJSON.Feature<GeoJSON.LineString>);
    } else if (f.geometry?.type === 'MultiLineString') {
      for (const ring of f.geometry.coordinates) {
        if (Array.isArray(ring) && ring.length >= 2) {
          result.push({
            type: 'Feature',
            properties: f.properties || {},
            geometry: { type: 'LineString', coordinates: ring },
          });
        }
      }
    }
  }
  return result;
}

export class RouteManager {
  static clearHydratedCache(): void {
    hydratedRouteCache.clear();
  }

  static clearHydratedCacheForTesting(): void {
    hydratedRouteCache.clear();
  }

  static isRouteVisibleForUser(
    route: SavedRouteRecord | null | undefined,
    uid?: string | null
  ): boolean {
    if (!route) return false;
    if (!uid) {
      // Signed-out users see ONLY unowned local routes, never signed-in or shared routes
      return route.ownership !== 'shared' && !route.ownerUid;
    }
    if (route.ownership === 'shared') {
      return !route.sharedForUid || route.sharedForUid === uid;
    }
    return !route.ownerUid || route.ownerUid === uid;
  }

  static getCachedFullRoute(routeId: string): SavedRouteRecord | undefined {
    const hit = hydratedRouteCache.get(routeId);
    if (hit) {
      touchHydratedCache(hit);
    }
    return hit;
  }

  static isHydratedRoute(route: SavedRouteRecord | null | undefined): boolean {
    if (!route) return false;
    return Boolean(
      route.hasFullPayload ||
        (route.geojson?.features && route.geojson.features.length > 0) ||
        (route.elevationProfile && route.elevationProfile.length > 0)
    );
  }

  static splitRouteRecord(record: SavedRouteRecord): {
    summary: SavedRouteRecord;
    payload: RoutePayloadRecord;
  } {
    const updatedAt = record.updatedAt || record.createdAt || new Date().toISOString();
    const bounds =
      record.bounds || computeRouteBounds(record.geojson, record.elevationProfile);

    const payload: RoutePayloadRecord = {
      id: record.id,
      geojson: record.geojson || { type: 'FeatureCollection', features: [] },
      elevationProfile: record.elevationProfile || [],
      waypoints: record.waypoints,
      gpxXml: record.gpxXml,
      updatedAt,
    };

    const summary: SavedRouteRecord = {
      ...record,
      bounds,
      ownership: record.ownership || 'mine',
      hasFullPayload: false,
      geojson: { type: 'FeatureCollection', features: [] },
      elevationProfile: [],
      waypoints: undefined,
      gpxXml: undefined,
      updatedAt,
    };

    return { summary, payload };
  }

  static async persistFullRoute(record: SavedRouteRecord): Promise<SavedRouteRecord> {
    const updatedAt = record.updatedAt || record.createdAt || new Date().toISOString();
    const bounds =
      record.bounds || computeRouteBounds(record.geojson, record.elevationProfile);
    const fullRecord: SavedRouteRecord = {
      ...record,
      bounds,
      ownership: record.ownership || 'mine',
      hasFullPayload: true,
      updatedAt,
    };

    touchHydratedCache(fullRecord);
    const { summary, payload } = this.splitRouteRecord(fullRecord);

    try {
      await db.routePayloads.put(payload);
      await db.routes.put(summary);
    } catch {
      // Fallback for mocked Node/Vitest environments where db.routePayloads has no IndexedDB backend
      await db.routes.put(fullRecord);
    }

    return fullRecord;
  }

  static async persistRoutesBulk(records: SavedRouteRecord[]): Promise<SavedRouteRecord[]> {
    if (records.length === 0) return [];
    const summaries: SavedRouteRecord[] = [];
    const payloads: RoutePayloadRecord[] = [];
    const fullRecords: SavedRouteRecord[] = [];

    for (const r of records) {
      const updatedAt = r.updatedAt || r.createdAt || new Date().toISOString();
      const bounds = r.bounds || computeRouteBounds(r.geojson, r.elevationProfile);
      const fullRec: SavedRouteRecord = {
        ...r,
        bounds,
        ownership: r.ownership || 'mine',
        hasFullPayload: true,
        updatedAt,
      };
      fullRecords.push(fullRec);
      if (hydratedRouteCache.has(r.id)) {
        touchHydratedCache(fullRec);
      }
      const split = this.splitRouteRecord(fullRec);
      summaries.push(split.summary);
      payloads.push(split.payload);
    }

    try {
      await db.routePayloads.bulkPut(payloads);
      await db.routes.bulkPut(summaries);
      return summaries;
    } catch {
      // Fallback for mocked Node/Vitest environments
      await db.routes.bulkPut(fullRecords);
      return fullRecords;
    }
  }

  static async listRouteSummaries(forUid?: string | null): Promise<SavedRouteRecord[]> {
    const all = await db.routes.toArray();
    const normalized = all.map((r) =>
      r.ownership ? r : { ...r, ownership: 'mine' as RouteOwnership }
    );
    if (forUid === undefined) {
      return normalized;
    }
    return normalized.filter((r) => this.isRouteVisibleForUser(r, forUid));
  }

  static async loadFullRoute(
    routeOrId: SavedRouteRecord | string | null | undefined
  ): Promise<SavedRouteRecord | undefined> {
    if (!routeOrId) return undefined;
    const inputSummary = typeof routeOrId === 'string' ? undefined : routeOrId;
    const routeId = typeof routeOrId === 'string' ? routeOrId : routeOrId.id;

    if (inputSummary && this.isHydratedRoute(inputSummary)) {
      const bounds =
        inputSummary.bounds ||
        computeRouteBounds(inputSummary.geojson, inputSummary.elevationProfile);
      const normalized: SavedRouteRecord = {
        ...inputSummary,
        bounds,
        ownership: inputSummary.ownership || 'mine',
        hasFullPayload: true,
      };
      touchHydratedCache(normalized);
      return normalized;
    }

    const cached = hydratedRouteCache.get(routeId);
    if (cached && this.isHydratedRoute(cached)) {
      const latestSummary =
        inputSummary || (await db.routes.get(routeId).catch(() => undefined));
      const merged: SavedRouteRecord = latestSummary
        ? {
            ...cached,
            ...latestSummary,
            geojson: cached.geojson,
            elevationProfile: cached.elevationProfile,
            waypoints: cached.waypoints,
            gpxXml: cached.gpxXml,
            bounds: latestSummary.bounds || cached.bounds,
            ownership: latestSummary.ownership || cached.ownership || 'mine',
            hasFullPayload: true,
          }
        : cached;
      touchHydratedCache(merged);
      return merged;
    }

    const [dbSummary, payload] = await Promise.all([
      inputSummary
        ? Promise.resolve(inputSummary)
        : db.routes.get(routeId).catch(() => undefined),
      db.routePayloads.get(routeId).catch(() => undefined),
    ]);

    if (!dbSummary) return undefined;

    const geojson = payload?.geojson ?? dbSummary.geojson ?? {
      type: 'FeatureCollection',
      features: [],
    };
    const elevationProfile =
      payload?.elevationProfile ?? dbSummary.elevationProfile ?? [];
    const waypoints = payload?.waypoints ?? dbSummary.waypoints;
    const gpxXml = payload?.gpxXml ?? dbSummary.gpxXml;
    const hasFull = Boolean(
      payload ||
        (geojson?.features && geojson.features.length > 0) ||
        elevationProfile.length > 0
    );

    const fullRecord: SavedRouteRecord = {
      ...dbSummary,
      geojson,
      elevationProfile,
      waypoints,
      gpxXml,
      bounds: dbSummary.bounds || computeRouteBounds(geojson, elevationProfile),
      ownership: dbSummary.ownership || 'mine',
      hasFullPayload: hasFull,
    };

    if (hasFull) {
      touchHydratedCache(fullRecord);
    }
    return fullRecord;
  }

  static async initializeStarterRoutes(
    forUid?: string | null
  ): Promise<SavedRouteRecord[]> {
    // Purge any legacy test/starter routes from IndexedDB
    await db.routes.bulkDelete(LEGACY_TEST_ROUTE_IDS);
    try {
      await db.routePayloads.bulkDelete(LEGACY_TEST_ROUTE_IDS);
    } catch {
      // Ignore in mocked Node/Vitest runs
    }
    const all = await db.routes.toArray();
    const migrated: SavedRouteRecord[] = [];
    const normalized = all.map((r) => {
      const baseOwnership: RouteOwnership = r.ownership || 'mine';
      if (
        r.sourceFormat === 'planned' &&
        !r.colorCustomized &&
        r.color !== PLANNING_ROUTE_COLOR &&
        (!r.color || LEGACY_PLANNED_COLORS.has(r.color))
      ) {
        const updated: SavedRouteRecord = {
          ...r,
          ownership: baseOwnership,
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
      return r.ownership ? r : { ...r, ownership: baseOwnership };
    });
    if (migrated.length > 0) {
      await db.routes.bulkPut(migrated);
      try {
        await Promise.all(
          migrated.map(async (m) => {
            const p = await db.routePayloads.get(m.id);
            if (!p?.geojson?.features?.length) return;
            await db.routePayloads.put({
              ...p,
              geojson: {
                ...p.geojson,
                features: p.geojson.features.map((f) => ({
                  ...f,
                  properties: {
                    ...(f.properties || {}),
                    color: PLANNING_ROUTE_COLOR,
                  },
                })),
              },
            });
          })
        );
      } catch {
        // Ignore in mocked Node/Vitest runs
      }
    }
    if (forUid === undefined) {
      return normalized;
    }
    return normalized.filter((r) => this.isRouteVisibleForUser(r, forUid));
  }

  /**
   * Binds unowned local routes (imported/created before first sign-in) to the active user
   * so switching to another account later isolates them cleanly.
   */
  static async claimUnownedRoutesForUser(user: {
    uid: string;
    email?: string | null;
    displayName?: string | null;
  }): Promise<number> {
    if (!user?.uid) return 0;
    const all = await db.routes.toArray();
    const toClaim = all.filter((r) => r.ownership !== 'shared' && !r.ownerUid);
    if (toClaim.length === 0) return 0;

    const updatedRows: SavedRouteRecord[] = toClaim.map((r) => {
      const updated: SavedRouteRecord = {
        ...r,
        ownership: 'mine',
        ownerUid: user.uid,
        ownerEmail: r.ownerEmail ?? user.email ?? null,
        ownerDisplayName: r.ownerDisplayName ?? user.displayName ?? null,
      };
      const cached = hydratedRouteCache.get(r.id);
      if (cached) {
        touchHydratedCache({
          ...cached,
          ownership: 'mine',
          ownerUid: user.uid,
          ownerEmail: cached.ownerEmail ?? user.email ?? null,
          ownerDisplayName: cached.ownerDisplayName ?? user.displayName ?? null,
        });
      }
      return updated;
    });

    await db.routes.bulkPut(updatedRows);
    return updatedRows.length;
  }

  /**
   * Purges cached shared inbox routes and cloud-synced routes belonging to other accounts
   * when switching users or signing out so previous user's tracks never leak.
   */
  static async purgeOtherUsersCachedRoutes(activeUid: string | null): Promise<string[]> {
    const all = await db.routes.toArray();
    const toRemoveIds: string[] = [];

    for (const r of all) {
      if (r.ownership === 'shared') {
        if (!activeUid || r.sharedForUid !== activeUid) {
          toRemoveIds.push(r.id);
        }
        continue;
      }
      if (
        r.ownerUid &&
        r.ownerUid !== activeUid &&
        (r.cloudSyncStatus === 'synced' || activeUid !== null)
      ) {
        toRemoveIds.push(r.id);
      }
    }

    hydratedRouteCache.clear();
    if (toRemoveIds.length === 0) return [];

    await db.routes.bulkDelete(toRemoveIds);
    try {
      await db.routePayloads.bulkDelete(toRemoveIds);
    } catch {
      // Ignore in mocked Node/Vitest environments
    }
    return toRemoveIds;
  }

  static async duplicateRouteToMine(
    sourceRoute: SavedRouteRecord,
    currentUser?: { uid?: string | null; email?: string | null; displayName?: string | null } | null
  ): Promise<SavedRouteRecord> {
    const full = (await this.loadFullRoute(sourceRoute)) || sourceRoute;
    const nowIso = new Date().toISOString();
    const nextId = `route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const nextName = full.name.includes('(עותק)') ? full.name : `${full.name} (עותק)`;
    const clonedGeojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: (full.geojson?.features || []).map((f, idx) => ({
        ...f,
        properties: {
          ...(f.properties || {}),
          id: `${nextId}-seg-${idx}`,
          routeId: nextId,
          name: nextName,
        },
      })),
    };

    const cloned: SavedRouteRecord = {
      ...full,
      id: nextId,
      name: nextName,
      geojson: clonedGeojson,
      waypoints: full.waypoints ? full.waypoints.map((wp) => ({ ...wp })) : undefined,
      elevationProfile: (full.elevationProfile || []).map((pt) => ({ ...pt })),
      ownership: 'mine',
      ownerUid: currentUser?.uid ?? null,
      ownerEmail: currentUser?.email ?? null,
      ownerDisplayName: currentUser?.displayName ?? null,
      sharedByUid: undefined,
      sharedByName: undefined,
      sharedByEmail: undefined,
      sharedWith: undefined,
      sharedWithUids: undefined,
      sharedWithEmails: undefined,
      cloudStoragePath: undefined,
      cloudJsonPath: undefined,
      cloudDownloadUrl: undefined,
      cloudError: undefined,
      cloudSyncStatus: full.sourceFormat === 'planned' ? 'pending' : 'local-only',
      visible: true,
      createdAt: nowIso,
      updatedAt: nowIso,
      hasFullPayload: true,
    };

    if (cloned.sourceFormat === 'planned') {
      cloned.gpxXml = this.exportRouteAsGpx(cloned);
    }

    return await this.persistFullRoute(cloned);
  }

  static async createAndSaveRoute(params: {
    id?: string;
    name: string;
    coordinates: Array<[number, number]>;
    segments?: Array<Array<[number, number]>>;
    segmentElevations?: Array<Array<number | null>>;
    sourceFormat: SavedRouteRecord['sourceFormat'];
    color?: string;
    colorCustomized?: boolean;
    visible?: boolean;
    planningMode?: PlanningMode;
    waypoints?: PlannedWaypoint[];
    ownership?: RouteOwnership;
    ownerUid?: string | null;
    ownerEmail?: string | null;
    ownerDisplayName?: string | null;
    sharedByUid?: string | null;
    sharedByName?: string | null;
    sharedByEmail?: string | null;
    sharedWith?: RouteShareRecipient[];
    sharedWithUids?: string[];
    sharedWithEmails?: string[];
    cloudSyncStatus?: CloudSyncStatus;
  }): Promise<SavedRouteRecord> {
    const rawSegments =
      params.segments && params.segments.length > 0 ? params.segments : [params.coordinates];
    const validPairs = rawSegments
      .map((seg, idx) => ({
        seg,
        eles: params.segmentElevations?.[idx],
      }))
      .filter((item) => item.seg.length >= 2);

    const validSegments = validPairs.map((p) => p.seg);
    const lines = validSegments.map((seg) => turf.lineString(seg));
    const segmentLengths = lines.map((l) => turf.length(l, { units: 'kilometers' }));
    const totalLengthKm = segmentLengths.reduce((sum, len) => sum + len, 0);

    // Resample points proportionally across all segments to compute continuous elevation profile from Israel.dem.pmtiles or parsed GPX/KML elevations
    const totalSamples = Math.max(12, Math.min(60, Math.ceil(totalLengthKm * 5)));
    const rawSamples: Array<{ distKm: number; ele: number | null; lon: number; lat: number }> = [];
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
        if (sIdx > 0 && i === 0) continue;
        const localDistKm = segSamples > 0 ? (segLen * i) / segSamples : 0;
        const pt = turf.along(segLine, localDistKm, { units: 'kilometers' });
        const [lon, lat] = pt.geometry.coordinates;
        const demEle = await ElevationService.getElevationAt(lon, lat, 11);
        const fileEle =
          demEle === null
            ? interpolateSegmentElevationAtDist(
                validPairs[sIdx].seg,
                validPairs[sIdx].eles,
                localDistKm
              )
            : null;

        rawSamples.push({
          distKm: Number((cumDistKm + localDistKm).toFixed(2)),
          ele: demEle ?? fileEle,
          lon,
          lat,
        });
      }
      cumDistKm += segLen;
    }

    const elevationProfile = fillMissingElevations(rawSamples);
    const { ascentMeters, descentMeters, minEle, maxEle } =
      summarizeElevationProfile(elevationProfile);

    const nowIso = new Date().toISOString();
    const geojson: GeoJSON.FeatureCollection = {
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
    };

    const record: SavedRouteRecord = {
      id: routeId,
      name: params.name,
      sourceFormat: params.sourceFormat,
      planningMode: params.planningMode,
      waypoints: params.waypoints,
      distanceKm: Number(totalLengthKm.toFixed(2)),
      ascentMeters,
      descentMeters,
      minEle,
      maxEle,
      color: routeColor,
      colorCustomized: params.colorCustomized,
      visible: params.visible ?? true,
      bounds: computeRouteBounds(geojson, elevationProfile),
      hasFullPayload: true,
      geojson,
      elevationProfile,
      ownership: params.ownership || 'mine',
      ownerUid: params.ownerUid ?? null,
      ownerEmail: params.ownerEmail ?? null,
      ownerDisplayName: params.ownerDisplayName ?? null,
      sharedByUid: params.sharedByUid ?? undefined,
      sharedByName: params.sharedByName ?? undefined,
      sharedByEmail: params.sharedByEmail ?? undefined,
      sharedWith: params.sharedWith,
      sharedWithUids: params.sharedWithUids,
      sharedWithEmails: params.sharedWithEmails,
      cloudSyncStatus:
        params.cloudSyncStatus ?? (params.sourceFormat === 'planned' ? 'pending' : 'local-only'),
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    if (params.sourceFormat === 'planned') {
      record.gpxXml = this.exportRouteAsGpx(record);
    }

    return await this.persistFullRoute(record);
  }

  static async createAndSavePlannedRoute(params: {
    id?: string;
    name: string;
    mode: PlanningMode;
    segments: Array<Array<[number, number]>>;
    waypoints: PlannedWaypoint[];
    color?: string;
    colorCustomized?: boolean;
    visible?: boolean;
    ownerUid?: string | null;
    ownerEmail?: string | null;
    ownerDisplayName?: string | null;
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
      id: params.id,
      name: params.name,
      coordinates: flattened,
      segments: params.segments,
      sourceFormat: 'planned',
      color: params.color || PLANNING_MODE_META[params.mode].color,
      colorCustomized: params.colorCustomized,
      visible: params.visible,
      planningMode: params.mode,
      waypoints: enrichedWaypoints,
      ownership: 'mine',
      ownerUid: params.ownerUid ?? null,
      ownerEmail: params.ownerEmail ?? null,
      ownerDisplayName: params.ownerDisplayName ?? null,
      cloudSyncStatus: 'pending',
    });
  }

  static async updatePlannedRoute(
    routeId: string,
    params: {
      name: string;
      mode: PlanningMode;
      segments: Array<Array<[number, number]>>;
      waypoints: PlannedWaypoint[];
      color?: string;
      ownerUid?: string | null;
      ownerEmail?: string | null;
      ownerDisplayName?: string | null;
    }
  ): Promise<SavedRouteRecord> {
    const existing = await this.loadFullRoute(routeId);
    const nextColor = params.color || existing?.color || PLANNING_MODE_META[params.mode].color;
    const saved = await this.createAndSavePlannedRoute({
      id: routeId,
      name: params.name,
      mode: params.mode,
      segments: params.segments,
      waypoints: params.waypoints,
      color: nextColor,
      colorCustomized: Boolean(params.color || existing?.colorCustomized),
      visible: existing?.visible ?? true,
      ownerUid: params.ownerUid ?? existing?.ownerUid ?? null,
      ownerEmail: params.ownerEmail ?? existing?.ownerEmail ?? null,
      ownerDisplayName: params.ownerDisplayName ?? existing?.ownerDisplayName ?? null,
    });

    const merged: SavedRouteRecord = {
      ...saved,
      ownership: existing?.ownership || saved.ownership || 'mine',
      sharedWith: existing?.sharedWith,
      sharedWithUids: existing?.sharedWithUids,
      sharedWithEmails: existing?.sharedWithEmails,
      createdAt: existing?.createdAt || saved.createdAt,
      cloudStoragePath: existing?.cloudStoragePath,
      cloudJsonPath: existing?.cloudJsonPath,
      cloudDownloadUrl: existing?.cloudDownloadUrl,
      cloudSyncStatus: 'pending',
      cloudError: undefined,
    };
    merged.gpxXml = this.exportRouteAsGpx(merged);
    return await this.persistFullRoute(merged);
  }

  static async updateRouteDetails(
    routeId: string,
    patch: { name?: string; color?: string; visible?: boolean }
  ): Promise<SavedRouteRecord | undefined> {
    const existing = await this.loadFullRoute(routeId);
    if (!existing) return undefined;

    const trimmedName = patch.name !== undefined ? patch.name.trim() : undefined;
    const nextName = trimmedName && trimmedName.length > 0 ? trimmedName : existing.name;
    const hasColorChange = typeof patch.color === 'string' && patch.color.length > 0;
    const nextColor = hasColorChange ? patch.color! : existing.color;
    const nextColorCustomized = hasColorChange ? true : existing.colorCustomized;
    const nextVisible = typeof patch.visible === 'boolean' ? patch.visible : existing.visible;
    const contentEdited =
      nextName !== existing.name ||
      nextColor !== existing.color ||
      nextColorCustomized !== existing.colorCustomized;

    const updatedGeojson: GeoJSON.FeatureCollection = {
      ...existing.geojson,
      features: (existing.geojson?.features || []).map((f) => ({
        ...f,
        properties: {
          ...(f.properties || {}),
          name: nextName,
          color: nextColor,
        },
      })),
    };

    const updated: SavedRouteRecord = {
      ...existing,
      name: nextName,
      color: nextColor,
      colorCustomized: nextColorCustomized,
      visible: nextVisible,
      geojson: updatedGeojson,
      updatedAt: new Date().toISOString(),
      ...(existing.sourceFormat === 'planned' && contentEdited
        ? { cloudSyncStatus: 'pending' as CloudSyncStatus }
        : {}),
    };

    if (updated.sourceFormat === 'planned' && contentEdited) {
      updated.gpxXml = this.exportRouteAsGpx(updated);
    }

    return await this.persistFullRoute(updated);
  }

  static async toggleRouteVisibility(routeId: string): Promise<SavedRouteRecord | undefined> {
    const existing = await db.routes.get(routeId);
    if (!existing) return undefined;
    return this.updateRouteDetails(routeId, { visible: existing.visible === false });
  }

  static async reverseRoute(routeId: string): Promise<SavedRouteRecord | undefined> {
    const existing = await this.loadFullRoute(routeId);
    if (!existing) return undefined;

    const lineFeatures = extractLineStringsFromRoute(existing);
    if (lineFeatures.length === 0) return existing;

    const reversedFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = [...lineFeatures]
      .reverse()
      .map((f, idx) => ({
        ...f,
        properties: {
          ...(f.properties || {}),
          id: `${existing.id}-seg-${idx}`,
        },
        geometry: {
          type: 'LineString',
          coordinates: [...f.geometry.coordinates].reverse(),
        },
      }));

    let reversedWaypoints: PlannedWaypoint[] | undefined = existing.waypoints;
    if (existing.waypoints && existing.waypoints.length >= 2) {
      const oldWps = existing.waypoints;
      const n = oldWps.length;
      reversedWaypoints = [...oldWps].reverse().map((wp, revIdx) => {
        if (revIdx === 0) {
          const { legType: _dropped, ...rest } = wp;
          return rest;
        }
        const incomingLegType = oldWps[n - revIdx]?.legType;
        return {
          ...wp,
          ...(incomingLegType ? { legType: incomingLegType } : {}),
        };
      });
    }

    const totalKm = existing.distanceKm;
    const reversedProfile = [...(existing.elevationProfile || [])]
      .reverse()
      .map((pt) => ({
        ...pt,
        distKm: Number(Math.max(0, totalKm - pt.distKm).toFixed(2)),
      }));

    const { ascentMeters, descentMeters, minEle, maxEle } =
      summarizeElevationProfile(reversedProfile);

    const updated: SavedRouteRecord = {
      ...existing,
      waypoints: reversedWaypoints,
      ascentMeters,
      descentMeters,
      minEle,
      maxEle,
      geojson: {
        type: 'FeatureCollection',
        features: reversedFeatures,
      },
      elevationProfile: reversedProfile,
      updatedAt: new Date().toISOString(),
      ...(existing.sourceFormat === 'planned' ? { cloudSyncStatus: 'pending' as CloudSyncStatus } : {}),
    };

    if (updated.sourceFormat === 'planned') {
      updated.gpxXml = this.exportRouteAsGpx(updated);
    }

    return await this.persistFullRoute(updated);
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
        | 'ownerDisplayName'
        | 'sharedWith'
        | 'sharedWithUids'
        | 'sharedWithEmails'
        | 'updatedAt'
      >
    >
  ): Promise<SavedRouteRecord | undefined> {
    const updatedAt = patch.updatedAt || new Date().toISOString();
    await db.routes.update(routeId, {
      ...patch,
      updatedAt,
    });
    const cached = hydratedRouteCache.get(routeId);
    if (cached) {
      touchHydratedCache({
        ...cached,
        ...patch,
        updatedAt,
      });
    }
    return cached ? hydratedRouteCache.get(routeId) : await db.routes.get(routeId);
  }

  /**
   * Re-samples route elevations directly from Israel.dem.pmtiles once mounted.
   * Preserves user edits (`visible`, `color`, `colorCustomized`, `updatedAt`) and
   * preserves GPX/KML `<ele>` profiles when DEM is not mounted.
   */
  static async refreshRouteElevationsFromDem(route: SavedRouteRecord): Promise<SavedRouteRecord> {
    const fullRoute = this.isHydratedRoute(route)
      ? route
      : (await this.loadFullRoute(route)) || route;

    const segments = extractLineStringsFromRoute(fullRoute).map(
      (f) => f.geometry.coordinates as Array<[number, number]>
    );
    if (segments.length === 0) return fullRoute;

    const lines = segments.map((seg) => turf.lineString(seg));
    const segmentLengths = lines.map((l) => turf.length(l, { units: 'kilometers' }));
    const totalLengthKm = segmentLengths.reduce((sum, len) => sum + len, 0);
    const totalSamples = Math.max(12, Math.min(60, Math.ceil(totalLengthKm * 5)));

    const rawSamples: Array<{ distKm: number; ele: number | null; lon: number; lat: number }> = [];
    let validDemCount = 0;
    let cumDistKm = 0;

    for (let sIdx = 0; sIdx < lines.length; sIdx++) {
      const segLine = lines[sIdx];
      const segLen = segmentLengths[sIdx];
      const segSamples =
        totalLengthKm > 0
          ? Math.max(3, Math.round((segLen / totalLengthKm) * totalSamples))
          : Math.max(2, segments[sIdx].length - 1);

      for (let i = 0; i <= segSamples; i++) {
        if (sIdx > 0 && i === 0) continue;
        const localDistKm = segSamples > 0 ? (segLen * i) / segSamples : 0;
        const pt = turf.along(segLine, localDistKm, { units: 'kilometers' });
        const [lon, lat] = pt.geometry.coordinates;
        const sampledEle = await ElevationService.getElevationAt(lon, lat, 11);
        if (sampledEle !== null) validDemCount++;
        rawSamples.push({
          distKm: Number((cumDistKm + localDistKm).toFixed(2)),
          ele: sampledEle,
          lon,
          lat,
        });
      }
      cumDistKm += segLen;
    }

    // If DEM is not loaded / returned nothing (e.g. offline without DEM or offshore), keep existing profile & metadata intact
    if (validDemCount === 0) {
      return fullRoute;
    }

    const elevationProfile = fillMissingElevations(rawSamples);
    const { ascentMeters, descentMeters, minEle, maxEle } =
      summarizeElevationProfile(elevationProfile);

    const enrichedWaypoints = fullRoute.waypoints
      ? await Promise.all(
          fullRoute.waypoints.map(async (wp) => {
            const wpEle = await ElevationService.getElevationAt(wp.lon, wp.lat, 11);
            return wpEle !== null ? { ...wp, ele: wpEle } : wp;
          })
        )
      : undefined;

    const merged: SavedRouteRecord = {
      ...fullRoute,
      waypoints: enrichedWaypoints,
      distanceKm: Number(totalLengthKm.toFixed(2)),
      ascentMeters,
      descentMeters,
      minEle,
      maxEle,
      bounds: computeRouteBounds(fullRoute.geojson, elevationProfile),
      elevationProfile,
      visible: fullRoute.visible,
      color: fullRoute.color,
      colorCustomized: fullRoute.colorCustomized,
      createdAt: fullRoute.createdAt,
      updatedAt: fullRoute.updatedAt,
    };

    if (fullRoute.sourceFormat === 'planned') {
      merged.gpxXml = this.exportRouteAsGpx(merged);
    }

    return await this.persistFullRoute(merged);
  }

  /**
   * Computes remaining trail distance (km) along all segments from the user's snapped position to the route finish.
   */
  static computeRemainingDistanceKm(
    route: SavedRouteRecord,
    userLon: number,
    userLat: number
  ): number {
    const lineFeatures = extractLineStringsFromRoute(route);
    if (lineFeatures.length === 0) return route.distanceKm || 0;

    const userPt = turf.point([userLon, userLat]);
    const lengthsKm = lineFeatures.map((lf) => turf.length(lf, { units: 'kilometers' }));

    let bestSegIdx = 0;
    let minDistMeters = Infinity;
    let bestAlongKm = 0;

    for (let i = 0; i < lineFeatures.length; i++) {
      const lf = lineFeatures[i];
      const distMeters = turf.pointToLineDistance(userPt, lf, { units: 'meters' });
      if (distMeters < minDistMeters) {
        minDistMeters = distMeters;
        bestSegIdx = i;
        const snapped = turf.nearestPointOnLine(lf, userPt, { units: 'kilometers' });
        const locKm =
          typeof snapped.properties?.location === 'number' &&
          Number.isFinite(snapped.properties.location)
            ? snapped.properties.location
            : 0;
        bestAlongKm = Math.max(0, Math.min(lengthsKm[i], locKm));
      }
    }

    let remainingKm = Math.max(0, lengthsKm[bestSegIdx] - bestAlongKm);
    for (let j = bestSegIdx + 1; j < lengthsKm.length; j++) {
      remainingKm += lengthsKm[j];
    }

    return Number(Math.max(0, remainingKm).toFixed(1));
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
    const lineFeatures = extractLineStringsFromRoute(route);
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
    hydratedRouteCache.delete(id);
    await db.routes.delete(id);
    try {
      await db.routePayloads.delete(id);
    } catch {
      // Ignore in mocked Node/Vitest environments
    }
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

    const lineFeatures = extractLineStringsFromRoute(route);

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
