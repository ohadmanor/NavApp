import React, { useMemo, useState } from 'react';
import * as turf from '@turf/turf';
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
} from 'lucide-react';
import type { PoiRecord, SavedRouteRecord } from '../../core/db/NavDatabase';
import { RouteManager } from '../../core/navigation/RouteManager';
import { MilitaryGridService } from '../../core/navigation/MilitaryGridService';
import { getSurfaceTheme, POI_CATEGORY_META, type MapTheme } from '../ui/themeTokens';

export interface RouteChartPoint {
  lon: number;
  lat: number;
  ele: number;
  distKm: number;
  label?: string;
}

interface RoutePointOption extends RouteChartPoint {
  id: string;
  label: string;
  emoji: string;
  kind: 'start' | 'end' | 'peak' | 'wpt';
}

interface ElevationProfileDrawerProps {
  route: SavedRouteRecord | null;
  routes?: SavedRouteRecord[];
  pois?: PoiRecord[];
  theme?: MapTheme;
  isNavigating?: boolean;
  onSelectRoute?: (route: SavedRouteRecord | null) => void;
  onStartNavigation?: (route: SavedRouteRecord) => void;
  onStopNavigation?: () => void;
  onOpenImporter?: () => void;
  onDeleteRoute?: (routeId: string) => void;
  onClose: () => void;
  onHoverPoint: (pt: { lon: number; lat: number; ele: number; distKm: number } | null) => void;
  onSelectPoint?: (pt: { lon: number; lat: number; ele: number; distKm: number }) => void;
  onFlyToRoute: (route: SavedRouteRecord) => void;
  onFitAllRoutes?: () => void;
  embedded?: boolean;
}

