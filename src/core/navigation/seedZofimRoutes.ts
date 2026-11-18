import {
  db,
  type PlanningFolderRecord,
  type PlanningTrailRecord,
} from '../db/NavDatabase';
import {
  TRAIL_DIFFICULTY_META,
  type TrailDifficulty,
} from './PlanningTrailTaxonomy';
import {
  matchZofimToIsraelTrail,
  type IsraelTrailRecord,
} from '../trails/IsraelTrailsService';
import zofimRoutesData from './zofimRoutesSeed.json';
import zofimGeometriesRaw from './zofimRoutesGeometries.json';

const zofimGeometries = zofimGeometriesRaw as unknown as Record<string, number[][][]>;

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

function buildRouteNotes(item: ZofimRouteSeedItem, trailMatch: IsraelTrailRecord | null): string {
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
  if (trailMatch) {
    lines.push(`שביל ישראל: ${trailMatch.name}`);
    if (trailMatch.description) lines.push(`מאפייני שביל: ${trailMatch.description}`);
    lines.push(`נ.צ. שביל: ${trailMatch.lat.toFixed(5)}, ${trailMatch.lon.toFixed(5)}`);
  }
  return lines.join('\n');
}

function buildRouteTags(item: ZofimRouteSeedItem, trailMatch: IsraelTrailRecord | null): string[] {
  const tags = ['צופים'];
  if (item.region) tags.push(item.region);
  if (item.mapNum) tags.push(`מפה ${item.mapNum}`);
  if (item.colorClass) tags.push(item.colorClass);
  if (item.trailMarking) tags.push(item.trailMarking);
  if (trailMatch) {
    for (const num of trailMatch.numbers) {
      tags.push(`שביל ${num}`);
    }
  }
  return Array.from(new Set(tags.filter(Boolean)));
}

function buildTrailGeometry(
  item: ZofimRouteSeedItem,
  trailMatch: IsraelTrailRecord | null
): {
  geojson: GeoJSON.FeatureCollection;
  bounds: PlanningTrailRecord['bounds'];
  hasFullPayload: boolean;
} {
  const lines = zofimGeometries[String(item.row)];
  if (Array.isArray(lines) && lines.length > 0) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const line of lines) {
      for (const [lon, lat] of line) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return {
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: item.name,
              trailMarking: item.trailMarking,
            },
            geometry: {
              type: 'MultiLineString',
              coordinates: lines,
            },
          },
        ],
      },
      bounds: [minLon, minLat, maxLon, maxLat],
      hasFullPayload: true,
    };
  }
  if (trailMatch) {
    return {
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              name: item.name,
              trailMarking: item.trailMarking,
            },
            geometry: {
              type: 'Point',
              coordinates: [trailMatch.lon, trailMatch.lat],
            },
          },
        ],
      },
      bounds: [trailMatch.lon, trailMatch.lat, trailMatch.lon, trailMatch.lat],
      hasFullPayload: false,
    };
  }
  return {
    geojson: { type: 'FeatureCollection', features: [] },
    bounds: undefined,
    hasFullPayload: false,
  };
}

/**
 * Resolves geometry (traced polyline or Moked Teva point) on demand for a
 * seeded Zofim trail (`pt-zofim-<uid>-<row>`) if its local DB record lacks it.
 */
export function resolveZofimTrailFallback(trailId: string): {
  geojson: GeoJSON.FeatureCollection;
  bounds: PlanningTrailRecord['bounds'];
  hasFullPayload: boolean;
} | null {
  const match = /^pt-zofim-.+-(\d+)$/.exec(trailId);
  if (!match) return null;
  const row = Number(match[1]);
  const items = zofimRoutesData as ZofimRouteSeedItem[];
  const item = items.find((entry) => entry.row === row);
  if (!item) return null;
  const trailMatch = matchZofimToIsraelTrail(item);
  const geom = buildTrailGeometry(item, trailMatch);
  return geom.geojson.features.length > 0 ? geom : null;
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
  const items = zofimRoutesData as ZofimRouteSeedItem[];
  const now = new Date().toISOString();

  if (alreadySeeded) {
    const existingTrails = (await db.planningTrails.toArray()).filter(
      (t) => t.ownerUid === ownerUid && t.id.startsWith(`pt-zofim-${ownerUid}-`)
    );
    const existingById = new Map(existingTrails.map((t) => [t.id, t]));
    const updates: PlanningTrailRecord[] = [];
    for (const item of items) {
      const existing = existingById.get(`pt-zofim-${ownerUid}-${item.row}`);
      if (!existing) continue;
      const existingNotes = existing.notes || '';
      const needsNotes = !existingNotes.includes('שביל ישראל:') && !existingNotes.includes('מוקד טבע:');
      const needsGeom = !existing.hasFullPayload && existing.geojson.features.length === 0;
      if (!needsNotes && !needsGeom) continue;
      const trailMatch = matchZofimToIsraelTrail(item);
      const geom = needsGeom ? buildTrailGeometry(item, trailMatch) : null;
      if (!trailMatch && (!geom || geom.geojson.features.length === 0)) continue;

      let nextNotes = existingNotes;
      let nextTags = existing.tags || [];
      if (needsNotes && trailMatch) {
        const trailLines = [`שביל ישראל: ${trailMatch.name}`];
        if (trailMatch.description) trailLines.push(`מאפייני שביל: ${trailMatch.description}`);
        trailLines.push(`נ.צ. שביל: ${trailMatch.lat.toFixed(5)}, ${trailMatch.lon.toFixed(5)}`);
        nextNotes = existingNotes
          ? `${existingNotes}\n${trailLines.join('\n')}`
          : trailLines.join('\n');
        nextTags = Array.from(
          new Set([...nextTags, ...trailMatch.numbers.map((num) => `שביל ${num}`)])
        );
      }

      updates.push({
        ...existing,
        notes: nextNotes,
        tags: nextTags,
        ...(geom
          ? {
              geojson: geom.geojson,
              bounds: geom.bounds,
              hasFullPayload: geom.hasFullPayload,
            }
          : {}),
        updatedAt: now,
      });
    }
    if (updates.length > 0) {
      await db.planningTrails.bulkPut(updates);
    }
    return false;
  }

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
    const trailMatch = matchZofimToIsraelTrail(item);
    const geom = buildTrailGeometry(item, trailMatch);

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
      bounds: geom.bounds,
      color,
      tags: buildRouteTags(item, trailMatch),
      isStarred: false,
      notes: buildRouteNotes(item, trailMatch),
      sourceRouteId: null,
      hasFullPayload: geom.hasFullPayload,
      geojson: geom.geojson,
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
