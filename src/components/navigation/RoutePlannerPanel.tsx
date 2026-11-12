import React from 'react';
import {
  X,
  Car,
  Footprints,
  Bike,
  Undo2,
  Trash2,
  Check,
  AlertTriangle,
  Cloud,
  CloudOff,
  LogIn,
  LogOut,
  Loader2,
  Route as RouteIcon,
} from 'lucide-react';
import {
  PLANNING_MODE_META,
  type PlanningMode,
} from '../../core/routing/RoutingProfiles';
import type { SnappedPoint } from '../../core/routing/ClientRoutePlannerEngine';
import type { PlannedWaypoint } from '../../core/db/NavDatabase';
import type { NavUser } from '../../core/firebase/AuthService';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

export interface PlannedLeg {
  coordinates: Array<[number, number]>;
  distanceKm: number;
  legType: 'network' | 'straight';
  roadLabels: string[];
}

interface RoutePlannerPanelProps {
  theme: MapTheme;
  mode: PlanningMode;
  routeName: string;
  waypoints: PlannedWaypoint[];
  legs: PlannedLeg[];
  totalDistanceKm: number;
  ascentMeters: number;
  descentMeters: number;
  isRoutingLeg: boolean;
  isSaving: boolean;
  isEditingExisting?: boolean;
  editingRouteColor?: string;
  disconnectedCandidate: SnappedPoint | null;
  currentUser: NavUser | null;
  firebaseAvailable: boolean;
  isAuthBusy: boolean;
  pendingCloudSyncCount: number;
  onChangeMode: (mode: PlanningMode) => void;
  onChangeRouteName: (name: string) => void;
  onConfirmStraightLine: () => void;
  onCancelDisconnected: () => void;
  onUndoLastPoint: () => void;
  onRemoveWaypoint?: (index: number) => void;
  onToggleLegType?: (legIndex: number) => void;
  onClearPlan: () => void;
  onCancelEdit?: () => void;
  onFinishAndSave: () => void;
  onSignInGoogle: () => void;
  onSignOutGoogle: () => void;
  onSyncPendingNow: () => void;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{
  id: PlanningMode;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: '4x4', label: 'רכב 4x4', icon: <Car className="w-4 h-4" /> },
  { id: 'foot', label: 'הליכה', icon: <Footprints className="w-4 h-4" /> },
  { id: 'bicycle', label: 'אופניים', icon: <Bike className="w-4 h-4" /> },
];

