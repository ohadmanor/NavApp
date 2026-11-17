import {
  db,
  type PlanningFolderRecord,
  type PlanningTrailRecord,
} from '../db/NavDatabase';
import {
  TRAIL_DIFFICULTY_META,
  type TrailDifficulty,
} from './PlanningTrailTaxonomy';
import zofimRoutesData from './zofimRoutesSeed.json';

export const ZOFIM_ROOT_FOLDER_NAME = 'מסלולי צופים';

export interface ZofimRouteSeedItem {
  row: number;
  region: string;
  mapNum: string;
  name: string;
  kmRaw: string;
  km: number;
  difficultyRaw: string;
  colorClass: string;
  trailMarking: string;
  notes: string;
  inquiries: string;
  updated: string;
}

function mapZofimDifficulty(colorClass: string, difficultyRaw: string): TrailDifficulty {
  const col = colorClass.trim();
  if (col.includes('אדום')) return 'hard';
  if (col.includes('צהוב')) return 'medium';
  if (col.includes('ירוק')) return 'light';

  const diff = difficultyRaw.trim();
  if (diff.includes('קשה')) return 'hard';
  if (diff.includes('בינוני') || diff.includes('בנוני')) return 'medium';
  return 'light';
}

function buildRouteNotes(item: ZofimRouteSeedItem): string {
  const lines: string[] = [];
  if (item.region) lines.push(`אזור: ${item.region}`);
  if (item.mapNum) lines.push(`מפה: ${item.mapNum}`);
  if (item.kmRaw) lines.push(`אורך (ק"מ): ${item.kmRaw}`);
  if (item.difficultyRaw) lines.push(`דרגת קושי: ${item.difficultyRaw}`);
  if (item.colorClass) lines.push(`אופי מסלול: ${item.colorClass}`);
  if (item.trailMarking) lines.push(`צבע סימון תחילת מסלול: ${item.trailMarking}`);
  if (item.notes) lines.push(`הנחיות פרטניות: ${item.notes}`);
  if (item.inquiries) lines.push(`בירורים לפני אישור: ${item.inquiries}`);
  if (item.updated) lines.push(`מועד עדכון: ${item.updated}`);
  return lines.join('\n');
}

function buildRouteTags(item: ZofimRouteSeedItem): string[] {
  const tags = ['צופים'];
  if (item.region) tags.push(item.region);
  if (item.mapNum) tags.push(`מפה ${item.mapNum}`);
  if (item.colorClass) tags.push(item.colorClass);
  if (item.trailMarking) tags.push(item.trailMarking);
  return Array.from(new Set(tags.filter(Boolean)));
}

/**
 * Ensures the "מסלולי צופים" root folder, regional subfolders, and all 393
 * Zofim walking routes (metadata-only, no GIS geometry) exist in the user's
 * local Planning Trail DB. Idempotent: no-ops if the root folder already exists.
 */
export async function ensureZofimRoutesSeeded(ownerUid: string): Promise<boolean> {
  if (!ownerUid) return false;

  const existingFolders = await db.planningFolders
    .where('ownerUid')
    .equals(ownerUid)
    .toArray();

  const alreadySeeded = existingFolders.some(
    (f) => f.parentId === null && f.name.trim() === ZOFIM_ROOT_FOLDER_NAME
  );
  if (alreadySeeded) return false;

  const items = zofimRoutesData as ZofimRouteSeedItem[];
  const now = new Date().toISOString();

  const rootFolderId = `pf-zofim-root-${ownerUid}`;
  const rootFolder: PlanningFolderRecord = {
    id: rootFolderId,
    ownerUid,
    name: ZOFIM_ROOT_FOLDER_NAME,
    parentId: null,
    pathIds: [],
    color: '#10b981',
    defaultCategoryId: 'hiking',
    sortOrder: existingFolders.filter((f) => f.parentId === null).length,
    cloudSyncStatus: 'local-only',
    createdAt: now,
    updatedAt: now,
  };

  const uniqueRegions = Array.from(
    new Set(items.map((item) => item.region.trim() || 'ללא אזור'))
  );

  const regionFolderMap = new Map<string, string>();
  const foldersToPut: PlanningFolderRecord[] = [rootFolder];

  uniqueRegions.forEach((regionName, index) => {
    const folderId = `pf-zofim-${ownerUid}-${index + 1}`;
    regionFolderMap.set(regionName, folderId);
    foldersToPut.push({
      id: folderId,
      ownerUid,
      name: regionName,
      parentId: rootFolderId,
      pathIds: [rootFolderId],
      color: '#10b981',
      defaultCategoryId: 'hiking',
      sortOrder: index,
      cloudSyncStatus: 'local-only',
      createdAt: now,
      updatedAt: now,
    });
  });

  const trailsToPut: PlanningTrailRecord[] = items.map((item) => {
    const regionName = item.region.trim() || 'ללא אזור';
    const folderId = regionFolderMap.get(regionName) ?? rootFolderId;
    const difficulty = mapZofimDifficulty(item.colorClass, item.difficultyRaw);
    const color = TRAIL_DIFFICULTY_META[difficulty].color;

    return {
      id: `pt-zofim-${ownerUid}-${item.row}`,
      ownerUid,
      name: item.name,
      folderId,
      categoryId: 'hiking',
      difficulty,
      planningMode: 'foot',
      sourceFormat: 'planned',
      distanceKm: item.km,
      ascentMeters: 0,
      descentMeters: 0,
      minEle: 0,
      maxEle: 0,
      bounds: undefined,
      color,
      tags: buildRouteTags(item),
      isStarred: false,
      notes: buildRouteNotes(item),
      sourceRouteId: null,
      hasFullPayload: false,
      geojson: { type: 'FeatureCollection', features: [] },
      elevationProfile: [],
      cloudSyncStatus: 'local-only',
      createdAt: now,
      updatedAt: now,
    };
  });

  await db.transaction('rw', db.planningFolders, db.planningTrails, async () => {
    await db.planningFolders.bulkPut(foldersToPut);
    await db.planningTrails.bulkPut(trailsToPut);
  });

  return true;
}
