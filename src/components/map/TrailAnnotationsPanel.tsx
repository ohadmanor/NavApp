import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock3,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { NavUser } from '../../core/firebase/AuthService';
import {
  trailAnnotationsCloudService,
  type TrailAnnotationLoadResult,
  type TrailGeometryResolution,
} from '../../core/firebase/TrailAnnotationsCloudService';
import type {
  TrailAnnotationHistoryRecord,
  TrailAnnotationRecord,
  TrailWayCandidate,
  TrailWayGeometry,
} from '../../core/trails/TrailAnnotationTypes';
import {
  isTrailAnnotationColor,
  TRAIL_ANNOTATION_COLORS,
} from '../../core/trails/TrailAnnotationTypes';
import type { MapTheme } from '../ui/themeTokens';
import { getSurfaceTheme } from '../ui/themeTokens';

interface TrailAnnotationsPanelProps {
  isMarkingMode: boolean;
  theme: MapTheme;
  currentUser: NavUser | null;
  firebaseAvailable: boolean;
  isOnline: boolean;
  releaseId: string;
  showTrailOverlay: boolean;
  onToggleTrailOverlay: () => void;
  wayCandidates: TrailWayCandidate[];
  onResolveCandidate: (candidate: TrailWayCandidate) => void;
  selectedMapWay: TrailWayGeometry | null;
  onConsumeSelectedWay: () => void;
  selectedAnnotationId: string | null;
  onConsumeSelectedAnnotation: () => void;
  onAddWaysModeChange: (enabled: boolean) => void;
  onClose: () => void;
  onGeoJSONChange: (geojson: GeoJSON.FeatureCollection) => void;
  onNotify: (message: string) => void;
}

function shortUid(uid: string): string {
  return uid.length > 10 ? `${uid.slice(0, 6)}…${uid.slice(-3)}` : uid;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('he-IL');
}

const OPERATION_LABELS: Record<TrailAnnotationHistoryRecord['operation'], string> = {
  create: 'יצירה',
  edit: 'עריכה',
  delete: 'מחיקה',
  restore: 'שחזור',
  rebind: 'שינוי קטעים',
};

function historyChanges(event: TrailAnnotationHistoryRecord): string[] {
  if (!event.previous) return ['סימון שביל חדש'];
  const changes: string[] = [];
  if (event.previous.color !== event.next.color) changes.push('צבע');
  if (event.previous.number !== event.next.number) changes.push('מספר');
  if (event.previous.description !== event.next.description) changes.push('תיאור');
  if (event.previous.status !== event.next.status) changes.push('מצב');
  if (event.previous.wayIds.join('|') !== event.next.wayIds.join('|')) changes.push('קטעים');
  return changes.length > 0 ? changes : ['עדכון'];
}

function findAnnotationForWay(
  annotations: TrailAnnotationRecord[],
  wayId: string
): TrailAnnotationRecord | null {
  const matches = annotations.filter((annotation) => annotation.wayIds.includes(wayId));
  if (matches.length === 0) return null;
  const active = matches.filter((annotation) => annotation.status === 'active');
  const pool = active.length > 0 ? active : matches;
  return pool.reduce((latest, annotation) =>
    annotation.updatedAt > latest.updatedAt ? annotation : latest
  );
}

