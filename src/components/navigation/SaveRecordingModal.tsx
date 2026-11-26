import React, { useEffect, useState } from 'react';
import { Download, Loader2, Play, Save, Trash2 } from 'lucide-react';
import { formatDuration } from './TrackRecorderPanel';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface SaveRecordingModalProps {
  isOpen: boolean;
  theme: MapTheme;
  trigger: 'stop-recording' | 'stop-navigation';
  initialName: string;
  distanceKm: number;
  ascentMeters: number;
  durationSeconds: number;
  pointsCount: number;
  startedAt: string;
  isSaving: boolean;
  onConfirmSave: (params: { name: string; notes: string; exportGpx: boolean }) => void | Promise<void>;
  onContinueRecording?: () => void;
  onDiscard: () => void;
}

export const SaveRecordingModal: React.FC<SaveRecordingModalProps> = ({
  isOpen,
  theme,
  trigger,
  initialName,
  distanceKm,
  ascentMeters,
  durationSeconds,
  pointsCount,
  startedAt,
  isSaving,
  onConfirmSave,
  onContinueRecording,
  onDiscard,
}) => {
  const t = getSurfaceTheme(theme);
  const [name, setName] = useState(initialName);
  const [notes, setNotes] = useState('');
  const [exportGpx, setExportGpx] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setName(initialName);
      setNotes('');
      setExportGpx(false);
    }
  }, [isOpen, initialName]);

  if (!isOpen) return null;

  const cleanName = name.trim();
  const formattedStart = (() => {
    const d = new Date(startedAt);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString('he-IL', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
  })();

  const handleSubmit = (e: React.FormEvent, forceExportGpx?: boolean) => {
    e.preventDefault();
    if (!cleanName || isSaving) return;
    void onConfirmSave({
      name: cleanName,
      notes: notes.trim(),
      exportGpx: forceExportGpx ?? exportGpx,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/65 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="שמירת הקלטת ניווט"
    >
      <form
        dir="rtl"
        onSubmit={(e) => handleSubmit(e)}
        className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden flex flex-col ${t.panelSolid}`}
      >
        <div className={`px-4 py-3 border-b flex items-center gap-2.5 ${t.divider}`}>
          <div className="w-9 h-9 rounded-xl bg-rose-500/15 text-rose-500 flex items-center justify-center shrink-0">
            <Save className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold leading-tight">
              {trigger === 'stop-navigation'
                ? 'הניווט הופסק — שמירת הקלטה'
                : 'סיום הקלטת ניווט'}
            </h3>
            <p className={`text-[11px] ${t.muted}`}>
              תן שם להקלטה כדי לשמור אותה באזור ההקלטות האישי שלך
              {formattedStart ? ` • התחלה ${formattedStart}` : ''}
            </p>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <div className={`grid grid-cols-3 gap-2 p-2.5 rounded-xl border text-xs ${t.subCard}`}>
            <div>
              <span className={`block text-[11px] ${t.muted}`}>מרחק</span>
              <span dir="ltr" className="font-mono font-bold text-sky-500 inline-block">
                {distanceKm.toFixed(2)} km
              </span>
            </div>
            <div>
              <span className={`block text-[11px] ${t.muted}`}>זמן</span>
              <span dir="ltr" className="font-mono font-bold inline-block">
                {formatDuration(durationSeconds)}
              </span>
            </div>
            <div>
              <span className={`block text-[11px] ${t.muted}`}>טיפוס / נקודות</span>
              <span dir="ltr" className="font-mono font-bold text-emerald-500 inline-block">
                +{Math.round(ascentMeters)}m • {pointsCount}
              </span>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="recording-save-name" className="block text-xs font-bold">
              שם ההקלטה
            </label>
            <input
              id="recording-save-name"
              name="recordingSaveName"
              type="text"
              dir="auto"
              autoFocus
              required
              value={name}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setName(e.target.value)}
              placeholder="לדוגמה: נחל עקב 4x4 - בוקר שישי"
              className={`w-full rounded-xl border px-3 py-2 text-xs font-semibold focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="recording-save-notes" className={`block text-xs font-bold ${t.muted}`}>
              הערות לתחקור ועדכון המפה (אופציונלי)
            </label>
            <textarea
              id="recording-save-notes"
              name="recordingSaveNotes"
              dir="auto"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="שביל חדש לעדכון ב-OSM, שער נעול, מעבר מים..."
              className={`w-full rounded-xl border px-3 py-2 text-xs resize-none focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
            />
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              id="recording-save-export-gpx"
              name="recordingSaveExportGpx"
              type="checkbox"
              checked={exportGpx}
              onChange={(e) => setExportGpx(e.target.checked)}
              className="rounded border-slate-500 text-sky-500"
            />
            <span>ייצא מיד גם כקובץ GPX למכשיר</span>
          </label>

          <div className={`px-3 py-2 rounded-xl border text-[11px] ${t.subCard} ${t.muted}`}>
            ההקלטה תישמר בחשבונך תחת <strong className="text-sky-500">מסלולים ← הקלטות ניווט</strong> ותסונכרן לענן כשהחיבור זמין.
          </div>
        </div>

        <div className={`px-4 py-3 border-t flex flex-wrap items-center justify-between gap-2 ${t.divider}`}>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={isSaving}
              onClick={onDiscard}
              className={`px-2.5 py-2 rounded-xl border text-xs font-bold text-red-500 inline-flex items-center gap-1 ${t.pillBtn}`}
              title="מחק הקלטה זו ללא שמירה"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>מחק</span>
            </button>
            {trigger === 'stop-recording' && onContinueRecording && (
              <button
                type="button"
                disabled={isSaving}
                onClick={onContinueRecording}
                className={`px-2.5 py-2 rounded-xl border text-xs font-bold inline-flex items-center gap-1 ${t.pillBtn}`}
              >
                <Play className="w-3.5 h-3.5 text-emerald-500" />
                <span>המשך הקלטה</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {!exportGpx && (
              <button
                type="button"
                disabled={!cleanName || isSaving}
                onClick={(e) => handleSubmit(e, true)}
                className="px-3 py-2 rounded-xl border border-sky-500/50 bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-45 text-sky-400 text-xs font-bold inline-flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                <span>שמור + GPX</span>
              </button>
            )}
            <button
              type="submit"
              disabled={!cleanName || isSaving}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-45 text-white text-xs font-bold inline-flex items-center gap-1.5"
            >
              {isSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              <span>{exportGpx ? 'שמור וייצא GPX' : 'שמור הקלטה'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
