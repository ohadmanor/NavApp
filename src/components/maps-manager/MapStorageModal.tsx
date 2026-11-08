import React, { useState, useRef, useEffect } from 'react';
import {
  X,
  HardDrive,
  Lock,
  RefreshCw,
  Upload,
  CheckCircle2,
  FolderOpen,
  Globe,
  FileUp,
  Download,
  Trash2,
  Ban,
  Cloud,
  Terminal,
  AlertCircle,
} from 'lucide-react';
import type { MountedArchiveInfo } from '../../core/pmtiles/PMTilesRegistry';
import { pmtilesRegistry } from '../../core/pmtiles/PMTilesRegistry';
import { OpfsStorageAdapter } from '../../core/pmtiles/OpfsStorageAdapter';
import { CommunityPoiImporter } from '../../core/pois/CommunityPoiImporter';
import { RouteManager } from '../../core/navigation/RouteManager';

interface MapStorageModalProps {
  isOpen: boolean;
  onClose: () => void;
  demInfo: MountedArchiveInfo | null;
  osmInfo: MountedArchiveInfo | null;
  onArchivesUpdated: (dem: MountedArchiveInfo | null, osm: MountedArchiveInfo | null) => void;
  onPoisAndRoutesImported: (poiCount: number, routeCount: number) => void;
}

