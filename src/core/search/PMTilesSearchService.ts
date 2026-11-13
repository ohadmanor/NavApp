import { db, type PoiCategory, type PoiRecord, type SavedRouteRecord } from '../db/NavDatabase';
import { offlineDataFiles } from '../pmtiles/OfflineDataFiles';
import { MilitaryGridService } from '../navigation/MilitaryGridService';
import type { MountedArchiveInfo } from '../pmtiles/PMTilesRegistry';
import {
  extractSearchIndexFromPmtiles,
  getPmtilesArchiveFingerprint,
  haversineKmFast,
  isGzipBytes,
  normalizeSearchText,
  parseSearchIndexBytes,
  serializeSearchIndexPayload,
  type SearchIndexPayload,
} from './pmtilesSearchCore.js';
import {
  resolveSearchTaxonomy,
  type SearchFilterCategory,
  type SearchTaxonomyInfo,
} from './searchTaxonomy';

export type SearchResultKind = 'curated-poi' | 'pmtiles' | 'route' | 'coord';

export interface SearchResultItem {
  id: string;
  kind: SearchResultKind;
  title: string;
  subtitle: string;
  locality: string;
  categoryLabel: string;
  emoji: string;
  filterGroup: Exclude<SearchFilterCategory, 'all'>;
  poiCategory: PoiCategory;
  subcategory: string;
  ref: string;
  lon: number;
  lat: number;
  ele: number | null;
  distanceKm: number | null;
  recommendedZoom: number;
  score: number;
  sourceLabel: string;
  poiRecord?: PoiRecord;
  routeRecord?: SavedRouteRecord;
  toPoiRecord(): PoiRecord;
}

export interface SearchIndexStatus {
  ready: boolean;
  source: 'none' | 'bundled' | 'idb-cache' | 'pmtiles-extract';
  fingerprint: string;
  totalFeatures: number;
  indexingProgress: { done: number; total: number } | null;
  error?: string | null;
}

export interface SearchQueryOptions {
  filter?: SearchFilterCategory;
  referenceCoord?: { lon: number; lat: number } | null;
  pois?: PoiRecord[];
  routes?: SavedRouteRecord[];
  deletedSignatures?: Array<{ id: string; normName: string; lon: number; lat: number }>;
  limit?: number;
}

interface TaxonomyCacheEntry {
  info: SearchTaxonomyInfo;
  normSynonyms: string;
}

interface CompiledIndex {
  payload: SearchIndexPayload;
  rowCount: number;
  layerIdxArr: Uint8Array;
  clsIdxArr: Uint16Array;
  subIdxArr: Uint16Array;
  locIdxArr: Uint16Array;
  latArr: Float64Array;
  lonArr: Float64Array;
  eleArr: Int16Array;
  rankArr: Uint8Array;
  tierArr: Uint8Array;
  names: string[];
  altNames: string[];
  refs: string[];
  normNames: string[];
  normAlts: string[];
  normRefs: string[];
  dictLayers: string[];
  dictClasses: string[];
  dictSubclasses: string[];
  dictLocs: string[];
  dictNormLocs: string[];
  taxCache: Map<string, TaxonomyCacheEntry>;
}

const ELE_NULL_SENTINEL = -32768;
const TIER_BOOST = [680, 440, 220, 60, -40, -260] as const;
const STOP_WORDS = new Set(['של', 'את', 'על', 'אל', 'the', 'of', 'in', 'at', 'to']);

function compilePayload(payload: SearchIndexPayload): CompiledIndex {
  const rowCount = payload.rows.length;
  const layerIdxArr = new Uint8Array(rowCount);
  const clsIdxArr = new Uint16Array(rowCount);
  const subIdxArr = new Uint16Array(rowCount);
  const locIdxArr = new Uint16Array(rowCount);
  const latArr = new Float64Array(rowCount);
  const lonArr = new Float64Array(rowCount);
  const eleArr = new Int16Array(rowCount);
  const rankArr = new Uint8Array(rowCount);
  const tierArr = new Uint8Array(rowCount);

  const names = new Array<string>(rowCount);
  const altNames = new Array<string>(rowCount);
  const refs = new Array<string>(rowCount);
  const normNames = new Array<string>(rowCount);
  const normAlts = new Array<string>(rowCount);
  const normRefs = new Array<string>(rowCount);

  for (let i = 0; i < rowCount; i++) {
    const r = payload.rows[i];
    layerIdxArr[i] = r[0];
    clsIdxArr[i] = r[1];
    subIdxArr[i] = r[2];
    locIdxArr[i] = r[3];
    const name = r[4] || '';
    const altName = r[5] || '';
    const ref = r[6] || '';
    names[i] = name;
    altNames[i] = altName;
    refs[i] = ref;
    normNames[i] = normalizeSearchText(name);
    normAlts[i] = altName ? normalizeSearchText(altName) : '';
    normRefs[i] = ref ? normalizeSearchText(ref) : '';
    latArr[i] = r[7] / 1e5;
    lonArr[i] = r[8] / 1e5;
    eleArr[i] = r[9] === null || r[9] === undefined ? ELE_NULL_SENTINEL : Math.max(-32767, Math.min(32767, r[9]));
    rankArr[i] = Math.max(0, Math.min(255, r[10] ?? 25));
    tierArr[i] = Math.max(0, Math.min(5, r[11] ?? 3));
  }

  const dictNormLocs = payload.localities.map((l) => (l ? normalizeSearchText(l) : ''));

  return {
    payload,
    rowCount,
    layerIdxArr,
    clsIdxArr,
    subIdxArr,
    locIdxArr,
    latArr,
    lonArr,
    eleArr,
    rankArr,
    tierArr,
    names,
    altNames,
    refs,
    normNames,
    normAlts,
    normRefs,
    dictLayers: payload.layers,
    dictClasses: payload.classes,
    dictSubclasses: payload.subclasses,
    dictLocs: payload.localities,
    dictNormLocs,
    taxCache: new Map<string, TaxonomyCacheEntry>(),
  };
}

