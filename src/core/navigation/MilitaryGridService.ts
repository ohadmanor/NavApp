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
}