export const MapStorageModal: React.FC<MapStorageModalProps> = ({
  isOpen,
  onClose,
  demInfo,
  osmInfo,
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
  const [cloudStatus, setCloudStatus] = useState<{
    dem?: { available: boolean; size?: number; url?: string };
    osm?: { available: boolean; size?: number; url?: string };
  }>({});
  const [isCheckingCloud, setIsCheckingCloud] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const osmFileInputRef = useRef<HTMLInputElement>(null);
  const demFileInputRef = useRef<HTMLInputElement>(null);
  const communityFileInputRef = useRef<HTMLInputElement>(null);

  if (!isOpen) return null;

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const ARCHIVE_SIZES = { 'israel-dem': 1402183369, 'israel-osm': 112434955 } as const;
  const ARCHIVE_FILES = {
    'israel-dem': 'Israel.dem.pmtiles',
    'israel-osm': 'Israel.osm.pmtiles',
  } as const;

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
    if (isOpen) {
      checkCloudStatus();
    }
  }, [isOpen]);

  const handleDownloadOffline = async (id: 'israel-dem' | 'israel-osm') => {
    if (downloading) return;
    if (!OpfsStorageAdapter.isSupported()) {
      setStatusMessage('שגיאה: אחסון אופליין (OPFS) אינו נתמך במכשיר / בדפדפן זה.');
      return;
    }
    const needed = ARCHIVE_SIZES[id];
    const est = await OpfsStorageAdapter.getStorageEstimate();
    if (est.quota > 0 && est.quota - est.usage < needed * 1.05) {
      setStatusMessage(
        `אין מספיק מקום אחסון פנוי: נדרש ${formatSize(needed)}, פנוי ${formatSize(
          Math.max(0, est.quota - est.usage)
        )}.`
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setDownloading(id);
    setIsBusy(true);
    setDlProgress({ loaded: 0, total: needed });
    setStatusMessage(`מוריד את ${ARCHIVE_FILES[id]} מ-Firebase לשימוש אופליין...`);
    try {
      const mounted = await pmtilesRegistry.downloadOfflineArchive(
        id,
        (loaded, total) => setDlProgress({ loaded, total: total || needed }),
        controller.signal
      );
      if (id === 'israel-dem') onArchivesUpdated(mounted, osmInfo);
      else onArchivesUpdated(demInfo, mounted);
      setStatusMessage(`✓ ${ARCHIVE_FILES[id]} ירד ונשמר במכשיר – המפה פועלת כעת ללא אינטרנט!`);
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
    if (!window.confirm(`למחוק את העותק המקומי של ${ARCHIVE_FILES[id]}? המפה תחזור לטעינה מהאינטרנט.`)) {
      return;
    }
    await OpfsStorageAdapter.removeFile(ARCHIVE_FILES[id]);
    window.location.reload();
  };

  const isLocalCopy = (info: MountedArchiveInfo | null) =>
    !!info && (info.record.storageKind === 'opfs' || info.record.storageKind === 'user-file');

  const handleReplaceOsmFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsBusy(true);
    setStatusMessage(`מחליף את קובץ המפה הווקטורית (${file.name})...`);
    try {
      const updatedOsm = await pmtilesRegistry.replaceOsmArchive(
        { kind: 'file', file, persistToOpfs: persistOpfs },
        (loaded, total) => {
          if (total > 0) setProgressPct(Math.round((loaded / total) * 100));
        }
      );
      onArchivesUpdated(demInfo, updatedOsm);
      setStatusMessage(
        `✓ קובץ Israel.osm.pmtiles הוחלף בהצלחה! תאריך הפקה: ${updatedOsm.record.createdUtc}`
      );
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
    setStatusMessage(`טוען קובץ DEM מקומי (${file.name}) בקריאת Byte-Range...`);
    try {
      const updatedDem = await pmtilesRegistry.mountFromFile(
        'israel-dem',
        'Israel.dem.pmtiles',
        file,
        true,
        'user-file'
      );
      onArchivesUpdated(updatedDem, osmInfo);
      setStatusMessage(`✓ קובץ Israel.dem.pmtiles חובר בהצלחה מהדיסק המקומי!`);
    } catch (err: any) {
      setStatusMessage(`שגיאה בטעינת DEM: ${err.message}`);
    } finally {
      setIsBusy(false);
    }
  };

  const handleRemoteOsmUpdate = async () => {
    if (!remoteOsmUrl.trim()) return;
    setIsBusy(true);
    setStatusMessage(`מוריד ומחליף את Israel.osm.pmtiles מכתובת מרוחקת...`);
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
      const { importedPois, extractedLineCoordinates } =
        await CommunityPoiImporter.importWaypointsAndRoutesFromFile(file);

      let routesCreated = 0;
      for (let i = 0; i < extractedLineCoordinates.length; i++) {
        await RouteManager.createAndSaveRoute({
          name: `${file.name.replace(/\.[^.]+$/, '')} ${
            extractedLineCoordinates.length > 1 ? `#${i + 1}` : ''
          }`.trim(),
          coordinates: extractedLineCoordinates[i],
          sourceFormat: file.name.endsWith('.kml') ? 'kml' : 'gpx',
          color: '#38bdf8',
        });
        routesCreated++;
      }

      onPoisAndRoutesImported(importedPois.length, routesCreated);
      setStatusMessage(
        `✓ יובאו בהצלחה ${importedPois.length} נקודות עניין ו-${routesCreated} מסלולים מתוך ${file.name}!`
      );
    } catch (err: any) {
      setStatusMessage(`שגיאה בייבוא קובץ: ${err.message}`);
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-y-auto shadow-2xl p-6 text-slate-100 space-y-5">
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/20 text-emerald-400">
              <HardDrive className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">
                ניהול קבצי מפה אופליין (PMTiles) וייבוא נקודות עניין
              </h2>
              <p className="text-xs text-slate-400">
                ארכיטקטורה מפוצלת: קובץ טופוגרפיה קבוע (Israel.dem.pmtiles) + קובץ וקטורי מתעדכן (Israel.osm.pmtiles)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status / Progress Banner */}
        {statusMessage && (
          <div className="p-3.5 rounded-xl bg-slate-800/90 border border-emerald-500/40 text-xs text-emerald-300 space-y-2">
            <div className="flex items-center justify-between">
              <span>{statusMessage}</span>
              {progressPct !== null && <span className="font-mono font-bold">{progressPct}%</span>}
            </div>
            {progressPct !== null && (
              <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* Dual PMTiles Archive Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Card 1: CONSTANT Israel.dem.pmtiles */}
          <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  <Lock className="w-3.5 h-3.5" />
                  קבוע (Constant / Static DEM)
                </span>
                <span className="text-xs font-mono text-slate-400">
                  {demInfo ? formatSize(demInfo.record.sizeBytes) : '1.40 GB'}
                </span>
              </div>
              <h3 className="text-base font-bold text-white font-mono">
                data/Israel.dem.pmtiles
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed" dir="rtl">
                קובץ גבהים וטופוגרפיה (Terrarium 256px PNG DEM, זום 0–14). מפעיל הצללת הרים (Hillshade), תלת-ממד, קווי גובה וחתך גבהים.
              </p>

              {/* Status Box */}
              <div className="text-xs font-mono text-slate-300 bg-slate-900 p-2.5 rounded-lg border border-slate-800 space-y-1" dir="rtl">
                <div className="flex items-center justify-between">
                  <span>מצב מקומי:</span>
                  <span className="text-emerald-400">
                    {demInfo ? `✓ מחובר (${demInfo.record.storageKind})` : 'טוען / לא מחובר'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>מצב ענן (Firebase):</span>
                  {cloudStatus.dem?.available ? (
                    <span className="text-emerald-400">✓ זמין ({formatSize(cloudStatus.dem.size || 1402183369)})</span>
                  ) : (
                    <span className="text-amber-400">ממתין להעלאה</span>
                  )}
                </div>
                {demInfo && (
                  <div>זום: z{demInfo.record.minZoom} – z{demInfo.record.maxZoom} (Terrarium RGB)</div>
                )}
              </div>

              {/* Hard Safety Interlock Note */}
              <div className="text-[11px] text-emerald-300/90 bg-emerald-950/40 border border-emerald-500/30 rounded-lg p-2 flex items-center gap-2" dir="rtl">
                <Lock className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>קובץ זה מוגן באופן מוחלט: פריסות קוד (deploy-firebase.bat) לעולם אינן נוגעות בו או מוחקות אותו!</span>
              </div>
            </div>

            <div className="pt-2">
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
                className="w-full py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center justify-center gap-2 transition-colors"
              >
                <FolderOpen className="w-4 h-4 text-amber-400" />
                <span>בחר קובץ Israel.dem.pmtiles מהמכשיר / כרטיס זיכרון</span>
              </button>
            </div>
          </div>

          {/* Card 2: UPDATABLE Israel.osm.pmtiles */}
          <div className="p-4 rounded-xl bg-slate-950/80 border border-emerald-500/40 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  <RefreshCw className="w-3.5 h-3.5" />
                  מתעדכן (Updatable Vector Map)
                </span>
                <span className="text-xs font-mono text-slate-400">
                  {osmInfo ? formatSize(osmInfo.record.sizeBytes) : '112.4 MB'}
                </span>
              </div>
              <h3 className="text-base font-bold text-white font-mono">
                data/Israel.osm.pmtiles
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed" dir="rtl">
                מפת OpenStreetMap וקטורית (19 שכבות: שבילים, דרכי 4x4, שמורות טבע, שטחי אש, נחלים, פסגות ויישובים). מתעדכנת מעת לעת מבלי לגעת בקובץ ה-DEM.
              </p>

              {/* Status Box */}
              <div className="text-xs font-mono text-slate-300 bg-slate-900 p-2.5 rounded-lg border border-slate-800 space-y-1" dir="rtl">
                <div className="flex items-center justify-between">
                  <span>מצב מקומי:</span>
                  <span className="text-emerald-400">
                    {osmInfo ? `✓ מחובר (${osmInfo.record.storageKind})` : 'טוען / לא מחובר'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>מצב ענן (Firebase):</span>
                  {cloudStatus.osm?.available ? (
                    <span className="text-emerald-400">✓ זמין ({formatSize(cloudStatus.osm.size || 112434955)})</span>
                  ) : (
                    <span className="text-amber-400">ממתין להעלאה</span>
                  )}
                </div>
                {osmInfo && (
                  <div>תאריך בנייה: <span className="text-sky-300">{osmInfo.record.createdUtc.slice(0, 19)}</span></div>
                )}
              </div>

              {/* Section 1: Fast Client Streaming */}
              <div className="text-xs bg-slate-900/90 p-2.5 rounded-lg border border-sky-500/30 space-y-1.5" dir="rtl">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sky-300 flex items-center gap-1.5">
                    <Cloud className="w-3.5 h-3.5" />
                    חלק 1: טעינה מהירה מ-Firebase ללקוחות חדשים
                  </span>
                  <button
                    onClick={checkCloudStatus}
                    disabled={isCheckingCloud}
                    className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 px-2 py-0.5 rounded bg-sky-950/60 border border-sky-500/40"
                  >
                    <RefreshCw className={`w-3 h-3 ${isCheckingCloud ? 'animate-spin' : ''}`} />
                    <span>{isCheckingCloud ? 'בודק...' : 'בדוק ענן'}</span>
                  </button>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  כל לקוח שנכנס ללא מטמון מקומי מזרים מקטעי בתים (Byte-Ranges) ישירות מ-Firebase תוך מילישניות, ללא צורך בהורדת 112MB מראש. מקטעים שנצפו נשמרים במטמון.
                </p>
              </div>

              {/* Section 2: Cloud & Local OSM Update */}
              <div className="text-xs bg-slate-900/90 p-2.5 rounded-lg border border-emerald-500/30 space-y-2" dir="rtl">
                <span className="font-semibold text-emerald-300 flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5" />
                  חלק 2: עדכון קובץ OSM חדש
                </span>

                {/* Sub-section A: Cloud Update for all users */}
                <div className="text-[11px] text-slate-300 bg-slate-950 p-2 rounded-lg border border-slate-700/60 space-y-1">
                  <div className="font-semibold text-amber-300 flex items-center gap-1">
                    <Terminal className="w-3.5 h-3.5 text-amber-400" />
                    <span>עדכון ענן (עבור כל המשתמשים):</span>
                  </div>
                  <p className="text-slate-400">
                    העתק את קובץ <code>Israel.osm.pmtiles</code> החדש לתיקיית <code>data\</code> והרץ במחשב:
                  </p>
                  <code className="block text-emerald-400 font-mono text-center bg-slate-900 py-1 rounded border border-slate-800 select-all">
                    devops\upload-map-data.bat
                  </code>
                  <p className="text-slate-500 text-[10px]">
                    הסקריפט מעלה את הנתונים לענן הייעודי navapp-israel-topo-data ללא מחיקת ה-DEM.
                  </p>
                </div>

                {/* Sub-section B: Local Update / Test on this device */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[11px] font-semibold text-slate-300 block">
                    בדיקה / החלפה מקומית במכשיר זה (OPFS):
                  </span>
                  <label className="flex items-center gap-2 text-[11px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={persistOpfs}
                      onChange={(e) => setPersistOpfs(e.target.checked)}
                      className="rounded border-slate-700 text-emerald-500"
                    />
                    <span>שמור קובץ מעודכן בזיכרון הדפדפן המתמיד (OPFS Offline)</span>
                  </label>

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
                    className="w-full py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center justify-center gap-2 transition-colors"
                  >
                    <Upload className="w-4 h-4" />
                    <span>בחר קובץ והחלף מקומית במכשיר זה</span>
                  </button>

                  <div className="flex gap-1.5 pt-0.5">
                    <input
                      type="url"
                      value={remoteOsmUrl}
                      onChange={(e) => setRemoteOsmUrl(e.target.value)}
                      placeholder="https://.../Israel.osm.pmtiles"
                      className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-100"
                    />
                    <button
                      disabled={isBusy || !remoteOsmUrl.trim()}
                      onClick={handleRemoteOsmUpdate}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-xs font-semibold text-sky-300 flex items-center gap-1"
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>עדכן מ-URL</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Offline Download Card */}
        <div className="p-4 rounded-xl bg-slate-950/90 border border-amber-500/40 space-y-3">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-amber-400" />
            <h4 className="text-sm font-bold text-white" dir="rtl">
              הורדת מפות לשימוש אופליין (מ-Firebase למכשיר)
            </h4>
          </div>
          <p className="text-xs text-slate-400" dir="rtl">
            ההורדה מתבצעת לפי בקשה בלבד ונשמרת באחסון הקבוע של המכשיר. מומלץ להוריד ב-Wi-Fi.
            לאחר ההורדה המפה פועלת ללא חיבור לאינטרנט.
          </p>

          {(['israel-osm', 'israel-dem'] as const).map((id) => {
            const info = id === 'israel-dem' ? demInfo : osmInfo;
            const local = isLocalCopy(info);
            const active = downloading === id;
            const pct =
              active && dlProgress && dlProgress.total > 0
                ? Math.min(100, Math.round((dlProgress.loaded / dlProgress.total) * 100))
                : 0;
            return (
              <div
                key={id}
                className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-mono text-slate-200">
                    {ARCHIVE_FILES[id]}{' '}
                    <span className="text-slate-500">({formatSize(ARCHIVE_SIZES[id])})</span>
                  </div>
                  <span
                    className={`text-xs font-semibold ${
                      local ? 'text-emerald-400' : info ? 'text-amber-300' : 'text-slate-400'
                    }`}
                  >
                    {local ? '✓ שמור במכשיר (אופליין)' : info ? 'מקוון בלבד' : 'לא מחובר (מפה מקוונת פעילה)'}
                  </span>
                </div>

                {active && dlProgress && (
                  <div className="space-y-1">
                    <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="text-xs font-mono text-slate-400 flex justify-between">
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
                      className="flex-1 py-2 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold text-white flex items-center justify-center gap-2"
                    >
                      <Ban className="w-4 h-4" />
                      <span>בטל הורדה</span>
                    </button>
                  ) : (
                    <button
                      disabled={isBusy || !demInfo || !osmInfo}
                      onClick={() => handleDownloadOffline(id)}
                      className="flex-1 py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-2"
                    >
                      <Download className="w-4 h-4" />
                      <span>{local ? 'הורד מחדש / עדכן' : 'הורד לשימוש אופליין'}</span>
                    </button>
                  )}
                  {local && !active && (
                    <button
                      disabled={isBusy}
                      onClick={() => handleRemoveOffline(id)}
                      className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-red-300 flex items-center gap-1"
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

        {/* Community Importer Card (Amud Anan / Off-Road / Israel Hiking) */}
        <div className="p-4 rounded-xl bg-slate-950/90 border border-sky-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-sky-400" />
              <h4 className="text-sm font-bold text-white">
                ייבוא נקודות עניין ומסלולים (עמוד ענן / Off-Road / Israel Hiking Map)
              </h4>
            </div>
            <p className="text-xs text-slate-400" dir="rtl">
              תומך בקבצי <code>.gpx</code>, <code>.kml</code>, <code>.geojson</code> ו-<code>.twl</code>. כל הנקודות והמסלולים נשמרים ב-IndexedDB לעבודה מלאה ללא אינטרנט.
            </p>
          </div>
          <div>
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
              className="px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-xs font-semibold text-white flex items-center gap-2 shrink-0 transition-colors"
            >
              <FileUp className="w-4 h-4" />
              <span>ייבא קובץ GPX / KML / TWL</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

