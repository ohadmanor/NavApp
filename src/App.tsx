import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import {
  Search,
  Layers,
  HardDrive,
  Compass,
  LocateFixed,
  Route as RouteIcon,
  AlertTriangle,
  Crosshair,
  Download,
  CheckCircle2,
  Plus,
  Pause,
  Play,
  Map as MapIcon,
  Navigation,
  Sun,
  Moon,
  X,
  PenTool,
  Undo2,
  Check,
} from 'lucide-react';
import { pmtilesRegistry, type MountedArchiveInfo } from './core/pmtiles/PMTilesRegistry';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  DEFAULT_LAYER_VISIBILITY,
  type OutdoorLayerVisibility,
} from './core/style/israelOutdoorStyle';
import { PoiManager } from './core/pois/PoiManager';
import { RouteManager } from './core/navigation/RouteManager';
import { ElevationService } from './core/navigation/ElevationService';
import { MilitaryGridService } from './core/navigation/MilitaryGridService';
import {
  pmtilesSearchService,
  type SearchResultItem,
  type SearchIndexStatus,
} from './core/search/PMTilesSearchService';
import {
  SEARCH_FILTER_TABS,
  type SearchFilterCategory,
} from './core/search/searchTaxonomy';
import {
  db,
  type PoiRecord,
  type SavedRouteRecord,
  type PlannedWaypoint,
} from './core/db/NavDatabase';
import {
  PLANNING_MODE_META,
  PLANNING_ROUTE_COLOR,
  type PlanningMode,
} from './core/routing/RoutingProfiles';
import {
  routePlannerEngine,
  type SnappedPoint,
} from './core/routing/ClientRoutePlannerEngine';
import { AuthService, type NavUser } from './core/firebase/AuthService';
import { PlannedTracksCloudService } from './core/firebase/PlannedTracksCloudService';
import { PoiInspectorSheet } from './components/pois/PoiInspectorSheet';
import { AddPoiPanel } from './components/pois/AddPoiPanel';
import { MapStorageModal } from './components/maps-manager/MapStorageModal';
import { ElevationProfileDrawer } from './components/navigation/ElevationProfileDrawer';
import { TrackRecorderPanel, formatDuration } from './components/navigation/TrackRecorderPanel';
import {
  RoutePlannerPanel,
  type PlannedLeg,
} from './components/navigation/RoutePlannerPanel';
import { LayerSwitcherSheet } from './components/map/LayerSwitcherSheet';
import { getSurfaceTheme, POI_CATEGORY_META, type MapTheme } from './components/ui/themeTokens';

type DesktopDrawerMode = 'poi' | 'routes' | 'record' | 'add-poi' | 'plan-route' | null;
type MobileTab = 'explore' | 'routes' | 'record' | 'offline';
type MobileDisplayMode = 'planning' | 'navigating';
type MobileOverlayMode = 'poi' | 'layers' | 'add-poi' | 'plan-route' | null;
type MobileNavOverlay = 'poi-mini' | 'layers' | 'add-poi' | null;

interface PlanOverlayState {
  active: boolean;
  mode: PlanningMode;
  waypoints: PlannedWaypoint[];
  legs: PlannedLeg[];
  previewPoint: SnappedPoint | null;
  cursorCoord: [number, number] | null;
  disconnectedCandidate: SnappedPoint | null;
}

function ensureWaypointBadgeImage(
  map: maplibregl.Map,
  label: string,
  fillColor: string
): string {
  const safeColor = fillColor.replace('#', '');
  const imageId = `plan-wp-${label}-${safeColor}`;
  if (map.hasImage(imageId) || typeof document === 'undefined') {
    return imageId;
  }
  const size = 34;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 12.5, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${label.length >= 2 ? 12 : 14}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, size / 2, size / 2 + 0.5);

    const imgData = ctx.getImageData(0, 0, size, size);
    map.addImage(imageId, {
      width: size,
      height: size,
      data: new Uint8Array(imgData.data.buffer),
    });
  }
  return imageId;
}

function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth < breakpoint : false
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);

  return isMobile;
}

