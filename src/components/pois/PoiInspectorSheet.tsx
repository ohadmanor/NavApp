import React, { useState, useEffect } from 'react';
import {
  X,
  Droplets,
  Compass,
  Tent,
  AlertTriangle,
  Mountain,
  MapPin,
  Save,
  Navigation,
  ExternalLink,
} from 'lucide-react';
import type { PoiRecord } from '../../core/db/NavDatabase';
import { PoiManager } from '../../core/pois/PoiManager';
import { ElevationService } from '../../core/navigation/ElevationService';

interface PoiInspectorSheetProps {
  poi: PoiRecord | null;
  onClose: () => void;
  onFlyTo: (lon: number, lat: number) => void;
  onPoiUpdated: (updated: PoiRecord) => void;
}

export const PoiInspectorSheet: React.FC<PoiInspectorSheetProps> = ({
  poi,
  onClose,
  onFlyTo,
  onPoiUpdated,
}) => {
  const [noteText, setNoteText] = useState('');
  const [sampledDemEle, setSampledDemEle] = useState<number | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);

  useEffect(() => {
    if (!poi) return;
    setNoteText(poi.userNotes || '');
    setSavedBanner(false);
    setSampledDemEle(poi.ele);

    // Sample live DEM altitude from Israel.dem.pmtiles if not already set
    ElevationService.getElevationAt(poi.lon, poi.lat, 12).then((ele) => {
      if (ele !== null) setSampledDemEle(ele);
    });
  }, [poi]);

  if (!poi) return null;

  const hasHebrew = (s?: string | null) => Boolean(s && /[\u0590-\u05FF]/.test(s));
  const displayName = hasHebrew(poi.nameHe)
    ? poi.nameHe
    : hasHebrew(poi.name)
      ? poi.name
      : poi.nameEn || poi.nameHe || poi.name;
  const displayDesc = hasHebrew(poi.descHe)
    ? poi.descHe
    : poi.descEn || poi.descHe || '';

  const getCategoryMeta = (cat: PoiRecord['category']) => {
    switch (cat) {
      case 'water':
        return {
          label: 'מקור מים / מעיין / גב',
          bg: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
          icon: <Droplets className="w-4 h-4 text-sky-400" />,
        };
      case 'offroad':
        return {
          label: 'מעלה / עבירות 4x4',
          bg: 'bg-red-500/20 text-red-300 border-red-500/40',
          icon: <AlertTriangle className="w-4 h-4 text-red-400" />,
        };
      case 'campsite':
        return {
          label: 'חניון לילה',
          bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
          icon: <Tent className="w-4 h-4 text-emerald-400" />,
        };
      case 'peak':
        return {
          label: 'פסגה / הר',
          bg: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
          icon: <Mountain className="w-4 h-4 text-purple-400" />,
        };
      default:
        return {
          label: 'אתר היסטורי / מערה / תצפית',
          bg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
          icon: <Compass className="w-4 h-4 text-amber-400" />,
        };
    }
  };

  const meta = getCategoryMeta(poi.category);

  const handleSaveNote = async () => {
    const updated = await PoiManager.saveUserNote(poi.id, noteText);
    if (updated) {
      onPoiUpdated(updated);
      setSavedBanner(true);
      setTimeout(() => setSavedBanner(false), 2500);
    }
  };

  return (
    <div
      dir="rtl"
      className="fixed bottom-4 right-4 left-4 md:left-auto md:w-[430px] z-40 bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl p-5 text-slate-100 animate-in fade-in slide-in-from-bottom-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${meta.bg}`}>
            {meta.icon}
            <span>{meta.label}</span>
          </div>
          <h3 className="text-lg font-bold text-white leading-snug" dir="auto">
            {displayName}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Coordinates & DEM Altitude Bar */}
      <div className="grid grid-cols-3 gap-2 mt-3.5 p-2.5 rounded-xl bg-slate-950/70 border border-slate-800 text-xs">
        <div>
          <span className="text-slate-400 block">גובה (Israel.dem)</span>
          <span className="font-mono font-semibold text-emerald-400">
            {sampledDemEle !== null ? `${sampledDemEle} m` : 'N/A'}
          </span>
        </div>
        <div>
          <span className="text-slate-400 block">קואורדינטות</span>
          <span className="font-mono text-slate-200">
            {poi.lat.toFixed(4)}, {poi.lon.toFixed(4)}
          </span>
        </div>
        <div>
          <span className="text-slate-400 block">מקור המידע</span>
          <span className="text-slate-300 truncate block" title={poi.source}>
            {poi.source}
          </span>
        </div>
      </div>

      {/* Special Badges for Water Status or 4x4 Difficulty */}
      {poi.waterStatus && (
        <div className="mt-3 p-2.5 rounded-xl bg-sky-950/60 border border-sky-800/60 text-xs text-sky-200 flex items-center gap-2" dir="auto">
          <Droplets className="w-4 h-4 text-sky-400 shrink-0" />
          <span><strong>מצב מים:</strong> {poi.waterStatus}</span>
        </div>
      )}

      {poi.difficulty4x4 && (
        <div className="mt-3 p-2.5 rounded-xl bg-red-950/60 border border-red-800/60 text-xs text-red-200 flex items-center gap-2" dir="auto">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <span><strong>דירוג עבירות 4x4:</strong> {poi.difficulty4x4}</span>
        </div>
      )}

      {/* Description (Hebrew if available, otherwise English) */}
      <div className="mt-3.5 space-y-2 max-h-40 overflow-y-auto pr-1">
        {displayDesc && (
          <p className="text-sm text-slate-200 leading-relaxed" dir="auto">
            {displayDesc}
          </p>
        )}
      </div>

      {/* Offline Field Notes (Saved in Dexie.js IndexedDB) */}
      <div className="mt-4 pt-3 border-t border-slate-800">
        <label className="block text-xs font-semibold text-slate-300 mb-1.5" dir="rtl">
          הערות שטח אישיות / דיווח מטיילים (נשמר אופליין במכשיר):
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            dir="auto"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="לדוגמה: המעיין מלא ונקי / מדרגת סלע גבוהה..."
            className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={handleSaveNote}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1 transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            <span>שמור</span>
          </button>
        </div>
        {savedBanner && (
          <p className="text-xs text-emerald-400 mt-1">✓ נשמר בהצלחה בזיכרון המקומי (IndexedDB)</p>
        )}
      </div>

      {/* Action Buttons */}
      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          onClick={() => onFlyTo(poi.lon, poi.lat)}
          className="flex-1 py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-100 flex items-center justify-center gap-1.5 transition-colors"
        >
          <Navigation className="w-3.5 h-3.5 text-emerald-400" />
          <span>מרכז מפה לנקודה (Zoom 14)</span>
        </button>

        {poi.wikipedia && (
          <a
            href={`https://he.wikipedia.org/wiki/${encodeURIComponent(
              poi.wikipedia.replace(/^he:/, '')
            )}`}
            target="_blank"
            rel="noreferrer"
            className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-sky-300 flex items-center gap-1.5 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>ויקיפדיה</span>
          </a>
        )}
      </div>
    </div>
  );
};

