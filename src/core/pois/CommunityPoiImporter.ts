import * as turf from '@turf/turf';
import { db, type PoiRecord, type PoiCategory } from '../db/NavDatabase';

export interface ExtractedRouteTrack {
  name?: string;
  segments: Array<Array<[number, number]>>;
}

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
    const text = await file.text();
    const ext = file.name.split('.').pop()?.toLowerCase() || '';

    if (ext === 'geojson' || ext === 'json') {
      return this.parseGeoJson(text, file.name);
    }
    if (ext === 'kml') {
      return this.parseKml(text, file.name);
    }
    if (ext === 'gpx' || text.includes('<gpx')) {
      return this.parseGpx(text, file.name);
    }
    if (ext === 'twl') {
      return this.parseTwlText(text, file.name);
    }

    // Fallback auto-detect XML vs JSON
    if (text.trim().startsWith('{')) {
      return this.parseGeoJson(text, file.name);
    }
    if (text.includes('<kml')) {
      return this.parseKml(text, file.name);
    }
    return this.parseGpx(text, file.name);
  }

  private static inferCategory(name: string, desc: string): PoiCategory {
    const combined = `${name} ${desc}`.toLowerCase();
    if (
      combined.includes('עין ') ||
      combined.includes('מעיין') ||
      combined.includes('גב ') ||
      combined.includes('בור ') ||
      combined.includes('באר ') ||
      combined.includes('spring') ||
      combined.includes('water')
    ) {
      return 'water';
    }
    if (
      combined.includes('מעלה ') ||
      combined.includes('4x4') ||
      combined.includes('עבירות') ||
      combined.includes('מדרגה') ||
      combined.includes('חסימה')
    ) {
      return 'offroad';
    }
    if (
      combined.includes('חניון לילה') ||
      combined.includes('קמפינג') ||
      combined.includes('camp')
    ) {
      return 'campsite';
    }
    if (combined.includes('הר ') || combined.includes('פסגת') || combined.includes('peak')) {
      return 'peak';
    }
    return 'heritage';
  }

  private static stripHtml(raw: string): string {
    return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private static parseXmlSafe(xmlText: string): Document {
    // Strip UTF-8 BOM and escape unescaped ampersands common in exported Hebrew trail files
    const cleaned = xmlText
      .replace(/^\uFEFF/, '')
      .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;');
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleaned, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      return parser.parseFromString(cleaned, 'text/html');
    }
    return doc;
  }

  private static cleanTrackCoordinates(rawCoords: Array<[number, number]>): Array<[number, number]> {
    const deduped: Array<[number, number]> = [];
    for (const pt of rawCoords) {
      if (!Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
      const prev = deduped[deduped.length - 1];
      if (!prev || Math.abs(prev[0] - pt[0]) > 1e-6 || Math.abs(prev[1] - pt[1]) > 1e-6) {
        deduped.push(pt);
      }
    }
    if (deduped.length < 2) return [];
    const distKm = turf.length(turf.lineString(deduped), { units: 'kilometers' });
    return distKm >= 0.005 ? deduped : [];
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

  private static async parseGpx(xmlText: string, sourceFile: string) {
    const doc = this.parseXmlSafe(xmlText);
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];

    // 1. Parse <wpt> waypoints
    const wpts = Array.from(doc.getElementsByTagNameNS('*', 'wpt'));
    for (let i = 0; i < wpts.length; i++) {
      const wpt = wpts[i];
      const lat = parseFloat(wpt.getAttribute('lat') || '');
      const lon = parseFloat(wpt.getAttribute('lon') || '');
      if (isNaN(lat) || isNaN(lon)) continue;

      const name =
        wpt.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim() || `Waypoint ${i + 1}`;
      const desc = this.stripHtml(
        wpt.getElementsByTagNameNS('*', 'desc')[0]?.textContent ||
          wpt.getElementsByTagNameNS('*', 'cmt')[0]?.textContent ||
          ''
      );
      const eleText = wpt.getElementsByTagNameNS('*', 'ele')[0]?.textContent;
      const ele = eleText ? Math.round(parseFloat(eleText)) : null;
      const category = this.inferCategory(name, desc);

      const record: PoiRecord = {
        id: `import-gpx-${Date.now()}-${i}`,
        name,
        nameHe: name,
        nameEn: name,
        category,
        subcategory: 'imported_wpt',
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

    // 2. Parse <trk> tracks (combining <trkseg> segments within each <trk> while preserving track name)
    const trks = Array.from(doc.getElementsByTagNameNS('*', 'trk'));
    for (const trk of trks) {
      const trkName = this.getDirectChildName(trk);
      const segEls = Array.from(trk.getElementsByTagNameNS('*', 'trkseg'));
      const segments: Array<Array<[number, number]>> = [];

      const containers = segEls.length > 0 ? segEls : [trk];
      for (const seg of containers) {
        const pts = Array.from(seg.getElementsByTagNameNS('*', 'trkpt'));
        const raw: Array<[number, number]> = [];
        for (const pt of pts) {
          const lat = parseFloat(pt.getAttribute('lat') || '');
          const lon = parseFloat(pt.getAttribute('lon') || '');
          if (!isNaN(lat) && !isNaN(lon)) raw.push([lon, lat]);
        }
        const cleaned = this.cleanTrackCoordinates(raw);
        if (cleaned.length >= 2) {
          segments.push(cleaned);
          extractedLineCoordinates.push(cleaned);
        }
      }

      if (segments.length > 0) {
        extractedRoutes.push({ name: trkName, segments });
      }
    }

    // 3. Parse <rte> planned routes
    const rtes = Array.from(doc.getElementsByTagNameNS('*', 'rte'));
    for (const rte of rtes) {
      const rteName = this.getDirectChildName(rte);
      const pts = Array.from(rte.getElementsByTagNameNS('*', 'rtept'));
      const raw: Array<[number, number]> = [];
      for (const pt of pts) {
        const lat = parseFloat(pt.getAttribute('lat') || '');
        const lon = parseFloat(pt.getAttribute('lon') || '');
        if (!isNaN(lat) && !isNaN(lon)) raw.push([lon, lat]);
      }
      const cleaned = this.cleanTrackCoordinates(raw);
      if (cleaned.length >= 2) {
        extractedLineCoordinates.push(cleaned);
        extractedRoutes.push({ name: rteName, segments: [cleaned] });
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }

  private static async parseKml(xmlText: string, sourceFile: string) {
    const doc = this.parseXmlSafe(xmlText);
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];

    const placemarks = Array.from(doc.getElementsByTagNameNS('*', 'Placemark'));
    for (let i = 0; i < placemarks.length; i++) {
      const pm = placemarks[i];
      const name = pm.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim() || `KML Item ${i + 1}`;
      const desc = this.stripHtml(
        pm.getElementsByTagNameNS('*', 'description')[0]?.textContent || ''
      );

      const pointEls = Array.from(pm.getElementsByTagNameNS('*', 'Point'));
      const pointCoord = pointEls[0]?.getElementsByTagNameNS('*', 'coordinates')[0]?.textContent?.trim();
      if (pointCoord) {
        const parts = pointCoord.split(',').map((s) => parseFloat(s.trim()));
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          const [lon, lat, ele] = parts;
          const category = this.inferCategory(name, desc);
          importedPois.push({
            id: `import-kml-${Date.now()}-${i}`,
            name,
            nameHe: name,
            nameEn: name,
            category,
            subcategory: 'imported_kml',
            lon,
            lat,
            ele: !isNaN(ele) ? Math.round(ele) : null,
            waterStatus: null,
            difficulty4x4: null,
            descHe: desc || `יובא מקובץ KML (${sourceFile})`,
            descEn: desc || `Imported from KML (${sourceFile})`,
            source: `KML Import (${sourceFile})`,
            wikipedia: null,
          });
        }
      }

      const lineStrings = Array.from(pm.getElementsByTagNameNS('*', 'LineString'));
      const pmSegments: Array<Array<[number, number]>> = [];
      for (const ls of lineStrings) {
        const lineCoordText =
          ls.getElementsByTagNameNS('*', 'coordinates')[0]?.textContent?.trim() || '';
        if (!lineCoordText) continue;
        const raw: Array<[number, number]> = [];
        for (const tuple of lineCoordText.split(/\s+/)) {
          const parts = tuple.split(',').map((s) => parseFloat(s.trim()));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            raw.push([parts[0], parts[1]]);
          }
        }
        const cleaned = this.cleanTrackCoordinates(raw);
        if (cleaned.length >= 2) {
          pmSegments.push(cleaned);
          extractedLineCoordinates.push(cleaned);
        }
      }
      if (pmSegments.length > 0) {
        extractedRoutes.push({
          name: name.startsWith('KML Item ') ? undefined : name,
          segments: pmSegments,
        });
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }

  private static async parseGeoJson(jsonText: string, sourceFile: string) {
    const data = JSON.parse(jsonText);
    const features = data.type === 'FeatureCollection' ? data.features : [data];
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];

    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (!f || !f.geometry) continue;
      const props = f.properties || {};
      const name = props.nameHe || props.name || props.title || `GeoJSON Item ${i + 1}`;
      const desc = props.descHe || props.description || props.note || '';

      if (f.geometry.type === 'Point') {
        const [lon, lat, ele] = f.geometry.coordinates;
        importedPois.push({
          id: String(props.id || `import-geojson-${Date.now()}-${i}`),
          name,
          nameHe: name,
          nameEn: props.nameEn || name,
          category: (props.category as PoiCategory) || this.inferCategory(name, desc),
          subcategory: props.subcategory || 'imported_geojson',
          lon: Number(lon),
          lat: Number(lat),
          ele: typeof ele === 'number' ? Math.round(ele) : props.ele ?? null,
          waterStatus: props.waterStatus || null,
          difficulty4x4: props.difficulty4x4 || null,
          descHe: desc || `יובא מקובץ ${sourceFile}`,
          descEn: props.descEn || desc || `Imported from ${sourceFile}`,
          source: `GeoJSON (${sourceFile})`,
          wikipedia: props.wikipedia || null,
        });
      } else if (f.geometry.type === 'LineString' && Array.isArray(f.geometry.coordinates)) {
        const cleaned = this.cleanTrackCoordinates(
          f.geometry.coordinates.map((c: number[]) => [Number(c[0]), Number(c[1])] as [number, number])
        );
        if (cleaned.length >= 2) {
          extractedLineCoordinates.push(cleaned);
          extractedRoutes.push({
            name: props.nameHe || props.name || props.title || undefined,
            segments: [cleaned],
          });
        }
      } else if (f.geometry.type === 'MultiLineString' && Array.isArray(f.geometry.coordinates)) {
        const segments: Array<Array<[number, number]>> = [];
        for (const seg of f.geometry.coordinates) {
          const cleaned = this.cleanTrackCoordinates(
            seg.map((c: number[]) => [Number(c[0]), Number(c[1])] as [number, number])
          );
          if (cleaned.length >= 2) {
            segments.push(cleaned);
            extractedLineCoordinates.push(cleaned);
          }
        }
        if (segments.length > 0) {
          extractedRoutes.push({
            name: props.nameHe || props.name || props.title || undefined,
            segments,
          });
        }
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }

  private static async parseTwlText(text: string, _sourceFile: string) {
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const extractedRoutes: ExtractedRouteTrack[] = [];
    const lines = text.split(/\r?\n/);
    const raw: Array<[number, number]> = [];
    for (const line of lines) {
      const match = /([23]\d\.\d+)[,\s]+(3[456]\.\d+)/.exec(line);
      if (match) {
        const lat = parseFloat(match[1]);
        const lon = parseFloat(match[2]);
        raw.push([lon, lat]);
      }
    }
    const cleaned = this.cleanTrackCoordinates(raw);
    if (cleaned.length >= 2) {
      extractedLineCoordinates.push(cleaned);
      extractedRoutes.push({ segments: [cleaned] });
    }
    return { importedPois, extractedLineCoordinates, extractedRoutes };
  }
}

