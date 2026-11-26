import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TrendingUp,
  Download,
  X,
  Navigation,
  FileUp,
  Compass,
  Trash2,
  Route as RouteIcon,
  ChevronDown,
  MapPin,
  Maximize2,
  Check,
  Plus,
  Pencil,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  Palette,
  ArrowLeftRight,
  PenTool,
  Search,
  Copy,
  Users,
  Share2,
  FolderTree,
} from 'lucide-react';
import type { PoiRecord, SavedRouteRecord } from '../../core/db/NavDatabase';
import { GpxExportService } from '../../core/navigation/GpxExportService';
import {
  ROUTE_COLOR_PALETTE,
  isRecordedRouteFormat,
  resolveRouteDisplayColor,
} from '../../core/navigation/RouteManager';
import type { RouteMapDisplayMode } from '../../core/navigation/RouteDisplayPolicy';
import {
  computeRoutePointsAlongTrack,
  type RouteChartPoint,
  type RoutePointOption,
} from '../../core/navigation/routeTelemetryHelpers';
import { PLANNING_MODE_META } from '../../core/routing/RoutingProfiles';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';
import { PoiCategoryIcon } from '../pois/PoiCategoryIcon';
import { ElevationChart } from './ElevationChart';

const DEFAULT_VISIBLE_ROUTES_BATCH = 35;

type OwnershipTab = 'mine' | 'shared';
type RouteFilterKind = 'all' | '4x4' | 'foot' | 'bicycle' | 'recorded' | 'imported';
type RouteSortKey = 'updated' | 'name' | 'distance' | 'ascent';

export type { RouteChartPoint };

interface ElevationProfileDrawerProps {
  route: SavedRouteRecord | null;
  routes?: SavedRouteRecord[];
  pois?: PoiRecord[];
  theme?: MapTheme;
  isNavigating?: boolean;
  routeDisplayMode?: RouteMapDisplayMode;
  backgroundRouteIds?: string[];
  unseenSharedCount?: number;
  onSelectRoute?: (route: SavedRouteRecord | null) => void;
  onStartNavigation?: (route: SavedRouteRecord) => void;
  onStopNavigation?: () => void;
  onOpenImporter?: () => void;
  onOpenRoutePlanner?: () => void;
  onDeleteRoute?: (routeId: string) => void;
  onShareRoute?: (route: SavedRouteRecord) => void;
  onViewSharedTab?: () => void;
  onDuplicateSharedRoute?: (route: SavedRouteRecord) => void | Promise<void>;
  onDismissSharedRoute?: (routeId: string) => void | Promise<void>;
  onRenameRoute?: (routeId: string, nextName: string) => void | Promise<void>;
  onChangeRouteColor?: (routeId: string, color: string) => void | Promise<void>;
  onToggleRouteVisibility?: (routeId: string) => void | Promise<void>;
  onToggleBackgroundRoute?: (routeId: string) => void;
  onClearBackgroundRoutes?: () => void;
  onReverseRoute?: (routeId: string) => void | Promise<void>;
  onEditRouteInPlanner?: (route: SavedRouteRecord) => void;
  onSendToPlanningDb?: (route: SavedRouteRecord) => void;
  onClose: () => void;
  onHoverPoint: (pt: { lon: number; lat: number; ele: number; distKm: number } | null) => void;
  onSelectPoint?: (pt: { lon: number; lat: number; ele: number; distKm: number }) => void;
  onFlyToRoute: (route: SavedRouteRecord) => void;
  onFitAllRoutes?: () => void;
  onNotify?: (message: string) => void;
  embedded?: boolean;
  hideCloseButton?: boolean;
}

