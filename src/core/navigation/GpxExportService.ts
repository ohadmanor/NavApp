import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { SavedRouteRecord } from '../db/NavDatabase';
import { RouteManager } from './RouteManager';

export interface GpxExportResult {
  fileName: string;
  gpxXml: string;
  method: 'browser-download' | 'native-documents' | 'native-data';
  locationLabelHe: string;
  uri?: string;
}

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]+/g;

/**
 * Produces a cross-platform safe, human-readable `.gpx` filename from a route/recording title.
 */
export function sanitizeGpxFileName(name: string, timestampIso?: string): string {
  const cleaned = String(name || '')
    .replace(INVALID_FILENAME_CHARS, ' ')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 72);

  const dateObj = timestampIso ? new Date(timestampIso) : null;
  const dateSuffix =
    dateObj && !Number.isNaN(dateObj.getTime())
      ? `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(
          dateObj.getDate()
        ).padStart(2, '0')}`
      : '';

  const base = cleaned || 'navapp_route';
  const withDate = dateSuffix && !base.includes(dateSuffix) ? `${base}_${dateSuffix}` : base;
  return withDate.toLowerCase().endsWith('.gpx') ? withDate : `${withDate}.gpx`;
}

export class GpxExportService {
  /**
   * Hydrates the full route geometry/timestamps, serializes GPX 1.1 XML, and writes or
   * downloads the `.gpx` file on Web, Android, and iOS.
   */
  static async exportAndSaveRouteGpx(route: SavedRouteRecord): Promise<GpxExportResult> {
    const full = RouteManager.isHydratedRoute(route)
      ? route
      : (await RouteManager.loadFullRoute(route)) || route;

    const gpxXml = RouteManager.exportRouteAsGpx(full);
    const fileName = sanitizeGpxFileName(
      full.name || full.id,
      full.recordingMeta?.startedAt || full.createdAt
    );

    if (Capacitor.isNativePlatform()) {
      const relativePath = `NavApp-Recordings/${fileName}`;
      try {
        const writeRes = await Filesystem.writeFile({
          path: relativePath,
          data: gpxXml,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        return {
          fileName,
          gpxXml,
          method: 'native-documents',
          locationLabelHe: `תיקיית Documents/NavApp-Recordings/${fileName}`,
          uri: writeRes.uri,
        };
      } catch {
        const fallbackRes = await Filesystem.writeFile({
          path: relativePath,
          data: gpxXml,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        return {
          fileName,
          gpxXml,
          method: 'native-data',
          locationLabelHe: `אחסון האפליקציה (${relativePath})`,
          uri: fallbackRes.uri,
        };
      }
    }

    if (
      typeof document !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      const blob = new Blob([gpxXml], { type: 'application/gpx+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    return {
      fileName,
      gpxXml,
      method: 'browser-download',
      locationLabelHe: `תיקיית ההורדות בדפדפן (${fileName})`,
    };
  }
}
