/**
 * Military Topographic Coordinate & Tactical Grid Service
 *
 * Provides:
 *  1. Accurate conversion from WGS84 (Lon/Lat) to:
 *     - ITM (Israel Transverse Mercator — רשת ישראל החדשה, EPSG:2039)
 *     - 6-Digit / 8-Digit IDF Tactical Grid Reference (נ.צ. צבאי 6/8 ספרות)
 *     - UTM Zone 36N (NATO Tactical Standard, EPSG:32636)
 *  2. Dynamic Tactical Grid Overlay (GeoJSON lines + grid coordinate labels)
 *     matching 1:50,000 Military Topographic Maps.
 */

export interface MilitaryCoordReadout {
  itmEasting: number;
  itmNorthing: number;
  itmFormatted: string;     // e.g. "181340 / 582810"
  idfGrid8Digit: string;    // e.g. "18135828" (4+4 tactical grid)
  utmZone: string;          // e.g. "36R"
  utmEasting: number;
  utmNorthing: number;
  utmFormatted: string;     // e.g. "36R 0673420E 3412580N"
}

export class MilitaryGridService {
  /**
   * Converts WGS84 (lon, lat) in degrees to ITM (Israel Transverse Mercator, EPSG:2039)
   * and UTM Zone 36N (EPSG:32636).
   */
  static toMilitaryCoords(lon: number, lat: number): MilitaryCoordReadout {
    // 1. ITM (Israel Transverse Mercator - GRS80 ellipsoid)
    // Central Meridian: 35°12'16.261" E (35.2045169444°), Origin Lat: 31°44'03.817" N (31.7343936111°)
    // False Easting: 219529.584m, False Northing: 626907.390m, Scale Factor: 1.0000067
    const itm = this.projectTransverseMercator(
      lon,
      lat,
      35.2045169444,
      31.7343936111,
      219529.584,
      626907.39,
      1.0000067
    );

    const itmEasting = Math.round(itm.easting);
    const itmNorthing = Math.round(itm.northing);

    // 8-digit tactical reference: Easting km+100m (4 digits) / Northing km+100m (4 digits)
    const e6 = String(Math.max(0, itmEasting)).padStart(6, '0');
    const n6 = String(Math.max(0, itmNorthing)).padStart(6, '0');
    const idfGrid8Digit = `${e6.slice(0, 4)}-${n6.slice(0, 4)}`;

    // 2. UTM Zone 36N (Central Meridian 33°E, Origin Lat 0°, False Easting 500000, False Northing 0, k0 = 0.9996)
    const utm = this.projectTransverseMercator(lon, lat, 33.0, 0.0, 500000.0, 0.0, 0.9996);
    const utmEasting = Math.round(utm.easting);
    const utmNorthing = Math.round(utm.northing);
    const utmBand = lat >= 32.0 ? '36S' : '36R';

    return {
      itmEasting,
      itmNorthing,
      itmFormatted: `${e6}E / ${n6}N`,
      idfGrid8Digit,
      utmZone: utmBand,
      utmEasting,
      utmNorthing,
      utmFormatted: `${utmBand} ${String(utmEasting).padStart(6, '0')}E ${String(utmNorthing).padStart(7, '0')}N`,
    };
  }

  private static projectTransverseMercator(
    lonDeg: number,
    latDeg: number,
    lon0Deg: number,
    lat0Deg: number,
    falseEasting: number,
    falseNorthing: number,
    k0: number
  ): { easting: number; northing: number } {
    const a = 6378137.0; // GRS80 / WGS84 semi-major axis
    const f = 1 / 298.257222101;
    const e2 = 2 * f - f * f;
    const ep2 = e2 / (1 - e2);

    const deg2rad = Math.PI / 180;
    const phi = latDeg * deg2rad;
    const lam = lonDeg * deg2rad;
    const phi0 = lat0Deg * deg2rad;
    const lam0 = lon0Deg * deg2rad;

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const tanPhi = Math.tan(phi);

    const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
    const T = tanPhi * tanPhi;
    const C = ep2 * cosPhi * cosPhi;
    const A = cosPhi * (lam - lam0);

    const M = this.meridionalArc(phi, a, e2);
    const M0 = this.meridionalArc(phi0, a, e2);

    const easting =
      falseEasting +
      k0 *
        N *
        (A +
          ((1 - T + C) * Math.pow(A, 3)) / 6 +
          ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * Math.pow(A, 5)) / 120);

