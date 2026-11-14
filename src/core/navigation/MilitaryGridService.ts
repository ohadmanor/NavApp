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

export interface GridZoomSpec {
  minorStepMeters: number;
  majorStepMeters: number;
  labelMinor: boolean;
  labelHalfKm?: boolean;
}

export class MilitaryGridService {
  private static readonly ITM_LON0 = 35.2045169444;
  private static readonly ITM_LAT0 = 31.7343936111;
  private static readonly ITM_FE = 219529.584;
  private static readonly ITM_FN = 626907.39;
  private static readonly ITM_K0 = 1.0000067;

  /**
   * Returns true if the coordinate falls within the Israel & Levant region where ITM (EPSG:2039)
   * is the standard topographic reference grid. Outside this region, UTM is used.
   */
  static isInsideItmRegion(lon: number, lat: number): boolean {
    return lon >= 31.5 && lon <= 39.0 && lat >= 27.5 && lat <= 35.5;
  }

  /**
   * Returns metric grid spacing and label rules for a given MapLibre zoom level.
   */
  static getGridZoomSpec(zoom: number): GridZoomSpec {
    const z = Math.floor(zoom);
    if (z <= 7) {
      return { minorStepMeters: 50_000, majorStepMeters: 100_000, labelMinor: false };
    }
    if (z === 8) {
      return { minorStepMeters: 20_000, majorStepMeters: 100_000, labelMinor: false };
    }
    if (z === 9) {
      return { minorStepMeters: 10_000, majorStepMeters: 50_000, labelMinor: false };
    }
    if (z === 10) {
      return { minorStepMeters: 5_000, majorStepMeters: 10_000, labelMinor: false };
    }
    if (z === 11) {
      return { minorStepMeters: 2_000, majorStepMeters: 10_000, labelMinor: false };
    }
    if (z === 12) {
      return { minorStepMeters: 1_000, majorStepMeters: 5_000, labelMinor: false };
    }
    if (z <= 15) {
      return { minorStepMeters: 1_000, majorStepMeters: 5_000, labelMinor: true };
    }
    return { minorStepMeters: 100, majorStepMeters: 1_000, labelMinor: false, labelHalfKm: true };
  }

  /**
   * Formats a metric grid coordinate (in meters) into its cartographic grid label.
   */
  static formatGridLabel(meters: number, isItm: boolean): string {
    if (meters % 1000 === 0) {
      const km = Math.round(meters / 1000);
      return isItm ? String(km).padStart(3, '0') : String(km);
    }
    if (meters % 500 === 0) {
      const kmHalf = (meters / 1000).toFixed(1);
      return isItm && meters < 100_000 ? kmHalf.padStart(5, '0') : kmHalf;
    }
    return String(Math.round(meters));
  }

  /**
   * Projects WGS84 (lon, lat) in degrees to ITM (EPSG:2039) easting/northing in meters.
   */
  static wgs84ToItm(lon: number, lat: number): { easting: number; northing: number } {
    return this.projectTransverseMercator(
      lon,
      lat,
      this.ITM_LON0,
      this.ITM_LAT0,
      this.ITM_FE,
      this.ITM_FN,
      this.ITM_K0
    );
  }

  /**
   * Projects WGS84 (lon, lat) in degrees to UTM easting/northing in meters for the given or natural zone.
   */
  static wgs84ToUtm(
    lon: number,
    lat: number,
    forcedZone?: number
  ): { zone: number; isNorthern: boolean; easting: number; northing: number } {
    const zone =
      typeof forcedZone === 'number'
        ? forcedZone
        : Math.max(1, Math.min(60, Math.floor((lon + 180) / 6) + 1));
    const lon0 = (zone - 1) * 6 - 180 + 3;
    const isNorthern = lat >= 0;
    const falseNorthing = isNorthern ? 0.0 : 10_000_000.0;
    const proj = this.projectTransverseMercator(lon, lat, lon0, 0.0, 500_000.0, falseNorthing, 0.9996);
    return { zone, isNorthern, easting: proj.easting, northing: proj.northing };
  }

