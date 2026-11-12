import * as turf from '@turf/turf';
import { db, type PoiRecord, type PoiCategory } from '../db/NavDatabase';
import { MilitaryGridService } from '../navigation/MilitaryGridService';
import { classifyPoiWithText } from './poiClassifier';
import { isValidPoiCategory, normalizeSubcategoryForCategory } from './poiTaxonomy';

export interface ExtractedRouteTrack {
  name?: string;
  segments: Array<Array<[number, number]>>;
  pointElevations?: Array<Array<number | null>>;
}

interface RawTrackVertex {
  lon: number;
  lat: number;
  ele: number | null;
}

const VALID_ELE_MIN = -500;
const VALID_ELE_MAX = 9000;

/**
 * Imports community waypoints and routes exported from:
 *  - Amud Anan (עמוד ענן): .kml, .gpx, .twl
 *  - Off-Road.io: .gpx, .kml
 *  - Israel Hiking Map (Mapeak): .gpx, .geojson
 */
export class CommunityPoiImporter {
  static async importWaypointsAndRoutesFromFile(file: File): Promise<{
    importedPois: PoiRecord[];
    extractedLineCoordinates: Array<Array<[number, number]>>;
    extractedRoutes: ExtractedRouteTrack[];
  }> {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    const text = await this.readFileAsTextSafe(file, ext);

    if (ext === 'geojson' || ext === 'json') {
      return this.parseGeoJson(text, file.name);
    }
    if (ext === 'kml') {
      return this.parseKml(text, file.name);
    }
    if (ext === 'gpx' || /<gpx[\s>]/i.test(text)) {
      return this.parseGpx(text, file.name);
    }
    if (ext === 'twl') {
      return this.parseTwlText(text, file.name);
    }

    // Fallback auto-detect JSON vs KML vs GPX vs plain-text coords
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return this.parseGeoJson(text, file.name);
    }
    if (/<kml[\s>]/i.test(text) || /<Placemark[\s>]/i.test(text)) {
      return this.parseKml(text, file.name);
    }
    return this.parseGpx(text, file.name);
  }

  private static isLikelyBinaryBytes(bytes: Uint8Array): boolean {
    const sampleLen = Math.min(bytes.length, 4096);
    if (sampleLen === 0) return false;
    let suspiciousCount = 0;
    for (let i = 0; i < sampleLen; i++) {
      const b = bytes[i];
      if (b === 0) return true; // NUL byte is binary
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
        suspiciousCount++;
      }
    }
    return suspiciousCount / sampleLen > 0.05;
  }

  private static async readFileAsTextSafe(file: File, ext: string): Promise<string> {
    if (typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (ext === 'twl' && this.isLikelyBinaryBytes(bytes)) {
        throw new Error(
          'קובץ TWL בינארי (Naviguide) אינו נתמך בדפדפן — יש להמיר תחילה לקובץ GPX או KML'
        );
      }
      if (typeof TextDecoder !== 'undefined') {
        const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        if (utf8.includes('\uFFFD')) {
          try {
            return new TextDecoder('windows-1255', { fatal: false }).decode(bytes);
          } catch {
            return utf8;
          }
        }
        return utf8;
      }
    }
    const fallbackText = await file.text();
    if (ext === 'twl' && fallbackText.includes('\u0000')) {
      throw new Error(
        'קובץ TWL בינארי (Naviguide) אינו נתמך בדפדפן — יש להמיר תחילה לקובץ GPX או KML'
      );
    }
    return fallbackText;
  }

  private static createImportId(prefix: string, idx: number): string {
    return `import-${prefix}-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
  }

  private static classifyImportedPoi(params: {
    name: string;
    desc: string;
    ele?: number | null;
    explicitCategory?: unknown;
    explicitSubcategory?: unknown;
    sourceFile?: string;
  }): { category: PoiCategory; subcategory: string } {
    const { name, desc, ele, explicitCategory, explicitSubcategory, sourceFile } = params;
    const rawSub = typeof explicitSubcategory === 'string' ? explicitSubcategory.trim() : '';

    if (isValidPoiCategory(explicitCategory)) {
      const normalized = normalizeSubcategoryForCategory(explicitCategory, rawSub);
      const isGeneric =
        !rawSub ||
        rawSub === 'poi' ||
        rawSub.startsWith('imported_') ||
        rawSub === 'offroad_poi' ||
        rawSub === 'offroad_photo';
      if (!isGeneric) {
        return { category: explicitCategory, subcategory: normalized };
      }
      const cls = classifyPoiWithText({
        nameHe: name,
        descHe: desc,
        ele: ele ?? null,
        existingCategory: explicitCategory,
        existingSubcategory: rawSub,
        source: sourceFile ? `Imported (${sourceFile})` : 'Imported',
      });
      return {
        category: explicitCategory,
        subcategory:
          cls.category === explicitCategory
            ? cls.subcategory
            : normalizeSubcategoryForCategory(explicitCategory, rawSub),
      };
    }

    const cls = classifyPoiWithText({
      nameHe: name,
      descHe: desc,
      ele: ele ?? null,
      existingSubcategory: rawSub || null,
      source: sourceFile ? `Imported (${sourceFile})` : 'Imported',
    });

    // Generic unnamed waypoints ("Waypoint 1", "KML Item 2") with no text cues belong in 'user'
    const topScore = Math.max(...Object.values(cls.scores));
    if (
      topScore <= 0 &&
      /^(?:waypoint|kml item|geojson item|wpt)\s*\d*$/i.test(name.trim())
    ) {
      return { category: 'user', subcategory: 'waypoint' };
    }

    return { category: cls.category, subcategory: cls.subcategory };
  }

  private static stripHtml(raw: string): string {
    return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private static parseValidElevation(rawValue: unknown): number | null {
    if (rawValue === null || rawValue === undefined || rawValue === '') return null;
    const n = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue).trim());
    if (!Number.isFinite(n) || n < VALID_ELE_MIN || n > VALID_ELE_MAX) return null;
    return Math.round(n);
  }

  private static isValidLatLon(lon: number, lat: number): boolean {
    return (
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    );
  }

  private static sanitizeXmlText(xmlText: string): string {
    // Strip UTF-8 BOM, illegal XML 1.0 control chars, and any noise before the first '<'
    let cleaned = xmlText
      .replace(/^\uFEFF/, '')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    const firstTagIdx = cleaned.indexOf('<');
    if (firstTagIdx > 0) {
      cleaned = cleaned.slice(firstTagIdx);
    }

    // Escape bare '&' outside CDATA blocks without breaking CDATA HTML descriptions
    const cdataBlocks: string[] = [];
    cleaned = cleaned.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (match) => {
      const token = `__NAVAPP_CDATA_${cdataBlocks.length}__`;
      cdataBlocks.push(match);
      return token;
    });
    cleaned = cleaned.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;');
    cleaned = cleaned.replace(/__NAVAPP_CDATA_(\d+)__/g, (_, idx) => cdataBlocks[Number(idx)] ?? '');

    // Inject common missing namespace prefixes (gx:, gpxx:, xsi:) on root element if used
    cleaned = cleaned.replace(/<(kml|gpx)\b([^>]*)>/i, (full, tag, attrs) => {
      let nextAttrs = attrs || '';
      if (/\bgx:/i.test(cleaned) && !/\bxmlns:gx=/i.test(nextAttrs)) {
        nextAttrs += ' xmlns:gx="http://www.google.com/kml/ext/2.2"';
      }
      if (/\bgpxx:/i.test(cleaned) && !/\bxmlns:gpxx=/i.test(nextAttrs)) {
        nextAttrs += ' xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"';
      }
      if (/\bxsi:/i.test(cleaned) && !/\bxmlns:xsi=/i.test(nextAttrs)) {
        nextAttrs += ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"';
      }
      return `<${tag}${nextAttrs}>`;
    });

    return cleaned;
  }

  private static parseXmlSafe(xmlText: string): {
    doc: Document;
    cleaned: string;
    hasParserError: boolean;
  } {
    const cleaned = this.sanitizeXmlText(xmlText);
    if (typeof DOMParser === 'undefined') {
      const emptyDoc = { getElementsByTagName: () => [] } as unknown as Document;
      return { doc: emptyDoc, cleaned, hasParserError: true };
    }
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleaned, 'text/xml');
    const hasParserError = doc.getElementsByTagName('parsererror').length > 0;
    return { doc, cleaned, hasParserError };
  }

  private static queryByLocalName(root: Document | Element, localNameLower: string): Element[] {
    const target = localNameLower.toLowerCase();
    const all = Array.from(root.getElementsByTagName('*'));
    return all.filter((el) => {
      const ln = (el.localName || el.tagName || '').toLowerCase();
      return ln === target || ln.endsWith(`:${target}`);
    });
  }

  private static decodeXmlEntities(raw: string): string {
    return raw
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  private static cleanTrackCoordinatesWithElevations(raw: RawTrackVertex[]): {
    coords: Array<[number, number]>;
    elevations: Array<number | null>;
  } {
    const coords: Array<[number, number]> = [];
    const elevations: Array<number | null> = [];

    for (const pt of raw) {
      if (!this.isValidLatLon(pt.lon, pt.lat)) continue;
      const prev = coords[coords.length - 1];
      if (!prev || Math.abs(prev[0] - pt.lon) > 1e-6 || Math.abs(prev[1] - pt.lat) > 1e-6) {
        coords.push([pt.lon, pt.lat]);
        elevations.push(pt.ele);
      } else if (elevations[elevations.length - 1] === null && pt.ele !== null) {
        elevations[elevations.length - 1] = pt.ele;
      }
    }
    if (coords.length < 2) {
      return { coords: [], elevations: [] };
    }
    const distKm = turf.length(turf.lineString(coords), { units: 'kilometers' });
    if (distKm < 0.005) {
      return { coords: [], elevations: [] };
    }
    return { coords, elevations };
  }

  private static getDirectChildName(el: Element): string | undefined {
    for (const child of Array.from(el.children)) {
      if (child.localName?.toLowerCase() === 'name') {
        const text = child.textContent?.trim();
        if (text) return text;
      }
    }
    return undefined;
  }

  private static extractAttrValue(attrStr: string, attrName: string): number {
    const re = new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
    const m = re.exec(attrStr);
    return m ? parseFloat(m[1]) : NaN;
  }

  private static parseMalformedGpxRegexFallback(
    xmlText: string,
    sourceFile: string,
    importedPois: PoiRecord[],
    extractedLineCoordinates: Array<Array<[number, number]>>,
    extractedRoutes: ExtractedRouteTrack[]
  ): void {
    const wptRegex = /<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/gi;
    let wm: RegExpExecArray | null;
    let wIdx = 0;
    while ((wm = wptRegex.exec(xmlText)) !== null) {
      const attrs = wm[1] || '';
      const body = wm[2] || '';
      const lat = this.extractAttrValue(attrs, 'lat');
      const lon = this.extractAttrValue(attrs, 'lon');
      if (!this.isValidLatLon(lon, lat)) continue;

      const nameMatch = /<name>([\s\S]*?)<\/name>/i.exec(body);
      const descMatch = /<(?:desc|cmt)>([\s\S]*?)<\/(?:desc|cmt)>/i.exec(body);
      const eleMatch = /<ele>([\s\S]*?)<\/ele>/i.exec(body);
      const name =
        (nameMatch ? this.decodeXmlEntities(nameMatch[1]).trim() : '') || `Waypoint ${wIdx + 1}`;
      const desc = descMatch ? this.stripHtml(this.decodeXmlEntities(descMatch[1])) : '';
      const ele = eleMatch ? this.parseValidElevation(eleMatch[1]) : null;
      const { category, subcategory } = this.classifyImportedPoi({
        name,
        desc,
        ele,
        sourceFile,
      });

      importedPois.push({
        id: this.createImportId('gpx', wIdx++),
        name,
        nameHe: name,
        nameEn: name,
        category,
        subcategory,
        lon,
        lat,
        ele,
        waterStatus: null,
        difficulty4x4: null,
        descHe: desc || `יובא מקובץ ${sourceFile}`,
        descEn: desc || `Imported from ${sourceFile}`,
        source: `Imported (${sourceFile})`,
        wikipedia: null,
      });
    }

    const extractPtTag = (chunk: string, tagName: string): RawTrackVertex[] => {
      const out: RawTrackVertex[] = [];
      const ptRe = new RegExp(`<${tagName}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tagName}>)`, 'gi');
      let pm: RegExpExecArray | null;
      while ((pm = ptRe.exec(chunk)) !== null) {
        const lat = this.extractAttrValue(pm[1] || '', 'lat');
        const lon = this.extractAttrValue(pm[1] || '', 'lon');
        if (!this.isValidLatLon(lon, lat)) continue;
        const eleMatch = pm[2] ? /<ele>([\s\S]*?)<\/ele>/i.exec(pm[2]) : null;
        out.push({
          lon,
          lat,
          ele: eleMatch ? this.parseValidElevation(eleMatch[1]) : null,
        });
      }
      return out;
    };

    const trkBlocks = xmlText.match(/<trk\b[\s\S]*?(?:<\/trk>|$)/gi) || [];
    for (const tb of trkBlocks) {
      const trkNameMatch = /<name>([\s\S]*?)<\/name>/i.exec(tb);
      const trkName = trkNameMatch ? this.decodeXmlEntities(trkNameMatch[1]).trim() : undefined;
      const segMatches = tb.match(/<trkseg\b[\s\S]*?(?:<\/trkseg>|$)/gi) || [tb];
      const segments: Array<Array<[number, number]>> = [];
      const pointElevations: Array<Array<number | null>> = [];

      for (const sb of segMatches) {
        const raw = extractPtTag(sb, 'trkpt');
        const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
        if (coords.length >= 2) {
          segments.push(coords);
          pointElevations.push(elevations);
          extractedLineCoordinates.push(coords);
        }
      }
      if (segments.length > 0) {
        extractedRoutes.push({ name: trkName, segments, pointElevations });
      }
    }

    if (trkBlocks.length === 0) {
      const raw = extractPtTag(xmlText, 'trkpt');
      const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
      if (coords.length >= 2) {
        extractedLineCoordinates.push(coords);
        extractedRoutes.push({ segments: [coords], pointElevations: [elevations] });
      }
    }
  }

  private static async parseGpx(xmlText: string, sourceFile: string) {
    const { doc, cleaned, hasParserError } = this.parseXmlSafe(xmlText);
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];

    // 1. Parse <wpt> waypoints
    const wpts = this.queryByLocalName(doc, 'wpt');
    for (let i = 0; i < wpts.length; i++) {
      const wpt = wpts[i];
      const lat = parseFloat(wpt.getAttribute('lat') || '');
      const lon = parseFloat(wpt.getAttribute('lon') || '');
      if (!this.isValidLatLon(lon, lat)) continue;

      const name =
        this.queryByLocalName(wpt, 'name')[0]?.textContent?.trim() || `Waypoint ${i + 1}`;
      const desc = this.stripHtml(
        this.queryByLocalName(wpt, 'desc')[0]?.textContent ||
          this.queryByLocalName(wpt, 'cmt')[0]?.textContent ||
          ''
      );
      const eleText = this.queryByLocalName(wpt, 'ele')[0]?.textContent;
      const ele = this.parseValidElevation(eleText);
      const { category, subcategory } = this.classifyImportedPoi({
        name,
        desc,
        ele,
        sourceFile,
      });

      const record: PoiRecord = {
        id: this.createImportId('gpx', i),
        name,
        nameHe: name,
        nameEn: name,
        category,
        subcategory,
        lon,
        lat,
        ele,
        waterStatus: null,
        difficulty4x4: null,
        descHe: desc || `יובא מקובץ ${sourceFile}`,
        descEn: desc || `Imported from ${sourceFile}`,
        source: `Imported (${sourceFile})`,
        wikipedia: null,
      };
      importedPois.push(record);
    }

    // 2. Parse <trk> tracks (combining <trkseg> segments within each <trk> while preserving track name & elevations)
    const trks = this.queryByLocalName(doc, 'trk');
    for (const trk of trks) {
      const trkName = this.getDirectChildName(trk);
      const segEls = this.queryByLocalName(trk, 'trkseg');
      const segments: Array<Array<[number, number]>> = [];
      const pointElevations: Array<Array<number | null>> = [];

      const containers = segEls.length > 0 ? segEls : [trk];
      for (const seg of containers) {
        const pts = this.queryByLocalName(seg, 'trkpt');
        const raw: RawTrackVertex[] = [];
        for (const pt of pts) {
          const lat = parseFloat(pt.getAttribute('lat') || '');
          const lon = parseFloat(pt.getAttribute('lon') || '');
          if (!this.isValidLatLon(lon, lat)) continue;
          const eleText = this.queryByLocalName(pt, 'ele')[0]?.textContent;
          raw.push({
            lon,
            lat,
            ele: this.parseValidElevation(eleText),
          });
        }
        const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
        if (coords.length >= 2) {
          segments.push(coords);
          pointElevations.push(elevations);
          extractedLineCoordinates.push(coords);
        }
      }

      if (segments.length > 0) {
        extractedRoutes.push({ name: trkName, segments, pointElevations });
      }
    }

    // 3. Parse <rte> planned routes
    const rtes = this.queryByLocalName(doc, 'rte');
    for (const rte of rtes) {
      const rteName = this.getDirectChildName(rte);
      const pts = this.queryByLocalName(rte, 'rtept');
      const raw: RawTrackVertex[] = [];
      for (const pt of pts) {
        const lat = parseFloat(pt.getAttribute('lat') || '');
        const lon = parseFloat(pt.getAttribute('lon') || '');
        if (!this.isValidLatLon(lon, lat)) continue;
        const eleText = this.queryByLocalName(pt, 'ele')[0]?.textContent;
        raw.push({
          lon,
          lat,
          ele: this.parseValidElevation(eleText),
        });
      }
      const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
      if (coords.length >= 2) {
        extractedLineCoordinates.push(coords);
        extractedRoutes.push({
          name: rteName,
          segments: [coords],
          pointElevations: [elevations],
        });
      }
    }

    if (hasParserError && importedPois.length === 0 && extractedRoutes.length === 0) {
      this.parseMalformedGpxRegexFallback(
        cleaned,
        sourceFile,
        importedPois,
        extractedLineCoordinates,
        extractedRoutes
      );
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }

  private static parseKmlCoordinateTuples(coordText: string): RawTrackVertex[] {
    const raw: RawTrackVertex[] = [];
    for (const tuple of coordText.split(/\s+/)) {
      if (!tuple) continue;
      const parts = tuple.split(',').map((s) => parseFloat(s.trim()));
      if (parts.length >= 2 && this.isValidLatLon(parts[0], parts[1])) {
        raw.push({
          lon: parts[0],
          lat: parts[1],
          ele: parts.length >= 3 ? this.parseValidElevation(parts[2]) : null,
        });
      }
    }
    return raw;
  }

  private static async parseKml(xmlText: string, sourceFile: string) {
    const { doc, cleaned, hasParserError } = this.parseXmlSafe(xmlText);
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];

    const placemarks = this.queryByLocalName(doc, 'placemark');
    let poiSeq = 0;

    for (let i = 0; i < placemarks.length; i++) {
      const pm = placemarks[i];
      const name =
        this.queryByLocalName(pm, 'name')[0]?.textContent?.trim() || `KML Item ${i + 1}`;
      const desc = this.stripHtml(
        this.queryByLocalName(pm, 'description')[0]?.textContent || ''
      );

      // Extract ALL <Point> elements in this Placemark (supports MultiGeometry)
      const pointEls = this.queryByLocalName(pm, 'point');
      for (const pointEl of pointEls) {
        const pointCoord = this.queryByLocalName(pointEl, 'coordinates')[0]?.textContent?.trim();
        if (!pointCoord) continue;
        const parts = pointCoord.split(',').map((s) => parseFloat(s.trim()));
        if (parts.length >= 2 && this.isValidLatLon(parts[0], parts[1])) {
          const [lon, lat, eleRaw] = parts;
          const ele = this.parseValidElevation(eleRaw);
          const { category, subcategory } = this.classifyImportedPoi({
            name,
            desc,
            ele,
            sourceFile,
          });
          importedPois.push({
            id: this.createImportId('kml', poiSeq++),
            name,
            nameHe: name,
            nameEn: name,
            category,
            subcategory,
            lon,
            lat,
            ele,
            waterStatus: null,
            difficulty4x4: null,
            descHe: desc || `יובא מקובץ KML (${sourceFile})`,
            descEn: desc || `Imported from KML (${sourceFile})`,
            source: `KML Import (${sourceFile})`,
            wikipedia: null,
          });
        }
      }

      const pmSegments: Array<Array<[number, number]>> = [];
      const pmElevations: Array<Array<number | null>> = [];

      // LineString geometries
      const lineStrings = this.queryByLocalName(pm, 'linestring');
      for (const ls of lineStrings) {
        const lineCoordText =
          this.queryByLocalName(ls, 'coordinates')[0]?.textContent?.trim() || '';
        if (!lineCoordText) continue;
        const raw = this.parseKmlCoordinateTuples(lineCoordText);
        const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
        if (coords.length >= 2) {
          pmSegments.push(coords);
          pmElevations.push(elevations);
          extractedLineCoordinates.push(coords);
        }
      }

      // gx:Track geometries (<gx:coord>lon lat [ele]</gx:coord>)
      const gxTracks = this.queryByLocalName(pm, 'track');
      for (const gxTrk of gxTracks) {
        const coordEls = this.queryByLocalName(gxTrk, 'coord');
        const raw: RawTrackVertex[] = [];
        for (const ce of coordEls) {
          const parts = (ce.textContent || '')
            .trim()
            .split(/[\s,]+/)
            .map((s) => parseFloat(s));
          if (parts.length >= 2 && this.isValidLatLon(parts[0], parts[1])) {
            raw.push({
              lon: parts[0],
              lat: parts[1],
              ele: parts.length >= 3 ? this.parseValidElevation(parts[2]) : null,
            });
          }
        }
        const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
        if (coords.length >= 2) {
          pmSegments.push(coords);
          pmElevations.push(elevations);
          extractedLineCoordinates.push(coords);
        }
      }

      if (pmSegments.length > 0) {
        extractedRoutes.push({
          name: name.startsWith('KML Item ') ? undefined : name,
          segments: pmSegments,
          pointElevations: pmElevations,
        });
      }
    }

    // Recovery if KML had broken XML structure or ran without DOMParser
    if (hasParserError && importedPois.length === 0 && extractedRoutes.length === 0) {
      const pmBlocks = cleaned.match(/<Placemark\b[\s\S]*?(?:<\/Placemark>|$)/gi) || [];
      for (const pmBlock of pmBlocks) {
        if (!/<Point\b/i.test(pmBlock)) continue;
        const nameM = /<name>([\s\S]*?)<\/name>/i.exec(pmBlock);
        const descM = /<description>([\s\S]*?)<\/description>/i.exec(pmBlock);
        const ptM = /<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i.exec(pmBlock);
        if (!ptM) continue;
        const parts = ptM[1].trim().split(',').map((s) => parseFloat(s.trim()));
        if (parts.length >= 2 && this.isValidLatLon(parts[0], parts[1])) {
          const [lon, lat, eleRaw] = parts;
          const ele = this.parseValidElevation(eleRaw);
          const name =
            (nameM ? this.decodeXmlEntities(nameM[1]).trim() : '') || `KML Item ${poiSeq + 1}`;
          const desc = descM ? this.stripHtml(this.decodeXmlEntities(descM[1])) : '';
          const { category, subcategory } = this.classifyImportedPoi({
            name,
            desc,
            ele,
            sourceFile,
          });
          importedPois.push({
            id: this.createImportId('kml', poiSeq++),
            name,
            nameHe: name,
            nameEn: name,
            category,
            subcategory,
            lon,
            lat,
            ele,
            waterStatus: null,
            difficulty4x4: null,
            descHe: desc || `יובא מקובץ KML (${sourceFile})`,
            descEn: desc || `Imported from KML (${sourceFile})`,
            source: `KML Import (${sourceFile})`,
            wikipedia: null,
          });
        }
      }
      const lsMatches = cleaned.match(/<LineString[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/gi) || [];
      for (const m of lsMatches) {
        const inner = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(m)?.[1] || '';
        const raw = this.parseKmlCoordinateTuples(inner);
        const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
        if (coords.length >= 2) {
          extractedLineCoordinates.push(coords);
          extractedRoutes.push({ segments: [coords], pointElevations: [elevations] });
        }
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }

  private static async parseGeoJson(jsonText: string, sourceFile: string) {
    const data = JSON.parse(jsonText);
    const features: any[] =
      data?.type === 'FeatureCollection' && Array.isArray(data.features)
        ? data.features
        : data?.type === 'Feature'
          ? [data]
          : data?.type && data?.coordinates
            ? [{ type: 'Feature', properties: {}, geometry: data }]
            : data?.type === 'GeometryCollection' && Array.isArray(data.geometries)
              ? data.geometries.map((g: any) => ({ type: 'Feature', properties: {}, geometry: g }))
              : [];

    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (!f || !f.geometry) continue;
      const props = f.properties || {};
      const name = props.nameHe || props.name || props.title || `GeoJSON Item ${i + 1}`;
      const desc = props.descHe || props.description || props.note || '';

      if (f.geometry.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
        const [lonRaw, latRaw, eleRaw] = f.geometry.coordinates;
        const lon = Number(lonRaw);
        const lat = Number(latRaw);
        if (!this.isValidLatLon(lon, lat)) continue;
        const ele = this.parseValidElevation(eleRaw) ?? this.parseValidElevation(props.ele);
        const { category, subcategory } = this.classifyImportedPoi({
          name,
          desc,
          ele,
          explicitCategory: props.category,
          explicitSubcategory: props.subcategory,
          sourceFile,
        });
        importedPois.push({
          id: String(props.id || this.createImportId('geojson', i)),
          name,
          nameHe: name,
          nameEn: props.nameEn || name,
          category,
          subcategory,
          lon,
          lat,
          ele,
          waterStatus: props.waterStatus || null,
          difficulty4x4: props.difficulty4x4 || null,
          descHe: desc || `יובא מקובץ ${sourceFile}`,
          descEn: props.descEn || desc || `Imported from ${sourceFile}`,
          source: `GeoJSON (${sourceFile})`,
          wikipedia: props.wikipedia || null,
        });
      } else if (f.geometry.type === 'LineString' && Array.isArray(f.geometry.coordinates)) {
        const raw: RawTrackVertex[] = f.geometry.coordinates.map((c: number[]) => ({
          lon: Number(c[0]),
          lat: Number(c[1]),
          ele: c.length >= 3 ? this.parseValidElevation(c[2]) : null,
        }));
        const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
        if (coords.length >= 2) {
          extractedLineCoordinates.push(coords);
          extractedRoutes.push({
            name: props.nameHe || props.name || props.title || undefined,
            segments: [coords],
            pointElevations: [elevations],
          });
        }
      } else if (f.geometry.type === 'MultiLineString' && Array.isArray(f.geometry.coordinates)) {
        const segments: Array<Array<[number, number]>> = [];
        const pointElevations: Array<Array<number | null>> = [];
        for (const seg of f.geometry.coordinates) {
          if (!Array.isArray(seg)) continue;
          const raw: RawTrackVertex[] = seg.map((c: number[]) => ({
            lon: Number(c[0]),
            lat: Number(c[1]),
            ele: c.length >= 3 ? this.parseValidElevation(c[2]) : null,
          }));
          const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
          if (coords.length >= 2) {
            segments.push(coords);
            pointElevations.push(elevations);
            extractedLineCoordinates.push(coords);
          }
        }
        if (segments.length > 0) {
          extractedRoutes.push({
            name: props.nameHe || props.name || props.title || undefined,
            segments,
            pointElevations,
          });
        }
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }

  private static async parseTwlText(text: string, sourceFile: string) {
    if (text.includes('\u0000')) {
      throw new Error(
        'קובץ TWL בינארי (Naviguide) אינו נתמך בדפדפן — יש להמיר תחילה לקובץ GPX או KML'
      );
    }

    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];
    const lines = text.split(/\r?\n/);
    const raw: RawTrackVertex[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;

      let lon: number | null = null;
      let lat: number | null = null;
      let ele: number | null = null;
      let label = '';

      // 1. Decimal WGS84 coordinates (e.g. "30.835, 34.813, 420, עין עקב" or swapped Israel lon, lat)
      const wgsMatch =
        /(-?\d{1,3}\.\d{3,})[,\s;/]+(-?\d{1,3}\.\d{3,})(?:[,\s;/]+(-?\d+(?:\.\d+)?))?(.*)$/.exec(
          line
        );
      if (wgsMatch) {
        const a = parseFloat(wgsMatch[1]);
        const b = parseFloat(wgsMatch[2]);
        const optEle = wgsMatch[3] ? this.parseValidElevation(wgsMatch[3]) : null;
        const tailText = (wgsMatch[4] || '').replace(/^[,;\t\s|]+/, '').trim();

        // Detect Israel region (lon 33.5..36.8, lat 28.5..33.5) vs general lat,lon
        if (a >= 33.5 && a <= 36.8 && b >= 28.5 && b < 33.5) {
          lon = a;
          lat = b;
        } else if (this.isValidLatLon(b, a)) {
          lat = a;
          lon = b;
        } else if (this.isValidLatLon(a, b)) {
          lon = a;
          lat = b;
        }
        ele = optEle;
        label = tailText;
      } else {
        // 2. Israeli ITM 6-digit Easting / Northing (100000..320000, 340000..860000)
        const itmMatch = /(\d{6})[,\s;/]+(\d{6})(?:[,\s;/]+(-?\d+(?:\.\d+)?))?(.*)$/.exec(line);
        if (itmMatch) {
          const e = parseInt(itmMatch[1], 10);
          const n = parseInt(itmMatch[2], 10);
          if (e >= 100000 && e <= 320000 && n >= 340000 && n <= 860000) {
            const converted = MilitaryGridService.itmToWgs84(e, n);
            lon = converted.lon;
            lat = converted.lat;
            ele = itmMatch[3] ? this.parseValidElevation(itmMatch[3]) : null;
            label = (itmMatch[4] || '').replace(/^[,;\t\s|]+/, '').trim();
          }
        } else {
          // 3. 8-digit IDF Grid (e.g. 1813-5828)
          const parsed = MilitaryGridService.parseCoordinateQuery(line);
          if (parsed) {
            lon = parsed.lon;
            lat = parsed.lat;
          }
        }
      }

      if (lon !== null && lat !== null && this.isValidLatLon(lon, lat)) {
        raw.push({ lon, lat, ele });
        if (label && /[a-zA-Z\u0590-\u05FF]/.test(label)) {
          const { category, subcategory } = this.classifyImportedPoi({
            name: label,
            desc: '',
            ele,
            sourceFile,
          });
          importedPois.push({
            id: this.createImportId('twl', importedPois.length),
            name: label,
            nameHe: label,
            nameEn: label,
            category,
            subcategory,
            lon,
            lat,
            ele,
            waterStatus: null,
            difficulty4x4: null,
            descHe: `יובא מקובץ ${sourceFile}`,
            descEn: `Imported from ${sourceFile}`,
            source: `TWL Import (${sourceFile})`,
            wikipedia: null,
          });
        }
      }
    }

    const { coords, elevations } = this.cleanTrackCoordinatesWithElevations(raw);
    if (coords.length >= 2) {
      extractedLineCoordinates.push(coords);
      extractedRoutes.push({ segments: [coords], pointElevations: [elevations] });
    } else if (raw.length === 1 && importedPois.length === 0) {
      const baseName = sourceFile.replace(/\.[^.]+$/, '');
      const { category, subcategory } = this.classifyImportedPoi({
        name: baseName,
        desc: '',
        ele: raw[0].ele,
        sourceFile,
      });
      importedPois.push({
        id: this.createImportId('twl', 0),
        name: baseName,
        nameHe: baseName,
        nameEn: baseName,
        category,
        subcategory,
        lon: raw[0].lon,
        lat: raw[0].lat,
        ele: raw[0].ele,
        waterStatus: null,
        difficulty4x4: null,
        descHe: `יובא מקובץ ${sourceFile}`,
        descEn: `Imported from ${sourceFile}`,
        source: `TWL Import (${sourceFile})`,
        wikipedia: null,
      });
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }
}
