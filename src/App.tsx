import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import {
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
  Satellite,
  Sun,
  Moon,
  PenTool,
  Undo2,
  Check,
} from 'lucide-react';
import { pmtilesRegistry, type MountedArchiveInfo } from './core/pmtiles/PMTilesRegistry';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  buildPoiLayerFilter,
  isMasterPoiActive,
  DEFAULT_LAYER_VISIBILITY,
  type OutdoorLayerVisibility,
} from './core/style/israelOutdoorStyle';
import { PoiManager, getPoiSortPriority } from './core/pois/PoiManager';
import { RouteManager, resolveRouteDisplayColor } from './core/navigation/RouteManager';
import {
  resolveMapRouteDisplay,
  type RouteDisplayContext,
} from './core/navigation/RouteDisplayPolicy';
import { carSyncService } from './core/car/CarSyncService';
import { LiveGpsService, type LiveGpsFix } from './core/navigation/LiveGpsService';
import { ScreenWakeLockService } from './core/navigation/ScreenWakeLockService';
import {
  NavigationHeadingService,
  extractRouteTangentHeading,
  shortestAngleDeltaDeg,
  smoothHeadingDeg,
  type MapNavigationOrientation,
} from './core/navigation/NavigationHeadingService';
import {
  GpsNavigationSmoother,
  type SmoothedNavigationFrame,
} from './core/navigation/GpsNavigationSmoother';
import {
  UserLocationIconService,
  type UserLocationIconPreference,
} from './core/navigation/UserLocationIconService';
import { ElevationService } from './core/navigation/ElevationService';
import { MilitaryGridService } from './core/navigation/MilitaryGridService';
import {
  pmtilesSearchService,
  type SearchResultItem,
  type SearchIndexStatus,
} from './core/search/PMTilesSearchService';
import type { SearchFilterCategory } from './core/search/searchTaxonomy';
import {
  db,
  type PoiRecord,
  type RouteShareRecipient,
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
import {
  PlannedTracksCloudService,
  getDeletedPlannedRouteIds,
  markPlannedRouteDeleted,
  markSharedRouteDismissed,
} from './core/firebase/PlannedTracksCloudService';
import { UserDirectoryService } from './core/firebase/UserDirectoryService';
import { PoiInspectorSheet } from './components/pois/PoiInspectorSheet';
import { AddPoiPanel } from './components/pois/AddPoiPanel';
import { MapStorageModal } from './components/maps-manager/MapStorageModal';
import { ElevationProfileDrawer } from './components/navigation/ElevationProfileDrawer';
import { ShareRouteModal } from './components/navigation/ShareRouteModal';
import { TrackRecorderPanel, formatDuration } from './components/navigation/TrackRecorderPanel';
import {
  RoutePlannerPanel,
  type PlannedLeg,
} from './components/navigation/RoutePlannerPanel';
import { LayerSwitcherSheet } from './components/map/LayerSwitcherSheet';
import {
  UserIconPickerSheet,
  UserLocationIconBadge,
} from './components/map/UserIconPickerSheet';
import { SearchBar } from './components/search/SearchBar';
import { GoogleAccountButton } from './components/auth/GoogleAccountButton';
import {
  UserStateSyncService,
  type MergeUserStateResult,
  type SavedMapCamera,
  type SavedUserConfiguration,
} from './core/preferences/UserStateSyncService';
import { getSurfaceTheme, POI_CATEGORY_META, type MapTheme } from './components/ui/themeTokens';

type DesktopDrawerMode = 'poi' | 'routes' | 'record' | 'add-poi' | 'plan-route' | null;
type MobileTab = 'explore' | 'routes' | 'record' | 'offline';
type MobileDisplayMode = 'planning' | 'navigating';
type MobileOverlayMode = 'poi' | 'layers' | 'add-poi' | 'plan-route' | 'user-icon' | null;
type MobileNavOverlay = 'poi-mini' | 'layers' | 'add-poi' | 'user-icon' | null;

const LAST_AUTH_UID_STORAGE_KEY = 'navapp.lastAuthUid.v1';

function readStoredLastAuthUid(): string | null {
  try {
    return window.localStorage.getItem(LAST_AUTH_UID_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLastAuthUid(uid: string | null): void {
  try {
    if (uid) {
      window.localStorage.setItem(LAST_AUTH_UID_STORAGE_KEY, uid);
    }
  } catch {
    // Ignore storage errors
  }
}

interface PlanOverlayState {
  active: boolean;
  mode: PlanningMode;
  waypoints: PlannedWaypoint[];
  legs: PlannedLeg[];
  previewPoint: SnappedPoint | null;
  cursorCoord: [number, number] | null;
  disconnectedCandidate: SnappedPoint | null;
  editingRouteId?: string | null;
  activeColor?: string;
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

function createUserMarkerElement(
  pref: UserLocationIconPreference,
  heading: number | null,
  mapBearing = 0,
  isNavigationActive = false
): HTMLDivElement {
  const root = document.createElement('div');
  UserLocationIconService.renderMarkerElement(root, pref, heading, mapBearing, isNavigationActive);
  return root;
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

  // Hydrate persisted last camera position & configuration synchronously before MapLibre initializes
  const initialSavedStateRef = useRef<ReturnType<typeof UserStateSyncService.getStartupState> | null>(
    null
  );
  if (!initialSavedStateRef.current) {
    initialSavedStateRef.current = UserStateSyncService.getStartupState();
  }
  const initialCamera = initialSavedStateRef.current.camera;
  const initialConfig = initialSavedStateRef.current.config;

  // Core map & archive state
  const [isMapReady, setIsMapReady] = useState(false);
  const [demInfo, setDemInfo] = useState<MountedArchiveInfo | null>(null);
  const [osmInfo, setOsmInfo] = useState<MountedArchiveInfo | null>(null);
  const [visibility, setVisibility] = useState<OutdoorLayerVisibility>(
    () => initialConfig.visibility
  );
  const [theme, setTheme] = useState<MapTheme>(() => initialConfig.theme);
  const [mapBearing, setMapBearing] = useState(() => initialCamera.bearing);

  // POIs & Search
  const [pois, setPois] = useState<PoiRecord[]>([]);
  const [selectedPoi, setSelectedPoi] = useState<PoiRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilter, setSearchFilter] = useState<SearchFilterCategory>('all');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [executedSearchQuery, setExecutedSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<SearchIndexStatus>(() =>
    pmtilesSearchService.getStatus()
  );
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  // Routes & Active Navigation
  const [routes, setRoutes] = useState<SavedRouteRecord[]>([]);
  const [activeRoute, setActiveRoute] = useState<SavedRouteRecord | null>(null);
  const [shareModalRouteId, setShareModalRouteId] = useState<string | null>(null);
  const [unseenSharedCount, setUnseenSharedCount] = useState(0);
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

  // Connectivity, Crosshair & Continuous Live GPS Coordinates
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [showCenterCrosshair, setShowCenterCrosshair] = useState<boolean>(
    () => initialConfig.showCenterCrosshair
  );
  const [userLocation, setUserLocation] = useState<LiveGpsFix | null>(null);
  const [isFollowingUser, setIsFollowingUser] = useState<boolean>(false);
  const [gpsWatchRestartSeq, setGpsWatchRestartSeq] = useState<number>(0);
  const [isScreenWakeLockActive, setIsScreenWakeLockActive] = useState<boolean>(false);
  const [isFreeNavigation, setIsFreeNavigation] = useState<boolean>(false);
  const [navOrientation, setNavOrientation] = useState<MapNavigationOrientation>(
    () => initialConfig.navOrientation
  );
  const [liveHeading, setLiveHeading] = useState<number | null>(null);
  const [userIconPref, setUserIconPref] = useState<UserLocationIconPreference>(
    () => initialConfig.userIcon
  );
  const [isUserIconPickerOpen, setIsUserIconPickerOpen] = useState<boolean>(false);
  const [cursorCoords, setCursorCoords] = useState<{
    lon: number;
    lat: number;
    ele: number | null;
    zoom: number;
  }>(() => ({
    lon: Number(initialCamera.lon.toFixed(4)),
    lat: Number(initialCamera.lat.toFixed(4)),
    ele: 390,
    zoom: Number(initialCamera.zoom.toFixed(1)),
  }));

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
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | undefined>(
    () => initialSavedStateRef.current?.rawState.lastSyncedAt
  );
  const [planningMode, setPlanningMode] = useState<PlanningMode>(() => initialConfig.planningMode);
  const [planRouteName, setPlanRouteName] = useState('');
  const [planWaypoints, setPlanWaypoints] = useState<PlannedWaypoint[]>([]);
  const [planLegs, setPlanLegs] = useState<PlannedLeg[]>([]);
  const [planPreviewPoint, setPlanPreviewPoint] = useState<SnappedPoint | null>(null);
  const [planCursorCoord, setPlanCursorCoord] = useState<[number, number] | null>(null);
  const [disconnectedCandidate, setDisconnectedCandidate] = useState<SnappedPoint | null>(null);
  const [isRoutingLeg, setIsRoutingLeg] = useState(false);
  const [isSavingPlan, setIsSavingPlan] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [pinnedBackgroundRouteIds, setPinnedBackgroundRouteIds] = useState<string[]>([]);
  const [showBackgroundInPlanner, setShowBackgroundInPlanner] = useState<boolean>(true);
  const [bgHydrationSeq, setBgHydrationSeq] = useState<number>(0);
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

  const isRoutesUiOpen =
    (!isMobile && desktopDrawer === 'routes') ||
    (isMobile &&
      mobileDisplayMode === 'planning' &&
      !mobilePlanningOverlay &&
      mobileTab === 'routes');

  const routeDisplayContext = useMemo<RouteDisplayContext>(
    () => ({
      isPlanning: isPlanningRouteMode,
      isEditing: isPlanningRouteMode && Boolean(editingRouteId),
      isSelecting: isRoutesUiOpen,
      isNavigating: isNavigatingRoute && Boolean(activeRoute),
      editingRouteId,
      pinnedBackgroundIds: pinnedBackgroundRouteIds,
      showBackgroundWhilePlanning: showBackgroundInPlanner,
    }),
    [
      isPlanningRouteMode,
      editingRouteId,
      isRoutesUiOpen,
      isNavigatingRoute,
      activeRoute,
      pinnedBackgroundRouteIds,
      showBackgroundInPlanner,
    ]
  );

  const resolvedRouteDisplay = useMemo(
    () => resolveMapRouteDisplay(routes, activeRoute, routeDisplayContext),
    [routes, activeRoute, routeDisplayContext]
  );

  const routeDisplayContextRef = useRef<RouteDisplayContext>(routeDisplayContext);
  routeDisplayContextRef.current = routeDisplayContext;

  const editingRouteColor = useMemo(() => {
    if (!editingRouteId) return undefined;
    const match = routes.find((r) => r.id === editingRouteId);
    return match ? resolveRouteDisplayColor(match) : undefined;
  }, [editingRouteId, routes]);

  const planOverlayState = useMemo<PlanOverlayState>(
    () => ({
      active: isPlanningRouteMode,
      mode: planningMode,
      waypoints: planWaypoints,
      legs: planLegs,
      previewPoint: planPreviewPoint,
      cursorCoord: planCursorCoord,
      disconnectedCandidate,
      editingRouteId,
      activeColor: editingRouteColor,
    }),
    [
      isPlanningRouteMode,
      planningMode,
      planWaypoints,
      planLegs,
      planPreviewPoint,
      planCursorCoord,
      disconnectedCandidate,
      editingRouteId,
      editingRouteColor,
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
  const planElevSeqRef = useRef<number>(0);
  const selectRouteSeqRef = useRef<number>(0);
  const editingRouteIdRef = useRef<string | null>(editingRouteId);
  editingRouteIdRef.current = editingRouteId;
  const activeRoutePromiseRef = useRef<Promise<void> | null>(null);
  const lastPoiSyncRef = useRef<PoiRecord[] | null>(null);
  const deletedRouteIdsRef = useRef<Set<string>>(null as any);
  if (!deletedRouteIdsRef.current) {
    deletedRouteIdsRef.current = getDeletedPlannedRouteIds();
  }
  const handlePlanMapClickRef = useRef<(lon: number, lat: number) => Promise<void>>(async () => {});
  const handleFinishPlanningRef = useRef<() => Promise<void>>(async () => {});
  const isStyleLoadedRef = useRef<boolean>(false);
  const mobileDisplayModeRef = useRef<MobileDisplayMode>(mobileDisplayMode);
  mobileDisplayModeRef.current = mobileDisplayMode;
  const isMobileRef = useRef<boolean>(isMobile);
  isMobileRef.current = isMobile;
  const isFollowingUserRef = useRef<boolean>(isFollowingUser);
  isFollowingUserRef.current = isFollowingUser;
  const pendingLocateFlyRef = useRef<boolean>(false);
  const isNavigatingRouteRef = useRef<boolean>(isNavigatingRoute);
  isNavigatingRouteRef.current = isNavigatingRoute;
  const isRecordingTrackRef = useRef<boolean>(isRecordingTrack);
  isRecordingTrackRef.current = isRecordingTrack;
  const isRecordingPausedRef = useRef<boolean>(isRecordingPaused);
  isRecordingPausedRef.current = isRecordingPaused;
  const userLocationRef = useRef<LiveGpsFix | null>(userLocation);
  userLocationRef.current = userLocation;
  const userIconPrefRef = useRef<UserLocationIconPreference>(userIconPref);
  userIconPrefRef.current = userIconPref;
  const navOrientationRef = useRef<MapNavigationOrientation>(navOrientation);
  navOrientationRef.current = navOrientation;
  const liveHeadingRef = useRef<number | null>(liveHeading);
  liveHeadingRef.current = liveHeading;
  const isNavigationActive =
    isNavigatingRoute || isFreeNavigation || (isMobile && mobileDisplayMode === 'navigating');
  const isNavigationActiveRef = useRef<boolean>(isNavigationActive);
  isNavigationActiveRef.current = isNavigationActive;
  const navSmootherRef = useRef<GpsNavigationSmoother | null>(null);
  if (!navSmootherRef.current) {
    navSmootherRef.current = new GpsNavigationSmoother();
  }
  const smoothRafIdRef = useRef<number | null>(null);
  const cameraTransitionInFlightRef = useRef<boolean>(false);
  const cameraTransitionTimerRef = useRef<number | null>(null);
  const userZoomingRef = useRef<boolean>(false);
  const lastNavFollowMoveEndTsRef = useRef<number>(0);
  const lastNavFollowGridTsRef = useRef<number>(0);
  const lastBearingUiUpdateRef = useRef<{ ts: number; bearing: number }>({
    ts: 0,
    bearing: 0,
  });
  const compassMetaRef = useRef<{ heading: number | null; updatedAt: number }>({
    heading: null,
    updatedAt: 0,
  });
  const lastHeadingStateUpdateRef = useRef<{ ts: number; heading: number | null }>({
    ts: 0,
    heading: null,
  });
  const lastCameraBearingRef = useRef<{ ts: number; bearing: number }>({
    ts: 0,
    bearing: 0,
  });
  const wasNavigationActiveRef = useRef<boolean>(false);
  const currentUserRef = useRef<NavUser | null>(currentUser);
  currentUserRef.current = currentUser;
  const lastSyncedConfigJsonRef = useRef<string>(JSON.stringify(initialConfig));
  const lastRecordedCameraRef = useRef<SavedMapCamera>({ ...initialCamera });
  const lastNavCamPersistTsRef = useRef<number>(0);

  const beginCameraTransition = useCallback((durationHintMs = 1000) => {
    cameraTransitionInFlightRef.current = true;
    if (cameraTransitionTimerRef.current !== null) {
      window.clearTimeout(cameraTransitionTimerRef.current);
    }
    cameraTransitionTimerRef.current = window.setTimeout(() => {
      cameraTransitionInFlightRef.current = false;
      cameraTransitionTimerRef.current = null;
    }, Math.max(250, durationHintMs + 150));
  }, []);

  const hasCameraChangedMeaningfully = useCallback(
    (prev: SavedMapCamera, next: SavedMapCamera): boolean => {
      return (
        Math.abs(prev.lon - next.lon) >= 0.00015 ||
        Math.abs(prev.lat - next.lat) >= 0.00015 ||
        Math.abs(prev.zoom - next.zoom) >= 0.05 ||
        Math.abs(shortestAngleDeltaDeg(prev.bearing, next.bearing)) >= 1.5 ||
        Math.abs(prev.pitch - next.pitch) >= 1.5
      );
    },
    []
  );

  const recordCameraIfChanged = useCallback(
    (nextCamera: SavedMapCamera, debounceMs = 1500) => {
      if (!hasCameraChangedMeaningfully(lastRecordedCameraRef.current, nextCamera)) {
        return;
      }
      lastRecordedCameraRef.current = { ...nextCamera };
      UserStateSyncService.recordLocalCamera(nextCamera, currentUserRef.current, debounceMs);
    },
    [hasCameraChangedMeaningfully]
  );

  const applyRemoteMergedState = useCallback(
    (result: MergeUserStateResult) => {
      if (result.applyRemoteConfig) {
        const cfg = result.merged.config;
        lastSyncedConfigJsonRef.current = JSON.stringify(cfg);
        NavigationHeadingService.setOrientationPreference(cfg.navOrientation);
        void UserLocationIconService.setPreference(cfg.userIcon).then((savedIcon) => {
          setUserIconPref(savedIcon);
          if (userMarkerRef.current) {
            UserLocationIconService.renderMarkerElement(
              userMarkerRef.current.getElement(),
              savedIcon,
              liveHeadingRef.current,
              mapRef.current?.getBearing() ?? 0,
              isNavigationActiveRef.current
            );
          }
        });
        setTheme(cfg.theme);
        setVisibility(cfg.visibility);
        setNavOrientation(cfg.navOrientation);
        setShowCenterCrosshair(cfg.showCenterCrosshair);
        setPlanningMode(cfg.planningMode);
      }

      if (result.applyRemoteCamera && result.merged.camera) {
        const cam = result.merged.camera;
        lastRecordedCameraRef.current = { ...cam };
        const map = mapRef.current;
        if (map && !isNavigationActiveRef.current && !isFollowingUserRef.current) {
          beginCameraTransition(650);
          map.easeTo({
            center: [cam.lon, cam.lat],
            zoom: cam.zoom,
            bearing: cam.bearing,
            pitch: cam.pitch,
            duration: 600,
            essential: true,
          });
          setMapBearing(cam.bearing);
        }
        setCursorCoords((prev) => ({
          ...prev,
          lon: Number(cam.lon.toFixed(4)),
          lat: Number(cam.lat.toFixed(4)),
          zoom: Number(cam.zoom.toFixed(1)),
        }));
      }

      if (result.merged.lastSyncedAt) {
        setLastSyncedAt(result.merged.lastSyncedAt);
      }
    },
    [beginCameraTransition]
  );

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

  // Persist user configuration changes locally immediately & debounce cross-platform cloud sync
  useEffect(() => {
    const snapshot: SavedUserConfiguration = {
      theme,
      visibility,
      navOrientation,
      showCenterCrosshair,
      planningMode,
      userIcon: userIconPref,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSyncedConfigJsonRef.current) {
      return;
    }
    lastSyncedConfigJsonRef.current = serialized;
    UserStateSyncService.recordLocalConfig(snapshot, currentUserRef.current);
  }, [theme, visibility, navOrientation, showCenterCrosshair, planningMode, userIconPref]);

  // Flush last map position & cloud user state cleanly when backgrounded or leaving page
  useEffect(() => {
    const captureAndFlush = () => {
      const map = mapRef.current;
      if (map) {
        try {
          const c = map.getCenter();
          recordCameraIfChanged(
            {
              lon: c.lng,
              lat: c.lat,
              zoom: map.getZoom(),
              bearing: map.getBearing(),
              pitch: map.getPitch(),
            },
            0
          );
        } catch {
          // Ignore if map was already disposed
        }
      }
      if (currentUserRef.current && UserStateSyncService.hasDirtyCloudChanges()) {
        void UserStateSyncService.flushCloudPush(currentUserRef.current);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        captureAndFlush();
      }
    };

    window.addEventListener('pagehide', captureAndFlush);
    window.addEventListener('beforeunload', captureAndFlush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', captureAndFlush);
      window.removeEventListener('beforeunload', captureAndFlush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [recordCameraIfChanged]);

  // Sync pending planned routes and cross-platform user position/config when signed in & online
  const resetRouteSessionState = useCallback(() => {
    RouteManager.clearHydratedCache();
    setActiveRoute(null);
    setShareModalRouteId(null);
    setUnseenSharedCount(0);
    setIsNavigatingRoute(false);
    setOffRouteWarning(null);
    setRemainingDistKm(null);
    setPinnedBackgroundRouteIds([]);
    editingRouteIdRef.current = null;
    setEditingRouteId(null);
    setPlanRouteName('');
    setPlanWaypoints([]);
    setPlanLegs([]);
    setPlanPreviewPoint(null);
    setPlanCursorCoord(null);
    setDisconnectedCandidate(null);
  }, []);

  // Scoped route ownership isolation + Cloud sync on sign-in / user switch / sign-out
  const prevAuthUidRef = useRef<string | null>(currentUser?.uid ?? null);
  useEffect(() => {
    let cancelled = false;
    const nextUid = currentUser?.uid ?? null;
    const prevUid = prevAuthUidRef.current;
    prevAuthUidRef.current = nextUid;
    const prevStoredUid = readStoredLastAuthUid();

    if (!currentUser) {
      // Signed out: immediately hide/purge any signed-in or shared routes
      if (prevUid) {
        writeStoredLastAuthUid(prevUid);
        resetRouteSessionState();
        setRoutes((prev) => prev.filter((r) => RouteManager.isRouteVisibleForUser(r, null)));
      }
      void RouteManager.purgeOtherUsersCachedRoutes(null).then(async () => {
        if (cancelled) return;
        const anonRoutes = (await RouteManager.listRouteSummaries(null)).filter(
          (r) => !deletedRouteIdsRef.current.has(r.id)
        );
        if (!cancelled) {
          setRoutes(anonRoutes);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    const switchedFromAnotherUser =
      (Boolean(prevUid) && prevUid !== nextUid) ||
      (Boolean(prevStoredUid) && prevStoredUid !== nextUid);

    if (switchedFromAnotherUser) {
      resetRouteSessionState();
      deletedRouteIdsRef.current.clear();
      try {
        window.localStorage.removeItem('navapp.deletedPlannedRoutes.v1');
        window.localStorage.removeItem('navapp.dismissedSharedRoutes.v1');
      } catch {
        // Ignore storage errors
      }
      setRoutes((prev) => prev.filter((r) => RouteManager.isRouteVisibleForUser(r, nextUid)));
    }
    writeStoredLastAuthUid(nextUid);

    (async () => {
      try {
        if (switchedFromAnotherUser) {
          await RouteManager.purgeOtherUsersCachedRoutes(nextUid);
        } else {
          await RouteManager.claimUnownedRoutesForUser(currentUser);
        }
        if (cancelled) return;

        const scopedInitial = (await RouteManager.listRouteSummaries(nextUid)).filter(
          (r) => !deletedRouteIdsRef.current.has(r.id)
        );
        if (!cancelled) {
          setRoutes(scopedInitial);
        }

        if (!isOnline) return;
        setIsSyncingCloud(true);

        const [mergedState, syncedCount, downloaded, sharedRes] = await Promise.all([
          UserStateSyncService.pullAndMergeCloudState(currentUser),
          PlannedTracksCloudService.syncPendingRoutesForUser(currentUser),
          PlannedTracksCloudService.fetchUserPlannedRoutes(currentUser),
          PlannedTracksCloudService.fetchSharedWithMeRoutes(currentUser),
          UserDirectoryService.registerCurrentUser(currentUser),
        ]);
        if (cancelled) return;

        if (mergedState) {
          applyRemoteMergedState(mergedState);
          if (mergedState.applyRemoteCamera || mergedState.applyRemoteConfig) {
            showToast('שוחזרו מיקום והגדרות מחשבון Google שלך');
          }
          setLastSyncedAt(mergedState.merged.lastSyncedAt || new Date().toISOString());
        }

        if (
          syncedCount > 0 ||
          downloaded.length > 0 ||
          sharedRes.newlyArrived.length > 0 ||
          sharedRes.revokedIds.length > 0
        ) {
          if (deletedRouteIdsRef.current.size > 0) {
            const delIds = Array.from(deletedRouteIdsRef.current);
            await db.routes.bulkDelete(delIds);
            await db.routePayloads.bulkDelete(delIds).catch(() => undefined);
          }
          const all = (await RouteManager.listRouteSummaries(nextUid)).filter(
            (r) => !deletedRouteIdsRef.current.has(r.id)
          );
          if (!cancelled) {
            setRoutes(all);
            if (syncedCount > 0) {
              showToast(`סונכרנו ${syncedCount} מסלולים מתוכננים ל-Firebase`);
            }
            if (sharedRes.newlyArrived.length > 0) {
              setUnseenSharedCount((c) => c + sharedRes.newlyArrived.length);
              const first = sharedRes.newlyArrived[0];
              const sender = first.sharedByName || first.sharedByEmail || 'משתמש NavApp';
              showToast(
                sharedRes.newlyArrived.length === 1
                  ? `${sender} שיתף איתך מסלול: ${first.name}`
                  : `התקבלו ${sharedRes.newlyArrived.length} מסלולים משותפים חדשים`
              );
            }
          }
        }
        if (sharedRes.error && !cancelled) {
          console.warn('[NavApp] Shared routes fetch error:', sharedRes.error);
        }
      } catch (err) {
        console.warn('[NavApp] Planned tracks cloud sync warning:', err);
      } finally {
        if (!cancelled) {
          setIsSyncingCloud(false);
        }
      }
    })();

    if (!isOnline) {
      return () => {
        cancelled = true;
      };
    }

    const unsubRemoteState = UserStateSyncService.subscribeRemoteState(currentUser, (remoteRes) => {
      if (cancelled) return;
      applyRemoteMergedState(remoteRes);
    });

    let sharedErrorNotified = false;
    const unsubSharedRoutes = PlannedTracksCloudService.subscribeSharedWithMeRoutes(
      currentUser,
      (event) => {
        if (cancelled) return;
        void RouteManager.listRouteSummaries(nextUid).then((all) => {
          if (cancelled) return;
          setRoutes(all.filter((r) => !deletedRouteIdsRef.current.has(r.id)));
        });

        if (
          event.revokedIds.length > 0 &&
          activeRouteRef.current &&
          event.revokedIds.includes(activeRouteRef.current.id) &&
          !isNavigationActiveRef.current
        ) {
          setActiveRoute(null);
          showToast('הגישה למסלול המשותף בוטלה ע״י הבעלים');
        }

        if (event.newlyArrived.length > 0) {
          setUnseenSharedCount((c) => c + event.newlyArrived.length);
          const first = event.newlyArrived[0];
          const sender = first.sharedByName || first.sharedByEmail || 'משתמש NavApp';
          showToast(
            event.newlyArrived.length === 1
              ? `${sender} שיתף איתך מסלול: ${first.name}`
              : `התקבלו ${event.newlyArrived.length} מסלולים משותפים חדשים`
          );
        }
      },
      (errMsg) => {
        if (cancelled || sharedErrorNotified) return;
        sharedErrorNotified = true;
        console.warn('[NavApp] Shared routes subscription error:', errMsg);
        if (errMsg.includes('failed-precondition') || errMsg.includes('not ready yet')) {
          showToast('אינדקס השיתוף ב-Firebase עדיין בבנייה בענן — יתעדכן אוטומטית כשהבנייה תסתיים');
        } else if (errMsg.includes('permission-denied')) {
          showToast('שגיאת הרשאות בטעינת מסלולים משותפים מ-Firestore');
        }
      }
    );

    return () => {
      cancelled = true;
      unsubRemoteState();
      unsubSharedRoutes();
    };
  }, [currentUser, isOnline, showToast, applyRemoteMergedState, resetRouteSessionState]);

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

  const syncHeadingUi = useCallback((resolved: number | null, perfNowMs = performance.now()) => {
    liveHeadingRef.current = resolved;
    const prevSaved = lastHeadingStateUpdateRef.current;
    if (
      resolved !== prevSaved.heading &&
      (resolved === null ||
        prevSaved.heading === null ||
        (perfNowMs - prevSaved.ts >= 180 &&
          Math.abs(shortestAngleDeltaDeg(prevSaved.heading, resolved)) >= 3))
    ) {
      lastHeadingStateUpdateRef.current = { ts: perfNowMs, heading: resolved };
      setLiveHeading(resolved);
    }
  }, []);

  const resolveCurrentHeading = useCallback((): number | null => {
    const latestFrame = navSmootherRef.current?.getLatestFrame();
    if (latestFrame?.headingDeg !== undefined && latestFrame?.headingDeg !== null) {
      syncHeadingUi(latestFrame.headingDeg, performance.now());
      return latestFrame.headingDeg;
    }

    const nowMs = Date.now();
    const currentLoc = userLocationRef.current;
    const routeFallback =
      isNavigationActiveRef.current && activeRouteRef.current
        ? extractRouteTangentHeading(activeRouteRef.current, currentLoc?.lon, currentLoc?.lat)
        : null;
    const rawResolved = NavigationHeadingService.resolveActiveHeading({
      gpsFixHeading: currentLoc?.heading ?? null,
      gpsSpeedMps: currentLoc?.speed ?? null,
      computedCourseHeading: null,
      compassHeading: compassMetaRef.current.heading,
      lastValidHeading: liveHeadingRef.current,
      routeFallbackHeading: routeFallback,
      nowMs,
      gpsUpdatedAtMs: currentLoc?.timestamp,
      compassUpdatedAtMs: compassMetaRef.current.updatedAt || undefined,
    });
    const resolved =
      rawResolved !== null
        ? smoothHeadingDeg(liveHeadingRef.current, rawResolved, 0.38)
        : null;
    syncHeadingUi(resolved, performance.now());
    if (userMarkerRef.current && mapRef.current) {
      UserLocationIconService.updateMarkerDirection(
        userMarkerRef.current.getElement(),
        userIconPrefRef.current,
        resolved,
        mapRef.current.getBearing(),
        isNavigationActiveRef.current
      );
    }
    return resolved;
  }, [syncHeadingUi]);

  const applySmoothedFrameToMap = useCallback(
    (frame: SmoothedNavigationFrame, perfNowMs: number) => {
      syncHeadingUi(frame.headingDeg, perfNowMs);

      const map = mapRef.current;
      if (!map) return;

      const curMapBearing = map.getBearing();
      if (!userMarkerRef.current) {
        userMarkerRef.current = new maplibregl.Marker({
          element: createUserMarkerElement(
            userIconPrefRef.current,
            frame.headingDeg,
            curMapBearing,
            isNavigationActiveRef.current
          ),
          anchor: 'center',
        })
          .setLngLat([frame.lon, frame.lat])
          .addTo(map);
      } else {
        userMarkerRef.current.setLngLat([frame.lon, frame.lat]);
        UserLocationIconService.updateMarkerDirection(
          userMarkerRef.current.getElement(),
          userIconPrefRef.current,
          frame.headingDeg,
          curMapBearing,
          isNavigationActiveRef.current
        );
      }

      if (
        isFollowingUserRef.current &&
        !cameraTransitionInFlightRef.current &&
        !userZoomingRef.current &&
        !map.isZooming()
      ) {
        const targetBearing = isNavigationActiveRef.current
          ? navOrientationRef.current === 'heading-up'
            ? frame.headingDeg ?? curMapBearing
            : 0
          : null;

        const curCenter = map.getCenter();
        const centerMoved =
          Math.abs(frame.lon - curCenter.lng) > 1e-7 ||
          Math.abs(frame.lat - curCenter.lat) > 1e-7;
        const bearingChanged =
          targetBearing !== null &&
          Math.abs(shortestAngleDeltaDeg(curMapBearing, targetBearing)) > 0.05;

        if (centerMoved || bearingChanged) {
          if (targetBearing !== null) {
            lastCameraBearingRef.current = { ts: perfNowMs, bearing: targetBearing };
          }
          map.jumpTo(
            {
              center: [frame.lon, frame.lat],
              ...(targetBearing !== null ? { bearing: targetBearing } : {}),
            },
            { navFollowTick: true }
          );
        }
      }
    },
    [syncHeadingUi]
  );

  const stopSmoothLoop = useCallback(() => {
    if (smoothRafIdRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(smoothRafIdRef.current);
      smoothRafIdRef.current = null;
    }
  }, []);

  const scheduleSmoothLoop = useCallback(() => {
    if (smoothRafIdRef.current !== null) return;
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      return;
    }

    const tick = () => {
      smoothRafIdRef.current = null;
      const smoother = navSmootherRef.current;
      if (!smoother) return;
      const perfNow = performance.now();
      const frame = smoother.step(perfNow);
      if (frame) {
        applySmoothedFrameToMap(frame, perfNow);
      }
      if (smoother.needsAnimationFrame(perfNow)) {
        smoothRafIdRef.current = window.requestAnimationFrame(tick);
      }
    };

    smoothRafIdRef.current = window.requestAnimationFrame(tick);
  }, [applySmoothedFrameToMap]);

  // Clean up smoother loop and transition timers on unmount
  useEffect(() => {
    return () => {
      stopSmoothLoop();
      if (cameraTransitionTimerRef.current !== null) {
        window.clearTimeout(cameraTransitionTimerRef.current);
        cameraTransitionTimerRef.current = null;
      }
    };
  }, [stopSmoothLoop]);

  // Keep navigation smoother synced with active route & OSM PMTiles archive
  useEffect(() => {
    const smoother = navSmootherRef.current;
    if (!smoother) return;
    smoother.setActiveRoute(activeRoute);
    if (!activeRoute) {
      smoother.setPlanningMode('4x4');
    }
    const frame = smoother.getLatestFrame();
    const refLon = frame?.kalmanLon ?? userLocationRef.current?.lon;
    const refLat = frame?.kalmanLat ?? userLocationRef.current?.lat;
    const routeFallback =
      isNavigationActive && activeRoute
        ? extractRouteTangentHeading(activeRoute, refLon, refLat)
        : null;
    smoother.setRouteFallbackHeading(routeFallback);
  }, [activeRoute, isNavigationActive]);

  useEffect(() => {
    routePlannerEngine.clearCache();
    const smoother = navSmootherRef.current;
    if (!smoother) return;
    smoother.clearRoadNetworkCache();
    const frame = smoother.getLatestFrame();
    const lon = frame?.kalmanLon ?? userLocationRef.current?.lon;
    const lat = frame?.kalmanLat ?? userLocationRef.current?.lat;
    if (typeof lon === 'number' && typeof lat === 'number') {
      void smoother.getRoadNetworkCache().ensureNear(lon, lat);
    }
  }, [osmInfo]);

  // Continuous live GPS position stream across all map modes (Explore, Planning, Navigating, Recording)
  useEffect(() => {
    const stopWatch = LiveGpsService.startContinuousWatch(
      async (fix) => {
        const smoother = navSmootherRef.current;
        if (!smoother) return;
        const perfNow = performance.now();

        const currentActiveRoute = activeRouteRef.current;
        const routeFallback =
          isNavigationActiveRef.current && currentActiveRoute
            ? extractRouteTangentHeading(currentActiveRoute, fix.lon, fix.lat)
            : null;
        smoother.setRouteFallbackHeading(routeFallback);

        const hadPreviousFix = userLocationRef.current !== null;
        const ingest = smoother.ingestFix(fix, perfNow);
        const latestFrame = smoother.getLatestFrame();

        if (ingest.accepted || !hadPreviousFix) {
          setUserLocation(fix);
        }

        if (pendingLocateFlyRef.current && mapRef.current) {
          pendingLocateFlyRef.current = false;
          const targetLon = latestFrame?.lon ?? ingest.kalmanLon;
          const targetLat = latestFrame?.lat ?? ingest.kalmanLat;
          const curMapBearing = mapRef.current.getBearing();
          const flyHeading = latestFrame?.headingDeg ?? ingest.headingDeg;
          const navTargetBearing = isNavigationActiveRef.current
            ? navOrientationRef.current === 'heading-up'
              ? flyHeading ?? curMapBearing
              : 0
            : undefined;
          if (navTargetBearing !== undefined) {
            lastCameraBearingRef.current = { ts: perfNow, bearing: navTargetBearing };
          }
          beginCameraTransition(1100);
          mapRef.current.flyTo({
            center: [targetLon, targetLat],
            zoom: Math.max(mapRef.current.getZoom(), isNavigationActiveRef.current ? 15.5 : 15),
            ...(navTargetBearing !== undefined ? { bearing: navTargetBearing } : {}),
            speed: 1.4,
            essential: true,
          });
        }

        if (latestFrame) {
          applySmoothedFrameToMap(latestFrame, perfNow);
          scheduleSmoothLoop();
        }

        if (currentActiveRoute && (ingest.accepted || !hadPreviousFix)) {
          const checkLon = ingest.kalmanLon;
          const checkLat = ingest.kalmanLat;
          const check = RouteManager.checkNavigationDeviation(
            currentActiveRoute,
            checkLon,
            checkLat
          );
          if (isNavigatingRouteRef.current) {
            setOffRouteWarning(check.isOffRoute ? check.distanceFromTrailMeters : null);
          }
          setRemainingDistKm(
            RouteManager.computeRemainingDistanceKm(currentActiveRoute, checkLon, checkLat)
          );
        }

        if (isRecordingTrackRef.current && !isRecordingPausedRef.current && ingest.accepted) {
          const recLon = ingest.kalmanLon;
          const recLat = ingest.kalmanLat;
          const nextPt: [number, number] = [Number(recLon.toFixed(6)), Number(recLat.toFixed(6))];
          setRecordedCoords((prev) => {
            if (prev.length > 0) {
              const last = prev[prev.length - 1];
              const stepMeters = turf.distance(turf.point(last), turf.point(nextPt), {
                units: 'meters',
              });
              if (stepMeters < 5) return prev;
              setRecordedDistanceKm((d) => Number((d + stepMeters / 1000).toFixed(2)));
            }
            return [...prev, nextPt];
          });

          const ele = await ElevationService.getElevationAt(recLon, recLat, 11, true);
          if (ele !== null) {
            if (lastRecordedEleRef.current !== null && ele > lastRecordedEleRef.current) {
              setRecordedAscentMeters((a) => a + (ele - (lastRecordedEleRef.current ?? ele)));
            }
            lastRecordedEleRef.current = ele;
          }
        }
      },
      (err) => {
        if (pendingLocateFlyRef.current) {
          pendingLocateFlyRef.current = false;
          setIsFollowingUser(false);
          isFollowingUserRef.current = false;
          if (err.isPermissionDenied) {
            showToast('אין הרשאת מיקום — אשר גישה ל-GPS בהגדרות הדפדפן/המכשיר');
          } else {
            const demoLon = 34.8134;
            const demoLat = 30.8281;
            beginCameraTransition(1100);
            mapRef.current?.flyTo({ center: [demoLon, demoLat], zoom: 13.5, essential: true });
            showToast('מיקום GPS לא זמין כרגע — ממרכז לאזור עין עקב');
          }
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 10000,
        minimumUpdateInterval: 500,
      }
    );

    return stopWatch;
  }, [
    gpsWatchRestartSeq,
    applySmoothedFrameToMap,
    scheduleSmoothLoop,
    beginCameraTransition,
    showToast,
  ]);

  // Continuous device compass stream so user icon & Heading-Up map turn smoothly even while stationary
  useEffect(() => {
    return NavigationHeadingService.subscribeCompassHeading((compassDeg) => {
      compassMetaRef.current = { heading: compassDeg, updatedAt: Date.now() };
      const perfNow = performance.now();
      const smoother = navSmootherRef.current;
      if (smoother) {
        smoother.setCompassHeading(compassDeg, perfNow);
        if (smoother.getLatestFrame()) {
          scheduleSmoothLoop();
          return;
        }
      }

      const resolved = resolveCurrentHeading();
      if (
        resolved !== null &&
        isNavigationActiveRef.current &&
        navOrientationRef.current === 'heading-up' &&
        isFollowingUserRef.current &&
        mapRef.current &&
        !cameraTransitionInFlightRef.current &&
        !userZoomingRef.current &&
        !mapRef.current.isMoving()
      ) {
        if (
          perfNow - lastCameraBearingRef.current.ts >= 180 &&
          Math.abs(shortestAngleDeltaDeg(lastCameraBearingRef.current.bearing, resolved)) >= 3
        ) {
          lastCameraBearingRef.current = { ts: perfNow, bearing: resolved };
          beginCameraTransition(220);
          const curLoc = userLocationRef.current;
          mapRef.current.easeTo({
            ...(curLoc ? { center: [curLoc.lon, curLoc.lat] } : {}),
            bearing: resolved,
            duration: 220,
            essential: true,
          });
        }
      }
    });
  }, [scheduleSmoothLoop, resolveCurrentHeading, beginCameraTransition]);

  // Ensure live GPS puck is mounted and styled when map readiness, icon preference, or nav state changes
  useEffect(() => {
    const map = mapRef.current;
    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const curLoc = userLocationRef.current;
    if (!map || !isMapReady || (!latestFrame && !curLoc)) return;
    const effectiveLon = latestFrame?.lon ?? curLoc!.lon;
    const effectiveLat = latestFrame?.lat ?? curLoc!.lat;
    const effectiveHeading =
      latestFrame?.headingDeg ?? liveHeadingRef.current ?? curLoc?.heading ?? null;
    const curBearing = map.getBearing();
    if (!userMarkerRef.current) {
      userMarkerRef.current = new maplibregl.Marker({
        element: createUserMarkerElement(
          userIconPref,
          effectiveHeading,
          curBearing,
          isNavigationActive
        ),
        anchor: 'center',
      })
        .setLngLat([effectiveLon, effectiveLat])
        .addTo(map);
    } else {
      userMarkerRef.current.setLngLat([effectiveLon, effectiveLat]);
      UserLocationIconService.renderMarkerElement(
        userMarkerRef.current.getElement(),
        userIconPref,
        effectiveHeading,
        curBearing,
        isNavigationActive
      );
    }
  }, [isMapReady, userIconPref, isNavigationActive]);

  // Keep screen awake (prevent sleep/dimming) whenever the user is in active navigation
  useEffect(() => {
    if (!isNavigationActive) {
      setIsScreenWakeLockActive(false);
      return;
    }
    return ScreenWakeLockService.acquireNavigationWakeLock((active) => {
      setIsScreenWakeLockActive(active);
    });
  }, [isNavigationActive]);

  // Automatically align camera orientation when entering or exiting navigation mode (Heading-Up default vs North-Up)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const wasActive = wasNavigationActiveRef.current;
    wasNavigationActiveRef.current = isNavigationActive;

    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const resolvedHeading = resolveCurrentHeading();
    if (isNavigationActive) {
      if (!wasActive) {
        setIsFollowingUser(true);
        isFollowingUserRef.current = true;
      }
      if (isFollowingUserRef.current || !wasActive) {
        const targetBearing =
          navOrientation === 'heading-up'
            ? resolvedHeading ?? map.getBearing()
            : 0;
        lastCameraBearingRef.current = { ts: performance.now(), bearing: targetBearing };
        const centerCoord: [number, number] | null = latestFrame
          ? [latestFrame.lon, latestFrame.lat]
          : userLocationRef.current
            ? [userLocationRef.current.lon, userLocationRef.current.lat]
            : null;
        beginCameraTransition(450);
        map.easeTo({
          ...(centerCoord ? { center: centerCoord, zoom: Math.max(map.getZoom(), 15.5) } : {}),
          bearing: targetBearing,
          duration: 450,
          essential: true,
        });
      }
    } else if (wasActive) {
      lastCameraBearingRef.current = { ts: performance.now(), bearing: 0 };
      beginCameraTransition(450);
      map.easeTo({ bearing: 0, duration: 450, essential: true });
    }
  }, [isNavigationActive, navOrientation, isMapReady, resolveCurrentHeading, beginCameraTransition]);

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
            layout: {
              visibility: showGrid ? 'visible' : 'none',
            },
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
            layout: {
              visibility: showGrid ? 'visible' : 'none',
            },
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
              visibility: showGrid ? 'visible' : 'none',
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
      highlightedPoi: PoiRecord | null,
      currentDisplayCtx: RouteDisplayContext
    ) => {
      try {
        if (!map.getStyle()) return;

        updateTacticalGridOnMap(
          map,
          currentVis.tacticalGrid && !currentVis.googleSatellite,
          currentTheme
        );

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
          ['==', ['get', 'color'], '#f59e0b'],
          currentTheme === 'topo-dark' ? '#fcd34d' : '#78350f',
          ['==', ['get', 'color'], '#ef4444'],
          currentTheme === 'topo-dark' ? '#fca5a5' : '#7f1d1d',
          ['==', ['get', 'color'], '#9333ea'],
          currentTheme === 'topo-dark' ? '#d8b4fe' : '#4c1d95',
          ['==', ['get', 'color'], '#06b6d4'],
          currentTheme === 'topo-dark' ? '#67e8f9' : '#164e63',
          ['==', ['get', 'color'], '#14b8a6'],
          currentTheme === 'topo-dark' ? '#5eead4' : '#134e4a',
          currentTheme === 'topo-dark' ? '#f9a8d4' : '#831843',
        ];

        const resolveOverlayRoute = (r: SavedRouteRecord): SavedRouteRecord =>
          RouteManager.isHydratedRoute(r) ? r : RouteManager.getCachedFullRoute(r.id) || r;

        const normalizeFeaturesForRoute = (r: SavedRouteRecord): GeoJSON.Feature[] => {
          const hydrated = resolveOverlayRoute(r);
          const feats = hydrated.geojson?.features || [];
          const resolvedColor = resolveRouteDisplayColor(hydrated);
          return feats.map((f) => ({
            ...f,
            properties: {
              ...(f.properties || {}),
              color: resolvedColor,
            },
          }));
        };

        const resolvedDisplay = resolveMapRouteDisplay(allRoutes, currentRoute, currentDisplayCtx);

        // Background reference routes (only rendered while planning/comparing when explicitly pinned)
        const secondaryFeatures = resolvedDisplay.backgroundRoutesToDisplay.flatMap((r) =>
          normalizeFeaturesForRoute(r)
        );
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

        // Active Route (deterministic display policy: Planning/Selecting/Editing/Navigating only)
        const displayActiveRoute = resolvedDisplay.activeRouteToDisplay
          ? resolveOverlayRoute(resolvedDisplay.activeRouteToDisplay)
          : null;
        if (!displayActiveRoute && hoverMarkerRef.current) {
          hoverMarkerRef.current.remove();
          hoverMarkerRef.current = null;
        }
        const routeGeoJson: GeoJSON.FeatureCollection = displayActiveRoute
          ? {
              type: 'FeatureCollection',
              features: normalizeFeaturesForRoute(displayActiveRoute),
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

        // Active Route Start / Finish Endpoint Markers (supports LineString & MultiLineString)
        const endpointFeatures: GeoJSON.Feature[] = [];
        if (displayActiveRoute) {
          const activeCoordLists: Array<Array<GeoJSON.Position>> = [];
          for (const f of displayActiveRoute.geojson?.features || []) {
            if (f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 1) {
              activeCoordLists.push(f.geometry.coordinates);
            } else if (f.geometry?.type === 'MultiLineString') {
              for (const ring of f.geometry.coordinates) {
                if (ring.length >= 1) activeCoordLists.push(ring);
              }
            }
          }
          const firstCoords = activeCoordLists[0] || [];
          const lastCoords = activeCoordLists[activeCoordLists.length - 1] || [];
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

        if (!map.hasImage('offroad-blocked')) {
          const size = 24;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, 8.5, 0, Math.PI * 2);
            ctx.fillStyle = '#b91c1c';
            ctx.fill();
            ctx.lineWidth = 2.2;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(size / 2 - 4.5, size / 2);
            ctx.lineTo(size / 2 + 4.5, size / 2);
            ctx.lineWidth = 2.4;
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            const imgData = ctx.getImageData(0, 0, size, size);
            map.addImage('offroad-blocked', {
              width: size,
              height: size,
              data: new Uint8Array(imgData.data.buffer),
            });
          }
        }

        if (!map.hasImage('offroad-danger')) {
          const size = 24;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, 8.5, 0, Math.PI * 2);
            ctx.fillStyle = '#d97706';
            ctx.fill();
            ctx.lineWidth = 2.2;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(size / 2, size / 2 - 4);
            ctx.lineTo(size / 2, size / 2 + 1);
            ctx.lineWidth = 2.2;
            ctx.lineCap = 'round';
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(size / 2, size / 2 + 4, 1.25, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            const imgData = ctx.getImageData(0, 0, size, size);
            map.addImage('offroad-danger', {
              width: size,
              height: size,
              data: new Uint8Array(imgData.data.buffer),
            });
          }
        }

        const poiIconExpression: any = [
          'match',
          ['get', 'category'],
          'water',
          [
            'match',
            ['coalesce', ['get', 'subcategory'], ''],
            'waterhole',
            'water_hole',
            'waterfall',
            'waterfall',
            'cistern',
            'cistern',
            'water_well',
            'water_well',
            'drinking_water',
            'tap',
            'spring',
          ],
          'campsite',
          [
            'match',
            ['coalesce', ['get', 'subcategory'], ''],
            'picnic_site',
            'picnic',
            'shelter',
            'alpinehut',
            'wilderness_hut',
            'alpinehut',
            'camping',
          ],
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
            'fort',
            'jar',
            'castle',
            'jar',
            'memorial',
            'monument',
            'nature_site',
            'flower',
            'offroad_poi',
            'info',
            'offroad_photo',
            'info',
            'viewpoint',
          ],
          'offroad',
          [
            'match',
            ['coalesce', ['get', 'subcategory'], ''],
            'gate',
            'gate_closed',
            'barrier',
            'gate_closed',
            'blocked_road',
            'offroad-blocked',
            'danger',
            'offroad-danger',
            'obstacle',
            'offroad-danger',
            'floods',
            'offroad-danger',
            'wifi_sos',
            'antenna',
            'ratag_info',
            'sign',
            'clunker',
            'construction',
            'offroad-pass',
          ],
          'user',
          'star',
          'viewpoint',
        ];

        const poiIconSizeExpression: any = [
          'match',
          ['get', 'category'],
          'water',
          [
            'match',
            ['coalesce', ['get', 'subcategory'], ''],
            'waterfall',
            0.52,
            'drinking_water',
            0.52,
            'waterhole',
            0.62,
            'cistern',
            0.58,
            'water_well',
            0.58,
            0.85,
          ],
          'peak',
          0.5,
          'offroad',
          [
            'match',
            ['coalesce', ['get', 'subcategory'], ''],
            'gate',
            0.55,
            'barrier',
            0.55,
            'wifi_sos',
            0.55,
            'ratag_info',
            0.55,
            'clunker',
            0.55,
            0.85,
          ],
          'user',
          0.58,
          0.55,
        ];

        const poiTextColorExpression: any = [
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
        ];

        // Unified Outdoor POIs Layer (Curated + OSM + Off-Road.io + Imported + User merged into one categorized collection)
        const existingPoiSrc = map.getSource('israel-pois-src') as maplibregl.GeoJSONSource;
        if (existingPoiSrc) {
          if (lastPoiSyncRef.current !== currentPois) {
            existingPoiSrc.setData(PoiManager.toCompactMapGeoJSON(currentPois));
            lastPoiSyncRef.current = currentPois;
          }
          if (map.getLayer('israel-pois-labels')) {
            map.setFilter('israel-pois-labels', buildPoiLayerFilter(currentVis));
          }
        } else {
          const poiGeoJson = PoiManager.toCompactMapGeoJSON(currentPois);
          lastPoiSyncRef.current = currentPois;
          map.addSource('israel-pois-src', { type: 'geojson', data: poiGeoJson });
          map.addLayer({
            id: 'israel-pois-labels',
            type: 'symbol',
            source: 'israel-pois-src',
            minzoom: 13,
            filter: buildPoiLayerFilter(currentVis),
            layout: {
              visibility: isMasterPoiActive(currentVis) ? 'visible' : 'none',
              'symbol-sort-key': ['coalesce', ['get', 'priority'], 500],
              'icon-image': poiIconExpression,
              'icon-size': poiIconSizeExpression,
              'icon-anchor': 'center',
              'icon-allow-overlap': false,
              'icon-ignore-placement': false,
              'icon-padding': ['interpolate', ['linear'], ['zoom'], 13, 8, 15, 6],
              'text-field': ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
              'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11.5, 14, 12.8, 15, 14],
              'text-offset': [0, 0.75],
              'text-anchor': 'top',
              'text-max-width': 9,
              'text-allow-overlap': false,
              'text-ignore-placement': false,
              'text-optional': true,
              'text-padding': 3,
            },
            paint: {
              'text-color': poiTextColorExpression,
              'text-halo-color': currentTheme === 'topo-dark' ? '#0b1015' : 'white',
              'text-halo-width': 3,
              'text-halo-blur': 1.5,
            },
          });
        }

        // Route Planning Overlays (draft network legs, straight fallback legs, snapped cursor preview, numbered waypoints)
        const modeColor = currentPlan.activeColor || PLANNING_MODE_META[currentPlan.mode].color;
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

    const startupCamera = UserStateSyncService.getStartupState().camera;
    lastRecordedCameraRef.current = { ...startupCamera };

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: initialStyle,
      center: [startupCamera.lon, startupCamera.lat],
      zoom: startupCamera.zoom,
      bearing: startupCamera.bearing,
      pitch: startupCamera.pitch,
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
        selectedPoiRef.current,
        routeDisplayContextRef.current
      );
    });

    map.on('rotate', (ev: any) => {
      if (isCancelled) return;
      const currentBearing = map.getBearing();
      const isNavFollowTick = Boolean(ev?.navFollowTick);
      const perfNow = performance.now();
      const prevUi = lastBearingUiUpdateRef.current;
      if (
        !isNavFollowTick ||
        (perfNow - prevUi.ts >= 120 &&
          Math.abs(shortestAngleDeltaDeg(prevUi.bearing, currentBearing)) >= 1.5)
      ) {
        lastBearingUiUpdateRef.current = { ts: perfNow, bearing: currentBearing };
        setMapBearing(currentBearing);
      }
      if (userMarkerRef.current) {
        UserLocationIconService.updateMarkerDirection(
          userMarkerRef.current.getElement(),
          userIconPrefRef.current,
          liveHeadingRef.current,
          currentBearing,
          isNavigationActiveRef.current
        );
      }
    });

    map.on('rotatestart', (ev) => {
      if (isCancelled) return;
      if (ev?.originalEvent) {
        pendingLocateFlyRef.current = false;
        isFollowingUserRef.current = false;
        setIsFollowingUser(false);
      }
    });

    map.on('dragstart', () => {
      if (isCancelled) return;
      pendingLocateFlyRef.current = false;
      isFollowingUserRef.current = false;
      setIsFollowingUser(false);
    });

    map.on('zoomstart', (ev) => {
      if (isCancelled) return;
      if (ev?.originalEvent) {
        userZoomingRef.current = true;
      }
    });

    map.on('zoomend', () => {
      if (isCancelled) return;
      userZoomingRef.current = false;
    });

    map.on('moveend', async (ev: any) => {
      if (isCancelled) return;
      const isNavFollowTick = Boolean(ev?.navFollowTick);
      if (!isNavFollowTick) {
        if (cameraTransitionTimerRef.current !== null) {
          window.clearTimeout(cameraTransitionTimerRef.current);
          cameraTransitionTimerRef.current = null;
        }
        cameraTransitionInFlightRef.current = false;
      } else {
        const perfNow = performance.now();
        if (perfNow - lastNavFollowMoveEndTsRef.current < 650) {
          return;
        }
        lastNavFollowMoveEndTsRef.current = perfNow;
      }

      const c = map.getCenter();
      const lon = Number(c.lng.toFixed(4));
      const lat = Number(c.lat.toFixed(4));
      const zoom = Number(map.getZoom().toFixed(1));
      const nowMs = Date.now();
      if (!isNavFollowTick || nowMs - lastNavCamPersistTsRef.current >= 2500) {
        lastNavCamPersistTsRef.current = nowMs;
        recordCameraIfChanged(
          {
            lon: c.lng,
            lat: c.lat,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          },
          isNavFollowTick ? 4000 : 1500
        );
      }
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
      const featureId = String(p.id || feature.id || '');
      const fullRecord = featureId
        ? poisRef.current.find((item) => item.id === featureId)
        : undefined;
      const geomCoords =
        feature.geometry && feature.geometry.type === 'Point'
          ? (feature.geometry as GeoJSON.Point).coordinates
          : undefined;
      const clickedPoi: PoiRecord = fullRecord ?? {
        id: featureId,
        name: p.nameHe || p.name,
        nameHe: p.nameHe || p.name,
        nameEn: p.nameEn || p.nameHe || p.name,
        category: p.category,
        subcategory: p.subcategory,
        lon: Number(p.lon ?? geomCoords?.[0] ?? e.lngLat.lng),
        lat: Number(p.lat ?? geomCoords?.[1] ?? e.lngLat.lat),
        ele: p.ele ? Number(p.ele) : null,
        waterStatus: p.waterStatus || null,
        difficulty4x4: p.difficulty4x4 || null,
        descHe: p.descHe || '',
        descEn: p.descEn || '',
        source:
          p.source ||
          (featureId.startsWith('or-') ? 'Off-Road.io (קהילת השטח)' : 'IsraelHiking / OSM'),
        wikipedia: p.wikipedia || null,
        externalUrl: p.externalUrl || null,
        likes: typeof p.likes === 'number' ? p.likes : undefined,
        updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : undefined,
        userNotes: p.userNotes || '',
        priority: typeof p.priority === 'number' ? p.priority : undefined,
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
        const bootUser = currentUserRef.current ?? AuthService.getCurrentUser();
        const bootUid = bootUser?.uid ?? null;
        const prevStoredUid = readStoredLastAuthUid();
        if (bootUser) {
          if (prevStoredUid && prevStoredUid !== bootUser.uid) {
            await RouteManager.purgeOtherUsersCachedRoutes(bootUser.uid);
          } else {
            await RouteManager.claimUnownedRoutesForUser(bootUser);
          }
          writeStoredLastAuthUid(bootUser.uid);
        } else {
          await RouteManager.purgeOtherUsersCachedRoutes(null);
        }
        const [{ dem, osm }, loadedPois, loadedRoutes] = await Promise.all([
          pmtilesRegistry.initializeDefaultIsraelArchives(),
          PoiManager.initializePois(),
          RouteManager.initializeStarterRoutes(bootUid),
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
        if (deletedRouteIdsRef.current.size > 0) {
          const delIds = Array.from(deletedRouteIdsRef.current);
          await db.routes.bulkDelete(delIds);
          await db.routePayloads.bulkDelete(delIds).catch(() => undefined);
        }
        const filteredRoutes = loadedRoutes.filter(
          (r) => !deletedRouteIdsRef.current.has(r.id)
        );
        if (filteredRoutes.length > 0) setRoutes(filteredRoutes);
      } catch (err) {
        console.warn('[App] Background data loading warning:', err);
      }
    })();

    return () => {
      isCancelled = true;
      isStyleLoadedRef.current = false;
      mountedStyleKeyRef.current = '';
      lastPoiSyncRef.current = null;
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

  // Refresh tactical grid when panning/zooming (throttled during 60fps nav follow)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const onMoveEnd = (ev?: any) => {
      if (ev?.navFollowTick) {
        const perfNow = performance.now();
        if (perfNow - lastNavFollowGridTsRef.current < 800) {
          return;
        }
        lastNavFollowGridTsRef.current = perfNow;
      }
      updateTacticalGridOnMap(
        map,
        visibility.tacticalGrid && !visibility.googleSatellite,
        theme
      );
    };
    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
    };
  }, [isMapReady, visibility.tacticalGrid, visibility.googleSatellite, theme, updateTacticalGridOnMap]);

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
    lastPoiSyncRef.current = null;

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
        selectedPoiRef.current,
        routeDisplayContextRef.current
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
      selectedPoi,
      routeDisplayContext
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
    routeDisplayContext,
    bgHydrationSeq,
    syncOverlaySourcesToMap,
  ]);

  // Mirror routes, user POIs, theme, layer visibility, and active navigation status for Android Auto
  useEffect(() => {
    carSyncService.scheduleSync({
      activeRoute,
      routes,
      pois,
      isNavigationActive: isNavigatingRoute || isFreeNavigation,
      theme,
      visibility,
    });
  }, [activeRoute, routes, pois, isNavigatingRoute, isFreeNavigation, theme, visibility]);

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
    const trimmed = searchQuery.trim();
    if (!isSearchFocused && !trimmed) {
      setSearchResults([]);
      setExecutedSearchQuery('');
      return;
    }

    const runSearch = () => {
      const results = pmtilesSearchService.search(searchQuery, {
        filter: searchFilter,
        referenceCoord: searchRefCoordRef.current,
        pois,
        routes,
        limit: 30,
      });
      setSearchResults(results);
      setExecutedSearchQuery(searchQuery);
      setActiveSearchIndex(0);
    };

    if (!trimmed) {
      runSearch();
      return;
    }

    // Brief coalesce delay keeps Android WebView IME keystrokes lag-free while scanning 142k+ features
    const timer = window.setTimeout(runSearch, 40);
    return () => window.clearTimeout(timer);
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
  const isNearbyStripVisible =
    isMobile &&
    mobileDisplayMode === 'planning' &&
    mobileTab === 'explore' &&
    !mobilePlanningOverlay;
  const nearbyRefLon = Math.round(referenceCoord.lon * 1000) / 1000;
  const nearbyRefLat = Math.round(referenceCoord.lat * 1000) / 1000;

  const nearbyPois = useMemo(() => {
    if (!isNearbyStripVisible || pois.length === 0 || !visibility.pois) return [];
    const cosLat = Math.cos((nearbyRefLat * Math.PI) / 180);
    const maxCandidates = 40;
    const candidates: Array<{ poi: PoiRecord; approxDistSq: number }> = [];
    let worstDistSq = Infinity;

    for (let i = 0; i < pois.length; i++) {
      const p = pois[i];
      if (p.category === 'water' && !visibility.poiWater) continue;
      if (p.category === 'heritage' && !visibility.poiHeritage) continue;
      if (p.category === 'campsite' && !visibility.poiCampsites) continue;
      if (p.category === 'offroad' && !visibility.poiOffroad) continue;
      if (p.category === 'peak' && !visibility.poiPeaks) continue;
      if (p.category === 'user' && !(visibility.poiUser ?? true)) continue;

      const dLon = (p.lon - nearbyRefLon) * cosLat;
      const dLat = p.lat - nearbyRefLat;
      const distSq = dLon * dLon + dLat * dLat;
      if (candidates.length < maxCandidates) {
        candidates.push({ poi: p, approxDistSq: distSq });
        if (candidates.length === maxCandidates) {
          candidates.sort((a, b) => a.approxDistSq - b.approxDistSq);
          worstDistSq = candidates[maxCandidates - 1].approxDistSq;
        }
      } else if (distSq < worstDistSq) {
        candidates[maxCandidates - 1] = { poi: p, approxDistSq: distSq };
        candidates.sort((a, b) => a.approxDistSq - b.approxDistSq);
        worstDistSq = candidates[maxCandidates - 1].approxDistSq;
      }
    }

    const refPt = turf.point([nearbyRefLon, nearbyRefLat]);
    return candidates
      .map(({ poi }) => ({
        poi,
        distKm: turf.distance(refPt, turf.point([poi.lon, poi.lat]), { units: 'kilometers' }),
      }))
      .sort((a, b) =>
        Math.abs(a.distKm - b.distKm) < 0.02
          ? getPoiSortPriority(a.poi) - getPoiSortPriority(b.poi)
          : a.distKm - b.distKm
      )
      .slice(0, 10);
  }, [
    isNearbyStripVisible,
    pois,
    nearbyRefLon,
    nearbyRefLat,
    visibility.pois,
    visibility.poiWater,
    visibility.poiHeritage,
    visibility.poiCampsites,
    visibility.poiOffroad,
    visibility.poiPeaks,
    visibility.poiUser,
  ]);

  const handleFlyTo = useCallback(
    (lon: number, lat: number, zoom = 14) => {
      beginCameraTransition(1000);
      mapRef.current?.flyTo({ center: [lon, lat], zoom, essential: true });
    },
    [beginCameraTransition]
  );

  const fitBoundsToRoutes = useCallback(
    (targetRoutes: SavedRouteRecord[]) => {
      const map = mapRef.current;
      if (!map || targetRoutes.length === 0) return;
      const hydratedTargets = targetRoutes.map(
        (r) => (RouteManager.isHydratedRoute(r) ? r : RouteManager.getCachedFullRoute(r.id) || r)
      );
      try {
        const allFeatures = hydratedTargets.flatMap((r) => r.geojson?.features || []);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        if (allFeatures.length > 0) {
          const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: allFeatures };
          [minX, minY, maxX, maxY] = turf.bbox(fc);
        } else {
          for (const r of hydratedTargets) {
            if (Array.isArray(r.bounds) && r.bounds.length === 4) {
              if (r.bounds[0] < minX) minX = r.bounds[0];
              if (r.bounds[1] < minY) minY = r.bounds[1];
              if (r.bounds[2] > maxX) maxX = r.bounds[2];
              if (r.bounds[3] > maxY) maxY = r.bounds[3];
            }
          }
        }

        if (
          Number.isFinite(minX) &&
          Number.isFinite(minY) &&
          Number.isFinite(maxX) &&
          Number.isFinite(maxY)
        ) {
          if (Math.abs(maxX - minX) < 0.0005 && Math.abs(maxY - minY) < 0.0005) {
            beginCameraTransition(1000);
            map.flyTo({
              center: [(minX + maxX) / 2, (minY + maxY) / 2],
              zoom: 15,
              essential: true,
            });
          } else {
            beginCameraTransition(750);
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
      } catch {
        // Fall through to midpoint fallback
      }
      const pts = hydratedTargets[0]?.elevationProfile || [];
      if (pts.length > 0) {
        const mid = pts[Math.floor(pts.length / 2)];
        beginCameraTransition(1000);
        map.flyTo({ center: [mid.lon, mid.lat], zoom: 13.0, essential: true });
      }
    },
    [beginCameraTransition]
  );

  const handleFlyToRoute = useCallback(
    (route: SavedRouteRecord) => {
      fitBoundsToRoutes([route]);
    },
    [fitBoundsToRoutes]
  );

  const handleImportedData = useCallback(
    async (poiCount: number, createdRoutes: SavedRouteRecord[], importedPois: PoiRecord[] = []) => {
      const activeUid = currentUserRef.current?.uid ?? AuthService.getCurrentUser()?.uid ?? null;
      const [updatedPois, updatedRoutes] = await Promise.all([
        PoiManager.getAllPois(),
        RouteManager.initializeStarterRoutes(activeUid),
      ]);
      setPois(updatedPois);
      setRoutes(updatedRoutes.filter((r) => !deletedRouteIdsRef.current.has(r.id)));

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
        const latestPoi = importedPois[0] ?? updatedPois[updatedPois.length - 1];
        if (!isMobileRef.current) {
          setIsStorageOpen(false);
        } else {
          setMobileTab('explore');
          setMobilePlanningOverlay(null);
        }
        if (latestPoi) {
          setSelectedPoi(latestPoi);
          beginCameraTransition(1000);
          mapRef.current?.flyTo({
            center: [latestPoi.lon, latestPoi.lat],
            zoom: 15.2,
            essential: true,
          });
        }
        showToast(`יובאו ${poiCount} נקודות עניין למפה`);
      }
    },
    [fitBoundsToRoutes, beginCameraTransition, showToast]
  );

  const handleHoverElevationChart = useCallback(
    (pt: { lon: number; lat: number; ele: number; distKm: number } | null) => {
      const map = mapRef.current;
      if (!map) return;
      if (!pt) {
        hoverMarkerRef.current?.remove();
        hoverMarkerRef.current = null;
        return;
      }
      const markerColor = resolveRouteDisplayColor(activeRouteRef.current);
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
    },
    []
  );

  const handleLocateMe = () => {
    setIsFollowingUser(true);
    isFollowingUserRef.current = true;
    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const currentLoc = userLocationRef.current;
    if (latestFrame || currentLoc) {
      pendingLocateFlyRef.current = false;
      const map = mapRef.current;
      const targetLon = latestFrame?.lon ?? currentLoc!.lon;
      const targetLat = latestFrame?.lat ?? currentLoc!.lat;
      const targetBearing = isNavigationActiveRef.current
        ? navOrientationRef.current === 'heading-up'
          ? latestFrame?.headingDeg ?? liveHeadingRef.current ?? map?.getBearing() ?? 0
          : 0
        : undefined;
      beginCameraTransition(1100);
      map?.flyTo({
        center: [targetLon, targetLat],
        zoom: Math.max(map.getZoom() || 14, isNavigationActiveRef.current ? 15.5 : 15),
        ...(targetBearing !== undefined ? { bearing: targetBearing } : {}),
        essential: true,
      });
      if (activeRoute) {
        const check = RouteManager.checkNavigationDeviation(
          activeRoute,
          latestFrame?.kalmanLon ?? targetLon,
          latestFrame?.kalmanLat ?? targetLat
        );
        setOffRouteWarning(check.isOffRoute ? check.distanceFromTrailMeters : null);
      }
    } else {
      pendingLocateFlyRef.current = true;
      setGpsWatchRestartSeq((s) => s + 1);
      showToast('מאתר מיקום GPS רציף...');
    }
  };

  const handleChangeNavOrientation = (nextMode: MapNavigationOrientation) => {
    NavigationHeadingService.setOrientationPreference(nextMode);
    setNavOrientation(nextMode);
    setIsFollowingUser(true);
    isFollowingUserRef.current = true;
    void NavigationHeadingService.requestCompassPermissionIfNeeded();
    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const resolvedHeading = resolveCurrentHeading();
    const targetBearing = nextMode === 'heading-up' ? resolvedHeading ?? 0 : 0;
    lastCameraBearingRef.current = { ts: performance.now(), bearing: targetBearing };
    const map = mapRef.current;
    const currentLoc = userLocationRef.current;
    const targetCoord: [number, number] | null = latestFrame
      ? [latestFrame.lon, latestFrame.lat]
      : currentLoc
        ? [currentLoc.lon, currentLoc.lat]
        : null;
    beginCameraTransition(420);
    map?.easeTo({
      ...(targetCoord ? { center: targetCoord } : {}),
      bearing: targetBearing,
      duration: 420,
      essential: true,
    });
    if (userMarkerRef.current) {
      UserLocationIconService.updateMarkerDirection(
        userMarkerRef.current.getElement(),
        userIconPrefRef.current,
        resolvedHeading,
        targetBearing,
        isNavigationActiveRef.current
      );
    }
    showToast(
      nextMode === 'heading-up'
        ? 'כיוון מפה: מסתובבת לכיוון הנסיעה'
        : 'כיוון מפה: צפון למעלה'
    );
  };

  const handleToggleDesktopFreeNavigation = () => {
    if (isNavigationActive) {
      handleStopRouteNavigation();
      return;
    }
    void NavigationHeadingService.requestCompassPermissionIfNeeded();
    setIsFreeNavigation(true);
    setIsFollowingUser(true);
    showToast(
      navOrientationRef.current === 'heading-up'
        ? 'מצב ניווט הופעל • מפה מסתובבת לכיוון התנועה'
        : 'מצב ניווט הופעל • צפון למעלה'
    );
  };

  const handleUserIconPreferenceChange = (nextPref: UserLocationIconPreference) => {
    setUserIconPref(nextPref);
    const currentLoc = userLocationRef.current;
    const map = mapRef.current;
    if (currentLoc && map) {
      try {
        const bounds = map.getBounds();
        if (!bounds || !bounds.contains([currentLoc.lon, currentLoc.lat])) {
          setIsFollowingUser(true);
          handleFlyTo(currentLoc.lon, currentLoc.lat, Math.max(map.getZoom() || 14, 15));
        }
      } catch {
        // Ignore bounds check if map projection isn't ready yet
      }
      showToast(`אייקון המיקום עודכן ל: ${nextPref.icon.labelHe}`);
    } else {
      showToast(`אייקון המיקום עודכן ל: ${nextPref.icon.labelHe} (ממתין ל-GPS להצגה במפה)`);
    }
  };

  const handleToggle3D = () => {
    const next3d = !visibility.terrain3d;
    setVisibility((prev) => ({ ...prev, terrain3d: next3d }));
    beginCameraTransition(700);
    mapRef.current?.easeTo({ pitch: next3d ? 60 : 0, duration: 700 });
  };

  const handleResetNorth = () => {
    if (isNavigationActiveRef.current) {
      const nextMode: MapNavigationOrientation =
        navOrientationRef.current === 'heading-up' ? 'north-up' : 'heading-up';
      handleChangeNavOrientation(nextMode);
      return;
    }
    beginCameraTransition(500);
    mapRef.current?.easeTo({ bearing: 0, pitch: visibility.terrain3d ? 60 : 0, duration: 500 });
  };

  const handleSelectPoi = (item: PoiRecord, zoom = 15.2) => {
    setSelectedPoi(item);
    handleFlyTo(item.lon, item.lat, zoom);
    setSearchQuery('');
    setExecutedSearchQuery('');
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
    setExecutedSearchQuery('');
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
    handleSelectPoi(poiRec, item.recommendedZoom || 15.2);
  };

  const handleNavigateToPoi = (poi: PoiRecord) => {
    void NavigationHeadingService.requestCompassPermissionIfNeeded();
    handleFlyTo(poi.lon, poi.lat, 15.2);
    showToast(`מכוון אל ${poi.nameHe} (${poi.ele ?? '---'}m)`);
    if (isMobile) {
      setMobileDisplayMode('navigating');
      setMobileNavOverlay('poi-mini');
    } else {
      setIsFreeNavigation(true);
    }
  };

  const handleSelectRoute = useCallback(
    async (route: SavedRouteRecord | null, options?: { flyTo?: boolean }) => {
      const seq = ++selectRouteSeqRef.current;
      if (!route) {
        handleHoverElevationChart(null);
        setActiveRoute(null);
        setIsNavigatingRoute(false);
        setOffRouteWarning(null);
        setRemainingDistKm(null);
        return;
      }
      handleHoverElevationChart(null);

      const immediateRoute = RouteManager.isHydratedRoute(route)
        ? route
        : RouteManager.getCachedFullRoute(route.id) || route;
      setActiveRoute(immediateRoute);
      if (options?.flyTo !== false) {
        handleFlyToRoute(immediateRoute);
      }

      const fullRoute = RouteManager.isHydratedRoute(immediateRoute)
        ? immediateRoute
        : (await RouteManager.loadFullRoute(route)) || immediateRoute;
      if (selectRouteSeqRef.current !== seq || deletedRouteIdsRef.current.has(route.id)) {
        return;
      }
      if (!RouteManager.isHydratedRoute(immediateRoute) && RouteManager.isHydratedRoute(fullRoute)) {
        setActiveRoute((cur) => (cur?.id === fullRoute.id ? fullRoute : cur));
      }

      const refreshed = await RouteManager.refreshRouteElevationsFromDem(fullRoute);
      if (selectRouteSeqRef.current !== seq || deletedRouteIdsRef.current.has(route.id)) {
        return;
      }
      const refreshedSummary = RouteManager.splitRouteRecord(refreshed).summary;
      setActiveRoute((cur) => (cur?.id === refreshed.id ? refreshed : cur));
      setRoutes((prev) => prev.map((r) => (r.id === refreshed.id ? refreshedSummary : r)));
    },
    [handleFlyToRoute, handleHoverElevationChart]
  );

  // Backfill active route elevation profile automatically once Israel DEM finishes mounting
  useEffect(() => {
    if (!demInfo) return;
    const cur = activeRouteRef.current;
    if (!cur) return;
    if (
      cur.minEle === 0 &&
      cur.maxEle === 0 &&
      cur.ascentMeters === 0 &&
      cur.descentMeters === 0
    ) {
      void handleSelectRoute(cur, { flyTo: false });
    }
  }, [demInfo, handleSelectRoute]);

  const handleStartRouteNavigation = async (route: SavedRouteRecord) => {
    void NavigationHeadingService.requestCompassPermissionIfNeeded();
    const wasAlreadyNavigating = isNavigationActiveRef.current;
    const fullRoute = (await RouteManager.loadFullRoute(route)) || route;
    await handleSelectRoute(fullRoute, { flyTo: false });
    setIsNavigatingRoute(true);
    setIsFreeNavigation(false);
    setIsFollowingUser(true);
    isFollowingUserRef.current = true;
    setRemainingDistKm(fullRoute.distanceKm);
    if (wasAlreadyNavigating) {
      const latestFrame = navSmootherRef.current?.getLatestFrame();
      const resolvedHeading = resolveCurrentHeading();
      const targetBearing =
        navOrientationRef.current === 'heading-up' ? resolvedHeading ?? 0 : 0;
      const currentLoc = userLocationRef.current;
      const centerCoord: [number, number] | null = latestFrame
        ? [latestFrame.lon, latestFrame.lat]
        : currentLoc
          ? [currentLoc.lon, currentLoc.lat]
          : null;
      if (centerCoord) {
        beginCameraTransition(450);
        mapRef.current?.easeTo({
          center: centerCoord,
          zoom: Math.max(mapRef.current.getZoom() || 15.5, 15.5),
          bearing: targetBearing,
          duration: 450,
          essential: true,
        });
      }
    }
    if (isMobile) {
      setMobileDisplayMode('navigating');
      setMobileNavOverlay(null);
    }
    showToast(`ניווט פעיל במסלול: ${route.name}`);
  };

  const handleStopRouteNavigation = () => {
    setIsNavigatingRoute(false);
    setIsFreeNavigation(false);
    setOffRouteWarning(null);
    setRemainingDistKm(null);
    if (isMobile) {
      setMobileDisplayMode('planning');
      setMobileTab('explore');
      setMobileNavOverlay(null);
    }
    showToast('הניווט הופסק');
  };

  const handleDeleteRoute = async (routeId: string) => {
    deletedRouteIdsRef.current.add(routeId);
    markPlannedRouteDeleted(routeId);
    const target = routesRef.current.find((r) => r.id === routeId);
    const wasActive = activeRouteRef.current?.id === routeId;
    if (editingRouteIdRef.current === routeId) {
      editingRouteIdRef.current = null;
      setEditingRouteId(null);
    }
    const nextRoutes = routesRef.current.filter((r) => r.id !== routeId);
    const nextActive = wasActive ? null : activeRouteRef.current;

    // Immediately clear map hover marker, React state, and MapLibre GeoJSON sources
    handleHoverElevationChart(null);
    routesRef.current = nextRoutes;
    activeRouteRef.current = nextActive;
    setRoutes((prev) => prev.filter((r) => r.id !== routeId));
    setActiveRoute((cur) => (cur?.id === routeId ? null : cur));
    setPinnedBackgroundRouteIds((prev) => prev.filter((id) => id !== routeId));
    if (wasActive) {
      setIsNavigatingRoute(false);
      setOffRouteWarning(null);
      setRemainingDistKm(null);
    }

    const updatedDisplayCtx: RouteDisplayContext = {
      ...routeDisplayContextRef.current,
      isNavigating: wasActive ? false : routeDisplayContextRef.current.isNavigating,
      isEditing:
        editingRouteIdRef.current === null ? false : routeDisplayContextRef.current.isEditing,
      editingRouteId: editingRouteIdRef.current,
      pinnedBackgroundIds: pinnedBackgroundRouteIds.filter((id) => id !== routeId),
    };

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
        selectedPoiRef.current,
        updatedDisplayCtx
      );
    }

    await RouteManager.deleteRoute(routeId);
    if (target && currentUser && target.sourceFormat === 'planned') {
      void PlannedTracksCloudService.deleteRemotePlannedRoute(target, currentUser);
    }
    showToast('המסלול נמחק מהמכשיר');
  };

  const syncMutatedRouteState = useCallback(
    (updated: SavedRouteRecord | undefined, successToast?: string) => {
      if (!updated) return;
      const summary = RouteManager.splitRouteRecord(updated).summary;
      routesRef.current = routesRef.current.map((r) => (r.id === updated.id ? summary : r));
      setRoutes((prev) => prev.map((r) => (r.id === updated.id ? summary : r)));
      if (activeRouteRef.current?.id === updated.id) {
        activeRouteRef.current = updated;
        setActiveRoute(updated);
      }
      if (successToast) showToast(successToast);
      if (
        updated.ownership !== 'shared' &&
        updated.sourceFormat === 'planned' &&
        updated.cloudSyncStatus === 'pending' &&
        currentUser &&
        isOnline &&
        AuthService.isAvailable()
      ) {
        void PlannedTracksCloudService.savePlannedRouteToFirebase(updated, currentUser).then(
          (cloudRes) => {
            if (deletedRouteIdsRef.current.has(updated.id)) return;
            const syncedRec = cloudRes.route;
            const syncedSummary = RouteManager.splitRouteRecord(syncedRec).summary;
            setRoutes((prev) => prev.map((r) => (r.id === syncedRec.id ? syncedSummary : r)));
            setActiveRoute((cur) => (cur?.id === syncedRec.id ? { ...cur, ...syncedRec, geojson: cur.geojson, elevationProfile: cur.elevationProfile, waypoints: cur.waypoints, gpxXml: cur.gpxXml } : cur));
          }
        );
      }
    },
    [currentUser, isOnline, showToast]
  );

  const handleRenameRoute = useCallback(
    async (routeId: string, nextName: string) => {
      const target = routesRef.current.find((r) => r.id === routeId) || activeRouteRef.current;
      if (target?.ownership === 'shared') {
        showToast('מסלול משותף הוא לקריאה בלבד — לחץ "שמור עותק אצלי" כדי לערוך');
        return;
      }
      const updated = await RouteManager.updateRouteDetails(routeId, { name: nextName });
      syncMutatedRouteState(updated, updated ? `שם המסלול עודכן ל-"${updated.name}"` : undefined);
    },
    [showToast, syncMutatedRouteState]
  );

  const handleChangeRouteColor = useCallback(
    async (routeId: string, color: string) => {
      const target = routesRef.current.find((r) => r.id === routeId) || activeRouteRef.current;
      if (target?.ownership === 'shared') {
        showToast('מסלול משותף הוא לקריאה בלבד — לחץ "שמור עותק אצלי" כדי לערוך');
        return;
      }
      const updated = await RouteManager.updateRouteDetails(routeId, { color });
      syncMutatedRouteState(updated, 'צבע המסלול עודכן');
    },
    [showToast, syncMutatedRouteState]
  );

  const handleToggleRouteVisibility = useCallback(
    async (routeId: string) => {
      const updated = await RouteManager.toggleRouteVisibility(routeId);
      syncMutatedRouteState(
        updated,
        updated
          ? updated.visible === false
            ? 'המסלול הוסתר מהמפה'
            : 'המסלול מוצג במפה'
          : undefined
      );
    },
    [syncMutatedRouteState]
  );

  const handleToggleBackgroundRoute = useCallback(
    (routeId: string) => {
      setPinnedBackgroundRouteIds((prev) => {
        const exists = prev.includes(routeId);
        const next = exists ? prev.filter((id) => id !== routeId) : [...prev, routeId];
        showToast(
          exists ? 'המסלול הוסר מהצגה ברקע' : 'המסלול נעוץ ברקע לתכנון והשוואת מסלולים'
        );
        if (!exists && !RouteManager.getCachedFullRoute(routeId)) {
          void RouteManager.loadFullRoute(routeId).then((loaded) => {
            if (loaded) setBgHydrationSeq((s) => s + 1);
          });
        }
        return next;
      });
    },
    [showToast]
  );

  const handleClearBackgroundRoutes = useCallback(() => {
    setPinnedBackgroundRouteIds([]);
    showToast('מסלולי הרקע נוקו מהמפה');
  }, [showToast]);

  const handleReverseRoute = useCallback(
    async (routeId: string) => {
      const target = routesRef.current.find((r) => r.id === routeId) || activeRouteRef.current;
      if (target?.ownership === 'shared') {
        showToast('מסלול משותף הוא לקריאה בלבד — לחץ "שמור עותק אצלי" כדי לערוך');
        return;
      }
      handleHoverElevationChart(null);
      const updated = await RouteManager.reverseRoute(routeId);
      syncMutatedRouteState(updated, 'כיוון המסלול הוחלף');
    },
    [handleHoverElevationChart, showToast, syncMutatedRouteState]
  );

  const handleDuplicateSharedRoute = useCallback(
    async (route: SavedRouteRecord) => {
      const cloned = await RouteManager.duplicateRouteToMine(route, currentUser);
      const summary = RouteManager.splitRouteRecord(cloned).summary;
      setRoutes((prev) => [summary, ...prev]);
      setActiveRoute(cloned);
      showToast(`נשמר עותק אישי "${cloned.name}" בהמסלולים שלי`);

      if (
        cloned.sourceFormat === 'planned' &&
        currentUser &&
        isOnline &&
        AuthService.isAvailable()
      ) {
        void PlannedTracksCloudService.savePlannedRouteToFirebase(cloned, currentUser).then(
          (cloudRes) => {
            if (deletedRouteIdsRef.current.has(cloned.id)) return;
            const syncedSummary = RouteManager.splitRouteRecord(cloudRes.route).summary;
            setRoutes((prev) => prev.map((r) => (r.id === syncedSummary.id ? syncedSummary : r)));
          }
        );
      }
    },
    [currentUser, isOnline, showToast]
  );

  const handleDismissSharedRoute = useCallback(
    async (routeId: string) => {
      const wasActive = activeRouteRef.current?.id === routeId;
      markSharedRouteDismissed(routeId);
      handleHoverElevationChart(null);
      setRoutes((prev) => prev.filter((r) => r.id !== routeId));
      setPinnedBackgroundRouteIds((prev) => prev.filter((id) => id !== routeId));
      if (wasActive) {
        setActiveRoute(null);
        setIsNavigatingRoute(false);
        setOffRouteWarning(null);
        setRemainingDistKm(null);
      }
      await RouteManager.deleteRoute(routeId);
      showToast('המסלול המשותף הוסר מהרשימה המקומית');
    },
    [handleHoverElevationChart, showToast]
  );

  const shareModalRoute = useMemo(() => {
    if (!shareModalRouteId) return null;
    return (
      routes.find((r) => r.id === shareModalRouteId) ||
      (activeRoute?.id === shareModalRouteId ? activeRoute : null)
    );
  }, [shareModalRouteId, routes, activeRoute]);

  const handleOpenShareModal = useCallback(
    (route: SavedRouteRecord) => {
      if (route.ownership === 'shared') {
        showToast('ניתן לשתף רק מסלולים שבבעלותך — לחץ "שמור עותק אצלי" תחילה');
        return;
      }
      setShareModalRouteId(route.id);
    },
    [showToast]
  );

  const handleUpdateRouteSharing = useCallback(
    async (route: SavedRouteRecord, nextRecipients: RouteShareRecipient[]) => {
      if (!currentUser) {
        return {
          synced: false,
          route,
          error: 'יש להתחבר לחשבון Google כדי לשתף מסלול',
        };
      }
      const res = await PlannedTracksCloudService.updateRouteSharing(
        route,
        nextRecipients,
        currentUser
      );
      const summary = RouteManager.splitRouteRecord(res.route).summary;
      setRoutes((prev) => prev.map((r) => (r.id === summary.id ? summary : r)));
      if (activeRouteRef.current?.id === res.route.id) {
        setActiveRoute(res.route);
      }
      return res;
    },
    [currentUser]
  );

  const recomputePlanElevationStats = useCallback(
    async (legs: PlannedLeg[], wps: PlannedWaypoint[]) => {
      const seq = ++planElevSeqRef.current;
      const allPts: Array<[number, number]> = [];
      for (const leg of legs) {
        for (const c of leg.coordinates) {
          const prev = allPts[allPts.length - 1];
          if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) allPts.push(c);
        }
      }
      if (allPts.length < 2) {
        if (planElevSeqRef.current === seq) {
          setPlanElevStats({ ascent: 0, descent: 0 });
        }
        return;
      }

      const maxSamples = 45;
      const step = Math.max(1, Math.floor(allPts.length / maxSamples));
      const sampledCoords: Array<[number, number]> = [];
      for (let i = 0; i < allPts.length; i += step) sampledCoords.push(allPts[i]);
      const last = allPts[allPts.length - 1];
      const tail = sampledCoords[sampledCoords.length - 1];
      if (tail[0] !== last[0] || tail[1] !== last[1]) sampledCoords.push(last);

      const eles = await Promise.all(
        sampledCoords.map(([lon, lat]) => ElevationService.getElevationAt(lon, lat, 11))
      );
      if (planElevSeqRef.current !== seq) return;

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
        isRoutingLegRef.current = true;
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
            disconnectedCandidateRef.current = null;
            planWaypointsRef.current = [firstWp];
            setDisconnectedCandidate(null);
            setPlanWaypoints([firstWp]);
            setPlanPreviewPoint(snapped);
            return;
          }

          const prevWp = prevWaypoints[prevWaypoints.length - 1];
          const res = await routePlannerEngine.routeBetweenSnappedPoints(prevWp, snapped, mode);
          if (!res.found) {
            disconnectedCandidateRef.current = snapped;
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
          disconnectedCandidateRef.current = null;
          planWaypointsRef.current = nextWps;
          planLegsRef.current = nextLegs;
          setDisconnectedCandidate(null);
          setPlanWaypoints(nextWps);
          setPlanLegs(nextLegs);
          void recomputePlanElevationStats(nextLegs, nextWps);
        } finally {
          isRoutingLegRef.current = false;
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
    disconnectedCandidateRef.current = null;
    planWaypointsRef.current = nextWps;
    planLegsRef.current = nextLegs;
    setDisconnectedCandidate(null);
    setPlanWaypoints(nextWps);
    setPlanLegs(nextLegs);
    void recomputePlanElevationStats(nextLegs, nextWps);
  }, [recomputePlanElevationStats]);

  const handleCancelDisconnected = useCallback(() => {
    disconnectedCandidateRef.current = null;
    setDisconnectedCandidate(null);
  }, []);

  const handleUndoLastPlanPoint = useCallback(() => {
    if (disconnectedCandidateRef.current) {
      disconnectedCandidateRef.current = null;
      setDisconnectedCandidate(null);
      return;
    }
    const prevWps = planWaypointsRef.current;
    if (prevWps.length === 0) return;
    const nextWps = prevWps.slice(0, -1);
    const nextLegs = nextWps.length <= 1 ? [] : planLegsRef.current.slice(0, -1);
    planWaypointsRef.current = nextWps;
    planLegsRef.current = nextLegs;
    setPlanWaypoints(nextWps);
    setPlanLegs(nextLegs);
    void recomputePlanElevationStats(nextLegs, nextWps);
  }, [recomputePlanElevationStats]);

  const handleClearPlan = useCallback(() => {
    snapSeqRef.current += 1;
    planElevSeqRef.current += 1;
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
        selectedPoiRef.current,
        routeDisplayContextRef.current
      );
    }
  }, [syncOverlaySourcesToMap]);

  const handleRemovePlanWaypoint = useCallback(
    async (removeIdx: number) => {
      if (isRoutingLegRef.current) return;
      const prevWps = planWaypointsRef.current;
      const prevLegs = planLegsRef.current;
      if (removeIdx < 0 || removeIdx >= prevWps.length) return;
      if (prevWps.length <= 1) {
        handleClearPlan();
        return;
      }

      disconnectedCandidateRef.current = null;
      setDisconnectedCandidate(null);

      if (removeIdx === 0) {
        const nextWps = prevWps.slice(1).map((wp, idx) =>
          idx === 0 ? { ...wp, legType: undefined } : wp
        );
        const nextLegs = prevLegs.slice(1);
        planWaypointsRef.current = nextWps;
        planLegsRef.current = nextLegs;
        setPlanWaypoints(nextWps);
        setPlanLegs(nextLegs);
        void recomputePlanElevationStats(nextLegs, nextWps);
        return;
      }

      if (removeIdx === prevWps.length - 1) {
        const nextWps = prevWps.slice(0, -1);
        const nextLegs = prevLegs.slice(0, -1);
        planWaypointsRef.current = nextWps;
        planLegsRef.current = nextLegs;
        setPlanWaypoints(nextWps);
        setPlanLegs(nextLegs);
        void recomputePlanElevationStats(nextLegs, nextWps);
        return;
      }

      // Bridge prevWps[removeIdx - 1] -> prevWps[removeIdx + 1]
      const leftWp = prevWps[removeIdx - 1];
      const rightWp = prevWps[removeIdx + 1];
      const preferStraight =
        prevLegs[removeIdx - 1]?.legType === 'straight' ||
        prevLegs[removeIdx]?.legType === 'straight';
      const straightDistKm = Number(
        turf
          .distance(turf.point([leftWp.lon, leftWp.lat]), turf.point([rightWp.lon, rightWp.lat]), {
            units: 'kilometers',
          })
          .toFixed(3)
      );

      let bridgedLeg: PlannedLeg;
      if (preferStraight) {
        bridgedLeg = {
          coordinates: [
            [leftWp.lon, leftWp.lat],
            [rightWp.lon, rightWp.lat],
          ],
          distanceKm: straightDistKm,
          legType: 'straight',
          roadLabels: [rightWp.roadLabel || 'קו ישר'],
        };
      } else {
        isRoutingLegRef.current = true;
        setIsRoutingLeg(true);
        try {
          const res = await routePlannerEngine.routeBetweenSnappedPoints(
            leftWp,
            rightWp,
            planningModeRef.current
          );
          if (res.found) {
            bridgedLeg = {
              coordinates: res.coordinates,
              distanceKm: res.distanceKm,
              legType: 'network',
              roadLabels: res.roadLabels,
            };
          } else {
            bridgedLeg = {
              coordinates: [
                [leftWp.lon, leftWp.lat],
                [rightWp.lon, rightWp.lat],
              ],
              distanceKm: straightDistKm,
              legType: 'straight',
              roadLabels: [rightWp.roadLabel || 'קו ישר'],
            };
            showToast('לא נמצא חיבור דרכים לאחר מחיקת הנקודה — המקטע חובר בקו ישר');
          }
        } finally {
          isRoutingLegRef.current = false;
          setIsRoutingLeg(false);
        }
      }

      const updatedRightWp: PlannedWaypoint = { ...rightWp, legType: bridgedLeg.legType };
      const nextWps = [
        ...prevWps.slice(0, removeIdx),
        updatedRightWp,
        ...prevWps.slice(removeIdx + 2),
      ];
      const nextLegs = [
        ...prevLegs.slice(0, removeIdx - 1),
        bridgedLeg,
        ...prevLegs.slice(removeIdx + 1),
      ];
      planWaypointsRef.current = nextWps;
      planLegsRef.current = nextLegs;
      setPlanWaypoints(nextWps);
      setPlanLegs(nextLegs);
      void recomputePlanElevationStats(nextLegs, nextWps);
    },
    [handleClearPlan, recomputePlanElevationStats, showToast]
  );

  const handleTogglePlanLegType = useCallback(
    async (legIdx: number) => {
      if (isRoutingLegRef.current) return;
      const prevWps = planWaypointsRef.current;
      const prevLegs = planLegsRef.current;
      if (legIdx < 0 || legIdx >= prevLegs.length || legIdx + 1 >= prevWps.length) return;

      const curLeg = prevLegs[legIdx];
      const fromWp = prevWps[legIdx];
      const toWp = prevWps[legIdx + 1];
      let nextLeg: PlannedLeg;

      if (curLeg.legType === 'network') {
        const distKm = Number(
          turf
            .distance(turf.point([fromWp.lon, fromWp.lat]), turf.point([toWp.lon, toWp.lat]), {
              units: 'kilometers',
            })
            .toFixed(3)
        );
        nextLeg = {
          coordinates: [
            [fromWp.lon, fromWp.lat],
            [toWp.lon, toWp.lat],
          ],
          distanceKm: distKm,
          legType: 'straight',
          roadLabels: [toWp.roadLabel || 'קו ישר'],
        };
      } else {
        isRoutingLegRef.current = true;
        setIsRoutingLeg(true);
        try {
          const res = await routePlannerEngine.routeBetweenSnappedPoints(
            fromWp,
            toWp,
            planningModeRef.current
          );
          if (!res.found) {
            showToast('לא נמצא חיבור ברשת הדרכים למקטע זה — נשאר בקו ישר');
            return;
          }
          nextLeg = {
            coordinates: res.coordinates,
            distanceKm: res.distanceKm,
            legType: 'network',
            roadLabels: res.roadLabels,
          };
        } finally {
          isRoutingLegRef.current = false;
          setIsRoutingLeg(false);
        }
      }

      const nextLegs = prevLegs.map((l, idx) => (idx === legIdx ? nextLeg : l));
      const nextWps = prevWps.map((wp, idx) =>
        idx === legIdx + 1 ? { ...wp, legType: nextLeg.legType } : wp
      );
      planWaypointsRef.current = nextWps;
      planLegsRef.current = nextLegs;
      setPlanWaypoints(nextWps);
      setPlanLegs(nextLegs);
      void recomputePlanElevationStats(nextLegs, nextWps);
    },
    [recomputePlanElevationStats, showToast]
  );

  const handleEditRouteInPlanner = useCallback(
    async (rawRoute: SavedRouteRecord) => {
      if (rawRoute.ownership === 'shared') {
        showToast('מסלול משותף הוא לקריאה בלבד — לחץ "שמור עותק אצלי" כדי לערוך');
        return;
      }
      const route = (await RouteManager.loadFullRoute(rawRoute)) || rawRoute;
      handleHoverElevationChart(null);
      const mode: PlanningMode = route.planningMode || 'foot';
      const lineFeatures: Array<GeoJSON.Feature<GeoJSON.LineString>> = [];
      for (const f of route.geojson?.features || []) {
        if (f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 2) {
          lineFeatures.push(f as GeoJSON.Feature<GeoJSON.LineString>);
        } else if (f.geometry?.type === 'MultiLineString') {
          for (const ring of f.geometry.coordinates) {
            if (ring.length >= 2) {
              lineFeatures.push({
                type: 'Feature',
                properties: f.properties || {},
                geometry: { type: 'LineString', coordinates: ring },
              });
            }
          }
        }
      }

      let wps: PlannedWaypoint[] = (route.waypoints || []).map((wp) => ({ ...wp }));
      if (wps.length < 2) {
        const allCoords = lineFeatures.flatMap((lf) =>
          lf.geometry.coordinates.map((c) => [Number(c[0]), Number(c[1])] as [number, number])
        );
        if (allCoords.length < 2) {
          showToast('לא ניתן לפתוח מסלול ריק לעריכת נקודות');
          return;
        }
        wps = [
          { lon: allCoords[0][0], lat: allCoords[0][1], roadLabel: 'התחלה' },
          {
            lon: allCoords[allCoords.length - 1][0],
            lat: allCoords[allCoords.length - 1][1],
            roadLabel: 'סיום',
            legType: 'network',
          },
        ];
      }

      const legs: PlannedLeg[] = [];
      if (lineFeatures.length === wps.length - 1) {
        for (let i = 0; i < wps.length - 1; i++) {
          const lf = lineFeatures[i];
          const coords = lf.geometry.coordinates.map(
            (c) => [Number(c[0]), Number(c[1])] as [number, number]
          );
          const distKm = Number(turf.length(lf, { units: 'kilometers' }).toFixed(3));
          const legType = wps[i + 1].legType || 'network';
          legs.push({
            coordinates: coords,
            distanceKm: distKm,
            legType,
            roadLabels: wps[i + 1].roadLabel ? [wps[i + 1].roadLabel!] : [],
          });
        }
      } else {
        const flatCoords = lineFeatures.flatMap((lf) =>
          lf.geometry.coordinates.map((c) => [Number(c[0]), Number(c[1])] as [number, number])
        );
        const wpIndices: number[] = [];
        let cursor = 0;
        for (let w = 0; w < wps.length; w++) {
          let bestIdx = Math.min(cursor, Math.max(0, flatCoords.length - 1));
          let bestDistSq = Infinity;
          for (let j = cursor; j < flatCoords.length; j++) {
            const dx = flatCoords[j][0] - wps[w].lon;
            const dy = flatCoords[j][1] - wps[w].lat;
            const dSq = dx * dx + dy * dy;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              bestIdx = j;
            }
          }
          wpIndices.push(bestIdx);
          cursor = bestIdx;
        }

        for (let i = 0; i < wps.length - 1; i++) {
          const fromIdx = wpIndices[i];
          const toIdx = wpIndices[i + 1];
          const slice =
            toIdx > fromIdx && flatCoords.length > toIdx
              ? flatCoords.slice(fromIdx, toIdx + 1)
              : ([
                  [wps[i].lon, wps[i].lat],
                  [wps[i + 1].lon, wps[i + 1].lat],
                ] as Array<[number, number]>);
          const legCoords: Array<[number, number]> =
            slice.length >= 2
              ? slice
              : [
                  [wps[i].lon, wps[i].lat],
                  [wps[i + 1].lon, wps[i + 1].lat],
                ];
          const distKm = Number(
            turf.length(turf.lineString(legCoords), { units: 'kilometers' }).toFixed(3)
          );
          const legType = wps[i + 1].legType || 'network';
          legs.push({
            coordinates: legCoords,
            distanceKm: distKm,
            legType,
            roadLabels: wps[i + 1].roadLabel ? [wps[i + 1].roadLabel!] : [],
          });
        }
      }

      editingRouteIdRef.current = route.id;
      setEditingRouteId(route.id);
      planningModeRef.current = mode;
      setPlanningMode(mode);
      setPlanRouteName(route.name);
      disconnectedCandidateRef.current = null;
      setDisconnectedCandidate(null);
      setPlanPreviewPoint(null);
      setPlanCursorCoord(null);
      planWaypointsRef.current = wps;
      setPlanWaypoints(wps);
      planLegsRef.current = legs;
      setPlanLegs(legs);

      if (isMobileRef.current) {
        setMobileDisplayMode('planning');
        setMobilePlanningOverlay('plan-route');
        setMobileSheetExpanded(true);
      } else {
        setDesktopDrawer('plan-route');
      }
      handleFlyToRoute(route);
      void recomputePlanElevationStats(legs, wps);
    },
    [handleFlyToRoute, handleHoverElevationChart, recomputePlanElevationStats, showToast]
  );

  const handleCancelEditPlan = useCallback(() => {
    editingRouteIdRef.current = null;
    setEditingRouteId(null);
    setPlanRouteName('');
    handleClearPlan();
    if (isMobileRef.current) {
      setMobilePlanningOverlay(null);
      setMobileDisplayMode('planning');
      setMobileTab('routes');
      setMobileSheetExpanded(true);
    } else {
      setDesktopDrawer('routes');
    }
  }, [handleClearPlan]);

  const handleClosePlannerPanel = useCallback(() => {
    disconnectedCandidateRef.current = null;
    setDisconnectedCandidate(null);
    setPlanPreviewPoint(null);
    setPlanCursorCoord(null);
    if (isMobileRef.current) {
      setMobilePlanningOverlay(null);
    } else {
      setDesktopDrawer(null);
    }
  }, []);

  const handleChangePlanningMode = useCallback(
    (nextMode: PlanningMode) => {
      planningModeRef.current = nextMode;
      setPlanningMode(nextMode);
      disconnectedCandidateRef.current = null;
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
    if (isSavingPlan) return;
    if (activeRoutePromiseRef.current) {
      await activeRoutePromiseRef.current;
    }
    const wps = planWaypointsRef.current;
    const legs = planLegsRef.current;
    const mode = planningModeRef.current;
    const targetEditId = editingRouteIdRef.current;

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

      const savedLocal = targetEditId
        ? await RouteManager.updatePlannedRoute(targetEditId, {
            name: finalName,
            mode,
            segments,
            waypoints: wps,
            ownerUid: currentUser?.uid ?? null,
            ownerEmail: currentUser?.email ?? null,
            ownerDisplayName: currentUser?.displayName ?? null,
          })
        : await RouteManager.createAndSavePlannedRoute({
            name: finalName,
            mode,
            segments,
            waypoints: wps,
            ownerUid: currentUser?.uid ?? null,
            ownerEmail: currentUser?.email ?? null,
            ownerDisplayName: currentUser?.displayName ?? null,
          });

      const savedSummary = RouteManager.splitRouteRecord(savedLocal).summary;
      setRoutes((prev) =>
        prev.some((r) => r.id === savedSummary.id)
          ? prev.map((r) => (r.id === savedSummary.id ? savedSummary : r))
          : [...prev, savedSummary]
      );
      setActiveRoute(savedLocal);

      editingRouteIdRef.current = null;
      setEditingRouteId(null);
      disconnectedCandidateRef.current = null;
      planWaypointsRef.current = [];
      planLegsRef.current = [];
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

      if (currentUser && isOnline && AuthService.isAvailable()) {
        showToast(
          targetEditId
            ? `המסלול "${savedLocal.name}" עודכן ונשמר — מסנכרן לענן ברקע...`
            : `המסלול "${savedLocal.name}" נשמר — מסנכרן לענן ברקע...`
        );
        void PlannedTracksCloudService.savePlannedRouteToFirebase(savedLocal, currentUser).then(
          async (cloudRes) => {
            if (deletedRouteIdsRef.current.has(savedLocal.id)) {
              await RouteManager.deleteRoute(savedLocal.id);
              void PlannedTracksCloudService.deleteRemotePlannedRoute(cloudRes.route, currentUser);
              return;
            }
            const finalRecord = cloudRes.route;
            const finalSummary = RouteManager.splitRouteRecord(finalRecord).summary;
            setRoutes((prev) => prev.map((r) => (r.id === finalRecord.id ? finalSummary : r)));
            setActiveRoute((cur) =>
              cur?.id === finalRecord.id ? RouteManager.getCachedFullRoute(finalRecord.id) || finalRecord : cur
            );

            if (cloudRes.synced) {
              showToast(`המסלול "${finalRecord.name}" נשמר כ-GPX וב-planing_tracks!`);
            } else {
              showToast(`נשמר מקומית כ-GPX (סנכרון ענן נדחה: ${cloudRes.error || 'שגיאה'})`);
            }
          }
        );
      } else if (!AuthService.isAvailable()) {
        showToast(`המסלול "${savedLocal.name}" נשמר מקומית כ-GPX`);
      } else if (!currentUser) {
        showToast('המסלול נשמר מקומית כ-GPX — התחבר עם Gmail לגיבוי ב-planing_tracks');
      } else {
        showToast('אופליין: המסלול נשמר כ-GPX במכשיר ויסונכרן עם החזרה לרשת');
      }
    } catch (err: any) {
      showToast(err?.message || 'שגיאה בשמירת המסלול');
    } finally {
      setIsSavingPlan(false);
    }
  }, [isSavingPlan, planRouteName, currentUser, isOnline, showToast]);

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
      if (currentUser) {
        writeStoredLastAuthUid(currentUser.uid);
        if (isOnline) {
          await PlannedTracksCloudService.syncPendingRoutesForUser(currentUser).catch(
            () => undefined
          );
          if (UserStateSyncService.hasDirtyCloudChanges()) {
            await UserStateSyncService.flushCloudPush(currentUser);
          }
        }
      }
      resetRouteSessionState();
      setRoutes((prev) => prev.filter((r) => RouteManager.isRouteVisibleForUser(r, null)));
      await AuthService.signOut();
      await RouteManager.purgeOtherUsersCachedRoutes(null);
      setCurrentUser(null);
      setRoutes(await RouteManager.listRouteSummaries(null));
      showToast('התנתקת מחשבון Google');
    } finally {
      setIsAuthBusy(false);
    }
  }, [currentUser, isOnline, resetRouteSessionState, showToast]);

  const handleSyncPendingNow = useCallback(async () => {
    if (!currentUser) return;
    setIsSyncingCloud(true);
    try {
      const map = mapRef.current;
      if (map) {
        try {
          const c = map.getCenter();
          recordCameraIfChanged(
            {
              lon: c.lng,
              lat: c.lat,
              zoom: map.getZoom(),
              bearing: map.getBearing(),
              pitch: map.getPitch(),
            },
            1500
          );
        } catch {
          // Ignore if map is unavailable
        }
      }
      const [count, merged] = await Promise.all([
        PlannedTracksCloudService.syncPendingRoutesForUser(currentUser),
        UserStateSyncService.pullAndMergeCloudState(currentUser),
        UserDirectoryService.registerCurrentUser(currentUser),
      ]);
      if (merged) {
        applyRemoteMergedState(merged);
        setLastSyncedAt(merged.merged.lastSyncedAt || new Date().toISOString());
      } else if (UserStateSyncService.hasDirtyCloudChanges()) {
        const pushed = await UserStateSyncService.flushCloudPush(currentUser);
        if (pushed) {
          setLastSyncedAt(new Date().toISOString());
        }
      }
      const all = (await RouteManager.listRouteSummaries(currentUser.uid)).filter(
        (r) => !deletedRouteIdsRef.current.has(r.id)
      );
      setRoutes(all);
      showToast(
        count > 0
          ? `סונכרנו ${count} מסלולים והגדרות לחשבון Google`
          : 'מיקום והגדרות מסונכרנים בענן'
      );
    } catch (err: any) {
      showToast(err?.message || 'שגיאת סנכרון');
    } finally {
      setIsSyncingCloud(false);
    }
  }, [currentUser, showToast, applyRemoteMergedState, recordCameraIfChanged]);

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
      const latestFrame = navSmootherRef.current?.getLatestFrame();
      const startPt: [number, number] = latestFrame
        ? [Number(latestFrame.kalmanLon.toFixed(6)), Number(latestFrame.kalmanLat.toFixed(6))]
        : userLocation
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
      ownerUid: currentUser?.uid ?? null,
      ownerEmail: currentUser?.email ?? null,
      ownerDisplayName: currentUser?.displayName ?? null,
    });
    setRoutes((prev) => [...prev, RouteManager.splitRouteRecord(saved).summary]);
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

  const osmInfoRef = useRef<MountedArchiveInfo | null>(osmInfo);
  osmInfoRef.current = osmInfo;

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
    setExecutedSearchQuery('');
    setSearchResults([]);
  }, []);

  const handleRebuildSearchIndex = useCallback(() => {
    const currentOsm = osmInfoRef.current;
    if (currentOsm) {
      void pmtilesSearchService.rebuildFromPmtiles(currentOsm.pmtiles);
    }
  }, []);

  const handleOpenMobileOffline = useCallback(() => {
    setMobileDisplayMode('planning');
    setMobileTab('offline');
    setMobilePlanningOverlay(null);
  }, []);

  const handleToggleDesktopRoutes = useCallback(() => {
    setDesktopDrawer((prev) => (prev === 'routes' ? null : 'routes'));
  }, []);

  const handleSelectSearchResultRef = useRef<(item: SearchResultItem) => void>(() => {});
  handleSelectSearchResultRef.current = handleSelectSearchResult;
  const handleSelectSearchResultStable = useCallback((item: SearchResultItem) => {
    handleSelectSearchResultRef.current(item);
  }, []);

  const isSearchingPending =
    searchQuery.trim().length > 0 && searchQuery.trim() !== executedSearchQuery.trim();

  const renderSearchBar = (compactMobile: boolean) => (
    <SearchBar
      compactMobile={compactMobile}
      theme={theme}
      containerRef={searchContainerRef}
      searchQuery={searchQuery}
      onChangeSearchQuery={setSearchQuery}
      searchFilter={searchFilter}
      onChangeSearchFilter={setSearchFilter}
      searchResults={searchResults}
      isSearching={isSearchingPending}
      searchStatus={searchStatus}
      activeSearchIndex={activeSearchIndex}
      onChangeActiveSearchIndex={setActiveSearchIndex}
      isSearchFocused={isSearchFocused}
      onChangeSearchFocused={setIsSearchFocused}
      onClearSearch={handleClearSearch}
      onSelectResult={handleSelectSearchResultStable}
      onRebuildIndex={handleRebuildSearchIndex}
      hasOsmInfo={Boolean(osmInfo)}
      isOfflineReady={isOfflineReady}
      isOnline={isOnline}
      onOpenMobileOffline={handleOpenMobileOffline}
      onToggleDesktopRoutes={handleToggleDesktopRoutes}
    />
  );

  const renderNavOrientationIconButton = (mobile = false) => {
    const headingActive = navOrientation === 'heading-up';
    const nextMode: MapNavigationOrientation = headingActive ? 'north-up' : 'heading-up';
    const label = headingActive
      ? 'כיוון מפה: כיוון תנועה — לחץ למעבר לצפון למעלה'
      : 'כיוון מפה: צפון למעלה — לחץ למעבר לכיוון התנועה';

    return (
      <button
        type="button"
        onClick={() => handleChangeNavOrientation(nextMode)}
        aria-label={label}
        aria-pressed={headingActive}
        title={label}
        className={`${
          mobile ? 'w-11 h-11 rounded-full mb-0.5' : 'w-10 h-10 rounded-xl'
        } border shadow-xl flex items-center justify-center transition-all shrink-0 ${
          headingActive
            ? `${t.pillBtn} border-sky-500/80 ring-2 ring-sky-500/25 ${
                theme === 'topo-dark' ? 'text-sky-400' : 'text-sky-600'
              }`
            : `${t.pillBtn} border-rose-500/75 ring-2 ring-rose-500/20 ${
                theme === 'topo-dark' ? 'text-rose-400' : 'text-rose-600'
              }`
        }`}
      >
        {headingActive ? (
          <svg viewBox="0 0 24 24" className="w-5 h-5" aria-hidden="true">
            <path
              d="M12 2.5L4.5 20.5l7.5-3.6 7.5 3.6L12 2.5z"
              fill="currentColor"
            />
          </svg>
        ) : (
          <svg
            viewBox="0 0 24 24"
            className="w-5 h-5 transition-transform"
            style={{ transform: `rotate(${-mapBearing}deg)` }}
            aria-hidden="true"
          >
            <path
              d="M9.2 7.5V2.5h1.3l3 3.5V2.5h1.3v5h-1.3l-3-3.5v3.5H9.2z"
              fill="#e11d48"
            />
            <polygon points="12,8.8 15.2,15.4 8.8,15.4" fill="#e11d48" />
            <polygon points="12,22 15.2,15.4 8.8,15.4" fill="#64748b" opacity="0.75" />
          </svg>
        )}
      </button>
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
                      onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 15.2)}
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
                      routeDisplayMode={resolvedRouteDisplay.mode}
                      backgroundRouteIds={pinnedBackgroundRouteIds}
                      unseenSharedCount={unseenSharedCount}
                      onSelectRoute={handleSelectRoute}
                      onStartNavigation={handleStartRouteNavigation}
                      onStopNavigation={handleStopRouteNavigation}
                      onOpenImporter={() => setIsStorageOpen(true)}
                      onOpenRoutePlanner={() => setDesktopDrawer('plan-route')}
                      onDeleteRoute={handleDeleteRoute}
                      onShareRoute={handleOpenShareModal}
                      onViewSharedTab={() => setUnseenSharedCount(0)}
                      onDuplicateSharedRoute={handleDuplicateSharedRoute}
                      onDismissSharedRoute={handleDismissSharedRoute}
                      onRenameRoute={handleRenameRoute}
                      onChangeRouteColor={handleChangeRouteColor}
                      onToggleRouteVisibility={handleToggleRouteVisibility}
                      onToggleBackgroundRoute={handleToggleBackgroundRoute}
                      onClearBackgroundRoutes={handleClearBackgroundRoutes}
                      onReverseRoute={handleReverseRoute}
                      onEditRouteInPlanner={handleEditRouteInPlanner}
                      onClose={() => setDesktopDrawer(null)}
                      onHoverPoint={handleHoverElevationChart}
                      onSelectPoint={(pt) =>
                        handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                      }
                      onFlyToRoute={handleFlyToRoute}
                      onFitAllRoutes={() => {
                        const visibleTargets = [
                          ...(resolvedRouteDisplay.activeRouteToDisplay
                            ? [resolvedRouteDisplay.activeRouteToDisplay]
                            : []),
                          ...resolvedRouteDisplay.backgroundRoutesToDisplay,
                        ];
                        fitBoundsToRoutes(visibleTargets.length > 0 ? visibleTargets : routes);
                      }}
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
                      isEditingExisting={Boolean(editingRouteId)}
                      editingRouteColor={editingRouteColor}
                      backgroundRoutesCount={pinnedBackgroundRouteIds.length}
                      showBackgroundRoutes={showBackgroundInPlanner}
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
                      onRemoveWaypoint={handleRemovePlanWaypoint}
                      onToggleLegType={handleTogglePlanLegType}
                      onToggleShowBackgroundRoutes={() => setShowBackgroundInPlanner((v) => !v)}
                      onClearBackgroundRoutes={handleClearBackgroundRoutes}
                      onClearPlan={handleClearPlan}
                      onCancelEdit={handleCancelEditPlan}
                      onFinishAndSave={handleFinishPlanningRoute}
                      onSignInGoogle={handleSignInGoogle}
                      onSignOutGoogle={handleSignOutGoogle}
                      onSyncPendingNow={handleSyncPendingNow}
                      onClose={handleClosePlannerPanel}
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

            {/* Top-Left (RTL End): Active Nav Alert + Orientation Switch + Offline Readiness + Quick Action Pills */}
            <div className="absolute top-3 left-3 z-30 max-w-[calc(100vw-408px)] flex flex-wrap items-center gap-2 pointer-events-auto">
              {isNavigatingRoute && activeRoute ? (
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
                        {isScreenWakeLockActive ? ' • מסך דולק' : ''}
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
              ) : isFreeNavigation ? (
                <div className="px-3.5 py-2 rounded-full border shadow-xl text-xs font-bold flex items-center gap-2 bg-emerald-600 border-emerald-400 text-white">
                  <Navigation className="w-4 h-4" />
                  <span>
                    מצב ניווט פעיל
                    {isScreenWakeLockActive ? ' • מסך דולק' : ''}
                  </span>
                  <button
                    onClick={handleStopRouteNavigation}
                    className="px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 text-xs"
                  >
                    סיים
                  </button>
                </div>
              ) : null}

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
                  onClick={handleToggleDesktopFreeNavigation}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    isNavigationActive ? 'bg-emerald-600 text-white' : t.hoverRow
                  }`}
                  title={isNavigationActive ? 'צא ממצב ניווט' : 'התחל מצב ניווט חי (כיוון מפה + שמירת מסך דולק)'}
                >
                  <Navigation
                    className={`w-3.5 h-3.5 ${isNavigationActive ? 'text-white' : 'text-emerald-500'}`}
                  />
                  <span>ניווט</span>
                </button>

                <button
                  onClick={() => setDesktopDrawer(desktopDrawer === 'routes' ? null : 'routes')}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors relative ${
                    desktopDrawer === 'routes' ? 'bg-emerald-600 text-white' : t.hoverRow
                  }`}
                >
                  <RouteIcon className="w-3.5 h-3.5 text-emerald-500" />
                  <span>מסלולים</span>
                  {unseenSharedCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-violet-600 text-white text-[10px] font-bold leading-none">
                      +{unseenSharedCount}
                    </span>
                  )}
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
                    visibility.googleSatellite
                      ? 'bg-gradient-to-br from-slate-900 via-emerald-950 to-sky-900 text-sky-300'
                      : theme === 'topo-day'
                        ? 'bg-gradient-to-br from-[#f4efe2] via-amber-200/70 to-emerald-200 text-amber-950'
                        : 'bg-gradient-to-br from-slate-900 via-slate-800 to-sky-950 text-sky-300'
                  }`}
                >
                  {visibility.googleSatellite ? (
                    <Satellite className="w-5 h-5" />
                  ) : theme === 'topo-day' ? (
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

                {!isNavigationActive && (
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
                )}

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
                  onClick={() => setIsUserIconPickerOpen((v) => !v)}
                  className={`w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${
                    isUserIconPickerOpen ? 'border-emerald-500 ring-2 ring-emerald-500/40' : ''
                  } ${t.pillBtn}`}
                  title={`שנה אייקון מיקום (${userIconPref.icon.labelHe})`}
                >
                  <UserLocationIconBadge
                    icon={userIconPref.icon}
                    accentColor={userIconPref.accentColor}
                    size="sm"
                  />
                </button>

                {isNavigationActive && renderNavOrientationIconButton(false)}

                <button
                  onClick={handleLocateMe}
                  className={`w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${
                    isFollowingUser && userLocation
                      ? 'bg-sky-600 border-sky-400 text-white'
                      : t.pillBtn
                  }`}
                  title={
                    isFollowingUser && userLocation
                      ? 'מעקב מיקום רציף פעיל'
                      : userLocation
                        ? 'מרכז ונעל מעקב מיקום רציף (GPS)'
                        : 'מאתר מיקום GPS רציף...'
                  }
                >
                  <LocateFixed
                    className={`w-4 h-4 ${
                      isFollowingUser && userLocation
                        ? 'text-white'
                        : userLocation
                          ? 'text-sky-500'
                          : 'text-slate-400 animate-pulse'
                    }`}
                  />
                </button>

                <GoogleAccountButton
                  currentUser={currentUser}
                  firebaseAvailable={AuthService.isAvailable()}
                  isAuthBusy={isAuthBusy}
                  isOnline={isOnline}
                  isSyncingCloud={isSyncingCloud}
                  lastSyncedAt={lastSyncedAt}
                  theme={theme}
                  onSignInGoogle={handleSignInGoogle}
                  onSignOutGoogle={handleSignOutGoogle}
                  onSyncNow={handleSyncPendingNow}
                />
              </div>
            </div>

            {/* User Position Icon Picker Floating Popover */}
            <UserIconPickerSheet
              isOpen={isUserIconPickerOpen}
              theme={theme}
              preference={userIconPref}
              isOnline={isOnline}
              hasGpsFix={Boolean(userLocation)}
              onLocateOnMap={handleLocateMe}
              onSelectPreference={handleUserIconPreferenceChange}
              onClose={() => setIsUserIconPickerOpen(false)}
            />

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
            {/* MODE B: NAVIGATING — No Search, No Chips! Compact Icon Navigation Status + Planning Icon */}
            {mobileDisplayMode === 'navigating' && (
              <div className="absolute top-3 right-3 left-3 z-30 pt-safe pointer-events-none">
                {isNavigatingRoute && activeRoute ? (
                  <div
                    className={`p-2.5 rounded-2xl shadow-2xl flex items-center justify-between gap-2 text-xs font-bold backdrop-blur-md pointer-events-auto ${
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
                      type="button"
                      onClick={() => {
                        setIsFreeNavigation(false);
                        setMobileDisplayMode('planning');
                        setMobileTab('routes');
                        setMobileNavOverlay(null);
                      }}
                      aria-label="תכנון וחיפוש"
                      title="תכנון וחיפוש"
                      className="w-9 h-9 rounded-xl bg-slate-950/35 hover:bg-slate-950/50 text-white flex items-center justify-center shrink-0 transition-colors"
                    >
                      <MapIcon className="w-4 h-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    {(() => {
                      const navStatLabel = isRecordingTrack
                        ? `מקליט ${formatDuration(recordElapsedSeconds)}`
                        : isScreenWakeLockActive
                          ? 'מצב ניווט • מסך דולק'
                          : 'מצב ניווט • GPS';
                      return (
                        <button
                          type="button"
                          onClick={() => showToast(navStatLabel)}
                          aria-label={navStatLabel}
                          title={navStatLabel}
                          className={`w-10 h-10 rounded-full border shadow-lg flex items-center justify-center relative pointer-events-auto transition-all ${t.panel}`}
                        >
                          <Navigation
                            className={`w-4 h-4 ${
                              isRecordingTrack && !isRecordingPaused
                                ? 'text-rose-500'
                                : 'text-emerald-500'
                            }`}
                          />
                          <span
                            className={`absolute top-1.5 right-1.5 w-2 h-2 rounded-full border border-white ${
                              isRecordingTrack && !isRecordingPaused
                                ? 'bg-rose-500 animate-pulse'
                                : 'bg-emerald-500'
                            }`}
                          />
                        </button>
                      );
                    })()}

                    <button
                      type="button"
                      onClick={() => {
                        setIsFreeNavigation(false);
                        setMobileDisplayMode('planning');
                        setMobileNavOverlay(null);
                      }}
                      aria-label="תכנון וחיפוש"
                      title="תכנון וחיפוש"
                      className={`w-10 h-10 rounded-full border shadow-lg flex items-center justify-center pointer-events-auto transition-all ${t.panel}`}
                    >
                      <MapIcon className="w-4 h-4 text-emerald-500" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Mobile Top-Left Horizontal Controls (Layers, 3D, Compass when rotated outside nav, Crosshair) */}
            <div
              dir="ltr"
              className={`absolute left-3 z-20 flex flex-row items-center gap-2 pointer-events-auto pt-safe ${
                mobileDisplayMode === 'navigating'
                  ? isNavigatingRoute && activeRoute
                    ? 'top-[5.25rem]'
                    : 'top-[4rem]'
                  : 'top-[4.5rem]'
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

              {!isNavigationActive && Math.abs(mapBearing) > 2 && (
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

            {/* Mobile Bottom-Left Compact 2-Column Thumb FABs (Locate GPS + Google | User Icon + Add Pin | Nav Orientation) */}
            <div
              dir="ltr"
              className="absolute bottom-3 left-3 z-20 flex items-end gap-2 pointer-events-auto"
            >
              <div className="flex flex-col items-center gap-2">
                <button
                  onClick={handleLocateMe}
                  className={`w-12 h-12 rounded-full shadow-xl flex items-center justify-center transition-all ${
                    isFollowingUser && userLocation
                      ? 'bg-sky-600 hover:bg-sky-500 ring-2 ring-sky-300/80 text-white'
                      : userLocation
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                        : 'bg-slate-800/95 border border-slate-600 text-sky-400'
                  }`}
                  title={
                    isFollowingUser && userLocation
                      ? 'מעקב מיקום רציף פעיל'
                      : userLocation
                        ? 'מרכז ונעל מעקב מיקום רציף (GPS)'
                        : 'מאתר מיקום GPS רציף...'
                  }
                >
                  <LocateFixed className={`w-5 h-5 ${!userLocation ? 'animate-pulse' : ''}`} />
                </button>

                <GoogleAccountButton
                  currentUser={currentUser}
                  firebaseAvailable={AuthService.isAvailable()}
                  isAuthBusy={isAuthBusy}
                  isOnline={isOnline}
                  isSyncingCloud={isSyncingCloud}
                  lastSyncedAt={lastSyncedAt}
                  theme={theme}
                  mobile
                  onSignInGoogle={handleSignInGoogle}
                  onSignOutGoogle={handleSignOutGoogle}
                  onSyncNow={handleSyncPendingNow}
                />
              </div>

              <div className="flex flex-col items-center gap-2">
                <button
                  onClick={() => {
                    if (mobileDisplayMode === 'navigating') {
                      setMobileNavOverlay(mobileNavOverlay === 'user-icon' ? null : 'user-icon');
                    } else {
                      setMobilePlanningOverlay(mobilePlanningOverlay === 'user-icon' ? null : 'user-icon');
                    }
                  }}
                  className={`w-11 h-11 rounded-full border shadow-xl flex items-center justify-center transition-all ${
                    (mobileDisplayMode === 'navigating'
                      ? mobileNavOverlay === 'user-icon'
                      : mobilePlanningOverlay === 'user-icon')
                      ? 'border-emerald-500 ring-2 ring-emerald-500/50'
                      : ''
                  } ${t.pillBtn}`}
                  title={`שנה אייקון מיקום (${userIconPref.icon.labelHe})`}
                >
                  <UserLocationIconBadge
                    icon={userIconPref.icon}
                    accentColor={userIconPref.accentColor}
                    size="sm"
                  />
                </button>

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
                  <Plus className={`w-5 h-5 ${isAddingPoiMode ? 'text-white' : 'text-sky-500'}`} />
                </button>
              </div>

              {isNavigationActive && renderNavOrientationIconButton(true)}
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

      {/* MODE A: PLANNING — Search Pill & Dropdown Overlay (rendered outside flex-1 overflow-hidden so Android keyboard resize never clips results) */}
      {isMobile && mobileDisplayMode === 'planning' && (
        <div className="absolute top-3 right-3 left-3 z-[45] pt-safe pointer-events-none">
          <div className="pointer-events-auto">{renderSearchBar(true)}</div>
        </div>
      )}

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
                  onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 15.2)}
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
            ) : mobilePlanningOverlay === 'user-icon' ? (
              <UserIconPickerSheet
                isOpen
                embedded
                theme={theme}
                preference={userIconPref}
                isOnline={isOnline}
                hasGpsFix={Boolean(userLocation)}
                onLocateOnMap={handleLocateMe}
                onSelectPreference={handleUserIconPreferenceChange}
                onClose={() => setMobilePlanningOverlay(null)}
              />
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
                    isEditingExisting={Boolean(editingRouteId)}
                    editingRouteColor={editingRouteColor}
                    backgroundRoutesCount={pinnedBackgroundRouteIds.length}
                    showBackgroundRoutes={showBackgroundInPlanner}
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
                    onRemoveWaypoint={handleRemovePlanWaypoint}
                    onToggleLegType={handleTogglePlanLegType}
                    onToggleShowBackgroundRoutes={() => setShowBackgroundInPlanner((v) => !v)}
                    onClearBackgroundRoutes={handleClearBackgroundRoutes}
                    onClearPlan={handleClearPlan}
                    onCancelEdit={handleCancelEditPlan}
                    onFinishAndSave={handleFinishPlanningRoute}
                    onSignInGoogle={handleSignInGoogle}
                    onSignOutGoogle={handleSignOutGoogle}
                    onSyncPendingNow={handleSyncPendingNow}
                    onClose={handleClosePlannerPanel}
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
                      style={{ backgroundColor: editingRouteColor || PLANNING_MODE_META[planningMode].color }}
                    />
                    <span className="truncate">
                      {PLANNING_MODE_META[planningMode].shortLabelHe} • <span dir="ltr">{planTotalDistanceKm.toFixed(2)} km</span> ({planWaypoints.length})
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
                  routeDisplayMode={resolvedRouteDisplay.mode}
                  backgroundRouteIds={pinnedBackgroundRouteIds}
                  unseenSharedCount={unseenSharedCount}
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
                  onShareRoute={handleOpenShareModal}
                  onViewSharedTab={() => setUnseenSharedCount(0)}
                  onDuplicateSharedRoute={handleDuplicateSharedRoute}
                  onDismissSharedRoute={handleDismissSharedRoute}
                  onRenameRoute={handleRenameRoute}
                  onChangeRouteColor={handleChangeRouteColor}
                  onToggleRouteVisibility={handleToggleRouteVisibility}
                  onToggleBackgroundRoute={handleToggleBackgroundRoute}
                  onClearBackgroundRoutes={handleClearBackgroundRoutes}
                  onReverseRoute={handleReverseRoute}
                  onEditRouteInPlanner={handleEditRouteInPlanner}
                  onClose={() => setMobileTab('explore')}
                  onHoverPoint={handleHoverElevationChart}
                  onSelectPoint={(pt) =>
                    handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                  }
                  onFlyToRoute={handleFlyToRoute}
                  onFitAllRoutes={() => {
                    const visibleTargets = [
                      ...(resolvedRouteDisplay.activeRouteToDisplay
                        ? [resolvedRouteDisplay.activeRouteToDisplay]
                        : []),
                      ...resolvedRouteDisplay.backgroundRoutesToDisplay,
                    ];
                    fitBoundsToRoutes(visibleTargets.length > 0 ? visibleTargets : routes);
                  }}
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
                currentUser={currentUser}
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
                        void NavigationHeadingService.requestCompassPermissionIfNeeded();
                        setMobileDisplayMode('navigating');
                        setMobileNavOverlay(null);
                        setIsFollowingUser(true);
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
              {
                id: 'routes' as const,
                label: 'מסלולים',
                icon: (
                  <span className="relative inline-flex">
                    <RouteIcon className="w-5 h-5" />
                    {unseenSharedCount > 0 && (
                      <span className="absolute -top-1 -right-2 px-1 min-w-[16px] h-4 rounded-full bg-violet-600 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                        {unseenSharedCount}
                      </span>
                    )}
                  </span>
                ),
              },
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
          {mobileNavOverlay === 'user-icon' ? (
            <UserIconPickerSheet
              isOpen
              embedded
              theme={theme}
              preference={userIconPref}
              isOnline={isOnline}
              hasGpsFix={Boolean(userLocation)}
              onLocateOnMap={handleLocateMe}
              onSelectPreference={handleUserIconPreferenceChange}
              onClose={() => setMobileNavOverlay(null)}
            />
          ) : mobileNavOverlay === 'layers' ? (
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
              onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 15.2)}
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
                  type="button"
                  onClick={() => {
                    if (!isRecordingTrack || isRecordingPaused) {
                      handleStartOrResumeRecording();
                    } else {
                      setIsRecordingPaused(true);
                    }
                  }}
                  className={`w-9 h-9 rounded-xl border text-xs font-bold flex items-center justify-center ${t.pillBtn}`}
                  title={isRecordingTrack && !isRecordingPaused ? 'השהה הקלטה' : 'התחל הקלטה'}
                  aria-label={isRecordingTrack && !isRecordingPaused ? 'השהה הקלטה' : 'התחל הקלטה'}
                >
                  {isRecordingTrack && !isRecordingPaused ? (
                    <Pause className="w-4 h-4 text-rose-500" />
                  ) : (
                    <Play className="w-4 h-4 text-emerald-500" />
                  )}
                </button>

                {isNavigatingRoute ? (
                  <button
                    type="button"
                    onClick={handleStopRouteNavigation}
                    className="px-3 h-9 rounded-xl text-xs font-bold text-white bg-red-600 hover:bg-red-500 flex items-center justify-center"
                  >
                    סיום
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setIsFreeNavigation(false);
                      setMobileDisplayMode('planning');
                    }}
                    aria-label="תכנון"
                    title="מצב תכנון"
                    className="w-9 h-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white flex items-center justify-center"
                  >
                    <PenTool className="w-4 h-4" />
                  </button>
                )}
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
        currentUser={currentUser}
        demInfo={demInfo}
        osmInfo={osmInfo}
        onArchivesUpdated={(nextDem, nextOsm) => {
          setDemInfo(nextDem);
          setOsmInfo(nextOsm);
        }}
        onPoisAndRoutesImported={handleImportedData}
      />

      {/* Route Sharing Modal (Gmail / Registered Users) */}
      {shareModalRoute && (
        <ShareRouteModal
          route={shareModalRoute}
          theme={theme}
          currentUser={currentUser}
          isOnline={isOnline}
          firebaseAvailable={AuthService.isAvailable()}
          isAuthBusy={isAuthBusy}
          onSignInGoogle={handleSignInGoogle}
          onUpdateRecipients={handleUpdateRouteSharing}
          onClose={() => setShareModalRouteId(null)}
        />
      )}
    </div>
  );
};

export default App;
