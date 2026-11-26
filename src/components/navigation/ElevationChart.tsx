import React from 'react';
import type { SavedRouteRecord } from '../../core/db/NavDatabase';
import type { RoutePointOption } from '../../core/navigation/routeTelemetryHelpers';
import { MilitaryGridService } from '../../core/navigation/MilitaryGridService';
import { PoiCategoryIcon } from '../pois/PoiCategoryIcon';
import { getSurfaceTheme, type MapTheme } from '../ui/themeTokens';

interface ElevationChartProps {
  route: SavedRouteRecord;
  strokeColor: string;
  routePoints: RoutePointOption[];
  theme: MapTheme;
  hoveredIdx: number | null;
  pinnedIdx: number | null;
  justSwitchedRoute: boolean;
  onHoverIdxChange: (idx: number | null) => void;
  onPinnedIdxChange: (idx: number | null) => void;
  onHoverPoint: (pt: { lon: number; lat: number; ele: number; distKm: number } | null) => void;
}

export const ElevationChart: React.FC<ElevationChartProps> = ({
  route,
  strokeColor,
  routePoints,
  theme,
  hoveredIdx,
  pinnedIdx,
  justSwitchedRoute,
  onHoverIdxChange,
  onPinnedIdxChange,
  onHoverPoint,
}) => {
  const t = getSurfaceTheme(theme);
  if (route.elevationProfile.length < 2) return null;

  const pts = route.elevationProfile;
  const minEle = Math.min(...pts.map((p) => p.ele));
  const maxEle = Math.max(...pts.map((p) => p.ele));
  const eleSpan = Math.max(20, maxEle - minEle);
  const midEle = Math.round((minEle + maxEle) / 2);
  const totalDist = pts[pts.length - 1].distKm || 1;

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

  const clampIdx = (idx: number | null): number | null => {
    if (justSwitchedRoute || idx === null || !Number.isInteger(idx) || pts.length === 0) {
      return null;
    }
    return Math.min(pts.length - 1, Math.max(0, idx));
  };

  const safeHoveredIdx = clampIdx(hoveredIdx);
  const safePinnedIdx = clampIdx(pinnedIdx);
  const activeIdx = safeHoveredIdx !== null ? safeHoveredIdx : safePinnedIdx;

  const getNearestIdxFromPointer = (clientX: number, rect: DOMRect): number | null => {
    if (!rect || rect.width <= 0 || pts.length === 0) return null;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const idx = Math.round(ratio * (pts.length - 1));
    return Number.isFinite(idx) ? Math.min(pts.length - 1, Math.max(0, idx)) : null;
  };

  const handleScrub = (clientX: number, rect: DOMRect) => {
    const nearestIdx = getNearestIdxFromPointer(clientX, rect);
    if (nearestIdx === null || !pts[nearestIdx]) return;
    onHoverIdxChange(nearestIdx);
    onHoverPoint(pts[nearestIdx]);
  };

  const handleChartClick = (clientX: number, rect: DOMRect) => {
    const nearestIdx = getNearestIdxFromPointer(clientX, rect);
    if (nearestIdx === null || !pts[nearestIdx]) return;
    onPinnedIdxChange(nearestIdx);
    onHoverIdxChange(nearestIdx);
    onHoverPoint(pts[nearestIdx]);
  };

  const activeSvgPt =
    activeIdx !== null && activeIdx >= 0 && activeIdx < coordsSvg.length
      ? coordsSvg[activeIdx]
      : null;
  const activePt = activeSvgPt?.pt ?? null;

  let gradePct: number | null = null;
  if (activeIdx !== null && pts.length >= 2) {
    const prevIdx = Math.max(0, activeIdx - 1);
    const nextIdx = Math.min(pts.length - 1, activeIdx + 1);
    const prevPt = pts[prevIdx];
    const nextPt = pts[nextIdx];
    if (prevPt && nextPt) {
      const dDistMeters = (nextPt.distKm - prevPt.distKm) * 1000;
      if (dDistMeters >= 15) {
        gradePct = Math.round(((nextPt.ele - prevPt.ele) / dDistMeters) * 100);
      }
    }
  }

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

  const gradId = `eleGrad-${route.id.replace(/[^a-zA-Z0-9_-]/g, '') || 'route'}`;

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
          onHoverIdxChange(null);
          if (safePinnedIdx !== null && pts[safePinnedIdx]) {
            onHoverPoint(pts[safePinnedIdx]);
          } else {
            onHoverPoint(null);
          }
        }}
      >
        {activePt && (
          <div
            style={{ left: `${tooltipLeftPct}%` }}
            className={`absolute top-0.5 -translate-x-1/2 z-20 pointer-events-none px-2.5 py-1 rounded-xl border shadow-xl backdrop-blur-md whitespace-nowrap text-xs flex items-center gap-2 ${t.panelSolid}`}
          >
            <span dir="ltr" className="font-mono font-bold" style={{ color: strokeColor }}>
              {activePt.ele}m
            </span>
            <span className="opacity-30">•</span>
            <span dir="ltr" className="font-mono">
              {activePt.distKm} km
            </span>
            {gradePct !== null && (
              <>
                <span className="opacity-30">•</span>
                <span
                  dir="ltr"
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
                <span className="inline-flex items-center gap-1 font-semibold truncate max-w-[125px]" dir="auto">
                  {nearestNamedWpt.poiCategory ? (
                    <PoiCategoryIcon
                      category={nearestNamedWpt.poiCategory}
                      subcategory={nearestNamedWpt.subcategory}
                      size={14}
                    />
                  ) : (
                    <span>{nearestNamedWpt.emoji}</span>
                  )}
                  <span className="truncate">{nearestNamedWpt.label}</span>
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

        <div
          dir="ltr"
          className={`absolute top-1 right-1 text-[10px] font-mono pointer-events-none ${t.muted}`}
        >
          {maxEle}m
        </div>
        <div
          dir="ltr"
          className={`absolute top-1/2 -translate-y-1/2 right-1 text-[10px] font-mono pointer-events-none ${t.muted}`}
        >
          {midEle}m
        </div>
        <div
          dir="ltr"
          className={`absolute bottom-1 right-1 text-[10px] font-mono pointer-events-none ${t.muted}`}
        >
          {minEle}m
        </div>
      </div>

      <div className={`flex items-center justify-between text-xs font-mono mt-1 ${t.muted}`}>
        <span dir="ltr">0 km</span>
        <span className="flex items-center gap-2 font-sans">
          <span dir={activePt ? 'ltr' : 'rtl'}>
            {activePt
              ? `${activePt.distKm} km • ${activePt.ele}m`
              : 'החלק או לחץ על הגרף לפרטי נקודה'}
          </span>
          {safePinnedIdx !== null && (
            <button
              type="button"
              onClick={() => {
                onPinnedIdxChange(null);
                onHoverIdxChange(null);
                onHoverPoint(null);
              }}
              style={{ color: strokeColor }}
              className="font-bold hover:underline"
            >
              שחרר נעילה
            </button>
          )}
        </span>
        <span dir="ltr">{route.distanceKm} km</span>
      </div>
    </div>
  );
};
