import React, { useState } from 'react';
import { Layers, Sun, Moon, Satellite, ChevronDown, X, Lock, Palette, MapPinned } from 'lucide-react';
import {
  countActivePoiCategories,
  enableAllPoiVisibility,
  isAerialOverlayActive,
  isMasterPoiActive,
  toggleMasterPoiVisibility,
  togglePoiCategoryVisibility,
  type MapStyleId,
  type OutdoorLayerVisibility,
  type PoiLayerKey,
} from '../../core/style/israelOutdoorStyle';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';
import { getAppVersion } from '../../core/appVersion';
import { isLocalDevServer } from '../../core/dataUrls';
import { PoiCategoryIcon } from '../pois/PoiCategoryIcon';
import { MinimizeToggle } from '../ui/MinimizeToggle';
import type { PoiCategory } from '../../core/db/NavDatabase';
import { POI_CATEGORY_SPECS } from '../../core/pois/poiTaxonomy';

export type LayerSheetSection = 'style' | 'layers' | 'pois';

const SECTION_HEADERS: Record<LayerSheetSection, { title: string; shortLabel: string; Icon: React.ComponentType<{ className?: string }> }> = {
  style: { title: 'סגנון מפה (יום / לילה)', shortLabel: 'סגנון', Icon: Palette },
  layers: { title: 'שכבות מפה', shortLabel: 'שכבות', Icon: Layers },
  pois: { title: 'נקודות עניין (POI)', shortLabel: 'POI', Icon: MapPinned },
};

interface LayerSwitcherSheetProps {
  isOpen: boolean;
  onClose: () => void;
  visibility: OutdoorLayerVisibility;
  onChangeVisibility: (next: OutdoorLayerVisibility) => void;
  theme: MapTheme;
  onSelectTheme: (theme: MapTheme) => void;
  mapStyle: MapStyleId;
  onSelectMapStyle: (style: MapStyleId) => void;
  embedded?: boolean;
  /** Which part of the controls to show. Omit to show everything. */
  section?: LayerSheetSection;
  onSelectSection?: (section: LayerSheetSection) => void;
}

