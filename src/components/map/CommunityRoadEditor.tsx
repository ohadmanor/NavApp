import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Link2,
  LoaderCircle,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import type { NavUser } from '../../core/firebase/AuthService';
import {
  communityRoadsCloudService,
  CommunityRoadConflictError,
} from '../../core/firebase/CommunityRoadsCloudService';
import {
  TRAIL_ANNOTATION_COLORS,
  type TrailAnnotationColor,
  type TrailAnnotationRecord,
} from '../../core/trails/TrailAnnotationTypes';
import {
  COMMUNITY_HIGHWAY_GROUPS,
  COMMUNITY_SURFACE_TYPES,
  COMMUNITY_TRACK_TYPES,
  computePolylineLengthMeters,
  getDefaultAccessForHighwayClass,
  getHighwayClassLabelHe,
  type CommunityHighwayClass,
  type CommunityRoadHistoryRecord,
  type CommunityRoadKind,
  type CommunityRoadRecord,
  type CommunityTrackType,
  type RoadConnectionAnchor,
} from '../../core/trails/CommunityRoadTypes';
import type { MapTheme } from '../ui/themeTokens';
import { getSurfaceTheme } from '../ui/themeTokens';

export interface CommunityRoadEditDraftInput {
  roadId: string | null;
  expectedRevision: number;
  kind: CommunityRoadKind;
  sourceOsmWayId?: string;
  coordinates: Array<[number, number]>;
  anchors: RoadConnectionAnchor[];
  highwayClass: CommunityHighwayClass;
  tracktype?: CommunityTrackType;
  surface?: string;
  name?: string;
  description?: string;
  oneway?: -1 | 0 | 1;
  allow4x4?: boolean;
  allowFoot?: boolean;
  allowBicycle?: boolean;
  existingRecord?: CommunityRoadRecord | null;
  trailColor?: TrailAnnotationColor | '';
  trailNumber?: string;
  trailName?: string;
  existingTrailAnnotation?: TrailAnnotationRecord | null;
}

interface CommunityRoadEditorProps {
  theme: MapTheme;
  currentUser: NavUser | null;
  isOnline: boolean;
  draft: CommunityRoadEditDraftInput;
  isDrawingGeometry: boolean;
  selectedVertexIndex?: number | null;
  onDeleteSelectedVertex?: () => void;
  onClearSelectedVertex?: () => void;
  onStartExtendDrawing?: () => void;
  onUndoLastVertex?: () => void;
  onFinishDrawing?: () => void;
  onCancel: () => void;
  onSaved: (saved: CommunityRoadRecord) => void;
  onDeleted: (deleted: CommunityRoadRecord) => void;
  onNotify: (message: string) => void;
}

const OP_LABELS: Record<CommunityRoadHistoryRecord['operation'], string> = {
  create: 'יצירה',
  edit: 'עריכה',
  delete: 'מחיקה',
  restore: 'שחזור',
  'osm-sync': 'סנכרון ל-OSM',
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('he-IL');
}