  /**
   * Converts WGS84 (lon, lat) in degrees to ITM (Israel Transverse Mercator, EPSG:2039)
   * and UTM Zone 36N (EPSG:32636).
   */
  static toMilitaryCoords(lon: number, lat: number): MilitaryCoordReadout {
    const itm = this.wgs84ToItm(lon, lat);

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
   * Builds a Military Tactical Grid GeoJSON overlay using true metric ITM (EPSG:2039)
   * or UTM coordinates covering the supplied geographic bounding box.
   */
  static buildTacticalGridGeoJSON(
    west: number,
    south: number,
    east: number,
    north: number,
    zoom: number
  ): GeoJSON.FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    if (zoom < 7 || east <= west || north <= south) {
      return { type: 'FeatureCollection', features };
    }

    const spec = this.getGridZoomSpec(zoom);
    const stepM = spec.minorStepMeters;
    const majorM = spec.majorStepMeters;
    const centerLon = (west + east) / 2;
    const centerLat = (south + north) / 2;
    const useItm = this.isInsideItmRegion(centerLon, centerLat);
    const utmZone = Math.max(1, Math.min(60, Math.floor((centerLon + 180) / 6) + 1));
    const utmNorthern = centerLat >= 0;

    const toProj = (lon: number, lat: number) =>
      useItm ? this.wgs84ToItm(lon, lat) : this.wgs84ToUtm(lon, lat, utmZone);
    const toWgs = (easting: number, northing: number) =>
      useItm
        ? this.itmToWgs84(easting, northing)
        : this.utmToWgs84(easting, northing, utmZone, utmNorthern);

    const sampleCorners = [
      toProj(west, south),
      toProj(east, south),
      toProj(west, north),
      toProj(east, north),
    ];
    let minE = Infinity;
    let maxE = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const c of sampleCorners) {
      if (c.easting < minE) minE = c.easting;
      if (c.easting > maxE) maxE = c.easting;
      if (c.northing < minN) minN = c.northing;
      if (c.northing > maxN) maxN = c.northing;
    }

    const startE = Math.floor(minE / stepM) * stepM;
    const endE = Math.ceil(maxE / stepM) * stepM;
    const startN = Math.floor(minN / stepM) * stepM;
    const endN = Math.ceil(maxN / stepM) * stepM;

    const maxLinesPerAxis = 120;
    const eCount = Math.round((endE - startE) / stepM);
    const nCount = Math.round((endN - startN) / stepM);
    if (eCount > maxLinesPerAxis || nCount > maxLinesPerAxis) {
      return { type: 'FeatureCollection', features };
    }

    // Easting lines (roughly N-S)
    for (let e = startE; e <= endE + 0.5; e += stepM) {
      const roundedE = Math.round(e);
      const isMajor = Math.abs(roundedE % majorM) === 0;
      const coords: Array<[number, number]> = [];
      for (let i = 0; i <= 4; i++) {
        const n = startN + ((endN - startN) * i) / 4;
        const p = toWgs(roundedE, n);
        coords.push([p.lon, p.lat]);
      }
      features.push({
        type: 'Feature',
        properties: {
          kind: isMajor ? 'major-grid' : 'minor-grid',
          axis: 'easting',
          label: this.formatGridLabel(roundedE, useItm),
        },
        geometry: {
          type: 'LineString',
          coordinates: coords,
        },
      });
    }

    // Northing lines (roughly E-W)
    for (let n = startN; n <= endN + 0.5; n += stepM) {
      const roundedN = Math.round(n);
      const isMajor = Math.abs(roundedN % majorM) === 0;
      const coords: Array<[number, number]> = [];
      for (let i = 0; i <= 4; i++) {
        const e = startE + ((endE - startE) * i) / 4;
        const p = toWgs(e, roundedN);
        coords.push([p.lon, p.lat]);
      }
      features.push({
        type: 'Feature',
        properties: {
          kind: isMajor ? 'major-grid' : 'minor-grid',
          axis: 'northing',
          label: this.formatGridLabel(roundedN, useItm),
        },
        geometry: {
          type: 'LineString',
          coordinates: coords,
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
    return this.invertTransverseMercator(
      easting,
      northing,
      this.ITM_LON0,
      this.ITM_LAT0,
      this.ITM_FE,
      this.ITM_FN,
      this.ITM_K0
    );
  }

  /**
   * Converts UTM easting/northing in meters back to WGS84 (lon, lat).
   */
  static utmToWgs84(
    easting: number,
    northing: number,
    zone: number,
    isNorthern = true
  ): { lon: number; lat: number } {
    const lon0 = (zone - 1) * 6 - 180 + 3;
    const falseNorthing = isNorthern ? 0.0 : 10_000_000.0;
    return this.invertTransverseMercator(easting, northing, lon0, 0.0, 500_000.0, falseNorthing, 0.9996);
  }

  private static invertTransverseMercator(
    easting: number,
    northing: number,
    lon0Deg: number,
    lat0Deg: number,
    falseEasting: number,
    falseNorthing: number,
    k0: number
  ): { lon: number; lat: number } {
    let lat = Math.max(-84, Math.min(84, lat0Deg + (northing - falseNorthing) / 110880));
    const cosLatInit = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    let lon = lon0Deg + (easting - falseEasting) / (111319.49 * cosLatInit);

    // 6 Newton-style refinement steps against the exact forward TM projection
    for (let i = 0; i < 6; i++) {
      const proj = this.projectTransverseMercator(
        lon,
        lat,
        lon0Deg,
        lat0Deg,
        falseEasting,
        falseNorthing,
        k0
      );
      const dE = easting - proj.easting;
      const dN = northing - proj.northing;
      if (Math.abs(dE) < 0.005 && Math.abs(dN) < 0.005) break;
      const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      lon += dE / (111319.49 * cosLat);
      lat = Math.max(-85, Math.min(85, lat + dN / 110880.0));
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

