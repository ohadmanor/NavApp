import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  HardDrive,
  Lock,
  RefreshCw,
  Upload,
  FolderOpen,
  Globe,
  FileUp,
  Download,
  Trash2,
  Ban,
  ChevronDown,
  ChevronUp,
  Terminal,
} from 'lucide-react';
import type { MountedArchiveInfo } from '../../core/pmtiles/PMTilesRegistry';
import { pmtilesRegistry } from '../../core/pmtiles/PMTilesRegistry';
import { OpfsStorageAdapter } from '../../core/pmtiles/OpfsStorageAdapter';
import { NativeOfflineStorage } from '../../core/pmtiles/NativeOfflineStorage';
import { CommunityPoiImporter } from '../../core/pois/CommunityPoiImporter';
import { RouteManager } from '../../core/navigation/RouteManager';
import type { SavedRouteRecord } from '../../core/db/NavDatabase';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface MapStorageModalProps {
  isOpen: boolean;
  onClose: () => void;
  demInfo: MountedArchiveInfo | null;
  osmInfo: MountedArchiveInfo | null;
  theme?: MapTheme;
  embedded?: boolean;
  onArchivesUpdated: (dem: MountedArchiveInfo | null, osm: MountedArchiveInfo | null) => void;
  onPoisAndRoutesImported: (
    poiCount: number,
    createdRoutes: SavedRouteRecord[]
  ) => void | Promise<void>;
}

