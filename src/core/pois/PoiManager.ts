import { db, type PoiRecord, type PoiCategory } from '../db/NavDatabase';
import { bundledDataUrl } from '../dataUrls';

/**
 * Computes default deterministic display & collision sort priority for POIs.
 * Lower numbers win symbol placement at zoom >= 15 and sort higher on ties.
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
  return {
    id,
    name: nameHe,
    nameHe,
    nameEn,
    category: (props.category as PoiCategory) || 'heritage',
    subcategory: props.subcategory || 'poi',
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

/**
 * Manages the Israeli Outdoor Points of Interest (Springs, Caves, Ruins, Campsites, 4x4 Passes, Peaks)
 * harvested from OpenStreetMap / IsraelHiking / Off-Road into:
 *   - data/Israel.pois.geojson (persisted in local IndexedDB)
 *   - data/Israel.offroad.pois.geojson (high-volume community overlay cached in memory; userNotes persisted to IndexedDB)
 */
export class PoiManager {
  private static offroadPoisCache: PoiRecord[] = [];

  private static mergeWithOffroadCache(dbPois: PoiRecord[]): PoiRecord[] {
    if (PoiManager.offroadPoisCache.length === 0) {
      dbPois.sort((a, b) => getPoiSortPriority(a) - getPoiSortPriority(b));
      return dbPois;
    }
    const dbById = new Map<string, PoiRecord>();
    for (const p of dbPois) {
      dbById.set(p.id, p);
    }
    const merged: PoiRecord[] = [...dbPois];
    for (const orPoi of PoiManager.offroadPoisCache) {
      if (!dbById.has(orPoi.id)) {
        merged.push(orPoi);
      }
    }
    merged.sort((a, b) => getPoiSortPriority(a) - getPoiSortPriority(b));
    return merged;
  }

  static async initializePois(): Promise<PoiRecord[]> {
    try {
      const [osmRes, offroadRes] = await Promise.all([
        fetch(bundledDataUrl('Israel.pois.geojson')),
        fetch(bundledDataUrl('Israel.offroad.pois.geojson')).catch(() => null),
      ]);

      const existingPois = await db.pois.toArray();
      const existingNotes = new Map<string, string>();
      for (const p of existingPois) {
        if (p.userNotes) existingNotes.set(p.id, p.userNotes);
      }

      const osmNextIds = new Set<string>();
      if (osmRes && osmRes.ok) {
        const geojson = await osmRes.json();
        if (Array.isArray(geojson.features) && geojson.features.length > 0) {
          const records: PoiRecord[] = geojson.features.map((f: any, index: number) =>
            hydrateGeojsonFeature(f, index, existingNotes, {
              defaultSource: 'IsraelHiking / OSM',
              basePriority: 100,
            })
          );

          for (const r of records) osmNextIds.add(r.id);
          const staleBundledIds = existingPois
            .filter(
              (p) =>
                (p.id.startsWith('osm-') || p.id.startsWith('il-poi-')) &&
                !osmNextIds.has(p.id) &&
                !p.userNotes
            )
            .map((p) => p.id);

          await db.transaction('rw', db.pois, async () => {
            if (staleBundledIds.length > 0) {
              await db.pois.bulkDelete(staleBundledIds);
            }
            await db.pois.bulkPut(records);
          });
        }
      }

      // Load separate Off-Road community overlay in memory (without bloating IndexedDB with 62k+ rows)
      if (offroadRes && offroadRes.ok) {
        try {
          const offroadGeo = await offroadRes.json();
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
              if (osmNextIds.has(rec.id)) continue;
              parsedOffroad.push(rec);
            }
            PoiManager.offroadPoisCache = parsedOffroad;
          }
        } catch (orParseErr) {
          console.warn('[PoiManager] Off-Road GeoJSON parse skipped:', orParseErr);
        }
      }
    } catch (err) {
      console.warn('[PoiManager] Offline mode — loading POIs from local IndexedDB cache:', err);
    }

    const all = await db.pois.toArray();
    return PoiManager.mergeWithOffroadCache(all);
  }

  static async getAllPois(): Promise<PoiRecord[]> {
    const all = await db.pois.toArray();
    return PoiManager.mergeWithOffroadCache(all);
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
  }

  static async addCustomUserPoi(params: {
    nameHe: string;
    nameEn?: string;
    category: PoiCategory;
    lon: number;
    lat: number;
    ele: number | null;
    descHe: string;
    userNotes?: string;
  }): Promise<PoiRecord> {
    const record: PoiRecord = {
      id: `user-poi-${Date.now()}`,
      name: params.nameHe,
      nameHe: params.nameHe,
      nameEn: params.nameEn || params.nameHe,
      category: params.category,
      subcategory: 'user_waypoint',
      lon: Number(params.lon.toFixed(6)),
      lat: Number(params.lat.toFixed(6)),
      ele: params.ele,
      waterStatus: params.category === 'water' ? 'דיווח משתמש בשטח' : null,
      difficulty4x4: params.category === 'offroad' ? 'דיווח עבירות 4x4' : null,
      descHe: params.descHe,
      descEn: params.descHe,
      source: 'User Field Report (דיווח מטייל)',
      wikipedia: null,
      userNotes: params.userNotes || '',
      updatedAt: new Date().toISOString(),
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
          priority: getPoiSortPriority(p),
        },
      })),
    };
  }
}