function getTaxonomyCached(compiled: CompiledIndex, lIdx: number, cIdx: number, sIdx: number): TaxonomyCacheEntry {
  const key = `${lIdx}:${cIdx}:${sIdx}`;
  let entry = compiled.taxCache.get(key);
  if (!entry) {
    const layer = compiled.dictLayers[lIdx] || 'poi';
    const cls = compiled.dictClasses[cIdx] || '';
    const sub = compiled.dictSubclasses[sIdx] || '';
    const info = resolveSearchTaxonomy(layer, cls, sub);
    entry = {
      info,
      normSynonyms: normalizeSearchText(info.synonyms),
    };
    compiled.taxCache.set(key, entry);
  }
  return entry;
}

function hasWholeWord(haystack: string, word: string): boolean {
  if (!haystack || !word) return false;
  if (haystack === word) return true;
  if (haystack.startsWith(`${word} `)) return true;
  if (haystack.endsWith(` ${word}`)) return true;
  return haystack.includes(` ${word} `);
}

function startsAtWordBoundary(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return haystack.startsWith(needle) || haystack.includes(` ${needle}`);
}

function matchLocToken(normLoc: string, token: string): number {
  if (!normLoc || !token) return 0;
  if (normLoc === token) return 3;
  if (startsAtWordBoundary(normLoc, token)) return 2;
  if (normLoc.includes(token)) return 1;
  // Handle common Hebrew prepositions attached to city names (בחיפה / לתל אביב / מירושלים)
  if (token.length >= 3 && 'בלמהו'.includes(token[0])) {
    const stripped = token.slice(1);
    if (normLoc === stripped) return 2.5;
    if (startsAtWordBoundary(normLoc, stripped)) return 1.8;
  }
  return 0;
}

function scoreSingleFieldMatch(haystack: string, normQuery: string): number {
  if (!haystack || !normQuery) return 0;
  if (haystack === normQuery) return 2550;
  if (haystack.startsWith(normQuery)) {
    const wordBoundBonus =
      haystack.length === normQuery.length || haystack[normQuery.length] === ' ' ? 450 : 0;
    const tightness = Math.round(350 * (normQuery.length / Math.max(haystack.length, 1)));
    return 1300 + wordBoundBonus + tightness;
  }
  if (hasWholeWord(haystack, normQuery)) {
    return 1120 + Math.round(250 * (normQuery.length / Math.max(haystack.length, 1)));
  }
  if (startsAtWordBoundary(haystack, normQuery)) {
    return 950 + Math.round(240 * (normQuery.length / Math.max(haystack.length, 1)));
  }
  if (haystack.includes(normQuery)) {
    return 720 + Math.round(220 * (normQuery.length / Math.max(haystack.length, 1)));
  }
  return 0;
}

function extractRoadRefQuery(normQuery: string): string | null {
  const m = normQuery.match(
    /^(?:(?:כביש|ציר|דרך|route|road|hwy|highway)\s+)?(\d{1,4}[א-תa-z]?)$/i
  );
  return m ? m[1] : null;
}

function matchesPoiFilter(poi: PoiRecord, filter: SearchFilterCategory): boolean {
  if (filter === 'all' || filter === 'pois') return true;
  if (filter === 'routes' || filter === 'places') return false;
  if (filter === 'nature') {
    return (
      poi.category === 'water' ||
      poi.category === 'peak' ||
      poi.category === 'campsite' ||
      poi.subcategory === 'viewpoint' ||
      poi.subcategory === 'cave'
    );
  }
  if (filter === 'roads') {
    return poi.category === 'offroad';
  }
  return false;
}

