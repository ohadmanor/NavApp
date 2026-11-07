import React from 'react';
import { TrendingUp, Download, X, Navigation } from 'lucide-react';
import type { SavedRouteRecord } from '../../core/db/NavDatabase';
import { RouteManager } from '../../core/navigation/RouteManager';

interface ElevationProfileDrawerProps {
  route: SavedRouteRecord | null;
  onClose: () => void;
  onHoverPoint: (pt: { lon: number; lat: number; ele: number; distKm: number } | null) => void;
  onFlyToRoute: (route: SavedRouteRecord) => void;
}

export const ElevationProfileDrawer: React.FC<ElevationProfileDrawerProps> = ({
  route,
  onClose,
  onHoverPoint,
  onFlyToRoute,
}) => {
  if (!route || route.elevationProfile.length < 2) return null;

  const pts = route.elevationProfile;
  const minEle = Math.min(...pts.map((p) => p.ele));
  const maxEle = Math.max(...pts.map((p) => p.ele));
  const eleSpan = Math.max(20, maxEle - minEle);
  const totalDist = pts[pts.length - 1].distKm || 1;

  const width = 600;
  const height = 110;
  const padX = 12;
  const padY = 14;

  const coordsSvg = pts.map((p) => {
    const x = padX + (p.distKm / totalDist) * (width - padX * 2);
    const y = height - padY - ((p.ele - minEle) / eleSpan) * (height - padY * 2);
    return { x, y, pt: p };
  });

  const linePath = coordsSvg
    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L ${coordsSvg[coordsSvg.length - 1].x.toFixed(1)} ${height} L ${coordsSvg[0].x.toFixed(1)} ${height} Z`;

  const handleExportGpx = () => {
    const gpxXml = RouteManager.exportRouteAsGpx(route);
    const blob = new Blob([gpxXml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${route.id}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 md:left-6 md:right-auto md:w-[620px] z-30 bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-2xl p-4 text-slate-100">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" />
          <h4 className="text-sm font-bold text-white truncate" dir="auto">
            {route.name}
          </h4>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => onFlyToRoute(route)}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-emerald-300 flex items-center gap-1"
          >
            <Navigation className="w-3.5 h-3.5" />
            <span>הצג מסלול</span>
          </button>
          <button
            onClick={handleExportGpx}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-sky-300 flex items-center gap-1"
          >
            <Download className="w-3.5 h-3.5" />
            <span>GPX</span>
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Route Stats Row */}
      <div className="grid grid-cols-4 gap-2 text-xs mb-2 bg-slate-950/70 p-2 rounded-xl border border-slate-800">
        <div>
          <span className="text-slate-400 block">אורך מסלול</span>
          <span className="font-mono font-bold text-white">{route.distanceKm} km</span>
        </div>
        <div>
          <span className="text-slate-400 block">טיפוס מצטבר</span>
          <span className="font-mono font-bold text-emerald-400">+{route.ascentMeters} m</span>
        </div>
        <div>
          <span className="text-slate-400 block">ירידה מצטברת</span>
          <span className="font-mono font-bold text-amber-400">-{route.descentMeters} m</span>
        </div>
        <div>
          <span className="text-slate-400 block">טווח גבהים (DEM)</span>
          <span className="font-mono text-slate-200">
            {route.minEle}m – {route.maxEle}m
          </span>
        </div>
      </div>

      {/* Interactive SVG Elevation Profile */}
      <div
        className="relative w-full h-28 bg-slate-950/80 rounded-xl border border-slate-800 overflow-hidden cursor-crosshair"
        onMouseLeave={() => onHoverPoint(null)}
      >
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full preserve-3d">
          <defs>
            <linearGradient id="eleGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.55" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.05" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#eleGrad)" />
          <path d={linePath} fill="none" stroke="#10b981" strokeWidth="2.5" />
          {coordsSvg.map((c, idx) => (
            <circle
              key={idx}
              cx={c.x}
              cy={c.y}
              r={6}
              fill="transparent"
              className="hover:fill-emerald-400"
              onMouseEnter={() => onHoverPoint(c.pt)}
            />
          ))}
        </svg>
        <div className="absolute bottom-1 left-2 text-xs font-mono text-slate-400">0 km</div>
        <div className="absolute bottom-1 right-2 text-xs font-mono text-slate-400">
          {route.distanceKm} km
        </div>
      </div>
    </div>
  );
};

