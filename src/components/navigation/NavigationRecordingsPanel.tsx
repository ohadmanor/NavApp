import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  Check,
  ChevronDown,
  Clock,
  Compass,
  Copy,
  Download,
  FileUp,
  FolderTree,
  Lock,
  MapPin,
  Navigation,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Search,
  Share2,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { PoiRecord, SavedRouteRecord } from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import { GpxExportService } from '../../core/navigation/GpxExportService';
import {
  ROUTE_COLOR_PALETTE,
  isRecordedRoute,
  resolveRouteDisplayColor,
} from '../../core/navigation/RouteManager';
import type { RouteMapDisplayMode } from '../../core/navigation/RouteDisplayPolicy';
import { computeRoutePointsAlongTrack } from '../../core/navigation/routeTelemetryHelpers';
import { PoiCategoryIcon } from '../pois/PoiCategoryIcon';
import { ElevationChart } from './ElevationChart';
import { formatDuration } from './TrackRecorderPanel';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

type OwnershipTab = 'mine' | 'shared';
type RecordingSortKey = 'newest' | 'name' | 'distance' | 'duration' | 'ascent';

interface NavigationRecordingsPanelProps {
  theme: MapTheme;
  currentUser: NavUser | null;
  isAuthBusy?: boolean;
  onSignInGoogle?: () => void;
  routes: SavedRouteRecord[];
  selectedRoute: SavedRouteRecord | null;
  pois?: PoiRecord[];
  routeDisplayMode?: RouteMapDisplayMode;
  backgroundRouteIds?: string[];
  unseenSharedCount?: number;
  onSelectRoute: (route: SavedRouteRecord | null) => void;
  onStartNavigation?: (route: SavedRouteRecord) => void;
  onDeleteRoute: (routeId: string) => void | Promise<void>;
  onShareRoute: (route: SavedRouteRecord) => void;
  onViewSharedTab?: () => void;
  onDuplicateSharedRoute: (route: SavedRouteRecord) => void | Promise<void>;
  onDismissSharedRoute: (routeId: string) => void | Promise<void>;
  onRenameRoute: (routeId: string, nextName: string) => void | Promise<void>;
  onUpdateNotes?: (routeId: string, notes: string) => void | Promise<void>;
  onChangeRouteColor?: (routeId: string, color: string) => void | Promise<void>;
  onToggleBackgroundRoute?: (routeId: string) => void;
  onReverseRoute?: (routeId: string) => void | Promise<void>;
  onUseForMapEdit?: (route: SavedRouteRecord, subMode: 'add-road' | 'edit-road') => void;
  onSendToPlanningDb?: (route: SavedRouteRecord) => void;
  onImportRecordingFile?: (file: File) => void | Promise<void>;
  onFlyToRoute: (route: SavedRouteRecord) => void;
  onHoverPoint: (pt: { lon: number; lat: number; ele: number; distKm: number } | null) => void;
  onSelectPoint?: (pt: { lon: number; lat: number; ele: number; distKm: number }) => void;
  onNotify?: (message: string) => void;
  onClose: () => void;
  hideCloseButton?: boolean;
}

