import React from 'react';
import { Layers, Sun, Moon, X, ShieldAlert } from 'lucide-react';
import type { OutdoorLayerVisibility } from '../../core/style/israelOutdoorStyle';

interface LayerSwitcherSheetProps {
  isOpen: boolean;
  onClose: () => void;
  visibility: OutdoorLayerVisibility;
  onChangeVisibility: (next: OutdoorLayerVisibility) => void;
  theme: 'topo-day' | 'topo-dark';
  onToggleTheme: () => void;
}

export const LayerSwitcherSheet: React.FC<LayerSwitcherSheetProps> = ({
  isOpen,
  onClose,
  visibility,
  onChangeVisibility,
  theme,
  onToggleTheme,
}) => {
  if (!isOpen) return null;

  const toggle = (key: keyof OutdoorLayerVisibility) => {
    onChangeVisibility({
      ...visibility,
      [key]: !visibility[key],
    });
  };

  return (
    <div
      dir="rtl"
      className="fixed top-20 right-4 z-40 w-84 bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl p-4 text-slate-100 space-y-4 max-h-[82vh] overflow-y-auto"
    >
      <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-white">שכבות מפה צבאית / טופוגרפית (1:50k)</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Map Theme Switcher */}
      <div className="flex items-center justify-between bg-slate-950/70 p-2.5 rounded-xl border border-slate-800">
        <span className="text-xs font-semibold text-slate-300">תצוגה טקטית (יום 1:50k / לילה C2)</span>
        <button
          onClick={onToggleTheme}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-300 flex items-center gap-1.5"
        >
          {theme === 'topo-day' ? (
            <>
              <Sun className="w-3.5 h-3.5 text-amber-400" />
              <span>תצוגת יום (טופוגרפי 1:50k)</span>
            </>
          ) : (
            <>
              <Moon className="w-3.5 h-3.5 text-sky-400" />
              <span>תצוגת לילה (טקטי)</span>
            </>
          )}
        </button>
      </div>

      {/* Military & Topographic Layers */}
      <div className="space-y-1.5">
        <div className="text-xs font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>שכבות טופוגרפיה ושליטה צבאית</span>
        </div>
        {[
          { key: 'contours', label: 'קווי גובה כל 10 מ׳ + ראשיים 50/100 מ׳', badge: '10m DEM' },
          { key: 'tacticalGrid', label: 'רשת קואורדינטות טקטית (ITM / UTM Grid)', badge: 'Grid' },
          { key: 'militaryZones', label: 'שטחי אש ושטחים צבאיים סגורים', badge: 'Firing Zone' },
          { key: 'hillshade', label: 'הצללת תבליט הרים (DEM Hillshade)', badge: 'Israel.dem' },
          { key: 'terrain3d', label: 'תבליט שטח תלת-ממד (3D Terrain)', badge: '3D GPU' },
          { key: 'offroad4x4', label: 'צירי 4x4 ודרכי עפר (סיווג עבירות 1-5)', badge: 'Israel.osm' },
          { key: 'hikingTrails', label: 'שבילים רגליים ונתיבי תנועה', badge: 'Israel.osm' },
          { key: 'natureParks', label: 'גבולות שמורות טבע וגנים לאומיים', badge: 'Israel.osm' },
          { key: 'fuelAndFlood', label: 'קווי חיץ, סוללות ומכשולי שטח', badge: 'Israel.osm' },
        ].map((item) => (
          <label
            key={item.key}
            className="flex items-center justify-between p-2 rounded-lg bg-slate-950/50 hover:bg-slate-800/60 border border-slate-800/80 cursor-pointer text-xs"
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={visibility[item.key as keyof OutdoorLayerVisibility]}
                onChange={() => toggle(item.key as keyof OutdoorLayerVisibility)}
                className="rounded border-slate-600 text-emerald-500"
              />
              <span className="text-slate-200">{item.label}</span>
            </div>
            <span className="text-slate-400 font-mono text-xs">{item.badge}</span>
          </label>
        ))}
      </div>

      {/* Interactive POI Dots (Israel Hiking / Off-Road / Amud Anan style) */}
      <div className="space-y-1.5 pt-1 border-t border-slate-800">
        <div className="text-xs font-bold uppercase tracking-wider text-slate-400">
          נקודות עניין ומודיעין שטח (עמוד ענן / Off-Road / IHM)
        </div>
        {[
          { key: 'poiWater', label: 'מעיינות, גבים ובורות מים (כחול)', dot: 'bg-sky-400' },
          { key: 'poiOffroad', label: 'מעלות ומכשולי עבירות 4x4 (אדום)', dot: 'bg-red-500' },
          { key: 'poiHeritage', label: 'תצפיות, מערות וחורבות (חום)', dot: 'bg-amber-500' },
          { key: 'poiCampsites', label: 'חניוני לילה ושטחי כינוס (ירוק)', dot: 'bg-emerald-400' },
          { key: 'poiPeaks', label: 'כיפות ונקודות גובה טריגונומטריות (▲)', dot: 'bg-purple-400' },
        ].map((item) => (
          <label
            key={item.key}
            className="flex items-center justify-between p-2 rounded-lg bg-slate-950/50 hover:bg-slate-800/60 border border-slate-800/80 cursor-pointer text-xs"
          >
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={visibility[item.key as keyof OutdoorLayerVisibility]}
                onChange={() => toggle(item.key as keyof OutdoorLayerVisibility)}
                className="rounded border-slate-600 text-emerald-500"
              />
              <span className="text-slate-200">{item.label}</span>
            </div>
            <span className={`w-3 h-3 rounded-full border border-white ${item.dot}`} />
          </label>
        ))}
      </div>
    </div>
  );
};