export const CommunityRoadEditor: React.FC<CommunityRoadEditorProps> = ({
  theme,
  currentUser,
  isOnline,
  draft,
  isDrawingGeometry,
  selectedVertexIndex = null,
  onDeleteSelectedVertex,
  onClearSelectedVertex,
  onStartExtendDrawing,
  onUndoLastVertex,
  onFinishDrawing,
  onCancel,
  onSaved,
  onDeleted,
  onNotify,
}) => {
  const t = getSurfaceTheme(theme);
  const [highwayClass, setHighwayClass] = useState<CommunityHighwayClass>(draft.highwayClass);
  const [tracktype, setTracktype] = useState<CommunityTrackType>(draft.tracktype || '');
  const [surface, setSurface] = useState<string>(draft.surface || '');
  const [name, setName] = useState<string>(draft.name || '');
  const [description, setDescription] = useState<string>(draft.description || '');
  const [oneway, setOneway] = useState<-1 | 0 | 1>(draft.oneway ?? 0);
  const defaults = getDefaultAccessForHighwayClass(draft.highwayClass);
  const [allow4x4, setAllow4x4] = useState<boolean>(draft.allow4x4 ?? defaults.allow4x4);
  const [allowFoot, setAllowFoot] = useState<boolean>(draft.allowFoot ?? defaults.allowFoot);
  const [allowBicycle, setAllowBicycle] = useState<boolean>(
    draft.allowBicycle ?? defaults.allowBicycle
  );
  const [reason, setReason] = useState('');
  const [trailColor, setTrailColor] = useState<TrailAnnotationColor | ''>(draft.trailColor || '');
  const [trailNumber, setTrailNumber] = useState<string>(draft.trailNumber || '');
  const [trailName, setTrailName] = useState<string>(draft.trailName || '');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDeleteRoad, setConfirmDeleteRoad] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<CommunityRoadHistoryRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  useEffect(() => {
    setHighwayClass(draft.highwayClass);
    setTracktype(draft.tracktype || '');
    setSurface(draft.surface || '');
    setName(draft.name || '');
    setDescription(draft.description || '');
    setOneway(draft.oneway ?? 0);
    const nextDef = getDefaultAccessForHighwayClass(draft.highwayClass);
    setAllow4x4(draft.allow4x4 ?? nextDef.allow4x4);
    setAllowFoot(draft.allowFoot ?? nextDef.allowFoot);
    setAllowBicycle(draft.allowBicycle ?? nextDef.allowBicycle);
    setReason('');
    setTrailColor(draft.trailColor || draft.existingTrailAnnotation?.color || '');
    setTrailNumber(draft.trailNumber || draft.existingTrailAnnotation?.number || '');
    setTrailName(draft.trailName || draft.existingTrailAnnotation?.name || '');
    setErrorMessage('');
    setConfirmDeleteRoad(false);
    setShowHistory(false);
    setHistoryEvents([]);
    // Only reset form fields when opening a different road/way, not when geometry vertices move
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.roadId, draft.kind, draft.sourceOsmWayId]);

  const handleHighwayClassChange = (nextClass: CommunityHighwayClass) => {
    setHighwayClass(nextClass);
    if (!draft.roadId) {
      const nextDef = getDefaultAccessForHighwayClass(nextClass);
      setAllow4x4(nextDef.allow4x4);
      setAllowFoot(nextDef.allowFoot);
      setAllowBicycle(nextDef.allowBicycle);
    }
  };

  const lengthMeters = Math.round(computePolylineLengthMeters(draft.coordinates));
  const existingRecord = draft.existingRecord;
  const isOsmOverride = draft.kind === 'osm-override';
  const isDeleted = existingRecord?.status === 'deleted';
  // An OSM road that was removed from the map (tombstone); opened from its ghost line to restore it
  const isRemoved = !isDeleted && Boolean(existingRecord?.removed);
  const canDeleteWholeRoad = !isDeleted && !isRemoved;
  const isOsmSynced =
    Boolean(existingRecord?.osmSync) &&
    existingRecord!.osmSync!.syncedRevision >= existingRecord!.revision;

  const handleSave = async () => {
    setErrorMessage('');
    setIsSaving(true);
    try {
      const saved = await communityRoadsCloudService.saveCommunityRoad({
        roadId: draft.roadId,
        expectedRevision: draft.expectedRevision,
        user: currentUser,
        kind: draft.kind,
        sourceOsmWayId: draft.sourceOsmWayId,
        coordinates: draft.coordinates,
        highwayClass,
        tracktype,
        surface,
        name,
        description,
        oneway,
        allow4x4,
        allowFoot,
        allowBicycle,
        anchors: draft.anchors,
        trailColor,
        trailNumber,
        trailName,
        reason,
      });

      onNotify(
        isOsmOverride
          ? 'עדכון הדרך נשמר מקומית ויסונכרן לענן.'
          : 'הדרך החדשה נשמרה מקומית, חוברה לרשת ותסונכרן לענן.'
      );
      onSaved(saved);
    } catch (err) {
      if (err instanceof CommunityRoadConflictError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'שמירת הדרך נכשלה.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const runRoadRemoval = async (
    mutate: () => Promise<CommunityRoadRecord>,
    successMessage: string
  ) => {
    setErrorMessage('');
    setIsSaving(true);
    try {
      const record = await mutate();
      onNotify(successMessage);
      onDeleted(record);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'מחיקת הדרך נכשלה.';
      setErrorMessage(message);
      // The error box sits at the bottom of a long form, so surface the failure as a toast too
      onNotify(message);
      setConfirmDeleteRoad(false);
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Soft-deletes the saved record. For a community-drawn road this removes the road; for an OSM
   * override (or a removed-road tombstone) it discards the record, so the original OSM way returns.
   */
  const handleDelete = async () => {
    const roadId = draft.roadId;
    if (!roadId) return;
    await runRoadRemoval(
      () =>
        communityRoadsCloudService.deleteCommunityRoad({
          roadId,
          expectedRevision: draft.expectedRevision,
          user: currentUser,
          reason:
            reason || (isOsmOverride ? 'חזרה לדרך המקורית של OSM' : 'מחיקת דרך קהילתית'),
        }),
      isOsmOverride
        ? 'הדרך המקורית של OSM הוחזרה למפה.'
        : 'הדרך סומנה כמחוקה מקומית ותסונכרן לענן.'
    );
  };

  /** Deletes the entire selected road (as opposed to a single point of it). */
  const handleDeleteWholeRoad = async () => {
    if (isOsmOverride) {
      const sourceOsmWayId = draft.sourceOsmWayId;
      if (!sourceOsmWayId) return;
      await runRoadRemoval(
        () =>
          communityRoadsCloudService.removeOsmRoad({
            roadId: draft.roadId,
            expectedRevision: draft.expectedRevision,
            user: currentUser,
            sourceOsmWayId,
            coordinates: draft.coordinates,
            highwayClass: draft.highwayClass,
            name: draft.name,
            reason: reason || 'הסרת דרך מהמפה',
          }),
        'הדרך הוסרה מהמפה ומהניתוב. ניתן לשחזר אותה במצב עריכת דרך.'
      );
      return;
    }
    if (!draft.roadId) {
      // A new road that was never saved: nothing is stored yet, so deleting it discards the draft
      onNotify('הדרך שלא נשמרה נמחקה.');
      onCancel();
      return;
    }
    await handleDelete();
  };

  const toggleHistory = async () => {
    if (!draft.roadId) return;
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    setShowHistory(true);
    setLoadingHistory(true);
    try {
      const page = await communityRoadsCloudService.loadHistoryPage(draft.roadId);
      setHistoryEvents(page.events);
    } catch {
      setHistoryEvents([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  if (isDrawingGeometry) {
    return (
      <section
        dir="rtl"
        className={`flex flex-col gap-2 rounded-2xl border p-3 shadow-xl ${t.panel}`}
        aria-label="ציור דרך חדשה"
      >
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-bold">הוספת דרך חדשה</h2>
            <p className={`text-[11px] ${t.muted}`}>
              לחץ על המפה להוספת נקודות · נקודות ליד דרך קיימת נצמדות אוטומטית
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className={`rounded-lg p-1.5 ${t.hoverRow}`}
            aria-label="ביטול ציור"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className={`flex flex-wrap items-center gap-2 rounded-xl border px-2.5 py-2 text-xs ${t.subCard}`}>
          <span>נקודות: {draft.coordinates.length}</span>
          <span>·</span>
          <span>אורך: {lengthMeters >= 1000 ? `${(lengthMeters / 1000).toFixed(2)} ק"מ` : `${lengthMeters} מ'`}</span>
          <span>·</span>
          <span className={draft.anchors.length > 0 ? 'text-emerald-500 font-semibold' : 'text-amber-500'}>
            חיבורים לדרכים: {draft.anchors.length}
          </span>
        </div>

        {selectedVertexIndex !== null && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-[11px]">
            <span>נקודה #{selectedVertexIndex + 1} נבחרה — גרור או לחץ במפה להזזה</span>
            <div className="flex items-center gap-1">
              {draft.coordinates.length > 2 && onDeleteSelectedVertex && (
                <button type="button" onClick={onDeleteSelectedVertex} className="rounded px-1.5 py-0.5 text-rose-500 font-semibold">
                  מחק
                </button>
              )}
              {onClearSelectedVertex && (
                <button type="button" onClick={onClearSelectedVertex} className={`rounded px-1.5 py-0.5 ${t.pillBtn}`}>
                  סיום
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onUndoLastVertex}
            disabled={draft.coordinates.length === 0}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40 ${t.pillBtn}`}
          >
            <Undo2 className="h-3.5 w-3.5" />
            בטל נקודה
          </button>
          <button
            type="button"
            onClick={onFinishDrawing}
            disabled={draft.coordinates.length < 2}
            className="flex-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40"
          >
            סיום ציור והגדרת דרך
          </button>
        </div>
      </section>
    );
  }

  return (
    <section
      dir="rtl"
      className={`flex max-h-[72vh] flex-col overflow-hidden rounded-2xl border ${t.panel}`}
      aria-label="עריכת דרך"
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${t.divider}`}>
        <div>
          <h2 className="text-sm font-bold">
            {isRemoved
              ? `דרך OSM שהוסרה ${draft.sourceOsmWayId?.replace('osm:way:', '#') || ''}`
              : isOsmOverride
              ? `עריכת דרך OSM ${draft.sourceOsmWayId?.replace('osm:way:', '#') || ''}`
              : draft.roadId
                ? `עריכת דרך${name ? `: ${name}` : ''}`
                : 'שמירת דרך חדשה'}
          </h2>
          <p className={`mt-0.5 text-[11px] ${t.muted}`}>
            {lengthMeters >= 1000 ? `${(lengthMeters / 1000).toFixed(2)} ק"מ` : `${lengthMeters} מ'`} ·{' '}
            {draft.anchors.length > 0
              ? `מחובר ל-${draft.anchors.length} נק׳ רשת`
              : isOsmOverride
                ? 'עדכון דרך קיימת ברשת'
                : 'ללא חיבור לרשת'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canDeleteWholeRoad && (
            <button
              type="button"
              onClick={() => setConfirmDeleteRoad(true)}
              disabled={isSaving}
              className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-2 py-1.5 text-xs font-semibold text-rose-500 disabled:opacity-45"
              title="מחיקת הדרך כולה"
            >
              <Trash2 className="h-3.5 w-3.5" />
              מחק דרך
            </button>
          )}
          <button type="button" onClick={onCancel} className={`rounded-lg p-2 ${t.hoverRow}`} aria-label="סגור">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {confirmDeleteRoad && canDeleteWholeRoad && (
        <div
          role="alertdialog"
          aria-label="אישור מחיקת הדרך"
          className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs"
        >
          <span className="font-semibold text-rose-500">
            {isOsmOverride
              ? 'למחוק את כל הדרך? היא תוסר מהמפה ומהניתוב לכל המשתמשים.'
              : draft.roadId
                ? 'למחוק את כל הדרך? היא תוסר מהמפה ומהניתוב.'
                : 'למחוק את הדרך שעדיין לא נשמרה?'}
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void handleDeleteWholeRoad()}
              disabled={isSaving}
              className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2.5 py-1 font-bold text-white disabled:opacity-45"
            >
              {isSaving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
              מחק
            </button>
            <button
              type="button"
              onClick={() => setConfirmDeleteRoad(false)}
              disabled={isSaving}
              className={`rounded-lg border px-2.5 py-1 disabled:opacity-45 ${t.pillBtn}`}
            >
              ביטול
            </button>
          </span>
        </div>
      )}

      <div className="space-y-3 overflow-y-auto p-3">
        <p className={`rounded-lg border px-2.5 py-1.5 text-[11px] ${t.subCard}`}>
          {selectedVertexIndex !== null
            ? `נקודה #${selectedVertexIndex + 1} נבחרה — גרור או לחץ במפה להזזה`
            : 'טיפ: ניתן ללחוץ או לגרור כל נקודה של הדרך במפה כדי להזיז אותה.'}
          {selectedVertexIndex !== null && (
            <span className="mr-2 inline-flex gap-1.5">
              {draft.coordinates.length > 2 && onDeleteSelectedVertex && (
                <button type="button" onClick={onDeleteSelectedVertex} className="font-semibold text-rose-500 underline">
                  מחק נקודה
                </button>
              )}
              {onClearSelectedVertex && (
                <button type="button" onClick={onClearSelectedVertex} className="font-semibold underline">
                  בטל בחירה
                </button>
              )}
            </span>
          )}
        </p>

        {isDeleted && (
          <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-500">
            דרך זו נמחקה. שמירה תשחזר אותה למפה ולניתוב.
          </p>
        )}

        {isRemoved && (
          <div className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-500">
            <p>דרך זו הוסרה מהמפה ומהניתוב. שמירה תשחזר אותה עם הפרטים שבטופס.</p>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isSaving}
              className="mt-1.5 inline-flex items-center gap-1 font-semibold underline disabled:opacity-45"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              שחזור הדרך המקורית של OSM
            </button>
          </div>
        )}

        {draft.kind === 'new' && draft.anchors.length === 0 && (
          <p className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-500">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            יש לחבר לפחות קצה אחד לדרך קיימת במפה.
          </p>
        )}

        {existingRecord && (
          <div className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[11px] ${t.subCard}`}>
            <span className="flex items-center gap-1.5">
              {isOsmSynced ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  <span>סונכרן ל-OSM (#{existingRecord.osmSync?.changesetId})</span>
                </>
              ) : (
                <>
                  <Link2 className="h-3.5 w-3.5 text-amber-500" />
                  <span>
                    {existingRecord.cloudSyncStatus === 'pending'
                      ? 'נשמר מקומית · ממתין לסנכרון לענן'
                      : existingRecord.cloudSyncStatus === 'error'
                        ? 'נשמר מקומית · שגיאת סנכרון לענן'
                        : 'סונכרן לענן · ממתין ל-OSM'}
                  </span>
                </>
              )}
            </span>
            <span className={t.muted}>גרסה {existingRecord.revision}</span>
          </div>
        )}

        <label className="block text-xs font-semibold">
          סוג דרך (OSM Highway)
          <select
            value={highwayClass}
            onChange={(e) => handleHighwayClassChange(e.target.value as CommunityHighwayClass)}
            className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
          >
            {COMMUNITY_HIGHWAY_GROUPS.map((group) => (
              <optgroup key={group.groupLabelHe} label={group.groupLabelHe}>
                {group.items.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.labelHe}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {highwayClass === 'track' && (
          <fieldset className={`rounded-xl border p-2.5 ${t.subCard}`}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <legend className="text-xs font-semibold">דירוג דרך עפר (tracktype)</legend>
              <button
                type="button"
                onClick={() => setTracktype('')}
                className={`rounded-md border px-2 py-0.5 text-[10px] ${
                  tracktype === '' ? 'border-emerald-500 bg-emerald-600 text-white' : t.pillBtn
                }`}
              >
                לא צוין
              </button>
            </div>
            <div dir="ltr" className="relative overflow-hidden rounded-lg border border-slate-500/30">
              <img
                src="/assets/tracktype/tracktype-guide.jpg"
                alt="OSM Tracktype Grade 1 to Grade 5 visual guide"
                className="block w-full h-auto select-none"
              />
              <div className="absolute inset-0 grid grid-cols-5">
                {COMMUNITY_TRACK_TYPES.map((tt) => (
                  <button
                    key={tt}
                    type="button"
                    aria-label={`בחר ${tt}`}
                    aria-pressed={tracktype === tt}
                    onClick={() => setTracktype(tt)}
                    className={`h-full transition-all ${
                      tracktype === tt
                        ? 'ring-2 ring-inset ring-emerald-400 bg-emerald-500/20'
                        : 'hover:bg-white/10'
                    }`}
                  />
                ))}
              </div>
            </div>
            <div dir="ltr" className="mt-1.5 grid grid-cols-5 gap-1">
              {COMMUNITY_TRACK_TYPES.map((tt) => (
                <button
                  key={tt}
                  type="button"
                  onClick={() => setTracktype(tt)}
                  className={`rounded-md border py-1 text-[10px] font-bold transition-colors ${
                    tracktype === tt ? 'border-emerald-500 bg-emerald-600 text-white' : t.pillBtn
                  }`}
                >
                  {tt}
                </button>
              ))}
            </div>
            {tracktype && (
              <p className={`mt-1.5 text-[11px] ${t.muted}`}>
                {tracktype === 'grade1'
                  ? 'grade1: משטח קשיח / סלול ברובו'
                  : tracktype === 'grade2'
                    ? 'grade2: דרך כורכר / חצץ מהודקת'
                    : tracktype === 'grade3'
                      ? 'grade3: תערובת מאוזנת של חומר קשה ורך'
                      : tracktype === 'grade4'
                        ? 'grade4: דרך רכה ברובה (קרקע/חול/עשב עם מעט אבנים)'
                        : 'grade5: דרך עפר/חול/עשב לא מהודקת'}
              </p>
            )}
          </fieldset>
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs font-semibold">
            פני שטח (surface)
            <select
              value={surface}
              onChange={(e) => setSurface(e.target.value)}
              className={`mt-1 w-full rounded-lg border px-2.5 py-2 text-xs ${t.fieldBox}`}
            >
              {COMMUNITY_SURFACE_TYPES.map((s) => (
                <option key={s || 'none'} value={s}>
                  {s || 'ברירת מחדל'}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-semibold">
            כיוון תנועה (oneway)
            <select
              value={String(oneway)}
              onChange={(e) => setOneway(Number(e.target.value) as -1 | 0 | 1)}
              className={`mt-1 w-full rounded-lg border px-2.5 py-2 text-xs ${t.fieldBox}`}
            >
              <option value="0">דו-סטרי</option>
              <option value="1">חד-סטרי (בכיוון הציור)</option>
              <option value="-1">חד-סטרי (הפוך)</option>
            </select>
          </label>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold">הרשאות מעבר בניתוב</legend>
          <div className="flex flex-wrap gap-2">
            {[
              { key: '4x4', label: 'רכב 4x4', checked: allow4x4, set: setAllow4x4 },
              { key: 'foot', label: 'הליכה', checked: allowFoot, set: setAllowFoot },
              { key: 'bicycle', label: 'אופניים', checked: allowBicycle, set: setAllowBicycle },
            ].map((perm) => (
              <button
                key={perm.key}
                type="button"
                aria-pressed={perm.checked}
                onClick={() => perm.set(!perm.checked)}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                  perm.checked ? 'border-emerald-500 bg-emerald-600 text-white' : t.pillBtn
                }`}
              >
                {perm.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block text-xs font-semibold">
          שם הדרך (רשות)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
            placeholder="לדוגמה: מעלה האלונים"
            dir="auto"
          />
        </label>

        <label className="block text-xs font-semibold">
          תיאור (רשות)
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            rows={2}
            className={`mt-1 w-full resize-y rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
            placeholder="פרטים על הדרך, עבירות וכו׳"
            dir="auto"
          />
        </label>

        {onStartExtendDrawing && (
          <button
            type="button"
            onClick={onStartExtendDrawing}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold ${t.pillBtn}`}
          >
            <Plus className="h-3.5 w-3.5" />
            הוסף נקודות בהמשך הדרך
          </button>
        )}

        <fieldset className={`rounded-xl border p-2.5 ${t.subCard}`}>
          <legend className="px-1 text-xs font-semibold">סימון שביל (רשות)</legend>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setTrailColor('')}
              className={`rounded-lg border px-2.5 py-1 text-xs ${
                trailColor === '' ? 'border-emerald-500 bg-emerald-600 text-white' : t.pillBtn
              }`}
            >
              ללא סימון
            </button>
            {TRAIL_ANNOTATION_COLORS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setTrailColor(item.value)}
                className={`flex h-7 w-7 items-center justify-center rounded-full border-2 ${
                  trailColor === item.value ? 'border-current ring-2 ring-emerald-500/50' : 'border-transparent'
                }`}
                style={{ backgroundColor: item.value }}
                aria-label={item.label}
                aria-pressed={trailColor === item.value}
              >
                {trailColor === item.value && <Check className="h-3.5 w-3.5 text-white" />}
              </button>
            ))}
          </div>
          {trailColor && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="block text-[11px] font-semibold">
                מספר שביל (רשות)
                <input
                  value={trailNumber}
                  onChange={(e) => setTrailNumber(e.target.value)}
                  maxLength={32}
                  className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs ${t.fieldBox}`}
                  placeholder="לדוגמה: 4120"
                  dir="auto"
                />
              </label>
              <label className="block text-[11px] font-semibold">
                שם שביל
                <input
                  value={trailName}
                  onChange={(e) => setTrailName(e.target.value)}
                  maxLength={120}
                  className={`mt-1 w-full rounded-lg border px-2.5 py-1.5 text-xs ${t.fieldBox}`}
                  placeholder="לדוגמה: נחל כזיב"
                  dir="auto"
                />
              </label>
            </div>
          )}
        </fieldset>

        <label className="block text-xs font-semibold">
          סיבת השינוי (רשות)
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
            placeholder="למשל: חיבור דרך עפר חדשה לשביל ראשי"
            dir="auto"
          />
        </label>

        {errorMessage && (
          <p role="alert" className="rounded-lg bg-rose-500/10 p-2 text-xs text-rose-500">
            {errorMessage}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-45"
          >
            {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {isDeleted || isRemoved ? 'שחזור ושמירה' : draft.roadId ? 'עדכון דרך' : 'שמירת דרך'}
          </button>

          {draft.roadId && (
            <button
              type="button"
              onClick={() => void toggleHistory()}
              aria-pressed={showHistory}
              className={`rounded-lg border px-2.5 py-2 text-xs ${t.pillBtn}`}
              title="היסטוריית שינויים"
            >
              <Clock3 className="h-4 w-4" />
            </button>
          )}

          {draft.roadId && isOsmOverride && canDeleteWholeRoad && (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={isSaving}
              className={`rounded-lg border px-2.5 py-2 text-xs disabled:opacity-45 ${t.pillBtn}`}
              title="ביטול העריכה וחזרה לדרך המקורית של OSM"
              aria-label="ביטול העריכה וחזרה לדרך המקורית של OSM"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          )}
        </div>

        {!isOnline && (
          <p className="text-[11px] text-amber-500">אופליין: השינוי יישמר במכשיר ויסונכרן אוטומטית בחיבור הבא.</p>
        )}

        {showHistory && (
          <section className={`rounded-xl border p-3 ${t.subCard}`}>
            <h3 className="mb-2 text-xs font-bold">היסטוריית שינויים</h3>
            {loadingHistory && <LoaderCircle className="mx-auto my-2 h-4 w-4 animate-spin" />}
            {!loadingHistory && historyEvents.length === 0 && (
              <p className={`text-xs ${t.muted}`}>אין אירועי היסטוריה.</p>
            )}
            {historyEvents.map((ev) => (
              <div key={ev.id} className={`border-t py-2 text-[11px] ${t.divider}`}>
                <p className="font-semibold">
                  {OP_LABELS[ev.operation] ?? ev.operation} · {getHighwayClassLabelHe(ev.next.highwayClass)}
                </p>
                <p className={t.muted}>{formatTime(ev.occurredAt)}</p>
                {ev.reason && (
                  <p dir="auto" className="mt-0.5">
                    {ev.reason}
                  </p>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </section>
  );
};