function formatDateTimeHe(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('he-IL', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const NavigationRecordingsPanel: React.FC<NavigationRecordingsPanelProps> = ({
  theme,
  currentUser,
  isAuthBusy = false,
  onSignInGoogle,
  routes,
  selectedRoute,
  pois = [],
  routeDisplayMode,
  backgroundRouteIds = [],
  unseenSharedCount = 0,
  onSelectRoute,
  onStartNavigation,
  onDeleteRoute,
  onShareRoute,
  onViewSharedTab,
  onDuplicateSharedRoute,
  onDismissSharedRoute,
  onRenameRoute,
  onUpdateNotes,
  onChangeRouteColor,
  onToggleBackgroundRoute,
  onReverseRoute,
  onUseForMapEdit,
  onSendToPlanningDb,
  onImportRecordingFile,
  onFlyToRoute,
  onHoverPoint,
  onSelectPoint,
  onNotify,
  onClose,
  hideCloseButton = false,
}) => {
  const t = getSurfaceTheme(theme);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const recordingRoutes = useMemo(
    () =>
      routes.filter(
        (r) =>
          isRecordedRoute(r) &&
          Boolean(currentUser?.uid) &&
          (r.ownership === 'shared'
            ? !r.sharedForUid || r.sharedForUid === currentUser?.uid
            : r.ownerUid === currentUser?.uid)
      ),
    [routes, currentUser?.uid]
  );

  const activeRecording = useMemo(
    () =>
      selectedRoute && isRecordedRoute(selectedRoute)
        ? recordingRoutes.find((r) => r.id === selectedRoute.id) || selectedRoute
        : null,
    [selectedRoute, recordingRoutes]
  );

  const [ownershipTab, setOwnershipTab] = useState<OwnershipTab>(() =>
    activeRecording?.ownership === 'shared' ? 'shared' : 'mine'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<RecordingSortKey>('newest');
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);
  const [isPointsMenuOpen, setIsPointsMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isEditingNotes, setIsEditingNotes] = useState(false);
  const [notesDraft, setNotesDraft] = useState('');
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const prevRouteIdRef = useRef<string | undefined>(activeRecording?.id);
  const justSwitchedRoute = prevRouteIdRef.current !== activeRecording?.id;
  if (justSwitchedRoute) {
    prevRouteIdRef.current = activeRecording?.id;
  }

  useEffect(() => {
    setHoveredIdx(null);
    setPinnedIdx(null);
    setIsRenaming(false);
    setIsEditingNotes(false);
    setIsColorPickerOpen(false);
    if (activeRecording?.ownership === 'shared') {
      setOwnershipTab('shared');
    } else if (activeRecording) {
      setOwnershipTab('mine');
    }
  }, [activeRecording?.id, activeRecording?.ownership]);

  const { mineRecordings, sharedRecordings } = useMemo(() => {
    const mine: SavedRouteRecord[] = [];
    const shared: SavedRouteRecord[] = [];
    for (const r of recordingRoutes) {
      if (r.ownership === 'shared') shared.push(r);
      else mine.push(r);
    }
    return { mineRecordings: mine, sharedRecordings: shared };
  }, [recordingRoutes]);

  const tabRecordings = ownershipTab === 'shared' ? sharedRecordings : mineRecordings;

  const filteredRecordings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = tabRecordings.filter((r) => {
      if (!q) return true;
      const nameHit = (r.name || '').toLowerCase().includes(q);
      const notesHit = (r.recordingMeta?.notes || '').toLowerCase().includes(q);
      const senderHit =
        (r.sharedByName || '').toLowerCase().includes(q) ||
        (r.sharedByEmail || '').toLowerCase().includes(q);
      return nameHit || notesHit || senderHit;
    });

    const sorted = [...matched];
    sorted.sort((a, b) => {
      if (sortKey === 'name') {
        return (a.name || '').localeCompare(b.name || '', 'he');
      }
      if (sortKey === 'distance') {
        return (b.distanceKm || 0) - (a.distanceKm || 0);
      }
      if (sortKey === 'ascent') {
        return (b.ascentMeters || 0) - (a.ascentMeters || 0);
      }
      if (sortKey === 'duration') {
        return (b.recordingMeta?.durationSeconds || 0) - (a.recordingMeta?.durationSeconds || 0);
      }
      const bTs = Date.parse(b.recordingMeta?.startedAt || b.createdAt || b.updatedAt || '') || 0;
      const aTs = Date.parse(a.recordingMeta?.startedAt || a.createdAt || a.updatedAt || '') || 0;
      return bTs - aTs;
    });
    return sorted;
  }, [tabRecordings, searchQuery, sortKey]);

  const routePoints = useMemo(
    () => computeRoutePointsAlongTrack(activeRecording, pois),
    [activeRecording, pois]
  );

  if (!currentUser) {
    return (
      <div dir="rtl" className="p-4 space-y-3 text-center">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-right">
            <Activity className="w-4 h-4 text-rose-500 shrink-0" />
            <h3 className="text-sm font-bold">הקלטות ניווט</h3>
          </div>
          {!hideCloseButton && (
            <button onClick={onClose} className={`p-1.5 rounded-lg border ${t.pillBtn}`} title="סגור">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className={`p-4 rounded-xl border space-y-2.5 ${t.subCard}`}>
          <div className="mx-auto w-10 h-10 rounded-full bg-rose-500/15 text-rose-500 flex items-center justify-center">
            <Lock className="w-5 h-5" />
          </div>
          <div className="text-xs font-bold">הקלטות הניווט נשמרות לפי משתמש מחובר בלבד</div>
          <p className={`text-xs ${t.muted}`}>
            התחבר עם חשבון Google כדי לצפות בהקלטות הניווט שלך, לשתף עם משתמשים אחרים, לעדכן את המפה או לייצא לקובץ GPX.
          </p>
          {onSignInGoogle && (
            <button
              type="button"
              disabled={isAuthBusy}
              onClick={onSignInGoogle}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold"
            >
              התחבר עם Google
            </button>
          )}
        </div>
      </div>
    );
  }

  const isSharedRecording = activeRecording?.ownership === 'shared';
  const activeColor = resolveRouteDisplayColor(activeRecording);

  const handleExportGpx = async (rec: SavedRouteRecord) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const result = await GpxExportService.exportAndSaveRouteGpx(rec);
      onNotify?.(`קובץ GPX נשמר: ${result.locationLabelHe}`);
    } catch (err: any) {
      onNotify?.(err?.message || 'שגיאה בייצוא קובץ GPX');
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !onImportRecordingFile) return;
    setIsImporting(true);
    try {
      await onImportRecordingFile(file);
    } finally {
      setIsImporting(false);
    }
  };

  const handleCommitRename = () => {
    if (!activeRecording || isSharedRecording) {
      setIsRenaming(false);
      return;
    }
    const next = renameDraft.trim();
    setIsRenaming(false);
    if (next && next !== activeRecording.name) {
      void onRenameRoute(activeRecording.id, next);
    }
  };

  const handleCommitNotes = () => {
    if (!activeRecording || isSharedRecording || !onUpdateNotes) {
      setIsEditingNotes(false);
      return;
    }
    setIsEditingNotes(false);
    void onUpdateNotes(activeRecording.id, notesDraft.trim());
  };

  return (
    <div dir="rtl" className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <Activity className="w-4 h-4 text-rose-500 shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-rose-500 block">
              הקלטות ניווט • תחקור ועדכון מפה
            </span>
            {activeRecording && isRenaming && !isSharedRecording ? (
              <div className="flex items-center gap-1.5 mt-1">
                <input
                  id="recording-rename-input"
                  name="recordingRename"
                  type="text"
                  dir="auto"
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitRename();
                    if (e.key === 'Escape') setIsRenaming(false);
                  }}
                  className={`flex-1 min-w-0 rounded-lg border px-2.5 py-1 text-xs font-bold focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
                />
                <button
                  type="button"
                  onClick={handleCommitRename}
                  className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                  title="שמור שם"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsRenaming(false)}
                  className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
                  title="ביטול"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <h4 className="text-sm font-bold truncate" dir="auto">
                  {activeRecording
                    ? activeRecording.name
                    : `הקלטות ניווט (${recordingRoutes.length})`}
                </h4>
                {activeRecording && !isSharedRecording && (
                  <button
                    type="button"
                    onClick={() => {
                      setRenameDraft(activeRecording.name);
                      setIsRenaming(true);
                    }}
                    className={`p-1 rounded-md opacity-70 hover:opacity-100 shrink-0 ${t.hoverRow}`}
                    title="שנה שם הקלטה"
                    aria-label="שנה שם הקלטה"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onImportRecordingFile && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".gpx,.kml,.geojson,.json,.twl"
                onChange={(e) => void handleFileChange(e)}
                className="hidden"
              />
              <button
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 rounded-xl border border-sky-500/50 bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 text-xs font-bold flex items-center gap-1 shrink-0"
                title="טען קובץ GPX שמור למאגר ההקלטות"
              >
                <FileUp className="w-3.5 h-3.5" />
                <span>{isImporting ? 'טוען...' : 'טען GPX'}</span>
              </button>
            </>
          )}
          {!hideCloseButton && (
            <button
              type="button"
              onClick={() => {
                setHoveredIdx(null);
                setPinnedIdx(null);
                onHoverPoint(null);
                onClose();
              }}
              className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
              title="סגור"
              aria-label="סגור"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Ownership Tabs */}
      <div
        role="tablist"
        aria-label="סיווג הקלטות ניווט"
        className={`grid grid-cols-2 gap-1 p-1 rounded-xl border ${t.subCard}`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={ownershipTab === 'mine'}
          onClick={() => setOwnershipTab('mine')}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
            ownershipTab === 'mine'
              ? 'bg-rose-600 text-white shadow-sm'
              : `${t.muted} hover:bg-black/5`
          }`}
        >
          <Activity className="w-3.5 h-3.5 shrink-0" />
          <span>ההקלטות שלי ({mineRecordings.length})</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={ownershipTab === 'shared'}
          onClick={() => {
            setOwnershipTab('shared');
            onViewSharedTab?.();
          }}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
            ownershipTab === 'shared'
              ? 'bg-violet-600 text-white shadow-sm'
              : `${t.muted} hover:bg-black/5`
          }`}
        >
          <Users className="w-3.5 h-3.5 shrink-0" />
          <span>שותפו איתי ({sharedRecordings.length})</span>
          {unseenSharedCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold leading-none">
              +{unseenSharedCount}
            </span>
          )}
        </button>
      </div>

      {/* Recordings List */}
      {tabRecordings.length === 0 ? (
        <div className={`p-4 rounded-xl border border-dashed text-center space-y-2 ${t.subCard}`}>
          <Activity className="w-6 h-6 text-rose-500 mx-auto" />
          <div className="text-xs font-bold">
            {ownershipTab === 'shared'
              ? 'לא שותפו איתך הקלטות ניווט עדיין'
              : 'אין לך עדיין הקלטות ניווט שמורות'}
          </div>
          <p className={`text-[11px] ${t.muted}`}>
            {ownershipTab === 'shared'
              ? 'כאשר משתמש אחר ישתף איתך הקלטת ניווט באפליקציה, היא תופיע כאן.'
              : 'בזמן ניווט פעיל, לחץ על כפתור ההקלטה (●) כדי לתעד את התוואי. בסיום ההקלטה או הניווט תתבקש לתת שם ולשמור כאן.'}
          </p>
        </div>
      ) : (
        <div className={`rounded-xl border shadow-sm overflow-hidden ${t.panelSolid}`}>
          <div className={`p-2 flex items-center gap-1.5 border-b ${t.divider}`}>
            <div className={`flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${t.fieldBox}`}>
              <Search className={`w-3.5 h-3.5 shrink-0 ${t.muted}`} />
              <input
                id="recordings-search"
                name="recordingsSearch"
                type="text"
                dir="auto"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="חיפוש הקלטה לפי שם או הערה..."
                className="w-full min-w-0 bg-transparent text-xs focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className={`p-0.5 rounded hover:bg-black/10 ${t.muted}`}
                  aria-label="נקה חיפוש"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            <select
              id="recordings-sort"
              name="recordingsSort"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as RecordingSortKey)}
              aria-label="מיון הקלטות"
              className={`px-2 py-1.5 rounded-lg border text-[11px] font-semibold focus:outline-none ${t.fieldBox}`}
            >
              <option value="newest">חדש לישן</option>
              <option value="name">שם</option>
              <option value="distance">מרחק</option>
              <option value="duration">משך זמן</option>
              <option value="ascent">טיפוס</option>
            </select>
          </div>

          <div className={`${activeRecording ? 'max-h-40' : 'max-h-64'} overflow-y-auto divide-y ${t.divider}`}>
            {filteredRecordings.length === 0 ? (
              <div className={`px-3 py-4 text-center text-xs ${t.muted}`}>
                לא נמצאו הקלטות תואמות לחיפוש.
              </div>
            ) : (
              filteredRecordings.map((r) => {
                const isSelected = activeRecording?.id === r.id;
                const isPinnedBg = backgroundRouteIds.includes(r.id);
                const whenStr = formatDateTimeHe(r.recordingMeta?.startedAt || r.createdAt);
                const durSec = r.recordingMeta?.durationSeconds;
                const senderLabel = r.sharedByName || r.sharedByEmail;

                return (
                  <div
                    key={r.id}
                    className={`w-full px-2 py-1.5 text-xs flex items-center justify-between gap-1 transition-colors ${
                      isSelected ? 'bg-rose-500/15 font-bold' : t.hoverRow
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setPinnedIdx(null);
                        setHoveredIdx(null);
                        setIsPointsMenuOpen(false);
                        onSelectRoute(r);
                      }}
                      className="flex-1 min-w-0 text-right px-1.5 py-1 flex items-center gap-2"
                    >
                      <span
                        className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          isPinnedBg ? 'ring-2 ring-sky-500/70' : ''
                        }`}
                        style={{ backgroundColor: resolveRouteDisplayColor(r) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-bold break-words" dir="auto">
                          {r.name}
                        </div>
                        <div className={`font-mono text-[11px] ${t.muted}`}>
                          <span dir="ltr">
                            {r.distanceKm} km • +{r.ascentMeters}m
                            {typeof durSec === 'number' && durSec > 0 ? ` • ${formatDuration(durSec)}` : ''}
                          </span>
                          {whenStr ? ` • ${whenStr}` : ''}
                          {r.ownership === 'shared' && senderLabel
                            ? ` • שותף ע״י ${senderLabel}`
                            : r.cloudSyncStatus === 'synced'
                              ? ' • ☁️ בענן'
                              : r.cloudSyncStatus === 'pending'
                                ? ' • ⏳ ממתין'
                                : ''}
                        </div>
                      </div>
                    </button>

                    <div className="flex items-center gap-1 shrink-0">
                      {onToggleBackgroundRoute && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleBackgroundRoute(r.id);
                          }}
                          className={`p-1.5 rounded-lg ${
                            isPinnedBg ? 'text-sky-500 bg-sky-500/10' : t.muted
                          } hover:bg-black/10`}
                          title={isPinnedBg ? 'הסר נעיצה מהמפה' : 'נעץ במפה'}
                        >
                          {isPinnedBg ? (
                            <PinOff className="w-3.5 h-3.5" />
                          ) : (
                            <Pin className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      {isSelected && <Check className="w-4 h-4 text-rose-500 shrink-0" />}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Selected Recording Debriefing & Actions */}
      {activeRecording && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span
              className={`px-2.5 py-1 rounded-full border font-semibold ${
                routeDisplayMode === 'navigating'
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-500'
              }`}
            >
              {backgroundRouteIds.includes(activeRecording.id)
                ? 'נעוץ במפה (יישאר גלוי גם בעריכת מפה)'
                : 'מוצג במפה כעת'}
            </span>
            {activeRecording.recordingMeta?.startedAt && (
              <span className={`px-2.5 py-1 rounded-full border inline-flex items-center gap-1 ${t.subCard} ${t.muted}`}>
                <Clock className="w-3 h-3" />
                <span>{formatDateTimeHe(activeRecording.recordingMeta.startedAt)}</span>
              </span>
            )}
          </div>

          <div className={`grid grid-cols-4 gap-2 text-xs p-2.5 rounded-xl border ${t.subCard}`}>
            <div>
              <span className={`block ${t.muted}`}>מרחק</span>
              <span dir="ltr" className="font-mono font-bold inline-block">
                {activeRecording.distanceKm} km
              </span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>
                {activeRecording.recordingMeta?.durationSeconds ? 'משך / מהירות' : 'טיפוס'}
              </span>
              <span dir="ltr" className="font-mono font-bold text-sky-500 inline-block">
                {activeRecording.recordingMeta?.durationSeconds
                  ? `${formatDuration(activeRecording.recordingMeta.durationSeconds)}${
                      activeRecording.recordingMeta.avgSpeedKmh
                        ? ` (${activeRecording.recordingMeta.avgSpeedKmh} km/h)`
                        : ''
                    }`
                  : `+${activeRecording.ascentMeters}m`}
              </span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>טיפוס / ירידה</span>
              <span dir="ltr" className="font-mono font-bold text-emerald-500 inline-block">
                +{activeRecording.ascentMeters} / -{activeRecording.descentMeters}m
              </span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>טווח גובה</span>
              <span dir="ltr" className="font-mono inline-block">
                {activeRecording.minEle}–{activeRecording.maxEle}m
              </span>
            </div>
          </div>

          {/* Debriefing Notes */}
          {!isSharedRecording && (
            <div className={`p-2.5 rounded-xl border text-xs space-y-1.5 ${t.subCard}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`font-bold ${t.muted}`}>הערות תחקור ועדכון מפה</span>
                {onUpdateNotes && !isEditingNotes && (
                  <button
                    type="button"
                    onClick={() => {
                      setNotesDraft(activeRecording.recordingMeta?.notes || '');
                      setIsEditingNotes(true);
                    }}
                    className="text-sky-500 font-semibold hover:underline inline-flex items-center gap-1"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>{activeRecording.recordingMeta?.notes ? 'ערוך הערה' : 'הוסף הערה'}</span>
                  </button>
                )}
              </div>
              {isEditingNotes ? (
                <div className="space-y-1.5">
                  <textarea
                    rows={2}
                    dir="auto"
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    placeholder="פרטי תחקור, חסימות, שבילים לעדכון..."
                    className={`w-full rounded-lg border px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
                  />
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setIsEditingNotes(false)}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold ${t.pillBtn}`}
                    >
                      ביטול
                    </button>
                    <button
                      type="button"
                      onClick={handleCommitNotes}
                      className="px-2.5 py-1 rounded-lg bg-emerald-600 text-white text-[11px] font-bold"
                    >
                      שמור הערה
                    </button>
                  </div>
                </div>
              ) : (
                <p className={activeRecording.recordingMeta?.notes ? '' : t.muted} dir="auto">
                  {activeRecording.recordingMeta?.notes || 'אין הערות תחקור עדיין.'}
                </p>
              )}
            </div>
          )}

          {/* Action Strip */}
          {isSharedRecording ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void onDuplicateSharedRoute(activeRecording)}
                className="px-3 py-1.5 rounded-xl border border-emerald-500/50 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 text-xs font-bold flex items-center gap-1.5"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>שמור עותק אצלי</span>
              </button>
              {onToggleBackgroundRoute && (
                <button
                  type="button"
                  onClick={() => onToggleBackgroundRoute(activeRecording.id)}
                  className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${
                    backgroundRouteIds.includes(activeRecording.id)
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-500'
                      : t.pillBtn
                  }`}
                >
                  {backgroundRouteIds.includes(activeRecording.id) ? (
                    <PinOff className="w-3.5 h-3.5" />
                  ) : (
                    <Pin className="w-3.5 h-3.5 text-sky-500" />
                  )}
                  <span>
                    {backgroundRouteIds.includes(activeRecording.id) ? 'הסר מרקע' : 'השאר במפה'}
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => void onDismissSharedRoute(activeRecording.id)}
                className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1 text-red-400 ${t.pillBtn}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>הסר מהרשימה</span>
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onShareRoute(activeRecording)}
                  className="px-2.5 py-1.5 rounded-xl border border-indigo-500/50 bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 text-xs font-bold flex items-center gap-1.5"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  <span>
                    {(activeRecording.sharedWith?.length || 0) > 0
                      ? `שתף (${activeRecording.sharedWith!.length})`
                      : 'שתף באפליקציה'}
                  </span>
                </button>

                {onUseForMapEdit && (
                  <button
                    type="button"
                    onClick={() => onUseForMapEdit(activeRecording, 'add-road')}
                    className="px-2.5 py-1.5 rounded-xl border border-amber-500/50 bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 text-xs font-bold flex items-center gap-1.5"
                    title="נעץ את ההקלטה על המפה ופתח עריכת שבילים / דרכים מעליה"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>עדכן מפה מההקלטה</span>
                  </button>
                )}

                {onToggleBackgroundRoute && (
                  <button
                    type="button"
                    onClick={() => onToggleBackgroundRoute(activeRecording.id)}
                    className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${
                      backgroundRouteIds.includes(activeRecording.id)
                        ? 'border-sky-500/60 bg-sky-500/10 text-sky-500'
                        : t.pillBtn
                    }`}
                  >
                    {backgroundRouteIds.includes(activeRecording.id) ? (
                      <PinOff className="w-3.5 h-3.5" />
                    ) : (
                      <Pin className="w-3.5 h-3.5 text-sky-500" />
                    )}
                    <span>
                      {backgroundRouteIds.includes(activeRecording.id) ? 'הסר מרקע' : 'השאר במפה'}
                    </span>
                  </button>
                )}

                {onChangeRouteColor && (
                  <button
                    type="button"
                    onClick={() => setIsColorPickerOpen((v) => !v)}
                    className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${t.pillBtn}`}
                  >
                    <Palette className="w-3.5 h-3.5" style={{ color: activeColor }} />
                    <span>צבע</span>
                  </button>
                )}

                {onReverseRoute && (
                  <button
                    type="button"
                    onClick={() => void onReverseRoute(activeRecording.id)}
                    className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${t.pillBtn}`}
                  >
                    <ArrowLeftRight className="w-3.5 h-3.5 text-sky-500" />
                    <span>הפוך כיוון</span>
                  </button>
                )}
              </div>

              {isColorPickerOpen && onChangeRouteColor && (
                <div className={`p-2 rounded-xl border flex items-center justify-between gap-2 ${t.subCard}`}>
                  <span className={`text-xs font-semibold ${t.muted}`}>צבע במפה:</span>
                  <div className="flex items-center gap-1.5">
                    {ROUTE_COLOR_PALETTE.map((hex) => {
                      const selected = activeColor.toLowerCase() === hex.toLowerCase();
                      return (
                        <button
                          key={hex}
                          type="button"
                          onClick={() => {
                            void onChangeRouteColor(activeRecording.id, hex);
                            setIsColorPickerOpen(false);
                          }}
                          className={`w-6 h-6 rounded-full flex items-center justify-center border-2 ${
                            selected ? 'border-white ring-2 ring-rose-500' : 'border-white/40'
                          }`}
                          style={{ backgroundColor: hex }}
                          aria-label={`בחר צבע ${hex}`}
                        >
                          {selected && <Check className="w-3 h-3 text-white stroke-[3]" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Waypoints / Nearby POIs */}
          {routePoints.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setIsPointsMenuOpen(!isPointsMenuOpen)}
                aria-expanded={isPointsMenuOpen}
                className={`w-full px-3 py-2 rounded-xl border text-xs flex items-center justify-between gap-2 ${t.subCard}`}
              >
                <span className="flex items-center gap-1.5 font-semibold">
                  <MapPin className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                  <span>נקודות לאורך ההקלטה ({routePoints.length})</span>
                </span>
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${isPointsMenuOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isPointsMenuOpen && (
                <div className={`mt-1.5 rounded-xl border shadow-lg max-h-44 overflow-y-auto divide-y ${t.panelSolid} ${t.divider}`}>
                  {routePoints.map((ptOpt) => (
                    <button
                      key={ptOpt.id}
                      type="button"
                      onClick={() => {
                        setIsPointsMenuOpen(false);
                        onHoverPoint(ptOpt);
                        onSelectPoint?.(ptOpt);
                      }}
                      className={`w-full px-3 py-2 text-right text-xs flex items-center justify-between gap-2 ${t.hoverRow}`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {ptOpt.poiCategory ? (
                          <PoiCategoryIcon
                            category={ptOpt.poiCategory}
                            subcategory={ptOpt.subcategory}
                            size={16}
                          />
                        ) : (
                          <span>{ptOpt.emoji}</span>
                        )}
                        <span className="font-semibold truncate">{ptOpt.label}</span>
                      </span>
                      <span dir="ltr" className={`font-mono shrink-0 ${t.muted}`}>
                        {ptOpt.distKm} km • {ptOpt.ele}m
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <ElevationChart
            route={activeRecording}
            strokeColor={activeColor}
            routePoints={routePoints}
            theme={theme}
            hoveredIdx={hoveredIdx}
            pinnedIdx={pinnedIdx}
            justSwitchedRoute={justSwitchedRoute}
            onHoverIdxChange={setHoveredIdx}
            onPinnedIdxChange={setPinnedIdx}
            onHoverPoint={onHoverPoint}
          />

          {/* Primary Footer Actions */}
          <div className="flex flex-wrap gap-2">
            {onStartNavigation && (
              <button
                type="button"
                onClick={() => onStartNavigation(activeRecording)}
                className="flex-1 py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm"
              >
                <Compass className="w-4 h-4" />
                <span>נווט על ההקלטה</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onFlyToRoute(activeRecording)}
              className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
              title="התמקד בהקלטה"
            >
              <Navigation className="w-3.5 h-3.5 text-rose-500" />
              <span>הצג</span>
            </button>

            <button
              type="button"
              disabled={isExporting}
              onClick={() => void handleExportGpx(activeRecording)}
              className="px-3 py-2.5 rounded-xl border border-sky-500/50 bg-sky-500/15 hover:bg-sky-500/25 text-sky-400 text-xs font-bold flex items-center gap-1"
              title="ייצא כקובץ GPX למכשיר"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExporting ? 'מייצא...' : 'ייצא GPX'}</span>
            </button>

            {onSendToPlanningDb && (
              <button
                type="button"
                onClick={() => onSendToPlanningDb(activeRecording)}
                className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
                title="שלח למאגר תכנון מסלולים"
              >
                <FolderTree className="w-3.5 h-3.5 text-emerald-500" />
                <span>למאגר</span>
              </button>
            )}

            {!isSharedRecording && (
              <button
                type="button"
                onClick={() => {
                  setHoveredIdx(null);
                  setPinnedIdx(null);
                  onHoverPoint(null);
                  void onDeleteRoute(activeRecording.id);
                }}
                className={`px-2.5 py-2.5 rounded-xl border text-xs font-bold text-red-500 ${t.pillBtn}`}
                title="מחק הקלטה"
                aria-label="מחק הקלטה"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
