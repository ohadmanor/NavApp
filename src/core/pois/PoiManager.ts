import { db, type PoiRecord, type PoiCategory } from '../db/NavDatabase';
import { bundledDataUrl } from '../dataUrls';

/**
 * Manages the Israeli Outdoor Points of Interest (Springs, Caves, Ruins, Campsites, 4x4 Passes, Peaks)
 * harvested from OpenStreetMap / IsraelHiking / Off-Road / Amud Anan into data/Israel.pois.geojson
 * and persisted in local IndexedDB (Dexie.js) for 100% offline operation.
 */
export class PoiManager {
  static async initializePois(): Promise<PoiRecord[]> {
    try {
      const response = await fetch(bundledDataUrl('Israel.pois.geojson'));
      if (response.ok) {
        const geojson = await response.json();
        if (Array.isArray(geojson.features) && geojson.features.length > 0) {
          const existingNotes = new Map<string, string>();
          const existingPois = await db.pois.toArray();
          for (const p of existingPois) {
            if (p.userNotes) existingNotes.set(p.id, p.userNotes);
          }

          const records: PoiRecord[] = geojson.features.map((f: any) => {
            const props = f.properties || {};
            const coords = f.geometry?.coordinates || [35.0615, 31.402];
            const id = String(props.id || f.id || `poi-${coords[0]}-${coords[1]}`);
            return {
              id,
              name: props.nameHe || props.name || props.nameEn || 'נקודת עניין',
              nameHe: props.nameHe || props.name || props.nameEn || 'נקודת עניין',
              nameEn: props.nameEn || props.name || props.nameHe || 'Point of Interest',
              category: (props.category as PoiCategory) || 'heritage',
              subcategory: props.subcategory || 'poi',
              lon: Number(coords[0]),
              lat: Number(coords[1]),
              ele: typeof props.ele === 'number' ? props.ele : null,
              waterStatus: props.waterStatus || null,
              difficulty4x4: props.difficulty4x4 || null,
              descHe: props.descHe || '',
              descEn: props.descEn || '',
              source: props.source || 'IsraelHiking / OSM',
              wikipedia: props.wikipedia || null,
              userNotes: existingNotes.get(id) || props.userNotes || '',
            };
          });

          await db.pois.bulkPut(records);
        }
      }
    } catch (err) {
      console.warn('[PoiManager] Offline mode — loading POIs from local IndexedDB cache:', err);
    }

    return await db.pois.toArray();
  }

  static async getAllPois(): Promise<PoiRecord[]> {
    return await db.pois.toArray();
  }

  static async searchPois(query: string, categoryFilter?: PoiCategory | 'all'): Promise<PoiRecord[]> {
    const q = query.trim().toLowerCase();
    const all = await db.pois.toArray();
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

  static async saveUserNote(poiId: string, userNotes: string): Promise<PoiRecord | undefined> {
    await db.pois.update(poiId, {
      userNotes,
      updatedAt: new Date().toISOString(),
    });
    return await db.pois.get(poiId);
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

    const filtered = pois.filter((p) => {
      if (p.category === 'water') return visibility.poiWater;
      if (p.category === 'heritage') return visibility.poiHeritage;
      if (p.category === 'campsite') return visibility.poiCampsites;
      if (p.category === 'offroad') return visibility.poiOffroad;
      if (p.category === 'peak') return visibility.poiPeaks;
      if (p.category === 'user') return visibility.poiUser ?? true;
      return true;
    });

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
        },
      })),
    };
  }
}