export const RoutePlannerPanel: React.FC<RoutePlannerPanelProps> = ({
  theme,
  mode,
  routeName,
  waypoints,
  legs,
  totalDistanceKm,
  ascentMeters,
  descentMeters,
  isRoutingLeg,
  isSaving,
  isEditingExisting = false,
  editingRouteColor,
  disconnectedCandidate,
  currentUser,
  firebaseAvailable,
  isAuthBusy,
  pendingCloudSyncCount,
  onChangeMode,
  onChangeRouteName,
  onConfirmStraightLine,
  onCancelDisconnected,
  onUndoLastPoint,
  onRemoveWaypoint,
  onToggleLegType,
  onClearPlan,
  onCancelEdit,
  onFinishAndSave,
  onSignInGoogle,
  onSignOutGoogle,
  onSyncPendingNow,
  onClose,
}) => {
  const t = getSurfaceTheme(theme);
  const modeMeta = PLANNING_MODE_META[mode];
  const accentColor = editingRouteColor || modeMeta.color;

  return (
    <div dir="rtl" className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: accentColor }}
            />
            <span className="text-xs font-bold" style={{ color: accentColor }}>
              {isEditingExisting
                ? `עריכת מסלול קיים • ${modeMeta.labelHe}`
                : `מתכנן מסלול חכם • ${modeMeta.labelHe}`}
            </span>
          </div>
          <p className={`text-xs mt-0.5 ${t.muted}`}>
            לחץ על המפה להוספת נקודה • דאבל-קליק לסיום
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isEditingExisting && onCancelEdit && (
            <button
              type="button"
              onClick={onCancelEdit}
              className={`px-2 py-1 rounded-lg border text-[11px] font-bold text-amber-500 ${t.pillBtn}`}
              title="בטל עריכה וחזור לרשימת המסלולים"
            >
              בטל עריכה
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
            title="סגור מתכנן מסלול"
            aria-label="סגור מתכנן מסלול"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Mode Selector: 4x4 / Foot / Bicycle */}
      <div className="grid grid-cols-3 gap-1.5">
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.id;
          const color = PLANNING_MODE_META[opt.id].color;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onChangeMode(opt.id)}
              className={`py-2 px-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-all ${
                active ? 'text-white shadow-sm' : t.subCard
              }`}
              style={
                active
                  ? { backgroundColor: color, borderColor: color }
                  : undefined
              }
            >
              {opt.icon}
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {/* Route Name */}
      <input
        id="route-planner-name"
        name="routePlannerName"
        type="text"
        dir="auto"
        value={routeName}
        onChange={(e) => onChangeRouteName(e.target.value)}
        placeholder={`שם המסלול (ברירת מחדל: מסלול ${modeMeta.shortLabelHe})`}
        className={`w-full rounded-xl border px-3 py-2 text-xs focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
      />

      {/* Live Telemetry */}
      <div className={`grid grid-cols-3 gap-2 p-2.5 rounded-xl border text-xs ${t.subCard}`}>
        <div>
          <span className={`block ${t.muted}`}>מרחק כולל</span>
          <span
            dir="ltr"
            className="font-mono font-bold text-sm inline-block"
            style={{ color: accentColor }}
          >
            {totalDistanceKm.toFixed(2)} km
          </span>
        </div>
        <div>
          <span className={`block ${t.muted}`}>טיפוס / ירידה</span>
          <span dir="ltr" className="font-mono font-bold inline-block">
            <span className="text-emerald-500">+{ascentMeters}m</span>
            <span className="opacity-35 mx-1">/</span>
            <span className="text-amber-500">-{descentMeters}m</span>
          </span>
        </div>
        <div>
          <span className={`block ${t.muted}`}>נקודות ציר</span>
          <span className="font-mono font-bold text-sm">{waypoints.length}</span>
        </div>
      </div>

      {/* Routing Calculation Indicator */}
      {isRoutingLeg && (
        <div className="px-3 py-2 rounded-xl border border-sky-500/40 bg-sky-500/10 text-sky-400 text-xs font-semibold flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
          <span>מחשב מסלול על גבי רשת הדרכים והשבילים...</span>
        </div>
      )}

      {/* Disconnected Network Prompt (One-Click Straight Line Fallback) */}
      {disconnectedCandidate && (
        <div className="p-3 rounded-xl border border-amber-500/60 bg-amber-500/15 space-y-2 text-xs">
          <div className="flex items-start gap-2 font-bold text-amber-500">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              לא נמצא חיבור רציף ברשת הדרכים לנקודה שנבחרה ({disconnectedCandidate.roadLabel}).
            </span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirmStraightLine}
              className="flex-1 py-2 px-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold transition-colors"
            >
              חבר בקו ישר
            </button>
            <button
              type="button"
              onClick={onCancelDisconnected}
              className={`px-3 py-2 rounded-xl border font-bold ${t.pillBtn}`}
            >
              בטל נקודה
            </button>
          </div>
        </div>
      )}

      {/* Snapped Waypoints List with Per-Point Delete & Leg Mode Toggle */}
      {waypoints.length > 0 ? (
        <div className={`rounded-xl border divide-y max-h-44 overflow-y-auto ${t.subCard} ${t.divider}`}>
          {waypoints.map((wp, idx) => {
            const incomingLeg = idx > 0 ? legs[idx - 1] : null;
            return (
              <div
                key={`${wp.lon}-${wp.lat}-${idx}`}
                className="px-3 py-1.5 text-xs flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-5 h-5 rounded-full text-[10px] font-bold text-white flex items-center justify-center shrink-0"
                    style={{
                      backgroundColor:
                        idx === 0
                          ? '#10b981'
                          : idx === waypoints.length - 1
                            ? '#ef4444'
                            : accentColor,
                    }}
                  >
                    {idx + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold truncate" dir="auto">
                      {wp.roadLabel || 'נקודה על ציר'}
                    </div>
                    {incomingLeg && (
                      <div className={`text-[11px] flex items-center gap-1.5 flex-wrap ${t.muted}`}>
                        <span dir="ltr" className="font-mono">
                          +{incomingLeg.distanceKm.toFixed(2)} km
                        </span>
                        <span>•</span>
                        {onToggleLegType ? (
                          <button
                            type="button"
                            disabled={isRoutingLeg || isSaving}
                            onClick={() => onToggleLegType(idx - 1)}
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold transition-colors disabled:opacity-40 ${
                              incomingLeg.legType === 'straight'
                                ? 'border-amber-500/50 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20'
                                : 'border-blue-500/40 text-blue-500 bg-blue-500/10 hover:bg-blue-500/20'
                            }`}
                            title="לחץ להחלפה בין ניתוב רשת דרכים לקו ישר"
                          >
                            <RouteIcon className="w-2.5 h-2.5" />
                            <span>
                              {incomingLeg.legType === 'straight' ? 'קו ישר' : 'רשת דרכים'}
                            </span>
                          </button>
                        ) : (
                          <span>
                            {incomingLeg.legType === 'straight' ? 'קו ישר' : 'רשת דרכים'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {onRemoveWaypoint && (
                  <button
                    type="button"
                    disabled={isRoutingLeg || isSaving}
                    onClick={() => onRemoveWaypoint(idx)}
                    className={`p-1 rounded-md text-red-400 hover:text-red-500 hover:bg-red-500/10 disabled:opacity-35 shrink-0`}
                    title={`הסר נקודה ${idx + 1}`}
                    aria-label={`הסר נקודה ${idx + 1}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={`p-3 rounded-xl border border-dashed text-xs text-center ${t.subCard} ${t.muted}`}>
          הקלק על המפה כדי להצמיד את נקודת ההתחלה לכביש או לשביל הקרוב
        </div>
      )}

      {/* Gmail Account & Firebase planing_tracks Sync Card */}
      <div className={`p-2.5 rounded-xl border text-xs space-y-2 ${t.subCard}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {currentUser ? (
              <Cloud className="w-4 h-4 text-emerald-500 shrink-0" />
            ) : (
              <CloudOff className={`w-4 h-4 shrink-0 ${t.muted}`} />
            )}
            <div className="min-w-0">
              <div className="font-bold leading-snug break-words">
                {currentUser ? (
                  currentUser.email || currentUser.displayName || 'מחובר עם Google'
                ) : (
                  <>
                    שמירה מקומית + <span dir="ltr">Firebase (planing_tracks)</span>
                  </>
                )}
              </div>
              <div className={`text-[11px] leading-snug ${t.muted}`}>
                {!firebaseAvailable
                  ? 'מצב מקומי בלבד (חסר קובץ .env של Firebase)'
                  : currentUser
                    ? 'GPX + JSON נשמרים אישית תחת חשבון ה-Gmail שלך'
                    : 'התחבר עם Gmail לשמירה וגיבוי בענן לפי משתמש'}
              </div>
            </div>
          </div>

          {firebaseAvailable &&
            (currentUser ? (
              <button
                type="button"
                disabled={isAuthBusy}
                onClick={onSignOutGoogle}
                className={`px-2.5 py-1.5 rounded-lg border text-[11px] font-bold flex items-center gap-1 shrink-0 ${t.pillBtn}`}
                title="התנתק מחשבון Google"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>יציאה</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={isAuthBusy}
                onClick={onSignInGoogle}
                className="px-2.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white text-[11px] font-bold flex items-center gap-1 shrink-0"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span>{isAuthBusy ? 'מתחבר...' : 'כניסה עם Gmail'}</span>
              </button>
            ))}
        </div>

        {currentUser && pendingCloudSyncCount > 0 && (
          <button
            type="button"
            onClick={onSyncPendingNow}
            className="w-full py-1.5 px-2.5 rounded-lg bg-emerald-600/15 border border-emerald-500/40 text-emerald-500 font-bold text-[11px] hover:bg-emerald-600/25 transition-colors"
          >
            סנכרן {pendingCloudSyncCount} מסלולים ממתינים ל-Firebase
          </button>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={waypoints.length === 0 || isRoutingLeg || isSaving}
          onClick={onUndoLastPoint}
          className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 disabled:opacity-40 ${t.pillBtn}`}
          title="בטל נקודה אחרונה"
        >
          <Undo2 className="w-4 h-4" />
          <span>חזור</span>
        </button>

        <button
          type="button"
          disabled={waypoints.length === 0 || isRoutingLeg || isSaving}
          onClick={onClearPlan}
          className={`px-3 py-2.5 rounded-xl border text-xs font-bold text-red-500 flex items-center gap-1 disabled:opacity-40 ${t.pillBtn}`}
          title="נקה תכנון"
          aria-label="נקה תכנון"
        >
          <Trash2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          disabled={waypoints.length < 2 || isRoutingLeg || isSaving}
          onClick={onFinishAndSave}
          className="flex-1 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-colors"
        >
          {isSaving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          <span>
            {isSaving
              ? 'שומר...'
              : isEditingExisting
                ? 'עדכן ושמור מסלול'
                : 'סיים ושמור מסלול'}
          </span>
        </button>
      </div>
    </div>
  );
};
