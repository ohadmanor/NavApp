import { db, type PoiRecord, type PoiCategory } from '../db/NavDatabase';

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

  private static async parseGpx(xmlText: string, sourceFile: string) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];

    // 1. Parse <wpt> waypoints
    const wpts = Array.from(doc.querySelectorAll('wpt'));
    for (let i = 0; i < wpts.length; i++) {
      const wpt = wpts[i];
      const lat = parseFloat(wpt.getAttribute('lat') || '');
      const lon = parseFloat(wpt.getAttribute('lon') || '');
      if (isNaN(lat) || isNaN(lon)) continue;

      const name = wpt.querySelector('name')?.textContent?.trim() || `Waypoint ${i + 1}`;
      const desc = this.stripHtml(
        wpt.querySelector('desc')?.textContent ||
          wpt.querySelector('cmt')?.textContent ||
          ''
      );
      const eleText = wpt.querySelector('ele')?.textContent;
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

    // 2. Parse <trkseg> tracks and <rte> routes
    const trkSegs = Array.from(doc.querySelectorAll('trkseg, rte'));
    for (const seg of trkSegs) {
      const pts = Array.from(seg.querySelectorAll('trkpt, rtept'));
      const coords: Array<[number, number]> = [];
      for (const pt of pts) {
        const lat = parseFloat(pt.getAttribute('lat') || '');
        const lon = parseFloat(pt.getAttribute('lon') || '');
        if (!isNaN(lat) && !isNaN(lon)) {
          coords.push([lon, lat]);
        }
      }
      if (coords.length >= 2) {
        extractedLineCoordinates.push(coords);
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates };
  }

  private static async parseKml(xmlText: string, sourceFile: string) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];

    const placemarks = Array.from(doc.querySelectorAll('Placemark'));
    for (let i = 0; i < placemarks.length; i++) {
      const pm = placemarks[i];
      const name = pm.querySelector('name')?.textContent?.trim() || `KML Point ${i + 1}`;
      const desc = this.stripHtml(pm.querySelector('description')?.textContent || '');

      const pointCoord = pm.querySelector('Point > coordinates')?.textContent?.trim();
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

      const lineCoordText = pm.querySelector('LineString > coordinates')?.textContent?.trim();
      if (lineCoordText) {
        const coords: Array<[number, number]> = [];
        for (const tuple of lineCoordText.split(/\s+/)) {
          const parts = tuple.split(',').map((s) => parseFloat(s.trim()));
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            coords.push([parts[0], parts[1]]);
          }
        }
        if (coords.length >= 2) {
          extractedLineCoordinates.push(coords);
        }
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates };
  }

  private static async parseGeoJson(jsonText: string, sourceFile: string) {
    const data = JSON.parse(jsonText);
    const features = data.type === 'FeatureCollection' ? data.features : [data];
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];

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
        extractedLineCoordinates.push(
          f.geometry.coordinates.map((c: number[]) => [Number(c[0]), Number(c[1])])
        );
      }
    }

    if (importedPois.length > 0) {
      await db.pois.bulkPut(importedPois);
    }
    return { importedPois, extractedLineCoordinates };
  }

  private static async parseTwlText(text: string, sourceFile: string) {
    const importedPois: PoiRecord[] = [];
    const extractedLineCoordinates: Array<Array<[number, number]>> = [];
    const lines = text.split(/\r?\n/);
    const coords: Array<[number, number]> = [];
    for (const line of lines) {
      const match = /([23]\d\.\d+)[,\s]+(3[456]\.\d+)/.exec(line);
      if (match) {
        const lat = parseFloat(match[1]);
        const lon = parseFloat(match[2]);
        coords.push([lon, lat]);
      }
    }
    if (coords.length >= 2) {
      extractedLineCoordinates.push(coords);
    }
    return { importedPois, extractedLineCoordinates, sourceFile };
  }
}