export const LayerSwitcherSheet: React.FC<LayerSwitcherSheetProps> = ({
  isOpen,
  onClose,
  visibility,
  onChangeVisibility,
  theme,
  onSelectTheme,
  mapStyle,
  onSelectMapStyle,
  embedded = false,
  section,
  onSelectSection,
}) => {
  const [showPoiSubCategories, setShowPoiSubCategories] = useState(true);
  const [minimized, setMinimized] = useState(false);

  if (!isOpen && !embedded) return null;

  const t = getSurfaceTheme(theme);
  const show = (name: LayerSheetSection) => !section || section === name;
  const header = section ? SECTION_HEADERS[section] : { title: 'סוג מפה ושכבות טופוגרפיות', Icon: Layers };

  const toggle = (key: keyof OutdoorLayerVisibility) => {
    const current =
      key === 'peerLocations' || key === 'publicPeerLocations' || key === 'poiPrivate'
        ? visibility[key] !== false
        : Boolean(visibility[key]);
    onChangeVisibility({
      ...visibility,
      [key]: !current,
    });
  };

  const isLocalhost = isLocalDevServer();

  const toggleAerial = (key: 'googleSatellite' | 'govmapOrtho') => {
    if (key === 'govmapOrtho' && !isLocalhost) return;
    const nextValue = !visibility[key];
    onChangeVisibility({
      ...visibility,
      googleSatellite: key === 'googleSatellite' ? nextValue : false,
      govmapOrtho: key === 'govmapOrtho' ? nextValue : false,
    });
  };

  const aerialToggles: Array<{
    key: 'googleSatellite' | 'govmapOrtho';
    title: string;
    activeDesc: string;
    idleDesc: string;
    badge: string;
  }> = [
    {
      key: 'googleSatellite',
      title: 'תצלום לוויין (Google Satellite)',
      activeDesc: visibility.hideRoadsOnExternalMap
        ? 'מוצג תצלום לוויין נקי (דרכים וכבישים מוסתרים)'
        : 'מוצגים כבישים, דרכים, שבילים ונקודות עניין (POI) — שאר השכבות מוסתרות',
      idleDesc: 'מוסיף תצלום לוויין ומציג דרכים, שבילים ונקודות עניין (POI) בלבד',
      badge: 'SAT',
    },
    ...(isLocalhost
      ? [
          {
            key: 'govmapOrtho' as const,
            title: 'תצלום אוויר GovMap (מפ״י 2025)',
            activeDesc: visibility.hideRoadsOnExternalMap
              ? 'מוצג תצלום אוויר GovMap נקי (דרכים וכבישים מוסתרים)'
              : 'מוצגים כבישים, דרכים, שבילים ונקודות עניין (POI) מעל אורתופוטו GovMap',
            idleDesc: 'מוסיף תצלום אוויר עדכני של מפ״י ומציג דרכים, שבילים ונקודות עניין בלבד',
            badge: 'ORTHO',
          },
        ]
      : []),
  ];

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
    { key: 'regionalTrails', label: 'שבילים איזורים', badge: 'Long', hiddenOnSatellite: false },
    { key: 'cycleways', label: 'שבילי אופניים', badge: 'Cycle', hiddenOnSatellite: false },
    { key: 'natureParks', label: 'גבולות שמורות טבע וגנים', badge: 'Parks', hiddenOnSatellite: true },
    { key: 'fuelAndFlood', label: 'קווי חיץ, סוללות ומכשולי שטח', badge: 'Hazard', hiddenOnSatellite: true },
    { key: 'peerLocations', label: 'מיקומי משתמשים משותפים (Live)', badge: 'Live', hiddenOnSatellite: false },
  ];

  const poiToggles: Array<{ key: PoiLayerKey; cat: PoiCategory; label: string; activeCls: string }> = [
    { key: 'poiWater', cat: 'water', label: POI_CATEGORY_SPECS.water.labelHe, activeCls: 'border-sky-500 bg-sky-500/15 text-sky-500' },
    { key: 'poiOffroad', cat: 'offroad', label: POI_CATEGORY_SPECS.offroad.shortLabelHe + ' ומהלכים', activeCls: 'border-red-500 bg-red-500/15 text-red-500' },
    { key: 'poiHeritage', cat: 'heritage', label: POI_CATEGORY_SPECS.heritage.shortLabelHe, activeCls: 'border-amber-500 bg-amber-500/15 text-amber-500' },
    { key: 'poiCampsites', cat: 'campsite', label: POI_CATEGORY_SPECS.campsite.labelHe, activeCls: 'border-emerald-500 bg-emerald-500/15 text-emerald-500' },
    { key: 'poiPeaks', cat: 'peak', label: POI_CATEGORY_SPECS.peak.labelHe, activeCls: 'border-indigo-500 bg-indigo-500/15 text-indigo-500' },
    { key: 'poiUser', cat: 'user', label: POI_CATEGORY_SPECS.user.labelHe, activeCls: 'border-violet-500 bg-violet-500/15 text-violet-500' },
  ];

  const activeSubCount = countActivePoiCategories(visibility);
  const isMasterPoiOn = isMasterPoiActive(visibility);

  const content = (
    <div dir="rtl" className="p-4 space-y-3.5 overflow-y-auto max-h-[65vh] md:max-h-[72vh]">
      <div className="flex items-center justify-between gap-2">
        {embedded && section && onSelectSection ? (
          <div className="flex items-center gap-1">
            {(['style', 'layers', 'pois'] as LayerSheetSection[]).map((secKey) => {
              const spec = SECTION_HEADERS[secKey];
              const active = section === secKey;
              return (
                <button
                  key={secKey}
                  type="button"
                  onClick={() => onSelectSection(secKey)}
                  className={`px-2.5 py-1 rounded-xl border text-xs font-bold flex items-center gap-1 transition-colors ${
                    active ? 'bg-emerald-600 border-emerald-500 text-white' : t.subCard
                  }`}
                >
                  <spec.Icon className="w-3.5 h-3.5" />
                  <span>{spec.shortLabel}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <header.Icon className="w-4 h-4 text-emerald-500" />
            <h3 className="text-sm font-bold">{header.title}</h3>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          {!embedded && (
            <MinimizeToggle minimized={minimized} onToggle={() => setMinimized((v) => !v)} theme={theme} />
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

      <div className={!embedded && minimized ? 'hidden' : 'space-y-3.5'}>

      {show('style') && (
        <>
      {/* Day / Night Map Mode Selector Cards */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => onSelectTheme('topo-day')}
          className={`p-2 rounded-xl border-2 text-center transition-all ${
            theme === 'topo-day'
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
            theme === 'topo-dark'
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
      </div>

      {/* Cartographic Style Selector: IHM (Classic) vs NMS (Enhanced) vs GovMap (1:25k) */}
      <div className="space-y-1.5">
        <div className={`text-xs font-bold ${t.muted}`}>סגנון מפה (Style)</div>
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => onSelectMapStyle('ihm')}
            aria-pressed={mapStyle === 'ihm'}
            className={`px-2.5 py-2 rounded-xl border-2 text-right transition-all ${
              mapStyle === 'ihm'
                ? 'border-emerald-500 bg-emerald-500/10'
                : t.subCard
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-extrabold tracking-wide">IHM</span>
              <span className={`text-[10px] font-semibold ${t.muted}`}>קלאסי</span>
            </div>
            <span className={`text-[10.5px] block mt-0.5 leading-tight ${t.muted}`}>
              Israel Hiking מקורי
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectMapStyle('nms')}
            aria-pressed={mapStyle === 'nms'}
            className={`px-2.5 py-2 rounded-xl border-2 text-right transition-all ${
              mapStyle === 'nms'
                ? 'border-emerald-500 bg-emerald-500/10'
                : t.subCard
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-extrabold tracking-wide">NMS</span>
              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                משופר
              </span>
            </div>
            <span className={`text-[10.5px] block mt-0.5 leading-tight ${t.muted}`}>
              צבעים והיררכיית סמלים
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectMapStyle('govmap')}
            aria-pressed={mapStyle === 'govmap'}
            className={`px-2.5 py-2 rounded-xl border-2 text-right transition-all ${
              mapStyle === 'govmap'
                ? 'border-emerald-500 bg-emerald-500/10'
                : t.subCard
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-extrabold tracking-wide">GovMap</span>
              <span className="text-[10px] font-bold text-amber-700 dark:text-amber-400">
                1:25k
              </span>
            </div>
            <span className={`text-[10.5px] block mt-0.5 leading-tight ${t.muted}`}>
              מפה טופוגרפית (מפ״י)
            </span>
          </button>
        </div>
      </div>
        </>
      )}

      {show('layers') && (
        <>
      {/* Navigation & Terrain Toggle Switches */}
      <div className="space-y-1.5">
        <div className={`text-xs font-bold ${t.muted}`}>שכבות ניווט ושטח</div>
        {aerialToggles.map((aerial) => {
          const isActive = Boolean(visibility[aerial.key]);
          return (
            <button
              key={aerial.key}
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => toggleAerial(aerial.key)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-xs transition-colors ${
                isActive
                  ? 'border-sky-500 bg-sky-500/15'
                  : t.subCard
              }`}
            >
              <span className="flex items-center gap-2 min-w-0 text-right">
                <Satellite
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-sky-500' : t.muted
                  }`}
                />
                <span className="min-w-0">
                  <span className="font-bold block truncate">{aerial.title}</span>
                  <span className={`text-[11px] block leading-tight ${t.muted}`}>
                    {isActive ? aerial.activeDesc : aerial.idleDesc}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span
                  className={`font-mono text-xs ${
                    isActive ? 'text-sky-500 font-bold' : t.muted
                  }`}
                >
                  {aerial.badge}
                </span>
                <span
                  className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                    isActive ? 'bg-sky-600 justify-start' : 'bg-slate-400/40 justify-end'
                  }`}
                >
                  <span className="w-4 h-4 rounded-full bg-white shadow" />
                </span>
              </span>
            </button>
          );
        })}

        {isAerialOverlayActive(visibility) && (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(visibility.hideRoadsOnExternalMap)}
            onClick={() => toggle('hideRoadsOnExternalMap')}
            className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs transition-colors ${
              visibility.hideRoadsOnExternalMap ? 'border-amber-500 bg-amber-500/15' : t.subCard
            }`}
          >
            <span className="text-right min-w-0">
              <span className="font-bold block">הסתר דרכים וכבישים במפה החיצונית</span>
              <span className={`text-[11px] block leading-tight ${t.muted}`}>
                מסתיר את שכבת הכבישים, השבילים והדרכים מעל תצלום הלוויין/אוויר
              </span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <span className={`font-mono text-xs ${t.muted}`}>Roads</span>
              <span
                className={`w-9 h-5 rounded-full p-0.5 transition-colors flex items-center ${
                  visibility.hideRoadsOnExternalMap ? 'bg-amber-600 justify-start' : 'bg-slate-400/40 justify-end'
                }`}
              >
                <span className="w-4 h-4 rounded-full bg-white shadow" />
              </span>
            </span>
          </button>
        )}

        {terrainToggles.map((item) => {
          const isOn =
            item.key === 'peerLocations' ? visibility.peerLocations !== false : Boolean(visibility[item.key]);
          const isHiddenBySatellite = isAerialOverlayActive(visibility) && item.hiddenOnSatellite;
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
        </>
      )}

      {show('pois') && (
        <>
      {/* Master POI Layer Switch + Category Sub-Toggles */}
      <div className={`space-y-2 ${section ? '' : `pt-2 border-t ${t.divider}`}`}>
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
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
                        isOn ? item.activeCls : `${t.subCard} opacity-55`
                      }`}
                    >
                      <PoiCategoryIcon category={item.cat} size={16} />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() =>
                    onChangeVisibility({
                      ...visibility,
                      poiPrivate: visibility.poiPrivate === false ? true : false,
                    })
                  }
                  aria-pressed={visibility.pois && visibility.poiPrivate !== false}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
                    visibility.pois && visibility.poiPrivate !== false
                      ? 'border-indigo-500 bg-indigo-500/15 text-indigo-400'
                      : `${t.subCard} opacity-55`
                  }`}
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>פרטיות ומשותפות</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
        </>
      )}

      {/* App Version Footer */}
      {show('style') && (
      <div
        className={`pt-2.5 border-t flex items-center justify-between text-[11px] ${t.divider} ${t.muted}`}
      >
        <span className="font-semibold">גרסת אפליקציה</span>
        <span dir="ltr" className="font-mono font-semibold select-all" data-testid="app-version">
          {getAppVersion()}
        </span>
      </div>
      )}
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className={`fixed bottom-4 left-16 z-40 w-84 rounded-2xl border overflow-hidden ${t.panel}`}>
      {content}
    </div>
  );
};
