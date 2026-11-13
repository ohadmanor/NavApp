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
} from 'lucide-react';
import type { PoiRecord, SavedRouteRecord } from '../../core/db/NavDatabase';
import {
  ROUTE_COLOR_PALETTE,
  RouteManager,
  resolveRouteDisplayColor,
} from '../../core/navigation/RouteManager';
import type { RouteMapDisplayMode } from '../../core/navigation/RouteDisplayPolicy';
import { PLANNING_MODE_META } from '../../core/routing/RoutingProfiles';
import { MilitaryGridService } from '../../core/navigation/MilitaryGridService';
import { getSurfaceTheme, POI_CATEGORY_META, type MapTheme } from '../ui/themeTokens';
import { PoiCategoryIcon } from '../pois/PoiCategoryIcon';

const KM_PER_DEG_LAT = 111.32;
const DEFAULT_VISIBLE_ROUTES_BATCH = 35;

type OwnershipTab = 'mine' | 'shared';
type RouteFilterKind = 'all' | '4x4' | 'foot' | 'bicycle' | 'imported';
type RouteSortKey = 'updated' | 'name' | 'distance' | 'ascent';

function approxDistKmPointToSegment(
  pLon: number,
  pLat: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
  kmPerDegLon: number
): number {
  const ax = (aLon - pLon) * kmPerDegLon;
  const ay = (aLat - pLat) * KM_PER_DEG_LAT;
  const bx = (bLon - pLon) * kmPerDegLon;
  const by = (bLat - pLat) * KM_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    return Math.hypot(ax, ay);
  }
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

