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
  Database,
} from 'lucide-react';
import type { MountedArchiveInfo } from '../../core/pmtiles/PMTilesRegistry';
import { pmtilesRegistry } from '../../core/pmtiles/PMTilesRegistry';
import {
  offlineDataFiles,
  OFFLINE_DATA_FILE_SPECS,
  type OfflineDataBundleStatus,
  type OfflineDataFileName,
} from '../../core/pmtiles/OfflineDataFiles';
import { probeRemoteDataFile } from '../../core/pmtiles/dataFileProbe';
import { OpfsStorageAdapter } from '../../core/pmtiles/OpfsStorageAdapter';
import { NativeOfflineStorage } from '../../core/pmtiles/NativeOfflineStorage';
import { CommunityPoiImporter } from '../../core/pois/CommunityPoiImporter';
import { RouteManager } from '../../core/navigation/RouteManager';
import type { NavUser } from '../../core/firebase/AuthService';
import type { PoiRecord, SavedRouteRecord } from '../../core/db/NavDatabase';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface MapStorageModalProps {
  isOpen: boolean;
  onClose: () => void;
  demInfo: MountedArchiveInfo | null;
  osmInfo: MountedArchiveInfo | null;
  theme?: MapTheme;
  embedded?: boolean;
  currentUser?: NavUser | null;
  onArchivesUpdated: (dem: MountedArchiveInfo | null, osm: MountedArchiveInfo | null) => void;
  onDataBundleUpdated?: () => void;
  onPoisAndRoutesImported: (
    poiCount: number,
    createdRoutes: SavedRouteRecord[],
    importedPois?: PoiRecord[]
  ) => void | Promise<void>;
}

interface CloudEntryStatus {
  available: boolean;
  size?: number;
  url?: string;
}

const DEFAULT_DATA_BUNDLE_BYTES = OFFLINE_DATA_FILE_SPECS.reduce(
  (sum, spec) => sum + spec.defaultSizeBytes,
  0
);