function computeRouteCentroid(route: SavedRouteRecord): [number, number] | null {
  if (Array.isArray(route.bounds) && route.bounds.length === 4) {
    const [minLon, minLat, maxLon, maxLat] = route.bounds;
    if (
      Number.isFinite(minLon) &&
      Number.isFinite(minLat) &&
      Number.isFinite(maxLon) &&
      Number.isFinite(maxLat)
    ) {
      return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    }
  }
  const pts = route.elevationProfile || [];
  if (pts.length > 0) {
    const mid = pts[Math.floor(pts.length / 2)];
    if (Number.isFinite(mid.lon) && Number.isFinite(mid.lat)) {
      return [mid.lon, mid.lat];
    }
  }
  const feat = route.geojson?.features?.find((f) => f.geometry?.type === 'LineString') as
    | GeoJSON.Feature<GeoJSON.LineString>
    | undefined;
  const coords = feat?.geometry?.coordinates || [];
  if (coords.length > 0) {
    const mid = coords[Math.floor(coords.length / 2)];
    if (Array.isArray(mid) && Number.isFinite(mid[0]) && Number.isFinite(mid[1])) {
      return [mid[0], mid[1]];
    }
  }
  return null;
}

export class PMTilesSearchService {
  private compiled: CompiledIndex | null = null;
  private status: SearchIndexStatus = {
    ready: false,
    source: 'none',
    fingerprint: '',
    totalFeatures: 0,
    indexingProgress: null,
    error: null,
  };
  private listeners = new Set<(status: SearchIndexStatus) => void>();
  private loadPromise: Promise<void> | null = null;
  private activeExtractAbort: AbortController | null = null;
  private normalizedPoiCache = new WeakMap<PoiRecord, { nHe: string; nEn: string; nDesc: string }>();

  getStatus(): SearchIndexStatus {
    return { ...this.status };
  }

  subscribeStatus(listener: (status: SearchIndexStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  private emitStatus(): void {
    const snap = this.getStatus();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // ignore listener errors
      }
    }
  }

  loadPayload(
    payload: SearchIndexPayload,
    source: SearchIndexStatus['source'] = 'bundled'
  ): void {
    this.compiled = compilePayload(payload);
    this.status = {
      ready: true,
      source,
      fingerprint: payload.fingerprint || '',
      totalFeatures: this.compiled.rowCount,
      indexingProgress: null,
      error: null,
    };
    this.emitStatus();
  }

  async loadFromBytes(
    bytes: Uint8Array | ArrayBuffer,
    source: SearchIndexStatus['source'] = 'bundled'
  ): Promise<SearchIndexPayload> {
    const payload = await parseSearchIndexBytes(bytes);
    this.loadPayload(payload, source);
    return payload;
  }