export const ElevationProfileDrawer: React.FC<ElevationProfileDrawerProps> = ({
  route,
  routes = [],
  pois = [],
  theme = 'topo-dark',
  isNavigating = false,
  routeDisplayMode,
  backgroundRouteIds = [],
  unseenSharedCount = 0,
  onSelectRoute,
  onStartNavigation,
  onStopNavigation,
  onOpenImporter,
  onOpenRoutePlanner,
  onDeleteRoute,
  onShareRoute,
  onViewSharedTab,
  onDuplicateSharedRoute,
  onDismissSharedRoute,
  onRenameRoute,
  onChangeRouteColor,
  onToggleRouteVisibility,
  onToggleBackgroundRoute,
  onClearBackgroundRoutes,
  onReverseRoute,
  onEditRouteInPlanner,
  onSendToPlanningDb,
  onClose,
  onHoverPoint,
  onSelectPoint,
  onFlyToRoute,
  onFitAllRoutes,
  onNotify,
  embedded = false,
  hideCloseButton = false,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);
  const [isPointsMenuOpen, setIsPointsMenuOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [ownershipTab, setOwnershipTab] = useState<OwnershipTab>(() =>
    route?.ownership === 'shared' ? 'shared' : 'mine'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [filterKind, setFilterKind] = useState<RouteFilterKind>('all');
  const [sortKey, setSortKey] = useState<RouteSortKey>('updated');
  const [visibleCount, setVisibleCount] = useState<number>(DEFAULT_VISIBLE_ROUTES_BATCH);
  const t = getSurfaceTheme(theme);

  // Synchronous guard prevents out-of-bounds crash during the first render after switching routes
  const prevRouteIdRef = useRef<string | undefined>(route?.id);
  const justSwitchedRoute = prevRouteIdRef.current !== route?.id;
  if (justSwitchedRoute) {
    prevRouteIdRef.current = route?.id;
  }

  useEffect(() => {
    setHoveredIdx(null);
    setPinnedIdx(null);
    setIsRenaming(false);
    setIsColorPickerOpen(false);
    if (route?.ownership === 'shared') {
      setOwnershipTab('shared');
    } else if (route) {
      setOwnershipTab('mine');
    }
  }, [route?.id, route?.ownership]);

  useEffect(() => {
    setVisibleCount(DEFAULT_VISIBLE_ROUTES_BATCH);
  }, [ownershipTab, searchQuery, filterKind, sortKey]);

  const { mineRoutes, sharedRoutes } = useMemo(() => {
    const mine: SavedRouteRecord[] = [];
    const shared: SavedRouteRecord[] = [];
    for (const r of routes) {
      if (r.ownership === 'shared') {
        shared.push(r);
      } else {
        mine.push(r);
      }
    }
    return { mineRoutes: mine, sharedRoutes: shared };
  }, [routes]);

  const tabRoutes = ownershipTab === 'shared' ? sharedRoutes : mineRoutes;

  const filteredRoutes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = tabRoutes.filter((r) => {
      if (filterKind === '4x4' && r.planningMode !== '4x4') return false;
      if (filterKind === 'foot' && r.planningMode !== 'foot') return false;
      if (filterKind === 'bicycle' && r.planningMode !== 'bicycle') return false;
      if (filterKind === 'recorded' && !isRecordedRouteFormat(r.sourceFormat)) return false;
      if (filterKind === 'imported' && (r.sourceFormat === 'planned' || isRecordedRouteFormat(r.sourceFormat))) return false;

      if (q) {
        const nameHit = (r.name || '').toLowerCase().includes(q);
        const senderHit =
          (r.sharedByName || '').toLowerCase().includes(q) ||
          (r.sharedByEmail || '').toLowerCase().includes(q) ||
          (r.ownerDisplayName || '').toLowerCase().includes(q);
        if (!nameHit && !senderHit) return false;
      }
      return true;
    });

    const sorted = [...matched];
    sorted.sort((a, b) => {
      if (sortKey === 'name') {
        return (a.name || '').localeCompare(b.name || '', 'he');
      }
      if (sortKey === 'distance') {
        return (b.distanceKm || 0) - (a.distanceKm || 0);
      }
      if (sortKey === 'ascent') {
        return (b.ascentMeters || 0) - (a.ascentMeters || 0);
      }
      const bTs = Date.parse(b.updatedAt || b.createdAt || '') || 0;
      const aTs = Date.parse(a.updatedAt || a.createdAt || '') || 0;
      return bTs - aTs;
    });
    return sorted;
  }, [tabRoutes, filterKind, searchQuery, sortKey]);

  const displayedRoutes = useMemo(
    () => filteredRoutes.slice(0, visibleCount),
    [filteredRoutes, visibleCount]
  );

  const isSharedRoute = route?.ownership === 'shared';

  const getDisplayColor = (r: SavedRouteRecord | null) => resolveRouteDisplayColor(r);

  const routePoints = useMemo<RoutePointOption[]>(
    () => computeRoutePointsAlongTrack(route, pois),
    [route, pois]
  );

  const handleExportGpx = async (r: SavedRouteRecord) => {
    try {
      const result = await GpxExportService.exportAndSaveRouteGpx(r);
      onNotify?.(`קובץ GPX נשמר: ${result.locationLabelHe}`);
    } catch (err: any) {
      onNotify?.(err?.message || 'שגיאה בייצוא קובץ GPX');
    }
  };

  const handleCommitRename = () => {
    if (!route || !onRenameRoute || isSharedRoute) {
      setIsRenaming(false);
      return;
    }
    const next = renameDraft.trim();
    setIsRenaming(false);
    if (next && next !== route.name) {
      void onRenameRoute(route.id, next);
    }
  };

  const renderChart = (r: SavedRouteRecord) => (
    <ElevationChart
      route={r}
      strokeColor={getDisplayColor(r)}
      routePoints={routePoints}
      theme={theme}
      hoveredIdx={hoveredIdx}
      pinnedIdx={pinnedIdx}
      justSwitchedRoute={justSwitchedRoute}
      onHoverIdxChange={setHoveredIdx}
      onPinnedIdxChange={setPinnedIdx}
      onHoverPoint={onHoverPoint}
    />
  );

  const handleSelectRouteOption = (r: SavedRouteRecord) => {
    setPinnedIdx(null);
    setHoveredIdx(null);
    setIsPointsMenuOpen(false);
    onSelectRoute?.(r);
  };

  const handleSelectPointOption = (ptOption: RoutePointOption) => {
    setIsPointsMenuOpen(false);
    if (route && route.elevationProfile.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      route.elevationProfile.forEach((p, idx) => {
        const d = Math.abs(p.distKm - ptOption.distKm);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      });
      setPinnedIdx(bestIdx);
      setHoveredIdx(bestIdx);
    }
    onHoverPoint(ptOption);
    onSelectPoint?.(ptOption);
  };

  const activeColor = getDisplayColor(route);

  const showRoutesLibrary = !isNavigating;
  const remainingFilteredCount = Math.max(0, filteredRoutes.length - displayedRoutes.length);

  const innerContent = (
    <div dir="rtl" className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
      {/* Header with Inline Rename & Background Pin / Visibility */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          <TrendingUp className="w-4 h-4 text-pink-500 shrink-0 mt-1" />
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-pink-500 block">
              מסלולים ופרופיל גובה (DEM)
            </span>
            {route && isRenaming && !isSharedRoute ? (
              <div className="flex items-center gap-1.5 mt-1">
                <input
                  id="route-rename-input"
                  name="routeRename"
                  type="text"
                  dir="auto"
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCommitRename();
                    if (e.key === 'Escape') setIsRenaming(false);
                  }}
                  className={`flex-1 min-w-0 rounded-lg border px-2.5 py-1 text-xs font-bold focus:outline-none focus:border-emerald-500 ${t.fieldBox}`}
                />
                <button
                  type="button"
                  onClick={handleCommitRename}
                  className="p-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                  title="שמור שם"
                  aria-label="שמור שם"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsRenaming(false)}
                  className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
                  title="ביטול"
                  aria-label="ביטול שינוי שם"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <h4 className="text-sm font-bold truncate" dir="auto">
                  {route ? route.name : `ספריית מסלולים (${routes.length})`}
                </h4>
                {route && onRenameRoute && !isSharedRoute && (
                  <button
                    type="button"
                    onClick={() => {
                      setRenameDraft(route.name);
                      setIsRenaming(true);
                    }}
                    className={`p-1 rounded-md opacity-70 hover:opacity-100 transition-opacity shrink-0 ${t.hoverRow}`}
                    title="שנה שם מסלול"
                    aria-label="שנה שם מסלול"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {route && onToggleBackgroundRoute ? (
            <button
              type="button"
              onClick={() => onToggleBackgroundRoute(route.id)}
              className={`p-1.5 rounded-lg border shrink-0 ${
                backgroundRouteIds.includes(route.id)
                  ? 'border-sky-500/60 text-sky-500 bg-sky-500/10'
                  : t.pillBtn
              }`}
              title={
                backgroundRouteIds.includes(route.id)
                  ? 'הסר נעיצה מהמפה'
                  : 'נעץ מסלול במפה (יישאר מוצג גם בסגירת החלונית)'
              }
              aria-label={
                backgroundRouteIds.includes(route.id)
                  ? 'הסר נעיצה מהמפה'
                  : 'נעץ מסלול במפה'
              }
            >
              {backgroundRouteIds.includes(route.id) ? (
                <PinOff className="w-4 h-4" />
              ) : (
                <Pin className="w-4 h-4" />
              )}
            </button>
          ) : (
            route &&
            onToggleRouteVisibility && (
              <button
                type="button"
                onClick={() => onToggleRouteVisibility(route.id)}
                className={`p-1.5 rounded-lg border shrink-0 ${
                  route.visible === false
                    ? 'border-amber-500/60 text-amber-500 bg-amber-500/10'
                    : t.pillBtn
                }`}
                title={route.visible === false ? 'המסלול מוסתר — לחץ להצגה במפה' : 'הסתר מסלול במפה'}
                aria-label={route.visible === false ? 'הצג מסלול במפה' : 'הסתר מסלול במפה'}
              >
                {route.visible === false ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            )
          )}
          {!hideCloseButton && (
            <button
              type="button"
              onClick={() => {
                setHoveredIdx(null);
                setPinnedIdx(null);
                onHoverPoint(null);
                onClose();
              }}
              className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
              title="סגור"
              aria-label="סגור"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Ownership Tabs & Always-Visible Routes Library (hidden only while navigating or editing) */}
      {showRoutesLibrary && (
        <>
          <div
            role="tablist"
            aria-label="סיווג בעלות מסלולים"
            className={`grid grid-cols-2 gap-1 p-1 rounded-xl border ${t.subCard}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={ownershipTab === 'mine'}
              onClick={() => {
                setOwnershipTab('mine');
                setIsPointsMenuOpen(false);
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                ownershipTab === 'mine'
                  ? 'bg-pink-600 text-white shadow-sm'
                  : `${t.muted} hover:bg-black/5`
              }`}
            >
              <RouteIcon className="w-3.5 h-3.5 shrink-0" />
              <span>המסלולים שלי ({mineRoutes.length})</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={ownershipTab === 'shared'}
              onClick={() => {
                setOwnershipTab('shared');
                setIsPointsMenuOpen(false);
                onViewSharedTab?.();
              }}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                ownershipTab === 'shared'
                  ? 'bg-violet-600 text-white shadow-sm'
                  : `${t.muted} hover:bg-black/5`
              }`}
            >
              <Users className="w-3.5 h-3.5 shrink-0" />
              <span>שותפו איתי ({sharedRoutes.length})</span>
              {unseenSharedCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold leading-none">
                  +{unseenSharedCount}
                </span>
              )}
            </button>
          </div>

          {routes.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-xs font-bold ${t.muted}`}>
                    {ownershipTab === 'shared' ? 'מסלולים ששותפו איתך' : 'כל המסלולים'}
                  </span>
                  <span dir="ltr" className={`text-[11px] font-mono ${t.muted}`}>
                    ({filteredRoutes.length}/{tabRoutes.length})
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {onFitAllRoutes && backgroundRouteIds.length > 0 && (
                    <button
                      type="button"
                      onClick={onFitAllRoutes}
                      className={`px-2.5 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1 shrink-0 ${t.pillBtn}`}
                      title="התמקד בכל המסלולים המוצגים"
                    >
                      <Maximize2 className="w-3.5 h-3.5 text-pink-500" />
                      <span>הכל</span>
                    </button>
                  )}

                  {onOpenRoutePlanner && (
                    <button
                      type="button"
                      onClick={onOpenRoutePlanner}
                      className="px-2.5 py-1.5 rounded-xl border border-blue-500/50 bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 text-xs font-bold flex items-center gap-1 shrink-0"
                      title="תכנון מסלול חדש על המפה"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>תכנן</span>
                    </button>
                  )}

                  {onOpenImporter && (
                    <button
                      type="button"
                      onClick={onOpenImporter}
                      className="px-2.5 py-1.5 rounded-xl border border-sky-500/50 bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 text-xs font-bold flex items-center gap-1 shrink-0"
                      title="ייבוא קובץ GPX / KML / TWL"
                    >
                      <FileUp className="w-3.5 h-3.5" />
                      <span>ייבא</span>
                    </button>
                  )}
                </div>
              </div>

              {tabRoutes.length === 0 ? (
                <div className={`p-3 rounded-xl border border-dashed text-center space-y-1.5 ${t.subCard}`}>
                  <div className="text-xs font-bold">
                    {ownershipTab === 'shared'
                      ? 'אין עדיין מסלולים ששותפו איתך'
                      : 'אין לך עדיין מסלולים אישיים'}
                  </div>
                  <p className={`text-[11px] ${t.muted}`}>
                    {ownershipTab === 'shared'
                      ? 'כשמשתמשים אחרים ישתפו איתך מסלול לפי כתובת Gmail או שם משתמש, הוא יופיע כאן.'
                      : 'תכנן מסלול חדש על המפה או ייבא קובץ GPX/KML.'}
                  </p>
                </div>
              ) : (
                <div className={`rounded-xl border shadow-sm overflow-hidden ${t.panelSolid}`}>
                  {/* Search, Mode Filter Chips & Sort Controls */}
                  <div className={`p-2 space-y-1.5 border-b ${t.divider}`}>
                    <div className="flex items-center gap-1.5">
                      <div className={`flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border ${t.fieldBox}`}>
                        <Search className={`w-3.5 h-3.5 shrink-0 ${t.muted}`} />
                        <input
                          id="route-library-search"
                          name="routeLibrarySearch"
                          type="text"
                          dir="auto"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder={
                            ownershipTab === 'shared'
                              ? 'חיפוש לפי שם מסלול או שולח...'
                              : 'חיפוש מסלול לפי שם...'
                          }
                          className="w-full min-w-0 bg-transparent text-xs focus:outline-none"
                        />
                        {searchQuery && (
                          <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            className={`p-0.5 rounded hover:bg-black/10 ${t.muted}`}
                            aria-label="נקה חיפוש מסלולים"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>

                      <select
                        id="route-library-sort"
                        name="routeLibrarySort"
                        value={sortKey}
                        onChange={(e) => setSortKey(e.target.value as RouteSortKey)}
                        aria-label="מיון מסלולים"
                        className={`px-2 py-1.5 rounded-lg border text-[11px] font-semibold focus:outline-none ${t.fieldBox}`}
                      >
                        <option value="updated">עודכן</option>
                        <option value="name">שם</option>
                        <option value="distance">מרחק</option>
                        <option value="ascent">טיפוס</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-1 flex-wrap">
                      {(
                        [
                          { id: 'all', label: 'הכל' },
                          { id: '4x4', label: '4x4' },
                          { id: 'foot', label: 'הליכה' },
                          { id: 'bicycle', label: 'אופניים' },
                          { id: 'recorded', label: 'הקלטות' },
                          { id: 'imported', label: 'מיובא' },
                        ] as const
                      ).map((chip) => {
                        const active = filterKind === chip.id;
                        return (
                          <button
                            key={chip.id}
                            type="button"
                            onClick={() => setFilterKind(chip.id)}
                            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-colors ${
                              active
                                ? 'border-pink-500 bg-pink-500/15 text-pink-500'
                                : t.pillBtn
                            }`}
                          >
                            {chip.label}
                          </button>
                        );
                      })}
                      <span className={`mr-auto text-[10px] font-mono ${t.muted}`}>
                        {filteredRoutes.length}/{tabRoutes.length}
                      </span>
                    </div>
                  </div>

                  {/* Paginated Scrollable List */}
                  <div
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      if (
                        remainingFilteredCount > 0 &&
                        el.scrollTop + el.clientHeight >= el.scrollHeight - 48
                      ) {
                        setVisibleCount((c) => c + DEFAULT_VISIBLE_ROUTES_BATCH);
                      }
                    }}
                    className={`${route ? 'max-h-44' : 'max-h-64'} overflow-y-auto divide-y ${t.divider}`}
                  >
                    {displayedRoutes.length === 0 ? (
                      <div className={`px-3 py-4 text-center text-xs ${t.muted}`}>
                        לא נמצאו מסלולים תואמים לחיפוש ולסינון.
                      </div>
                    ) : (
                      <>
                        {displayedRoutes.map((r, idx) => {
                          const isSelected = route?.id === r.id;
                          const isPinnedBg = backgroundRouteIds.includes(r.id);
                          const senderLabel = r.sharedByName || r.sharedByEmail;
                          return (
                            <div
                              key={r.id}
                              className={`w-full px-2 py-1.5 text-xs flex items-center justify-between gap-1 transition-colors ${
                                isSelected ? 'bg-pink-500/15 font-bold' : t.hoverRow
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => handleSelectRouteOption(r)}
                                className="flex-1 min-w-0 text-right px-1.5 py-1 flex items-center gap-2"
                              >
                                <span
                                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                                    isPinnedBg ? 'ring-2 ring-sky-500/70' : ''
                                  }`}
                                  style={{ backgroundColor: getDisplayColor(r) }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="font-bold break-words" dir="auto">
                                    {r.name}
                                  </div>
                                  <div className={`font-mono text-[11px] ${t.muted}`}>
                                    <span dir="ltr">
                                      #{idx + 1} • {r.distanceKm} km • +{r.ascentMeters}m
                                    </span>{' '}
                                    •{' '}
                                    {r.planningMode
                                      ? PLANNING_MODE_META[r.planningMode]?.shortLabelHe
                                      : isRecordedRouteFormat(r.sourceFormat)
                                        ? 'הקלטת ניווט'
                                        : r.sourceFormat.toUpperCase()}
                                    {isPinnedBg ? ' • 📌 ברקע' : ''}
                                    {r.ownership === 'shared' && senderLabel
                                      ? ` • שותף ע״י ${senderLabel}`
                                      : r.cloudSyncStatus === 'synced'
                                        ? ' • ☁️ בענן'
                                        : r.cloudSyncStatus === 'pending'
                                          ? ' • ⏳ ממתין'
                                          : ''}
                                    {r.ownership !== 'shared' && (r.sharedWith?.length || 0) > 0
                                      ? ` • שותף עם ${r.sharedWith!.length}`
                                      : ''}
                                  </div>
                                </div>
                              </button>

                              <div className="flex items-center gap-1 shrink-0">
                                {onToggleBackgroundRoute && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      onToggleBackgroundRoute(r.id);
                                    }}
                                    className={`p-1.5 rounded-lg ${
                                      isPinnedBg ? 'text-sky-500 bg-sky-500/10' : t.muted
                                    } hover:bg-black/10`}
                                    title={isPinnedBg ? 'הסר נעיצה מהמפה' : 'נעץ במפה (יישאר מוצג גם בסגירת החלונית)'}
                                    aria-label={isPinnedBg ? `הסר ${r.name} מנעיצה` : `נעץ ${r.name} במפה`}
                                  >
                                    {isPinnedBg ? (
                                      <PinOff className="w-3.5 h-3.5" />
                                    ) : (
                                      <Pin className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                )}
                                {isSelected && <Check className="w-4 h-4 text-pink-500 shrink-0" />}
                              </div>
                            </div>
                          );
                        })}
                        {remainingFilteredCount > 0 && (
                          <button
                            type="button"
                            onClick={() => setVisibleCount((c) => c + DEFAULT_VISIBLE_ROUTES_BATCH)}
                            className={`w-full py-2 text-center text-xs font-bold text-pink-500 ${t.hoverRow}`}
                          >
                            טען עוד מסלולים ({remainingFilteredCount} נותרו)
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className={`p-4 rounded-xl border border-dashed text-center space-y-2 ${t.subCard}`}>
              <RouteIcon className="w-6 h-6 text-pink-500 mx-auto" />
              <div className="text-xs font-bold">אין מסלולים שמורים כרגע</div>
              <p className={`text-xs ${t.muted}`}>
                תכנן מסלול על גבי רשת הדרכים והשבילים או ייבא קובץ GPX, KML או TWL.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {onOpenRoutePlanner && (
                  <button
                    onClick={onOpenRoutePlanner}
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>תכנן מסלול חדש</span>
                  </button>
                )}
                {onOpenImporter && (
                  <button
                    onClick={onOpenImporter}
                    className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold inline-flex items-center gap-1.5"
                  >
                    <FileUp className="w-4 h-4" />
                    <span>ייבא מסלול למכשיר</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {!route && backgroundRouteIds.length > 0 && onClearBackgroundRoutes && (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="px-2.5 py-1 rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-500 font-semibold flex items-center gap-1.5">
            <span>מוצג ברקע ({backgroundRouteIds.length})</span>
            <button
              type="button"
              onClick={onClearBackgroundRoutes}
              className="underline font-bold"
            >
              נקה רקע
            </button>
          </span>
        </div>
      )}

      {/* Selected Route Telemetry, Shared Attribution, Edit Strip, Waypoints, Elevation Chart & Actions */}
      {route && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`px-2.5 py-1 rounded-full border font-semibold ${
                  routeDisplayMode === 'navigating'
                    ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500'
                    : 'border-pink-500/40 bg-pink-500/10 text-pink-500'
                }`}
              >
                {routeDisplayMode === 'navigating'
                  ? 'מוצג במפה • ניווט פעיל'
                  : backgroundRouteIds.includes(route.id)
                    ? 'נעוץ במפה (יישאר מוצג בסגירת החלונית)'
                    : 'מוצג במפה (יוסתר בסגירת החלונית)'}
              </span>

              {isSharedRoute && (
                <span className="px-2.5 py-1 rounded-full border border-violet-500/40 bg-violet-500/10 text-violet-400 font-semibold inline-flex items-center gap-1">
                  <Users className="w-3 h-3 shrink-0" />
                  <span>
                    שותף ע״י:{' '}
                    {route.sharedByName ||
                      route.sharedByEmail ||
                      route.ownerDisplayName ||
                      route.ownerEmail ||
                      'משתמש NavApp'}
                    {' • קריאה בלבד'}
                  </span>
                </span>
              )}
            </div>

            {backgroundRouteIds.length > 0 && onClearBackgroundRoutes && (
              <span className="px-2.5 py-1 rounded-full border border-sky-500/40 bg-sky-500/10 text-sky-500 font-semibold flex items-center gap-1.5">
                <span>מוצג ברקע ({backgroundRouteIds.length})</span>
                <button
                  type="button"
                  onClick={onClearBackgroundRoutes}
                  className="underline font-bold"
                >
                  נקה רקע
                </button>
              </span>
            )}
          </div>

          <div className={`grid grid-cols-4 gap-2 text-xs p-2.5 rounded-xl border ${t.subCard}`}>
            <div>
              <span className={`block ${t.muted}`}>אורך</span>
              <span dir="ltr" className="font-mono font-bold inline-block">
                {route.distanceKm} km
              </span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>טיפוס</span>
              <span dir="ltr" className="font-mono font-bold text-emerald-500 inline-block">
                +{route.ascentMeters}m
              </span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>ירידה</span>
              <span dir="ltr" className="font-mono font-bold text-amber-500 inline-block">
                -{route.descentMeters}m
              </span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>טווח גובה</span>
              <span dir="ltr" className="font-mono inline-block">
                {route.minEle}–{route.maxEle}m
              </span>
            </div>
          </div>

          {/* Route Action Bar: Shared Read-Only Actions OR Personal Route Editing Strip */}
          {isSharedRoute ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {onDuplicateSharedRoute && (
                <button
                  type="button"
                  onClick={() => void onDuplicateSharedRoute(route)}
                  className="px-3 py-1.5 rounded-xl border border-emerald-500/50 bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 text-xs font-bold flex items-center gap-1.5"
                  title="צור עותק אישי הניתן לעריכה במסלולים שלי"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>שמור עותק אצלי</span>
                </button>
              )}

              {onToggleBackgroundRoute && (
                <button
                  type="button"
                  onClick={() => onToggleBackgroundRoute(route.id)}
                  className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${
                    backgroundRouteIds.includes(route.id)
                      ? 'border-sky-500/60 bg-sky-500/10 text-sky-500'
                      : t.pillBtn
                  }`}
                  title={
                    backgroundRouteIds.includes(route.id)
                      ? 'הסר נעיצה מהמפה'
                      : 'נעץ מסלול במפה (יישאר מוצג גם בסגירת החלונית)'
                  }
                >
                  {backgroundRouteIds.includes(route.id) ? (
                    <PinOff className="w-3.5 h-3.5" />
                  ) : (
                    <Pin className="w-3.5 h-3.5 text-sky-500" />
                  )}
                  <span>
                    {backgroundRouteIds.includes(route.id) ? 'הסר מרקע' : 'השאר ברקע'}
                  </span>
                </button>
              )}

              {onDismissSharedRoute && (
                <button
                  type="button"
                  onClick={() => {
                    setHoveredIdx(null);
                    setPinnedIdx(null);
                    onHoverPoint(null);
                    void onDismissSharedRoute(route.id);
                  }}
                  className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1 text-red-400 ${t.pillBtn}`}
                  title="הסר מסלול משותף זה מהרשימה המקומית שלך"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>הסר מהרשימה</span>
                </button>
              )}
            </div>
          ) : (
            (onChangeRouteColor ||
              onReverseRoute ||
              onEditRouteInPlanner ||
              onToggleBackgroundRoute ||
              onShareRoute) && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {onShareRoute && (
                    <button
                      type="button"
                      onClick={() => onShareRoute(route)}
                      className="px-2.5 py-1.5 rounded-xl border border-indigo-500/50 bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 text-xs font-bold flex items-center gap-1.5"
                      title="שתף מסלול עם משתמש NavApp או כתובת Gmail"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      <span>
                        {(route.sharedWith?.length || 0) > 0
                          ? `שתף (${route.sharedWith!.length})`
                          : 'שתף'}
                      </span>
                    </button>
                  )}
                  {onChangeRouteColor && (
                    <button
                      type="button"
                      onClick={() => setIsColorPickerOpen((v) => !v)}
                      className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${
                        isColorPickerOpen ? 'border-pink-500/70' : ''
                      } ${t.pillBtn}`}
                      title="שנה צבע מסלול"
                    >
                      <Palette className="w-3.5 h-3.5" style={{ color: activeColor }} />
                      <span>צבע</span>
                      <span
                        className="w-2.5 h-2.5 rounded-full border border-white/60"
                        style={{ backgroundColor: activeColor }}
                      />
                    </button>
                  )}

                  {onReverseRoute && (
                    <button
                      type="button"
                      onClick={() => onReverseRoute(route.id)}
                      className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${t.pillBtn}`}
                      title="הפוך את כיוון המסלול"
                    >
                      <ArrowLeftRight className="w-3.5 h-3.5 text-sky-500" />
                      <span>הפוך כיוון</span>
                    </button>
                  )}

                  {onToggleBackgroundRoute && (
                    <button
                      type="button"
                      onClick={() => onToggleBackgroundRoute(route.id)}
                      className={`px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 ${
                        backgroundRouteIds.includes(route.id)
                          ? 'border-sky-500/60 bg-sky-500/10 text-sky-500'
                          : t.pillBtn
                      }`}
                      title={
                    backgroundRouteIds.includes(route.id)
                      ? 'הסר נעיצה מהמפה'
                      : 'נעץ מסלול במפה (יישאר מוצג גם בסגירת החלונית)'
                  }
                    >
                      {backgroundRouteIds.includes(route.id) ? (
                        <PinOff className="w-3.5 h-3.5" />
                      ) : (
                        <Pin className="w-3.5 h-3.5 text-sky-500" />
                      )}
                      <span>
                        {backgroundRouteIds.includes(route.id) ? 'הסר מרקע' : 'השאר ברקע'}
                      </span>
                    </button>
                  )}

                  {onEditRouteInPlanner &&
                    (route.sourceFormat === 'planned' ||
                      (route.waypoints && route.waypoints.length >= 2)) && (
                      <button
                        type="button"
                        onClick={() => onEditRouteInPlanner(route)}
                        className="px-2.5 py-1.5 rounded-xl border border-blue-500/40 bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 text-xs font-bold flex items-center gap-1.5"
                        title="פתח לעריכת נקודות ציר במתכנן"
                      >
                        <PenTool className="w-3.5 h-3.5" />
                        <span>ערוך נקודות</span>
                      </button>
                    )}
                </div>

                {isColorPickerOpen && onChangeRouteColor && (
                  <div
                    className={`p-2 rounded-xl border flex items-center justify-between gap-2 ${t.subCard}`}
                  >
                    <span className={`text-xs font-semibold ${t.muted}`}>צבע במפה:</span>
                    <div className="flex items-center gap-1.5">
                      {ROUTE_COLOR_PALETTE.map((hex) => {
                        const selected = activeColor.toLowerCase() === hex.toLowerCase();
                        return (
                          <button
                            key={hex}
                            type="button"
                            onClick={() => {
                              void onChangeRouteColor(route.id, hex);
                              setIsColorPickerOpen(false);
                            }}
                            className={`w-6 h-6 rounded-full flex items-center justify-center border-2 transition-transform hover:scale-110 ${
                              selected ? 'border-white ring-2 ring-pink-500' : 'border-white/40'
                            }`}
                            style={{ backgroundColor: hex }}
                            title={`בחר צבע ${hex}`}
                            aria-label={`בחר צבע ${hex}`}
                          >
                            {selected && <Check className="w-3 h-3 text-white stroke-[3]" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )
          )}

          {/* Route Points / Waypoints Dropdown List */}
          {routePoints.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsPointsMenuOpen(!isPointsMenuOpen);
                }}
                aria-expanded={isPointsMenuOpen}
                className={`w-full px-3 py-2 rounded-xl border text-xs flex items-center justify-between gap-2 transition-colors ${t.subCard} hover:border-pink-500/70`}
              >
                <span className="flex items-center gap-1.5 font-semibold">
                  <MapPin className="w-3.5 h-3.5 text-pink-500 shrink-0" />
                  <span>נקודות לאורך המסלול ({routePoints.length})</span>
                </span>
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${
                    isPointsMenuOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {isPointsMenuOpen && (
                <div
                  className={`mt-1.5 rounded-xl border shadow-lg max-h-48 overflow-y-auto divide-y ${t.panelSolid} ${t.divider}`}
                >
                  {routePoints.map((ptOpt) => (
                    <button
                      key={ptOpt.id}
                      type="button"
                      onClick={() => handleSelectPointOption(ptOpt)}
                      className={`w-full px-3 py-2 text-right text-xs flex items-center justify-between gap-2 transition-colors ${t.hoverRow}`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        {ptOpt.poiCategory ? (
                          <PoiCategoryIcon
                            category={ptOpt.poiCategory}
                            subcategory={ptOpt.subcategory}
                            size={16}
                          />
                        ) : (
                          <span className="shrink-0">{ptOpt.emoji}</span>
                        )}
                        <span className="font-semibold truncate" dir="auto">
                          {ptOpt.label}
                        </span>
                      </span>
                      <span dir="ltr" className={`font-mono shrink-0 ${t.muted}`}>
                        {ptOpt.distKm} km • {ptOpt.ele}m
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {renderChart(route)}

          <div className="flex flex-wrap gap-2">
            {isNavigating ? (
              <button
                onClick={onStopNavigation}
                className="flex-1 py-2.5 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold flex items-center justify-center gap-1.5"
              >
                <Compass className="w-4 h-4" />
                <span>עצור ניווט</span>
              </button>
            ) : (
              onStartNavigation && (
                <button
                  onClick={() => onStartNavigation(route)}
                  className="flex-1 py-2.5 px-3 rounded-xl bg-pink-600 hover:bg-pink-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Compass className="w-4 h-4" />
                  <span>התחל ניווט במסלול</span>
                </button>
              )
            )}

            <button
              onClick={() => onFlyToRoute(route)}
              className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
              title="התמקד במסלול"
            >
              <Navigation className="w-3.5 h-3.5 text-pink-500" />
              <span>הצג</span>
            </button>

            <button
              onClick={() => void handleExportGpx(route)}
              className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
              title="ייצא כקובץ GPX"
            >
              <Download className="w-3.5 h-3.5 text-sky-500" />
              <span>GPX</span>
            </button>

            {onSendToPlanningDb && (
              <button
                onClick={() => onSendToPlanningDb(route)}
                className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
                title="שלח למאגר תכנון מסלולים (תיקיות, קטגוריה וקושי)"
              >
                <FolderTree className="w-3.5 h-3.5 text-emerald-500" />
                <span>למאגר תכנון</span>
              </button>
            )}

            {!isSharedRoute && onDeleteRoute && (
              <button
                onClick={() => {
                  setHoveredIdx(null);
                  setPinnedIdx(null);
                  onHoverPoint(null);
                  onDeleteRoute(route.id);
                }}
                className={`px-2.5 py-2.5 rounded-xl border text-xs font-bold text-red-500 ${t.pillBtn}`}
                title="מחק מסלול"
                aria-label="מחק מסלול"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );

  if (embedded) return innerContent;
  if (!route) return null;

  return (
    <div
      className={`fixed bottom-4 left-4 right-4 md:left-6 md:right-auto md:w-[560px] z-30 rounded-2xl border overflow-hidden ${t.panel}`}
    >
      {innerContent}
    </div>
  );
};