export const MapStorageModal: React.FC<MapStorageModalProps> = ({
  isOpen,
  onClose,
  demInfo,
  osmInfo,
  theme = 'topo-dark',
  embedded = false,
  currentUser = null,
  onArchivesUpdated,
  onDataBundleUpdated,
  onPoisAndRoutesImported,
}) => {
  const [remoteOsmUrl, setRemoteOsmUrl] = useState('');
  const [persistOpfs, setPersistOpfs] = useState(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [downloading, setDownloading] = useState<
    'israel-dem' | 'israel-osm' | 'offline-data' | null
  >(null);
  const [dlProgress, setDlProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [dataBundleStatus, setDataBundleStatus] = useState<OfflineDataBundleStatus | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<{
    dem?: CloudEntryStatus;
    osm?: CloudEntryStatus;
    pois?: CloudEntryStatus;
    offroadPois?: CloudEntryStatus;
    searchIdx?: CloudEntryStatus;
  }>({});
  const [isCheckingCloud, setIsCheckingCloud] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const osmFileInputRef = useRef<HTMLInputElement>(null);
  const demFileInputRef = useRef<HTMLInputElement>(null);
  const poisFileInputRef = useRef<HTMLInputElement>(null);
  const offroadFileInputRef = useRef<HTMLInputElement>(null);
  const searchIdxFileInputRef = useRef<HTMLInputElement>(null);
  const communityFileInputRef = useRef<HTMLInputElement>(null);

  const checkCloudStatus = async () => {
    setIsCheckingCloud(true);
    try {
      const [demRemote, osmRemote, poisRemote, offroadRemote, searchRemote] = await Promise.all([
        pmtilesRegistry.probeRemote('Israel.dem.pmtiles'),
        pmtilesRegistry.probeRemote('Israel.osm.pmtiles'),
        probeRemoteDataFile('Israel.pois.geojson', { preferHead: true }),
        probeRemoteDataFile('Israel.offroad.pois.geojson', { preferHead: true }),
        probeRemoteDataFile('Israel.search.idx', { preferHead: true }),
      ]);
      const toStatus = (
        res: { size: number; url: string } | null
      ): CloudEntryStatus => (res ? { available: true, size: res.size, url: res.url } : { available: false });
      setCloudStatus({
        dem: toStatus(demRemote),
        osm: toStatus(osmRemote),
        pois: toStatus(poisRemote),
        offroadPois: toStatus(offroadRemote),
        searchIdx: toStatus(searchRemote),
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
      void offlineDataFiles
        .getBundleStatus()
        .then(setDataBundleStatus)
        .catch(() => {});
    } else if (!isBusy) {
      setStatusMessage(null);
      setProgressPct(null);
    }
  }, [isOpen, embedded, isBusy]);

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

  const ensureFreeSpaceForOfflineDownload = async (needed: number): Promise<boolean> => {
    const isAndroidNative = NativeOfflineStorage.isAndroidNative();
    if (!isAndroidNative && !OpfsStorageAdapter.isSupported()) {
      setStatusMessage('שגיאה: אחסון אופליין (OPFS) אינו נתמך במכשיר / בדפדפן זה.');
      return false;
    }
    if (isAndroidNative) {
      const nativeStatus = await NativeOfflineStorage.getArchiveStatus();
      if (nativeStatus && nativeStatus.freeBytes > 0 && nativeStatus.freeBytes < needed * 1.05) {
        setStatusMessage(
          `אין מספיק מקום אחסון פנוי במכשיר: נדרש ${formatSize(needed)}, פנוי ${formatSize(
            nativeStatus.freeBytes
          )}.`
        );
        return false;
      }
      return true;
    }
    const est = await OpfsStorageAdapter.getStorageEstimate();
    if (est.quota > 0 && est.quota - est.usage < needed * 1.05) {
      setStatusMessage(
        `אין מספיק מקום אחסון פנוי: נדרש ${formatSize(needed)}, פנוי ${formatSize(
          Math.max(0, est.quota - est.usage)
        )}.`
      );
      return false;
    }
    return true;
  };

  const handleDownloadOffline = async (id: 'israel-dem' | 'israel-osm') => {
    if (downloading) return;
    const needed = ARCHIVE_SIZES[id];
    if (!(await ensureFreeSpaceForOfflineDownload(needed))) return;

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

  const handleDownloadOfflineData = async () => {
    if (downloading) return;
    const needed = dataBundleStatus?.totalBytes || DEFAULT_DATA_BUNDLE_BYTES;
    if (!(await ensureFreeSpaceForOfflineDownload(needed))) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading('offline-data');
    setIsBusy(true);
    setDlProgress({ loaded: 0, total: needed });
    setStatusMessage('מוריד נקודות עניין ואינדקס חיפוש לשימוש אופליין...');
    try {
      const nextStatus = await offlineDataFiles.downloadOfflineBundle(
        (loaded, total) => setDlProgress({ loaded, total: total || needed }),
        controller.signal
      );
      setDataBundleStatus(nextStatus);
      onDataBundleUpdated?.();
      setStatusMessage('✓ חבילת נקודות העניין והחיפוש נשמרה במכשיר ותעודכן אוטומטית!');
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

  const handleRemoveOfflineData = async () => {
    if (
      !window.confirm(
        'למחוק את העותק המקומי של נקודות העניין ואינדקס החיפוש? האפליקציה תחזור לטעון אותם מ-Firebase בחיבור מקוון.'
      )
    ) {
      return;
    }
    setIsBusy(true);
    try {
      await offlineDataFiles.removeOfflineBundle();
      const nextStatus = await offlineDataFiles.getBundleStatus();
      setDataBundleStatus(nextStatus);
      onDataBundleUpdated?.();
      setStatusMessage('✓ העותק המקומי של נקודות העניין והחיפוש נמחק.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleReplaceLocalDataFile = async (
    fileName: OfflineDataFileName,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsBusy(true);
    setStatusMessage(`טוען קובץ נתונים מקומי (${fileName})...`);
    try {
      const nextStatus = await offlineDataFiles.replaceLocalDataFile(
        fileName,
        file,
        (loaded, total) => {
          if (total > 0) setProgressPct(Math.round((loaded / total) * 100));
        }
      );
      setDataBundleStatus(nextStatus);
      onDataBundleUpdated?.();
      setStatusMessage(`✓ הקובץ ${fileName} נשמר במכשיר בהצלחה!`);
    } catch (err: any) {
      setStatusMessage(`שגיאה בטעינת ${fileName}: ${err.message}`);
    } finally {
      setIsBusy(false);
      setProgressPct(null);
      e.target.value = '';
    }
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
      e.target.value = '';
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
      e.target.value = '';
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
        const track = tracksToCreate[i] as {
          name?: string;
          segments: Array<Array<[number, number]>>;
          pointElevations?: Array<Array<number | null>>;
        };
        const fallbackName =
          tracksToCreate.length > 1 ? `${baseName} #${i + 1}` : baseName;
        const routeName = track.name?.trim() || fallbackName;
        const savedRoute = await RouteManager.createAndSaveRoute({
          name: routeName,
          coordinates: track.segments[0],
          segments: track.segments,
          segmentElevations: track.pointElevations,
          sourceFormat,
          color: '#ec4899',
          ownerUid: currentUser?.uid ?? null,
          ownerEmail: currentUser?.email ?? null,
          ownerDisplayName: currentUser?.displayName ?? null,
        });
        createdRoutes.push(savedRoute);
      }

      if (importedPois.length === 0 && createdRoutes.length === 0) {
        setStatusMessage(
          `לא נמצאו מסלולים או נקודות עניין בקובץ ${file.name}. ודא שהקובץ תקין ומכיל <trkpt>, <rtept> או <wpt>.`
        );
        return;
      }

      await onPoisAndRoutesImported(importedPois.length, createdRoutes, importedPois);
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
  const dataLocal = !!dataBundleStatus?.allLocal;
  const dataAnyLocal = !!dataBundleStatus?.anyLocal;
  const dataBundleBytes = dataBundleStatus?.totalBytes || DEFAULT_DATA_BUNDLE_BYTES;
  const dataStoredBytes = dataBundleStatus
    ? dataBundleStatus.files.filter((f) => f.local).reduce((sum, f) => sum + f.sizeBytes, 0)
    : 0;
  const storedBytes =
    (osmLocal ? osmInfo?.record.sizeBytes || ARCHIVE_SIZES['israel-osm'] : 0) +
    (demLocal ? demInfo?.record.sizeBytes || ARCHIVE_SIZES['israel-dem'] : 0) +
    dataStoredBytes;
  const totalBytes = ARCHIVE_SIZES['israel-osm'] + ARCHIVE_SIZES['israel-dem'] + dataBundleBytes;

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
      {statusMessage && (() => {
        const isError =
          statusMessage.startsWith('שגיאה') ||
          statusMessage.includes('אין מספיק') ||
          statusMessage.includes('לא נמצאו') ||
          statusMessage.includes('אינו נתמך');
        const isSuccess = statusMessage.startsWith('✓');
        const tone = isError
          ? 'bg-red-500/15 border-red-500/50 text-red-500'
          : isSuccess
            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-500'
            : 'bg-sky-500/15 border-sky-500/40 text-sky-400';
        const barTone = isError ? 'bg-red-500' : isSuccess ? 'bg-emerald-500' : 'bg-sky-500';
        return (
          <div className={`p-3 rounded-xl border text-xs font-semibold space-y-2 ${tone}`}>
            <div className="flex items-center justify-between gap-2">
              <span>{statusMessage}</span>
              {progressPct !== null && <span className="font-mono font-bold">{progressPct}%</span>}
            </div>
            {progressPct !== null && (
              <div className="w-full h-2 bg-slate-500/20 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${barTone}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
          </div>
        );
      })()}

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
          <div
            className="bg-amber-500 h-full transition-all"
            style={{
              width: `${dataStoredBytes > 0 ? Math.max(1, Math.round((dataStoredBytes / totalBytes) * 100)) : 0}%`,
            }}
          />
        </div>
        <div className={`flex flex-wrap justify-between gap-2 text-xs ${t.muted}`}>
          <span>● גבהים 1.40 GB ({demLocal ? 'במכשיר' : 'בענן'})</span>
          <span>● שבילים ווקטור 112 MB ({osmLocal ? 'במכשיר' : 'בענן'})</span>
          <span>
            ● נקודות עניין וחיפוש {formatSize(dataBundleBytes)} (
            {dataLocal
              ? 'במכשיר'
              : dataAnyLocal
                ? 'חלקי במכשיר'
                : dataBundleStatus?.storageKind === 'local-server'
                  ? 'שרת מקומי'
                  : 'בענן'}
            )
          </span>
        </div>
      </div>

      {/* Offline Package Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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

        {(() => {
          const active = downloading === 'offline-data';
          const pct =
            active && dlProgress && dlProgress.total > 0
              ? Math.min(100, Math.round((dlProgress.loaded / dlProgress.total) * 100))
              : 0;
          return (
            <div className={`p-3.5 rounded-xl border space-y-2.5 ${t.subCard}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <Database className="w-3.5 h-3.5 text-amber-500" />
                    <span>נקודות עניין וחיפוש אופליין (POIs &amp; Search)</span>
                  </div>
                  <div className={`text-xs font-mono mt-0.5 ${t.muted}`}>
                    3 קבצים • {formatSize(dataBundleBytes)}
                  </div>
                </div>
                <span
                  className={`px-2.5 py-0.5 rounded-full text-xs font-bold shrink-0 ${
                    dataLocal
                      ? 'bg-emerald-500/15 text-emerald-500'
                      : 'bg-amber-500/15 text-amber-500'
                  }`}
                >
                  {dataLocal
                    ? '✓ אופליין'
                    : dataAnyLocal
                      ? 'חלקי'
                      : dataBundleStatus?.storageKind === 'local-server'
                        ? 'שרת מקומי'
                        : 'ענן'}
                </span>
              </div>

              <div className={`text-xs space-y-0.5 ${t.muted}`}>
                {(dataBundleStatus?.files ??
                  OFFLINE_DATA_FILE_SPECS.map((s) => ({
                    fileName: s.fileName,
                    local: false,
                    storageKind: 'remote-url' as const,
                    sizeBytes: s.defaultSizeBytes,
                  }))
                ).map((item) => (
                  <div key={item.fileName} className="flex items-center justify-between gap-1 font-mono text-[11px]">
                    <span className="truncate" dir="ltr">
                      {item.fileName}
                    </span>
                    <span className={item.local ? 'text-emerald-500 shrink-0' : 'shrink-0'}>
                      {formatSize(item.sizeBytes)}
                    </span>
                  </div>
                ))}
              </div>

              {active && dlProgress && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-mono text-sky-400">
                    <span>{formatSize(dlProgress.loaded)} / {formatSize(dlProgress.total)}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-500/20 overflow-hidden">
                    <div className="h-full bg-sky-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-0.5">
                {active ? (
                  <button
                    onClick={handleCancelDownload}
                    className="flex-1 py-2 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center justify-center gap-1.5"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    <span>בטל הורדה</span>
                  </button>
                ) : (
                  <button
                    disabled={isBusy}
                    onClick={handleDownloadOfflineData}
                    className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 text-white transition-colors ${
                      dataLocal ? 'bg-slate-600 hover:bg-slate-500' : 'bg-amber-600 hover:bg-amber-500'
                    } disabled:opacity-40`}
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{dataLocal ? 'עדכן / הורד מחדש' : 'הורד לאופליין'}</span>
                  </button>
                )}
                {dataAnyLocal && !active && (
                  <button
                    disabled={isBusy}
                    onClick={handleRemoveOfflineData}
                    className={`px-3 py-2 rounded-xl border text-xs text-red-500 ${t.pillBtn}`}
                    title="מחק עותק מקומי"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          );
        })()}
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
          id="community-route-import-file"
          name="communityRouteImportFile"
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
            <span>מתקדם: טעינת קבצים מקומיים ועדכון ענן</span>
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

            <div className={`rounded-xl border p-2.5 space-y-1 text-[11px] font-mono ${t.panelSolid}`}>
              {([
                { label: 'Israel.dem.pmtiles', st: cloudStatus.dem },
                { label: 'Israel.osm.pmtiles', st: cloudStatus.osm },
                { label: 'Israel.pois.geojson', st: cloudStatus.pois },
                { label: 'Israel.offroad.pois.geojson', st: cloudStatus.offroadPois },
                { label: 'Israel.search.idx', st: cloudStatus.searchIdx },
              ] as const).map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-2">
                  <span dir="ltr">{row.label}</span>
                  <span
                    className={
                      row.st?.available
                        ? 'text-emerald-500'
                        : row.st
                          ? 'text-red-500'
                          : t.muted
                    }
                  >
                    {row.st
                      ? row.st.available
                        ? `✓ ${row.st.size ? formatSize(row.st.size) : 'זמין'}`
                        : '✗ לא נמצא'
                      : 'בודק...'}
                  </span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                id="replace-osm-pmtiles-file"
                name="replaceOsmPmtilesFile"
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
                id="mount-dem-pmtiles-file"
                name="mountDemPmtilesFile"
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

              <input
                id="replace-pois-geojson-file"
                name="replacePoisGeojsonFile"
                ref={poisFileInputRef}
                type="file"
                accept=".geojson,.json"
                onChange={(e) => void handleReplaceLocalDataFile('Israel.pois.geojson', e)}
                className="hidden"
              />
              <button
                disabled={isBusy}
                onClick={() => poisFileInputRef.current?.click()}
                className={`py-2 px-3 rounded-xl border font-semibold flex items-center justify-center gap-1.5 ${t.pillBtn}`}
              >
                <Upload className="w-4 h-4 text-amber-500" />
                <span>החלף Israel.pois.geojson</span>
              </button>

              <input
                id="replace-offroad-pois-geojson-file"
                name="replaceOffroadPoisGeojsonFile"
                ref={offroadFileInputRef}
                type="file"
                accept=".geojson,.json"
                onChange={(e) => void handleReplaceLocalDataFile('Israel.offroad.pois.geojson', e)}
                className="hidden"
              />
              <button
                disabled={isBusy}
                onClick={() => offroadFileInputRef.current?.click()}
                className={`py-2 px-3 rounded-xl border font-semibold flex items-center justify-center gap-1.5 ${t.pillBtn}`}
              >
                <Upload className="w-4 h-4 text-amber-500" />
                <span>החלף Israel.offroad.pois.geojson</span>
              </button>

              <input
                id="replace-search-idx-file"
                name="replaceSearchIdxFile"
                ref={searchIdxFileInputRef}
                type="file"
                accept=".idx"
                onChange={(e) => void handleReplaceLocalDataFile('Israel.search.idx', e)}
                className="hidden"
              />
              <button
                disabled={isBusy}
                onClick={() => searchIdxFileInputRef.current?.click()}
                className={`py-2 px-3 rounded-xl border font-semibold flex items-center justify-center gap-1.5 sm:col-span-2 ${t.pillBtn}`}
              >
                <Upload className="w-4 h-4 text-sky-500" />
                <span>החלף Israel.search.idx מקובץ</span>
              </button>
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                id="persist-osm-opfs"
                name="persistOsmOpfs"
                type="checkbox"
                checked={persistOpfs}
                onChange={(e) => setPersistOpfs(e.target.checked)}
                className="rounded border-slate-500 text-emerald-600"
              />
              <span className={t.muted}>שמור קובץ OSM שהוחלף בזיכרון המקומי (OPFS)</span>
            </label>

            <div className="flex gap-2">
              <input
                id="remote-osm-url"
                name="remoteOsmUrl"
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

            <div className={`p-2.5 rounded-xl border text-xs space-y-1 ${t.panelSolid}`}>
              <div className="font-bold text-amber-500">סנכרון קובצי מפה ונתונים מול Firebase (DevOps):</div>
              <code className="block font-mono text-emerald-500 select-all" dir="ltr">
                devops\upload-map-data.bat
              </code>
              <code className="block font-mono text-sky-400 select-all" dir="ltr">
                devops\download-map-data.bat
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
