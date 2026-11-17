import * as turf from '@turf/turf';
import {
  db,
  type PlannedWaypoint,
  type PlanningFolderRecord,
  type PlanningTrailPayloadRecord,
  type PlanningTrailRecord,
  type SavedRouteRecord,
} from '../db/NavDatabase';
import type { PlanningMode } from '../routing/RoutingProfiles';
import {
  TRAIL_CATEGORY_META,
  inferDefaultCategoryFromPlanningMode,
  type TrailCategoryId,
  type TrailDifficulty,
} from './PlanningTrailTaxonomy';
import { RouteManager, computeRouteBounds } from './RouteManager';

const MAX_HYDRATED_PLANNING_CACHE = 30;
const hydratedPlanningCache = new Map<string, PlanningTrailRecord>();

function touchPlanningCache(record: PlanningTrailRecord): void {
  hydratedPlanningCache.delete(record.id);
  hydratedPlanningCache.set(record.id, record);
  while (hydratedPlanningCache.size > MAX_HYDRATED_PLANNING_CACHE) {
    const oldestKey = hydratedPlanningCache.keys().next().value;
    if (oldestKey === undefined) break;
    hydratedPlanningCache.delete(oldestKey);
  }
}

export interface PlanningFolderTreeNode {
  folder: PlanningFolderRecord;
  directCount: number;
  recursiveCount: number;
  totalDistanceKm: number;
  children: PlanningFolderTreeNode[];
}

export type FolderDeleteStrategy = 'move-to-parent' | 'move-to-unfiled' | 'delete-trails';