  /**
   * Loads offline search index (`Israel.search.idx`) from OPFS / Native storage / Firebase,
   * or IndexedDB cached custom index. Safe to invoke multiple times concurrently.
   */
  async ensureInitialized(forceReload = false): Promise<void> {
    if (this.compiled && !forceReload) return;
    if (this.loadPromise && !forceReload) return this.loadPromise;

    this.loadPromise = (async () => {
      try {
        const rawBuf = await offlineDataFiles.loadBytes('Israel.search.idx');
        if (rawBuf) {
          const bytes = new Uint8Array(rawBuf);
          if (bytes.length >= 4 && (isGzipBytes(bytes) || bytes[0] === 0x7b)) {
            await this.loadFromBytes(bytes, 'bundled');
            return;
          }
        }
      } catch (err: any) {
        this.status.error = err?.message || String(err);
        this.emitStatus();
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  async reloadFromOfflineData(): Promise<void> {
    return this.ensureInitialized(true);
  }

  /**
   * Ensures search index matches the currently mounted OSM PMTiles archive.
   * When a user mounts a custom or updated local PMTiles file, restores from IndexedDB cache
   * if previously indexed, or extracts directly in the browser without blocking the UI.
   */
  async syncWithOsmArchive(
    osmInfo: MountedArchiveInfo | null,
    options?: { allowRemoteExtract?: boolean }
  ): Promise<void> {
    await this.ensureInitialized();
    if (!osmInfo) return;

    try {
      const header = await osmInfo.pmtiles.getHeader();
      const targetFp = getPmtilesArchiveFingerprint(header);
      if (!targetFp) return;

      if (this.compiled && this.compiled.payload.fingerprint === targetFp) {
        return;
      }

      // Check IndexedDB cache first
      try {
        const cached = await db.searchIndexCache.get(targetFp);
        if (cached?.payloadBytes) {
          await this.loadFromBytes(cached.payloadBytes, 'idb-cache');
          return;
        }
      } catch {
        // IndexedDB unavailable in Node/test environment
      }

      const isLocalArchive =
        osmInfo.record.storageKind === 'opfs' ||
        osmInfo.record.storageKind === 'user-file' ||
        osmInfo.record.storageKind === 'native-file' ||
        osmInfo.record.storageKind === 'local-server';

      if (!isLocalArchive && !options?.allowRemoteExtract) {
        // Keep bundled index active until user swaps to local PMTiles or requests remote rebuild
        return;
      }

      await this.rebuildFromPmtiles(osmInfo.pmtiles);
    } catch (err: any) {
      console.warn('[PMTilesSearchService] Archive sync warning:', err);
    }
  }

  async rebuildFromPmtiles(pmtiles: MountedArchiveInfo['pmtiles']): Promise<SearchIndexPayload> {
    this.activeExtractAbort?.abort();
    const abortCtrl = new AbortController();
    this.activeExtractAbort = abortCtrl;

    this.status = {
      ...this.status,
      indexingProgress: { done: 0, total: 100 },
      error: null,
    };
    this.emitStatus();

    try {
      const payload = await extractSearchIndexFromPmtiles(pmtiles, {
        yieldEvery: 48,
        signal: abortCtrl.signal,
        onProgress: (done, total) => {
          this.status.indexingProgress = { done, total };
          this.emitStatus();
        },
      });

      this.loadPayload(payload, 'pmtiles-extract');

      try {
        const compressed = await serializeSearchIndexPayload(payload, { gzip: true });
        await db.searchIndexCache.put({
          fingerprint: payload.fingerprint,
          createdUtc: payload.createdUtc,
          payloadBytes: compressed,
          totalFeatures: payload.totalFeatures,
        });
      } catch {
        // Ignore IndexedDB cache errors cleanly
      }

      return payload;
    } catch (err: any) {
      this.status.indexingProgress = null;
      if (err?.name !== 'AbortError') {
        this.status.error = err?.message || String(err);
      }
      this.emitStatus();
      throw err;
    } finally {
      if (this.activeExtractAbort === abortCtrl) {
        this.activeExtractAbort = null;
      }
    }
  }

  search(rawQuery: string, options: SearchQueryOptions = {}): SearchResultItem[] {
    const filter: SearchFilterCategory = options.filter || 'all';
    const limit = options.limit ?? 30;
    const referenceCoord = options.referenceCoord ?? null;
    const curatedPois = options.pois ?? [];
    const routes = options.routes ?? [];

    const trimmed = rawQuery.trim();
    const normQuery = normalizeSearchText(trimmed);

    // Special case: empty query on 'routes' tab lists all saved/planned routes
    if (!normQuery) {
      if (filter === 'routes') {
        return this.searchRoutes('', routes, referenceCoord).slice(0, limit);
      }
      return [];
    }

    const candidates: SearchResultItem[] = [];

    // 1. Coordinate / Tactical ITM Grid parsing
    if (filter === 'all' || filter === 'pois') {
      const parsedCoord = MilitaryGridService.parseCoordinateQuery(trimmed);
      if (parsedCoord) {
        const mil = MilitaryGridService.toMilitaryCoords(parsedCoord.lon, parsedCoord.lat);
        const distKm = referenceCoord
          ? haversineKmFast(referenceCoord.lon, referenceCoord.lat, parsedCoord.lon, parsedCoord.lat)
          : null;
        const coordPoi: PoiRecord = {
          id: `coord:${parsedCoord.lat.toFixed(5)},${parsedCoord.lon.toFixed(5)}`,
          name: parsedCoord.label,
          nameHe: parsedCoord.label,
          nameEn: `${parsedCoord.lat.toFixed(5)}, ${parsedCoord.lon.toFixed(5)}`,
          category: 'user',
          subcategory: 'coordinate',
          lon: parsedCoord.lon,
          lat: parsedCoord.lat,
          ele: null,
          waterStatus: null,
          difficulty4x4: null,
          descHe: `קואורדינטות WGS84: ${parsedCoord.lat.toFixed(5)}, ${parsedCoord.lon.toFixed(5)} | נ.צ. ${mil.idfGrid8Digit} (${mil.utmZone})`,
          descEn: `Coordinates: ${parsedCoord.lat.toFixed(5)}, ${parsedCoord.lon.toFixed(5)} | ITM ${mil.idfGrid8Digit}`,
          source: parsedCoord.kind === 'wgs84' ? 'חיפוש קואורדינטות WGS84' : 'חיפוש נ.צ. ITM',
          wikipedia: null,
        };
        candidates.push({
          id: coordPoi.id,
          kind: 'coord',
          title: parsedCoord.label,
          subtitle: parsedCoord.subtitle,
          locality: '',
          categoryLabel: parsedCoord.kind === 'wgs84' ? 'קואורדינטה' : 'נ.צ. ITM',
          emoji: '🎯',
          filterGroup: 'pois',
          poiCategory: 'user',
          subcategory: 'coordinate',
          ref: mil.idfGrid8Digit,
          lon: parsedCoord.lon,
          lat: parsedCoord.lat,
          ele: null,
          distanceKm: distKm,
          recommendedZoom: 15.2,
          score: 5000,
          sourceLabel: coordPoi.source,
          poiRecord: coordPoi,
          toPoiRecord: () => coordPoi,
        });
      }
    }

    const rawTokens = normQuery.split(' ').filter(Boolean);
    const substantiveTokens = rawTokens.filter((tk) => !STOP_WORDS.has(tk));
    const tokens = substantiveTokens.length > 0 ? substantiveTokens : rawTokens;
    const roadRefQuery = extractRoadRefQuery(normQuery);

    // 2. Saved & Planned Routes
    if ((filter === 'all' || filter === 'routes') && routes.length > 0) {
      candidates.push(...this.searchRoutes(normQuery, routes, referenceCoord));
    }

    // 3. Curated & User Offline POIs (db.pois)
    const deletedSigs = (options?.deletedSignatures || []).map((d) => ({
      id: d.id,
      norm: normalizeSearchText(d.normName),
      lon: d.lon,
      lat: d.lat,
    }));
    const deletedIdSet = new Set(deletedSigs.map((d) => d.id));
    const curatedDedupKeys: Array<{ normName: string; lon: number; lat: number }> = [];
    if (filter !== 'routes' && curatedPois.length > 0) {
      for (const poi of curatedPois) {
        if (deletedIdSet.has(poi.id)) continue;
        if (!matchesPoiFilter(poi, filter)) continue;
        let cachedNorm = this.normalizedPoiCache.get(poi);
        if (!cachedNorm) {
          const rawHe = poi.nameHe || poi.name || '';
          const rawEn = poi.nameEn || '';
          const rawDesc = poi.descHe || poi.descEn || '';
          const nHe = normalizeSearchText(rawHe);
          const nEn = !rawEn ? '' : rawEn === rawHe ? nHe : normalizeSearchText(rawEn);
          const nDesc = rawDesc ? normalizeSearchText(rawDesc) : poi.subcategory || '';
          cachedNorm = { nHe, nEn, nDesc };
          this.normalizedPoiCache.set(poi, cachedNorm);
        }
        const { nHe, nEn, nDesc } = cachedNorm;

        let score = Math.max(
          scoreSingleFieldMatch(nHe, normQuery),
          scoreSingleFieldMatch(nEn, normQuery)
        );
        if (score === 0 && tokens.length > 1) {
          const combined = `${nHe} ${nEn} ${nDesc}`.trim();
          if (tokens.every((tk) => combined.includes(tk))) {
            score = 860 + tokens.length * 40;
          }
        } else if (score === 0 && nDesc.includes(normQuery) && normQuery.length >= 2) {
          score = 520;
        }
        if (score === 0) continue;

        const distKm = referenceCoord
          ? haversineKmFast(referenceCoord.lon, referenceCoord.lat, poi.lon, poi.lat)
          : null;
        const distBoost = distKm !== null ? Math.round(110 * Math.exp(-distKm / 60)) : 0;
        const userBoost = poi.category === 'user' || poi.userNotes ? 260 : 0;
        const tierBoost =
          poi.id.startsWith('il-poi-') || poi.category === 'user'
            ? 760
            : poi.id.startsWith('or-')
              ? 510
              : 580;
        // Curated outdoor highlights & user field reports carry Tier-0 outdoor salience
        const totalScore = score + tierBoost + userBoost + distBoost;

        const subcatEmoji =
          poi.category === 'water'
            ? '💧'
            : poi.category === 'campsite'
              ? '⛺'
              : poi.category === 'offroad'
                ? '🚙'
                : poi.category === 'peak'
                  ? '⛰️'
                  : poi.category === 'user'
                    ? '📌'
                    : '🏛️';

        curatedDedupKeys.push({ normName: nHe, lon: poi.lon, lat: poi.lat });

        candidates.push({
          id: poi.id,
          kind: 'curated-poi',
          title: poi.nameHe || poi.name || poi.nameEn,
          subtitle: poi.descHe || poi.descEn || poi.source,
          locality: '',
          categoryLabel: poi.userNotes ? 'נקודת שטח (עם הערה)' : 'נקודת טיול מומלצת',
          emoji: subcatEmoji,
          filterGroup: matchesPoiFilter(poi, 'nature')
            ? 'nature'
            : poi.category === 'offroad'
              ? 'roads'
              : 'pois',
          poiCategory: poi.category,
          subcategory: poi.subcategory,
          ref: '',
          lon: poi.lon,
          lat: poi.lat,
          ele: poi.ele,
          distanceKm: distKm,
          recommendedZoom: poi.category === 'peak' ? 15.1 : 15.3,
          score: totalScore,
          sourceLabel: poi.source || 'IsraelHiking / OSM',
          poiRecord: poi,
          toPoiRecord: () => poi,
        });
      }
    }

    // 4. Unified PMTiles Vector Index (142k+ features across all layers)
    if (filter !== 'routes' && this.compiled) {
      const pmtilesHits = this.searchCompiledPmtiles(
        this.compiled,
        normQuery,
        tokens,
        roadRefQuery,
        filter,
        referenceCoord,
        Math.max(limit * 4, 120)
      );

      for (const hit of pmtilesHits) {
        const hitNorm = normalizeSearchText(hit.title);
        // Suppress PMTiles duplicate if a curated POI with the same name sits within ~350m
        if (curatedDedupKeys.length > 0) {
          const dup = curatedDedupKeys.some(
            (c) =>
              c.normName === hitNorm &&
              haversineKmFast(c.lon, c.lat, hit.lon, hit.lat) < 0.35
          );
          if (dup) continue;
        }
        if (deletedSigs.length > 0) {
          const deletedDup = deletedSigs.some((d) => {
            const distKm = haversineKmFast(d.lon, d.lat, hit.lon, hit.lat);
            if (distKm < 0.015) return true;
            return Boolean(d.norm && hitNorm && d.norm === hitNorm && distKm < 0.085);
          });
          if (deletedDup) continue;
        }
        candidates.push(hit);
      }
    }

    // Sort globally descending by score, then proximity
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.distanceKm !== null && b.distanceKm !== null && a.distanceKm !== b.distanceKm) {
        return a.distanceKm - b.distanceKm;
      }
      return a.title.length - b.title.length;
    });

    // Diversify repeated segments (e.g. don't return 28 segments of the same highway/river)
    const perNameLocSeen = new Set<string>();
    const perNameCounts = new Map<string, number>();
    const diversified: SearchResultItem[] = [];
    const deferred: SearchResultItem[] = [];

    for (const item of candidates) {
      if (item.kind !== 'pmtiles') {
        diversified.push(item);
        if (diversified.length >= limit) break;
        continue;
      }

      const normTitle = normalizeSearchText(item.title);
      const normLoc = normalizeSearchText(item.locality);
      const nameLocKey = `${item.filterGroup}|${normTitle}|${normLoc}`;
      const nameKey = `${item.filterGroup}|${normTitle}`;

      if (perNameLocSeen.has(nameLocKey)) {
        continue;
      }
      const countForName = perNameCounts.get(nameKey) ?? 0;
      const capForName = item.filterGroup === 'roads' || item.filterGroup === 'nature' ? 4 : 6;
      if (countForName >= capForName) {
        deferred.push(item);
        continue;
      }

      perNameLocSeen.add(nameLocKey);
      perNameCounts.set(nameKey, countForName + 1);
      diversified.push(item);
      if (diversified.length >= limit) break;
    }

    if (diversified.length < limit && deferred.length > 0) {
      for (const item of deferred) {
        diversified.push(item);
        if (diversified.length >= limit) break;
      }
    }

    return diversified.slice(0, limit);
  }

  private searchRoutes(
    normQuery: string,
    routes: SavedRouteRecord[],
    referenceCoord: { lon: number; lat: number } | null
  ): SearchResultItem[] {
    const out: SearchResultItem[] = [];
    for (const r of routes) {
      const centroid = computeRouteCentroid(r);
      if (!centroid) continue;
      const nName = normalizeSearchText(r.name);
      const formatLabel =
        r.sourceFormat === 'planned'
          ? 'מסלול מתוכנן'
          : r.sourceFormat === 'drawn'
            ? 'מסלול מוקלט'
            : `מסלול ${r.sourceFormat.toUpperCase()}`;

      let score = 600;
      if (normQuery) {
        const direct = scoreSingleFieldMatch(nName, normQuery);
        const fmtMatch = normalizeSearchText(formatLabel).includes(normQuery) ? 450 : 0;
        const tokMatch =
          direct === 0 &&
          normQuery.split(' ').every((tk) => nName.includes(tk) || normalizeSearchText(formatLabel).includes(tk))
            ? 750
            : 0;
        score = Math.max(direct, tokMatch, fmtMatch);
        if (score === 0) continue;
        score += 360;
      }

      const distKm = referenceCoord
        ? haversineKmFast(referenceCoord.lon, referenceCoord.lat, centroid[0], centroid[1])
        : null;

      out.push({
        id: `route:${r.id}`,
        kind: 'route',
        title: r.name,
        subtitle: `${formatLabel} • ${r.distanceKm.toFixed(1)} ק״מ • טיפוס ${r.ascentMeters} מ׳`,
        locality: '',
        categoryLabel: formatLabel,
        emoji: r.sourceFormat === 'planned' ? '🧭' : '🥾',
        filterGroup: 'routes',
        poiCategory: 'offroad',
        subcategory: r.sourceFormat,
        ref: `${r.distanceKm.toFixed(1)}km`,
        lon: centroid[0],
        lat: centroid[1],
        ele: r.maxEle || null,
        distanceKm: distKm,
        recommendedZoom: 13.5,
        score,
        sourceLabel: formatLabel,
        routeRecord: r,
        toPoiRecord: () => ({
          id: `route-poi:${r.id}`,
          name: r.name,
          nameHe: r.name,
          nameEn: r.name,
          category: 'offroad',
          subcategory: r.sourceFormat,
          lon: centroid[0],
          lat: centroid[1],
          ele: r.maxEle || null,
          waterStatus: null,
          difficulty4x4: null,
          descHe: `${formatLabel} • אורך ${r.distanceKm.toFixed(1)} ק״מ • טיפוס מצטבר ${r.ascentMeters} מ׳`,
          descEn: `Saved route (${r.distanceKm.toFixed(1)} km)`,
          source: formatLabel,
          wikipedia: null,
        }),
      });
    }
    return out;
  }

  private searchCompiledPmtiles(
    compiled: CompiledIndex,
    normQuery: string,
    tokens: string[],
    roadRefQuery: string | null,
    filter: SearchFilterCategory,
    referenceCoord: { lon: number; lat: number } | null,
    topPoolSize: number
  ): SearchResultItem[] {
    const isSingleChar = normQuery.length === 1;
    const isSingleToken = tokens.length === 1;

    // Track top K by score without allocating objects for non-top rows
    const scoredHits: Array<{ idx: number; score: number; distKm: number | null }> = [];
    let minPoolScore = -Infinity;

    const {
      rowCount,
      layerIdxArr,
      clsIdxArr,
      subIdxArr,
      locIdxArr,
      latArr,
      lonArr,
      eleArr,
      rankArr,
      tierArr,
      normNames,
      normAlts,
      normRefs,
      dictLayers,
      dictNormLocs,
    } = compiled;

    for (let i = 0; i < rowCount; i++) {
      const tier = tierArr[i];
      // For single-character queries, limit to primary geography (places, peaks, parks, rivers)
      if (isSingleChar && tier > 1 && !(roadRefQuery && normRefs[i] === roadRefQuery)) {
        continue;
      }

      const taxEntry = getTaxonomyCached(compiled, layerIdxArr[i], clsIdxArr[i], subIdxArr[i]);
      if (filter !== 'all' && taxEntry.info.filterGroup !== filter) {
        continue;
      }

      const nName = normNames[i];
      const nAlt = normAlts[i];
      const nRef = normRefs[i];
      const nLoc = dictNormLocs[locIdxArr[i]] || '';
      const layer = dictLayers[layerIdxArr[i]];

      let matchScore = 0;

      // Exact route number or well-known ICAO/IATA airport match ("כביש 6" -> ref="6", "נתבג" -> LLBG)
      const exactRefHit = Boolean(
        (roadRefQuery &&
          (layer === 'road' || layer === 'aerodrome_label') &&
          nRef &&
          hasWholeWord(nRef, roadRefQuery)) ||
          (normQuery === 'נתבג' && layer === 'aerodrome_label' && nRef && hasWholeWord(nRef, 'llbg'))
      );
      if (exactRefHit) {
        matchScore = 2250;
      }

      if (isSingleToken) {
        // Fast single-token/phrase path: skip row immediately if neither name, alt, ref, nor synonyms match
        const sName = nName.includes(normQuery) ? scoreSingleFieldMatch(nName, normQuery) : 0;
        const sAlt = nAlt && nAlt.includes(normQuery) ? scoreSingleFieldMatch(nAlt, normQuery) - 40 : 0;
        const sRef =
          nRef && nRef.includes(normQuery)
            ? hasWholeWord(nRef, normQuery)
              ? 2000
              : 550
            : 0;
        const bestDirect = Math.max(matchScore, sName, sAlt, sRef);

        if (bestDirect > 0) {
          matchScore = bestDirect;
        } else if (normQuery.length >= 2 && taxEntry.normSynonyms.includes(normQuery)) {
          // Allow category searches like "תצפית", "דלק", "חניון", "קפה", "מעיין"
          matchScore = hasWholeWord(taxEntry.normSynonyms, normQuery) ? 320 : 180;
        } else {
          continue;
        }
      } else {
        // Multi-token path (e.g. "הרצל חיפה", "שמורת עין גדי", "תחנת דלק אילת", "כביש 6")
        const sFull = Math.max(
          nName.includes(normQuery) ? scoreSingleFieldMatch(nName, normQuery) : 0,
          nAlt && nAlt.includes(normQuery) ? scoreSingleFieldMatch(nAlt, normQuery) - 40 : 0
        );

        if (sFull > 0) {
          matchScore = Math.max(matchScore, sFull);
        } else {
          let nameHitCount = 0;
          let locHitScore = 0;
          let synHitCount = 0;
          let tokenQuality = 0;
          let allSatisfied = true;

          for (let t = 0; t < tokens.length; t++) {
            const tk = tokens[t];
            const inName = nName.includes(tk);
            const inAlt = nAlt ? nAlt.includes(tk) : false;
            const inRef = nRef ? hasWholeWord(nRef, tk) : false;
            const locScore = matchLocToken(nLoc, tk);
            const inSyn = tk.length >= 2 && taxEntry.normSynonyms.includes(tk);

            if (inName || inAlt || inRef) {
              nameHitCount++;
              if (inRef) {
                tokenQuality += 380;
              } else if (startsAtWordBoundary(nName, tk)) {
                tokenQuality += 280;
              } else if (inName) {
                tokenQuality += 160;
              } else {
                tokenQuality += 130;
              }
              if (locScore > 0) {
                locHitScore += locScore * 180;
              }
            } else if (locScore > 0) {
              locHitScore += locScore * 240;
            } else if (inSyn) {
              synHitCount++;
              tokenQuality += 110;
            } else {
              allSatisfied = false;
              break;
            }
          }

          if (!allSatisfied) continue;
          if (nameHitCount === 0 && !(synHitCount > 0 && locHitScore > 0)) {
            continue;
          }

          // When roadRefQuery is active (e.g. "כביש 6"), ensure numeric token matched as whole word or ref!
          if (roadRefQuery && layer === 'road') {
            const refExactOrWord =
              (nRef && hasWholeWord(nRef, roadRefQuery)) || hasWholeWord(nName, roadRefQuery);
            if (!refExactOrWord) {
              tokenQuality -= 600;
            } else {
              tokenQuality += 700;
            }
          }

          matchScore = Math.max(
            matchScore,
            680 +
              tokenQuality +
              locHitScore +
              (nameHitCount > 0 && locHitScore > 0 ? 340 : 0) -
              (nName.length > 40 ? 80 : 0)
          );
        }

        // Still apply roadRef bonus/penalty when sFull hit prefix (e.g. "כביש 6" prefix matching "כביש 60")
        if (roadRefQuery && layer === 'road') {
          if (nRef && hasWholeWord(nRef, roadRefQuery)) {
            matchScore += 950;
          } else if (nName.startsWith(`כביש ${roadRefQuery}`) && !hasWholeWord(nName, roadRefQuery)) {
            matchScore -= 550; // Penalize "כביש 60" / "כביש 65" when user typed "כביש 6"
          }
        }
      }

      if (matchScore <= 0) continue;

      // Semantic Tier + OpenMapTiles Rank boost
      const tierBoost = TIER_BOOST[tier] ?? 0;
      const rankBoost = Math.max(0, 30 - Math.min(30, rankArr[i])) * 6;

      // Proximity boost from map center / user GPS
      let distKm: number | null = null;
      let distBoost = 0;
      if (referenceCoord) {
        distKm = haversineKmFast(referenceCoord.lon, referenceCoord.lat, lonArr[i], latArr[i]);
        distBoost = Math.round(145 * Math.exp(-distKm / 45));
      }

      // Mild Hebrew priority over Arabic/Latin when both share equal match quality
      const nameStr = compiled.names[i];
      const hebrewBonus = /[\u0590-\u05FF]/.test(nameStr) ? 45 : 0;

      // Avoid zeroing out if an exact prefix penalized road
      const finalScore = matchScore + tierBoost + rankBoost + distBoost + hebrewBonus;
      if (scoredHits.length >= topPoolSize && finalScore <= minPoolScore) {
        continue;
      }

      scoredHits.push({ idx: i, score: finalScore, distKm });
      if (scoredHits.length >= topPoolSize * 2) {
        scoredHits.sort((a, b) => b.score - a.score);
        scoredHits.length = topPoolSize;
        minPoolScore = scoredHits[scoredHits.length - 1].score;
      }
    }

    scoredHits.sort((a, b) => b.score - a.score);
    if (scoredHits.length > topPoolSize) {
      scoredHits.length = topPoolSize;
    }

    // Materialize SearchResultItem objects ONLY for the top candidate pool
    return scoredHits.map(({ idx, score, distKm }) => {
      const layer = dictLayers[layerIdxArr[idx]] || 'poi';
      const cls = compiled.dictClasses[clsIdxArr[idx]] || '';
      const sub = compiled.dictSubclasses[subIdxArr[idx]] || '';
      const loc = compiled.dictLocs[locIdxArr[idx]] || '';
      const name = compiled.names[idx];
      const altName = compiled.altNames[idx];
      const ref = compiled.refs[idx];
      const lat = latArr[idx];
      const lon = lonArr[idx];
      const ele = eleArr[idx] === ELE_NULL_SENTINEL ? null : eleArr[idx];
      const tax = getTaxonomyCached(compiled, layerIdxArr[idx], clsIdxArr[idx], subIdxArr[idx]).info;

      const subtitleParts: string[] = [tax.heLabel];
      if (loc) subtitleParts.push(loc);
      if (ref && layer === 'road' && !name.includes(ref)) {
        subtitleParts.push(`כביש ${ref}`);
      } else if (ref && layer === 'aerodrome_label') {
        subtitleParts.push(ref);
      } else if (altName && altName !== name) {
        subtitleParts.push(altName);
      }
      if (ele !== null) {
        subtitleParts.push(`${ele} מ׳`);
      }

      const safeIdName = name.slice(0, 24).replace(/\//g, '_');
      const id = `pmtiles:${layer}:${lon.toFixed(5)}:${lat.toFixed(5)}:${safeIdName}`;
      const subtitle = subtitleParts.join(' • ');

      return {
        id,
        kind: 'pmtiles' as const,
        title: name,
        subtitle,
        locality: loc,
        categoryLabel: tax.heLabel,
        emoji: tax.emoji,
        filterGroup: tax.filterGroup,
        poiCategory: tax.poiCategory,
        subcategory: sub || cls || layer,
        ref,
        lon,
        lat,
        ele,
        distanceKm: distKm,
        recommendedZoom: tax.recommendedZoom,
        score,
        sourceLabel: `מפת OSM (${tax.heLabel})`,
        toPoiRecord: () => ({
          id,
          name,
          nameHe: name,
          nameEn: altName || name,
          category: tax.poiCategory,
          subcategory: sub || cls || layer,
          lon,
          lat,
          ele,
          waterStatus: null,
          difficulty4x4: layer === 'road' && cls === 'track' ? 'דרך עפר / שטח מ-OSM' : null,
          descHe: subtitle,
          descEn: altName ? `${altName} (${tax.heLabel})` : tax.heLabel,
          source: `OpenMapTiles (${loc || 'ישראל'})`,
          wikipedia: null,
        }),
      };
    });
  }
}

export const pmtilesSearchService = new PMTilesSearchService();