export const TrailAnnotationsPanel: React.FC<TrailAnnotationsPanelProps> = ({
  isMarkingMode,
  theme,
  currentUser,
  firebaseAvailable,
  isOnline,
  releaseId,
  showTrailOverlay,
  onToggleTrailOverlay,
  wayCandidates,
  onResolveCandidate,
  selectedMapWay,
  onConsumeSelectedWay,
  selectedAnnotationId,
  onConsumeSelectedAnnotation,
  onAddWaysModeChange,
  onClose,
  onGeoJSONChange,
  onNotify,
}) => {
  const t = getSurfaceTheme(theme);
  const [annotations, setAnnotations] = useState<TrailAnnotationRecord[]>([]);
  const [resolutions, setResolutions] = useState<Map<string, TrailGeometryResolution>>(new Map());
  const [loadWarning, setLoadWarning] = useState('');
  const [loadError, setLoadError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [addWaysMode, setAddWaysMode] = useState(false);
  const [trailId, setTrailId] = useState<string | null>(null);
  const [expectedRevision, setExpectedRevision] = useState(0);
  const [wayIds, setWayIds] = useState<string[]>([]);
  const [ways, setWays] = useState<Map<string, TrailWayGeometry>>(new Map());
  const [color, setColor] = useState<string>(TRAIL_ANNOTATION_COLORS[0].value);
  const [number, setNumber] = useState('');
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showHistoryView, setShowHistoryView] = useState(false);
  const [historyEvents, setHistoryEvents] = useState<TrailAnnotationHistoryRecord[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);
  const mountedUidRef = useRef<string | null>(currentUser?.uid ?? null);

  const editingAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === trailId) || null,
    [annotations, trailId]
  );
  const isVisible = isMarkingMode && (isEditing || wayCandidates.length > 0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      setLoadError('');
      try {
        const result: TrailAnnotationLoadResult =
          await trailAnnotationsCloudService.loadPublishedAnnotations();
        if (cancelled) return;
        const published = result.annotations;
        setAnnotations(published);
        setLoadWarning(result.warning || '');
        const nextResolutions = new Map<string, TrailGeometryResolution>();
        const active = published.filter((annotation) => annotation.status === 'active');
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(4, active.length) }, async () => {
          while (!cancelled) {
            const index = nextIndex++;
            if (index >= active.length) return;
            const annotation = active[index];
            try {
              const resolution = await trailAnnotationsCloudService.resolveAnnotationGeometry(
                annotation,
                releaseId
              );
              if (!cancelled) nextResolutions.set(annotation.id, resolution);
            } catch (error) {
              if (!cancelled) {
                console.warn(`[TrailAnnotations] Could not load geometry for ${annotation.id}:`, error);
                nextResolutions.set(annotation.id, { ways: [], staleWayIds: annotation.wayIds });
              }
            }
          }
        });
        await Promise.all(workers);
        if (!cancelled) setResolutions(nextResolutions);
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load trail annotations.';
          setLoadError(message);
          setLoadWarning('');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [releaseId]);

  useEffect(() => {
    const geojson = trailAnnotationsCloudService.toGeoJSON(annotations, resolutions);
    if (isEditing) {
      for (const wayId of wayIds) {
        const way = ways.get(wayId);
        if (!way) continue;
        geojson.features.push({
          type: 'Feature',
          id: `selection:${wayId}`,
          geometry: way.geometry,
          properties: {
            trailId: 'selection-preview',
            wayId,
            number: '',
            color: '#facc15',
            updatedAt: '',
            stale: false,
          },
        });
      }
    }
    onGeoJSONChange(geojson);
  }, [annotations, resolutions, isEditing, wayIds, ways, onGeoJSONChange]);

  useEffect(() => {
    onAddWaysModeChange(isEditing && addWaysMode);
  }, [isEditing, addWaysMode, onAddWaysModeChange]);

  const closeEditor = () => {
    setIsEditing(false);
    setAddWaysMode(false);
    setShowHistoryView(false);
    setErrorMessage('');
  };

  useEffect(() => {
    if (!isMarkingMode) closeEditor();
  }, [isMarkingMode]);

  useEffect(() => {
    const nextUid = currentUser?.uid ?? null;
    if (mountedUidRef.current === nextUid) return;
    mountedUidRef.current = nextUid;
    closeEditor();
    setTrailId(null);
    setWayIds([]);
    setWays(new Map());
  }, [currentUser?.uid]);

  useEffect(() => {
    if (!currentUser || !isEditing || isSaving) return;
    const timer = window.setTimeout(() => {
      void trailAnnotationsCloudService
        .saveDraft({
          ownerUid: currentUser.uid,
          trailId,
          wayIds,
          color: isTrailAnnotationColor(color) ? color : TRAIL_ANNOTATION_COLORS[0].value,
          number,
          description,
          reason,
        })
        .catch((error) => {
          console.error('[TrailAnnotations] Failed to save local draft:', error);
          setErrorMessage('לא ניתן לשמור טיוטה מקומית במכשיר.');
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [currentUser, isEditing, isSaving, trailId, wayIds, color, number, description, reason]);

  const openEditor = () => {
    setShowHistoryView(false);
    setHistoryEvents([]);
    setHistoryCursor(null);
    setErrorMessage('');
    setAddWaysMode(false);
    setIsEditing(true);
  };

  const startNewTrailForWay = async (way: TrailWayGeometry) => {
    if (!currentUser) return;
    setTrailId(null);
    setExpectedRevision(0);
    setWayIds([way.wayId]);
    setWays(new Map([[way.wayId, way]]));
    setColor(TRAIL_ANNOTATION_COLORS[0].value);
    setNumber('');
    setDescription('');
    setReason('');
    openEditor();
    const draft = await trailAnnotationsCloudService.loadDraft(currentUser.uid, null);
    if (draft && draft.wayIds.length === 1 && draft.wayIds[0] === way.wayId) {
      setColor(draft.color);
      setNumber(draft.number);
      setDescription(draft.description);
      setReason(draft.reason);
    }
  };

  const startEditTrail = async (annotation: TrailAnnotationRecord, freshWay?: TrailWayGeometry) => {
    if (!currentUser) return;
    let resolution = resolutions.get(annotation.id);
    if (!resolution) {
      try {
        resolution = await trailAnnotationsCloudService.resolveAnnotationGeometry(
          annotation,
          releaseId
        );
        setResolutions((previous) => new Map(previous).set(annotation.id, resolution!));
      } catch (error) {
        console.warn(`[TrailAnnotations] Could not load geometry for ${annotation.id}:`, error);
      }
    }
    const nextWays = new Map((resolution?.ways || []).map((way) => [way.wayId, way]));
    if (freshWay) nextWays.set(freshWay.wayId, freshWay);
    setTrailId(annotation.id);
    setExpectedRevision(annotation.revision);
    setWayIds(annotation.wayIds);
    setWays(nextWays);
    setColor(annotation.color);
    setNumber(annotation.number);
    setDescription(annotation.description);
    setReason('');
    openEditor();
    const draft = await trailAnnotationsCloudService.loadDraft(currentUser.uid, annotation.id);
    if (draft && draft.updatedAt > annotation.updatedAt) {
      setWayIds(draft.wayIds);
      setColor(draft.color);
      setNumber(draft.number);
      setDescription(draft.description);
      setReason(draft.reason);
    }
  };

  useEffect(() => {
    if (!selectedMapWay) return;
    onConsumeSelectedWay();
    if (!isMarkingMode || !currentUser) return;
    if (isEditing && addWaysMode) {
      setWayIds((previous) =>
        previous.includes(selectedMapWay.wayId) ? previous : [...previous, selectedMapWay.wayId]
      );
      setWays((previous) => new Map(previous).set(selectedMapWay.wayId, selectedMapWay));
      setErrorMessage('');
      return;
    }
    const existing = findAnnotationForWay(annotations, selectedMapWay.wayId);
    if (existing) {
      void startEditTrail(existing, selectedMapWay);
    } else {
      void startNewTrailForWay(selectedMapWay);
    }
  }, [selectedMapWay]);

  useEffect(() => {
    if (!selectedAnnotationId) return;
    onConsumeSelectedAnnotation();
    if (!isMarkingMode || !currentUser) return;
    const annotation = annotations.find((item) => item.id === selectedAnnotationId);
    if (annotation) void startEditTrail(annotation);
  }, [selectedAnnotationId]);

  const loadHistoryPage = async (annotationId: string, beforeRevision?: number) => {
    if (!firebaseAvailable || !isOnline) {
      setHistoryError('היסטוריית שינויים זמינה בחיבור לענן בלבד.');
      return;
    }
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const page = await trailAnnotationsCloudService.loadHistory(annotationId, beforeRevision);
      setHistoryEvents((previous) =>
        beforeRevision === undefined ? page.events : [...previous, ...page.events]
      );
      setHistoryCursor(page.nextRevision);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'לא ניתן לטעון היסטוריה.');
    } finally {
      setLoadingHistory(false);
    }
  };

  const toggleHistory = () => {
    if (!trailId) return;
    if (showHistoryView) {
      setShowHistoryView(false);
      return;
    }
    setShowHistoryView(true);
    setHistoryEvents([]);
    setHistoryCursor(null);
    void loadHistoryPage(trailId);
  };

  const handleSave = async () => {
    if (!currentUser) {
      setErrorMessage('יש להתחבר לפני פרסום שינוי.');
      return;
    }
    if (!isOnline) {
      setErrorMessage('אפשר לשמור טיוטה אופליין, אך פרסום שינויים מחייב חיבור לאינטרנט.');
      return;
    }
    setIsSaving(true);
    setErrorMessage('');
    try {
      const geometries = wayIds.flatMap((wayId) => {
        const way = ways.get(wayId);
        return way ? [way] : [];
      });
      const saved = await trailAnnotationsCloudService.saveAnnotation({
        trailId,
        expectedRevision,
        user: currentUser,
        wayIds,
        color,
        number,
        description,
        reason,
        releaseId,
        geometries,
      });
      setAnnotations((previous) => [
        saved,
        ...previous.filter((annotation) => annotation.id !== saved.id),
      ]);
      setResolutions((previous) =>
        new Map(previous).set(saved.id, { ways: geometries, staleWayIds: [] })
      );
      setExpectedRevision(saved.revision);
      closeEditor();
      onClose();
      onNotify('סימון השביל נשמר והעדכון נרשם בהיסטוריה.');
    } catch (error) {
      console.error('[TrailAnnotations] Save failed:', error);
      setErrorMessage(error instanceof Error ? error.message : 'לא ניתן לשמור את סימון השביל.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editingAnnotation || !currentUser || !isOnline) return;
    if (!window.confirm(`למחוק את סימון השביל ${editingAnnotation.number}? ההיסטוריה תישמר.`)) return;
    setIsSaving(true);
    setErrorMessage('');
    try {
      const deleted = await trailAnnotationsCloudService.softDelete(
        editingAnnotation,
        currentUser,
        releaseId,
        []
      );
      setAnnotations((previous) =>
        previous.map((annotation) => (annotation.id === deleted.id ? deleted : annotation))
      );
      closeEditor();
      onClose();
      onNotify('סימון השביל הוסר מהמפה. היסטוריית השינויים נשמרה.');
    } catch (error) {
      console.error('[TrailAnnotations] Delete failed:', error);
      setErrorMessage(error instanceof Error ? error.message : 'לא ניתן למחוק את סימון השביל.');
    } finally {
      setIsSaving(false);
    }
  };

  const removeWay = (wayId: string) => {
    setWayIds((previous) => previous.filter((id) => id !== wayId));
    setWays((previous) => {
      const next = new Map(previous);
      next.delete(wayId);
      return next;
    });
  };

  const handleCancel = () => {
    closeEditor();
    onClose();
  };

  if (!isVisible) return null;

  const isDeletedTrail = editingAnnotation?.status === 'deleted';
  const isStale = Boolean(trailId && resolutions.get(trailId)?.staleWayIds.length);

  return (
    <section
      dir="rtl"
      className={`flex max-h-[72vh] flex-col overflow-hidden rounded-2xl border ${t.panel}`}
      aria-label="סימון שבילים"
    >
      <header className={`flex items-center justify-between gap-2 border-b px-4 py-3 ${t.divider}`}>
        <div>
          <h2 className="text-sm font-bold">
            {!isEditing ? 'סימון שבילים' : trailId ? `שביל ${number || editingAnnotation?.number || ''}` : 'סימון שביל חדש'}
          </h2>
          {isEditing && editingAnnotation && (
            <p className={`mt-0.5 flex items-center gap-1 text-[11px] ${t.muted}`}>
              <Clock3 className="h-3 w-3" />
              עודכן {formatTime(editingAnnotation.updatedAt)} · {shortUid(editingAnnotation.updatedByUid)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onToggleTrailOverlay} className={`rounded-lg px-2 py-1 text-[10px] ${t.pillBtn}`} aria-pressed={showTrailOverlay}>
            {showTrailOverlay ? 'הסתר במפה' : 'הצג במפה'}
          </button>
          <button type="button" onClick={handleCancel} className={`rounded-lg p-2 ${t.hoverRow}`} aria-label="סגור">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="overflow-y-auto p-3">
        {!firebaseAvailable && (
          <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
            חיבור Firebase אינו מוגדר. לא ניתן לפרסם שינויים.
          </div>
        )}
        {loadWarning && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>{loadWarning}</span>
          </div>
        )}
        {loadError && (
          <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-500">
            {loadError}
          </div>
        )}
        {isLoading && (
          <div className={`mb-3 flex items-center gap-2 text-xs ${t.muted}`}>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            טוען סימוני שבילים…
          </div>
        )}

        {wayCandidates.length > 0 && (
          <div className={`mb-3 rounded-xl border p-3 ${t.subCard}`}>
            <h3 className="mb-2 text-xs font-bold">בחירת קטע דרך</h3>
            <div className="space-y-1.5">
              {wayCandidates.map((candidate) => {
                const existing = findAnnotationForWay(annotations, candidate.wayId);
                return (
                  <button
                    key={candidate.wayId}
                    type="button"
                    onClick={() => onResolveCandidate(candidate)}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-right text-xs ${t.pillBtn}`}
                  >
                    <span className="flex items-center gap-1.5">
                      {existing && (
                        <span className="h-3 w-3 rounded-full" style={{ backgroundColor: existing.color }} />
                      )}
                      {existing ? `שביל ${existing.number}` : candidate.highwayClass}
                      {!existing && candidate.highwaySubclass ? ` · ${candidate.highwaySubclass}` : ''}
                    </span>
                    <span dir="ltr" className={t.muted}>
                      {candidate.wayId.replace('osm:way:', '#')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {isEditing && (
          <div className="space-y-3">
            {isDeletedTrail && (
              <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-500">
                סימון זה נמחק. שמירה תשחזר אותו למפה.
              </p>
            )}
            {isStale && (
              <p className="flex items-center gap-1 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                חלק מהקטעים לא נמצאו בגרסת המפה הנוכחית.
              </p>
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">קטעי דרך ({wayIds.length})</span>
                <button
                  type="button"
                  onClick={() => setAddWaysMode((value) => !value)}
                  aria-pressed={addWaysMode}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] ${
                    addWaysMode ? 'border-emerald-500 bg-emerald-600 text-white' : t.pillBtn
                  }`}
                >
                  <Plus className="h-3 w-3" />
                  {addWaysMode ? 'לחץ על קטעים במפה…' : 'הוסף קטעים'}
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {wayIds.map((wayId) => (
                  <span key={wayId} className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-1 text-[10px] ${t.pillBtn}`} dir="ltr">
                    <span className="truncate">{wayId.replace('osm:way:', '#')}</span>
                    {!ways.has(wayId) && <span className="text-amber-500" title="נדרשת בחירה מחדש במפה">לא נטען</span>}
                    {wayIds.length > 1 && (
                      <button type="button" onClick={() => removeWay(wayId)} className="rounded-full p-0.5" aria-label={`הסר ${wayId}`}>
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>

            <fieldset>
              <legend className="mb-1.5 text-xs font-semibold">צבע השביל</legend>
              <div className="flex flex-wrap gap-2">
                {TRAIL_ANNOTATION_COLORS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setColor(item.value)}
                    className={`flex h-8 w-8 items-center justify-center rounded-full border-2 ${color === item.value ? 'border-current ring-2 ring-emerald-500/50' : 'border-transparent'}`}
                    style={{ backgroundColor: item.value }}
                    aria-label={item.label}
                    aria-pressed={color === item.value}
                  >
                    {color === item.value && <Check className="h-4 w-4 text-white" />}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="block text-xs font-semibold">
              מספר שביל
              <input
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                maxLength={32}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
                placeholder="לדוגמה: 001 או 12A"
                dir="auto"
              />
            </label>
            <label className="block text-xs font-semibold">
              תיאור
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={4000}
                rows={3}
                className={`mt-1 w-full resize-y rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
                placeholder="תיאור השביל"
                dir="auto"
              />
            </label>
            <label className="block text-xs font-semibold">
              סיבת השינוי (רשות)
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${t.fieldBox}`}
                placeholder="למשל: תיקון צבע ומספר"
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
                disabled={
                  isSaving ||
                  !isOnline ||
                  !firebaseAvailable ||
                  wayIds.length === 0 ||
                  wayIds.some((id) => !ways.has(id))
                }
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-45"
              >
                {isSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isDeletedTrail ? 'שחזור ושמירה' : trailId ? 'עדכון' : 'שמירה'}
              </button>
              {trailId && (
                <button
                  type="button"
                  onClick={toggleHistory}
                  aria-pressed={showHistoryView}
                  className={`rounded-lg border px-3 py-2 text-xs ${t.pillBtn}`}
                  title="היסטוריית שינויים"
                >
                  <Clock3 className="h-4 w-4" />
                </button>
              )}
              {trailId && !isDeletedTrail && (
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  disabled={isSaving || !isOnline}
                  className="rounded-lg border border-rose-500/40 px-3 py-2 text-xs text-rose-500 disabled:opacity-45"
                  title="מחיקה עם רישום בהיסטוריה"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            {!isOnline && <p className="text-[11px] text-amber-500">אופליין: הטיוטה נשמרת במכשיר, השמירה תדרוש חיבור.</p>}

            {showHistoryView && trailId && (
              <section className={`rounded-xl border p-3 ${t.subCard}`}>
                <h3 className="mb-2 text-xs font-bold">היסטוריית שינויים</h3>
                {historyError && <p role="alert" className="text-xs text-amber-500">{historyError}</p>}
                {historyEvents.map((event) => (
                  <div key={event.id} className={`border-t py-2 text-[11px] ${t.divider}`}>
                    <p className="font-semibold">{OPERATION_LABELS[event.operation] ?? event.operation} · {historyChanges(event).join(', ')}</p>
                    <p className={t.muted}>{formatTime(event.occurredAt)} · {shortUid(event.actorUid)}</p>
                    {event.reason && <p dir="auto" className="mt-0.5">{event.reason}</p>}
                  </div>
                ))}
                {loadingHistory && <LoaderCircle className="mx-auto my-2 h-4 w-4 animate-spin" />}
                {historyCursor !== null && (
                  <button
                    type="button"
                    onClick={() => void loadHistoryPage(trailId, historyCursor)}
                    disabled={loadingHistory}
                    className={`mt-2 w-full rounded-lg border px-2 py-1.5 text-xs ${t.pillBtn}`}
                  >
                    טעינת שינויים קודמים
                  </button>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