export class PlanningTrailManager {
  static clearCache(): void {
    hydratedPlanningCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Pure Tree & Hierarchy Helpers
  // ---------------------------------------------------------------------------

  static getDescendantFolderIds(
    folderId: string,
    folders: PlanningFolderRecord[]
  ): Set<string> {
    const ids = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          changed = true;
        }
      }
    }
    return ids;
  }

  static getFolderBreadcrumbs(
    folderId: string | null | undefined,
    folders: PlanningFolderRecord[]
  ): PlanningFolderRecord[] {
    if (!folderId) return [];
    const byId = new Map(folders.map((f) => [f.id, f]));
    const chain: PlanningFolderRecord[] = [];
    const visited = new Set<string>();
    let cur = byId.get(folderId);
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }

  static canMoveFolder(
    folderId: string,
    newParentId: string | null,
    folders: PlanningFolderRecord[]
  ): boolean {
    if (!newParentId) return true;
    if (folderId === newParentId) return false;
    const descendants = this.getDescendantFolderIds(folderId, folders);
    return !descendants.has(newParentId);
  }

  static buildFolderTree(
    folders: PlanningFolderRecord[],
    trails: PlanningTrailRecord[]
  ): PlanningFolderTreeNode[] {
    const directCounts = new Map<string, number>();
    const directDist = new Map<string, number>();

    for (const t of trails) {
      if (!t.folderId) continue;
      directCounts.set(t.folderId, (directCounts.get(t.folderId) || 0) + 1);
      directDist.set(t.folderId, (directDist.get(t.folderId) || 0) + (t.distanceKm || 0));
    }

    const byParent = new Map<string | null, PlanningFolderRecord[]>();
    for (const f of folders) {
      const key = f.parentId ?? null;
      const list = byParent.get(key) || [];
      list.push(f);
      byParent.set(key, list);
    }

    for (const list of byParent.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'he'));
    }

    const buildNode = (folder: PlanningFolderRecord): PlanningFolderTreeNode => {
      const kids = (byParent.get(folder.id) || []).map(buildNode);
      const directCount = directCounts.get(folder.id) || 0;
      const recursiveCount =
        directCount + kids.reduce((sum, c) => sum + c.recursiveCount, 0);
      const totalDistanceKm =
        (directDist.get(folder.id) || 0) +
        kids.reduce((sum, c) => sum + c.totalDistanceKm, 0);

      return {
        folder,
        directCount,
        recursiveCount,
        totalDistanceKm,
        children: kids,
      };
    };

    return (byParent.get(null) || []).map(buildNode);
  }

  // ---------------------------------------------------------------------------
  // Folder CRUD (Per-User Isolated)
  // ---------------------------------------------------------------------------

  static async listFolders(ownerUid: string): Promise<PlanningFolderRecord[]> {
    if (!ownerUid) return [];
    const all = await db.planningFolders.toArray();
    return all.filter((f) => f.ownerUid === ownerUid);
  }

  static async createFolder(params: {
    id?: string;
    ownerUid: string;
    name: string;
    parentId?: string | null;
    color?: string;
    defaultCategoryId?: TrailCategoryId;
    defaultDifficulty?: TrailDifficulty;
  }): Promise<PlanningFolderRecord> {
    if (!params.ownerUid) {
      throw new Error('יש להתחבר לחשבון כדי ליצור תיקייה');
    }
    const cleanName = params.name.trim();
    if (!cleanName) {
      throw new Error('שם התיקייה אינו יכול להיות ריק');
    }

    const allFolders = await this.listFolders(params.ownerUid);
    const parentId = params.parentId ?? null;
    const parent = parentId ? allFolders.find((f) => f.id === parentId) : undefined;
    const pathIds = parent ? [...parent.pathIds, parent.id] : [];
    const siblings = allFolders.filter((f) => (f.parentId ?? null) === parentId);
    const now = new Date().toISOString();

    const record: PlanningFolderRecord = {
      id: params.id || `pf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ownerUid: params.ownerUid,
      name: cleanName,
      parentId,
      pathIds,
      color: params.color || parent?.color || '#10b981',
      defaultCategoryId: params.defaultCategoryId ?? parent?.defaultCategoryId,
      defaultDifficulty: params.defaultDifficulty ?? parent?.defaultDifficulty,
      sortOrder: siblings.length,
      cloudSyncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    await db.planningFolders.put(record);
    return record;
  }

  static async renameFolder(folderId: string, newName: string): Promise<PlanningFolderRecord | undefined> {
    const cleanName = newName.trim();
    if (!cleanName) throw new Error('שם התיקייה אינו יכול להיות ריק');
    const existing = await db.planningFolders.get(folderId);
    if (!existing) return undefined;
    const updated: PlanningFolderRecord = {
      ...existing,
      name: cleanName,
      cloudSyncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    };
    await db.planningFolders.put(updated);
    return updated;
  }

  static async moveFolder(
    folderId: string,
    newParentId: string | null
  ): Promise<PlanningFolderRecord | undefined> {
    const target = await db.planningFolders.get(folderId);
    if (!target) return undefined;
    const allFolders = await this.listFolders(target.ownerUid);
    if (!this.canMoveFolder(folderId, newParentId, allFolders)) {
      throw new Error('לא ניתן להעביר תיקייה לתוך תת-תיקייה של עצמה');
    }

    const byId = new Map(allFolders.map((f) => [f.id, f]));
    const newParent = newParentId ? byId.get(newParentId) : undefined;
    const newPathIds = newParent ? [...newParent.pathIds, newParent.id] : [];
    const now = new Date().toISOString();

    const updatedTarget: PlanningFolderRecord = {
      ...target,
      parentId: newParentId,
      pathIds: newPathIds,
      cloudSyncStatus: 'pending',
      updatedAt: now,
    };

    const descendants = this.getDescendantFolderIds(folderId, allFolders);
    const toPut: PlanningFolderRecord[] = [updatedTarget];

    // Recompute pathIds for descendants in topological order
    const updatedMap = new Map(allFolders.map((f) => [f.id, f]));
    updatedMap.set(updatedTarget.id, updatedTarget);

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of descendants) {
        if (id === folderId) continue;
        const f = updatedMap.get(id);
        if (!f || !f.parentId) continue;
        const p = updatedMap.get(f.parentId);
        if (!p) continue;
        const expectedPath = [...p.pathIds, p.id];
        if (JSON.stringify(f.pathIds) !== JSON.stringify(expectedPath)) {
          const next: PlanningFolderRecord = {
            ...f,
            pathIds: expectedPath,
            cloudSyncStatus: 'pending',
            updatedAt: now,
          };
          updatedMap.set(id, next);
          changed = true;
        }
      }
    }

    for (const id of descendants) {
      if (id === folderId) continue;
      const item = updatedMap.get(id);
      if (item && item.updatedAt === now) {
        toPut.push(item);
      }
    }

    await db.planningFolders.bulkPut(toPut);
    return updatedTarget;
  }

  static async deleteFolder(
    folderId: string,
    strategy: FolderDeleteStrategy = 'move-to-unfiled'
  ): Promise<void> {
    const target = await db.planningFolders.get(folderId);
    if (!target) return;
    const allFolders = await this.listFolders(target.ownerUid);

    const descendantIds = this.getDescendantFolderIds(folderId, allFolders);
    const allTrails = await this.listTrailSummaries(target.ownerUid);
    const affectedTrails = allTrails.filter((t) => t.folderId && descendantIds.has(t.folderId));
    const now = new Date().toISOString();

    if (strategy === 'delete-trails') {
      const trailIds = affectedTrails.map((t) => t.id);
      await db.planningTrails.bulkDelete(trailIds);
      await db.planningTrailPayloads.bulkDelete(trailIds);
      for (const tid of trailIds) hydratedPlanningCache.delete(tid);
    } else {
      const targetFolderId = strategy === 'move-to-parent' ? target.parentId : null;
      const updatedTrails = affectedTrails.map((t) => ({
        ...t,
        folderId: targetFolderId,
        cloudSyncStatus: 'pending' as const,
        updatedAt: now,
      }));
      if (updatedTrails.length > 0) {
        await db.planningTrails.bulkPut(updatedTrails);
      }
    }

    await db.planningFolders.bulkDelete(Array.from(descendantIds));
  }

  // ---------------------------------------------------------------------------
  // Planning Trail CRUD & Lazy Payload Hydration
  // ---------------------------------------------------------------------------

  static splitTrailRecord(record: PlanningTrailRecord): {
    summary: PlanningTrailRecord;
    payload: PlanningTrailPayloadRecord;
  } {
    const updatedAt = record.updatedAt || record.createdAt || new Date().toISOString();
    const payload: PlanningTrailPayloadRecord = {
      id: record.id,
      geojson: record.geojson || { type: 'FeatureCollection', features: [] },
      elevationProfile: record.elevationProfile || [],
      waypoints: record.waypoints,
      gpxXml: record.gpxXml,
      updatedAt,
    };
    const summary: PlanningTrailRecord = {
      ...record,
      hasFullPayload: true,
      geojson: { type: 'FeatureCollection', features: [] },
      elevationProfile: [],
      waypoints: undefined,
      gpxXml: undefined,
      updatedAt,
    };
    return { summary, payload };
  }

  static async listTrailSummaries(ownerUid: string): Promise<PlanningTrailRecord[]> {
    if (!ownerUid) return [];
    const rows = await db.planningTrails.toArray();
    return rows
      .filter((t) => t.ownerUid === ownerUid)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  static async loadFullTrail(trailId: string): Promise<PlanningTrailRecord | undefined> {
    const cached = hydratedPlanningCache.get(trailId);
    if (cached) {
      touchPlanningCache(cached);
      return cached;
    }

    const summary = await db.planningTrails.get(trailId);
    if (!summary) return undefined;

    let payload: PlanningTrailPayloadRecord | undefined;
    try {
      payload = await db.planningTrailPayloads.get(trailId);
    } catch {
      payload = undefined;
    }

    const full: PlanningTrailRecord = payload
      ? {
          ...summary,
          geojson: payload.geojson,
          elevationProfile: payload.elevationProfile,
          waypoints: payload.waypoints,
          gpxXml: payload.gpxXml,
          hasFullPayload: true,
        }
      : summary;

    touchPlanningCache(full);
    return full;
  }

  static async persistFullTrail(record: PlanningTrailRecord): Promise<PlanningTrailRecord> {
    const updatedAt = record.updatedAt || record.createdAt || new Date().toISOString();
    const bounds =
      record.bounds || computeRouteBounds(record.geojson, record.elevationProfile);
    const fullRecord: PlanningTrailRecord = {
      ...record,
      bounds,
      hasFullPayload: true,
      updatedAt,
    };

    touchPlanningCache(fullRecord);
    const { summary, payload } = this.splitTrailRecord(fullRecord);

    try {
      await db.planningTrailPayloads.put(payload);
      await db.planningTrails.put(summary);
    } catch {
      await db.planningTrails.put(fullRecord);
    }

    return fullRecord;
  }

  static async updateTrailMetadata(
    trailId: string,
    patch: Partial<
      Pick<
        PlanningTrailRecord,
        | 'name'
        | 'folderId'
        | 'categoryId'
        | 'customCategoryLabel'
        | 'difficulty'
        | 'tags'
        | 'isStarred'
        | 'notes'
        | 'color'
      >
    >
  ): Promise<PlanningTrailRecord | undefined> {
    const existing = await db.planningTrails.get(trailId);
    if (!existing) return undefined;
    const updated: PlanningTrailRecord = {
      ...existing,
      ...patch,
      cloudSyncStatus: 'pending',
      updatedAt: new Date().toISOString(),
    };
    await db.planningTrails.put(updated);
    const cached = hydratedPlanningCache.get(trailId);
    if (cached) {
      touchPlanningCache({ ...cached, ...patch, updatedAt: updated.updatedAt });
    }
    return updated;
  }

  static async moveTrailsToFolder(
    trailIds: string[],
    targetFolderId: string | null
  ): Promise<void> {
    if (trailIds.length === 0) return;
    const now = new Date().toISOString();
    const existing = await db.planningTrails.bulkGet(trailIds);
    const updates: PlanningTrailRecord[] = [];
    for (const item of existing) {
      if (!item) continue;
      updates.push({
        ...item,
        folderId: targetFolderId,
        cloudSyncStatus: 'pending',
        updatedAt: now,
      });
      const cached = hydratedPlanningCache.get(item.id);
      if (cached) {
        touchPlanningCache({ ...cached, folderId: targetFolderId, updatedAt: now });
      }
    }
    if (updates.length > 0) {
      await db.planningTrails.bulkPut(updates);
    }
  }

  static async toggleTrailStarred(trailId: string): Promise<PlanningTrailRecord | undefined> {
    const existing = await db.planningTrails.get(trailId);
    if (!existing) return undefined;
    return this.updateTrailMetadata(trailId, { isStarred: !existing.isStarred });
  }

  static async deleteTrail(trailId: string): Promise<void> {
    hydratedPlanningCache.delete(trailId);
    await db.planningTrails.delete(trailId);
    try {
      await db.planningTrailPayloads.delete(trailId);
    } catch {
      // Ignore if payload table not present
    }
  }

  // ---------------------------------------------------------------------------
  // Bidirectional Bridge: Planning Trail DB <-> Active Routes ("Old Menu")
  // ---------------------------------------------------------------------------

  static async sendPlanningTrailToActiveRoutes(
    trailId: string,
    ownerUid?: string
  ): Promise<SavedRouteRecord | undefined> {
    const fullTrail = await this.loadFullTrail(trailId);
    if (!fullTrail) return undefined;
    if (ownerUid && fullTrail.ownerUid !== ownerUid) return undefined;

    const now = new Date().toISOString();
    const categorySpec = TRAIL_CATEGORY_META[fullTrail.categoryId];
    const routeRecord: SavedRouteRecord = {
      id: `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: fullTrail.name,
      sourceFormat: fullTrail.sourceFormat,
      planningMode: fullTrail.planningMode || categorySpec?.defaultPlanningMode || '4x4',
      waypoints: fullTrail.waypoints,
      distanceKm: fullTrail.distanceKm,
      ascentMeters: fullTrail.ascentMeters,
      descentMeters: fullTrail.descentMeters,
      minEle: fullTrail.minEle,
      maxEle: fullTrail.maxEle,
      color: fullTrail.color || categorySpec?.color || '#ec4899',
      colorCustomized: true,
      visible: true,
      bounds: fullTrail.bounds,
      hasFullPayload: true,
      geojson: fullTrail.geojson,
      elevationProfile: fullTrail.elevationProfile,
      gpxXml: fullTrail.gpxXml,
      ownership: 'mine',
      ownerUid: ownerUid || fullTrail.ownerUid,
      cloudSyncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    return RouteManager.persistFullRoute(routeRecord);
  }

  static async sendActiveRouteToPlanningDb(
    routeId: string,
    options: {
      ownerUid: string;
      folderId: string | null;
      categoryId?: TrailCategoryId;
      difficulty: TrailDifficulty;
      tags?: string[];
      notes?: string;
    }
  ): Promise<PlanningTrailRecord | undefined> {
    if (!options.ownerUid) {
      throw new Error('יש להתחבר לחשבון כדי לשמור במאגר תכנון');
    }
    const fullRoute = await RouteManager.loadFullRoute(routeId);
    if (!fullRoute) return undefined;

    const categoryId =
      options.categoryId || inferDefaultCategoryFromPlanningMode(fullRoute.planningMode);
    const now = new Date().toISOString();

    const trailRecord: PlanningTrailRecord = {
      id: `pt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ownerUid: options.ownerUid,
      name: fullRoute.name,
      folderId: options.folderId ?? null,
      categoryId,
      difficulty: options.difficulty,
      planningMode: fullRoute.planningMode,
      sourceFormat: fullRoute.sourceFormat,
      distanceKm: fullRoute.distanceKm,
      ascentMeters: fullRoute.ascentMeters,
      descentMeters: fullRoute.descentMeters,
      minEle: fullRoute.minEle,
      maxEle: fullRoute.maxEle,
      bounds: fullRoute.bounds,
      color: TRAIL_CATEGORY_META[categoryId]?.color || fullRoute.color || '#10b981',
      tags: options.tags?.filter(Boolean) || [],
      isStarred: false,
      notes: options.notes,
      sourceRouteId: fullRoute.id,
      hasFullPayload: true,
      geojson: fullRoute.geojson,
      elevationProfile: fullRoute.elevationProfile,
      waypoints: fullRoute.waypoints,
      gpxXml: fullRoute.gpxXml,
      cloudSyncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    return this.persistFullTrail(trailRecord);
  }

  static async updatePlannedTrailGeometry(
    trailId: string,
    params: {
      name: string;
      mode: PlanningMode;
      segments: Array<Array<[number, number]>>;
      waypoints: PlannedWaypoint[];
    }
  ): Promise<PlanningTrailRecord | undefined> {
    const existing = await this.loadFullTrail(trailId);
    if (!existing) return undefined;

    const features: GeoJSON.Feature<GeoJSON.LineString>[] = params.segments
      .filter((seg) => seg.length >= 2)
      .map((coords) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      }));

    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features,
    };

    let distanceKm = 0;
    for (const f of features) {
      distanceKm += turf.length(f, { units: 'kilometers' });
    }

    const now = new Date().toISOString();
    const updated: PlanningTrailRecord = {
      ...existing,
      name: params.name.trim() || existing.name,
      planningMode: params.mode,
      sourceFormat: 'planned',
      distanceKm: Number(distanceKm.toFixed(2)),
      bounds: computeRouteBounds(geojson, existing.elevationProfile),
      geojson,
      waypoints: params.waypoints,
      hasFullPayload: true,
      cloudSyncStatus: 'pending',
      updatedAt: now,
    };

    return this.persistFullTrail(updated);
  }
}
