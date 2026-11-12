import React, { useState, useEffect } from 'react';
import * as turf from '@turf/turf';
import {
  X,
  Droplets,
  AlertTriangle,
  Save,
  Navigation,
  ExternalLink,
  Copy,
  LocateFixed,
} from 'lucide-react';
import type { PoiRecord } from '../../core/db/NavDatabase';
import { PoiManager } from '../../core/pois/PoiManager';
import { ElevationService } from '../../core/navigation/ElevationService';
import { MilitaryGridService } from '../../core/navigation/MilitaryGridService';
import { getSurfaceTheme, POI_CATEGORY_META, type MapTheme } from '../ui/themeTokens';

interface PoiInspectorSheetProps {
  poi: PoiRecord | null;
  theme: MapTheme;
  referenceCoord: { lon: number; lat: number };
  onClose: () => void;
  onFlyTo: (lon: number, lat: number) => void;
  onNavigateToPoi?: (poi: PoiRecord) => void;
  onPoiUpdated: (updated: PoiRecord) => void;
  onNotify?: (msg: string) => void;
  embedded?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  compactNavigating?: boolean;
  onOpenFullPlanning?: () => void;
}

function buildWikipediaHref(raw: string): string {
  const match = /^([a-z]{2,3}):(.*)$/i.exec(raw.trim());
  const lang = match ? match[1].toLowerCase() : 'he';
  const target = (match ? match[2] : raw).trim();
  if (target.startsWith('?curid=') || /^curid=\d+$/i.test(target)) {
    const query = target.startsWith('?') ? target : `?${target}`;
    return `https://${lang}.wikipedia.org/${query}`;
  }
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(target)}`;
}

function getSafeExternalHref(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // ignore malformed URL
  }
  return null;
}

export const PoiInspectorSheet: React.FC<PoiInspectorSheetProps> = ({
  poi,
  theme,
  referenceCoord,
  onClose,
  onFlyTo,
  onNavigateToPoi,
  onPoiUpdated,
  onNotify,
  embedded = false,
  isExpanded = true,
  onToggleExpand,
  compactNavigating = false,
  onOpenFullPlanning,
}) => {
  const [noteText, setNoteText] = useState('');
  const [sampledDemEle, setSampledDemEle] = useState<number | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);

  useEffect(() => {
    if (!poi) return;
    setNoteText(poi.userNotes || '');
    setSavedBanner(false);
    setSampledDemEle(poi.ele);

    ElevationService.getElevationAt(poi.lon, poi.lat, 12).then((ele) => {
      if (ele !== null) setSampledDemEle(ele);
    });
  }, [poi]);

  if (!poi) return null;

  const t = getSurfaceTheme(theme);
  const hasHebrew = (s?: string | null) => Boolean(s && /[\u0590-\u05FF]/.test(s));
  const displayName = hasHebrew(poi.nameHe)
    ? poi.nameHe
    : hasHebrew(poi.name)
      ? poi.name
      : poi.nameEn || poi.nameHe || poi.name;
  const displayDesc = hasHebrew(poi.descHe) ? poi.descHe : poi.descEn || poi.descHe || '';
  const meta = POI_CATEGORY_META[poi.category] || POI_CATEGORY_META.heritage;

  const distanceKm = turf.distance(
    turf.point([referenceCoord.lon, referenceCoord.lat]),
    turf.point([poi.lon, poi.lat]),
    { units: 'kilometers' }
  );
  const milCoords = MilitaryGridService.toMilitaryCoords(poi.lon, poi.lat);

  const handleCopyCoords = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    onNotify?.(`הועתק ללוח: ${text}`);
  };

  const handleSaveNote = async () => {
    const updated = await PoiManager.saveUserNote(poi.id, noteText, poi);
    if (updated) {
      onPoiUpdated(updated);
      setSavedBanner(true);
      onNotify?.('הערת השטח נשמרה בזיכרון המקומי (IndexedDB)');
      setTimeout(() => setSavedBanner(false), 2500);
    }
  };

  // Ultra-compact mini card used when tapping a pin in Mobile Navigating Mode
  if (compactNavigating) {
    return (
      <div dir="rtl" className="px-4 py-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-bold truncate">
            <span>{meta.emoji}</span>
            <span className="truncate">{displayName}</span>
          </div>
          <div className={`text-xs font-mono ${t.muted}`}>
            {sampledDemEle !== null ? `${sampledDemEle}m` : '---'} • {distanceKm.toFixed(1)} ק״מ • נ.צ.{' '}
            <span dir="ltr">{milCoords.idfGrid8Digit}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onOpenFullPlanning && (
            <button
              onClick={onOpenFullPlanning}
              className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
            >
              פרטים
            </button>
          )}
          <button
            onClick={onClose}
            className={`p-1.5 rounded-xl border text-xs font-bold ${t.pillBtn}`}
            title="סגור"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  const content = (
    <div dir="rtl" className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1 min-w-0">
          <div
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border ${meta.badgeClass}`}
          >
            <span>{meta.emoji}</span>
            <span>{meta.fullLabel}</span>
          </div>
          <h3 className="text-base font-bold leading-snug" dir="auto">
            {displayName}
          </h3>
          <p className={`text-xs truncate ${t.muted}`}>
            {poi.nameEn && poi.nameEn !== displayName ? `${poi.nameEn} • ` : ''}
            {poi.source}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onToggleExpand && (
            <button
              onClick={onToggleExpand}
              className={`px-2.5 py-1 rounded-lg border text-xs font-semibold ${t.pillBtn}`}
            >
              {isExpanded ? 'צמצם' : 'הרחב'}
            </button>
          )}
          <button
            onClick={onClose}
            className={`p-1.5 rounded-lg border transition-colors ${t.pillBtn}`}
            title="סגור"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Telemetry Row */}
      <div className={`grid grid-cols-3 gap-2 p-2.5 rounded-xl border text-xs ${t.subCard}`}>
        <div>
          <span className={`block ${t.muted}`}>גובה (DEM)</span>
          <span className="font-mono font-bold text-emerald-500 text-sm">
            {sampledDemEle !== null ? `${sampledDemEle} m` : 'N/A'}
          </span>
        </div>
        <div>
          <span className={`block ${t.muted}`}>מרחק</span>
          <span className="font-mono font-bold text-sm">{distanceKm.toFixed(1)} ק״מ</span>
        </div>
        <div>
          <span className={`block ${t.muted}`}>נ.צ. ITM</span>
          <button
            onClick={() => handleCopyCoords(milCoords.idfGrid8Digit)}
            dir="ltr"
            className="font-mono font-bold text-amber-500 hover:underline text-left"
            title="העתק נ.צ. 8 ספרות"
          >
            {milCoords.idfGrid8Digit}
          </button>
        </div>
      </div>

      {/* Google-Maps-Style Action Row */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => (onNavigateToPoi ? onNavigateToPoi(poi) : onFlyTo(poi.lon, poi.lat))}
          className="py-2 px-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-colors"
        >
          <Navigation className="w-3.5 h-3.5" />
          <span>נווט לכאן</span>
        </button>
        <button
          onClick={() => onFlyTo(poi.lon, poi.lat)}
          className={`py-2 px-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${t.pillBtn}`}
        >
          <LocateFixed className="w-3.5 h-3.5 text-sky-500" />
          <span>מרכז מפה</span>
        </button>
        <button
          onClick={() => handleCopyCoords(`${poi.lat.toFixed(5)}, ${poi.lon.toFixed(5)}`)}
          className={`py-2 px-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${t.pillBtn}`}
        >
          <Copy className="w-3.5 h-3.5 text-amber-500" />
          <span>העתק נ.צ.</span>
        </button>
      </div>

      {isExpanded && (
        <>
          {poi.waterStatus && (
            <div
              className="p-2.5 rounded-xl bg-sky-500/15 border border-sky-500/35 text-xs flex items-center gap-2"
              dir="auto"
            >
              <Droplets className="w-4 h-4 text-sky-500 shrink-0" />
              <span>
                <strong>מצב מים:</strong> {poi.waterStatus}
              </span>
            </div>
          )}

          {poi.difficulty4x4 && (
            <div
              className="p-2.5 rounded-xl bg-red-500/15 border border-red-500/35 text-xs flex items-center gap-2"
              dir="auto"
            >
              <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
              <span>
                <strong>עבירות 4x4:</strong> {poi.difficulty4x4}
              </span>
            </div>
          )}

          {displayDesc && (
            <div className="max-h-36 overflow-y-auto pl-1">
              <p className="text-xs leading-relaxed" dir="auto">
                {displayDesc}
              </p>
            </div>
          )}

          {(poi.likes && poi.likes > 0) || poi.updatedAt ? (
            <div className={`flex flex-wrap items-center gap-2 text-[11px] ${t.muted}`}>
              {poi.likes && poi.likes > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-500 font-semibold">
                  👍 {poi.likes} המלצות קהילה
                </span>
              )}
              {poi.updatedAt && (
                <span>עודכן: {poi.updatedAt.slice(0, 10)}</span>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {poi.wikipedia && (
              <a
                href={buildWikipediaHref(poi.wikipedia)}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold text-sky-500 ${t.pillBtn}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>קרא עוד בויקיפדיה</span>
              </a>
            )}
            {getSafeExternalHref(poi.externalUrl) && (
              <a
                href={getSafeExternalHref(poi.externalUrl)!}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold text-emerald-500 ${t.pillBtn}`}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>קישור למקור המידע</span>
              </a>
            )}
          </div>

          {/* Offline Field Notes */}
          <div className={`pt-2.5 border-t space-y-1.5 ${t.divider}`}>
            <label className="block text-xs font-bold">
              הערת שטח אישית (נשמר אופליין במכשיר):
            </label>
            <div className="flex gap-2">
              <input
                id="poi-field-note"
                name="poiNote"
                type="text"
                dir="auto"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                placeholder="לדוגמה: המעיין מלא ונקי / מדרגת סלע גבוהה..."
                className={`flex-1 rounded-xl border px-3 py-1.5 text-xs focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
              />
              <button
                onClick={handleSaveNote}
                className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-bold text-white flex items-center gap-1 shrink-0 transition-colors"
              >
                <Save className="w-3.5 h-3.5" />
                <span>שמור</span>
              </button>
            </div>
            {savedBanner && (
              <p className="text-xs text-emerald-500 font-semibold">
                ✓ נשמר בהצלחה בזיכרון המקומי (IndexedDB)
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );

  if (embedded) return content;

  return (
    <div
      className={`fixed bottom-4 right-4 left-4 md:left-auto md:w-[420px] z-40 rounded-2xl border overflow-hidden ${t.panel}`}
    >
      {content}
    </div>
  );
};
