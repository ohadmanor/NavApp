import React from 'react';
import { X, Play, Pause, Save, MapPin, Trash2 } from 'lucide-react';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface TrackRecorderPanelProps {
  theme: MapTheme;
  isRecording: boolean;
  isPaused: boolean;
  elapsedSeconds: number;
  distanceKm: number;
  ascentMeters: number;
  currentElevation: number | null;
  pointsCount: number;
  onStartOrResume: () => void;
  onPause: () => void;
  onSaveRoute: () => void;
  onDiscard: () => void;
  onDropWaypoint: () => void;
  onClose: () => void;
}

export function formatDuration(seconds: number): string {
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export const TrackRecorderPanel: React.FC<TrackRecorderPanelProps> = ({
  theme,
  isRecording,
  isPaused,
  elapsedSeconds,
  distanceKm,
  ascentMeters,
  currentElevation,
  pointsCount,
  onStartOrResume,
  onPause,
  onSaveRoute,
  onDiscard,
  onDropWaypoint,
  onClose,
}) => {
  const t = getSurfaceTheme(theme);

  return (
    <div dir="rtl" className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`w-3 h-3 rounded-full ${
              !isRecording
                ? 'bg-slate-400'
                : isPaused
                  ? 'bg-amber-500'
                  : 'bg-rose-500 animate-pulse'
            }`}
          />
          <div>
            <h3 className="text-base font-bold leading-tight">
              {!isRecording
                ? 'הקלטת מסלול GPS'
                : isPaused
                  ? 'הקלטה מושהית'
                  : 'מקליט מסלול שטח...'}
            </h3>
            <p className={`text-xs ${t.muted}`}>{pointsCount} נקודות דגימה בנתיב</p>
          </div>
        </div>
        <button onClick={onClose} className={`p-1.5 rounded-lg border ${t.pillBtn}`} title="סגור">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* High-Contrast Outdoor Trip Computer Grid */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className={`p-3 rounded-xl border ${t.subCard}`}>
          <span className={`text-xs block ${t.muted}`}>זמן תנועה</span>
          <span className="font-mono font-bold text-lg tabular-nums">
            {formatDuration(elapsedSeconds)}
          </span>
        </div>
        <div className={`p-3 rounded-xl border ${t.subCard}`}>
          <span className={`text-xs block ${t.muted}`}>מרחק שהוקלט</span>
          <span className="font-mono font-bold text-lg text-sky-500 tabular-nums">
            {distanceKm.toFixed(2)} km
          </span>
        </div>
        <div className={`p-3 rounded-xl border ${t.subCard}`}>
          <span className={`text-xs block ${t.muted}`}>טיפוס מצטבר</span>
          <span className="font-mono font-bold text-base text-emerald-500 tabular-nums">
            +{Math.round(ascentMeters)} m
          </span>
        </div>
        <div className={`p-3 rounded-xl border ${t.subCard}`}>
          <span className={`text-xs block ${t.muted}`}>גובה נוכחי (DEM)</span>
          <span className="font-mono font-bold text-base tabular-nums">
            {currentElevation !== null ? `${currentElevation} m` : '---'}
          </span>
        </div>
      </div>

      {/* Controls */}
      {!isRecording ? (
        <button
          onClick={onStartOrResume}
          className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition-colors"
        >
          <Play className="w-4 h-4" />
          <span>התחל הקלטת מסלול GPS</span>
        </button>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            {isPaused ? (
              <button
                onClick={onStartOrResume}
                className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5" />
                <span>המשך הקלטה</span>
              </button>
            ) : (
              <button
                onClick={onPause}
                className={`flex-1 py-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 ${t.pillBtn}`}
              >
                <Pause className="w-3.5 h-3.5 text-amber-500" />
                <span>השהה</span>
              </button>
            )}

            <button
              onClick={onDropWaypoint}
              className="flex-1 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold flex items-center justify-center gap-1.5"
            >
              <MapPin className="w-3.5 h-3.5" />
              <span>דווח נקודה</span>
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={onSaveRoute}
              disabled={pointsCount < 2}
              className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold flex items-center justify-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              <span>שמור כמסלול + GPX</span>
            </button>
            <button
              onClick={onDiscard}
              className={`px-3 py-2.5 rounded-xl border text-xs font-bold text-red-500 flex items-center justify-center ${t.pillBtn}`}
              title="בטל ונקה הקלטה"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