export const MapStorageModal: React.FC<MapStorageModalProps> = ({
  isOpen,
  onClose,
  demInfo,
  osmInfo,
  theme = 'topo-dark',
  embedded = false,
  onArchivesUpdated,
  onPoisAndRoutesImported,
}) => {
  const [remoteOsmUrl, setRemoteOsmUrl] = useState('');
  const [persistOpfs, setPersistOpfs] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [downloading, setDownloading] = useState<'israel-dem' | 'israel-osm' | null>(null);
  const [dlProgress, setDlProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<{
    dem?: { available: boolean; size?: number; url?: string };
    osm?: { available: boolean; size?: number; url?: string };
  }>({});
  const [isCheckingCloud, setIsCheckingCloud] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const osmFileInputRef = useRef<HTMLInputElement>(null);
  const demFileInputRef = useRef<HTMLInputElement>(null);
  const communityFileInputRef = useRef<HTMLInputElement>(null);

  const checkCloudStatus = async () => {
    setIsCheckingCloud(true);
    try {
      const [demRemote, osmRemote] = await Promise.all([
        pmtilesRegistry.probeRemote('Israel.dem.pmtiles'),
        pmtilesRegistry.probeRemote('Israel.osm.pmtiles'),
      ]);
      setCloudStatus({
        dem: demRemote
          ? { available: true, size: demRemote.size, url: demRemote.url }
          : { available: false },
        osm: osmRemote
          ? { available: true, size: osmRemote.size, url: osmRemote.url }
          : { available: false },
      });
    } catch {
      // offline
    } finally {
      setIsCheckingCloud(false);
    }
  };

  useEffect(() => {
    if (isOpen || embedded) {
      checkCloudStatus();
    }
  }, [isOpen, embedded]);

  if (!isOpen && !embedded) return null;

  const t = getSurfaceTheme(theme);

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const ARCHIVE_SIZES = { 'israel-dem': 1402183369, 'israel-osm': 112258784 } as const;
  const ARCHIVE_FILES = {
    'israel-dem': 'Israel.dem.pmtiles',
    'israel-osm': 'Israel.osm.pmtiles',
  } as const;

  const handleDownloadOffline = async (id: 'israel-dem' | 'israel-osm') => {
    if (downloading) return;
    const isAndroidNative = NativeOfflineStorage.isAndroidNative();
    if (!isAndroidNative && !OpfsStorageAdapter.isSupported()) {
      setStatusMessage('שגיאה: אחסון אופליין (OPFS) אינו נתמך במכשיר / בדפדפן זה.');
      return;
    }
    const needed = ARCHIVE_SIZES[id];
    if (isAndroidNative) {
      const nativeStatus = await NativeOfflineStorage.getArchiveStatus();
      if (nativeStatus && nativeStatus.freeBytes > 0 && nativeStatus.freeBytes < needed * 1.05) {
        setStatusMessage(
          `אין מספיק מקום אחסון פנוי במכשיר: נדרש ${formatSize(needed)}, פנוי ${formatSize(
            nativeStatus.freeBytes
          )}.`
        );
        return;
      }
    } else {
      const est = await OpfsStorageAdapter.getStorageEstimate();
      if (est.quota > 0 && est.quota - est.usage < needed * 1.05) {
        setStatusMessage(
          `אין מספיק מקום אחסון פנוי: נדרש ${formatSize(needed)}, פנוי ${formatSize(
            Math.max(0, est.quota - est.usage)
          )}.`
        );
        return;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(id);
    setIsBusy(true);
    setDlProgress({ loaded: 0, total: needed });
    setStatusMessage(`מוריד את ${ARCHIVE_FILES[id]} לשימוש אופליין...`);
    try {
      const mounted = await pmtilesRegistry.downloadOfflineArchive(
        id,
        (loaded, total) => setDlProgress({ loaded, total: total || needed }),
        controller.signal
      );
      if (id === 'israel-dem') onArchivesUpdated(mounted, osmInfo);
      else onArchivesUpdated(demInfo, mounted);
      setStatusMessage(`✓ ${ARCHIVE_FILES[id]} נשמר במכשיר – המפה פועלת כעת 100% אופליין!`);
    } catch (err: any) {
      setStatusMessage(
        err?.name === 'AbortError'
          ? 'ההורדה בוטלה.'
          : `שגיאה בהורדה: ${err?.message || err}`
      );
    } finally {
      setDownloading(null);
      setDlProgress(null);
      setIsBusy(false);
      abortRef.current = null;
    }
  };

  const handleCancelDownload = () => abortRef.current?.abort();

  const handleRemoveOffline = async (id: 'israel-dem' | 'israel-osm') => {
    if (!window.confirm(`למחוק את העותק המקומי של ${ARCHIVE_FILES[id]}? המפה תחזור להזרמה מקוונת.`)) {
      return;
    }
    await pmtilesRegistry.removeOfflineArchive(ARCHIVE_FILES[id]);
    window.location.reload();
  };

  const isLocalCopy = (info: MountedArchiveInfo | null) =>
    !!info &&
    (info.record.storageKind === 'opfs' ||
      info.record.storageKind === 'user-file' ||
      info.record.storageKind === 'native-file');

  const handleReplaceOsmFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsBusy(true);
    setStatusMessage(`טוען מפה וקטורית (${file.name})...`);
    try {
      const updatedOsm = await pmtilesRegistry.replaceOsmArchive(
        { kind: 'file', file, persistToOpfs: persistOpfs },
        (loaded, total) => {
          if (total > 0) setProgressPct(Math.round((loaded / total) * 100));
        }
      );
      onArchivesUpdated(demInfo, updatedOsm);
      setStatusMessage(`✓ קובץ Israel.osm.pmtiles עודכן בהצלחה! (${updatedOsm.record.createdUtc})`);
    } catch (err: any) {
      setStatusMessage(`שגיאה בטעינת הקובץ: ${err.message}`);
    } finally {
      setIsBusy(false);
      setProgressPct(null);
    }
  };

  const handleMountLocalDemFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsBusy(true);
    setStatusMessage(`טוען קובץ גבהים מקומי (${file.name})...`);
    try {
      const updatedDem = await pmtilesRegistry.mountLocalDemArchive(
        file,
        (loaded, total) => {
          if (total > 0) setProgressPct(Math.round((loaded / total) * 100));
        }
      );
      onArchivesUpdated(updatedDem, osmInfo);
      setStatusMessage(`✓ קובץ Israel.dem.pmtiles חובר בהצלחה מהמכשיר!`);
    } catch (err: any) {
      setStatusMessage(`שגיאה בטעינת DEM: ${err.message}`);
    } finally {
      setIsBusy(false);
      setProgressPct(null);
    }
  };

  const handleRemoteOsmUpdate = async () => {
    if (!remoteOsmUrl.trim()) return;
    setIsBusy(true);
    setStatusMessage(`מעדכן את Israel.osm.pmtiles מכתובת URL...`);
    try {
      const updatedOsm = await pmtilesRegistry.replaceOsmArchive(
        { kind: 'url', url: remoteOsmUrl.trim() },
        (loaded, total) => {
          if (total > 0) setProgressPct(Math.round((loaded / total) * 100));
        }
      );
      onArchivesUpdated(demInfo, updatedOsm);
      setStatusMessage(`✓ קובץ Israel.osm.pmtiles עודכן בהצלחה מכתובת ה-URL!`);
    } catch (err: any) {
      setStatusMessage(`שגיאה בעדכון מרוחק: ${err.message}`);
    } finally {
      setIsBusy(false);
      setProgressPct(null);
    }
  };

  const handleImportCommunityFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsBusy(true);
    setStatusMessage(`מייבא נקודות עניין ומסלולים מתוך ${file.name}...`);
    try {
      const { importedPois, extractedLineCoordinates, extractedRoutes } =
        await CommunityPoiImporter.importWaypointsAndRoutesFromFile(file);

      const tracksToCreate =
        extractedRoutes.length > 0
          ? extractedRoutes
          : extractedLineCoordinates.map((coords) => ({ segments: [coords] }));

      const baseName = file.name.replace(/\.[^.]+$/, '');
      const sourceFormat = file.name.toLowerCase().endsWith('.kml')
        ? 'kml'
        : file.name.toLowerCase().endsWith('.geojson') || file.name.toLowerCase().endsWith('.json')
          ? 'geojson'
          : 'gpx';

      const createdRoutes: SavedRouteRecord[] = [];
      for (let i = 0; i < tracksToCreate.length; i++) {
        const track = tracksToCreate[i];
        const fallbackName =
          tracksToCreate.length > 1 ? `${baseName} #${i + 1}` : baseName;
        const routeName = (track as { name?: string }).name?.trim() || fallbackName;
        const savedRoute = await RouteManager.createAndSaveRoute({
          name: routeName,
          coordinates: track.segments[0],
          segments: track.segments,
          sourceFormat,
          color: '#ec4899',
        });
        createdRoutes.push(savedRoute);
      }

      if (importedPois.length === 0 && createdRoutes.length === 0) {
        setStatusMessage(
          `לא נמצאו מסלולים או נקודות עניין בקובץ ${file.name}. ודא שהקובץ תקין ומכיל <trkpt>, <rtept> או <wpt>.`
        );
        return;
      }

      await onPoisAndRoutesImported(importedPois.length, createdRoutes);
      setStatusMessage(
        `✓ יובאו בהצלחה ${importedPois.length} נקודות עניין ו-${createdRoutes.length} מסלולים מתוך ${file.name}!`
      );
    } catch (err: any) {
      setStatusMessage(`שגיאה בייבוא קובץ: ${err.message}`);
    } finally {
      setIsBusy(false);
      e.target.value = '';
    }
  };

  const osmLocal = isLocalCopy(osmInfo);
  const demLocal = isLocalCopy(demInfo);
  const storedBytes =
    (osmLocal ? osmInfo?.record.sizeBytes || ARCHIVE_SIZES['israel-osm'] : 0) +
    (demLocal ? demInfo?.record.sizeBytes || ARCHIVE_SIZES['israel-dem'] : 0);
  const totalBytes = ARCHIVE_SIZES['israel-osm'] + ARCHIVE_SIZES['israel-dem'];

  const body = (
    <div dir="rtl" className="space-y-3.5">
      {/* Header */}
      <div className={`flex items-center justify-between border-b pb-3 ${t.divider}`}>
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-500">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">מפות אופליין וייבוא קבצים</h2>
            <p className={`text-xs ${t.muted}`}>עבודה מלאה בשטח ללא קליטה סלולרית</p>
          </div>
        </div>
        <button onClick={onClose} className={`p-1.5 rounded-lg border ${t.pillBtn}`} title="סגור">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Status / Progress Banner */}
      {statusMessage && (
        <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-500 font-semibold space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span>{statusMessage}</span>
            {progressPct !== null && <span className="font-mono font-bold">{progressPct}%</span>}
          </div>
          {progressPct !== null && (
            <div className="w-full h-2 bg-slate-500/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}
        </div>
      )}

      {/* Clean Device Storage Meter */}
      <div className={`p-3 rounded-xl border space-y-2 ${t.subCard}`}>
        <div className="flex items-center justify-between text-xs font-bold">
          <span>מפות שמורות במכשיר (OPFS / מקומי)</span>
          <span className="text-emerald-500 font-mono">
            {storedBytes > 0 ? `${formatSize(storedBytes)} שמור` : 'מצב הזרמה מהענן'}
          </span>
        </div>
        <div className="w-full h-2.5 rounded-full bg-slate-500/20 overflow-hidden flex">
          <div
            className="bg-emerald-500 h-full transition-all"
            style={{
              width: `${demLocal ? Math.round((ARCHIVE_SIZES['israel-dem'] / totalBytes) * 100) : 0}%`,
            }}
          />
          <div
            className="bg-sky-500 h-full transition-all"
            style={{
              width: `${osmLocal ? Math.round((ARCHIVE_SIZES['israel-osm'] / totalBytes) * 100) : 0}%`,
            }}
          />
        </div>
        <div className={`flex justify-between text-xs ${t.muted}`}>
          <span>● גבהים 1.40 GB ({demLocal ? 'במכשיר' : 'בענן'})</span>
          <span>● שבילים ווקטור 112 MB ({osmLocal ? 'במכשיר' : 'בענן'})</span>
        </div>
      </div>

      {/* Offline Package Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(['israel-osm', 'israel-dem'] as const).map((id) => {
          const info = id === 'israel-dem' ? demInfo : osmInfo;
          const local = isLocalCopy(info);
          const active = downloading === id;
          const pct =
            active && dlProgress && dlProgress.total > 0
              ? Math.min(100, Math.round((dlProgress.loaded / dlProgress.total) * 100))
              : 0;
          const isDem = id === 'israel-dem';

          return (
            <div key={id} className={`p-3.5 rounded-xl border space-y-2.5 ${t.subCard}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    {isDem ? (
                      <Lock className="w-3.5 h-3.5 text-amber-500" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5 text-emerald-500" />
                    )}
                    <span>
                      {isDem ? 'מודל גבהים וקונטורים (DEM)' : 'מפת שבילים ודרכים (OSM)'}
                    </span>
                  </div>
                  <div className={`text-xs font-mono mt-0.5 ${t.muted}`}>
                    {ARCHIVE_FILES[id]} • {formatSize(info?.record.sizeBytes || ARCHIVE_SIZES[id])}
                  </div>
                </div>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-xs font-bold shrink-0 ${
                    local
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : 'bg-amber-500/15 text-amber-500'
                  }`}
                >
                  {local
                    ? '✓ אופליין'
                    : info?.record.storageKind === 'local-server'
                      ? 'שרת מקומי'
                      : 'ענן'}
                </span>
              </div>

              {info && (
                <div className={`text-xs space-y-0.5 ${t.muted}`}>
                  <div>
                    {isDem
                      ? `${info.record.storageKind === 'native-file' ? 'שמור במכשיר (Android + Auto) • ' : 'קבוע ומוגן • '}זום z${info.record.minZoom}–z${info.record.maxZoom}`
                      : `${info.record.storageKind === 'native-file' ? 'שמור במכשיר (Android + Auto)' : info.record.storageKind === 'opfs' ? 'שמור ב-OPFS' : info.record.storageKind === 'local-server' ? 'מקור: /data מקומי' : 'מקור: ענן Firebase'} • עודכן: ${info.record.createdUtc.slice(0, 10)}`}
                  </div>
                  {!isDem && info.hasTrailColorSchema !== undefined && (
                    <div
                      className={
                        info.hasTrailColorSchema
                          ? 'text-emerald-500 font-semibold'
                          : 'text-amber-500 font-semibold'
                      }
                    >
                      {info.hasTrailColorSchema
                        ? '✓ כולל צבעי שבילים מובנים (colour / osmc_symbol)'
                        : '⚠ קובץ ישן ללא צבעי שבילים — יש לעדכן בענן (upload-map-data.bat)'}
                    </div>
                  )}
                </div>
              )}

              {active && dlProgress && (
                <div className="space-y-1">
                  <div className="w-full h-2 bg-slate-500/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className={`text-xs font-mono flex justify-between ${t.muted}`}>
                    <span>
                      {formatSize(dlProgress.loaded)} / {formatSize(dlProgress.total)}
                    </span>
                    <span>{pct}%</span>
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                {active ? (
                  <button
                    onClick={handleCancelDownload}
                    className="flex-1 py-2 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white flex items-center justify-center gap-1.5"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    <span>בטל הורדה</span>
                  </button>
                ) : (
                  <button
                    disabled={isBusy}
                    onClick={() => handleDownloadOffline(id)}
                    className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                      local
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                        : 'bg-amber-600 hover:bg-amber-500 text-white'
                    } disabled:opacity-40`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{local ? 'עדכן / הורד מחדש' : 'הורד לאופליין'}</span>
                  </button>
                )}
                {local && !active && (
                  <button
                    disabled={isBusy}
                    onClick={() => handleRemoveOffline(id)}
                    className={`px-3 py-2 rounded-xl border text-xs text-red-500 ${t.pillBtn}`}
                    title="מחק עותק מקומי"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Community GPX / KML / TWL Importer */}
      <div className="p-3.5 rounded-xl border border-dashed border-sky-500/60 bg-sky-500/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="text-xs font-bold">ייבוא מסלולים ונקודות עניין מהקהילה</div>
          <p className={`text-xs ${t.muted}`}>
            תומך בקבצי <code className="font-mono">.gpx</code>, <code className="font-mono">.kml</code>,{' '}
            <code className="font-mono">.twl</code> ו-<code className="font-mono">.geojson</code> (עמוד ענן / Off-Road / IHM)
          </p>
        </div>
        <input
          ref={communityFileInputRef}
          type="file"
          accept=".gpx,.kml,.geojson,.json,.twl"
          onChange={handleImportCommunityFile}
          className="hidden"
        />
        <button
          disabled={isBusy}
          onClick={() => communityFileInputRef.current?.click()}
          className="w-full sm:w-auto px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-xs font-bold text-white flex items-center justify-center gap-2 shrink-0 transition-colors"
        >
          <FileUp className="w-4 h-4" />
          <span>בחר קובץ GPX / KML / TWL</span>
        </button>
      </div>

      {/* Collapsible Advanced Local/Cloud Tools */}
      <div className={`rounded-xl border overflow-hidden ${t.subCard}`}>
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-bold"
        >
          <span className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-amber-500" />
            <span>מתקדם: טעינת קובץ PMTiles מקומי ועדכון ענן</span>
          </span>
          {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showAdvanced && (
          <div className={`px-3.5 pb-3.5 pt-2 border-t space-y-3 text-xs ${t.divider}`}>
            <div className="flex items-center justify-between">
              <span className={t.muted}>בדיקת זמינות קבצים בענן (Firebase):</span>
              <button
                onClick={checkCloudStatus}
                disabled={isCheckingCloud}
                className={`px-2.5 py-1 rounded-lg border text-xs font-semibold flex items-center gap-1 ${t.pillBtn}`}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCheckingCloud ? 'animate-spin' : ''}`} />
                <span>{isCheckingCloud ? 'בודק...' : 'רענן מצב ענן'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                ref={osmFileInputRef}
                type="file"
                accept=".pmtiles"
                onChange={handleReplaceOsmFile}
                className="hidden"
              />
              <button
                disabled={isBusy}
                onClick={() => osmFileInputRef.current?.click()}
                className={`py-2 px-3 rounded-xl border font-semibold flex items-center justify-center gap-1.5 ${t.pillBtn}`}
              >
                <Upload className="w-4 h-4 text-emerald-500" />
                <span>החלף Israel.osm מקובץ</span>
              </button>

              <input
                ref={demFileInputRef}
                type="file"
                accept=".pmtiles"
                onChange={handleMountLocalDemFile}
                className="hidden"
              />
              <button
                disabled={isBusy}
                onClick={() => demFileInputRef.current?.click()}
                className={`py-2 px-3 rounded-xl border font-semibold flex items-center justify-center gap-1.5 ${t.pillBtn}`}
              >
                <FolderOpen className="w-4 h-4 text-amber-500" />
                <span>טען Israel.dem מקובץ</span>
              </button>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={persistOpfs}
                onChange={(e) => setPersistOpfs(e.target.checked)}
                className="rounded border-slate-500 text-emerald-600"
              />
              <span className={t.muted}>שמור קובץ OSM שהוחלף בזיכרון המקומי (OPFS)</span>
            </label>

            <div className="flex gap-2">
              <input
                type="url"
                dir="ltr"
                value={remoteOsmUrl}
                onChange={(e) => setRemoteOsmUrl(e.target.value)}
                placeholder="https://.../Israel.osm.pmtiles"
                className={`flex-1 rounded-xl border px-3 py-1.5 text-xs ${t.fieldBox}`}
              />
              <button
                disabled={isBusy || !remoteOsmUrl.trim()}
                onClick={handleRemoteOsmUpdate}
                className={`px-3 py-1.5 rounded-xl border text-xs font-semibold text-sky-500 disabled:opacity-40 flex items-center gap-1 ${t.pillBtn}`}
              >
                <Globe className="w-3.5 h-3.5" />
                <span>עדכן מ-URL</span>
              </button>
            </div>

            <div className={`p-2.5 rounded-xl border text-xs ${t.panelSolid}`}>
              <div className="font-bold text-amber-500 mb-1">עדכון ענן למשתמשים (DevOps):</div>
              <code className="block font-mono text-emerald-500 select-all" dir="ltr">
                devops\upload-map-data.bat
              </code>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  if (embedded) {
    return <div className="p-4 max-h-[65vh] overflow-y-auto">{body}</div>;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4">
      <div className={`rounded-2xl border max-w-2xl w-full max-h-[88vh] overflow-y-auto p-5 ${t.panelSolid}`}>
        {body}
      </div>
    </div>
  );
};
