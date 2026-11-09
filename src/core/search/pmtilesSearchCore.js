import { PMTiles, Compression, tileIdToZxy } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

export const SEARCH_INDEX_VERSION = 1;

export const SEARCH_LAYERS = [
  'place',
  'mountain_peak',
  'park',
  'aerodrome_label',
  'admin_area',
  'water',
  'flood_defence',
  'poi',
  'road',
  'aeroway',
  'building',
  'landcover',
];

const LAYER_INDEX_MAP = new Map(SEARCH_LAYERS.map((l, idx) => [l, idx]));

/**
 * Normalizes Hebrew, English, Arabic, punctuation, dashes, maqaf, and quotes for tolerant search matching.
 */
export function normalizeSearchText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[\u200e\u200f\u202a-\u202e\u200b]/g, '')
    .replace(/['"׳״’‘`´]/g, '')
    .replace(/[-–—־_/\\.,:;()[\]{}|!?+*~<>@#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanDisplayName(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\u200e\u200f\u202a-\u202e\u200b]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tilePixelToLonLat(z, x, y, px, py, extent = 4096) {
  const n = Math.pow(2, z);
  const tx = x + px / extent;
  const ty = y + py / extent;
  const lon = (tx / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [lon, lat];
}

export function haversineKmFast(lon1, lat1, lon2, lat2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

/**
 * Computes a stable fingerprint from a PMTiles archive header so prebuilt/cached search indexes
 * can verify exact alignment with the mounted vector archive.
 */
export function getPmtilesArchiveFingerprint(header) {
  if (!header) return '';
  const bounds = [
    Number(header.minLon ?? 0).toFixed(3),
    Number(header.minLat ?? 0).toFixed(3),
    Number(header.maxLon ?? 0).toFixed(3),
    Number(header.maxLat ?? 0).toFixed(3),
  ].join(',');
  return [
    header.numTileEntries ?? 0,
    header.numTileContents ?? 0,
    header.tileDataLength ?? 0,
    header.minZoom ?? 0,
    header.maxZoom ?? 0,
    bounds,
  ].join(':');
}

export function isGzipBytes(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gzipUint8Array(inputBytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this runtime');
  }
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const copy = new Uint8Array(inputBytes.byteLength);
  copy.set(inputBytes);
  const [, ab] = await Promise.all([
    (async () => {
      await writer.write(copy);
      await writer.close();
    })(),
    new Response(cs.readable).arrayBuffer(),
  ]);
  return new Uint8Array(ab);
}

export async function gunzipUint8Array(inputBytes) {
  if (!isGzipBytes(inputBytes)) {
    return inputBytes;
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this runtime');
  }
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const copy = new Uint8Array(inputBytes.byteLength);
  copy.set(inputBytes);
  const [, ab] = await Promise.all([
    (async () => {
      await writer.write(copy);
      await writer.close();
    })(),
    new Response(ds.readable).arrayBuffer(),
  ]);
  return new Uint8Array(ab);
}

/**
 * Reads a raw PMTiles v3 directory block (root or leaf) cleanly using only pbf.
 */
async function readPmtilesDirectory(source, offset, length, internalCompression, gunzipFn) {
  const res = await source.getBytes(offset, length);
  let bytes = new Uint8Array(res.data);
  if (internalCompression === Compression.Gzip || isGzipBytes(bytes)) {
    bytes = await gunzipFn(bytes);
  }
  const pbf = new PbfReader(bytes);
  const numEntries = pbf.readVarint();
  const tileIds = new Array(numEntries);
  const runLengths = new Array(numEntries);
  const lengths = new Array(numEntries);
  const offsets = new Array(numEntries);

  let lastId = 0;
  for (let i = 0; i < numEntries; i++) {
    lastId += pbf.readVarint();
    tileIds[i] = lastId;
  }
  for (let i = 0; i < numEntries; i++) {
    runLengths[i] = pbf.readVarint();
  }
  for (let i = 0; i < numEntries; i++) {
    lengths[i] = pbf.readVarint();
  }
  for (let i = 0; i < numEntries; i++) {
    const tmp = pbf.readVarint();
    if (tmp === 0 && i > 0) {
      offsets[i] = offsets[i - 1] + lengths[i - 1];
    } else {
      offsets[i] = tmp - 1;
    }
  }

  const entries = new Array(numEntries);
  for (let i = 0; i < numEntries; i++) {
    entries[i] = {
      tileId: tileIds[i],
      runLength: runLengths[i],
      length: lengths[i],
      offset: offsets[i],
    };
  }
  return entries;
}

/**
 * Walks root and all leaf directories in a PMTiles archive to enumerate every tile entry across all zoom levels.
 */
export async function readPmtilesTileDirectoryEntries(pmtiles, options = {}) {
  const gunzipFn = options.gunzip || gunzipUint8Array;
  const header = await pmtiles.getHeader();
  const source = pmtiles.source;
  const rootEntries = await readPmtilesDirectory(
    source,
    header.rootDirectoryOffset,
    header.rootDirectoryLength,
    header.internalCompression,
    gunzipFn
  );

  const leafEntryGroups = [];
  const leafQueue = [];
  const expanded = [];

  for (const entry of rootEntries) {
    if (entry.runLength === 0) {
      leafQueue.push(entry);
    } else {
      expanded.push(entry);
    }
  }

  // Batch leaf directory fetches slightly while avoiding flooding remote servers
  const batchSize = 12;
  for (let i = 0; i < leafQueue.length; i += batchSize) {
    const slice = leafQueue.slice(i, i + batchSize);
    const resolved = await Promise.all(
      slice.map((leaf) =>
        readPmtilesDirectory(
          source,
          header.leafDirectoryOffset + leaf.offset,
          leaf.length,
          header.internalCompression,
          gunzipFn
        )
      )
    );
    leafEntryGroups.push(...resolved);
  }

  for (const grp of leafEntryGroups) {
    for (const entry of grp) {
      expanded.push(entry);
    }
  }

  const byZoom = new Map();
  for (const entry of expanded) {
    const rl = Math.max(1, entry.runLength || 1);
    for (let r = 0; r < rl; r++) {
      const [z, x, y] = tileIdToZxy(entry.tileId + r);
      let arr = byZoom.get(z);
      if (!arr) {
        arr = [];
        byZoom.set(z, arr);
      }
      arr.push({
        z,
        x,
        y,
        offset: entry.offset,
        length: entry.length,
      });
    }
  }

  return { header, byZoom };
}

/**
 * Computes representative [lon, lat], buffer flag, and tile-clipped extent for a decoded MVT feature.
 */
function extractFeatureGeo(feature, z, x, y, extent) {
  let rings;
  try {
    rings = feature.loadGeometry();
  } catch {
    return null;
  }
  if (!rings || rings.length === 0) return null;

  if (feature.type === 1) {
    let chosen = null;
    let buffered = false;
    for (const ring of rings) {
      for (const pt of ring) {
        const inside = pt.x >= 0 && pt.x <= extent && pt.y >= 0 && pt.y <= extent;
        if (inside) {
          chosen = pt;
          buffered = false;
          break;
        }
        if (!chosen) {
          chosen = pt;
          buffered = true;
        }
      }
      if (chosen && !buffered) break;
    }
    if (!chosen) return null;
    const [lon, lat] = tilePixelToLonLat(z, x, y, chosen.x, chosen.y, extent);
    return { lon, lat, buffered, minLon: lon, maxLon: lon, minLat: lat, maxLat: lat };
  }

  // LineString or Polygon: compute midpoint + clamped bounds inside tile
  let bestRing = rings[0];
  for (let i = 1; i < rings.length; i++) {
    if (rings[i].length > bestRing.length) bestRing = rings[i];
  }
  if (!bestRing || bestRing.length === 0) return null;

  let minPx = Infinity;
  let minPy = Infinity;
  let maxPx = -Infinity;
  let maxPy = -Infinity;
  let allBuffered = true;

  for (const pt of bestRing) {
    if (pt.x >= 0 && pt.x <= extent && pt.y >= 0 && pt.y <= extent) {
      allBuffered = false;
    }
    const cx = Math.max(0, Math.min(extent, pt.x));
    const cy = Math.max(0, Math.min(extent, pt.y));
    if (cx < minPx) minPx = cx;
    if (cy < minPy) minPy = cy;
    if (cx > maxPx) maxPx = cx;
    if (cy > maxPy) maxPy = cy;
  }

  let repLon;
  let repLat;
  if (feature.type === 3) {
    const cpx = (minPx + maxPx) / 2;
    const cpy = (minPy + maxPy) / 2;
    [repLon, repLat] = tilePixelToLonLat(z, x, y, cpx, cpy, extent);
  } else {
    const insidePts = bestRing.filter(
      (pt) => pt.x >= -64 && pt.x <= extent + 64 && pt.y >= -64 && pt.y <= extent + 64
    );
    const seq = insidePts.length > 0 ? insidePts : bestRing;
    const mid = seq[Math.floor(seq.length / 2)];
    [repLon, repLat] = tilePixelToLonLat(z, x, y, mid.x, mid.y, extent);
  }

  const [minLon, maxLat] = tilePixelToLonLat(z, x, y, minPx, minPy, extent);
  const [maxLon, minLat] = tilePixelToLonLat(z, x, y, maxPx, maxPy, extent);

  return {
    lon: repLon,
    lat: repLat,
    buffered: allBuffered,
    minLon,
    maxLon,
    minLat,
    maxLat,
  };
}

/**
 * Priority tier (0 = highest importance, 5 = lowest) matching map user intent in NavApp.
 */
export function computeRecordTier(layer, cls, subclass, rank, ele) {
  if (layer === 'place') {
    if (cls === 'country' || cls === 'city') return 0;
    if (cls === 'town') return rank !== null && rank <= 6 ? 0 : 1;
    if (cls === 'village' || cls === 'suburb' || cls === 'island') return 1;
    return 2;
  }
  if (layer === 'mountain_peak' || layer === 'park' || layer === 'aerodrome_label') {
    return 1;
  }
  if (layer === 'admin_area') {
    return cls === 'lvl_2' || cls === 'lvl_4' ? 1 : 2;
  }
  if (layer === 'flood_defence') {
    return 2;
  }
  if (layer === 'water') {
    if (cls === 'lake' || cls === 'river') return 1;
    if (cls === 'stream') return 2;
    return 3;
  }
  if (layer === 'poi') {
    if (cls === 'bus' || subclass === 'bus_stop') return 5;
    if (cls === 'barrier' && subclass === 'gate') return 4;
    if (
      subclass === 'viewpoint' ||
      subclass === 'camp_site' ||
      subclass === 'caravan_site' ||
      subclass === 'picnic_site' ||
      subclass === 'alpine_hut' ||
      subclass === 'ruins' ||
      subclass === 'monument' ||
      subclass === 'attraction' ||
      subclass === 'visitor_centre' ||
      subclass === 'hospital' ||
      subclass === 'station' ||
      subclass === 'university' ||
      cls === 'campsite' ||
      cls === 'castle' ||
      cls === 'railway' ||
      cls === 'harbor'
    ) {
      return 2;
    }
    if (
      cls === 'hospital' ||
      cls === 'amenity' ||
      cls === 'lodging' ||
      cls === 'tourism' ||
      cls === 'park' ||
      cls === 'leisure' ||
      cls === 'college' ||
      cls === 'town_hall'
    ) {
      return 3;
    }
    if (!cls && !subclass) {
      return rank !== null && rank <= 10 ? 2 : 4;
    }
    return 3;
  }
  if (layer === 'road') {
    if (cls === 'motorway' || cls === 'trunk') return 2;
    if (cls === 'primary' || cls === 'secondary' || cls === 'track' || cls === 'path') return 3;
    if (cls === 'tertiary' || cls === 'ferry' || cls === 'aerialway') return 3;
    return 4;
  }
  if (layer === 'aeroway') return 4;
  if (layer === 'building' || layer === 'landcover') return 3;
  return 4;
}

const ROAD_CLASS_PRIORITY = {
  motorway: 1,
  trunk: 2,
  primary: 3,
  secondary: 4,
  tertiary: 5,
  track: 6,
  path: 7,
  cycleway: 8,
  rail: 9,
  aerialway: 10,
  ferry: 11,
  minor: 12,
  service: 13,
};

function synthesizeRoadName(cls, ref) {
  if (!ref) return '';
  if (
    cls === 'motorway' ||
    cls === 'trunk' ||
    cls === 'primary' ||
    cls === 'secondary' ||
    cls === 'tertiary'
  ) {
    return `כביש ${ref}`;
  }
  if (cls === 'track' || cls === 'path') return `שביל ${ref}`;
  if (cls === 'rail') return `קו רכבת ${ref}`;
  return `דרך ${ref}`;
}

/**
 * Extracts raw searchable records from a single decoded VectorTile at (z, x, y).
 */
export function extractRawRecordsFromVectorTile(vt, z, x, y) {
  const out = [];

  for (const lname of Object.keys(vt.layers)) {
    if (
      lname === 'housenumber' ||
      lname === 'boundary' ||
      lname === 'fuel_line' ||
      lname === 'water' ||
      lname === 'landuse' ||
      lname === 'transportation'
    ) {
      continue;
    }

    const layer = vt.layers[lname];
    if (!layer || layer.length === 0) continue;
    const extent = layer.extent || 4096;

    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const p = f.properties || {};

      const rawLatin = cleanDisplayName(p['name:latin']);
      const rawName = cleanDisplayName(p.name);
      const rawEn = cleanDisplayName(p.name_en);
      const ref = cleanDisplayName(p.ref);
      const iata = cleanDisplayName(p.iata);
      const icao = cleanDisplayName(p.icao);

      let canonicalLayer = lname;
      let cls = cleanDisplayName(p.class);
      let subclass = cleanDisplayName(p.subclass);
      let name = rawLatin || rawName || rawEn;
      let altName = rawEn && rawEn !== name ? rawEn : rawName && rawName !== name ? rawName : '';
      let refOrCode = ref;
      let ele = Number.isFinite(Number(p.ele)) ? Math.round(Number(p.ele)) : null;
      let rank = Number.isFinite(Number(p.rank)) ? Number(p.rank) : 25;

      if (lname === 'water_name' || lname === 'waterway') {
        canonicalLayer = 'water';
      } else if (lname === 'transportation_name') {
        canonicalLayer = 'road';
        if (!name && ref) {
          name = synthesizeRoadName(cls, ref);
        }
      } else if (lname === 'admin_area') {
        if (p.admin_level !== undefined && p.admin_level !== null) {
          cls = `lvl_${p.admin_level}`;
        }
        refOrCode = cleanDisplayName(p.iso_3166_2) || cleanDisplayName(p.iso_a2) || ref;
      } else if (lname === 'aerodrome_label') {
        refOrCode = [iata, icao].filter(Boolean).join(' / ');
        if (!name && refOrCode) name = refOrCode;
      } else if (lname === 'aeroway') {
        if (!name && ref) {
          name = cls === 'runway' ? `מסלול ${ref}` : `מסלול הסעה ${ref}`;
        }
        refOrCode = ref;
      } else if (lname === 'flood_defence') {
        const crest = Number(p.crest_m ?? p.height_m);
        if (Number.isFinite(crest) && crest > 0) ele = Math.round(crest);
      } else if (lname === 'place') {
        if (Number(p.capital) === 2) rank = 0;
        else if (Number(p.capital) === 4 && rank > 3) rank = 3;
      }

      if (!name) continue;
      const normName = normalizeSearchText(name);
      if (!normName || normName.length < 2) {
        // Allow 1-char highway refs like Road 1, Road 2, Road 6
        if (!(canonicalLayer === 'road' && ref && ref.length >= 1)) continue;
      }

      const geo = extractFeatureGeo(f, z, x, y, extent);
      if (!geo) continue;

      out.push({
        layer: canonicalLayer,
        sourceLayer: lname,
        cls,
        subclass,
        name,
        altName,
        refOrCode,
        normName,
        lon: geo.lon,
        lat: geo.lat,
        minLon: geo.minLon,
        maxLon: geo.maxLon,
        minLat: geo.minLat,
        maxLat: geo.maxLat,
        buffered: geo.buffered,
        ele,
        rank,
        z,
      });
    }
  }

  return out;
}

const CLUSTER_MERGE_RADIUS_KM = {
  place_country: 200,
  place_region: 80,
  place_city: 18,
  place_town: 10,
  place_village: 4.5,
  place_suburb: 2.0,
  place_other: 2.0,
  mountain_peak: 1.8,
  aerodrome_label: 6.0,
  water: 8.5,
  flood_defence: 3.0,
  park: 22.0,
};

function getClusterRadiusKm(r) {
  if (r.layer === 'place') {
    return CLUSTER_MERGE_RADIUS_KM[`place_${r.cls}`] ?? CLUSTER_MERGE_RADIUS_KM.place_other;
  }
  return CLUSTER_MERGE_RADIUS_KM[r.layer] ?? null;
}

/**
 * Spatial hashing & centroid/bbox aggregation + nearest-locality enrichment producing a compact columnar payload.
 */
export class SearchIndexBuilder {
  constructor(meta = {}) {
    this.meta = meta;
    this.buckets = new Map();
    this.clusterGroups = new Map(); // Distance-clustered records (eliminates grid-edge duplicates)
    this.bboxGroups = new Map(); // Used for admin_area centroid averaging across tiles
  }

  ingestRecords(records) {
    for (const r of records) {
      if (r.layer === 'admin_area') {
        const key = `${r.layer}|${r.normName}|${r.cls}`;
        const existing = this.bboxGroups.get(key);
        if (!existing) {
          this.bboxGroups.set(key, {
            ...r,
            count: 1,
          });
        } else {
          existing.minLon = Math.min(existing.minLon, r.minLon);
          existing.maxLon = Math.max(existing.maxLon, r.maxLon);
          existing.minLat = Math.min(existing.minLat, r.minLat);
          existing.maxLat = Math.max(existing.maxLat, r.maxLat);
          existing.lon = (existing.minLon + existing.maxLon) / 2;
          existing.lat = (existing.minLat + existing.maxLat) / 2;
          if (!existing.altName && r.altName) existing.altName = r.altName;
          if (!existing.refOrCode && r.refOrCode) existing.refOrCode = r.refOrCode;
          existing.count += 1;
        }
        continue;
      }

      const mergeRadiusKm = getClusterRadiusKm(r);
      if (mergeRadiusKm !== null) {
        const gKey =
          r.layer === 'place' || r.layer === 'park'
            ? `${r.layer}|${r.cls}|${r.normName}`
            : `${r.layer}|${r.normName}`;
        let clusters = this.clusterGroups.get(gKey);
        if (!clusters) {
          clusters = [{ ...r }];
          this.clusterGroups.set(gKey, clusters);
        } else {
          let merged = false;
          for (let i = 0; i < clusters.length; i++) {
            const c = clusters[i];
            if (haversineKmFast(r.lon, r.lat, c.lon, c.lat) <= mergeRadiusKm) {
              if (r.layer === 'park') {
                const minLon = Math.min(c.minLon, r.minLon);
                const maxLon = Math.max(c.maxLon, r.maxLon);
                const minLat = Math.min(c.minLat, r.minLat);
                const maxLat = Math.max(c.maxLat, r.maxLat);
                const preferNew = this.shouldReplace(c, r);
                clusters[i] = {
                  ...(preferNew ? r : c),
                  minLon,
                  maxLon,
                  minLat,
                  maxLat,
                  lon: (minLon + maxLon) / 2,
                  lat: (minLat + maxLat) / 2,
                  altName: c.altName || r.altName,
                  refOrCode: c.refOrCode || r.refOrCode,
                  ele: r.ele !== null ? r.ele : c.ele,
                };
              } else if (this.shouldReplace(c, r)) {
                clusters[i] = {
                  ...r,
                  altName: r.altName || c.altName,
                  refOrCode: r.refOrCode || c.refOrCode,
                  ele: r.ele !== null ? r.ele : c.ele,
                };
              } else {
                if (!c.altName && r.altName) c.altName = r.altName;
                if (!c.refOrCode && r.refOrCode) c.refOrCode = r.refOrCode;
                if (c.ele === null && r.ele !== null) c.ele = r.ele;
              }
              merged = true;
              break;
            }
          }
          if (!merged) {
            clusters.push({ ...r });
          }
        }
        continue;
      }

      const dedupKey = this.makeDedupKey(r);
      const existing = this.buckets.get(dedupKey);
      if (!existing) {
        this.buckets.set(dedupKey, r);
      } else if (this.shouldReplace(existing, r)) {
        this.buckets.set(dedupKey, {
          ...r,
          altName: r.altName || existing.altName,
          refOrCode: r.refOrCode || existing.refOrCode,
          ele: r.ele !== null ? r.ele : existing.ele,
        });
      }
    }
  }

  makeDedupKey(r) {
    switch (r.layer) {
      case 'poi': {
        const cLat = Math.round(r.lat / 0.0022);
        const cLon = Math.round(r.lon / 0.0025);
        return `poi|${r.cls}|${r.subclass}|${r.normName}|${cLat}:${cLon}`;
      }
      case 'road': {
        const isHighwayRefOnly = !r.normName || r.name.startsWith('כביש ');
        const stepLat = isHighwayRefOnly ? 0.045 : 0.018;
        const stepLon = isHighwayRefOnly ? 0.045 : 0.02;
        const cLat = Math.round(r.lat / stepLat);
        const cLon = Math.round(r.lon / stepLon);
        const idPart = r.normName || `ref:${r.refOrCode}`;
        return `road|${idPart}|${cLat}:${cLon}`;
      }
      case 'aeroway': {
        const cLat = Math.round(r.lat / 0.025);
        const cLon = Math.round(r.lon / 0.025);
        return `aeroway|${r.cls}|${r.normName}|${cLat}:${cLon}`;
      }
      default: {
        const cLat = Math.round(r.lat / 0.003);
        const cLon = Math.round(r.lon / 0.003);
        return `${r.layer}|${r.normName}|${cLat}:${cLon}`;
      }
    }
  }

  shouldReplace(existing, candidate) {
    // Prefer higher zoom (highest precision z14 over z10)
    if (candidate.z !== existing.z) {
      return candidate.z > existing.z;
    }
    // Prefer interior vertices over tile-border buffer duplicates
    if (existing.buffered !== candidate.buffered) {
      return !candidate.buffered;
    }
    if (existing.layer === 'water' && candidate.layer === 'water') {
      // Prefer explicit water_name points / lakes / rivers over drain/ditch segments
      if (existing.sourceLayer !== candidate.sourceLayer) {
        return candidate.sourceLayer === 'water_name';
      }
    }
    if (existing.layer === 'road' && candidate.layer === 'road') {
      const pOld = ROAD_CLASS_PRIORITY[existing.cls] ?? 99;
      const pNew = ROAD_CLASS_PRIORITY[candidate.cls] ?? 99;
      if (pNew !== pOld) return pNew < pOld;
    }
    if (candidate.ele !== null && existing.ele === null) return true;
    if (candidate.rank < existing.rank) return true;
    return false;
  }

  /**
   * Produces the final compact columnar SearchIndexPayload enriched with nearest-locality lookup.
   */
  buildPayload() {
    const clusteredList = [];
    for (const grp of this.clusterGroups.values()) {
      for (const item of grp) clusteredList.push(item);
    }

    const allRecords = [
      ...this.bboxGroups.values(),
      ...clusteredList,
      ...this.buckets.values(),
    ];

    // 1. Collect cities, towns, villages & hamlets for clean nearest-locality enrichment
    // Skip suburbs/quarters and purely numeric names (e.g. quarter numbers "15") so POIs get real city/town names.
    const settlements = [];
    const grid = new Map();
    const cellDeg = 0.08;

    for (const r of allRecords) {
      if (r.layer !== 'place') continue;
      if (
        r.cls !== 'city' &&
        r.cls !== 'town' &&
        r.cls !== 'village' &&
        r.cls !== 'hamlet'
      ) {
        continue;
      }
      if (/^\d+$/.test(r.name)) continue;

      const weight =
        r.cls === 'city'
          ? 0.28
          : r.cls === 'town'
            ? 0.36
            : r.cls === 'village'
              ? 0.68
              : 0.92;
      const maxKm = r.cls === 'city' ? 16 : r.cls === 'town' ? 12 : r.cls === 'village' ? 7 : 4.5;
      const item = { name: r.name, lon: r.lon, lat: r.lat, weight, maxKm };
      settlements.push(item);

      const gx = Math.floor(r.lon / cellDeg);
      const gy = Math.floor(r.lat / cellDeg);
      const key = `${gx}:${gy}`;
      let list = grid.get(key);
      if (!list) {
        list = [];
        grid.set(key, list);
      }
      list.push(item);
    }

    const findNearestLocality = (lon, lat) => {
      if (settlements.length === 0) return '';
      const gx = Math.floor(lon / cellDeg);
      const gy = Math.floor(lat / cellDeg);
      let bestName = '';
      let bestScore = Infinity;

      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const list = grid.get(`${gx + dx}:${gy + dy}`);
          if (!list) continue;
          for (const s of list) {
            const dKm = haversineKmFast(lon, lat, s.lon, s.lat);
            if (dKm <= s.maxKm) {
              const weighted = dKm * s.weight;
              if (weighted < bestScore) {
                bestScore = weighted;
                bestName = s.name;
              }
            }
          }
        }
      }
      return bestName;
    };

    // 2. Build dictionary tables
    const layers = [...SEARCH_LAYERS];
    const layerMap = new Map(LAYER_INDEX_MAP);
    const classes = [''];
    const classMap = new Map([['', 0]]);
    const subclasses = [''];
    const subclassMap = new Map([['', 0]]);
    const localities = [''];
    const localityMap = new Map([['', 0]]);

    const intern = (arr, map, val) => {
      const v = val || '';
      let idx = map.get(v);
      if (idx === undefined) {
        idx = arr.length;
        arr.push(v);
        map.set(v, idx);
      }
      return idx;
    };

    // Sort records by tier ascending so even sequential scans hit high-value results early
    const enriched = allRecords.map((r) => {
      const tier = computeRecordTier(r.layer, r.cls, r.subclass, r.rank, r.ele);
      const locality =
        r.layer === 'place' && (r.cls === 'city' || r.cls === 'town' || r.cls === 'country')
          ? ''
          : r.layer === 'admin_area'
            ? ''
            : findNearestLocality(r.lon, r.lat);
      return { r, tier, locality: locality === r.name ? '' : locality };
    });

    enriched.sort((a, b) => a.tier - b.tier || a.r.rank - b.r.rank);

    const rows = new Array(enriched.length);
    for (let i = 0; i < enriched.length; i++) {
      const { r, tier, locality } = enriched[i];
      let lIdx = layerMap.get(r.layer);
      if (lIdx === undefined) {
        lIdx = layers.length;
        layers.push(r.layer);
        layerMap.set(r.layer, lIdx);
      }
      const cIdx = intern(classes, classMap, r.cls);
      const sIdx = intern(subclasses, subclassMap, r.subclass);
      const locIdx = intern(localities, localityMap, locality);

      rows[i] = [
        lIdx,
        cIdx,
        sIdx,
        locIdx,
        r.name,
        r.altName || '',
        r.refOrCode || '',
        Math.round(r.lat * 100000),
        Math.round(r.lon * 100000),
        r.ele,
        r.rank,
        tier,
      ];
    }

    return {
      v: SEARCH_INDEX_VERSION,
      createdUtc: this.meta.createdUtc || new Date().toISOString(),
      fingerprint: this.meta.fingerprint || '',
      bounds: this.meta.bounds || [33.99, 29.43, 35.92, 33.46],
      minZoom: this.meta.minZoom ?? 0,
      maxZoom: this.meta.maxZoom ?? 14,
      totalFeatures: rows.length,
      layers,
      classes,
      subclasses,
      localities,
      rows,
    };
  }
}

/**
 * Extracts a full SearchIndexPayload directly from any mounted PMTiles instance (browser FileSource, OPFS, FetchSource, or Node).
 */
export async function extractSearchIndexFromPmtiles(pmtiles, options = {}) {
  const gunzipFn = options.gunzip || gunzipUint8Array;
  const onProgress = options.onProgress;
  const yieldEvery = options.yieldEvery ?? 64;
  const signal = options.signal;

  const { header, byZoom } = await readPmtilesTileDirectoryEntries(pmtiles, { gunzip: gunzipFn });
  const zoomLevels = Array.from(byZoom.keys()).sort((a, b) => b - a);
  const totalTiles = zoomLevels.reduce((sum, z) => sum + (byZoom.get(z)?.length || 0), 0);

  const builder = new SearchIndexBuilder({
    fingerprint: getPmtilesArchiveFingerprint(header),
    bounds: [
      Number(header.minLon ?? 0),
      Number(header.minLat ?? 0),
      Number(header.maxLon ?? 0),
      Number(header.maxLat ?? 0),
    ],
    minZoom: header.minZoom ?? 0,
    maxZoom: header.maxZoom ?? 14,
  });

  const emptyByteRanges = new Set();
  let processed = 0;

  for (const z of zoomLevels) {
    const tiles = byZoom.get(z) || [];
    for (const tile of tiles) {
      if (signal?.aborted) {
        throw new Error('Indexing aborted');
      }

      const byteKey = `${tile.offset}:${tile.length}`;
      if (!emptyByteRanges.has(byteKey)) {
        const absOffset = header.tileDataOffset + tile.offset;
        const rawRes = await pmtiles.source.getBytes(absOffset, tile.length);
        let tileBytes = new Uint8Array(rawRes.data);
        if (options.gunzip) {
          if (header.tileCompression === Compression.Gzip || isGzipBytes(tileBytes)) {
            tileBytes = await options.gunzip(tileBytes);
          }
        } else if (typeof pmtiles.decompress === 'function' && header.tileCompression !== Compression.None) {
          tileBytes = new Uint8Array(await pmtiles.decompress(rawRes.data, header.tileCompression));
        } else if (header.tileCompression === Compression.Gzip || isGzipBytes(tileBytes)) {
          tileBytes = await gunzipFn(tileBytes);
        }
        const vt = new VectorTile(new PbfReader(tileBytes));
        const records = extractRawRecordsFromVectorTile(vt, tile.z, tile.x, tile.y);
        if (records.length === 0) {
          emptyByteRanges.add(byteKey);
        } else {
          builder.ingestRecords(records);
        }
      }

      processed += 1;
      if (onProgress && (processed % 50 === 0 || processed === totalTiles)) {
        onProgress(processed, totalTiles);
      }
      if (yieldEvery > 0 && processed % yieldEvery === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  return builder.buildPayload();
}

export async function serializeSearchIndexPayload(payload, options = {}) {
  const jsonText = JSON.stringify(payload);
  const rawBytes = new TextEncoder().encode(jsonText);
  if (options.gzip === false) {
    return rawBytes;
  }
  const gzipFn = options.gzipFn || gzipUint8Array;
  return await gzipFn(rawBytes);
}

export async function parseSearchIndexBytes(bytes, options = {}) {
  const gunzipFn = options.gunzip || gunzipUint8Array;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength === 0) {
    throw new Error('Empty search index payload');
  }

  // Reject HTML 404/SPA rewrites explicitly
  if (u8[0] === 0x3c /* '<' */) {
    throw new Error('Unexpected HTML response instead of search index');
  }

  const plainBytes = isGzipBytes(u8) ? await gunzipFn(u8) : u8;
  const jsonStr = new TextDecoder().decode(plainBytes);
  const parsed = JSON.parse(jsonStr);
  if (!parsed || parsed.v !== SEARCH_INDEX_VERSION || !Array.isArray(parsed.rows)) {
    throw new Error('Invalid search index schema version');
  }
  return parsed;
}
