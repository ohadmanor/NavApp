import {
  db,
  type PoiRecord,
  type PoiCategory,
  type PoiOverrideRecord,
  type PoiVisibility,
  type PoiShareRecipient,
} from '../db/NavDatabase';
import { offlineDataFiles } from '../pmtiles/OfflineDataFiles';
import { isValidPoiCategory, normalizeSubcategoryForCategory, resolvePoiSymbolId } from './poiTaxonomy';
import { classifyPoiWithText } from './poiClassifier';

const GENERIC_VECTOR_PLACEHOLDER_NAMES = new Set<string>([
  'אתר מורשת / נקודת עניין',
  'heritage landmark',
  'מעבר הרים / שטח',
  'mountain / trail pass',
  'unnamed',
]);

export interface DeletedPoiSignature {
  id: string;
  normName: string;
  lon: number;
  lat: number;
}

export function parseVectorTilePoiId(
  id: string
): { layerId: string; lon: number; lat: number } | null {
  const m = /^vt-(.+)-(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(String(id || '').trim());
  if (!m) return null;
  const lon = Number(m[2]);
  const lat = Number(m[3]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { layerId: m[1], lon, lat };
}

export function parsePmtilesSearchPoiId(
  id: string
): { layer: string; lon: number; lat: number; name: string } | null {
  const m = /^pmtiles:([^:]+):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?):(.*)$/.exec(
    String(id || '').trim()
  );
  if (!m) return null;
  const lon = Number(m[2]);
  const lat = Number(m[3]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { layer: m[1], lon, lat, name: m[4] || '' };
}

export interface DeletedPoiUndoSnapshot {
  poi: PoiRecord;
  hadRecordInDb: boolean;
  hadRecordInOffroadCache: boolean;
  offroadCacheIndex: number;
  previousOverride?: PoiOverrideRecord;
}

/**
 * Computes default deterministic display & collision sort priority for POIs.
 * Lower numbers win symbol placement at zoom >= 13 and sort higher on ties.
 */
export function getPoiSortPriority(poi: Pick<PoiRecord, 'id' | 'category' | 'subcategory' | 'ele' | 'wikipedia' | 'userNotes' | 'priority'>): number {
  if (poi.category === 'user' || poi.id.startsWith('user-poi-') || poi.userNotes) {
    return 10;
  }
  if (poi.id.startsWith('import-')) {
    return 20;
  }
  if (typeof poi.priority === 'number' && Number.isFinite(poi.priority)) {
    return poi.priority;
  }
  if (poi.id.startsWith('il-poi-')) {
    return 100;
  }
  const baseByCategory: Record<PoiCategory, number> = {
    user: 10,
    offroad: 210,
    water: 310,
    campsite: 410,
    heritage: 510,
    peak: 620,
  };
  let score = baseByCategory[poi.category] ?? 550;
  if (poi.category === 'peak' && typeof poi.ele === 'number') {
    score -= Math.min(80, Math.max(0, Math.round(poi.ele / 30)));
  }
  if (poi.wikipedia) score -= 25;
  return score;
}

/**
 * Computes compact minimal properties needed by MapLibre symbol rendering & collision.
 */
function hydrateGeojsonFeature(
  f: any,
  index: number,
  existingNotes: Map<string, string>,
  defaults: { defaultSource: string; basePriority: number }
): PoiRecord {
  const props = f.properties || {};
  const coords = f.geometry?.coordinates || [35.0615, 31.402];
  const id = String(props.id || f.id || `poi-${coords[0]}-${coords[1]}`);
  const nameHe = props.nameHe || props.name || props.nameEn || 'נקודת עניין';
  const nameEn = props.nameEn || props.name || props.nameHe || 'Point of Interest';
  const rawCat = isValidPoiCategory(props.category) ? props.category : 'heritage';
  const rawSub = String(props.subcategory || '').trim();
  const normalizedSub = normalizeSubcategoryForCategory(rawCat, rawSub);
  return {
    id,
    name: nameHe,
    nameHe,
    nameEn,
    category: rawCat,
    subcategory: normalizedSub,
    lon: Number(coords[0]),
    lat: Number(coords[1]),
    ele: typeof props.ele === 'number' ? props.ele : null,
    waterStatus: props.waterStatus || null,
    difficulty4x4: props.difficulty4x4 || null,
    descHe: props.descHe || '',
    descEn: props.descEn || '',
    source: props.source || defaults.defaultSource,
    wikipedia: props.wikipedia || null,
    externalUrl: props.externalUrl || null,
    likes: typeof props.likes === 'number' ? props.likes : undefined,
    updatedAt: typeof props.updatedAt === 'string' ? props.updatedAt : undefined,
    priority:
      typeof props.priority === 'number' && Number.isFinite(props.priority)
        ? props.priority
        : defaults.basePriority + index,
    userNotes: existingNotes.get(id) || props.userNotes || '',
  };
}

const MERGE_DIR_MODIFIER_RE = /(עליון|תחתון|מערבי|מזרחי|צפוני|דרומי|גדול|קטן|\d+)$/;

function normalizePoiNameForMerge(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[\u0591-\u05C7"'״׳`.,:;!?()[\]\-—–/\\]+/g, ' ')
    .replace(/(^|\s)ה(?=[א-ת]{2,})/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function arePoiNamesEquivalentForMerge(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 6 && (a.includes(b) || b.includes(a))) {
    const modA = a.match(MERGE_DIR_MODIFIER_RE)?.[1] || '';
    const modB = b.match(MERGE_DIR_MODIFIER_RE)?.[1] || '';
    if (modA !== modB) return false;
    return true;
  }
  return false;
}

function mergeMatchingPoiMetadata(canonical: PoiRecord, community: PoiRecord): PoiRecord {
  const nextSource = canonical.source.includes('Off-Road.io')
    ? canonical.source
    : `${canonical.source} + Off-Road.io`;

  let nextDescHe = canonical.descHe || '';
  if (!nextDescHe && community.descHe) {
    nextDescHe = community.descHe;
  } else if (
    community.descHe &&
    community.descHe.length <= 220 &&
    normalizePoiNameForMerge(nextDescHe) !== normalizePoiNameForMerge(community.descHe) &&
    !nextDescHe.includes(community.descHe) &&
    !community.descHe.includes(nextDescHe)
  ) {
    nextDescHe = `${nextDescHe} • ${community.descHe}`;
  }

  const basePrio = getPoiSortPriority(canonical);
  const commPrio = getPoiSortPriority(community);
  const mergedPriority = canonical.id.startsWith('il-poi-') || canonical.category === 'user' || canonical.userNotes
    ? canonical.priority
    : Math.min(basePrio, commPrio);

  return {
    ...canonical,
    waterStatus: canonical.waterStatus || community.waterStatus,
    difficulty4x4: canonical.difficulty4x4 || community.difficulty4x4,
    descHe: nextDescHe,
    wikipedia: canonical.wikipedia || community.wikipedia,
    externalUrl: canonical.externalUrl || community.externalUrl,
    likes:
      typeof community.likes === 'number' && community.likes > (canonical.likes ?? 0)
        ? community.likes
        : canonical.likes,
    updatedAt:
      community.updatedAt && (!canonical.updatedAt || community.updatedAt > canonical.updatedAt)
        ? community.updatedAt
        : canonical.updatedAt,
    userNotes: canonical.userNotes || community.userNotes || '',
    source: nextSource,
    ...(typeof mergedPriority === 'number' ? { priority: mergedPriority } : {}),
  };
}

function normalizeLegacyPoiRecord(p: PoiRecord): PoiRecord {
  const validCat: PoiCategory = isValidPoiCategory(p.category) ? p.category : 'heritage';
  const rawSub = String(p.subcategory || '').trim().toLowerCase();
  if (
    rawSub === 'offroad_poi' ||
    rawSub === 'offroad_photo' ||
    rawSub === 'imported_wpt' ||
    rawSub === 'imported_kml' ||
    rawSub === 'imported_geojson' ||
    rawSub === 'imported_twl'
  ) {
    const cls = classifyPoiWithText({
      nameHe: p.nameHe || p.name,
      nameEn: p.nameEn,
      descHe: p.descHe,
      descEn: p.descEn,
      waterStatus: p.waterStatus,
      difficulty4x4: p.difficulty4x4,
      existingCategory: validCat,
      existingSubcategory: rawSub,
      source: p.source,
      ele: p.ele,
      wikipedia: p.wikipedia,
    });
    return {
      ...p,
      category: cls.category,
      subcategory: cls.subcategory,
    };
  }
  const normalizedSub =
    rawSub === 'user_waypoint'
      ? normalizeSubcategoryForCategory(validCat, validCat === 'user' ? 'custom_pin' : '')
      : normalizeSubcategoryForCategory(validCat, rawSub);
  if (normalizedSub === p.subcategory && validCat === p.category) {
    return p;
  }
  return {
    ...p,
    category: validCat,
    subcategory: normalizedSub,
  };
}

/**
 * Manages the unified Israeli Outdoor Points of Interest (Springs, Caves, Ruins, Campsites, 4x4 Passes, Peaks)
 * merging OpenStreetMap / IsraelHiking with Off-Road.io community POIs into one categorized list:
 *   - data/Israel.pois.geojson (persisted in local IndexedDB)
 *   - data/Israel.offroad.pois.geojson (high-volume community POIs cached in memory; userNotes persisted to IndexedDB)
 */
export class PoiManager {
  private static offroadPoisCache: PoiRecord[] = [];
  private static deletedSignatures = new Map<string, DeletedPoiSignature>();
  private static overriddenPoiIds = new Set<string>();
  private static originalBaseById = new Map<
    string,
    { category: PoiCategory; subcategory: string; priority?: number }
  >();

  private static mergeWithOffroadCache(
    dbPois: PoiRecord[],
    overrides: PoiOverrideRecord[] = []
  ): PoiRecord[] {
    const overrideMap = new Map<string, PoiOverrideRecord>();
    PoiManager.deletedSignatures.clear();
    PoiManager.overriddenPoiIds.clear();
    for (const ov of overrides) {
      overrideMap.set(ov.id, ov);
      if (!ov.deleted && isValidPoiCategory(ov.category)) {
        PoiManager.overriddenPoiIds.add(ov.id);
      }
    }

    const dbById = new Map<string, PoiRecord>();
    const combinedRaw: PoiRecord[] = [];
    const deletedCanonicalGrid = new Set<number>();
    const step = 0.001;
    const canonicalGrid = new Map<
      string,
      Array<{ index: number; normName: string; baseCategory: PoiCategory; deleted: boolean }>
    >();

    for (const rawPoi of dbPois) {
      const copy = { ...normalizeLegacyPoiRecord(rawPoi) };
      if (!PoiManager.originalBaseById.has(copy.id)) {
        PoiManager.originalBaseById.set(copy.id, {
          category: copy.category,
          subcategory: copy.subcategory,
          priority: copy.priority,
        });
      }

      const ov = overrideMap.get(copy.id);
      const isDeleted = Boolean(ov?.deleted);
      if (isDeleted) {
        PoiManager.deletedSignatures.set(copy.id, {
          id: copy.id,
          normName: normalizePoiNameForMerge(copy.nameHe || copy.name),
          lon: copy.lon,
          lat: copy.lat,
        });
      } else if (ov && isValidPoiCategory(ov.category)) {
        const nextCat = ov.category;
        const nextSub = normalizeSubcategoryForCategory(nextCat, ov.subcategory);
        copy.category = nextCat;
        copy.subcategory = nextSub;
        copy.waterStatus = nextCat === 'water' ? copy.waterStatus : null;
        copy.difficulty4x4 = nextCat === 'offroad' ? copy.difficulty4x4 : null;
        copy.priority = getPoiSortPriority({
          ...copy,
          category: nextCat,
          subcategory: nextSub,
          priority: copy.id.startsWith('il-poi-') ? copy.priority : undefined,
        });
        if (ov.updatedAt) copy.updatedAt = ov.updatedAt;
      }

      const idx = combinedRaw.length;
      combinedRaw.push(copy);
      dbById.set(copy.id, copy);
      if (isDeleted) {
        deletedCanonicalGrid.add(idx);
      }

      if (copy.id.startsWith('osm-') || copy.id.startsWith('il-poi-')) {
        const baseCat = PoiManager.originalBaseById.get(copy.id)?.category || copy.category;
        const gk = `${Math.floor(copy.lon / step)},${Math.floor(copy.lat / step)}`;
        let bucket = canonicalGrid.get(gk);
        if (!bucket) {
          bucket = [];
          canonicalGrid.set(gk, bucket);
        }
        bucket.push({
          index: idx,
          normName: normalizePoiNameForMerge(copy.nameHe || copy.name),
          baseCategory: baseCat,
          deleted: isDeleted,
        });
      }
    }

    for (const orRaw of PoiManager.offroadPoisCache) {
      const orPoiBase = normalizeLegacyPoiRecord(orRaw);
      if (!PoiManager.originalBaseById.has(orPoiBase.id)) {
        PoiManager.originalBaseById.set(orPoiBase.id, {
          category: orPoiBase.category,
          subcategory: orPoiBase.subcategory,
          priority: orPoiBase.priority,
        });
      }

      const ov = overrideMap.get(orPoiBase.id);
      if (ov?.deleted) {
        PoiManager.deletedSignatures.set(orPoiBase.id, {
          id: orPoiBase.id,
          normName: normalizePoiNameForMerge(orPoiBase.nameHe || orPoiBase.name),
          lon: orPoiBase.lon,
          lat: orPoiBase.lat,
        });
        continue;
      }

      if (dbById.has(orPoiBase.id)) {
        continue;
      }

      const orPoi = { ...orPoiBase };
      if (ov && isValidPoiCategory(ov.category)) {
        const nextCat = ov.category;
        const nextSub = normalizeSubcategoryForCategory(nextCat, ov.subcategory);
        orPoi.category = nextCat;
        orPoi.subcategory = nextSub;
        orPoi.waterStatus = nextCat === 'water' ? orPoi.waterStatus : null;
        orPoi.difficulty4x4 = nextCat === 'offroad' ? orPoi.difficulty4x4 : null;
        orPoi.priority = getPoiSortPriority({
          ...orPoi,
          category: nextCat,
          subcategory: nextSub,
          priority: undefined,
        });
        if (ov.updatedAt) orPoi.updatedAt = ov.updatedAt;
      }

      const gx = Math.floor(orPoi.lon / step);
      const gy = Math.floor(orPoi.lat / step);
      const orNorm = normalizePoiNameForMerge(orPoi.nameHe || orPoi.name);
      let matchedIndex = -1;
      let matchedDeletedCanonical = false;

      if (orNorm) {
        for (let dx = -1; dx <= 1 && matchedIndex === -1 && !matchedDeletedCanonical; dx++) {
          for (let dy = -1; dy <= 1 && matchedIndex === -1 && !matchedDeletedCanonical; dy++) {
            const bucket = canonicalGrid.get(`${gx + dx},${gy + dy}`);
            if (!bucket) continue;
            for (const cand of bucket) {
              const currentCanon = combinedRaw[cand.index];
              const matchCat = cand.deleted ? cand.baseCategory : currentCanon.category;
              if (matchCat !== orPoi.category) continue;
              const dMeters = Math.hypot(
                (currentCanon.lon - orPoi.lon) * 95000,
                (currentCanon.lat - orPoi.lat) * 111320
              );
              if (dMeters <= 85 && arePoiNamesEquivalentForMerge(cand.normName, orNorm)) {
                if (cand.deleted) {
                  matchedDeletedCanonical = true;
                } else {
                  matchedIndex = cand.index;
                }
                break;
              }
            }
          }
        }
      }

      if (matchedDeletedCanonical) {
        continue;
      }

      if (matchedIndex !== -1) {
        combinedRaw[matchedIndex] = mergeMatchingPoiMetadata(combinedRaw[matchedIndex], orPoi);
      } else {
        combinedRaw.push(orPoi);
      }
    }

    const merged =
      deletedCanonicalGrid.size === 0
        ? combinedRaw
        : combinedRaw.filter((_, idx) => !deletedCanonicalGrid.has(idx));

    // Preserve deleted signatures for vector-tile (vt-*) and PMTiles search (pmtiles:*) overrides
    // which do not have base rows in db.pois or offroadPoisCache.
    for (const ov of overrides) {
      if (!ov?.deleted || PoiManager.deletedSignatures.has(ov.id)) continue;
      const vtParsed = parseVectorTilePoiId(ov.id);
      if (vtParsed) {
        PoiManager.deletedSignatures.set(ov.id, {
          id: ov.id,
          normName: '',
          lon: vtParsed.lon,
          lat: vtParsed.lat,
        });
        continue;
      }
      const pmtParsed = parsePmtilesSearchPoiId(ov.id);
      if (pmtParsed) {
        PoiManager.deletedSignatures.set(ov.id, {
          id: ov.id,
          normName: pmtParsed.name ? normalizePoiNameForMerge(pmtParsed.name) : '',
          lon: pmtParsed.lon,
          lat: pmtParsed.lat,
        });
      }
    }

    merged.sort((a, b) => getPoiSortPriority(a) - getPoiSortPriority(b) || a.id.localeCompare(b.id));
    return merged;
  }

  /**
   * Checks whether a rendered PMTiles vector-tile POI feature corresponds to a globally
   * deleted POI (`vt-*`, `pmtiles:*`, or a deleted GeoJSON/Off-Road POI at the same spot).
   */
  static isVectorFeatureDeleted(params: {
    layerId?: string;
    lon: number;
    lat: number;
    name?: string;
  }): boolean {
    if (PoiManager.deletedSignatures.size === 0) return false;
    if (!Number.isFinite(params.lon) || !Number.isFinite(params.lat)) return false;

    const layerId = String(params.layerId || '').trim();
    if (layerId) {
      const vtId = `vt-${layerId}-${params.lon.toFixed(5)}-${params.lat.toFixed(5)}`;
      if (PoiManager.deletedSignatures.has(vtId)) {
        return true;
      }
    }

    const normName = params.name ? normalizePoiNameForMerge(params.name) : '';
    for (const sig of PoiManager.deletedSignatures.values()) {
      const dMeters = Math.hypot(
        (sig.lon - params.lon) * 95000,
        (sig.lat - params.lat) * 111320
      );
      if (dMeters > 85) continue;

      if (sig.id.startsWith('vt-')) {
        if (dMeters <= 12) {
          if (!layerId || sig.id.startsWith(`vt-${layerId}-`) || dMeters <= 4) {
            return true;
          }
        }
        continue;
      }

      if (normName && sig.normName) {
        if (arePoiNamesEquivalentForMerge(sig.normName, normName)) {
          return true;
        }
      } else if (dMeters <= 12) {
        return true;
      }
    }
    return false;
  }

  static async initializePois(): Promise<PoiRecord[]> {
    try {
      const [existingPois, osmGeo, offroadGeo] = await Promise.all([
        db.pois.toArray(),
        offlineDataFiles.loadJson('Israel.pois.geojson'),
        offlineDataFiles.loadJson('Israel.offroad.pois.geojson').catch(() => null),
      ]);

      const existingById = new Map<string, PoiRecord>();
      const existingNotes = new Map<string, string>();
      for (const p of existingPois) {
        existingById.set(p.id, p);
        if (p.userNotes) existingNotes.set(p.id, p.userNotes);
      }

      const osmNextIds = new Set<string>();
      const osmSyncPromise = (async () => {
        if (!Array.isArray(osmGeo?.features) || osmGeo.features.length === 0) return;

        const records: PoiRecord[] = osmGeo.features.map((f: any, index: number) =>
          hydrateGeojsonFeature(f, index, existingNotes, {
            defaultSource: 'IsraelHiking / OSM',
            basePriority: 100,
          })
        );

        const changedOrMissing: PoiRecord[] = [];
        for (const r of records) {
          osmNextIds.add(r.id);
          PoiManager.originalBaseById.set(r.id, {
            category: r.category,
            subcategory: r.subcategory,
            priority: r.priority,
          });
          const prev = existingById.get(r.id);
          if (
            !prev ||
            prev.nameHe !== r.nameHe ||
            prev.category !== r.category ||
            prev.subcategory !== r.subcategory ||
            prev.priority !== r.priority ||
            prev.descHe !== r.descHe ||
            prev.lon !== r.lon ||
            prev.lat !== r.lat
          ) {
            changedOrMissing.push(r);
          }
        }

        const staleBundledIds = existingPois
          .filter(
            (p) =>
              (p.id.startsWith('osm-') || p.id.startsWith('il-poi-')) &&
              !osmNextIds.has(p.id) &&
              !p.userNotes
          )
          .map((p) => p.id);

        if (staleBundledIds.length > 0 || changedOrMissing.length > 0) {
          await db.transaction('rw', db.pois, async () => {
            if (staleBundledIds.length > 0) {
              await db.pois.bulkDelete(staleBundledIds);
            }
            if (changedOrMissing.length > 0) {
              await db.pois.bulkPut(changedOrMissing);
            }
          });
        }
      })();

      if (offroadGeo) {
        try {
          const feats = Array.isArray(offroadGeo?.features) ? offroadGeo.features : [];
          const isOffroadCollection =
            String(offroadGeo?.metadata?.source || '').includes('Off-Road') ||
            feats.some((f: any) => String(f?.properties?.id || f?.id || '').startsWith('or-'));

          if (isOffroadCollection && feats.length > 0) {
            const parsedOffroad: PoiRecord[] = [];
            for (let i = 0; i < feats.length; i++) {
              const rec = hydrateGeojsonFeature(feats[i], i, existingNotes, {
                defaultSource: 'Off-Road.io (קהילת השטח)',
                basePriority: 220,
              });
              PoiManager.originalBaseById.set(rec.id, {
                category: rec.category,
                subcategory: rec.subcategory,
                priority: rec.priority,
              });
              parsedOffroad.push(rec);
            }
            PoiManager.offroadPoisCache = parsedOffroad;
          }
        } catch (orParseErr) {
          console.warn('[PoiManager] Off-Road GeoJSON parse skipped:', orParseErr);
        }
      }

      await osmSyncPromise;
      if (osmNextIds.size > 0 && PoiManager.offroadPoisCache.length > 0) {
        PoiManager.offroadPoisCache = PoiManager.offroadPoisCache.filter(
          (p) => !osmNextIds.has(p.id)
        );
      }
    } catch (err) {
      console.warn('[PoiManager] Offline mode — loading POIs from local IndexedDB cache:', err);
    }

    const [all, overrides] = await Promise.all([db.pois.toArray(), db.poiOverrides.toArray()]);
    return PoiManager.mergeWithOffroadCache(all, overrides);
  }

  static async getAllPois(): Promise<PoiRecord[]> {
    const [all, overrides] = await Promise.all([db.pois.toArray(), db.poiOverrides.toArray()]);
    return PoiManager.mergeWithOffroadCache(all, overrides);
  }

  static getDeletedSignatures(): DeletedPoiSignature[] {
    return Array.from(PoiManager.deletedSignatures.values());
  }

  static getDeletedPoiIdsSnapshot(): string[] {
    return Array.from(PoiManager.deletedSignatures.keys());
  }

  static getOverriddenPoiIdsSnapshot(): string[] {
    return Array.from(PoiManager.overriddenPoiIds);
  }

  static async getOverrides(): Promise<PoiOverrideRecord[]> {
    return await db.poiOverrides.toArray();
  }

  static async getOverride(poiId: string): Promise<PoiOverrideRecord | undefined> {
    return await db.poiOverrides.get(poiId);
  }

  static async updatePoiCategory(
    poi: PoiRecord,
    nextCategory: PoiCategory,
    nextSubcategory?: string,
    updatedByUid?: string
  ): Promise<PoiRecord> {
    const updatedAt = new Date().toISOString();
    const isPrivate = poi.visibility === 'private';
    if (!isPrivate && !PoiManager.originalBaseById.has(poi.id)) {
      PoiManager.originalBaseById.set(poi.id, {
        category: poi.category,
        subcategory: poi.subcategory,
        priority: poi.priority,
      });
    }

    const normalizedSub = normalizeSubcategoryForCategory(nextCategory, nextSubcategory);
    if (!isPrivate) {
      await db.poiOverrides.put({
        id: poi.id,
        deleted: false,
        category: nextCategory,
        subcategory: normalizedSub,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      });
      PoiManager.deletedSignatures.delete(poi.id);
      PoiManager.overriddenPoiIds.add(poi.id);
    }

    const updated: PoiRecord = {
      ...poi,
      category: nextCategory,
      subcategory: normalizedSub,
      waterStatus:
        nextCategory === 'water'
          ? poi.waterStatus || (poi.id.startsWith('user-poi-') ? 'דיווח משתמש בשטח' : null)
          : null,
      difficulty4x4:
        nextCategory === 'offroad'
          ? poi.difficulty4x4 || (poi.id.startsWith('user-poi-') ? 'דיווח עבירות 4x4' : null)
          : null,
      priority: getPoiSortPriority({
        ...poi,
        category: nextCategory,
        subcategory: normalizedSub,
        priority: poi.id.startsWith('il-poi-') ? poi.priority : undefined,
      }),
      ...(updatedByUid ? { updatedByUid } : {}),
      updatedAt,
    };

    if (isPrivate || poi.id.startsWith('user-poi-') || poi.id.startsWith('import-')) {
      await db.pois.put(updated);
    }

    const cachedIdx = PoiManager.offroadPoisCache.findIndex((p) => p.id === poi.id);
    if (cachedIdx >= 0) {
      PoiManager.offroadPoisCache[cachedIdx] = {
        ...PoiManager.offroadPoisCache[cachedIdx],
        category: nextCategory,
        subcategory: normalizedSub,
        waterStatus: updated.waterStatus,
        difficulty4x4: updated.difficulty4x4,
        priority: updated.priority,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      };
    }

    return updated;
  }

  static async resetPoiOverride(
    poiId: string,
    updatedByUid?: string
  ): Promise<PoiRecord | undefined> {
    const updatedAt = new Date().toISOString();
    if (poiId.startsWith('user-poi-') || poiId.startsWith('import-')) {
      await db.poiOverrides.delete(poiId);
    } else {
      await db.poiOverrides.put({
        id: poiId,
        deleted: false,
        category: null,
        subcategory: null,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      });
    }
    PoiManager.deletedSignatures.delete(poiId);
    PoiManager.overriddenPoiIds.delete(poiId);

    const base = PoiManager.originalBaseById.get(poiId);
    const dbRec = await db.pois.get(poiId);
    if (dbRec && base && (poiId.startsWith('user-poi-') || poiId.startsWith('import-'))) {
      const restored: PoiRecord = {
        ...dbRec,
        category: base.category,
        subcategory: base.subcategory,
        priority: base.priority,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      };
      await db.pois.put(restored);
      return restored;
    }

    if (dbRec) {
      return normalizeLegacyPoiRecord(dbRec);
    }
    const cached = PoiManager.offroadPoisCache.find((p) => p.id === poiId);
    if (cached && base) {
      const idx = PoiManager.offroadPoisCache.findIndex((p) => p.id === poiId);
      const restored: PoiRecord = {
        ...cached,
        category: base.category,
        subcategory: base.subcategory,
        priority: base.priority,
      };
      if (idx >= 0) PoiManager.offroadPoisCache[idx] = restored;
      return restored;
    }
    return cached ? normalizeLegacyPoiRecord(cached) : undefined;
  }

  static async deletePoi(poi: PoiRecord, updatedByUid?: string): Promise<DeletedPoiUndoSnapshot> {
    const updatedAt = new Date().toISOString();
    const isPrivate = poi.visibility === 'private';
    const [existingInDb, previousOverride] = await Promise.all([
      db.pois.get(poi.id),
      isPrivate ? Promise.resolve(undefined) : db.poiOverrides.get(poi.id),
    ]);
    const offroadIdx = PoiManager.offroadPoisCache.findIndex((p) => p.id === poi.id);

    if (isPrivate) {
      if (existingInDb) {
        await db.pois.delete(poi.id);
      }
      return {
        poi: { ...poi },
        hadRecordInDb: Boolean(existingInDb),
        hadRecordInOffroadCache: false,
        offroadCacheIndex: -1,
        previousOverride: undefined,
      };
    }

    if (poi.id.startsWith('user-poi-') || poi.id.startsWith('import-')) {
      if (existingInDb) {
        await db.pois.delete(poi.id);
      }
      await db.poiOverrides.delete(poi.id);
    } else {
      await db.poiOverrides.put({
        id: poi.id,
        deleted: true,
        category: previousOverride?.category ?? null,
        subcategory: previousOverride?.subcategory ?? null,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      });
    }

    PoiManager.deletedSignatures.set(poi.id, {
      id: poi.id,
      normName: normalizePoiNameForMerge(poi.nameHe || poi.name),
      lon: poi.lon,
      lat: poi.lat,
    });
    PoiManager.overriddenPoiIds.delete(poi.id);

    return {
      poi: { ...poi },
      hadRecordInDb: Boolean(existingInDb),
      hadRecordInOffroadCache: offroadIdx >= 0,
      offroadCacheIndex: offroadIdx,
      previousOverride,
    };
  }

  static async restoreDeletedPoi(
    snapshot: DeletedPoiUndoSnapshot,
    updatedByUid?: string
  ): Promise<PoiRecord> {
    const { poi, hadRecordInDb, previousOverride } = snapshot;
    if (poi.visibility === 'private') {
      await db.pois.put(poi);
      return poi;
    }

    const updatedAt = new Date().toISOString();
    if (previousOverride) {
      await db.poiOverrides.put({
        ...previousOverride,
        deleted: false,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      });
      if (isValidPoiCategory(previousOverride.category)) {
        PoiManager.overriddenPoiIds.add(poi.id);
      }
    } else if (poi.id.startsWith('user-poi-') || poi.id.startsWith('import-')) {
      await db.poiOverrides.delete(poi.id);
      PoiManager.overriddenPoiIds.delete(poi.id);
    } else {
      await db.poiOverrides.put({
        id: poi.id,
        deleted: false,
        category: null,
        subcategory: null,
        ...(updatedByUid ? { updatedByUid } : {}),
        updatedAt,
      });
      PoiManager.overriddenPoiIds.delete(poi.id);
    }

    if (hadRecordInDb || poi.id.startsWith('user-poi-')) {
      await db.pois.put(poi);
    }

    PoiManager.deletedSignatures.delete(poi.id);
    return poi;
  }

  static async applyRemoteOverrides(remoteOverrides: PoiOverrideRecord[]): Promise<void> {
    if (!Array.isArray(remoteOverrides) || remoteOverrides.length === 0) return;
    const localRows = await db.poiOverrides.toArray();
    const localById = new Map(localRows.map((r) => [r.id, r]));
    const toWrite: PoiOverrideRecord[] = [];
    for (const remote of remoteOverrides) {
      if (!remote?.id || !remote.updatedAt) continue;
      const local = localById.get(remote.id);
      if (!local || remote.updatedAt > local.updatedAt) {
        toWrite.push(remote);
      }
    }
    if (toWrite.length > 0) {
      await db.poiOverrides.bulkPut(toWrite);
    }
  }

  /**
   * Reconciles the local IndexedDB global POI cache (`user-poi-*` and `poiOverrides`)
   * with the authoritative global Firestore snapshot while preserving local personal `userNotes`
   * and any locally pending offline edits.
   */
  static async reconcileRemoteGlobalPoisAndOverrides(
    remotePois: PoiRecord[],
    remoteOverrides: PoiOverrideRecord[],
    options?: {
      pendingPoiIds?: ReadonlySet<string>;
      pendingOverrideIds?: ReadonlySet<string>;
      pendingDeleteIds?: ReadonlySet<string>;
      preserveUnpublishedLocalUserPois?: boolean;
    }
  ): Promise<{ poisChanged: boolean; overridesChanged: boolean }> {
    const pendingPoiIds = options?.pendingPoiIds ?? new Set<string>();
    const pendingOverrideIds = options?.pendingOverrideIds ?? new Set<string>();
    const pendingDeleteIds = options?.pendingDeleteIds ?? new Set<string>();

    const [localPois, localOverrides] = await Promise.all([
      db.pois.toArray(),
      db.poiOverrides.toArray(),
    ]);

    const localPoiById = new Map(localPois.map((p) => [p.id, p]));
    const remotePoiIds = new Set<string>();
    const poisToPut: PoiRecord[] = [];
    const poisToDeleteIds: string[] = [];

    for (const rawRemote of remotePois) {
      if (!rawRemote?.id) continue;
      remotePoiIds.add(rawRemote.id);
      if (pendingPoiIds.has(rawRemote.id) || pendingDeleteIds.has(rawRemote.id)) {
        continue;
      }
      const normalized = normalizeLegacyPoiRecord(rawRemote);
      const local = localPoiById.get(normalized.id);
      const nextRecord: PoiRecord = {
        ...normalized,
        visibility: 'global',
        userNotes: local?.userNotes || '',
      };
      if (
        !local ||
        (nextRecord.updatedAt || '') > (local.updatedAt || '') ||
        local.category !== nextRecord.category ||
        local.subcategory !== nextRecord.subcategory ||
        local.nameHe !== nextRecord.nameHe ||
        local.descHe !== nextRecord.descHe ||
        (local.visibility ?? 'global') !== 'global'
      ) {
        if (!local || (nextRecord.updatedAt || '') >= (local.updatedAt || '')) {
          poisToPut.push(nextRecord);
        }
      }
    }

    for (const local of localPois) {
      if (!local.id.startsWith('user-poi-')) continue;
      if (local.visibility === 'private') continue;
      if (remotePoiIds.has(local.id)) continue;
      if (pendingPoiIds.has(local.id)) continue;
      if (options?.preserveUnpublishedLocalUserPois && !local.createdByUid) continue;
      poisToDeleteIds.push(local.id);
    }

    if (poisToPut.length > 0 || poisToDeleteIds.length > 0) {
      await db.transaction('rw', db.pois, async () => {
        if (poisToDeleteIds.length > 0) {
          await db.pois.bulkDelete(poisToDeleteIds);
        }
        if (poisToPut.length > 0) {
          await db.pois.bulkPut(poisToPut);
        }
      });
    }

    const localOvById = new Map(localOverrides.map((o) => [o.id, o]));
    const remoteOvIds = new Set<string>();
    const ovToPut: PoiOverrideRecord[] = [];
    const ovToDeleteIds: string[] = [];

    for (const remote of remoteOverrides) {
      if (!remote?.id || !remote.updatedAt) continue;
      remoteOvIds.add(remote.id);
      if (pendingOverrideIds.has(remote.id) || pendingDeleteIds.has(remote.id)) {
        continue;
      }
      const local = localOvById.get(remote.id);
      const differs =
        !local ||
        remote.updatedAt > local.updatedAt ||
        Boolean(remote.deleted) !== Boolean(local.deleted) ||
        (remote.category ?? null) !== (local.category ?? null) ||
        (remote.subcategory ?? null) !== (local.subcategory ?? null);
      if (differs && (!local || remote.updatedAt >= local.updatedAt)) {
        ovToPut.push(remote);
      }
    }

    for (const local of localOverrides) {
      if (remoteOvIds.has(local.id)) continue;
      if (pendingOverrideIds.has(local.id) || pendingDeleteIds.has(local.id)) continue;
      ovToDeleteIds.push(local.id);
    }

    if (ovToPut.length > 0 || ovToDeleteIds.length > 0) {
      await db.transaction('rw', db.poiOverrides, async () => {
        if (ovToDeleteIds.length > 0) {
          await db.poiOverrides.bulkDelete(ovToDeleteIds);
        }
        if (ovToPut.length > 0) {
          await db.poiOverrides.bulkPut(ovToPut);
        }
      });
    }

    return {
      poisChanged: poisToPut.length > 0 || poisToDeleteIds.length > 0,
      overridesChanged: ovToPut.length > 0 || ovToDeleteIds.length > 0,
    };
  }

  /**
   * Reconciles the signed-in user's own private POIs and POIs shared with them
   * into IndexedDB `db.pois`, preserving local personal `userNotes` and pending offline edits.
   */
  static async reconcilePrivateAndSharedPois(params: {
    ownPrivatePois: PoiRecord[];
    sharedWithMePois: PoiRecord[];
    activeUid: string;
    pendingPrivateIds?: ReadonlySet<string>;
    pendingDeleteIds?: ReadonlySet<string>;
    dismissedSharedIds?: ReadonlySet<string>;
    allowRevokeOwn?: boolean;
    allowRevokeShared?: boolean;
  }): Promise<{
    changed: boolean;
    newlyArrivedShared: PoiRecord[];
    revokedSharedIds: string[];
  }> {
    const { activeUid } = params;
    if (!activeUid) {
      return { changed: false, newlyArrivedShared: [], revokedSharedIds: [] };
    }
    const pendingPrivateIds = params.pendingPrivateIds ?? new Set<string>();
    const pendingDeleteIds = params.pendingDeleteIds ?? new Set<string>();
    const dismissedSharedIds = params.dismissedSharedIds ?? new Set<string>();

    const localPois = await db.pois.toArray();
    const localById = new Map(localPois.map((p) => [p.id, p]));

    const toPut: PoiRecord[] = [];
    const toDeleteIds: string[] = [];
    const newlyArrivedShared: PoiRecord[] = [];
    const revokedSharedIds: string[] = [];

    // Purge any foreign private/shared POIs left behind from another user
    for (const local of localPois) {
      if (local.visibility !== 'private') continue;
      if (local.ownership === 'shared') {
        if (local.sharedForUid && local.sharedForUid !== activeUid) {
          toDeleteIds.push(local.id);
        }
      } else {
        const owner = local.ownerUid || local.createdByUid;
        if (owner && owner !== activeUid) {
          toDeleteIds.push(local.id);
        }
      }
    }

    const remoteOwnIds = new Set<string>();
    for (const rawOwn of params.ownPrivatePois) {
      if (!rawOwn?.id) continue;
      remoteOwnIds.add(rawOwn.id);
      if (pendingPrivateIds.has(rawOwn.id) || pendingDeleteIds.has(rawOwn.id)) continue;

      const normalized = normalizeLegacyPoiRecord(rawOwn);
      const local = localById.get(normalized.id);
      if (
        local &&
        (local.visibility ?? 'global') === 'global' &&
        (local.updatedAt || '') > (normalized.updatedAt || '')
      ) {
        continue;
      }
      const nextRecord: PoiRecord = {
        ...normalized,
        visibility: 'private',
        ownership: 'mine',
        ownerUid: normalized.ownerUid || normalized.createdByUid || activeUid,
        userNotes: local?.userNotes || '',
      };

      const changedRecord =
        !local ||
        local.visibility !== 'private' ||
        local.ownership !== 'mine' ||
        (nextRecord.updatedAt || '') > (local.updatedAt || '') ||
        local.category !== nextRecord.category ||
        local.subcategory !== nextRecord.subcategory ||
        local.nameHe !== nextRecord.nameHe ||
        local.descHe !== nextRecord.descHe ||
        JSON.stringify(local.sharedWithUids || []) !== JSON.stringify(nextRecord.sharedWithUids || []) ||
        JSON.stringify(local.sharedWithEmails || []) !==
          JSON.stringify(nextRecord.sharedWithEmails || []);

      if (changedRecord && (!local || (nextRecord.updatedAt || '') >= (local.updatedAt || ''))) {
        toPut.push(nextRecord);
      }
    }

    if (params.allowRevokeOwn) {
      for (const local of localPois) {
        if (local.visibility !== 'private' || local.ownership === 'shared') continue;
        const owner = local.ownerUid || local.createdByUid;
        if (owner !== activeUid) continue;
        if (remoteOwnIds.has(local.id) || pendingPrivateIds.has(local.id)) continue;
        toDeleteIds.push(local.id);
      }
    }

    const remoteSharedIds = new Set<string>();
    for (const rawShared of params.sharedWithMePois) {
      if (!rawShared?.id) continue;
      if ((rawShared.ownerUid || rawShared.createdByUid) === activeUid) continue;
      if (dismissedSharedIds.has(rawShared.id)) continue;
      remoteSharedIds.add(rawShared.id);

      const normalized = normalizeLegacyPoiRecord(rawShared);
      const local = localById.get(normalized.id);
      const nextRecord: PoiRecord = {
        ...normalized,
        visibility: 'private',
        ownership: 'shared',
        sharedForUid: activeUid,
        userNotes: local?.userNotes || '',
      };

      if (!local) {
        toPut.push(nextRecord);
        newlyArrivedShared.push(nextRecord);
      } else if (
        local.visibility !== 'private' ||
        local.ownership !== 'shared' ||
        local.sharedForUid !== activeUid ||
        (nextRecord.updatedAt || '') > (local.updatedAt || '') ||
        local.category !== nextRecord.category ||
        local.subcategory !== nextRecord.subcategory ||
        local.nameHe !== nextRecord.nameHe ||
        local.descHe !== nextRecord.descHe
      ) {
        if ((nextRecord.updatedAt || '') >= (local.updatedAt || '')) {
          toPut.push(nextRecord);
        }
      }
    }

    if (params.allowRevokeShared) {
      for (const local of localPois) {
        if (local.visibility !== 'private' || local.ownership !== 'shared') continue;
        if (local.sharedForUid && local.sharedForUid !== activeUid) continue;
        if (!remoteSharedIds.has(local.id)) {
          toDeleteIds.push(local.id);
          revokedSharedIds.push(local.id);
        }
      }
    }

    const uniqueDeleteIds = Array.from(new Set(toDeleteIds));
    if (toPut.length > 0 || uniqueDeleteIds.length > 0) {
      await db.transaction('rw', db.pois, async () => {
        if (uniqueDeleteIds.length > 0) {
          await db.pois.bulkDelete(uniqueDeleteIds);
        }
        if (toPut.length > 0) {
          await db.pois.bulkPut(toPut);
        }
      });
    }

    return {
      changed: toPut.length > 0 || uniqueDeleteIds.length > 0,
      newlyArrivedShared,
      revokedSharedIds,
    };
  }

  /**
   * Removes cached private & shared POIs that do not belong to `activeUid`
   * (or all private & shared POIs when signed out with `activeUid === null`).
   */
  static async purgePrivateAndSharedPoisForUserSwitch(activeUid: string | null): Promise<number> {
    const localPois = await db.pois.toArray();
    const deleteIds: string[] = [];
    for (const p of localPois) {
      if (p.visibility !== 'private') continue;
      if (!activeUid) {
        deleteIds.push(p.id);
        continue;
      }
      if (p.ownership === 'shared') {
        if (p.sharedForUid !== activeUid) {
          deleteIds.push(p.id);
        }
      } else {
        const owner = p.ownerUid || p.createdByUid;
        if (owner !== activeUid) {
          deleteIds.push(p.id);
        }
      }
    }
    if (deleteIds.length > 0) {
      await db.pois.bulkDelete(deleteIds);
    }
    return deleteIds.length;
  }

  static async searchPois(query: string, categoryFilter?: PoiCategory | 'all'): Promise<PoiRecord[]> {
    const q = query.trim().toLowerCase();
    const all = await PoiManager.getAllPois();
    return all.filter((poi) => {
      if (categoryFilter && categoryFilter !== 'all' && poi.category !== categoryFilter) {
        return false;
      }
      if (!q) return true;
      return (
        poi.nameHe.toLowerCase().includes(q) ||
        poi.nameEn.toLowerCase().includes(q) ||
        poi.descHe.toLowerCase().includes(q) ||
        poi.descEn.toLowerCase().includes(q) ||
        poi.subcategory.toLowerCase().includes(q)
      );
    });
  }

  static async saveUserNote(
    poiId: string,
    userNotes: string,
    fallbackRecord?: PoiRecord
  ): Promise<PoiRecord | undefined> {
    const updatedAt = new Date().toISOString();
    const cachedIdx = PoiManager.offroadPoisCache.findIndex((p) => p.id === poiId);
    if (cachedIdx >= 0) {
      PoiManager.offroadPoisCache[cachedIdx] = {
        ...PoiManager.offroadPoisCache[cachedIdx],
        userNotes,
        updatedAt,
      };
    }

    const updatedCount = await db.pois.update(poiId, {
      userNotes,
      updatedAt,
    });
    if (updatedCount === 0 && fallbackRecord) {
      const created: PoiRecord = {
        ...fallbackRecord,
        id: poiId,
        userNotes,
        updatedAt,
      };
      await db.pois.put(created);
      return created;
    }
    return await db.pois.get(poiId);
  }

  static clearOffroadCacheForTesting(): void {
    PoiManager.offroadPoisCache = [];
    PoiManager.deletedSignatures.clear();
    PoiManager.overriddenPoiIds.clear();
    PoiManager.originalBaseById.clear();
  }

  static async addCustomUserPoi(params: {
    id?: string;
    nameHe: string;
    nameEn?: string;
    category: PoiCategory;
    subcategory?: string;
    lon: number;
    lat: number;
    ele: number | null;
    descHe: string;
    userNotes?: string;
    visibility?: PoiVisibility;
    createdByUid?: string;
    ownerUid?: string | null;
    ownerEmail?: string | null;
    ownerDisplayName?: string | null;
    sharedWith?: PoiShareRecipient[];
    sharedWithUids?: string[];
    sharedWithEmails?: string[];
  }): Promise<PoiRecord> {
    const normalizedSub = normalizeSubcategoryForCategory(params.category, params.subcategory);
    const nowIso = new Date().toISOString();
    const randomSuffix = Math.random().toString(36).slice(2, 6);
    const visibility: PoiVisibility = params.visibility ?? 'private';
    const ownerUid = params.ownerUid ?? params.createdByUid ?? null;
    const isPrivate = visibility === 'private';

    const record: PoiRecord = {
      id: params.id || `user-poi-${Date.now()}-${randomSuffix}`,
      name: params.nameHe,
      nameHe: params.nameHe,
      nameEn: params.nameEn || params.nameHe,
      category: params.category,
      subcategory: normalizedSub,
      lon: Number(params.lon.toFixed(6)),
      lat: Number(params.lat.toFixed(6)),
      ele: params.ele,
      waterStatus: params.category === 'water' ? 'דיווח משתמש בשטח' : null,
      difficulty4x4: params.category === 'offroad' ? 'דיווח עבירות 4x4' : null,
      descHe: params.descHe,
      descEn: params.descHe,
      source: isPrivate ? 'נקודה פרטית (משתמש)' : 'User Field Report (דיווח מטייל)',
      wikipedia: null,
      userNotes: params.userNotes || '',
      visibility,
      ...(isPrivate
        ? {
            ownership: 'mine' as const,
            ownerUid,
            ownerEmail: params.ownerEmail ?? null,
            ownerDisplayName: params.ownerDisplayName ?? null,
            sharedWith: params.sharedWith ?? [],
            sharedWithUids: params.sharedWithUids ?? [],
            sharedWithEmails: params.sharedWithEmails ?? [],
          }
        : {}),
      ...(ownerUid ? { createdByUid: ownerUid, updatedByUid: ownerUid } : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await db.pois.put(record);
    return record;
  }

  static toGeoJSON(
    pois: PoiRecord[],
    visibility: {
      pois?: boolean;
      poiWater: boolean;
      poiHeritage: boolean;
      poiCampsites: boolean;
      poiOffroad: boolean;
      poiPeaks: boolean;
      poiUser?: boolean;
      poiPrivate?: boolean;
    }
  ): GeoJSON.FeatureCollection {
    if (visibility.pois === false) {
      return {
        type: 'FeatureCollection',
        features: [],
      };
    }

    const filtered = pois
      .filter((p) => {
        if (p.visibility === 'private' && visibility.poiPrivate === false) return false;
        if (p.category === 'water') return visibility.poiWater;
        if (p.category === 'heritage') return visibility.poiHeritage;
        if (p.category === 'campsite') return visibility.poiCampsites;
        if (p.category === 'offroad') return visibility.poiOffroad;
        if (p.category === 'peak') return visibility.poiPeaks;
        if (p.category === 'user') return visibility.poiUser ?? true;
        return true;
      })
      .sort((a, b) => getPoiSortPriority(a) - getPoiSortPriority(b));

    return {
      type: 'FeatureCollection',
      features: filtered.map((p) => ({
        type: 'Feature',
        id: p.id,
        geometry: {
          type: 'Point',
          coordinates: [p.lon, p.lat],
        },
        properties: {
          ...p,
          priority: getPoiSortPriority(p),
        },
      })),
    };
  }

  /**
   * Resolves a clicked PMTiles vector-tile POI feature (`POI_STYLE_LAYER_IDS`) to either
   * a matching richer GeoJSON/Off-Road/User POI at the same spot or a named `vt-*` PoiRecord.
   * Returns `null` for deleted features or unnamed/placeholder vector points.
   */
  static resolveRenderedVectorPoi(params: {
    featureProps: Record<string, any> | null | undefined;
    layerId: string;
    lon: number;
    lat: number;
    existingPois: ReadonlyArray<PoiRecord>;
    vectorCategory?: PoiCategory;
  }): PoiRecord | null {
    const p = params.featureProps || {};
    const layerId = String(params.layerId || '').trim();
    const { lon, lat } = params;
    const rawNameHe = String(p['name:he'] || p.name || p['name:latin'] || '').trim();
    const rawNameEn = String(
      p['name:en'] || p.name_en || p['name:latin'] || p.name || p['int_name'] || ''
    ).trim();
    const subclass = String(p.subclass || p.class || '').trim();
    const eleNum =
      typeof p.ele === 'number' && Number.isFinite(p.ele)
        ? p.ele
        : p.ele && Number.isFinite(Number(p.ele))
          ? Number(p.ele)
          : null;

    const cls = classifyPoiWithText({
      nameHe: rawNameHe || undefined,
      nameEn: rawNameEn || undefined,
      existingCategory: params.vectorCategory,
      existingSubcategory: subclass || undefined,
      source: 'IsraelHiking / OSM',
      ele: eleNum,
    });

    // If a matching GeoJSON/Off-Road POI sits at the same spot (~28m), open the richer full record
    const normVtName = rawNameHe.replace(/[\s"'׳״\-–—]/g, '').toLowerCase();
    const nearbyMatch = params.existingPois.find((item) => {
      if (Math.abs(item.lon - lon) > 0.0004 || Math.abs(item.lat - lat) > 0.0004) return false;
      if (item.category !== cls.category) return false;
      const dMeters = Math.hypot((item.lon - lon) * 95000, (item.lat - lat) * 111320);
      if (dMeters > 28) return false;
      if (!normVtName) return true;
      const normItemName = (item.nameHe || item.name || '').replace(/[\s"'׳״\-–—]/g, '').toLowerCase();
      return !normItemName || normItemName.includes(normVtName) || normVtName.includes(normItemName);
    });

    if (nearbyMatch) return nearbyMatch;

    const displayHe = rawNameHe || rawNameEn;
    if (!displayHe || GENERIC_VECTOR_PLACEHOLDER_NAMES.has(displayHe.toLowerCase())) {
      return null;
    }

    if (
      PoiManager.isVectorFeatureDeleted({
        layerId,
        lon,
        lat,
        name: displayHe,
      })
    ) {
      return null;
    }

    return {
      id: `vt-${layerId || 'poi'}-${lon.toFixed(5)}-${lat.toFixed(5)}`,
      name: displayHe,
      nameHe: displayHe,
      nameEn: rawNameEn || rawNameHe,
      category: cls.category,
      subcategory: cls.subcategory,
      lon,
      lat,
      ele: eleNum,
      waterStatus: null,
      difficulty4x4: null,
      descHe: '',
      descEn: '',
      source: 'IsraelHiking / OSM',
      wikipedia: null,
      externalUrl: null,
      userNotes: '',
    };
  }

  /**
   * Emits a lightweight GeoJSON FeatureCollection containing only styling/filtering
   * properties so 62k+ Off-Road POIs tile smoothly in MapLibre's WebWorker without
   * duplicating multi-megabyte descriptions; rich details are resolved on click via `id`.
   */
  static toCompactMapGeoJSON(pois: PoiRecord[]): GeoJSON.FeatureCollection {
    const sorted = [...pois].sort((a, b) => getPoiSortPriority(a) - getPoiSortPriority(b));
    return {
      type: 'FeatureCollection',
      features: sorted.map((p) => ({
        type: 'Feature',
        id: p.id,
        geometry: {
          type: 'Point',
          coordinates: [p.lon, p.lat],
        },
        properties: {
          id: p.id,
          nameHe: p.nameHe || p.name,
          category: p.category,
          subcategory: p.subcategory,
          symbolId: resolvePoiSymbolId(p.category, p.subcategory),
          priority: getPoiSortPriority(p),
          visibility: p.visibility || 'global',
          ownership: p.ownership || 'global',
        },
      })),
    };
  }
}