function approxDistKmPointToCoordList(
  lon: number,
  lat: number,
  coords: Array<[number, number]>,
  kmPerDegLon: number
): number {
  if (coords.length === 0) return Infinity;
  if (coords.length === 1) {
    return Math.hypot((coords[0][0] - lon) * kmPerDegLon, (coords[0][1] - lat) * KM_PER_DEG_LAT);
  }
  let minKm = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = approxDistKmPointToSegment(lon, lat, a[0], a[1], b[0], b[1], kmPerDegLon);
    if (d < minKm) {
      minKm = d;
    }
  }
  return minKm;
}

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
  poiCategory?: PoiRecord['category'];
  subcategory?: string;
}

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
  onClose,
  onHoverPoint,
  onSelectPoint,
  onFlyToRoute,
  onFitAllRoutes,
  embedded = false,
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
      if (filterKind === 'imported' && r.sourceFormat === 'planned') return false;

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

    // Build spatially-chunked polyline segments so scanning 3,000+ POIs along a 100+ km track runs in <2ms
    interface PolyChunk {
      coords: Array<[number, number]>;
      minLon: number;
      maxLon: number;
      minLat: number;
      maxLat: number;
    }
    const chunks: PolyChunk[] = [];
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    const pushCoordChunks = (rawCoords: GeoJSON.Position[]) => {
      if (rawCoords.length < 2) return;
      const CHUNK_SIZE = 80;
      for (let start = 0; start < rawCoords.length - 1; start += CHUNK_SIZE - 1) {
        const slice = rawCoords.slice(start, Math.min(rawCoords.length, start + CHUNK_SIZE));
        if (slice.length < 2) break;
        const coords: Array<[number, number]> = [];
        let cMinLon = Infinity;
        let cMinLat = Infinity;
        let cMaxLon = -Infinity;
        let cMaxLat = -Infinity;
        for (const c of slice) {
          const lon = Number(c[0]);
          const lat = Number(c[1]);
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
          coords.push([lon, lat]);
          if (lon < cMinLon) cMinLon = lon;
          if (lon > cMaxLon) cMaxLon = lon;
          if (lat < cMinLat) cMinLat = lat;
          if (lat > cMaxLat) cMaxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
        if (coords.length >= 2) {
          chunks.push({
            coords,
            minLon: cMinLon,
            maxLon: cMaxLon,
            minLat: cMinLat,
            maxLat: cMaxLat,
          });
        }
      }
    };

    for (const f of route.geojson?.features || []) {
      if (f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 2) {
        pushCoordChunks(f.geometry.coordinates);
      } else if (f.geometry?.type === 'MultiLineString') {
        for (const ring of f.geometry.coordinates) {
          if (Array.isArray(ring) && ring.length >= 2) {
            pushCoordChunks(ring);
          }
        }
      }
    }

    if (chunks.length > 0 && pois.length > 0 && Number.isFinite(minLon)) {
      const padDeg = 0.02;
      const gMinLon = minLon - padDeg;
      const gMaxLon = maxLon + padDeg;
      const gMinLat = minLat - padDeg;
      const gMaxLat = maxLat + padDeg;
      const midLat = (minLat + maxLat) / 2;
      const kmPerDegLon = KM_PER_DEG_LAT * Math.max(0.2, Math.cos((midLat * Math.PI) / 180));

      const nearbyWpts: RoutePointOption[] = [];
      for (const poi of pois) {
        if (
          poi.lon < gMinLon ||
          poi.lon > gMaxLon ||
          poi.lat < gMinLat ||
          poi.lat > gMaxLat
        ) {
          continue;
        }

        const maxRadiusKm = poi.subcategory?.startsWith('imported_') ? 1.5 : 0.35;
        let minLineKm = Infinity;
        for (const chunk of chunks) {
          if (
            poi.lon < chunk.minLon - padDeg ||
            poi.lon > chunk.maxLon + padDeg ||
            poi.lat < chunk.minLat - padDeg ||
            poi.lat > chunk.maxLat + padDeg
          ) {
            continue;
          }
          const d = approxDistKmPointToCoordList(poi.lon, poi.lat, chunk.coords, kmPerDegLon);
          if (d < minLineKm) minLineKm = d;
          if (minLineKm <= 0.03) break;
        }

        if (minLineKm <= maxRadiusKm) {
          let bestSample = pts[0];
          let bestSampleDistSq = Infinity;
          for (const sample of pts) {
            const dx = (sample.lon - poi.lon) * kmPerDegLon;
            const dy = (sample.lat - poi.lat) * KM_PER_DEG_LAT;
            const dSq = dx * dx + dy * dy;
            if (dSq < bestSampleDistSq) {
              bestSampleDistSq = dSq;
              bestSample = sample;
            }
          }
          const meta = POI_CATEGORY_META[poi.category] || POI_CATEGORY_META.heritage;
          nearbyWpts.push({
            id: `pt-wpt-${poi.id}`,
            label: poi.nameHe || poi.name,
            emoji: meta.emoji,
            kind: 'wpt',
            poiCategory: poi.category,
            subcategory: poi.subcategory,
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

  const handleExportGpx = async (r: SavedRouteRecord) => {
    const full = RouteManager.isHydratedRoute(r)
      ? r
      : (await RouteManager.loadFullRoute(r)) || r;
    const gpxXml = RouteManager.exportRouteAsGpx(full);
    const blob = new Blob([gpxXml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${full.id}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
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
      setHoveredIdx(nearestIdx);
      onHoverPoint(pts[nearestIdx]);
    };

    const handleChartClick = (clientX: number, rect: DOMRect) => {
      const nearestIdx = getNearestIdxFromPointer(clientX, rect);
      if (nearestIdx === null || !pts[nearestIdx]) return;
      setPinnedIdx(nearestIdx);
      setHoveredIdx(nearestIdx);
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

    const gradId = `eleGrad-${r.id.replace(/[^a-zA-Z0-9_-]/g, '') || 'route'}`;

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
                  setPinnedIdx(null);
                  setHoveredIdx(null);
                  onHoverPoint(null);
                }}
                style={{ color: strokeColor }}
                className="font-bold hover:underline"
              >
                שחרר נעילה
              </button>
            )}
          </span>
          <span dir="ltr">{r.distanceKm} km</span>
        </div>
      </div>
    );
  };

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