export const App: React.FC = () => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const mountedStyleKeyRef = useRef<string>('');
  const lastMouseMoveTsRef = useRef<number>(0);

  const isMobile = useIsMobile(768);

  // Core map & archive state
  const [isMapReady, setIsMapReady] = useState(false);
  const [demInfo, setDemInfo] = useState<MountedArchiveInfo | null>(null);
  const [osmInfo, setOsmInfo] = useState<MountedArchiveInfo | null>(null);
  const [visibility, setVisibility] = useState<OutdoorLayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const [theme, setTheme] = useState<MapTheme>('topo-day');
  const [mapBearing, setMapBearing] = useState(0);

  // POIs & Search
  const [pois, setPois] = useState<PoiRecord[]>([]);
  const [selectedPoi, setSelectedPoi] = useState<PoiRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState<SearchFilterCategory>('all');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchStatus, setSearchStatus] = useState<SearchIndexStatus>(() =>
    pmtilesSearchService.getStatus()
  );
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  // Routes & Active Navigation
  const [routes, setRoutes] = useState<SavedRouteRecord[]>([]);
  const [activeRoute, setActiveRoute] = useState<SavedRouteRecord | null>(null);
  const [isNavigatingRoute, setIsNavigatingRoute] = useState(false);
  const [offRouteWarning, setOffRouteWarning] = useState<number | null>(null);
  const [remainingDistKm, setRemainingDistKm] = useState<number | null>(null);

  // UI Shell States (Desktop vs Mobile Planning/Navigating)
  const [desktopDrawer, setDesktopDrawer] = useState<DesktopDrawerMode>(null);
  const [isStorageOpen, setIsStorageOpen] = useState(false);
  const [isLayerSheetOpen, setIsLayerSheetOpen] = useState(false);
  const [mobileDisplayMode, setMobileDisplayMode] = useState<MobileDisplayMode>('planning');
  const [mobileTab, setMobileTab] = useState<MobileTab>('explore');
  const [mobilePlanningOverlay, setMobilePlanningOverlay] = useState<MobileOverlayMode>(null);
  const [mobileNavOverlay, setMobileNavOverlay] = useState<MobileNavOverlay>(null);
  const [mobileSheetExpanded, setMobileSheetExpanded] = useState(true);

  // Connectivity, Crosshair & Coordinates
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [showCenterCrosshair, setShowCenterCrosshair] = useState<boolean>(false);
  const [userLocation, setUserLocation] = useState<{ lon: number; lat: number } | null>(null);
  const [cursorCoords, setCursorCoords] = useState<{
    lon: number;
    lat: number;
    ele: number | null;
    zoom: number;
  }>({ lon: 34.8134, lat: 30.8281, ele: 390, zoom: 12.6 });

  // Track Recording State
  const [isRecordingTrack, setIsRecordingTrack] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [recordElapsedSeconds, setRecordElapsedSeconds] = useState(0);
  const [recordedCoords, setRecordedCoords] = useState<Array<[number, number]>>([]);
  const [recordedDistanceKm, setRecordedDistanceKm] = useState(0);
  const [recordedAscentMeters, setRecordedAscentMeters] = useState(0);
  const lastRecordedEleRef = useRef<number | null>(null);

  // Route Planning & Firebase User Sync State
  const [currentUser, setCurrentUser] = useState<NavUser | null>(() => AuthService.getCurrentUser());
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const [planningMode, setPlanningMode] = useState<PlanningMode>('4x4');
  const [planRouteName, setPlanRouteName] = useState('');
  const [planWaypoints, setPlanWaypoints] = useState<PlannedWaypoint[]>([]);
  const [planLegs, setPlanLegs] = useState<PlannedLeg[]>([]);
  const [planPreviewPoint, setPlanPreviewPoint] = useState<SnappedPoint | null>(null);
  const [planCursorCoord, setPlanCursorCoord] = useState<[number, number] | null>(null);
  const [disconnectedCandidate, setDisconnectedCandidate] = useState<SnappedPoint | null>(null);
  const [isRoutingLeg, setIsRoutingLeg] = useState(false);
  const [isSavingPlan, setIsSavingPlan] = useState(false);
  const [planElevStats, setPlanElevStats] = useState<{ ascent: number; descent: number }>({
    ascent: 0,
    descent: 0,
  });

  // Banners & Toasts
  const [downloadStatus, setDownloadStatus] = useState<{
    fileName: string;
    loaded: number;
    total: number;
    percent: number;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const isAddingPoiMode =
    (!isMobile && desktopDrawer === 'add-poi') ||
    (isMobile &&
      ((mobileDisplayMode === 'planning' && mobilePlanningOverlay === 'add-poi') ||
        (mobileDisplayMode === 'navigating' && mobileNavOverlay === 'add-poi')));

  const isPlanningRouteMode =
    (!isMobile && desktopDrawer === 'plan-route') ||
    (isMobile && mobileDisplayMode === 'planning' && mobilePlanningOverlay === 'plan-route');

  const planOverlayState = useMemo<PlanOverlayState>(
    () => ({
      active: isPlanningRouteMode,
      mode: planningMode,
      waypoints: planWaypoints,
      legs: planLegs,
      previewPoint: planPreviewPoint,
      cursorCoord: planCursorCoord,
      disconnectedCandidate,
    }),
    [
      isPlanningRouteMode,
      planningMode,
      planWaypoints,
      planLegs,
      planPreviewPoint,
      planCursorCoord,
      disconnectedCandidate,
    ]
  );

  const poisRef = useRef<PoiRecord[]>(pois);
  poisRef.current = pois;
  const selectedPoiRef = useRef<PoiRecord | null>(selectedPoi);
  selectedPoiRef.current = selectedPoi;
  const visibilityRef = useRef<OutdoorLayerVisibility>(visibility);
  visibilityRef.current = visibility;
  const themeRef = useRef<MapTheme>(theme);
  themeRef.current = theme;
  const activeRouteRef = useRef<SavedRouteRecord | null>(activeRoute);
  activeRouteRef.current = activeRoute;
  const routesRef = useRef<SavedRouteRecord[]>(routes);
  routesRef.current = routes;
  const recordedCoordsRef = useRef<Array<[number, number]>>(recordedCoords);
  recordedCoordsRef.current = recordedCoords;
  const planOverlayStateRef = useRef<PlanOverlayState>(planOverlayState);
  planOverlayStateRef.current = planOverlayState;
  const isPlanningRouteRef = useRef<boolean>(isPlanningRouteMode);
  isPlanningRouteRef.current = isPlanningRouteMode;
  const planningModeRef = useRef<PlanningMode>(planningMode);
  planningModeRef.current = planningMode;
  const planWaypointsRef = useRef<PlannedWaypoint[]>(planWaypoints);
  planWaypointsRef.current = planWaypoints;
  const planLegsRef = useRef<PlannedLeg[]>(planLegs);
  planLegsRef.current = planLegs;
  const disconnectedCandidateRef = useRef<SnappedPoint | null>(disconnectedCandidate);
  disconnectedCandidateRef.current = disconnectedCandidate;
  const isRoutingLegRef = useRef<boolean>(isRoutingLeg);
  isRoutingLegRef.current = isRoutingLeg;
  const clickTimerRef = useRef<number | null>(null);
  const lastPlanSnapTsRef = useRef<number>(0);
  const snapSeqRef = useRef<number>(0);
  const activeRoutePromiseRef = useRef<Promise<void> | null>(null);
  const deletedRouteIdsRef = useRef<Set<string>>(new Set());
  const handlePlanMapClickRef = useRef<(lon: number, lat: number) => Promise<void>>(async () => {});
  const handleFinishPlanningRef = useRef<() => Promise<void>>(async () => {});
  const isStyleLoadedRef = useRef<boolean>(false);
  const mobileDisplayModeRef = useRef<MobileDisplayMode>(mobileDisplayMode);
  mobileDisplayModeRef.current = mobileDisplayMode;
  const isMobileRef = useRef<boolean>(isMobile);
  isMobileRef.current = isMobile;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 3500);
  }, []);

  const t = getSurfaceTheme(theme);

  // Subscribe to Firebase Google/Gmail auth state
  useEffect(() => {
    return AuthService.subscribeAuth((user) => {
      setCurrentUser(user);
    });
  }, []);

  // Sync pending planned routes and fetch remote planing_tracks when signed in & online
  useEffect(() => {
    if (!currentUser || !isOnline) return;
    let cancelled = false;
    (async () => {
      try {
        const syncedCount = await PlannedTracksCloudService.syncPendingRoutesForUser(currentUser);
        const downloaded = await PlannedTracksCloudService.fetchUserPlannedRoutes(currentUser);
        if (cancelled) return;
        if (syncedCount > 0 || downloaded.length > 0) {
          if (deletedRouteIdsRef.current.size > 0) {
            await db.routes.bulkDelete(Array.from(deletedRouteIdsRef.current));
          }
          const all = (await db.routes.toArray()).filter(
            (r) => !deletedRouteIdsRef.current.has(r.id)
          );
          if (!cancelled) {
            setRoutes(all);
            if (syncedCount > 0) {
              showToast(`סונכרנו ${syncedCount} מסלולים מתוכננים ל-Firebase`);
            }
          }
        }
      } catch (err) {
        console.warn('[NavApp] Planned tracks cloud sync warning:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser, isOnline, showToast]);

  // Toggle MapLibre doubleClickZoom & crosshair cursor while Route Planning mode is active
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isPlanningRouteMode) {
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = '';
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
    }
  }, [isPlanningRouteMode, isMapReady]);

  // Listen to background downloads from Firebase into persistent OPFS
  useEffect(() => {
    const unsubProgress = pmtilesRegistry.onDownloadProgress((fileName, loaded, total) => {
      const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
      setDownloadStatus({ fileName, loaded, total, percent });
    });

    const unsubUpdated = pmtilesRegistry.onArchiveUpdated((id, info) => {
      if (id === 'israel-osm') setOsmInfo(info);
      if (id === 'israel-dem') setDemInfo(info);
      setDownloadStatus(null);
      showToast(`קובץ המפה ${info.record.fileName} נשמר במכשיר! פועל 100% אופליין.`);
    });

    return () => {
      unsubProgress();
      unsubUpdated();
    };
  }, [showToast]);

  // Monitor Online / Offline connectivity
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Recording elapsed timer
  useEffect(() => {
    if (!isRecordingTrack || isRecordingPaused) return;
    const timer = window.setInterval(() => {
      setRecordElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRecordingTrack, isRecordingPaused]);

  // Live GPS Watch when recording or navigating an active route
  useEffect(() => {
    if ((!isRecordingTrack || isRecordingPaused) && !isNavigatingRoute) return;
    if (!navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        const lon = pos.coords.longitude;
        const lat = pos.coords.latitude;
        setUserLocation({ lon, lat });

        if (mapRef.current) {
          if (!userMarkerRef.current) {
            userMarkerRef.current = new maplibregl.Marker({ color: '#0ea5e9' })
              .setLngLat([lon, lat])
              .addTo(mapRef.current);
          } else {
            userMarkerRef.current.setLngLat([lon, lat]);
          }
        }

        if (isNavigatingRoute && activeRoute) {
          const check = RouteManager.checkNavigationDeviation(activeRoute, lon, lat);
          setOffRouteWarning(check.isOffRoute ? check.distanceFromTrailMeters : null);
          const feature = activeRoute.geojson.features[0] as GeoJSON.Feature<GeoJSON.LineString>;
          if (feature?.geometry?.coordinates?.length >= 2) {
            const endCoord =
              feature.geometry.coordinates[feature.geometry.coordinates.length - 1];
            const rem = turf.distance(turf.point(check.snappedCoord), turf.point(endCoord), {
              units: 'kilometers',
            });
            setRemainingDistKm(Number(rem.toFixed(1)));
          }
        }

        if (isRecordingTrack && !isRecordingPaused) {
          const nextPt: [number, number] = [Number(lon.toFixed(5)), Number(lat.toFixed(5))];
          setRecordedCoords((prev) => {
            if (prev.length > 0) {
              const last = prev[prev.length - 1];
              const stepMeters = turf.distance(turf.point(last), turf.point(nextPt), {
                units: 'meters',
              });
              if (stepMeters < 8) return prev;
              setRecordedDistanceKm((d) => Number((d + stepMeters / 1000).toFixed(2)));
            }
            return [...prev, nextPt];
          });

          const ele = await ElevationService.getElevationAt(lon, lat, 11, true);
          if (ele !== null) {
            if (lastRecordedEleRef.current !== null && ele > lastRecordedEleRef.current) {
              setRecordedAscentMeters((a) => a + (ele - (lastRecordedEleRef.current ?? ele)));
            }
            lastRecordedEleRef.current = ele;
          }
        }
      },
      () => {
        // Ignore transient GPS timeout
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [isRecordingTrack, isRecordingPaused, isNavigatingRoute, activeRoute]);

  // Update Military Tactical UTM/ITM Grid GeoJSON on the map
  const updateTacticalGridOnMap = useCallback(
    (map: maplibregl.Map, showGrid: boolean, currentTheme: MapTheme) => {
      try {
        if (!map.getStyle()) return;

        const bounds = map.getBounds();
        const zoom = map.getZoom();
        const gridGeoJson: GeoJSON.FeatureCollection = showGrid
          ? MilitaryGridService.buildTacticalGridGeoJSON(
              bounds.getWest(),
              bounds.getSouth(),
              bounds.getEast(),
              bounds.getNorth(),
              zoom
            )
          : { type: 'FeatureCollection', features: [] };

        const existingGridSrc = map.getSource('tactical-grid-src') as maplibregl.GeoJSONSource;
        if (existingGridSrc) {
          existingGridSrc.setData(gridGeoJson);
        } else {
          map.addSource('tactical-grid-src', {
            type: 'geojson',
            data: gridGeoJson,
          });
          map.addLayer({
            id: 'tactical-grid-minor',
            type: 'line',
            source: 'tactical-grid-src',
            filter: ['==', ['get', 'kind'], 'minor-grid'],
            paint: {
              'line-color': currentTheme === 'topo-dark' ? '#64748b' : 'rgb(127, 127, 127)',
              'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 11, 1],
              'line-opacity': currentTheme === 'topo-dark' ? 0.35 : 0.45,
            },
          });
          map.addLayer({
            id: 'tactical-grid-major',
            type: 'line',
            source: 'tactical-grid-src',
            filter: ['==', ['get', 'kind'], 'major-grid'],
            paint: {
              'line-color': currentTheme === 'topo-dark' ? '#94a3b8' : 'rgb(127, 127, 127)',
              'line-width': 1.8,
              'line-opacity': currentTheme === 'topo-dark' ? 0.55 : 0.65,
            },
          });
          map.addLayer({
            id: 'tactical-grid-labels',
            type: 'symbol',
            source: 'tactical-grid-src',
            filter: ['==', ['get', 'kind'], 'major-grid'],
            layout: {
              'symbol-placement': 'line',
              'symbol-spacing': 380,
              'text-field': ['get', 'label'],
              'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
              'text-size': 11,
            },
            paint: {
              'text-color': currentTheme === 'topo-dark' ? '#94a3b8' : '#7F7F7F',
              'text-halo-color': currentTheme === 'topo-dark' ? '#0b1015' : 'white',
              'text-halo-width': 3,
              'text-halo-blur': 1.5,
            },
          });
        }
      } catch (err) {
        console.warn('[NavApp] updateTacticalGridOnMap error:', err);
      }
    },
    []
  );

  // Mount GeoJSON overlays (Tactical Grid + POIs + Search Highlight + Saved/Active Routes + Live Recorded Track + Route Planner)
  const syncOverlaySourcesToMap = useCallback(
    (
      map: maplibregl.Map,
      currentPois: PoiRecord[],
      currentVis: OutdoorLayerVisibility,
      currentRoute: SavedRouteRecord | null,
      allRoutes: SavedRouteRecord[],
      liveTrack: Array<[number, number]>,
      currentTheme: MapTheme,
      currentPlan: PlanOverlayState,
      highlightedPoi: PoiRecord | null
    ) => {
      try {
        if (!map.getStyle()) return;

        updateTacticalGridOnMap(map, currentVis.tacticalGrid, currentTheme);

        const routeHighlightColor: any = [
          'case',
          ['any', ['==', ['get', 'color'], '#10b981'], ['!', ['has', 'color']]],
          '#ec4899',
          ['get', 'color'],
        ];
        const railBorderColor: any = [
          'case',
          ['==', ['get', 'color'], PLANNING_ROUTE_COLOR],
          currentTheme === 'topo-dark' ? '#93c5fd' : '#1e3a8a',
          currentTheme === 'topo-dark' ? '#f9a8d4' : '#831843',
        ];

        const normalizeFeaturesForRoute = (r: SavedRouteRecord): GeoJSON.Feature[] => {
          const feats = r.geojson?.features || [];
          if (r.sourceFormat !== 'planned') return feats;
          return feats.map((f) => ({
            ...f,
            properties: {
              ...(f.properties || {}),
              color: PLANNING_ROUTE_COLOR,
            },
          }));
        };

        // Other visible saved routes (renders full multi-route / multi-segment GPX paths clearly)
        const secondaryFeatures = allRoutes
          .filter((r) => r.visible !== false && r.id !== currentRoute?.id)
          .flatMap((r) => normalizeFeaturesForRoute(r));
        const savedRoutesGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: secondaryFeatures,
        };
        const existingSavedSrc = map.getSource('saved-routes-src') as maplibregl.GeoJSONSource;
        if (existingSavedSrc) {
          existingSavedSrc.setData(savedRoutesGeoJson);
        } else {
          map.addSource('saved-routes-src', { type: 'geojson', data: savedRoutesGeoJson });
          map.addLayer({
            id: 'saved-routes-line',
            type: 'line',
            source: 'saved-routes-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': routeHighlightColor,
              'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 8.5, 16, 12],
              'line-opacity': 0.34,
            },
          });
          map.addLayer({
            id: 'saved-routes-border',
            type: 'line',
            source: 'saved-routes-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': railBorderColor,
              'line-width': 1.3,
              'line-gap-width': ['interpolate', ['linear'], ['zoom'], 9, 4.5, 13, 8, 16, 11.5],
              'line-opacity': 0.55,
            },
          });
        }

        // Active Route (semi-transparent highlighter ribbon + crisp outer rail casing so original trail colors stay visible through the center)
        const routeGeoJson: GeoJSON.FeatureCollection = currentRoute
          ? {
              type: 'FeatureCollection',
              features: normalizeFeaturesForRoute(currentRoute),
            }
          : { type: 'FeatureCollection', features: [] };

        const existingRouteSrc = map.getSource('active-route-src') as maplibregl.GeoJSONSource;
        if (existingRouteSrc) {
          existingRouteSrc.setData(routeGeoJson);
        } else {
          map.addSource('active-route-src', { type: 'geojson', data: routeGeoJson });
          map.addLayer({
            id: 'active-route-line',
            type: 'line',
            source: 'active-route-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': routeHighlightColor,
              'line-width': ['interpolate', ['linear'], ['zoom'], 9, 7, 13, 11, 16, 15],
              'line-opacity': 0.44,
            },
          });
          map.addLayer({
            id: 'active-route-casing',
            type: 'line',
            source: 'active-route-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': railBorderColor,
              'line-width': 1.8,
              'line-gap-width': ['interpolate', ['linear'], ['zoom'], 9, 6.5, 13, 10.5, 16, 14.5],
              'line-opacity': 0.85,
            },
          });
        }

        // Active Route Start / Finish Endpoint Markers (supports single & multi-segment tracks)
        const endpointFeatures: GeoJSON.Feature[] = [];
        const activeLineFeatures = (currentRoute?.geojson?.features?.filter(
          (f) => f.geometry?.type === 'LineString'
        ) || []) as Array<GeoJSON.Feature<GeoJSON.LineString>>;
        const firstCoords = activeLineFeatures[0]?.geometry?.coordinates || [];
        const lastCoords =
          activeLineFeatures[activeLineFeatures.length - 1]?.geometry?.coordinates || [];
        if (firstCoords.length >= 1 && lastCoords.length >= 1) {
          endpointFeatures.push(
            {
              type: 'Feature',
              properties: { kind: 'start' },
              geometry: { type: 'Point', coordinates: firstCoords[0] },
            },
            {
              type: 'Feature',
              properties: { kind: 'end' },
              geometry: { type: 'Point', coordinates: lastCoords[lastCoords.length - 1] },
            }
          );
        }
        const endpointsGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: endpointFeatures,
        };
        const existingEndpointsSrc = map.getSource(
          'active-route-endpoints-src'
        ) as maplibregl.GeoJSONSource;
        if (existingEndpointsSrc) {
          existingEndpointsSrc.setData(endpointsGeoJson);
        } else {
          map.addSource('active-route-endpoints-src', { type: 'geojson', data: endpointsGeoJson });
          map.addLayer({
            id: 'active-route-endpoints',
            type: 'circle',
            source: 'active-route-endpoints-src',
            paint: {
              'circle-radius': 6,
              'circle-color': [
                'match',
                ['get', 'kind'],
                'start',
                '#10b981',
                '#ef4444',
              ],
              'circle-stroke-width': 2.2,
              'circle-stroke-color': '#ffffff',
            },
          });
        }

        // Live Recorded Track
        const trackGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features:
            liveTrack.length >= 2
              ? [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: liveTrack },
                  },
                ]
              : [],
        };
        const existingTrackSrc = map.getSource('live-track-src') as maplibregl.GeoJSONSource;
        if (existingTrackSrc) {
          existingTrackSrc.setData(trackGeoJson);
        } else {
          map.addSource('live-track-src', { type: 'geojson', data: trackGeoJson });
          map.addLayer({
            id: 'live-track-line',
            type: 'line',
            source: 'live-track-src',
            paint: {
              'line-color': '#38bdf8',
              'line-width': 4,
              'line-dasharray': [2, 1],
            },
          });
        }

        if (!map.hasImage('offroad-pass')) {
          const size = 24;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, 8.5, 0, Math.PI * 2);
            ctx.fillStyle = '#dc2626';
            ctx.fill();
            ctx.lineWidth = 2.2;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(size / 2 - 4, size / 2 + 2);
            ctx.lineTo(size / 2, size / 2 - 3);
            ctx.lineTo(size / 2 + 4, size / 2 + 2);
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            const imgData = ctx.getImageData(0, 0, size, size);
            map.addImage('offroad-pass', {
              width: size,
              height: size,
              data: new Uint8Array(imgData.data.buffer),
            });
          }
        }

        const poiGeoJson = PoiManager.toGeoJSON(currentPois, currentVis);
        const existingPoiSrc = map.getSource('israel-pois-src') as maplibregl.GeoJSONSource;
        if (existingPoiSrc) {
          existingPoiSrc.setData(poiGeoJson);
        } else {
          map.addSource('israel-pois-src', { type: 'geojson', data: poiGeoJson });
          map.addLayer({
            id: 'israel-pois-labels',
            type: 'symbol',
            source: 'israel-pois-src',
            minzoom: 9,
            layout: {
              visibility: currentVis.pois ? 'visible' : 'none',
              'icon-image': [
                'match',
                ['get', 'category'],
                'water',
                [
                  'match',
                  ['coalesce', ['get', 'subcategory'], ''],
                  'cistern',
                  'cistern',
                  'spring',
                ],
                'campsite',
                'camping',
                'peak',
                'dot',
                'heritage',
                [
                  'match',
                  ['coalesce', ['get', 'subcategory'], ''],
                  'cave',
                  'cave',
                  'ruins',
                  'ruins',
                  'archaeological_site',
                  'jar',
                  'viewpoint',
                ],
                'offroad',
                'offroad-pass',
                'user',
                'star',
                'viewpoint',
              ],
              'icon-size': [
                'match',
                ['get', 'category'],
                'water',
                0.75,
                'peak',
                0.45,
                'offroad',
                0.85,
                0.55,
              ],
              'icon-anchor': 'center',
              'icon-allow-overlap': false,
              'icon-ignore-placement': false,
              'icon-padding': 6,
              'text-field': ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
              'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
              'text-size': 14,
              'text-offset': [0, 0.75],
              'text-anchor': 'top',
              'text-max-width': 9,
              'text-allow-overlap': false,
              'text-ignore-placement': false,
              'text-optional': true,
              'text-padding': 3,
            },
            paint: {
              'text-color': [
                'match',
                ['get', 'category'],
                'water',
                currentTheme === 'topo-dark' ? '#38bdf8' : '#125595',
                'offroad',
                currentTheme === 'topo-dark' ? '#f87171' : '#991b1b',
                'campsite',
                currentTheme === 'topo-dark' ? '#34d399' : '#166534',
                'peak',
                currentTheme === 'topo-dark' ? '#e2e8f0' : '#404040',
                'user',
                currentTheme === 'topo-dark' ? '#2dd4bf' : '#0f766e',
                currentTheme === 'topo-dark' ? '#fbbf24' : '#404040',
              ],
              'text-halo-color': currentTheme === 'topo-dark' ? '#0b1015' : 'white',
              'text-halo-width': 3,
              'text-halo-blur': 1.5,
            },
          });
        }

        // Route Planning Overlays (draft network legs, straight fallback legs, snapped cursor preview, numbered waypoints)
        const modeColor = PLANNING_MODE_META[currentPlan.mode].color;
        const planCasingColor = currentTheme === 'topo-dark' ? '#0f172a' : '#ffffff';

        const networkFeatures: GeoJSON.Feature[] = currentPlan.active
          ? currentPlan.legs
              .filter((leg) => leg.legType === 'network' && leg.coordinates.length >= 2)
              .map((leg, idx) => ({
                type: 'Feature',
                properties: { id: `plan-net-${idx}`, color: modeColor },
                geometry: { type: 'LineString', coordinates: leg.coordinates },
              }))
          : [];
        const planNetGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: networkFeatures,
        };
        const existingPlanNetSrc = map.getSource(
          'plan-route-network-src'
        ) as maplibregl.GeoJSONSource;
        if (existingPlanNetSrc) {
          existingPlanNetSrc.setData(planNetGeoJson);
          if (map.getLayer('plan-route-network-casing')) {
            map.setPaintProperty('plan-route-network-casing', 'line-color', planCasingColor);
          }
        } else {
          map.addSource('plan-route-network-src', { type: 'geojson', data: planNetGeoJson });
          map.addLayer({
            id: 'plan-route-network-casing',
            type: 'line',
            source: 'plan-route-network-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': planCasingColor,
              'line-width': 7.5,
              'line-opacity': 0.9,
            },
          });
          map.addLayer({
            id: 'plan-route-network-line',
            type: 'line',
            source: 'plan-route-network-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': ['coalesce', ['get', 'color'], modeColor],
              'line-width': 4.2,
              'line-opacity': 0.95,
            },
          });
        }

        const straightFeatures: GeoJSON.Feature[] = currentPlan.active
          ? currentPlan.legs
              .filter((leg) => leg.legType === 'straight' && leg.coordinates.length >= 2)
              .map((leg, idx) => ({
                type: 'Feature',
                properties: { id: `plan-str-${idx}` },
                geometry: { type: 'LineString', coordinates: leg.coordinates },
              }))
          : [];
        const planStraightGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: straightFeatures,
        };
        const existingPlanStrSrc = map.getSource(
          'plan-route-straight-src'
        ) as maplibregl.GeoJSONSource;
        if (existingPlanStrSrc) {
          existingPlanStrSrc.setData(planStraightGeoJson);
        } else {
          map.addSource('plan-route-straight-src', {
            type: 'geojson',
            data: planStraightGeoJson,
          });
          map.addLayer({
            id: 'plan-route-straight-line',
            type: 'line',
            source: 'plan-route-straight-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': PLANNING_ROUTE_COLOR,
              'line-width': 3.5,
              'line-dasharray': [2, 1.5],
              'line-opacity': 0.95,
            },
          });
        }

        // Snap hover preview / disconnected candidate preview
        const previewFeatures: GeoJSON.Feature[] = [];
        if (currentPlan.active && currentPlan.disconnectedCandidate && currentPlan.waypoints.length > 0) {
          const lastWp = currentPlan.waypoints[currentPlan.waypoints.length - 1];
          previewFeatures.push({
            type: 'Feature',
            properties: { kind: 'tether', color: '#f59e0b' },
            geometry: {
              type: 'LineString',
              coordinates: [
                [lastWp.lon, lastWp.lat],
                [currentPlan.disconnectedCandidate.lon, currentPlan.disconnectedCandidate.lat],
              ],
            },
          });
          previewFeatures.push({
            type: 'Feature',
            properties: { kind: 'dot', color: '#f59e0b' },
            geometry: {
              type: 'Point',
              coordinates: [
                currentPlan.disconnectedCandidate.lon,
                currentPlan.disconnectedCandidate.lat,
              ],
            },
          });
        } else if (currentPlan.active && currentPlan.previewPoint) {
          const snap = currentPlan.previewPoint;
          if (currentPlan.cursorCoord && snap.distFromClickMeters > 2) {
            previewFeatures.push({
              type: 'Feature',
              properties: { kind: 'tether', color: modeColor },
              geometry: {
                type: 'LineString',
                coordinates: [currentPlan.cursorCoord, [snap.lon, snap.lat]],
              },
            });
          }
          previewFeatures.push({
            type: 'Feature',
            properties: { kind: 'dot', color: modeColor },
            geometry: { type: 'Point', coordinates: [snap.lon, snap.lat] },
          });
        }
        const previewGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: previewFeatures,
        };
        const existingPreviewSrc = map.getSource(
          'plan-snap-preview-src'
        ) as maplibregl.GeoJSONSource;
        if (existingPreviewSrc) {
          existingPreviewSrc.setData(previewGeoJson);
        } else {
          map.addSource('plan-snap-preview-src', { type: 'geojson', data: previewGeoJson });
          map.addLayer({
            id: 'plan-snap-preview-tether',
            type: 'line',
            source: 'plan-snap-preview-src',
            filter: ['==', ['get', 'kind'], 'tether'],
            paint: {
              'line-color': ['coalesce', ['get', 'color'], '#f59e0b'],
              'line-width': 2.2,
              'line-dasharray': [2, 2],
              'line-opacity': 0.85,
            },
          });
          map.addLayer({
            id: 'plan-snap-preview-dot',
            type: 'circle',
            source: 'plan-snap-preview-src',
            filter: ['==', ['get', 'kind'], 'dot'],
            paint: {
              'circle-radius': 6.5,
              'circle-color': ['coalesce', ['get', 'color'], modeColor],
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#ffffff',
            },
          });
        }

        // Numbered snapped waypoints
        const wpFeatures: GeoJSON.Feature[] = currentPlan.active
          ? currentPlan.waypoints.map((wp, idx) => {
              const isStart = idx === 0;
              const isEnd = idx === currentPlan.waypoints.length - 1 && idx > 0;
              const wpColor = isStart ? '#10b981' : isEnd ? '#ef4444' : modeColor;
              const badgeId = ensureWaypointBadgeImage(map, String(idx + 1), wpColor);
              return {
                type: 'Feature',
                properties: {
                  index: idx + 1,
                  color: wpColor,
                  badgeId,
                },
                geometry: { type: 'Point', coordinates: [wp.lon, wp.lat] },
              };
            })
          : [];
        const planWpGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: wpFeatures,
        };
        const existingWpSrc = map.getSource(
          'plan-route-waypoints-src'
        ) as maplibregl.GeoJSONSource;
        if (existingWpSrc) {
          existingWpSrc.setData(planWpGeoJson);
        } else {
          map.addSource('plan-route-waypoints-src', { type: 'geojson', data: planWpGeoJson });
          map.addLayer({
            id: 'plan-route-waypoints-circle',
            type: 'circle',
            source: 'plan-route-waypoints-src',
            paint: {
              'circle-radius': 9,
              'circle-color': ['coalesce', ['get', 'color'], modeColor],
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#ffffff',
            },
          });
          map.addLayer({
            id: 'plan-route-waypoints-symbol',
            type: 'symbol',
            source: 'plan-route-waypoints-src',
            layout: {
              'icon-image': ['get', 'badgeId'],
              'icon-size': 0.78,
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
          });
        }

        // Selected POI / PMTiles Search Result Pin Highlight
        const highlightFeatures: GeoJSON.Feature[] =
          highlightedPoi &&
          Number.isFinite(highlightedPoi.lon) &&
          Number.isFinite(highlightedPoi.lat)
            ? [
                {
                  type: 'Feature',
                  properties: {
                    title: highlightedPoi.nameHe || highlightedPoi.name || '',
                  },
                  geometry: {
                    type: 'Point',
                    coordinates: [highlightedPoi.lon, highlightedPoi.lat],
                  },
                },
              ]
            : [];
        const highlightGeoJson: GeoJSON.FeatureCollection = {
          type: 'FeatureCollection',
          features: highlightFeatures,
        };
        const existingHighlightSrc = map.getSource(
          'search-highlight-src'
        ) as maplibregl.GeoJSONSource;
        if (existingHighlightSrc) {
          existingHighlightSrc.setData(highlightGeoJson);
        } else {
          map.addSource('search-highlight-src', { type: 'geojson', data: highlightGeoJson });
          map.addLayer({
            id: 'search-highlight-halo',
            type: 'circle',
            source: 'search-highlight-src',
            paint: {
              'circle-radius': 18,
              'circle-color': '#10b981',
              'circle-opacity': 0.22,
              'circle-stroke-width': 2,
              'circle-stroke-color': '#10b981',
              'circle-stroke-opacity': 0.8,
            },
          });
          map.addLayer({
            id: 'search-highlight-pin',
            type: 'circle',
            source: 'search-highlight-src',
            paint: {
              'circle-radius': 7.5,
              'circle-color': '#f59e0b',
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#ffffff',
            },
          });
          map.addLayer({
            id: 'search-highlight-label',
            type: 'symbol',
            source: 'search-highlight-src',
            layout: {
              'text-field': ['get', 'title'],
              'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
              'text-size': 13.5,
              'text-offset': [0, 1.35],
              'text-anchor': 'top',
              'text-max-width': 12,
              'text-allow-overlap': true,
            },
            paint: {
              'text-color': currentTheme === 'topo-dark' ? '#fde68a' : '#065f46',
              'text-halo-color': currentTheme === 'topo-dark' ? '#0b1015' : '#ffffff',
              'text-halo-width': 3,
              'text-halo-blur': 1,
            },
          });
        }

        map.triggerRepaint();
      } catch (err) {
        console.warn('[NavApp] syncOverlaySourcesToMap error:', err);
      }
    },
    [updateTacticalGridOnMap]
  );

  // Initialize MapLibre immediately
  useEffect(() => {
    let isCancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    if (!mapContainerRef.current) return;
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }

    pmtilesRegistry.initProtocols();

    const existingOsm = pmtilesRegistry.getMountedInfo('israel-osm');
    const existingDem = pmtilesRegistry.getMountedInfo('israel-dem');
    const initialOsmUrl = existingOsm?.protocolUrl || pmtilesRegistry.getDefaultOsmProtocolUrl();
    const initialDemUrl = existingDem?.protocolUrl || pmtilesRegistry.getDefaultDemProtocolUrl();
    const initialContourUrl =
      existingDem?.contourProtocolUrl || pmtilesRegistry.getDefaultContourProtocolUrl();

    mountedStyleKeyRef.current = `${initialOsmUrl}|${initialDemUrl}|${themeRef.current}`;
    isStyleLoadedRef.current = false;

    const initialStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: initialOsmUrl,
      demProtocolUrl: initialDemUrl,
      contourProtocolUrl: initialContourUrl,
      visibility: visibilityRef.current,
      theme: themeRef.current,
    });

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: initialStyle,
      center: [34.8134, 30.835],
      zoom: 12.6,
      maxPitch: 75,
      fadeDuration: 0,
      refreshExpiredTiles: false,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on('error', (ev) => {
      console.warn('[MapLibre error]', ev?.error?.message || ev);
    });

    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');

    if (typeof ResizeObserver !== 'undefined' && mapContainerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        if (isCancelled) return;
        map.resize();
        map.triggerRepaint();
      });
      resizeObserver.observe(mapContainerRef.current);
    }

    map.on('load', () => {
      if (isCancelled) return;
      isStyleLoadedRef.current = true;
      setIsMapReady(true);
      map.resize();
      applyLayerVisibilityToMap(map, visibilityRef.current);
      syncOverlaySourcesToMap(
        map,
        poisRef.current,
        visibilityRef.current,
        activeRouteRef.current,
        routesRef.current,
        recordedCoordsRef.current,
        themeRef.current,
        planOverlayStateRef.current,
        selectedPoiRef.current
      );
    });

    map.on('rotate', () => {
      if (isCancelled) return;
      setMapBearing(map.getBearing());
    });

    map.on('moveend', async () => {
      if (isCancelled) return;
      const c = map.getCenter();
      const lon = Number(c.lng.toFixed(4));
      const lat = Number(c.lat.toFixed(4));
      const zoom = Number(map.getZoom().toFixed(1));
      const ele = await ElevationService.getElevationAt(lon, lat, 11, false);
      if (isCancelled) return;
      setCursorCoords({ lon, lat, ele, zoom });
    });

    map.on('mousemove', async (e) => {
      if (isCancelled || map.isMoving() || map.isZooming() || map.isRotating()) return;
      const now = performance.now();

      // Snap-to-nearest-highway live preview while Route Planning mode is active (throttled ~75ms)
      if (isPlanningRouteRef.current && now - lastPlanSnapTsRef.current >= 75) {
        lastPlanSnapTsRef.current = now;
        const cLon = Number(e.lngLat.lng.toFixed(6));
        const cLat = Number(e.lngLat.lat.toFixed(6));
        setPlanCursorCoord([cLon, cLat]);
        const seq = ++snapSeqRef.current;
        const activeMode = planningModeRef.current;
        void routePlannerEngine
          .snapToNearestHighway(cLon, cLat, activeMode)
          .then((snap) => {
            if (isCancelled || snapSeqRef.current !== seq || !isPlanningRouteRef.current) return;
            setPlanPreviewPoint(snap);
          });
      }

      if (now - lastMouseMoveTsRef.current < 150) return;
      lastMouseMoveTsRef.current = now;

      const lon = Number(e.lngLat.lng.toFixed(4));
      const lat = Number(e.lngLat.lat.toFixed(4));
      const zoom = Number(map.getZoom().toFixed(1));
      const ele = await ElevationService.getElevationAt(lon, lat, 11, true);
      if (isCancelled) return;
      setCursorCoords((prev) => ({
        lon,
        lat,
        ele: ele !== null ? ele : prev.ele,
        zoom,
      }));
    });

    const handlePoiFeatureClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (isCancelled || isPlanningRouteRef.current) return;
      const feature = e.features?.[0];
      if (!feature || !feature.properties) return;
      const p = feature.properties as any;
      const clickedPoi: PoiRecord = {
        id: p.id,
        name: p.nameHe || p.name,
        nameHe: p.nameHe || p.name,
        nameEn: p.nameEn || p.name,
        category: p.category,
        subcategory: p.subcategory,
        lon: Number(p.lon),
        lat: Number(p.lat),
        ele: p.ele ? Number(p.ele) : null,
        waterStatus: p.waterStatus || null,
        difficulty4x4: p.difficulty4x4 || null,
        descHe: p.descHe || '',
        descEn: p.descEn || '',
        source: p.source || 'IsraelHiking / OSM',
        wikipedia: p.wikipedia || null,
        userNotes: p.userNotes || '',
      };
      setSelectedPoi(clickedPoi);
      if (isMobileRef.current) {
        if (mobileDisplayModeRef.current === 'navigating') {
          setMobileNavOverlay('poi-mini');
        } else {
          setMobileTab('explore');
          setMobilePlanningOverlay('poi');
          setMobileSheetExpanded(true);
        }
      } else {
        setDesktopDrawer('poi');
      }
    };

    const handleMapPlanClick = (e: maplibregl.MapMouseEvent) => {
      if (isCancelled || !isPlanningRouteRef.current) return;
      const origDetail = (e.originalEvent as MouseEvent | undefined)?.detail ?? 1;
      if (origDetail > 1) {
        if (clickTimerRef.current) {
          window.clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
        }
        return;
      }
      if (isRoutingLegRef.current) return;

      const clickLon = Number(e.lngLat.lng.toFixed(6));
      const clickLat = Number(e.lngLat.lat.toFixed(6));
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
      }
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        if (!isCancelled && isPlanningRouteRef.current) {
          void handlePlanMapClickRef.current(clickLon, clickLat);
        }
      }, 220);
    };

    const handleMapPlanDblClick = (e: maplibregl.MapMouseEvent) => {
      if (isCancelled || !isPlanningRouteRef.current) return;
      e.preventDefault();
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      void handleFinishPlanningRef.current();
    };

    map.on('click', 'israel-pois-labels', handlePoiFeatureClick);
    map.on('click', handleMapPlanClick);
    map.on('dblclick', handleMapPlanDblClick);
    map.on('mouseenter', 'israel-pois-labels', () => {
      if (!isPlanningRouteRef.current) {
        map.getCanvas().style.cursor = 'pointer';
      }
    });
    map.on('mouseleave', 'israel-pois-labels', () => {
      map.getCanvas().style.cursor = isPlanningRouteRef.current ? 'crosshair' : '';
    });

    (async () => {
      try {
        const [{ dem, osm }, loadedPois, loadedRoutes] = await Promise.all([
          pmtilesRegistry.initializeDefaultIsraelArchives(),
          PoiManager.initializePois(),
          RouteManager.initializeStarterRoutes(),
        ]);

        if (isCancelled) return;

        if (dem) setDemInfo(dem);
        if (osm) {
          setOsmInfo(osm);
          if (osm.hasTrailColorSchema === false) {
            showToast(
              'קובץ Israel.osm.pmtiles שנטען חסר צבעי שבילים — עדכן בענן (upload-map-data.bat) או מחק עותק אופליין ישן.'
            );
          }
        }
        if (!osm && !dem) {
          showToast('לא נמצאו קובצי מפה מקומיים — פתח "מפות אופליין" לטעינת PMTiles.');
        }
        if (loadedPois.length > 0) setPois(loadedPois);
        if (loadedRoutes.length > 0) setRoutes(loadedRoutes);
      } catch (err) {
        console.warn('[App] Background data loading warning:', err);
      }
    })();

    return () => {
      isCancelled = true;
      isStyleLoadedRef.current = false;
      mountedStyleKeyRef.current = '';
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      resizeObserver?.disconnect();
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      if (mapRef.current === map) {
        mapRef.current = null;
      }
      setIsMapReady(false);
      map.remove();
    };
  }, [syncOverlaySourcesToMap, showToast]);

  // Refresh tactical grid when panning/zooming
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const onMoveEnd = () => {
      updateTacticalGridOnMap(map, visibility.tacticalGrid, theme);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
    };
  }, [isMapReady, visibility.tacticalGrid, theme, updateTacticalGridOnMap]);

  // Effect A: Rebuild style only when theme or PMTiles archive URL changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const effectiveOsmUrl = osmInfo?.protocolUrl || pmtilesRegistry.getDefaultOsmProtocolUrl();
    const effectiveDemUrl = demInfo?.protocolUrl || pmtilesRegistry.getDefaultDemProtocolUrl();
    const effectiveContourUrl =
      demInfo?.contourProtocolUrl || pmtilesRegistry.getDefaultContourProtocolUrl() || null;
    const nextStyleKey = `${effectiveOsmUrl}|${effectiveDemUrl}|${theme}`;
    if (mountedStyleKeyRef.current === nextStyleKey) {
      return;
    }
    mountedStyleKeyRef.current = nextStyleKey;
    isStyleLoadedRef.current = false;

    const newStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: effectiveOsmUrl,
      demProtocolUrl: effectiveDemUrl,
      contourProtocolUrl: effectiveContourUrl,
      visibility: visibilityRef.current,
      theme,
    });

    let completed = false;
    const restoreOverlays = () => {
      completed = true;
      if (mapRef.current !== map) return;
      isStyleLoadedRef.current = true;
      applyLayerVisibilityToMap(map, visibilityRef.current);
      syncOverlaySourcesToMap(
        map,
        poisRef.current,
        visibilityRef.current,
        activeRouteRef.current,
        routesRef.current,
        recordedCoordsRef.current,
        themeRef.current,
        planOverlayStateRef.current,
        selectedPoiRef.current
      );
    };

    map.once('style.load', restoreOverlays);
    map.setStyle(newStyle, { diff: false });

    return () => {
      map.off('style.load', restoreOverlays);
      if (!completed && mountedStyleKeyRef.current === nextStyleKey) {
        mountedStyleKeyRef.current = '';
      }
    };
  }, [isMapReady, demInfo, osmInfo, theme, syncOverlaySourcesToMap]);

  // Effect B: Instant in-place refresh for layer visibility, POIs, selected highlight, active route, GPS track, and Route Planner overlays
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    if (!isStyleLoadedRef.current) {
      if (map.isStyleLoaded()) {
        isStyleLoadedRef.current = true;
      } else {
        return;
      }
    }

    applyLayerVisibilityToMap(map, visibility);
    syncOverlaySourcesToMap(
      map,
      pois,
      visibility,
      activeRoute,
      routes,
      recordedCoords,
      theme,
      planOverlayState,
      selectedPoi
    );
  }, [
    isMapReady,
    visibility,
    pois,
    selectedPoi,
    activeRoute,
    routes,
    recordedCoords,
    theme,
    planOverlayState,
    syncOverlaySourcesToMap,
  ]);

  // Initialize unified PMTiles full-map search index & keep synced with active OSM archive
  useEffect(() => {
    const unsubStatus = pmtilesSearchService.subscribeStatus((st) => {
      setSearchStatus(st);
    });
    void pmtilesSearchService.ensureInitialized();
    return () => {
      unsubStatus();
    };
  }, []);

  useEffect(() => {
    if (!osmInfo) return;
    void pmtilesSearchService.syncWithOsmArchive(osmInfo);
  }, [osmInfo]);

  // Close search dropdown when tapping outside the search bar & panel
  useEffect(() => {
    if (!isSearchFocused) return;
    const handlePointerDown = (ev: PointerEvent) => {
      const container = searchContainerRef.current;
      if (container && ev.target instanceof Node && !container.contains(ev.target)) {
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isSearchFocused]);

  const searchRefCoordRef = useRef<{ lon: number; lat: number }>({
    lon: 34.8134,
    lat: 30.8281,
  });
  searchRefCoordRef.current = userLocation ?? { lon: cursorCoords.lon, lat: cursorCoords.lat };

  // Live unified search over all PMTiles vector features + POIs + saved routes + ITM/WGS84 coords
  useEffect(() => {
    if (!isSearchFocused && !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const results = pmtilesSearchService.search(searchQuery, {
      filter: searchFilter,
      referenceCoord: searchRefCoordRef.current,
      pois,
      routes,
      limit: 30,
    });
    setSearchResults(results);
    setActiveSearchIndex(0);
  }, [
    searchQuery,
    searchFilter,
    isSearchFocused,
    searchStatus.totalFeatures,
    searchStatus.fingerprint,
    pois,
    routes,
  ]);

  // Auto-select longest saved route when opening Routes drawer with none active
  useEffect(() => {
    const routesUiOpen =
      (!isMobile && desktopDrawer === 'routes') ||
      (isMobile && mobileDisplayMode === 'planning' && mobileTab === 'routes');
    if (routesUiOpen && !activeRoute && routes.length > 0) {
      const longest = routes.reduce(
        (best, cur) => (cur.distanceKm > best.distanceKm ? cur : best),
        routes[0]
      );
      setActiveRoute(longest);
    }
  }, [isMobile, desktopDrawer, mobileDisplayMode, mobileTab, activeRoute, routes]);

  // Clear chart hover marker whenever the elevation drawer/tab closes
  useEffect(() => {
    const showingRoutes =
      (!isMobile && desktopDrawer === 'routes') ||
      (isMobile &&
        mobileDisplayMode === 'planning' &&
        !mobilePlanningOverlay &&
        mobileTab === 'routes');
    if (!showingRoutes && hoverMarkerRef.current) {
      hoverMarkerRef.current.remove();
      hoverMarkerRef.current = null;
    }
  }, [isMobile, desktopDrawer, mobileDisplayMode, mobilePlanningOverlay, mobileTab]);

  // Nearest POIs for Mobile Planning Peek Strip
  const referenceCoord = userLocation ?? { lon: cursorCoords.lon, lat: cursorCoords.lat };

  const nearbyPois = useMemo(() => {
    const refPt = turf.point([referenceCoord.lon, referenceCoord.lat]);
    return pois
      .map((p) => ({
        poi: p,
        distKm: turf.distance(refPt, turf.point([p.lon, p.lat]), { units: 'kilometers' }),
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 10);
  }, [pois, referenceCoord.lon, referenceCoord.lat]);

  const handleFlyTo = (lon: number, lat: number, zoom = 14) => {
    mapRef.current?.flyTo({ center: [lon, lat], zoom, essential: true });
  };

  const fitBoundsToRoutes = useCallback((targetRoutes: SavedRouteRecord[]) => {
    const map = mapRef.current;
    if (!map || targetRoutes.length === 0) return;
    try {
      const allFeatures = targetRoutes.flatMap((r) => r.geojson?.features || []);
      if (allFeatures.length > 0) {
        const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: allFeatures };
        const [minX, minY, maxX, maxY] = turf.bbox(fc);
        if (
          Number.isFinite(minX) &&
          Number.isFinite(minY) &&
          Number.isFinite(maxX) &&
          Number.isFinite(maxY)
        ) {
          if (Math.abs(maxX - minX) < 0.0005 && Math.abs(maxY - minY) < 0.0005) {
            map.flyTo({
              center: [(minX + maxX) / 2, (minY + maxY) / 2],
              zoom: 15,
              essential: true,
            });
          } else {
            map.fitBounds(
              [
                [minX, minY],
                [maxX, maxY],
              ],
              {
                padding: isMobileRef.current
                  ? { top: 115, bottom: 70, left: 40, right: 40 }
                  : { top: 90, bottom: 90, left: 90, right: 430 },
                maxZoom: 15,
                duration: 750,
              }
            );
          }
          return;
        }
      }
    } catch {
      // Fall through to midpoint fallback
    }
    const pts = targetRoutes[0]?.elevationProfile || [];
    if (pts.length > 0) {
      const mid = pts[Math.floor(pts.length / 2)];
      map.flyTo({ center: [mid.lon, mid.lat], zoom: 13.0, essential: true });
    }
  }, []);

  const handleFlyToRoute = useCallback(
    (route: SavedRouteRecord) => {
      fitBoundsToRoutes([route]);
    },
    [fitBoundsToRoutes]
  );

  const handleImportedData = useCallback(
    async (poiCount: number, createdRoutes: SavedRouteRecord[]) => {
      const [updatedPois, updatedRoutes] = await Promise.all([
        PoiManager.getAllPois(),
        RouteManager.initializeStarterRoutes(),
      ]);
      setPois(updatedPois);
      setRoutes(updatedRoutes);

      if (createdRoutes.length > 0) {
        const primary = createdRoutes.reduce(
          (best, cur) => (cur.distanceKm > best.distanceKm ? cur : best),
          createdRoutes[0]
        );
        setActiveRoute(primary);
        if (isMobileRef.current) {
          setMobileDisplayMode('planning');
          setMobileTab('routes');
          setMobilePlanningOverlay(null);
          setMobileSheetExpanded(true);
        } else {
          setDesktopDrawer('routes');
          setIsStorageOpen(false);
        }
        fitBoundsToRoutes(createdRoutes);
        showToast(
          createdRoutes.length === 1
            ? `המסלול "${primary.name}" מוצג במפה`
            : `יובאו ${createdRoutes.length} מסלולי שטח ומוצגים במפה`
        );
      } else if (poiCount > 0) {
        const latestPoi = updatedPois[updatedPois.length - 1];
        if (!isMobileRef.current) {
          setIsStorageOpen(false);
        } else {
          setMobileTab('explore');
          setMobilePlanningOverlay(null);
        }
        if (latestPoi) {
          setSelectedPoi(latestPoi);
          mapRef.current?.flyTo({
            center: [latestPoi.lon, latestPoi.lat],
            zoom: 14,
            essential: true,
          });
        }
        showToast(`יובאו ${poiCount} נקודות עניין למפה`);
      }
    },
    [fitBoundsToRoutes, showToast]
  );

  const handleHoverElevationChart = (
    pt: { lon: number; lat: number; ele: number; distKm: number } | null
  ) => {
    const map = mapRef.current;
    if (!map) return;
    if (!pt) {
      hoverMarkerRef.current?.remove();
      hoverMarkerRef.current = null;
      return;
    }
    const markerColor =
      activeRouteRef.current?.sourceFormat === 'planned'
        ? PLANNING_ROUTE_COLOR
        : !activeRouteRef.current?.color || activeRouteRef.current.color === '#10b981'
          ? '#ec4899'
          : activeRouteRef.current.color;
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'w-4 h-4 rounded-full border-2 border-white shadow-lg pointer-events-none';
      el.style.backgroundColor = markerColor;
      hoverMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([pt.lon, pt.lat])
        .addTo(map);
    } else {
      hoverMarkerRef.current.getElement().style.backgroundColor = markerColor;
      hoverMarkerRef.current.setLngLat([pt.lon, pt.lat]);
    }
  };

  const handleLocateMe = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lon = pos.coords.longitude;
        const lat = pos.coords.latitude;
        setUserLocation({ lon, lat });
        handleFlyTo(lon, lat, 14);
        if (mapRef.current) {
          if (!userMarkerRef.current) {
            userMarkerRef.current = new maplibregl.Marker({ color: '#0ea5e9' })
              .setLngLat([lon, lat])
              .addTo(mapRef.current);
          } else {
            userMarkerRef.current.setLngLat([lon, lat]);
          }
        }
        if (activeRoute) {
          const check = RouteManager.checkNavigationDeviation(activeRoute, lon, lat);
          setOffRouteWarning(check.isOffRoute ? check.distanceFromTrailMeters : null);
        }
      },
      () => {
        const demoLon = 34.8134;
        const demoLat = 30.8281;
        handleFlyTo(demoLon, demoLat, 13.5);
        showToast('מיקום GPS לא זמין — ממרכז לאזור עין עקב');
      }
    );
  };

  const handleToggle3D = () => {
    const next3d = !visibility.terrain3d;
    setVisibility((prev) => ({ ...prev, terrain3d: next3d }));
    mapRef.current?.easeTo({ pitch: next3d ? 60 : 0, duration: 700 });
  };

  const handleResetNorth = () => {
    mapRef.current?.easeTo({ bearing: 0, pitch: visibility.terrain3d ? 60 : 0, duration: 500 });
  };

  const handleSelectPoi = (item: PoiRecord, zoom = 14) => {
    setSelectedPoi(item);
    handleFlyTo(item.lon, item.lat, zoom);
    setSearchQuery('');
    setSearchResults([]);
    setIsSearchFocused(false);
    if (isMobile) {
      setMobileDisplayMode('planning');
      setMobileTab('explore');
      setMobilePlanningOverlay('poi');
      setMobileSheetExpanded(true);
    } else {
      setDesktopDrawer('poi');
    }
  };

  const handleSelectSearchResult = (item: SearchResultItem) => {
    setSearchQuery('');
    setSearchResults([]);
    setIsSearchFocused(false);

    if (item.kind === 'route' && item.routeRecord) {
      setSelectedPoi(null);
      void handleSelectRoute(item.routeRecord);
      if (isMobile) {
        setMobileDisplayMode('planning');
        setMobileTab('routes');
        setMobilePlanningOverlay(null);
        setMobileSheetExpanded(true);
      } else {
        setDesktopDrawer('routes');
      }
      return;
    }

    const existingMatch = poisRef.current.find((p) => p.id === item.id);
    const poiRec = existingMatch || item.toPoiRecord();
    handleSelectPoi(poiRec, item.recommendedZoom || 14.5);
  };

  const handleNavigateToPoi = (poi: PoiRecord) => {
    handleFlyTo(poi.lon, poi.lat, 14.5);
    showToast(`מכוון אל ${poi.nameHe} (${poi.ele ?? '---'}m)`);
    if (isMobile) {
      setMobileDisplayMode('navigating');
      setMobileNavOverlay('poi-mini');
    }
  };

  const handleSelectRoute = async (route: SavedRouteRecord | null) => {
    if (!route) {
      handleHoverElevationChart(null);
      setActiveRoute(null);
      setIsNavigatingRoute(false);
      setOffRouteWarning(null);
      setRemainingDistKm(null);
      return;
    }
    handleHoverElevationChart(null);
    const refreshed = await RouteManager.refreshRouteElevationsFromDem(route);
    setActiveRoute(refreshed);
    setRoutes((prev) => prev.map((r) => (r.id === refreshed.id ? refreshed : r)));
    handleFlyToRoute(refreshed);
  };

  const handleStartRouteNavigation = async (route: SavedRouteRecord) => {
    await handleSelectRoute(route);
    setIsNavigatingRoute(true);
    setRemainingDistKm(route.distanceKm);
    if (isMobile) {
      setMobileDisplayMode('navigating');
      setMobileNavOverlay(null);
    }
    showToast(`ניווט פעיל במסלול: ${route.name}`);
  };

  const handleStopRouteNavigation = () => {
    setIsNavigatingRoute(false);
    setOffRouteWarning(null);
    setRemainingDistKm(null);
    if (isMobile) {
      setMobileDisplayMode('planning');
      setMobileTab('explore');
      setMobileNavOverlay(null);
    }
    showToast('הניווט במסלול הופסק');
  };

  const handleDeleteRoute = async (routeId: string) => {
    deletedRouteIdsRef.current.add(routeId);
    const target = routesRef.current.find((r) => r.id === routeId);
    const wasActive = activeRouteRef.current?.id === routeId;
    const nextRoutes = routesRef.current.filter((r) => r.id !== routeId);
    const nextActive = wasActive ? null : activeRouteRef.current;

    // Immediately clear map hover marker, React state, and MapLibre GeoJSON sources
    handleHoverElevationChart(null);
    routesRef.current = nextRoutes;
    activeRouteRef.current = nextActive;
    setRoutes((prev) => prev.filter((r) => r.id !== routeId));
    setActiveRoute((cur) => (cur?.id === routeId ? null : cur));
    if (wasActive) {
      setIsNavigatingRoute(false);
      setOffRouteWarning(null);
      setRemainingDistKm(null);
    }

    if (mapRef.current && mapRef.current.getStyle()) {
      syncOverlaySourcesToMap(
        mapRef.current,
        poisRef.current,
        visibilityRef.current,
        nextActive,
        nextRoutes,
        recordedCoordsRef.current,
        themeRef.current,
        planOverlayStateRef.current,
        selectedPoiRef.current
      );
    }

    await RouteManager.deleteRoute(routeId);
    if (target && currentUser && target.sourceFormat === 'planned') {
      void PlannedTracksCloudService.deleteRemotePlannedRoute(target, currentUser);
    }
    showToast('המסלול נמחק מהמכשיר');
  };

  const recomputePlanElevationStats = useCallback(
    async (legs: PlannedLeg[], wps: PlannedWaypoint[]) => {
      const allPts: Array<[number, number]> = [];
      for (const leg of legs) {
        for (const c of leg.coordinates) {
          const prev = allPts[allPts.length - 1];
          if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) allPts.push(c);
        }
      }
      if (allPts.length < 2) {
        setPlanElevStats({ ascent: 0, descent: 0 });
        return;
      }

      const maxSamples = 35;
      const step = Math.max(1, Math.floor(allPts.length / maxSamples));
      const sampledCoords: Array<[number, number]> = [];
      for (let i = 0; i < allPts.length; i += step) sampledCoords.push(allPts[i]);
      const last = allPts[allPts.length - 1];
      const tail = sampledCoords[sampledCoords.length - 1];
      if (tail[0] !== last[0] || tail[1] !== last[1]) sampledCoords.push(last);

      const eles = await Promise.all(
        sampledCoords.map(([lon, lat]) => ElevationService.getElevationAt(lon, lat, 11))
      );
      if (planLegsRef.current.length !== legs.length) return;

      let ascent = 0;
      let descent = 0;
      let prevEle: number | null = null;
      for (const ele of eles) {
        if (ele === null) continue;
        if (prevEle !== null) {
          const d = ele - prevEle;
          if (d > 0) ascent += d;
          else descent += Math.abs(d);
        }
        prevEle = ele;
      }

      if (prevEle === null && wps.length >= 2) {
        let p: number | null = null;
        for (const wp of wps) {
          if (typeof wp.ele !== 'number') continue;
          if (p !== null) {
            const d = wp.ele - p;
            if (d > 0) ascent += d;
            else descent += Math.abs(d);
          }
          p = wp.ele;
        }
      }

      setPlanElevStats({ ascent: Math.round(ascent), descent: Math.round(descent) });
    },
    []
  );

  const handlePlanMapClick = useCallback(
    async (clickLon: number, clickLat: number) => {
      if (isRoutingLegRef.current) return;
      const mode = planningModeRef.current;

      const work = (async () => {
        setIsRoutingLeg(true);
        try {
          const snapped = await routePlannerEngine.snapToNearestHighway(clickLon, clickLat, mode);
          if (!snapped) {
            showToast(
              `לא נמצא ${
                mode === '4x4' ? 'כביש או דרך עפר' : 'שביל או דרך'
              } קרובה (עד ${PLANNING_MODE_META[mode].maxSnapRadiusMeters} מ׳)`
            );
            return;
          }

          const ele = await ElevationService.getElevationAt(snapped.lon, snapped.lat, 11);
          const prevWaypoints = planWaypointsRef.current;

          if (prevWaypoints.length === 0) {
            const firstWp: PlannedWaypoint = {
              lon: snapped.lon,
              lat: snapped.lat,
              ele,
              roadLabel: snapped.roadLabel,
            };
            setDisconnectedCandidate(null);
            setPlanWaypoints([firstWp]);
            setPlanPreviewPoint(snapped);
            return;
          }

          const prevWp = prevWaypoints[prevWaypoints.length - 1];
          const res = await routePlannerEngine.routeBetweenSnappedPoints(prevWp, snapped, mode);
          if (!res.found) {
            setDisconnectedCandidate(snapped);
            if (isMobileRef.current) {
              setMobileSheetExpanded(true);
            }
            if (res.reason === 'tile-budget-exceeded') {
              showToast('המרחק בין הנקודות גדול מדי לצעד אחד — הוסף נקודת ביניים או חבר בקו ישר');
            } else {
              showToast('לא נמצא חיבור ברשת הדרכים — ניתן לבחור "חבר בקו ישר"');
            }
            return;
          }

          const newLeg: PlannedLeg = {
            coordinates: res.coordinates,
            distanceKm: res.distanceKm,
            legType: 'network',
            roadLabels: res.roadLabels,
          };
          const newWp: PlannedWaypoint = {
            lon: snapped.lon,
            lat: snapped.lat,
            ele,
            roadLabel: snapped.roadLabel,
            legType: 'network',
          };
          const nextWps = [...prevWaypoints, newWp];
          const nextLegs = [...planLegsRef.current, newLeg];
          setDisconnectedCandidate(null);
          setPlanWaypoints(nextWps);
          setPlanLegs(nextLegs);
          void recomputePlanElevationStats(nextLegs, nextWps);
        } finally {
          setIsRoutingLeg(false);
        }
      })();

      activeRoutePromiseRef.current = work;
      try {
        await work;
      } finally {
        if (activeRoutePromiseRef.current === work) {
          activeRoutePromiseRef.current = null;
        }
      }
    },
    [recomputePlanElevationStats, showToast]
  );

  const handleConfirmStraightLine = useCallback(async () => {
    const cand = disconnectedCandidateRef.current;
    const prevWps = planWaypointsRef.current;
    if (!cand || prevWps.length === 0) return;
    const prevWp = prevWps[prevWps.length - 1];
    const distKm = Number(
      turf
        .distance(turf.point([prevWp.lon, prevWp.lat]), turf.point([cand.lon, cand.lat]), {
          units: 'kilometers',
        })
        .toFixed(3)
    );
    const ele = await ElevationService.getElevationAt(cand.lon, cand.lat, 11);
    const newLeg: PlannedLeg = {
      coordinates: [
        [prevWp.lon, prevWp.lat],
        [cand.lon, cand.lat],
      ],
      distanceKm: distKm,
      legType: 'straight',
      roadLabels: [cand.roadLabel],
    };
    const newWp: PlannedWaypoint = {
      lon: cand.lon,
      lat: cand.lat,
      ele,
      roadLabel: cand.roadLabel,
      legType: 'straight',
    };
    const nextWps = [...prevWps, newWp];
    const nextLegs = [...planLegsRef.current, newLeg];
    setDisconnectedCandidate(null);
    setPlanWaypoints(nextWps);
    setPlanLegs(nextLegs);
    void recomputePlanElevationStats(nextLegs, nextWps);
  }, [recomputePlanElevationStats]);

  const handleCancelDisconnected = useCallback(() => {
    setDisconnectedCandidate(null);
  }, []);

  const handleUndoLastPlanPoint = useCallback(() => {
    if (disconnectedCandidateRef.current) {
      setDisconnectedCandidate(null);
      return;
    }
    const prevWps = planWaypointsRef.current;
    if (prevWps.length === 0) return;
    const nextWps = prevWps.slice(0, -1);
    const nextLegs = nextWps.length <= 1 ? [] : planLegsRef.current.slice(0, -1);
    setPlanWaypoints(nextWps);
    setPlanLegs(nextLegs);
    void recomputePlanElevationStats(nextLegs, nextWps);
  }, [recomputePlanElevationStats]);

  const handleClearPlan = useCallback(() => {
    snapSeqRef.current += 1;
    disconnectedCandidateRef.current = null;
    planWaypointsRef.current = [];
    planLegsRef.current = [];
    setDisconnectedCandidate(null);
    setPlanWaypoints([]);
    setPlanLegs([]);
    setPlanPreviewPoint(null);
    setPlanCursorCoord(null);
    setPlanElevStats({ ascent: 0, descent: 0 });
    if (mapRef.current && mapRef.current.getStyle()) {
      syncOverlaySourcesToMap(
        mapRef.current,
        poisRef.current,
        visibilityRef.current,
        activeRouteRef.current,
        routesRef.current,
        recordedCoordsRef.current,
        themeRef.current,
        {
          ...planOverlayStateRef.current,
          waypoints: [],
          legs: [],
          previewPoint: null,
          cursorCoord: null,
          disconnectedCandidate: null,
        },
        selectedPoiRef.current
      );
    }
  }, [syncOverlaySourcesToMap]);

  const handleChangePlanningMode = useCallback(
    (nextMode: PlanningMode) => {
      setPlanningMode(nextMode);
      setDisconnectedCandidate(null);
      if (planCursorCoord) {
        void routePlannerEngine
          .snapToNearestHighway(planCursorCoord[0], planCursorCoord[1], nextMode)
          .then((snap) => setPlanPreviewPoint(snap));
      }
      showToast(`מצב תכנון: ${PLANNING_MODE_META[nextMode].labelHe}`);
    },
    [planCursorCoord, showToast]
  );

  const handleFinishPlanningRoute = useCallback(async () => {
    if (activeRoutePromiseRef.current) {
      await activeRoutePromiseRef.current;
    }
    const wps = planWaypointsRef.current;
    const legs = planLegsRef.current;
    const mode = planningModeRef.current;

    if (wps.length < 2 || legs.length === 0) {
      showToast('נדרשות לפחות 2 נקודות ציר כדי לשמור מסלול');
      return;
    }

    setIsSavingPlan(true);
    try {
      const modeMeta = PLANNING_MODE_META[mode];
      const defaultName = `מסלול ${modeMeta.shortLabelHe} ${new Date().toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
      const finalName = planRouteName.trim() || defaultName;
      const segments = legs
        .map((l) => l.coordinates)
        .filter((coords) => coords.length >= 2);

      const savedLocal = await RouteManager.createAndSavePlannedRoute({
        name: finalName,
        mode,
        segments,
        waypoints: wps,
        ownerUid: currentUser?.uid ?? null,
        ownerEmail: currentUser?.email ?? null,
      });

      let finalRecord = savedLocal;
      setRoutes((prev) => [...prev, savedLocal]);
      setActiveRoute(savedLocal);

      if (currentUser && isOnline && AuthService.isAvailable()) {
        const cloudRes = await PlannedTracksCloudService.savePlannedRouteToFirebase(
          savedLocal,
          currentUser
        );
        if (deletedRouteIdsRef.current.has(savedLocal.id)) {
          await RouteManager.deleteRoute(savedLocal.id);
          void PlannedTracksCloudService.deleteRemotePlannedRoute(cloudRes.route, currentUser);
          return;
        }
        finalRecord = cloudRes.route;
        setRoutes((prev) => prev.map((r) => (r.id === finalRecord.id ? finalRecord : r)));
        setActiveRoute((cur) => (cur?.id === finalRecord.id ? finalRecord : cur));

        if (cloudRes.synced) {
          showToast(`המסלול "${finalRecord.name}" נשמר כ-GPX במכשיר וב-planing_tracks!`);
        } else {
          showToast(`נשמר מקומית כ-GPX (סנכרון ענן נדחה: ${cloudRes.error || 'שגיאה'})`);
        }
      } else if (!AuthService.isAvailable()) {
        showToast(`המסלול "${finalRecord.name}" נשמר מקומית כ-GPX`);
      } else if (!currentUser) {
        showToast('המסלול נשמר מקומית כ-GPX — התחבר עם Gmail לגיבוי ב-planing_tracks');
      } else {
        showToast('אופליין: המסלול נשמר כ-GPX במכשיר ויסונכרן עם החזרה לרשת');
      }

      setDisconnectedCandidate(null);
      setPlanWaypoints([]);
      setPlanLegs([]);
      setPlanPreviewPoint(null);
      setPlanCursorCoord(null);
      setPlanRouteName('');
      setPlanElevStats({ ascent: 0, descent: 0 });

      if (isMobileRef.current) {
        setMobilePlanningOverlay(null);
        setMobileDisplayMode('planning');
        setMobileTab('routes');
        setMobileSheetExpanded(true);
      } else {
        setDesktopDrawer('routes');
      }
    } catch (err: any) {
      showToast(err?.message || 'שגיאה בשמירת המסלול');
    } finally {
      setIsSavingPlan(false);
    }
  }, [planRouteName, currentUser, isOnline, showToast]);

  handlePlanMapClickRef.current = handlePlanMapClick;
  handleFinishPlanningRef.current = handleFinishPlanningRoute;

  const handleSignInGoogle = useCallback(async () => {
    setIsAuthBusy(true);
    try {
      const user = await AuthService.signInWithGmail();
      setCurrentUser(user);
      showToast(`מחובר ל-Google: ${user.email || user.displayName}`);
    } catch (err: any) {
      showToast(err?.message || 'שגיאה בהתחברות ל-Google');
    } finally {
      setIsAuthBusy(false);
    }
  }, [showToast]);

  const handleSignOutGoogle = useCallback(async () => {
    setIsAuthBusy(true);
    try {
      await AuthService.signOut();
      setCurrentUser(null);
      showToast('התנתקת מחשבון Google');
    } finally {
      setIsAuthBusy(false);
    }
  }, [showToast]);

  const handleSyncPendingNow = useCallback(async () => {
    if (!currentUser) return;
    try {
      const count = await PlannedTracksCloudService.syncPendingRoutesForUser(currentUser);
      const all = await db.routes.toArray();
      setRoutes(all);
      showToast(count > 0 ? `סונכרנו ${count} מסלולים ל-planing_tracks` : 'הכל כבר מסונכרן');
    } catch (err: any) {
      showToast(err?.message || 'שגיאת סנכרון');
    }
  }, [currentUser, showToast]);

  const planTotalDistanceKm = useMemo(
    () => Number(planLegs.reduce((sum, leg) => sum + leg.distanceKm, 0).toFixed(2)),
    [planLegs]
  );

  const pendingCloudSyncCount = useMemo(
    () =>
      routes.filter(
        (r) =>
          r.sourceFormat === 'planned' &&
          (r.cloudSyncStatus === 'pending' || r.cloudSyncStatus === 'error')
      ).length,
    [routes]
  );

  const handleStartOrResumeRecording = () => {
    if (!isRecordingTrack) {
      const startPt: [number, number] = userLocation
        ? [userLocation.lon, userLocation.lat]
        : [Number(cursorCoords.lon.toFixed(5)), Number(cursorCoords.lat.toFixed(5))];
      setRecordedCoords([startPt]);
      setRecordedDistanceKm(0);
      setRecordedAscentMeters(0);
      setRecordElapsedSeconds(0);
      lastRecordedEleRef.current = cursorCoords.ele;
      setIsRecordingTrack(true);
      setIsRecordingPaused(false);
      showToast('הקלטת מסלול GPS החלה');
    } else {
      setIsRecordingPaused(false);
      showToast('הקלטת מסלול נמשכת');
    }
  };

  const handleSaveRecordedTrack = async () => {
    if (recordedCoords.length < 2) {
      showToast('נדרשות לפחות 2 נקודות תנועה לשמירת מסלול');
      return;
    }
    const saved = await RouteManager.createAndSaveRoute({
      name: `הקלטת שטח ${new Date().toLocaleTimeString('he-IL', {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
      coordinates: recordedCoords,
      sourceFormat: 'drawn',
      color: '#0ea5e9',
    });
    setRoutes((prev) => [...prev, saved]);
    setActiveRoute(saved);
    setIsRecordingTrack(false);
    setIsRecordingPaused(false);
    setRecordedCoords([]);
    setRecordElapsedSeconds(0);
    if (isMobile) {
      setMobileDisplayMode('planning');
      setMobileTab('routes');
    } else {
      setDesktopDrawer('routes');
    }
    showToast(`המסלול "${saved.name}" נשמר למכשיר!`);
  };

  const handleDiscardRecordedTrack = () => {
    lastRecordedEleRef.current = null;
    setIsRecordingTrack(false);
    setIsRecordingPaused(false);
    setRecordedCoords([]);
    setRecordedDistanceKm(0);
    setRecordedAscentMeters(0);
    setRecordElapsedSeconds(0);
    showToast('ההקלטה בוטלה');
  };

  const handleCopyGrid = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    showToast(`הועתק ללוח: ${text}`);
  };

  const milCoords = MilitaryGridService.toMilitaryCoords(cursorCoords.lon, cursorCoords.lat);
  const isOfflineReady =
    Boolean(osmInfo && (osmInfo.record.storageKind === 'opfs' || osmInfo.record.storageKind === 'native-file' || osmInfo.record.storageKind === 'user-file')) &&
    Boolean(demInfo && (demInfo.record.storageKind === 'opfs' || demInfo.record.storageKind === 'native-file' || demInfo.record.storageKind === 'user-file'));

  const renderSearchBar = (compactMobile: boolean) => {
    const showDropdown = isSearchFocused || searchQuery.trim().length > 0;
    const isIndexingCustom = Boolean(searchStatus.indexingProgress);
    const indexPct =
      searchStatus.indexingProgress && searchStatus.indexingProgress.total > 0
        ? Math.min(
            100,
            Math.round(
              (searchStatus.indexingProgress.done / searchStatus.indexingProgress.total) * 100
            )
          )
        : 0;
    const quickExamples = [
      'ירושלים',
      'עין עקב',
      'כביש 6',
      'הר מירון',
      'נחל צין',
      'מעלה זיק',
      '1813-5828',
    ];

    return (
      <div ref={searchContainerRef} className="relative">
        <div
          className={`flex items-center gap-2 border transition-colors ${
            compactMobile ? 'rounded-full px-3.5 py-2' : 'rounded-2xl px-3.5 py-2.5'
          } ${t.panel}`}
        >
          <Search
            className={`w-4 h-4 shrink-0 ${
              isIndexingCustom ? 'text-amber-500 animate-pulse' : 'text-emerald-500'
            }`}
          />
          <input
            type="text"
            dir="auto"
            value={searchQuery}
            onFocus={() => setIsSearchFocused(true)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setIsSearchFocused(false);
                (e.target as HTMLInputElement).blur();
                return;
              }
              if (e.key === 'ArrowDown' && searchResults.length > 0) {
                e.preventDefault();
                setActiveSearchIndex((idx) => (idx + 1) % searchResults.length);
                return;
              }
              if (e.key === 'ArrowUp' && searchResults.length > 0) {
                e.preventDefault();
                setActiveSearchIndex(
                  (idx) => (idx - 1 + searchResults.length) % searchResults.length
                );
                return;
              }
              if (e.key === 'Enter' && searchResults.length > 0) {
                e.preventDefault();
                const chosen = searchResults[activeSearchIndex] || searchResults[0];
                if (chosen) {
                  handleSelectSearchResult(chosen);
                  (e.target as HTMLInputElement).blur();
                }
              }
            }}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setIsSearchFocused(true);
            }}
            placeholder="חפש עיר, רחוב, נחל, הר, חניון, נ.צ..."
            className={`w-full bg-transparent text-sm focus:outline-none ${t.input}`}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setSearchResults([]);
              }}
              className={`p-1 rounded-full text-xs font-bold shrink-0 ${t.muted}`}
              title="נקה חיפוש"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {compactMobile ? (
            <button
              type="button"
              onClick={() => {
                setMobileDisplayMode('planning');
                setMobileTab('offline');
                setMobilePlanningOverlay(null);
              }}
              className={`px-2 py-0.5 rounded-full text-xs font-bold flex items-center gap-1 shrink-0 ${
                isOfflineReady
                  ? 'bg-emerald-500/15 text-emerald-600'
                  : isOnline
                    ? 'bg-sky-500/15 text-sky-600'
                    : 'bg-amber-500/20 text-amber-600'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isOfflineReady ? 'bg-emerald-500' : isOnline ? 'bg-sky-500' : 'bg-amber-500'
                }`}
              />
              <span>{isOfflineReady ? 'אופליין' : isOnline ? 'מקוון' : 'מנותק'}</span>
            </button>
          ) : (
            <>
              <div className="h-5 w-px bg-current opacity-15 shrink-0" />
              <button
                type="button"
                onClick={() => setDesktopDrawer(desktopDrawer === 'routes' ? null : 'routes')}
                title="מסלולים ופרופיל גובה"
                className="p-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shrink-0"
              >
                <RouteIcon className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        {/* Rich Unified Search Panel */}
        {showDropdown && (
          <div
            className={`absolute top-full left-0 right-0 mt-2 rounded-2xl border overflow-hidden z-50 flex flex-col max-h-[64vh] md:max-h-[460px] ${t.panel}`}
          >
            {/* Category Filter Chips */}
            <div
              className={`px-2.5 py-2 border-b flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0 ${t.divider}`}
            >
              {SEARCH_FILTER_TABS.map((tab) => {
                const active = searchFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setSearchFilter(tab.id)}
                    className={`px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap flex items-center gap-1 transition-colors shrink-0 ${
                      active
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : `border ${t.pillBtn}`
                    }`}
                  >
                    <span>{tab.emoji}</span>
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Indexing Status Strip when extracting custom PMTiles archive */}
            {isIndexingCustom && (
              <div
                className={`px-3 py-1.5 border-b text-xs flex items-center justify-between gap-2 text-amber-500 font-semibold ${t.divider}`}
              >
                <span>מעדכן אינדקס חיפוש מהמפה החדשה...</span>
                <span className="font-mono">{indexPct}%</span>
              </div>
            )}

            {/* Body: Suggestions (if empty) OR Ranked Results OR Empty State */}
            <div className="overflow-y-auto min-h-0 flex-1">
              {searchResults.length > 0 ? (
                searchResults.map((item, idx) => {
                  const isHighlighted = idx === activeSearchIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelectSearchResult(item)}
                      onMouseEnter={() => setActiveSearchIndex(idx)}
                      className={`w-full text-right px-3.5 py-2.5 border-b flex items-center justify-between gap-2.5 transition-colors ${t.divider} ${
                        isHighlighted ? 'bg-emerald-500/12' : t.hoverRow
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-base shrink-0">{item.emoji}</span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs font-bold truncate" dir="auto">
                              {item.title}
                            </span>
                            {item.ref && item.filterGroup === 'roads' && (
                              <span
                                dir="ltr"
                                className="px-1.5 py-0.5 rounded bg-sky-500/20 border border-sky-500/40 text-sky-500 text-[10px] font-mono font-bold shrink-0"
                              >
                                {item.ref}
                              </span>
                            )}
                          </div>
                          <div className={`text-xs truncate ${t.muted}`} dir="auto">
                            {item.subtitle}
                          </div>
                        </div>
                      </div>
                      <div className="text-left shrink-0 space-y-0.5">
                        {item.distanceKm !== null && (
                          <div className="text-xs font-mono font-bold text-emerald-500">
                            {item.distanceKm < 1
                              ? `${Math.round(item.distanceKm * 1000)} מ׳`
                              : `${item.distanceKm.toFixed(1)} ק״מ`}
                          </div>
                        )}
                        <div className={`text-[11px] font-mono ${t.muted}`}>
                          {item.ele !== null ? `${item.ele}m` : item.locality || item.categoryLabel}
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : !searchQuery.trim() ? (
                <div className="p-3 space-y-2.5">
                  <div className={`text-xs flex items-center justify-between ${t.muted}`}>
                    <span>
                      {searchStatus.ready
                        ? `מוכנים ${searchStatus.totalFeatures.toLocaleString()} יעדים מהמפה + נ.צ.`
                        : 'טוען אינדקס מפה...'}
                    </span>
                    {osmInfo && (
                      <button
                        type="button"
                        onClick={() => void pmtilesSearchService.rebuildFromPmtiles(osmInfo.pmtiles)}
                        disabled={isIndexingCustom}
                        className="text-emerald-500 hover:underline disabled:opacity-40 font-semibold"
                        title="סרוק מחדש את כל שכבות ה-PMTiles"
                      >
                        סרוק מחדש
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {quickExamples.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => {
                          setSearchFilter('all');
                          setSearchQuery(ex);
                        }}
                        className={`px-2.5 py-1 rounded-full border text-xs font-semibold transition-colors ${t.pillBtn}`}
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={`p-4 text-center text-xs space-y-2 ${t.muted}`}>
                  <div>לא נמצאו תוצאות עבור &ldquo;{searchQuery}&rdquo;</div>
                  {searchFilter !== 'all' ? (
                    <button
                      type="button"
                      onClick={() => setSearchFilter('all')}
                      className="px-3 py-1 rounded-full bg-emerald-600 text-white font-bold"
                    >
                      חפש בכל הקטגוריות
                    </button>
                  ) : (
                    <div>נסה שם עיר, רחוב, נחל, הר, כביש 6 או נ.צ. (לדוגמה 31.77, 35.21)</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      dir="rtl"
      className={`relative w-screen h-screen overflow-hidden bg-slate-950 select-none flex flex-col ${
        isMobile && mobileDisplayMode === 'planning' ? 'navapp-mobile-planning' : ''
      }`}
    >
      {/* Main Map Area (flex-1 ensures Mobile Planning bottom bar cleanly shrinks canvas above it!) */}
      <div className="relative flex-1 overflow-hidden">
        {/* Fullscreen MapLibre GL JS Canvas */}
        <div
          ref={mapContainerRef}
          onClick={() => setIsSearchFocused(false)}
          className="w-full h-full"
        />

        {/* Center Tactical Reticle Crosshair */}
        {(showCenterCrosshair || isAddingPoiMode) && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
            <div className="relative flex items-center justify-center">
              <div className="w-9 h-[2px] bg-red-600/85" />
              <div className="h-9 w-[2px] bg-red-600/85 absolute" />
              <div className="w-5 h-5 rounded-full border-2 border-red-600/85 absolute" />
            </div>
          </div>
        )}

        {/* Background Download from Firebase to OPFS Banner */}
        {downloadStatus && !isNaN(downloadStatus.percent) && downloadStatus.total > 0 && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-slate-900/95 border border-sky-500/50 text-white rounded-2xl shadow-2xl px-4 py-3 flex flex-col gap-2 min-w-[300px] max-w-md backdrop-blur-md">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold text-sky-400 flex items-center gap-1.5">
                <Download className="w-4 h-4 animate-bounce text-sky-400" />
                מוריד {downloadStatus.fileName} למכשיר...
              </span>
              <span className="font-mono text-sky-300 font-bold">{downloadStatus.percent}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
              <div
                className="bg-sky-500 h-2 rounded-full transition-all duration-200 ease-out"
                style={{ width: `${Math.max(3, downloadStatus.percent)}%` }}
              />
            </div>
          </div>
        )}

        {/* Toast Notification */}
        {toastMessage && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white rounded-full shadow-2xl px-4 py-2 flex items-center gap-2 text-xs font-bold">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        {/* ================= DESKTOP / WEB FLOATING CHROME ================= */}
        {!isMobile && (
          <>
            {/* Top-Right (RTL Start): Search Capsule + Contextual Floating Drawer */}
            <div className="absolute top-3 right-3 z-30 w-[380px] max-w-[calc(100vw-24px)] flex flex-col gap-2 pointer-events-none">
              <div className="pointer-events-auto">
                {renderSearchBar(false)}
              </div>

              {desktopDrawer && (
                <div
                  className={`pointer-events-auto rounded-2xl border overflow-hidden flex flex-col max-h-[calc(100vh-155px)] ${t.panel}`}
                >
                  {desktopDrawer === 'poi' && (
                    <PoiInspectorSheet
                      poi={selectedPoi}
                      theme={theme}
                      referenceCoord={referenceCoord}
                      embedded
                      onClose={() => {
                        setSelectedPoi(null);
                        setDesktopDrawer(null);
                      }}
                      onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 14.2)}
                      onNavigateToPoi={handleNavigateToPoi}
                      onPoiUpdated={(updated) => {
                        setSelectedPoi(updated);
                        setPois((prev) =>
                          prev.some((p) => p.id === updated.id)
                            ? prev.map((p) => (p.id === updated.id ? updated : p))
                            : [...prev, updated]
                        );
                      }}
                      onNotify={showToast}
                    />
                  )}

                  {desktopDrawer === 'routes' && (
                    <ElevationProfileDrawer
                      route={activeRoute}
                      routes={routes}
                      pois={pois}
                      theme={theme}
                      embedded
                      isNavigating={isNavigatingRoute}
                      onSelectRoute={handleSelectRoute}
                      onStartNavigation={handleStartRouteNavigation}
                      onStopNavigation={handleStopRouteNavigation}
                      onOpenImporter={() => setIsStorageOpen(true)}
                      onOpenRoutePlanner={() => setDesktopDrawer('plan-route')}
                      onDeleteRoute={handleDeleteRoute}
                      onClose={() => setDesktopDrawer(null)}
                      onHoverPoint={handleHoverElevationChart}
                      onSelectPoint={(pt) =>
                        handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                      }
                      onFlyToRoute={handleFlyToRoute}
                      onFitAllRoutes={() => fitBoundsToRoutes(routes)}
                    />
                  )}

                  {desktopDrawer === 'plan-route' && (
                    <RoutePlannerPanel
                      theme={theme}
                      mode={planningMode}
                      routeName={planRouteName}
                      waypoints={planWaypoints}
                      legs={planLegs}
                      totalDistanceKm={planTotalDistanceKm}
                      ascentMeters={planElevStats.ascent}
                      descentMeters={planElevStats.descent}
                      isRoutingLeg={isRoutingLeg}
                      isSaving={isSavingPlan}
                      disconnectedCandidate={disconnectedCandidate}
                      currentUser={currentUser}
                      firebaseAvailable={AuthService.isAvailable()}
                      isAuthBusy={isAuthBusy}
                      pendingCloudSyncCount={pendingCloudSyncCount}
                      onChangeMode={handleChangePlanningMode}
                      onChangeRouteName={setPlanRouteName}
                      onConfirmStraightLine={handleConfirmStraightLine}
                      onCancelDisconnected={handleCancelDisconnected}
                      onUndoLastPoint={handleUndoLastPlanPoint}
                      onClearPlan={handleClearPlan}
                      onFinishAndSave={handleFinishPlanningRoute}
                      onSignInGoogle={handleSignInGoogle}
                      onSignOutGoogle={handleSignOutGoogle}
                      onSyncPendingNow={handleSyncPendingNow}
                      onClose={() => setDesktopDrawer(null)}
                    />
                  )}

                  {desktopDrawer === 'record' && (
                    <TrackRecorderPanel
                      theme={theme}
                      isRecording={isRecordingTrack}
                      isPaused={isRecordingPaused}
                      elapsedSeconds={recordElapsedSeconds}
                      distanceKm={recordedDistanceKm}
                      ascentMeters={recordedAscentMeters}
                      currentElevation={cursorCoords.ele}
                      pointsCount={recordedCoords.length}
                      onStartOrResume={handleStartOrResumeRecording}
                      onPause={() => setIsRecordingPaused(true)}
                      onSaveRoute={handleSaveRecordedTrack}
                      onDiscard={handleDiscardRecordedTrack}
                      onDropWaypoint={() => setDesktopDrawer('add-poi')}
                      onClose={() => setDesktopDrawer(null)}
                    />
                  )}

                  {desktopDrawer === 'add-poi' && (
                    <AddPoiPanel
                      theme={theme}
                      centerCoords={cursorCoords}
                      onClose={() => setDesktopDrawer(null)}
                      onCreated={(created) => {
                        setPois((prev) => [...prev, created]);
                        setSelectedPoi(created);
                        setDesktopDrawer('poi');
                        showToast(`הנקודה "${created.nameHe}" נשמרה במפה!`);
                      }}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Top-Left (RTL End): Active Nav Alert + Offline Readiness + Quick Action Pills */}
            <div className="absolute top-3 left-3 z-30 flex flex-wrap items-center gap-2 pointer-events-auto">
              {isNavigatingRoute && activeRoute && (
                <div
                  className={`px-3.5 py-2 rounded-full border shadow-xl text-xs font-bold flex items-center gap-2 ${
                    offRouteWarning !== null
                      ? 'bg-red-600 border-red-400 text-white animate-pulse'
                      : 'bg-emerald-600 border-emerald-400 text-white'
                  }`}
                >
                  {offRouteWarning !== null ? (
                    <>
                      <AlertTriangle className="w-4 h-4" />
                      <span>סטייה מציר: {offRouteWarning} מ׳</span>
                    </>
                  ) : (
                    <>
                      <Navigation className="w-4 h-4" />
                      <span>
                        בניווט: {activeRoute.name}
                        {remainingDistKm !== null ? ` • נותר ${remainingDistKm} ק״מ` : ''}
                      </span>
                    </>
                  )}
                  <button
                    onClick={handleStopRouteNavigation}
                    className="px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 text-xs"
                  >
                    סיים
                  </button>
                </div>
              )}

              {/* Compact Offline Status Pill */}
              <button
                onClick={() => setIsStorageOpen(true)}
                className={`px-3 py-2 rounded-full border text-xs font-semibold flex items-center gap-2 transition-colors ${t.panel}`}
                title="ניהול מפות אופליין וייבוא GPX/KML"
              >
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                    isOfflineReady ? 'bg-emerald-500' : isOnline ? 'bg-sky-500' : 'bg-amber-500'
                  }`}
                />
                <HardDrive className="w-3.5 h-3.5 text-sky-500" />
                <span>
                  {isOfflineReady
                    ? '100% אופליין מוכן'
                    : isOnline
                      ? 'מפות אופליין / ייבוא'
                      : 'מצב אופליין'}
                </span>
              </button>

              {/* Quick Mode Pills */}
              <div className={`flex items-center gap-1 rounded-full p-1 border ${t.panel}`}>
                <button
                  onClick={() => setDesktopDrawer(desktopDrawer === 'routes' ? null : 'routes')}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    desktopDrawer === 'routes' ? 'bg-emerald-600 text-white' : t.hoverRow
                  }`}
                >
                  <RouteIcon className="w-3.5 h-3.5 text-emerald-500" />
                  <span>מסלולים</span>
                </button>

                <button
                  onClick={() =>
                    setDesktopDrawer(desktopDrawer === 'plan-route' ? null : 'plan-route')
                  }
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    desktopDrawer === 'plan-route' ? 'bg-blue-600 text-white' : t.hoverRow
                  }`}
                >
                  <PenTool
                    className={`w-3.5 h-3.5 ${
                      desktopDrawer === 'plan-route' ? 'text-white' : 'text-blue-500'
                    }`}
                  />
                  <span>תכנון מסלול</span>
                </button>

                <button
                  onClick={() => setDesktopDrawer(desktopDrawer === 'record' ? null : 'record')}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    desktopDrawer === 'record' || isRecordingTrack
                      ? 'bg-rose-600 text-white'
                      : t.hoverRow
                  }`}
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      isRecordingTrack ? 'bg-white animate-pulse' : 'bg-rose-500'
                    }`}
                  />
                  <span>
                    {isRecordingTrack ? formatDuration(recordElapsedSeconds) : 'הקלטה'}
                  </span>
                </button>

                <button
                  onClick={() => setDesktopDrawer(desktopDrawer === 'add-poi' ? null : 'add-poi')}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    desktopDrawer === 'add-poi' ? 'bg-sky-600 text-white' : t.hoverRow
                  }`}
                >
                  <Plus className="w-4 h-4 text-sky-500" />
                  <span>דווח נקודה</span>
                </button>
              </div>
            </div>

            {/* Live Snap-to-Highway Indicator Banner (Desktop Planning Mode) */}
            {desktopDrawer === 'plan-route' && (
              <div
                className={`absolute bottom-14 left-1/2 -translate-x-1/2 z-20 px-3.5 py-1.5 rounded-full border text-xs font-semibold flex items-center gap-2 pointer-events-none shadow-lg ${t.panel}`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: PLANNING_MODE_META[planningMode].color }}
                />
                {isRoutingLeg ? (
                  <span>מחשב חיבור על רשת הדרכים...</span>
                ) : planPreviewPoint ? (
                  <span>
                    נצמד ל: {planPreviewPoint.roadLabel} ({planPreviewPoint.distFromClickMeters} מ׳)
                    • לחיצה להוספה • דאבל-קליק לסיום
                  </span>
                ) : (
                  <span>לחץ על כביש או שביל להוספת נקודה • דאבל-קליק לסיום</span>
                )}
              </div>
            )}

            {/* Bottom-Left (RTL End): Layers Preview Card + Map Controls Stack */}
            <div className="absolute bottom-4 left-4 z-20 flex items-end gap-2.5 pointer-events-auto">
              {/* Visual Layers Preview Card */}
              <button
                onClick={() => setIsLayerSheetOpen(!isLayerSheetOpen)}
                className={`w-16 h-16 rounded-2xl border-2 shadow-xl overflow-hidden relative transition-transform hover:scale-105 ${
                  isLayerSheetOpen ? 'border-emerald-500' : 'border-white'
                }`}
                title="שכבות וסוג מפה"
              >
                <div
                  className={`absolute inset-0 flex items-center justify-center ${
                    theme === 'topo-day'
                      ? 'bg-gradient-to-br from-[#f4efe2] via-amber-200/70 to-emerald-200 text-amber-950'
                      : 'bg-gradient-to-br from-slate-900 via-slate-800 to-sky-950 text-sky-300'
                  }`}
                >
                  {theme === 'topo-day' ? (
                    <Sun className="w-5 h-5" />
                  ) : (
                    <Moon className="w-5 h-5" />
                  )}
                </div>
                <div className="absolute inset-x-0 bottom-0 bg-slate-950/80 text-white text-xs font-bold py-0.5 text-center flex items-center justify-center gap-1">
                  <Layers className="w-3 h-3" />
                  <span>שכבות</span>
                </div>
              </button>

              {/* Vertical Control Stack */}
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={handleToggle3D}
                  className={`w-10 h-10 rounded-xl border shadow-lg text-xs font-bold flex items-center justify-center transition-all ${
                    visibility.terrain3d ? 'bg-emerald-600 border-emerald-400 text-white' : t.pillBtn
                  }`}
                  title="תבליט 3D"
                >
                  3D
                </button>

                <button
                  onClick={handleResetNorth}
                  className={`w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${t.pillBtn}`}
                  title="אפס כיוון לצפון"
                >
                  <Compass
                    className="w-4 h-4 text-rose-500 transition-transform"
                    style={{ transform: `rotate(${-mapBearing}deg)` }}
                  />
                </button>

                <button
                  onClick={() => setShowCenterCrosshair(!showCenterCrosshair)}
                  className={`w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${
                    showCenterCrosshair ? 'bg-amber-600 border-amber-400 text-white' : t.pillBtn
                  }`}
                  title="צלב נ.צ. מרכז מפה"
                >
                  <Crosshair className="w-4 h-4" />
                </button>

                <div className={`flex flex-col rounded-xl border shadow-lg overflow-hidden ${t.pillBtn}`}>
                  <button
                    onClick={() => mapRef.current?.zoomIn()}
                    className="w-10 h-9 flex items-center justify-center text-base font-bold hover:bg-black/10 transition-colors"
                    title="התקרב"
                  >
                    +
                  </button>
                  <div className="h-px bg-current opacity-15" />
                  <button
                    onClick={() => mapRef.current?.zoomOut()}
                    className="w-10 h-9 flex items-center justify-center text-base font-bold hover:bg-black/10 transition-colors"
                    title="התרחק"
                  >
                    −
                  </button>
                </div>

                <button
                  onClick={handleLocateMe}
                  className={`w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${t.pillBtn}`}
                  title="המיקום שלי (GPS)"
                >
                  <LocateFixed className="w-4 h-4 text-sky-500" />
                </button>
              </div>
            </div>

            {/* Bottom-Center Click-to-Copy Tactical HUD Pill */}
            <button
              onClick={() => handleCopyGrid(milCoords.idfGrid8Digit)}
              title="לחץ להעתקת נ.צ."
              className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-20 px-4 py-2 rounded-full border text-xs font-mono flex items-center gap-3 pointer-events-auto transition-colors ${t.panel}`}
            >
              <span className="text-emerald-500 font-bold">
                גובה: {cursorCoords.ele !== null ? `${cursorCoords.ele}m` : '---'}
              </span>
              <span className="opacity-30">|</span>
              <span className="text-amber-500 font-bold">
                נ.צ. <span dir="ltr">{milCoords.idfGrid8Digit}</span>
              </span>
              <span className="opacity-30 hidden lg:inline">|</span>
              <span className={`hidden lg:inline ${t.muted}`}>
                ITM: <span dir="ltr">{milCoords.itmFormatted}</span>
              </span>
              <span className="opacity-30 hidden xl:inline">|</span>
              <span className={`hidden xl:inline ${t.muted}`}>
                UTM: <span dir="ltr">{milCoords.utmFormatted}</span>
              </span>
              <span className="opacity-30">|</span>
              <span className={t.muted} dir="ltr">
                z{cursorCoords.zoom}
              </span>
            </button>

            {/* Layer Switcher Floating Popover */}
            <LayerSwitcherSheet
              isOpen={isLayerSheetOpen}
              onClose={() => setIsLayerSheetOpen(false)}
              visibility={visibility}
              onChangeVisibility={setVisibility}
              theme={theme}
              onSelectTheme={setTheme}
              onToggle3D={handleToggle3D}
            />
          </>
        )}

        {/* ================= MOBILE CHROME (PLANNING vs NAVIGATING) ================= */}
        {isMobile && (
          <>
            {/* MODE A: PLANNING — Search Pill at Top */}
            {mobileDisplayMode === 'planning' && (
              <div className="absolute top-3 right-3 left-3 z-30 pt-safe pointer-events-none">
                <div className="pointer-events-auto">{renderSearchBar(true)}</div>
              </div>
            )}

            {/* MODE B: NAVIGATING — No Search, No Chips! Slim Top Navigation/Status Pill + Planning Toggle */}
            {mobileDisplayMode === 'navigating' && (
              <div className="absolute top-3 right-3 left-3 z-30 pt-safe pointer-events-auto">
                {isNavigatingRoute && activeRoute ? (
                  <div
                    className={`p-2.5 rounded-2xl shadow-2xl flex items-center justify-between gap-2 text-xs font-bold backdrop-blur-md ${
                      offRouteWarning !== null
                        ? 'bg-red-600/95 text-white animate-pulse'
                        : 'bg-emerald-600/95 text-white'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {offRouteWarning !== null ? (
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                      ) : (
                        <Navigation className="w-4 h-4 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="truncate">
                          {offRouteWarning !== null
                            ? `סטייה מציר • ${offRouteWarning} מטרים`
                            : activeRoute.name}
                        </div>
                        <div className="font-normal opacity-90 truncate">
                          {offRouteWarning !== null
                            ? 'חזור לכיוון הציר המתוכנן'
                            : `נותרו ${remainingDistKm ?? activeRoute.distanceKm} ק״מ • במעקב GPS`}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setMobileDisplayMode('planning');
                        setMobileTab('routes');
                        setMobileNavOverlay(null);
                      }}
                      className="px-2.5 py-1.5 rounded-xl bg-slate-950/35 text-white text-xs font-bold shrink-0"
                    >
                      תכנון
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className={`px-3 py-1.5 rounded-full border shadow-lg text-xs font-bold flex items-center gap-2 ${t.panel}`}
                    >
                      <span
                        className={`w-2.5 h-2.5 rounded-full ${
                          isRecordingTrack && !isRecordingPaused
                            ? 'bg-rose-500 animate-pulse'
                            : 'bg-emerald-500'
                        }`}
                      />
                      <span className="tabular-nums">
                        {isRecordingTrack
                          ? `מקליט ${formatDuration(recordElapsedSeconds)}`
                          : 'מצב ניווט • GPS'}
                      </span>
                    </div>

                    <button
                      onClick={() => {
                        setMobileDisplayMode('planning');
                        setMobileNavOverlay(null);
                      }}
                      className={`px-3 py-1.5 rounded-full border shadow-lg text-xs font-bold flex items-center gap-1.5 ${t.panel}`}
                    >
                      <MapIcon className="w-3.5 h-3.5 text-emerald-500" />
                      <span>תכנון וחיפוש</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Mobile Left-Edge Floating Controls (Layers, 3D, Compass, Crosshair) */}
            <div
              className={`absolute left-3 z-20 flex flex-col gap-2 pointer-events-auto pt-safe ${
                mobileDisplayMode === 'navigating' ? 'top-20' : 'top-[4.5rem]'
              }`}
            >
              <button
                onClick={() => {
                  if (mobileDisplayMode === 'navigating') {
                    setMobileNavOverlay(mobileNavOverlay === 'layers' ? null : 'layers');
                  } else {
                    setMobilePlanningOverlay(mobilePlanningOverlay === 'layers' ? null : 'layers');
                  }
                }}
                className={`w-10 h-10 rounded-full border shadow-lg flex items-center justify-center transition-all ${
                  (mobileDisplayMode === 'navigating'
                    ? mobileNavOverlay === 'layers'
                    : mobilePlanningOverlay === 'layers')
                    ? 'bg-emerald-600 border-emerald-400 text-white'
                    : t.pillBtn
                }`}
                title="שכבות מפה"
              >
                <Layers className="w-4 h-4" />
              </button>

              <button
                onClick={handleToggle3D}
                className={`w-10 h-10 rounded-full border shadow-lg text-xs font-bold flex items-center justify-center transition-all ${
                  visibility.terrain3d ? 'bg-emerald-600 border-emerald-400 text-white' : t.pillBtn
                }`}
              >
                3D
              </button>

              {Math.abs(mapBearing) > 2 && (
                <button
                  onClick={handleResetNorth}
                  className={`w-10 h-10 rounded-full border shadow-lg flex items-center justify-center transition-all ${t.pillBtn}`}
                  title="צפון"
                >
                  <Compass
                    className="w-4 h-4 text-rose-500"
                    style={{ transform: `rotate(${-mapBearing}deg)` }}
                  />
                </button>
              )}

              <button
                onClick={() => setShowCenterCrosshair(!showCenterCrosshair)}
                className={`w-10 h-10 rounded-full border shadow-lg flex items-center justify-center transition-all ${
                  showCenterCrosshair ? 'bg-amber-600 border-amber-400 text-white' : t.pillBtn
                }`}
                title="כוונת נ.צ."
              >
                <Crosshair className="w-4 h-4" />
              </button>
            </div>

            {/* Mobile Bottom-Left Thumb FABs (Add Pin + Locate GPS) */}
            <div className="absolute bottom-3 left-3 z-20 flex flex-col gap-2 pointer-events-auto">
              <button
                onClick={() => {
                  if (mobileDisplayMode === 'navigating') {
                    setMobileNavOverlay(mobileNavOverlay === 'add-poi' ? null : 'add-poi');
                  } else {
                    setMobilePlanningOverlay(mobilePlanningOverlay === 'add-poi' ? null : 'add-poi');
                  }
                }}
                className={`w-11 h-11 rounded-full border shadow-xl flex items-center justify-center transition-all ${
                  isAddingPoiMode ? 'bg-sky-600 border-sky-400 text-white' : t.pillBtn
                }`}
                title="דווח נקודת שטח"
              >
                <Plus className="w-5 h-5 text-sky-500" />
              </button>

              <button
                onClick={handleLocateMe}
                className="w-12 h-12 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white shadow-xl flex items-center justify-center transition-all"
                title="מיקום שלי (GPS)"
              >
                <LocateFixed className="w-5 h-5" />
              </button>
            </div>

            {/* Mobile Planning Mode Compact HUD Pill (Hidden in Navigating mode since telemetry bar already shows it!) */}
            {mobileDisplayMode === 'planning' && (
              <button
                onClick={() => handleCopyGrid(milCoords.idfGrid8Digit)}
                className={`absolute bottom-3 right-3 z-20 px-3 py-1.5 rounded-full border shadow-lg text-xs font-mono pointer-events-auto ${t.panel}`}
              >
                <span className="text-emerald-500 font-bold">
                  {cursorCoords.ele !== null ? `${cursorCoords.ele}m` : '---'}
                </span>{' '}
                •{' '}
                <span className="text-amber-500 font-bold">
                  נ.צ. <span dir="ltr">{milCoords.idfGrid8Digit}</span>
                </span>
              </button>
            )}
          </>
        )}
      </div>

      {/* ================= MOBILE BOTTOM AREA ================= */}
      {isMobile && mobileDisplayMode === 'planning' && (
        <>
          {/* Planning Expandable Bottom Sheet */}
          <div className={`relative z-30 rounded-t-3xl border-t shadow-2xl shrink-0 ${t.panel}`}>
            <div
              onClick={() => setMobileSheetExpanded(!mobileSheetExpanded)}
              className="w-full pt-2 pb-1 flex justify-center cursor-pointer"
            >
              <div className="w-10 h-1 rounded-full bg-slate-400/50" />
            </div>

            {mobilePlanningOverlay === 'poi' && selectedPoi ? (
              <div className="max-h-[60vh] overflow-y-auto">
                <PoiInspectorSheet
                  poi={selectedPoi}
                  theme={theme}
                  referenceCoord={referenceCoord}
                  embedded
                  isExpanded={mobileSheetExpanded}
                  onToggleExpand={() => setMobileSheetExpanded(!mobileSheetExpanded)}
                  onClose={() => {
                    setSelectedPoi(null);
                    setMobilePlanningOverlay(null);
                  }}
                  onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 14.2)}
                  onNavigateToPoi={handleNavigateToPoi}
                  onPoiUpdated={(updated) => {
                    setSelectedPoi(updated);
                    setPois((prev) =>
                      prev.some((p) => p.id === updated.id)
                        ? prev.map((p) => (p.id === updated.id ? updated : p))
                        : [...prev, updated]
                    );
                  }}
                  onNotify={showToast}
                />
              </div>
            ) : mobilePlanningOverlay === 'layers' ? (
              <LayerSwitcherSheet
                isOpen
                embedded
                onClose={() => setMobilePlanningOverlay(null)}
                visibility={visibility}
                onChangeVisibility={setVisibility}
                theme={theme}
                onSelectTheme={setTheme}
                onToggle3D={handleToggle3D}
              />
            ) : mobilePlanningOverlay === 'add-poi' ? (
              <div className="max-h-[60vh] overflow-y-auto">
                <AddPoiPanel
                  theme={theme}
                  centerCoords={cursorCoords}
                  onClose={() => setMobilePlanningOverlay(null)}
                  onCreated={(created) => {
                    setPois((prev) => [...prev, created]);
                    setSelectedPoi(created);
                    setMobilePlanningOverlay('poi');
                    showToast(`הנקודה "${created.nameHe}" נשמרה במפה!`);
                  }}
                />
              </div>
            ) : mobilePlanningOverlay === 'plan-route' ? (
              mobileSheetExpanded ? (
                <div className="max-h-[56vh] overflow-y-auto">
                  <RoutePlannerPanel
                    theme={theme}
                    mode={planningMode}
                    routeName={planRouteName}
                    waypoints={planWaypoints}
                    legs={planLegs}
                    totalDistanceKm={planTotalDistanceKm}
                    ascentMeters={planElevStats.ascent}
                    descentMeters={planElevStats.descent}
                    isRoutingLeg={isRoutingLeg}
                    isSaving={isSavingPlan}
                    disconnectedCandidate={disconnectedCandidate}
                    currentUser={currentUser}
                    firebaseAvailable={AuthService.isAvailable()}
                    isAuthBusy={isAuthBusy}
                    pendingCloudSyncCount={pendingCloudSyncCount}
                    onChangeMode={handleChangePlanningMode}
                    onChangeRouteName={setPlanRouteName}
                    onConfirmStraightLine={handleConfirmStraightLine}
                    onCancelDisconnected={handleCancelDisconnected}
                    onUndoLastPoint={handleUndoLastPlanPoint}
                    onClearPlan={handleClearPlan}
                    onFinishAndSave={handleFinishPlanningRoute}
                    onSignInGoogle={handleSignInGoogle}
                    onSignOutGoogle={handleSignOutGoogle}
                    onSyncPendingNow={handleSyncPendingNow}
                    onClose={() => setMobilePlanningOverlay(null)}
                  />
                </div>
              ) : (
                <div className="px-4 pb-3 flex items-center justify-between gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setMobileSheetExpanded(true)}
                    className="flex items-center gap-2 min-w-0 font-bold"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: PLANNING_MODE_META[planningMode].color }}
                    />
                    <span className="truncate">
                      {PLANNING_MODE_META[planningMode].shortLabelHe} • {planTotalDistanceKm.toFixed(2)} km ({planWaypoints.length})
                    </span>
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      disabled={planWaypoints.length === 0 || isRoutingLeg}
                      onClick={handleUndoLastPlanPoint}
                      className={`p-2 rounded-xl border disabled:opacity-40 ${t.pillBtn}`}
                      title="חזור"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={planWaypoints.length < 2 || isRoutingLeg || isSavingPlan}
                      onClick={handleFinishPlanningRoute}
                      className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold flex items-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>שמור</span>
                    </button>
                  </div>
                </div>
              )
            ) : mobileTab === 'routes' ? (
              <div className="max-h-[60vh] overflow-y-auto">
                <ElevationProfileDrawer
                  route={activeRoute}
                  routes={routes}
                  pois={pois}
                  theme={theme}
                  embedded
                  isNavigating={isNavigatingRoute}
                  onSelectRoute={handleSelectRoute}
                  onStartNavigation={handleStartRouteNavigation}
                  onStopNavigation={handleStopRouteNavigation}
                  onOpenImporter={() => {
                    setMobileTab('offline');
                    setMobilePlanningOverlay(null);
                  }}
                  onOpenRoutePlanner={() => {
                    setMobileDisplayMode('planning');
                    setMobilePlanningOverlay('plan-route');
                    setMobileSheetExpanded(true);
                  }}
                  onDeleteRoute={handleDeleteRoute}
                  onClose={() => setMobileTab('explore')}
                  onHoverPoint={handleHoverElevationChart}
                  onSelectPoint={(pt) =>
                    handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                  }
                  onFlyToRoute={handleFlyToRoute}
                  onFitAllRoutes={() => fitBoundsToRoutes(routes)}
                />
              </div>
            ) : mobileTab === 'record' ? (
              <div className="max-h-[60vh] overflow-y-auto">
                <TrackRecorderPanel
                  theme={theme}
                  isRecording={isRecordingTrack}
                  isPaused={isRecordingPaused}
                  elapsedSeconds={recordElapsedSeconds}
                  distanceKm={recordedDistanceKm}
                  ascentMeters={recordedAscentMeters}
                  currentElevation={cursorCoords.ele}
                  pointsCount={recordedCoords.length}
                  onStartOrResume={handleStartOrResumeRecording}
                  onPause={() => setIsRecordingPaused(true)}
                  onSaveRoute={handleSaveRecordedTrack}
                  onDiscard={handleDiscardRecordedTrack}
                  onDropWaypoint={() => setMobilePlanningOverlay('add-poi')}
                  onClose={() => setMobileTab('explore')}
                />
              </div>
            ) : mobileTab === 'offline' ? (
              <MapStorageModal
                isOpen
                embedded
                theme={theme}
                onClose={() => setMobileTab('explore')}
                demInfo={demInfo}
                osmInfo={osmInfo}
                onArchivesUpdated={(nextDem, nextOsm) => {
                  setDemInfo(nextDem);
                  setOsmInfo(nextOsm);
                }}
                onPoisAndRoutesImported={handleImportedData}
              />
            ) : (
              /* Explore Peek Sheet: Quick Nearby POIs + 1-Tap Route Planner & Navigating Mode */
              <div className="px-4 pb-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setMobileSheetExpanded(!mobileSheetExpanded)}
                    className="text-xs font-bold flex items-center gap-1"
                  >
                    <span>בקרבתך ({nearbyPois.length})</span>
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => {
                        setMobileDisplayMode('planning');
                        setMobilePlanningOverlay('plan-route');
                        setMobileSheetExpanded(true);
                      }}
                      className="px-2.5 py-1 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1 shadow-sm"
                    >
                      <PenTool className="w-3 h-3" />
                      <span>תכנון</span>
                    </button>
                    <button
                      onClick={() => {
                        setMobileDisplayMode('navigating');
                        setMobileNavOverlay(null);
                      }}
                      className="px-2.5 py-1 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1 shadow-sm"
                    >
                      <Navigation className="w-3 h-3" />
                      <span>ניווט</span>
                    </button>
                  </div>
                </div>

                {mobileSheetExpanded &&
                  (nearbyPois.length > 0 ? (
                    <div className="flex gap-2 overflow-x-auto no-scrollbar pb-0.5">
                      {nearbyPois.map(({ poi, distKm }) => {
                        const meta = POI_CATEGORY_META[poi.category] || POI_CATEGORY_META.heritage;
                        return (
                          <button
                            key={poi.id}
                            onClick={() => handleSelectPoi(poi)}
                            className={`shrink-0 w-44 text-right p-2.5 rounded-2xl border hover:border-emerald-500 transition-all space-y-1 ${t.subCard}`}
                          >
                            <div className="flex items-center justify-between text-xs">
                              <span>{meta.emoji}</span>
                              <span className={`font-mono ${t.muted}`}>{distKm.toFixed(1)} ק״מ</span>
                            </div>
                            <div className="text-xs font-bold truncate" dir="auto">
                              {poi.nameHe}
                            </div>
                            <div className={`text-xs font-mono ${t.muted}`}>
                              גובה {poi.ele !== null ? `${poi.ele}m` : '---'}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className={`text-xs py-2 ${t.muted}`}>טוען נקודות עניין באזור...</div>
                  ))}
              </div>
            )}
          </div>

          {/* Mobile Bottom 4-Tab Menu Bar (ONLY in Planning Mode!) */}
          <nav
            className={`h-16 border-t px-2 flex items-center justify-around shrink-0 z-40 pb-safe ${t.navBar}`}
          >
            {[
              { id: 'explore' as const, label: 'מפה', icon: <MapIcon className="w-5 h-5" /> },
              { id: 'routes' as const, label: 'מסלולים', icon: <RouteIcon className="w-5 h-5" /> },
              {
                id: 'record' as const,
                label: 'הקלטה',
                icon: (
                  <span className="relative flex items-center justify-center w-5 h-5">
                    <span
                      className={`w-3.5 h-3.5 rounded-full border-2 border-current flex items-center justify-center ${
                        isRecordingTrack ? 'text-rose-500' : ''
                      }`}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                    </span>
                  </span>
                ),
              },
              { id: 'offline' as const, label: 'אופליין', icon: <HardDrive className="w-5 h-5" /> },
            ].map((tab) => {
              const active = mobileTab === tab.id && !mobilePlanningOverlay;
              return (
                <button
                  key={tab.id}
                  onClick={() => {
                    setMobileTab(tab.id);
                    setMobilePlanningOverlay(null);
                  }}
                  className={`flex-1 h-full flex flex-col items-center justify-center gap-0.5 text-xs font-bold transition-colors ${
                    active ? 'text-emerald-500' : ''
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </>
      )}

      {/* MODE B: NAVIGATING BOTTOM BAR (No bottom 4-tab menu! Just slim telemetry or temporary overlay) */}
      {isMobile && mobileDisplayMode === 'navigating' && (
        <div className={`relative z-30 border-t shadow-2xl shrink-0 pb-safe ${t.panel}`}>
          {mobileNavOverlay === 'layers' ? (
            <LayerSwitcherSheet
              isOpen
              embedded
              onClose={() => setMobileNavOverlay(null)}
              visibility={visibility}
              onChangeVisibility={setVisibility}
              theme={theme}
              onSelectTheme={setTheme}
              onToggle3D={handleToggle3D}
            />
          ) : mobileNavOverlay === 'add-poi' ? (
            <div className="max-h-[58vh] overflow-y-auto">
              <AddPoiPanel
                theme={theme}
                centerCoords={cursorCoords}
                onClose={() => setMobileNavOverlay(null)}
                onCreated={(created) => {
                  setPois((prev) => [...prev, created]);
                  setSelectedPoi(created);
                  setMobileNavOverlay('poi-mini');
                  showToast(`הנקודה "${created.nameHe}" נשמרה במפה!`);
                }}
              />
            </div>
          ) : mobileNavOverlay === 'poi-mini' && selectedPoi ? (
            <PoiInspectorSheet
              poi={selectedPoi}
              theme={theme}
              referenceCoord={referenceCoord}
              compactNavigating
              onClose={() => setMobileNavOverlay(null)}
              onOpenFullPlanning={() => {
                setMobileNavOverlay(null);
                setMobileDisplayMode('planning');
                setMobileTab('explore');
                setMobilePlanningOverlay('poi');
                setMobileSheetExpanded(true);
              }}
              onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 14.2)}
              onPoiUpdated={(updated) => {
                setSelectedPoi(updated);
                setPois((prev) =>
                  prev.some((p) => p.id === updated.id)
                    ? prev.map((p) => (p.id === updated.id ? updated : p))
                    : [...prev, updated]
                );
              }}
              onNotify={showToast}
            />
          ) : (
            /* Slim Single-Row Navigation Telemetry Strip */
            <div className="px-3.5 py-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 text-xs font-mono">
                <div>
                  <span className={`block font-sans ${t.muted}`}>גובה</span>
                  <span className="font-bold text-emerald-500 text-sm">
                    {cursorCoords.ele !== null ? `${cursorCoords.ele}m` : '---'}
                  </span>
                </div>
                <div className="h-6 w-px bg-current opacity-15" />
                <div>
                  <span className={`block font-sans ${t.muted}`}>
                    {isNavigatingRoute ? 'נותר' : 'הוקלט'}
                  </span>
                  <span className="font-bold text-sm">
                    {isNavigatingRoute
                      ? `${remainingDistKm ?? activeRoute?.distanceKm ?? 0} km`
                      : `${recordedDistanceKm.toFixed(1)} km`}
                  </span>
                </div>
                <div className="h-6 w-px bg-current opacity-15" />
                <div>
                  <span className={`block font-sans ${t.muted}`}>נ.צ.</span>
                  <button
                    onClick={() => handleCopyGrid(milCoords.idfGrid8Digit)}
                    dir="ltr"
                    className="font-bold text-amber-500"
                  >
                    {milCoords.idfGrid8Digit}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => {
                    if (!isRecordingTrack || isRecordingPaused) {
                      handleStartOrResumeRecording();
                    } else {
                      setIsRecordingPaused(true);
                    }
                  }}
                  className={`px-2.5 py-1.5 rounded-xl border text-xs font-bold flex items-center gap-1 ${t.pillBtn}`}
                  title={isRecordingTrack && !isRecordingPaused ? 'השהה הקלטה' : 'התחל הקלטה'}
                >
                  {isRecordingTrack && !isRecordingPaused ? (
                    <Pause className="w-3.5 h-3.5 text-rose-500" />
                  ) : (
                    <Play className="w-3.5 h-3.5 text-emerald-500" />
                  )}
                </button>

                <button
                  onClick={() => {
                    if (isNavigatingRoute) {
                      handleStopRouteNavigation();
                    } else {
                      setMobileDisplayMode('planning');
                    }
                  }}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold text-white ${
                    isNavigatingRoute ? 'bg-red-600 hover:bg-red-500' : 'bg-emerald-600 hover:bg-emerald-500'
                  }`}
                >
                  {isNavigatingRoute ? 'סיום' : 'תכנון'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Desktop Modal: Offline Maps Manager & KML/GPX Importer */}
      <MapStorageModal
        isOpen={!isMobile && isStorageOpen}
        onClose={() => setIsStorageOpen(false)}
        theme={theme}
        demInfo={demInfo}
        osmInfo={osmInfo}
        onArchivesUpdated={(nextDem, nextOsm) => {
          setDemInfo(nextDem);
          setOsmInfo(nextOsm);
        }}
        onPoisAndRoutesImported={handleImportedData}
      />
    </div>
  );
};

export default App;