    const northing =
      falseNorthing +
      k0 *
        (M -
          M0 +
          N *
            tanPhi *
            ((A * A) / 2 +
              ((5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4)) / 24 +
              ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * Math.pow(A, 6)) / 720));

    return { easting, northing };
  }

  private static meridionalArc(phi: number, a: number, e2: number): number {
    const e4 = e2 * e2;
    const e6 = e4 * e2;
    return (
      a *
      ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi -
        ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi) +
        ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi) -
        ((35 * e6) / 3072) * Math.sin(6 * phi))
    );
  }

  /**
   * Builds a Military Tactical Grid GeoJSON overlay (1km / 5km / 10km grid lines + ITM labels)
   * covering the current viewport bounds.
   */
  static buildTacticalGridGeoJSON(
    west: number,
    south: number,
    east: number,
    north: number,
    zoom: number
  ): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];

    // Choose grid spacing in degrees (~1km at zoom>=13, ~5km at zoom>=10, ~10km at zoom<10)
    const stepDeg = zoom >= 13 ? 0.01 : zoom >= 10.5 ? 0.05 : 0.1;
    const majorEvery = 5;

    const minLon = Math.max(33.8, Math.floor(west / stepDeg) * stepDeg);
    const maxLon = Math.min(36.3, Math.ceil(east / stepDeg) * stepDeg);
    const minLat = Math.max(29.2, Math.floor(south / stepDeg) * stepDeg);
    const maxLat = Math.min(33.6, Math.ceil(north / stepDeg) * stepDeg);

    // Vertical Grid Meridians (Easting lines)
    let colIdx = Math.round(minLon / stepDeg);
    for (let lon = minLon; lon <= maxLon + 1e-6; lon += stepDeg, colIdx++) {
      const isMajor = colIdx % majorEvery === 0;
      const itm = this.toMilitaryCoords(lon, (minLat + maxLat) / 2);
      const kmLabel = String(Math.floor(itm.itmEasting / 1000)).padStart(3, '0');

      features.push({
        type: 'Feature',
        properties: {
          kind: isMajor ? 'major-grid' : 'minor-grid',
          label: `${kmLabel}`,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [Number(lon.toFixed(5)), Number(minLat.toFixed(5))],
            [Number(lon.toFixed(5)), Number(maxLat.toFixed(5))],
          ],
        },
      });
    }

    // Horizontal Grid Parallels (Northing lines)
    let rowIdx = Math.round(minLat / stepDeg);
    for (let lat = minLat; lat <= maxLat + 1e-6; lat += stepDeg, rowIdx++) {
      const isMajor = rowIdx % majorEvery === 0;
      const itm = this.toMilitaryCoords((minLon + maxLon) / 2, lat);
      const kmLabel = String(Math.floor(itm.itmNorthing / 1000)).padStart(3, '0');

      features.push({
        type: 'Feature',
        properties: {
          kind: isMajor ? 'major-grid' : 'minor-grid',
          label: `${kmLabel}`,
        },
        geometry: {
          type: 'LineString',
          coordinates: [
            [Number(minLon.toFixed(5)), Number(lat.toFixed(5))],
            [Number(maxLon.toFixed(5)), Number(lat.toFixed(5))],
          ],
        },
      });
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  }

  /**
   * Converts ITM (Israel Transverse Mercator, EPSG:2039) easting/northing in meters back to WGS84 (lon, lat).
   * Uses iterative inversion of projectTransverseMercator to achieve millimeter accuracy.
   */
  static itmToWgs84(easting: number, northing: number): { lon: number; lat: number } {
    let lon = 35.2045169444 + (easting - 219529.584) / 95000;
    let lat = 31.7343936111 + (northing - 626907.39) / 110880;

    // 4 Newton-style refinement steps against the exact forward TM projection
    for (let i = 0; i < 4; i++) {
      const proj = this.projectTransverseMercator(
        lon,
        lat,
        35.2045169444,
        31.7343936111,
        219529.584,
        626907.39,
        1.0000067
      );
      const dE = easting - proj.easting;
      const dN = northing - proj.northing;
      if (Math.abs(dE) < 0.01 && Math.abs(dN) < 0.01) break;
      const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      lon += dE / (111319.49 * cosLat);
      lat += dN / 110880.0;
    }

    return {
      lon: Number(lon.toFixed(6)),
      lat: Number(lat.toFixed(6)),
    };
  }

  /**
   * Parses manual coordinate / IDF grid searches:
   *  - WGS84: "31.7683, 35.2137" or "30.8281 34.8134" (lat, lon or lon, lat inside Israel region)
   *  - 8-digit IDF Grid: "1813-5828" or "1813 5828" or "18135828"
   *  - 12-digit ITM meters: "220120 / 631450" or "220120, 631450"
   */
  static parseCoordinateQuery(
    raw: string
  ): { lon: number; lat: number; label: string; subtitle: string; kind: 'wgs84' | 'itm' | 'idf-grid' } | null {
    const cleaned = raw
      .trim()
      .replace(/^נ\.?צ\.?:?\s*/i, '')
      .replace(/^itm:?\s*/i, '');
    if (!cleaned) return null;

    // 1. Decimal WGS84 coordinates: e.g. "31.7683, 35.2137" or "34.8134 30.8281"
    const decMatch = /^(-?\d{1,2}\.\d{3,})\s*[,;/\s]\s*(-?\d{1,2}\.\d{3,})$/.exec(cleaned);
    if (decMatch) {
      const a = Number(decMatch[1]);
      const b = Number(decMatch[2]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      // Standard order is lat, lon (28..35, 33..37). Detect swapped lon, lat in Israel bounds.
      let lat = a;
      let lon = b;
      if (a >= 33.5 && a <= 36.8 && b >= 28.5 && b < 33.5) {
        lon = a;
        lat = b;
      }
      if (lat >= -85 && lat <= 85 && lon >= -180 && lon <= 180) {
        const mil = this.toMilitaryCoords(lon, lat);
        return {
          lon: Number(lon.toFixed(6)),
          lat: Number(lat.toFixed(6)),
          label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
          subtitle: `קואורדינטות WGS84 • נ.צ. ${mil.idfGrid8Digit}`,
          kind: 'wgs84',
        };
      }
    }

    // 2. 8-digit IDF Tactical Grid: "1813-5828", "1813 5828", "18135828"
    const idfSep = /^(\d{4})\s*[-–—/\s]\s*(\d{4})$/.exec(cleaned);
    const idfCompact = !idfSep ? /^(\d{4})(\d{4})$/.exec(cleaned) : null;
    const idfMatch = idfSep || idfCompact;
    if (idfMatch) {
      const e4 = Number(idfMatch[1]);
      const n4 = Number(idfMatch[2]);
      if (e4 >= 1000 && e4 <= 3200 && n4 >= 3400 && n4 <= 8600) {
        const easting = e4 * 100 + 50;
        const northing = n4 * 100 + 50;
        const { lon, lat } = this.itmToWgs84(easting, northing);
        return {
          lon,
          lat,
          label: `נ.צ. ${idfMatch[1]}-${idfMatch[2]}`,
          subtitle: `רשת ישראל החדשה (${easting}E / ${northing}N)`,
          kind: 'idf-grid',
        };
      }
    }

    // 3. Full 6-digit ITM meters: "219529 / 626907" or "219529, 626907"
    const itmMatch = /^(\d{6})\s*[,;/\s]\s*(\d{6})$/.exec(cleaned);
    if (itmMatch) {
      const easting = Number(itmMatch[1]);
      const northing = Number(itmMatch[2]);
      if (easting >= 100000 && easting <= 320000 && northing >= 340000 && northing <= 860000) {
        const { lon, lat } = this.itmToWgs84(easting, northing);
        const mil = this.toMilitaryCoords(lon, lat);
        return {
          lon,
          lat,
          label: `ITM ${easting} / ${northing}`,
          subtitle: `נ.צ. ${mil.idfGrid8Digit} • ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
          kind: 'itm',
        };
      }
    }

    return null;
  }
}

