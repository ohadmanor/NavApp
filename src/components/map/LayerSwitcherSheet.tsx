import React, { useState } from 'react';
import { Layers, Sun, Moon, Mountain, Satellite, ChevronDown, X } from 'lucide-react';
import {
  countActivePoiCategories,
  enableAllPoiVisibility,
  isMasterPoiActive,
  toggleMasterPoiVisibility,
  togglePoiCategoryVisibility,
  type OutdoorLayerVisibility,
  type PoiLayerKey,
} from '../../core/style/israelOutdoorStyle';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface LayerSwitcherSheetProps {
  isOpen: boolean;
  onClose: () => void;
  visibility: OutdoorLayerVisibility;
  onChangeVisibility: (next: OutdoorLayerVisibility) => void;
  theme: MapTheme;
  onSelectTheme: (theme: MapTheme) => void;
  onToggle3D: () => void;
  embedded?: boolean;
}

export const LayerSwitcherSheet: React.FC<LayerSwitcherSheetProps> = ({
  isOpen,
  onClose,
  visibility,
  onChangeVisibility,
  theme,
  onSelectTheme,
  onToggle3D,
  embedded = false,
}) => {
  const [showPoiSubCategories, setShowPoiSubCategories] = useState(true);

  if (!isOpen && !embedded) return null;

  const t = getSurfaceTheme(theme);

  const toggle = (key: keyof OutdoorLayerVisibility) => {
    onChangeVisibility({
      ...visibility,
      [key]: !visibility[key],
    });
  };

  const terrainToggles: Array<{
    key: keyof OutdoorLayerVisibility;
    label: string;
    badge: string;
    hiddenOnSatellite: boolean;
  }> = [
    { key: 'contours', label: 'קווי גובה כל 10 מ׳ + ראשיים 50 מ׳', badge: 'DEM', hiddenOnSatellite: true },
    { key: 'tacticalGrid', label: 'רשת קואורדינטות (ITM / UTM)', badge: 'Grid', hiddenOnSatellite: true },
    { key: 'hillshade', label: 'הצללת תבליט הרים (Hillshade)', badge: 'Relief', hiddenOnSatellite: true },
    { key: 'militaryZones', label: 'שטחי אש ושטחים סגורים', badge: 'Firing', hiddenOnSatellite: true },
    { key: 'offroad4x4', label: 'צירי 4x4 ודרכי עפר (1-5)', badge: '4x4', hiddenOnSatellite: false },
    { key: 'hikingTrails', label: 'שבילים מסומנים ונתיבי הליכה', badge: 'Trails', hiddenOnSatellite: false },
    { key: 'cycleways', label: 'שבילי אופניים', badge: 'Cycle', hiddenOnSatellite: false },
    { key: 'natureParks', label: 'גבולות שמורות טבע וגנים', badge: 'Parks', hiddenOnSatellite: true },
    { key: 'fuelAndFlood', label: 'קווי חיץ, סוללות ומכשולי שטח', badge: 'Hazard', hiddenOnSatellite: true },
  ];

  const poiToggles: Array<{ key: PoiLayerKey; label: string; activeCls: string }> = [
    { key: 'poiWater', label: '💧 מעיינות וגבים', activeCls: 'border-sky-500 bg-sky-500/15 text-sky-500' },
    { key: 'poiOffroad', label: '🚙 מעלות 4x4', activeCls: 'border-red-500 bg-red-500/15 text-red-500' },
    { key: 'poiHeritage', label: '🏛️ תצפיות ומערות', activeCls: 'border-amber-500 bg-amber-500/15 text-amber-500' },
    { key: 'poiCampsites', label: '⛺ חניוני לילה', activeCls: 'border-emerald-500 bg-emerald-500/15 text-emerald-500' },
    { key: 'poiPeaks', label: '🏔️ פסגות ונ.ג.', activeCls: 'border-purple-500 bg-purple-500/15 text-purple-500' },
    { key: 'poiUser', label: '📍 נקודות שטח', activeCls: 'border-teal-500 bg-teal-500/15 text-teal-500' },
  ];

  const activeSubCount = countActivePoiCategories(visibility);
  const isMasterPoiOn = isMasterPoiActive(visibility);

  const content = (
    <div dir="rtl" className="p-4 space-y-3.5 overflow-y-auto max-h-[65vh] md:max-h-[72vh]">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-emerald-500" />
          <h3 className="text-sm font-bold">סוג מפה ושכבות טופוגרפיות</h3>
        </div>
        <button
          onClick={onClose}
          className={`p-1.5 rounded-lg border transition-colors ${t.pillBtn}`}
          title="סגור"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Visual Map Type Selector Cards */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={() => onSelectTheme('topo-day')}
          className={`p-2 rounded-xl border-2 text-center transition-all ${
            theme === 'topo-day' && !visibility.terrain3d
              ? 'border-emerald-500 bg-emerald-500/10'
              : t.subCard
          }`}
        >
          <div className="h-9 rounded-lg bg-[#f4efe2] border border-amber-800/30 mb-1.5 flex items-center justify-center gap-1 text-xs font-bold text-amber-900">
            <Sun className="w-3.5 h-3.5 text-amber-600" />
            <span>1:50k</span>
          </div>
          <span className="text-xs font-bold block">טופוגרפי יום</span>
        </button>

        <button
          onClick={() => onSelectTheme('topo-dark')}
          className={`p-2 rounded-xl border-2 text-center transition-all ${
            theme === 'topo-dark' && !visibility.terrain3d
              ? 'border-emerald-500 bg-emerald-500/10'
              : t.subCard
          }`}
        >
          <div className="h-9 rounded-lg bg-slate-900 border border-slate-700 mb-1.5 flex items-center justify-center gap-1 text-xs font-bold text-sky-400">
            <Moon className="w-3.5 h-3.5 text-sky-400" />
            <span>OPS</span>
          </div>
          <span className="text-xs font-bold block">לילה טקטי</span>
        </button>

        <button
          onClick={onToggle3D}
          className={`p-2 rounded-xl border-2 text-center transition-all ${
            visibility.terrain3d ? 'border-emerald-500 bg-emerald-500/10' : t.subCard
          }`}
        >
          <div className="h-9 rounded-lg bg-gradient-to-br from-emerald-700 to-amber-700 mb-1.5 flex items-center justify-center gap-1 text-xs font-bold text-white">
            <Mountain className="w-3.5 h-3.5" />
            <span>3D</span>
          </div>
          <span className="text-xs font-bold block">תבליט 3D</span>
        </button>
      </div>

      {/* Navigation & Terrain Toggle Switches */}
      <div className="space-y-1.5">
        <div className={`text-xs font-bold ${t.muted}`}>שכבות ניווט ושטח</div>
        <button
          type="button"
          role="switch"
          aria-checked={visibility.googleSatellite}
          onClick={() => toggle('googleSatellite')}
          className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-xs transition-colors ${
            visibility.googleSatellite
              ? 'border-sky-500 bg-sky-500/15'
              : t.subCard
          }`}
        >
          <span className="flex items-center gap-2 min-w-0 text-right">
            <Satellite
              className={`w-4 h-4 shrink-0 ${
                visibility.googleSatellite ? 'text-sky-500' : t.muted
              }`}
            />
            <span className="min-w-0">
              <span className="font-bold block truncate">תצלום לוויין (Google Satellite)</span>
              <span className={`text-[11px] block leading-tight ${t.muted}`}>
                {visibility.googleSatellite
                  ? 'מוצגים כבישים, דרכים, שבילים ונקודות עניין (POI) — שאר השכבות מוסתרות'
                  : 'מוסיף תצלום לוויין ומציג דרכים, שבילים ונקודות עניין (POI) בלבד'}
              </span>
            </span>
          </span>
          <span className="flex items-center gap-2 shrink-0">
            <span
              className={`font-mono text-xs ${
                visibility.googleSatellite ? 'text-sky-500 font-bold' : t.muted
              }`}
            >
              SAT
            </span>
            <span
              className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                visibility.googleSatellite ? 'bg-sky-600 justify-start' : 'bg-slate-400/40 justify-end'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-white shadow" />
            </span>
          </span>
        </button>

        {terrainToggles.map((item) => {
          const isOn = visibility[item.key];
          const isHiddenBySatellite = visibility.googleSatellite && item.hiddenOnSatellite;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => toggle(item.key)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl border text-xs transition-colors ${t.subCard} ${
                isHiddenBySatellite ? 'opacity-50' : ''
              }`}
            >
              <span className="text-right font-medium">{item.label}</span>
              <span className="flex items-center gap-2 shrink-0">
                {isHiddenBySatellite && (
                  <span className={`text-[10px] ${t.muted}`}>מוסתר בלוויין</span>
                )}
                <span className={`font-mono text-xs ${t.muted}`}>{item.badge}</span>
                <span
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                    isOn ? 'bg-emerald-600 justify-start' : 'bg-slate-400/40 justify-end'
                  }`}
                >
                  <span className="w-4 h-4 rounded-full bg-white shadow" />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Master POI Layer Switch + Category Sub-Toggles */}
      <div className={`space-y-2 pt-2 border-t ${t.divider}`}>
        <div className="flex items-center justify-between">
          <div className={`text-xs font-bold ${t.muted}`}>נקודות עניין במפה (POI)</div>
        </div>
        <div className={`rounded-xl border overflow-hidden ${t.subCard}`}>
          <div className="flex items-center justify-between px-3 py-2 text-xs gap-2">
            <button
              type="button"
              onClick={() => setShowPoiSubCategories((prev) => !prev)}
              className={`p-1 -mr-1 rounded-lg transition-colors ${t.muted} hover:bg-slate-500/10`}
              title={showPoiSubCategories ? 'הסתר קטגוריות' : 'הצג קטגוריות'}
              aria-expanded={showPoiSubCategories}
            >
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${
                  showPoiSubCategories ? '' : 'rotate-90'
                }`}
              />
            </button>

            <button
              type="button"
              onClick={() => onChangeVisibility(toggleMasterPoiVisibility(visibility))}
              role="switch"
              aria-checked={isMasterPoiOn}
              className="flex-1 flex items-center justify-between gap-2 min-w-0 text-right"
            >
              <span className="font-bold truncate">הצג נקודות עניין במפה</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={`font-mono text-xs ${t.muted}`}>
                  {isMasterPoiOn ? `${activeSubCount}/${poiToggles.length}` : 'כבוי'}
                </span>
                <span
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                    isMasterPoiOn ? 'bg-emerald-600 justify-start' : 'bg-slate-400/40 justify-end'
                  }`}
                >
                  <span className="w-4 h-4 rounded-full bg-white shadow" />
                </span>
              </span>
            </button>
          </div>

          {showPoiSubCategories && (
            <div className={`px-3 pb-3 pt-2 border-t space-y-2 ${t.divider}`}>
              <div className="flex items-center justify-between text-[11px]">
                <span className={`font-semibold ${t.muted}`}>קטגוריות נקודות עניין</span>
                {(!isMasterPoiOn || activeSubCount < poiToggles.length) && (
                  <button
                    type="button"
                    onClick={() => onChangeVisibility(enableAllPoiVisibility(visibility))}
                    className="font-bold text-emerald-500 hover:underline"
                  >
                    הצג הכל
                  </button>
                )}
              </div>
              <div className={`flex flex-wrap gap-1.5 ${!isMasterPoiOn ? 'opacity-65' : ''}`}>
                {poiToggles.map((item) => {
                  const isOn = visibility.pois && visibility[item.key];
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() =>
                        onChangeVisibility(togglePoiCategoryVisibility(visibility, item.key))
                      }
                      aria-pressed={isOn}
                      className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
                        isOn ? item.activeCls : `${t.subCard} opacity-55`
                      }`}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className={`fixed bottom-20 left-4 z-40 w-84 rounded-2xl border overflow-hidden ${t.panel}`}>
      {content}
    </div>
  );
};