export const ElevationProfileDrawer: React.FC<ElevationProfileDrawerProps> = ({
  route,
  routes = [],
  pois = [],
  theme = 'topo-dark',
  isNavigating = false,
  onSelectRoute,
  onStartNavigation,
  onStopNavigation,
  onOpenImporter,
  onDeleteRoute,
  onClose,
  onHoverPoint,
  onSelectPoint,
  onFlyToRoute,
  onFitAllRoutes,
  embedded = false,
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [pinnedIdx, setPinnedIdx] = useState<number | null>(null);
  const [isRoutesMenuOpen, setIsRoutesMenuOpen] = useState(false);
  const [isPointsMenuOpen, setIsPointsMenuOpen] = useState(false);
  const t = getSurfaceTheme(theme);

  const getDisplayColor = (r: SavedRouteRecord | null) =>
    !r?.color || r.color === '#10b981' ? '#ec4899' : r.color;

  const routePoints = useMemo<RoutePointOption[]>(() => {
    if (!route || route.elevationProfile.length === 0) return [];
    const pts = route.elevationProfile;
    const options: RoutePointOption[] = [];

    const first = pts[0];
    options.push({
      id: 'pt-start',
      label: 'נקודת התחלה',
      emoji: '🟢',
      kind: 'start',
      ...first,
    });

    // Find waypoints/POIs along this route (within 400m)
    const lineFeatures = route.geojson.features.filter(
      (f) => f.geometry?.type === 'LineString'
    ) as Array<GeoJSON.Feature<GeoJSON.LineString>>;

    if (lineFeatures.length > 0 && pois.length > 0) {
      const nearbyWpts: RoutePointOption[] = [];
      for (const poi of pois) {
        const pt = turf.point([poi.lon, poi.lat]);
        let minLineKm = Infinity;
        for (const lf of lineFeatures) {
          const d = turf.pointToLineDistance(pt, lf, { units: 'kilometers' });
          if (d < minLineKm) minLineKm = d;
        }
        const maxRadiusKm = poi.subcategory?.startsWith('imported_') ? 1.5 : 0.35;
        if (minLineKm <= maxRadiusKm) {
          // Match closest sample in elevationProfile for distKm & fallback elevation
          let bestSample = pts[0];
          let bestSampleDist = Infinity;
          for (const sample of pts) {
            const d = turf.distance(pt, turf.point([sample.lon, sample.lat]), {
              units: 'kilometers',
            });
            if (d < bestSampleDist) {
              bestSampleDist = d;
              bestSample = sample;
            }
          }
          const meta = POI_CATEGORY_META[poi.category] || POI_CATEGORY_META.heritage;
          nearbyWpts.push({
            id: `pt-wpt-${poi.id}`,
            label: poi.nameHe || poi.name,
            emoji: meta.emoji,
            kind: 'wpt',
            lon: poi.lon,
            lat: poi.lat,
            ele: poi.ele ?? bestSample.ele,
            distKm: bestSample.distKm,
          });
        }
      }
      nearbyWpts.sort((a, b) => a.distKm - b.distKm);
      const dedupedWpts: RoutePointOption[] = [];
      for (const wp of nearbyWpts) {
        const norm = wp.label.trim().toLowerCase();
        const isDup = dedupedWpts.some(
          (existing) =>
            existing.label.trim().toLowerCase() === norm &&
            Math.abs(existing.distKm - wp.distKm) < 0.8
        );
        if (!isDup) dedupedWpts.push(wp);
      }
      options.push(...dedupedWpts.slice(0, 25));
    }

    // Add Peak elevation point if distinct from start/end
    if (pts.length >= 3) {
      let peakIdx = 0;
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].ele > pts[peakIdx].ele) peakIdx = i;
      }
      if (peakIdx > 0 && peakIdx < pts.length - 1 && route.maxEle > route.minEle) {
        options.push({
          id: 'pt-peak',
          label: `שיא גובה (${pts[peakIdx].ele}m)`,
          emoji: '🏔️',
          kind: 'peak',
          ...pts[peakIdx],
        });
      }
    }

    if (pts.length > 1) {
      const last = pts[pts.length - 1];
      options.push({
        id: 'pt-end',
        label: 'נקודת סיום',
        emoji: '🔴',
        kind: 'end',
        ...last,
      });
    }

    return options;
  }, [route, pois]);

  const handleExportGpx = (r: SavedRouteRecord) => {
    const gpxXml = RouteManager.exportRouteAsGpx(r);
    const blob = new Blob([gpxXml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${r.id}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderChart = (r: SavedRouteRecord) => {
    if (r.elevationProfile.length < 2) return null;
    const pts = r.elevationProfile;
    const minEle = Math.min(...pts.map((p) => p.ele));
    const maxEle = Math.max(...pts.map((p) => p.ele));
    const eleSpan = Math.max(20, maxEle - minEle);
    const midEle = Math.round((minEle + maxEle) / 2);
    const totalDist = pts[pts.length - 1].distKm || 1;
    const strokeColor = getDisplayColor(r);

    const width = 520;
    const height = 112;
    const padX = 12;
    const padY = 16;

    const coordsSvg = pts.map((p, idx) => {
      const x = padX + (p.distKm / totalDist) * (width - padX * 2);
      const y = height - padY - ((p.ele - minEle) / eleSpan) * (height - padY * 2);
      return { x, y, pt: p, idx };
    });

    const linePath = coordsSvg
      .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const areaPath = `${linePath} L ${coordsSvg[coordsSvg.length - 1].x.toFixed(1)} ${height} L ${coordsSvg[0].x.toFixed(1)} ${height} Z`;

    const activeIdx = hoveredIdx !== null ? hoveredIdx : pinnedIdx;

    const getNearestIdxFromPointer = (clientX: number, rect: DOMRect) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1)));
    };

    const handleScrub = (clientX: number, rect: DOMRect) => {
      const nearestIdx = getNearestIdxFromPointer(clientX, rect);
      setHoveredIdx(nearestIdx);
      onHoverPoint(pts[nearestIdx]);
    };

    const handleChartClick = (clientX: number, rect: DOMRect) => {
      const nearestIdx = getNearestIdxFromPointer(clientX, rect);
      setPinnedIdx(nearestIdx);
      setHoveredIdx(nearestIdx);
      onHoverPoint(pts[nearestIdx]);
    };

    const activeSvgPt = activeIdx !== null ? coordsSvg[activeIdx] : null;
    const activePt = activeSvgPt?.pt ?? null;

    // Instantaneous slope (%) around activeIdx
    let gradePct: number | null = null;
    if (activeIdx !== null && pts.length >= 2) {
      const prevIdx = Math.max(0, activeIdx - 1);
      const nextIdx = Math.min(pts.length - 1, activeIdx + 1);
      const dDistMeters = (pts[nextIdx].distKm - pts[prevIdx].distKm) * 1000;
      if (dDistMeters >= 15) {
        gradePct = Math.round(((pts[nextIdx].ele - pts[prevIdx].ele) / dDistMeters) * 100);
      }
    }

    // Nearest named waypoint/point near activePt
    const nearestNamedWpt =
      activePt && routePoints.length > 0
        ? routePoints.find(
            (wp) =>
              wp.kind === 'wpt' &&
              Math.abs(wp.distKm - activePt.distKm) <= Math.max(0.18, totalDist * 0.03)
          )
        : undefined;

    const activeMil = activePt
      ? MilitaryGridService.toMilitaryCoords(activePt.lon, activePt.lat).idfGrid8Digit
      : null;

    const tooltipLeftPct = activeSvgPt
      ? Math.max(18, Math.min(82, (activeSvgPt.x / width) * 100))
      : 50;

    const gradId = `eleGrad-${r.id.replace(/[^a-zA-Z0-9_-]/g, '') || 'route'}`;

    // Map route waypoints to SVG positions anchored on the plotted elevation curve
    const wptMarkers = routePoints
      .filter((wp) => wp.kind === 'wpt')
      .map((wp) => {
        let closestSvg = coordsSvg[0];
        let minDiff = Infinity;
        for (const c of coordsSvg) {
          const diff = Math.abs(c.pt.distKm - wp.distKm);
          if (diff < minDiff) {
            minDiff = diff;
            closestSvg = c;
          }
        }
        return { wp, x: closestSvg.x, y: closestSvg.y };
      });

    return (
      <div className={`relative w-full rounded-xl border p-2 ${t.subCard}`}>
        <div
          className="relative w-full h-28 cursor-crosshair touch-none"
          onMouseMove={(e) => handleScrub(e.clientX, e.currentTarget.getBoundingClientRect())}
          onClick={(e) => handleChartClick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onTouchMove={(e) => {
            if (e.touches[0]) {
              handleScrub(e.touches[0].clientX, e.currentTarget.getBoundingClientRect());
            }
          }}
          onMouseLeave={() => {
            setHoveredIdx(null);
            if (pinnedIdx === null) {
              onHoverPoint(null);
            } else {
              onHoverPoint(pts[pinnedIdx]);
            }
          }}
        >
          {/* Floating Info Card directly over the hovered/pinned point on the height graph */}
          {activePt && (
            <div
              style={{ left: `${tooltipLeftPct}%` }}
              className={`absolute top-0.5 -translate-x-1/2 z-20 pointer-events-none px-2.5 py-1 rounded-xl border shadow-xl backdrop-blur-md whitespace-nowrap text-xs flex items-center gap-2 ${t.panelSolid}`}
            >
              <span className="font-mono font-bold text-pink-500">{activePt.ele}m</span>
              <span className="opacity-30">•</span>
              <span className="font-mono">{activePt.distKm} km</span>
              {gradePct !== null && (
                <>
                  <span className="opacity-30">•</span>
                  <span
                    className={`font-mono font-bold ${
                      gradePct > 0 ? 'text-emerald-500' : gradePct < 0 ? 'text-amber-500' : t.muted
                    }`}
                  >
                    {gradePct > 0 ? `+${gradePct}%` : `${gradePct}%`}
                  </span>
                </>
              )}
              {nearestNamedWpt ? (
                <>
                  <span className="opacity-30">•</span>
                  <span className="font-semibold truncate max-w-[110px]" dir="auto">
                    {nearestNamedWpt.emoji} {nearestNamedWpt.label}
                  </span>
                </>
              ) : (
                activeMil && (
                  <>
                    <span className="opacity-30 hidden sm:inline">•</span>
                    <span className={`font-mono hidden sm:inline ${t.muted}`} dir="ltr">
                      {activeMil}
                    </span>
                  </>
                )
              )}
            </div>
          )}

          <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible">
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity="0.42" />
                <stop offset="100%" stopColor={strokeColor} stopOpacity="0.04" />
              </linearGradient>
            </defs>

            {/* Horizontal Elevation Reference Lines */}
            {[padY, height / 2, height - padY].map((gy, idx) => (
              <line
                key={idx}
                x1={padX}
                y1={gy}
                x2={width - padX}
                y2={gy}
                stroke="currentColor"
                strokeOpacity="0.1"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            ))}

            <path d={areaPath} fill={`url(#${gradId})`} />
            <path
              d={linePath}
              fill="none"
              stroke={strokeColor}
              strokeWidth="2.8"
              strokeLinecap="round"
            />

            {/* Waypoint Markers along the elevation curve */}
            {wptMarkers.map(({ wp, x, y }) => (
              <circle
                key={wp.id}
                cx={x}
                cy={y}
                r={3.5}
                fill="#ffffff"
                stroke={strokeColor}
                strokeWidth={2}
              />
            ))}

            {/* Vertical Crosshair + Active Point Marker */}
            {activeSvgPt && (
              <>
                <line
                  x1={activeSvgPt.x}
                  y1={padY / 2}
                  x2={activeSvgPt.x}
                  y2={height}
                  stroke={strokeColor}
                  strokeDasharray="3 3"
                  strokeWidth="1.5"
                />
                <circle
                  cx={activeSvgPt.x}
                  cy={activeSvgPt.y}
                  r={5.5}
                  fill={strokeColor}
                  stroke="#ffffff"
                  strokeWidth={2}
                />
              </>
            )}
          </svg>

          {/* Min / Mid / Max subtle elevation labels inside chart */}
          <div className={`absolute top-1 right-1 text-[10px] font-mono pointer-events-none ${t.muted}`}>
            {maxEle}m
          </div>
          <div className={`absolute top-1/2 -translate-y-1/2 right-1 text-[10px] font-mono pointer-events-none ${t.muted}`}>
            {midEle}m
          </div>
          <div className={`absolute bottom-1 right-1 text-[10px] font-mono pointer-events-none ${t.muted}`}>
            {minEle}m
          </div>
        </div>

        <div className={`flex items-center justify-between text-xs font-mono mt-1 ${t.muted}`}>
          <span>0 km</span>
          <span className="flex items-center gap-2 font-sans">
            <span>
              {activePt
                ? `${activePt.distKm} km • ${activePt.ele}m`
                : 'החלק או לחץ על הגרף לפרטי נקודה'}
            </span>
            {pinnedIdx !== null && (
              <button
                type="button"
                onClick={() => {
                  setPinnedIdx(null);
                  setHoveredIdx(null);
                  onHoverPoint(null);
                }}
                className="text-pink-500 font-bold hover:underline"
              >
                שחרר נעילה
              </button>
            )}
          </span>
          <span>{r.distanceKm} km</span>
        </div>
      </div>
    );
  };

  const handleSelectRouteOption = (r: SavedRouteRecord) => {
    setPinnedIdx(null);
    setHoveredIdx(null);
    setIsRoutesMenuOpen(false);
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

  const innerContent = (
    <div dir="rtl" className="p-4 space-y-3 overflow-y-auto min-h-0 flex-1">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TrendingUp className="w-4 h-4 text-pink-500 shrink-0" />
          <div className="min-w-0">
            <span className="text-xs font-bold text-pink-500 block">
              מסלולים ופרופיל גובה (DEM)
            </span>
            <h4 className="text-sm font-bold truncate" dir="auto">
              {route ? route.name : `מסלולים שמורים (${routes.length})`}
            </h4>
          </div>
        </div>
        <button
          onClick={onClose}
          className={`p-1.5 rounded-lg border shrink-0 ${t.pillBtn}`}
          title="סגור"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Routes Dropdown Selector + Action Buttons (Zero Horizontal Cut-Off) */}
      {routes.length > 0 ? (
        <div className="space-y-2 relative">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <button
                type="button"
                onClick={() => {
                  setIsRoutesMenuOpen(!isRoutesMenuOpen);
                  setIsPointsMenuOpen(false);
                }}
                aria-expanded={isRoutesMenuOpen}
                className={`w-full px-3 py-2 rounded-xl border text-xs flex items-center justify-between gap-2 transition-colors ${t.subCard} hover:border-pink-500/70`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: getDisplayColor(route) }}
                  />
                  <span className="font-bold truncate" dir="auto">
                    {route ? route.name : 'בחר מסלול מהרשימה...'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {route && (
                    <span className={`font-mono ${t.muted}`}>
                      {route.distanceKm} km ({routes.length})
                    </span>
                  )}
                  <ChevronDown
                    className={`w-4 h-4 transition-transform ${
                      isRoutesMenuOpen ? 'rotate-180' : ''
                    }`}
                  />
                </div>
              </button>
            </div>

            {routes.length > 1 && onFitAllRoutes && (
              <button
                type="button"
                onClick={onFitAllRoutes}
                className={`px-2.5 py-2 rounded-xl border text-xs font-bold flex items-center gap-1 shrink-0 ${t.pillBtn}`}
                title="הצג את כל המסלולים במפה"
              >
                <Maximize2 className="w-3.5 h-3.5 text-pink-500" />
                <span>הכל</span>
              </button>
            )}

            {onOpenImporter && (
              <button
                type="button"
                onClick={onOpenImporter}
                className="px-2.5 py-2 rounded-xl border border-sky-500/50 bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 text-xs font-bold flex items-center gap-1 shrink-0"
                title="ייבוא קובץ GPX / KML / TWL"
              >
                <FileUp className="w-3.5 h-3.5" />
                <span>ייבא</span>
              </button>
            )}
          </div>

          {isRoutesMenuOpen && (
            <div
              className={`rounded-xl border shadow-lg max-h-48 overflow-y-auto divide-y ${t.panelSolid} ${t.divider}`}
            >
              {routes.map((r, idx) => {
                const isSelected = route?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => handleSelectRouteOption(r)}
                    className={`w-full px-3 py-2.5 text-right text-xs flex items-center justify-between gap-2 transition-colors ${
                      isSelected ? 'bg-pink-500/15 font-bold' : t.hoverRow
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: getDisplayColor(r) }}
                      />
                      <div className="min-w-0">
                        <div className="font-bold break-words" dir="auto">
                          {r.name}
                        </div>
                        <div className={`font-mono text-[11px] ${t.muted}`}>
                          #{idx + 1} • {r.distanceKm} km • +{r.ascentMeters}m •{' '}
                          {r.sourceFormat.toUpperCase()}
                        </div>
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-pink-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className={`p-4 rounded-xl border border-dashed text-center space-y-2 ${t.subCard}`}>
          <RouteIcon className="w-6 h-6 text-pink-500 mx-auto" />
          <div className="text-xs font-bold">אין מסלולים שמורים כרגע</div>
          <p className={`text-xs ${t.muted}`}>
            ייבא קובץ GPX, KML או TWL (מעמוד ענן / Off-Road / IHM) או הקלט מסלול בשטח.
          </p>
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
      )}

      {/* Selected Route Telemetry, Waypoints Dropdown, Elevation Chart & Actions */}
      {route && (
        <>
          <div className={`grid grid-cols-4 gap-2 text-xs p-2.5 rounded-xl border ${t.subCard}`}>
            <div>
              <span className={`block ${t.muted}`}>אורך</span>
              <span className="font-mono font-bold">{route.distanceKm} km</span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>טיפוס</span>
              <span className="font-mono font-bold text-emerald-500">+{route.ascentMeters}m</span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>ירידה</span>
              <span className="font-mono font-bold text-amber-500">-{route.descentMeters}m</span>
            </div>
            <div>
              <span className={`block ${t.muted}`}>טווח גובה</span>
              <span className="font-mono">
                {route.minEle}–{route.maxEle}m
              </span>
            </div>
          </div>

          {/* Route Points / Waypoints Dropdown List */}
          {routePoints.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setIsPointsMenuOpen(!isPointsMenuOpen);
                  setIsRoutesMenuOpen(false);
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
                        <span className="shrink-0">{ptOpt.emoji}</span>
                        <span className="font-semibold truncate" dir="auto">
                          {ptOpt.label}
                        </span>
                      </span>
                      <span className={`font-mono shrink-0 ${t.muted}`}>
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
              onClick={() => handleExportGpx(route)}
              className={`px-3 py-2.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
              title="ייצא כקובץ GPX"
            >
              <Download className="w-3.5 h-3.5 text-sky-500" />
              <span>GPX</span>
            </button>

            {onDeleteRoute && (
              <button
                onClick={() => onDeleteRoute(route.id)}
                className={`px-2.5 py-2.5 rounded-xl border text-xs font-bold text-red-500 ${t.pillBtn}`}
                title="מחק מסלול"
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
