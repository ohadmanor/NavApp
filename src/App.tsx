import React, { Suspense, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import {
  Layers,
  Palette,
  HardDrive,
  LocateFixed,
  Route as RouteIcon,
  AlertTriangle,
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
  MapPin,
  MapPinned,
  Search,
  FolderTree,
  Radio,
  UploadCloud,
  ChevronDown,
  Pencil,
  Activity,
  X,
} from 'lucide-react';
import { pmtilesRegistry, type MountedArchiveInfo } from './core/pmtiles/PMTilesRegistry';
import { offlineDataFiles } from './core/pmtiles/OfflineDataFiles';
import {
  buildIsraelOutdoorStyle,
  applyLayerVisibilityToMap,
  applyHighwayOverrideFiltersToMap,
  buildPoiTieredLayerFilter,
  findFirstNonRttOverlayLayerId,
  getVectorPoiLayerCategory,
  isAerialOverlayActive,
  isMasterPoiActive,
  POI_STYLE_LAYER_IDS,
  HIGHWAY_LAYER_IDS,
  DEFAULT_LAYER_VISIBILITY,
  type MapStyleId,
  type OutdoorLayerVisibility,
} from './core/style/israelOutdoorStyle';
import {
  COMMUNITY_ROADS_SOURCE_ID,
  COMMUNITY_ROADS_LABEL_LAYER_ID,
  COMMUNITY_ROADS_LINE_LAYER_IDS,
  COMMUNITY_TRAILS_SOURCE_ID,
  COMMUNITY_TRAILS_LAYER_IDS,
  buildCommunityTrailLayerSpecs,
  ensureCommunityRoadLayersOnMap,
} from './core/style/communityTrailLayers';
import { PoiManager, type DeletedPoiUndoSnapshot } from './core/pois/PoiManager';
import {
  POI_CATEGORY_ZOOM_RULES,
  buildPoiIconExpression,
  buildPoiIconSizeExpression,
  buildPoiTextColorExpression,
} from './core/pois/poiTaxonomy';
import {
  RouteManager,
  isRecordedRouteFormat,
  resolveRouteDisplayColor,
} from './core/navigation/RouteManager';
import { GpxExportService } from './core/navigation/GpxExportService';
import { deriveRecordingMetaFromTimestamps } from './core/navigation/routeTelemetryHelpers';
import { CommunityPoiImporter } from './core/pois/CommunityPoiImporter';
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
  LOCATION_ONCE_TIMEOUT_MS,
  NORTH_BEARING_SNAP_TOLERANCE_DEG,
  is3dNorthMode,
  isPovNorthMode,
  normalizeBearingDeltaDeg,
  resolveLocationModeTransition,
  resolveNorthModeFromManualRotate,
  resolveNorthModeFromMapPitch,
  resolveNorthModeTransition,
  shouldRunGpsWatch,
  toMapNavOrientation,
  type LocationModeTransitionAction,
  type LocationTrackingMode,
  type NorthPovMode,
} from './core/navigation/MapControlModes';
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
  type PoiShareRecipient,
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
import { GlobalPoiCloudService } from './core/firebase/GlobalPoiCloudService';
import { PrivatePoiCloudService } from './core/firebase/PrivatePoiCloudService';
import {
  PlannedTracksCloudService,
  getDeletedPlannedRouteIds,
  markPlannedRouteDeleted,
  markSharedRouteDismissed,
} from './core/firebase/PlannedTracksCloudService';
import { UserDirectoryService } from './core/firebase/UserDirectoryService';
import {
  canUserDeletePoi,
  isOwnedPrivatePoi,
  isPrivatePoi,
} from './core/pois/poiPermissions';
import { PoiInspectorSheet } from './components/pois/PoiInspectorSheet';
import { AddPoiPanel } from './components/pois/AddPoiPanel';
import { PoiCategoryIcon } from './components/pois/PoiCategoryIcon';
const SharePoiModal = React.lazy(() =>
  import('./components/pois/SharePoiModal').then((m) => ({ default: m.SharePoiModal }))
);
const MapStorageModal = React.lazy(() =>
  import('./components/maps-manager/MapStorageModal').then((m) => ({ default: m.MapStorageModal }))
);
const ElevationProfileDrawer = React.lazy(() =>
  import('./components/navigation/ElevationProfileDrawer').then((m) => ({
    default: m.ElevationProfileDrawer,
  }))
);
const NavigationRecordingsPanel = React.lazy(() =>
  import('./components/navigation/NavigationRecordingsPanel').then((m) => ({
    default: m.NavigationRecordingsPanel,
  }))
);
import { SaveRecordingModal } from './components/navigation/SaveRecordingModal';
const PlanningTrailDbDrawer = React.lazy(() =>
  import('./components/navigation/PlanningTrailDbDrawer').then((m) => ({
    default: m.PlanningTrailDbDrawer,
  }))
);
const SendToPlanningDbModal = React.lazy(() =>
  import('./components/navigation/SendToPlanningDbModal').then((m) => ({
    default: m.SendToPlanningDbModal,
  }))
);
import { PlanningTrailManager } from './core/navigation/PlanningTrailManager';
import {
  ensureZofimRoutesSeeded,
  resolveZofimTrailFallback,
} from './core/navigation/seedZofimRoutes';
import type {
  TrailCategoryId,
  TrailDifficulty,
} from './core/navigation/PlanningTrailTaxonomy';
import type {
  PlanningFolderRecord,
  PlanningTrailRecord,
} from './core/db/NavDatabase';
const ShareRouteModal = React.lazy(() =>
  import('./components/navigation/ShareRouteModal').then((m) => ({ default: m.ShareRouteModal }))
);
const ShareLocationModal = React.lazy(() =>
  import('./components/sharing/ShareLocationModal').then((m) => ({
    default: m.ShareLocationModal,
  }))
);
import { PeerLocationInspector } from './components/sharing/PeerLocationInspector';
import {
  LiveLocationCloudService,
  loadPersistedShareConfig,
  savePersistedShareConfig,
  type LiveLocationRecord,
  type LiveLocationShareConfig,
} from './core/firebase/LiveLocationCloudService';
import { TrackRecorderPanel, formatDuration } from './components/navigation/TrackRecorderPanel';
import {
  RoutePlannerPanel,
  type PlannedLeg,
} from './components/navigation/RoutePlannerPanel';
import { LayerSwitcherSheet, type LayerSheetSection } from './components/map/LayerSwitcherSheet';
import { raiseRegionalTrailNamesAbove } from './core/style/regionalTrails';
import { SheetChromeHeader } from './components/ui/SheetChromeHeader';
import {
  UserIconPickerSheet,
  UserLocationIconBadge,
} from './components/map/UserIconPickerSheet';
import { SearchBar } from './components/search/SearchBar';
import {
  GoogleAccountButton,
  GoogleAccountMenuCard,
  GoogleGIcon,
} from './components/auth/GoogleAccountButton';
const CommunityRoadEditor = React.lazy(() =>
  import('./components/map/CommunityRoadEditor').then((m) => ({
    default: m.CommunityRoadEditor,
  }))
);
const OsmSyncPanel = React.lazy(() =>
  import('./components/map/OsmSyncPanel').then((m) => ({
    default: m.OsmSyncPanel,
  }))
);
import { completeOsmOAuthCallback } from './core/trails/OsmBrowserSyncService';
import type { CommunityRoadEditDraftInput } from './components/map/CommunityRoadEditor';
import {
  UserStateSyncService,
  type MergeUserStateResult,
  type SavedMapCamera,
  type SavedUserConfiguration,
} from './core/preferences/UserStateSyncService';
import { getSurfaceTheme, type MapTheme } from './components/ui/themeTokens';
import {
  getTrailMapReleaseId,
  trailAnnotationsCloudService,
} from './core/firebase/TrailAnnotationsCloudService';
import { communityRoadsCloudService } from './core/firebase/CommunityRoadsCloudService';
import {
  ROAD_SEGMENT_SNAP_METERS,
  ROAD_VERTEX_SNAP_METERS,
  snapPointToExistingRoads,
  type RoadSnapCandidate,
} from './core/routing/CommunityRoadSnapper';
import {
  buildCommunityRoadsGeoJSON,
  buildRemovedRoadFeatures,
  extractOverriddenOsmWayIds,
  filterTrailOverlayByCommunityRoads,
  isCommunityHighwayClass,
  isRemovedOsmRoad,
  type CommunityHighwayClass,
  type CommunityRoadRecord,
} from './core/trails/CommunityRoadTypes';
import { highwayWayGeometryService } from './core/trails/HighwayWayGeometryService';
import {
  trailWayIdFromMvtId,
  type TrailAnnotationSearchItem,
  type TrailWayCandidate,
  type TrailWayGeometry,
} from './core/trails/TrailAnnotationTypes';

type DesktopDrawerMode =
  | 'poi'
  | 'routes'
  | 'recordings'
  | 'planning-db'
  | 'record'
  | 'add-poi'
  | 'plan-route'
  | null;
const DESKTOP_DRAWER_TITLES: Record<string, string> = {
  poi: 'נקודת עניין',
  routes: 'מסלולים',
  recordings: 'הקלטות ניווט',
  'planning-db': 'מאגר תכנון מסלולים',
  'plan-route': 'תכנון מסלול',
  record: 'הקלטה',
  'add-poi': 'נקודה חדשה',
};

const LAYER_SECTION_BUTTONS: Array<{
  id: LayerSheetSection;
  title: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'style', title: 'סגנון מפה (יום / לילה)', Icon: Palette },
  { id: 'layers', title: 'שכבות מפה', Icon: Layers },
  { id: 'pois', title: 'נקודות עניין (POI)', Icon: MapPinned },
];

type MobileTab = 'explore' | 'routes' | 'recordings' | 'planning-db' | 'map-edit' | 'offline';
type MobileDisplayMode = 'planning' | 'navigating';
type MobileOverlayMode =
  | 'poi'
  | 'layers'
  | 'add-poi'
  | 'plan-route'
  | 'user-icon'
  | 'google-account'
  | null;
type MobileNavOverlay = 'poi-mini' | 'layers' | 'add-poi' | 'record' | 'user-icon' | 'google-account' | null;

const MOBILE_SHEET_TITLES: Record<string, string> = {
  poi: 'נקודת עניין',
  'poi-mini': 'נקודת עניין',
  'google-account': 'חשבון Google',
  'user-icon': 'אייקון מיקום',
  layers: 'שכבות וסגנון מפה',
  'add-poi': 'נקודה חדשה',
  'plan-route': 'תכנון מסלול',
  routes: 'מסלולים',
  recordings: 'הקלטות ניווט',
  'planning-db': 'מאגר תכנון מסלולים',
  'map-edit': 'עריכת מפה',
  offline: 'מפות אופליין וייבוא',
  record: 'הקלטת מסלול',
};

const LAST_AUTH_UID_STORAGE_KEY = 'navapp.lastAuthUid.v1';
const PINNED_ROUTES_STORAGE_KEY = 'navapp.pinnedBackgroundRoutes.v1';

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

function readStoredPinnedRouteIds(): string[] {
  try {
    const raw = window.localStorage.getItem(PINNED_ROUTES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)))
      : [];
  } catch {
    return [];
  }
}

function writeStoredPinnedRouteIds(ids: string[]): void {
  try {
    if (ids.length === 0) {
      window.localStorage.removeItem(PINNED_ROUTES_STORAGE_KEY);
    } else {
      window.localStorage.setItem(PINNED_ROUTES_STORAGE_KEY, JSON.stringify(ids));
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
  isNavigationActive = false,
  isSharingLive = false
): HTMLDivElement {
  const root = document.createElement('div');
  UserLocationIconService.renderMarkerElement(
    root,
    pref,
    heading,
    mapBearing,
    isNavigationActive,
    isSharingLive
  );
  return root;
}

function useIsMobile(breakpoint = 768): boolean {
  // Portrait phones are narrow; landscape phones are wide but short with a coarse (touch) pointer.
  // Both must get the mobile layout (not the website layout).
  const query = `(max-width: ${breakpoint - 1}px), (max-height: 500px) and (pointer: coarse)`;
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : typeof window !== 'undefined'
        ? window.innerWidth < breakpoint
        : false
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);

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

  const initialTrailBootRef = useRef<ReturnType<
    typeof trailAnnotationsCloudService.getBootOverlaySnapshot
  > | null>(null);
  if (initialTrailBootRef.current === null) {
    initialTrailBootRef.current = trailAnnotationsCloudService.getBootOverlaySnapshot();
  }

  // Core map & archive state
  const [isMapReady, setIsMapReady] = useState(false);
  const [demInfo, setDemInfo] = useState<MountedArchiveInfo | null>(null);
  const [isDemUnavailable, setIsDemUnavailable] = useState(false);
  const [osmInfo, setOsmInfo] = useState<MountedArchiveInfo | null>(null);
  const [trailOverlayGeoJSON, setTrailOverlayGeoJSON] = useState<GeoJSON.FeatureCollection>(
    () => initialTrailBootRef.current!.geojson
  );
  const [trailSearchItems, setTrailSearchItems] = useState<TrailAnnotationSearchItem[]>(
    () => initialTrailBootRef.current!.searchItems
  );
  const [showTrailOverlay, setShowTrailOverlay] = useState(true);
  const [mapStyleRevision, setMapStyleRevision] = useState(0);
  const [selectedTrailWay, setSelectedTrailWay] = useState<TrailWayGeometry | null>(null);
  const [trailWayCandidates, setTrailWayCandidates] = useState<TrailWayCandidate[]>([]);
  const [isTrailMarkingMode, setIsTrailMarkingMode] = useState(false);
  const [trailSubMode, setTrailSubMode] = useState<'add-road' | 'edit-road'>('edit-road');
  const [communityRoads, setCommunityRoads] = useState<CommunityRoadRecord[]>(() =>
    communityRoadsCloudService.getCachedRoads()
  );
  const [roadDraft, setRoadDraft] = useState<CommunityRoadEditDraftInput | null>(null);
  const [isDrawingRoad, setIsDrawingRoad] = useState(false);
  const [selectedRoadVertexIndex, setSelectedRoadVertexIndex] = useState<number | null>(null);
  const [roadSnapPreview, setRoadSnapPreview] = useState<RoadSnapCandidate | null>(null);
  const [selectedTrailAnnotationId, setSelectedTrailAnnotationId] = useState<string | null>(null);
  const [isOsmSyncOpen, setIsOsmSyncOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const p = window.location.pathname;
    const sp = new URLSearchParams(window.location.search);
    return p === '/osm-sync' || p === '/osm-callback' || sp.get('osmSync') === '1';
  });
  const [isOsmSyncFullPage, setIsOsmSyncFullPage] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const p = window.location.pathname;
    return p === '/osm-sync' || p === '/osm-callback';
  });
  const [isHandlingOsmCallback, setIsHandlingOsmCallback] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.location.pathname === '/osm-callback';
  });
  const [osmCallbackError, setOsmCallbackError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<OutdoorLayerVisibility>(() => ({
    ...initialConfig.visibility,
    terrain3d: false,
  }));
  const [theme, setTheme] = useState<MapTheme>(() => initialConfig.theme);
  const [mapStyle, setMapStyle] = useState<MapStyleId>(() => initialConfig.mapStyle);
  const [mapBearing, setMapBearing] = useState(0);

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
  // Mobile navigating mode has no permanent search pill: the search icon opens this box on demand.
  const [isNavSearchOpen, setIsNavSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement | null>(null);

  // Routes & Active Navigation
  const [routes, setRoutes] = useState<SavedRouteRecord[]>([]);
  const [activeRoute, setActiveRoute] = useState<SavedRouteRecord | null>(null);
  const [shareModalRouteId, setShareModalRouteId] = useState<string | null>(null);
  const [shareModalPoiId, setShareModalPoiId] = useState<string | null>(null);
  const [unseenSharedCount, setUnseenSharedCount] = useState(0);
  const [isNavigatingRoute, setIsNavigatingRoute] = useState(false);
  const [offRouteWarning, setOffRouteWarning] = useState<number | null>(null);
  const [remainingDistKm, setRemainingDistKm] = useState<number | null>(null);

  // Planning Trail DB (separate hierarchical folders + categories + difficulty library)
  const [planningFolders, setPlanningFolders] = useState<PlanningFolderRecord[]>([]);
  const [planningTrails, setPlanningTrails] = useState<PlanningTrailRecord[]>([]);
  const [selectedPlanningTrailId, setSelectedPlanningTrailId] = useState<string | null>(null);
  const [showPlanningFolderOnMap, setShowPlanningFolderOnMap] = useState(false);
  const [planningDbWidthPx, setPlanningDbWidthPx] = useState<number>(() =>
    typeof window !== 'undefined'
      ? Math.min(620, Math.max(440, Math.round(window.innerWidth * 0.44)))
      : 560
  );
  const [sendToPlanningRouteTarget, setSendToPlanningRouteTarget] =
    useState<SavedRouteRecord | null>(null);

  // UI Shell States (Desktop vs Mobile Planning/Navigating)
  const [desktopDrawer, setDesktopDrawer] = useState<DesktopDrawerMode>(null);
  const [desktopTopMenu, setDesktopTopMenu] = useState<'trails' | 'map-edit' | null>(null);
  const desktopTopMenuRef = useRef<HTMLDivElement | null>(null);
  const [isStorageOpen, setIsStorageOpen] = useState(false);
  const [layerSheetSection, setLayerSheetSection] = useState<LayerSheetSection | null>(null);
  const [mobileLayerSection, setMobileLayerSection] = useState<LayerSheetSection>('layers');
  const [mobileSpeedDial, setMobileSpeedDial] = useState<'map' | 'user' | null>(null);
  const mobileControlsRef = useRef<HTMLDivElement | null>(null);
  const [mobileDisplayMode, setMobileDisplayMode] = useState<MobileDisplayMode>('planning');
  const [mobileTab, setMobileTab] = useState<MobileTab>('explore');
  const [mobilePlanningOverlay, setMobilePlanningOverlay] = useState<MobileOverlayMode>(null);
  const [mobileNavOverlay, setMobileNavOverlay] = useState<MobileNavOverlay>(null);
  const [mobileSheetExpanded, setMobileSheetExpanded] = useState(true);
  // Minimize state for floating windows (content stays mounted, only hidden).
  const [isDesktopDrawerMinimized, setIsDesktopDrawerMinimized] = useState(false);
  const [isMobileSheetMinimized, setIsMobileSheetMinimized] = useState(false);

  // Connectivity & Continuous Live GPS Coordinates
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [userLocation, setUserLocation] = useState<LiveGpsFix | null>(null);
  const [locationMode, setLocationMode] = useState<LocationTrackingMode>('none');
  const [northMode, setNorthMode] = useState<NorthPovMode>('2d-north');
  const [isFollowingUser, setIsFollowingUser] = useState<boolean>(false);
  const [gpsWatchRestartSeq, setGpsWatchRestartSeq] = useState<number>(0);
  const [isScreenWakeLockActive, setIsScreenWakeLockActive] = useState<boolean>(false);
  const [isFreeNavigation, setIsFreeNavigation] = useState<boolean>(false);
  const [navOrientation, setNavOrientation] = useState<MapNavigationOrientation>(() =>
    toMapNavOrientation('2d-north')
  );
  const [liveHeading, setLiveHeading] = useState<number | null>(null);
  const [userIconPref, setUserIconPref] = useState<UserLocationIconPreference>(
    () => initialConfig.userIcon
  );
  const [isUserIconPickerOpen, setIsUserIconPickerOpen] = useState<boolean>(false);
  const [isGoogleMenuOpen, setIsGoogleMenuOpen] = useState<boolean>(false);
  const [liveShareConfig, setLiveShareConfig] = useState<LiveLocationShareConfig>(() => ({
    visibility: 'off',
    sharedWith: [],
    durationPreset: '4h',
    startedAt: new Date().toISOString(),
    expiresAt: null,
    expiresAtMs: null,
  }));
  const [livePeers, setLivePeers] = useState<LiveLocationRecord[]>([]);
  const [selectedLivePeer, setSelectedLivePeer] = useState<LiveLocationRecord | null>(null);
  const [isShareLocationModalOpen, setIsShareLocationModalOpen] = useState<boolean>(false);
  const peerMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map());
  const livePeersRef = useRef<LiveLocationRecord[]>([]);
  livePeersRef.current = livePeers;
  const isLiveSharingActive = liveShareConfig.visibility !== 'off';
  const isLiveSharingActiveRef = useRef(isLiveSharingActive);
  isLiveSharingActiveRef.current = isLiveSharingActive;
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
  const recordedStartedAtRef = useRef<string | null>(null);
  const recordedElevationsRef = useRef<Array<number | null>>([]);
  const recordedTimestampsRef = useRef<number[]>([]);
  const recordElapsedSecondsRef = useRef<number>(recordElapsedSeconds);
  recordElapsedSecondsRef.current = recordElapsedSeconds;
  const recordedDistanceKmRef = useRef<number>(recordedDistanceKm);
  recordedDistanceKmRef.current = recordedDistanceKm;
  const recordedAscentMetersRef = useRef<number>(recordedAscentMeters);
  recordedAscentMetersRef.current = recordedAscentMeters;
  const [pendingRecordingSave, setPendingRecordingSave] = useState<{
    trigger: 'stop-recording' | 'stop-navigation';
    defaultName: string;
    coordinates: Array<[number, number]>;
    pointElevations: Array<number | null>;
    pointTimestamps: number[];
    distanceKm: number;
    ascentMeters: number;
    durationSeconds: number;
    startedAt: string;
    endedAt: string;
  } | null>(null);
  const [isSavingRecording, setIsSavingRecording] = useState(false);

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
  const editingPlanningTrailIdRef = useRef<string | null>(null);
  const [pinnedBackgroundRouteIds, setPinnedBackgroundRouteIds] = useState<string[]>(() =>
    readStoredPinnedRouteIds()
  );
  const [showBackgroundInPlanner, setShowBackgroundInPlanner] = useState<boolean>(true);
  const [bgHydrationSeq, setBgHydrationSeq] = useState<number>(0);
  const pinnedBackgroundRouteIdsRef = useRef<string[]>(pinnedBackgroundRouteIds);
  pinnedBackgroundRouteIdsRef.current = pinnedBackgroundRouteIds;

  useEffect(() => {
    writeStoredPinnedRouteIds(pinnedBackgroundRouteIds);
  }, [pinnedBackgroundRouteIds]);

  useEffect(() => {
    if (pinnedBackgroundRouteIds.length === 0 || routes.length === 0) return;
    const routeById = new Map(routes.map((r) => [r.id, r]));
    const idsToHydrate = pinnedBackgroundRouteIds.filter((id) => {
      const rec = routeById.get(id);
      if (!rec) return false;
      return !RouteManager.isHydratedRoute(rec) && !RouteManager.getCachedFullRoute(id);
    });
    if (idsToHydrate.length === 0) return;

    let cancelled = false;
    void Promise.all(idsToHydrate.map((id) => RouteManager.loadFullRoute(id))).then((loaded) => {
      if (!cancelled && loaded.some(Boolean)) {
        setBgHydrationSeq((s) => s + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pinnedBackgroundRouteIds, routes]);
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
  const [undoDeletedPoi, setUndoDeletedPoi] = useState<DeletedPoiUndoSnapshot | null>(null);
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
    (!isMobile &&
      (desktopDrawer === 'routes' ||
        desktopDrawer === 'recordings' ||
        desktopDrawer === 'planning-db')) ||
    (isMobile &&
      mobileDisplayMode === 'planning' &&
      !mobilePlanningOverlay &&
      (mobileTab === 'routes' || mobileTab === 'recordings' || mobileTab === 'planning-db'));

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
  const mapStyleRef = useRef<MapStyleId>(mapStyle);
  mapStyleRef.current = mapStyle;
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
  const isTrailMarkingModeRef = useRef<boolean>(isTrailMarkingMode);
  isTrailMarkingModeRef.current = isTrailMarkingMode;
  const trailSubModeRef = useRef<'add-road' | 'edit-road'>(trailSubMode);
  trailSubModeRef.current = trailSubMode;
  const baseHighwayLayerFiltersRef = useRef<Map<string, any>>(new Map());
  const communityRoadsRef = useRef<CommunityRoadRecord[]>(communityRoads);
  communityRoadsRef.current = communityRoads;
  const trailOverlayGeoJSONRef = useRef<GeoJSON.FeatureCollection>(trailOverlayGeoJSON);
  trailOverlayGeoJSONRef.current = trailOverlayGeoJSON;
  const showTrailOverlayRef = useRef<boolean>(showTrailOverlay);
  showTrailOverlayRef.current = showTrailOverlay;
  const isDrawingRoadRef = useRef<boolean>(isDrawingRoad);
  isDrawingRoadRef.current = isDrawingRoad;
  const roadDraftRef = useRef<CommunityRoadEditDraftInput | null>(roadDraft);
  roadDraftRef.current = roadDraft;
  const selectedRoadVertexIndexRef = useRef<number | null>(selectedRoadVertexIndex);
  selectedRoadVertexIndexRef.current = selectedRoadVertexIndex;
  const draggingRoadVertexIdxRef = useRef<number | null>(null);
  const justDraggedRoadVertexRef = useRef<boolean>(false);
  const lastRoadSnapTsRef = useRef<number>(0);
  const isTrailAddWaysModeRef = useRef(false);
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
  const handleTrailMapClickRef = useRef<(event: maplibregl.MapMouseEvent) => Promise<void>>(
    async () => {}
  );
  const handleFinishPlanningRef = useRef<() => Promise<void>>(async () => {});
  const isStyleLoadedRef = useRef<boolean>(false);
  const mobileDisplayModeRef = useRef<MobileDisplayMode>(mobileDisplayMode);
  mobileDisplayModeRef.current = mobileDisplayMode;
  const isMobileRef = useRef<boolean>(isMobile);
  isMobileRef.current = isMobile;
  const locationModeRef = useRef<LocationTrackingMode>(locationMode);
  locationModeRef.current = locationMode;
  const northModeRef = useRef<NorthPovMode>(northMode);
  northModeRef.current = northMode;
  const locationOnceTimerRef = useRef<number | null>(null);
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
  const userPitchGestureActiveRef = useRef<boolean>(false);
  const userRotateGestureActiveRef = useRef<boolean>(false);
  const manualCompassHoldRef = useRef<boolean>(false);
  const programmaticNorthUntilRef = useRef<number>(0);
  const lastNavFollowMoveEndTsRef = useRef<number>(0);
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

  const clearUserLocationMarker = useCallback(() => {
    if (userMarkerRef.current) {
      userMarkerRef.current.remove();
      userMarkerRef.current = null;
    }
    setUserLocation(null);
    const smoother = new GpsNavigationSmoother();
    if (activeRouteRef.current) {
      smoother.setActiveRoute(activeRouteRef.current);
    }
    navSmootherRef.current = smoother;
  }, []);

  const syncNorthModeState = useCallback(
    (nextNorth: NorthPovMode, options?: { fromGesture?: boolean }) => {
      northModeRef.current = nextNorth;
      setNorthMode(nextNorth);
      const next3d = is3dNorthMode(nextNorth);
      setVisibility((prev) => (prev.terrain3d === next3d ? prev : { ...prev, terrain3d: next3d }));
      const nextNavOrient = toMapNavOrientation(nextNorth);
      navOrientationRef.current = nextNavOrient;
      setNavOrientation(nextNavOrient);
      NavigationHeadingService.setOrientationPreference(nextNavOrient);
      if (options?.fromGesture) {
        manualCompassHoldRef.current = true;
      } else {
        manualCompassHoldRef.current = false;
        if (isPovNorthMode(nextNorth)) {
          void NavigationHeadingService.requestCompassPermissionIfNeeded();
        }
      }
    },
    []
  );
  const syncNorthModeStateRef = useRef(syncNorthModeState);
  syncNorthModeStateRef.current = syncNorthModeState;

  const applyLocationTransition = useCallback(
    (action: LocationModeTransitionAction) => {
      const res = resolveLocationModeTransition(
        locationModeRef.current,
        northModeRef.current,
        action
      );
      if (res.locationMode !== 'once' && locationOnceTimerRef.current !== null) {
        window.clearTimeout(locationOnceTimerRef.current);
        locationOnceTimerRef.current = null;
      }
      if (res.locationMode === 'none') {
        pendingLocateFlyRef.current = false;
      }
      if (res.isFollowingUser) {
        manualCompassHoldRef.current = false;
      }
      locationModeRef.current = res.locationMode;
      setLocationMode(res.locationMode);
      isFollowingUserRef.current = res.isFollowingUser;
      setIsFollowingUser(res.isFollowingUser);

      if (res.northMode !== northModeRef.current) {
        syncNorthModeState(res.northMode);
      }

      if (
        res.shouldClearMarker &&
        !isRecordingTrackRef.current &&
        !isNavigationActiveRef.current &&
        !isLiveSharingActiveRef.current
      ) {
        clearUserLocationMarker();
      }
      return res;
    },
    [clearUserLocationMarker, syncNorthModeState]
  );

  const handleUserMapOperation = useCallback(() => {
    if (locationModeRef.current === 'once') {
      pendingLocateFlyRef.current = false;
      applyLocationTransition('map-operation');
    }
  }, [applyLocationTransition]);
  const handleUserMapOperationRef = useRef<() => void>(() => {});
  handleUserMapOperationRef.current = handleUserMapOperation;

  useEffect(() => {
    if (locationMode !== 'once') {
      if (locationOnceTimerRef.current !== null) {
        window.clearTimeout(locationOnceTimerRef.current);
        locationOnceTimerRef.current = null;
      }
      return;
    }
    locationOnceTimerRef.current = window.setTimeout(() => {
      locationOnceTimerRef.current = null;
      pendingLocateFlyRef.current = false;
      applyLocationTransition('timeout-5min');
    }, LOCATION_ONCE_TIMEOUT_MS);
    return () => {
      if (locationOnceTimerRef.current !== null) {
        window.clearTimeout(locationOnceTimerRef.current);
        locationOnceTimerRef.current = null;
      }
    };
  }, [locationMode, applyLocationTransition]);
  const lastRecordedCameraRef = useRef<SavedMapCamera>({ ...initialCamera });
  const lastNavCamPersistTsRef = useRef<number>(0);

  const beginCameraTransition = useCallback((durationHintMs = 1000) => {
    userPitchGestureActiveRef.current = false;
    userRotateGestureActiveRef.current = false;
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

  const refreshPoisFromStore = useCallback(async () => {
    const allPois = await PoiManager.getAllPois();
    setPois(allPois);
    setSelectedPoi((cur) => {
      if (!cur) return null;
      return allPois.find((p) => p.id === cur.id) || null;
    });
  }, []);

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
              isNavigationActiveRef.current,
              isLiveSharingActiveRef.current
            );
          }
        });
        setTheme(cfg.theme);
        setMapStyle(cfg.mapStyle);
        setVisibility({ ...cfg.visibility, terrain3d: is3dNorthMode(northModeRef.current) });
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
    [beginCameraTransition, handleUserMapOperation]
  );

  const showToast = useCallback((msg: string, durationMs = 3500) => {
    setUndoDeletedPoi(null);
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      setUndoDeletedPoi(null);
    }, durationMs);
  }, []);

  const resolveTrailCandidate = useCallback(
    async (candidate: TrailWayCandidate) => {
      if (!osmInfo) return;
      try {
        const resolved = await highwayWayGeometryService.resolveWayAt(
          candidate.wayId,
          candidate.lon,
          candidate.lat,
          getTrailMapReleaseId(osmInfo)
        );
        const { fragments: _fragments, ...geometry } = resolved;
        setSelectedTrailWay(geometry);
        setTrailWayCandidates([]);
      } catch (error) {
        console.error('[TrailAnnotations] Highway resolution failed:', error);
        showToast(error instanceof Error ? error.message : 'לא ניתן לטעון את כל אורך הדרך.');
      }
    },
    [osmInfo, showToast]
  );

  useEffect(() => {
    if (typeof window === 'undefined' || window.location.pathname !== '/osm-callback') {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    let cancelled = false;
    void completeOsmOAuthCallback(params)
      .then(({ returnPath, isPopup }) => {
        if (cancelled) return;
        if (isPopup && typeof window.close === 'function') {
          window.close();
        }
        const target = returnPath.startsWith('/') ? returnPath : '/osm-sync';
        window.history.replaceState({}, '', target);
        setIsOsmSyncFullPage(target === '/osm-sync');
        setIsOsmSyncOpen(true);
        setOsmCallbackError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        window.history.replaceState({}, '', '/osm-sync');
        setIsOsmSyncFullPage(true);
        setIsOsmSyncOpen(true);
        setOsmCallbackError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setIsHandlingOsmCallback(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setCommunityRoads(communityRoadsCloudService.getCachedRoads());
    const unsubCache = communityRoadsCloudService.subscribe((roads) => {
      setCommunityRoads(roads);
    });
    const unsubRealtime = isOnline
      ? communityRoadsCloudService.subscribeCommunityRoads()
      : () => {};
    void communityRoadsCloudService.loadCommunityRoads();
    return () => {
      unsubCache();
      unsubRealtime();
    };
  }, [isOnline]);

  const trailReleaseId = getTrailMapReleaseId(osmInfo);
  useEffect(() => {
    let cancelled = false;
    const applyOverlay = (overlay: {
      geojson: GeoJSON.FeatureCollection;
      searchItems: TrailAnnotationSearchItem[];
    }) => {
      if (cancelled) return;
      setTrailOverlayGeoJSON(overlay.geojson);
      setTrailSearchItems(overlay.searchItems);
    };

    void trailAnnotationsCloudService.bootstrapAndSyncOverlay(
      trailReleaseId,
      applyOverlay,
      () => cancelled
    );

    const unsubRealtime = isOnline
      ? trailAnnotationsCloudService.subscribePublishedAnnotations((freshAnnotations) => {
          if (cancelled) return;
          void trailAnnotationsCloudService
            .resolveOverlayForAnnotations(freshAnnotations, trailReleaseId)
            .then((overlay) => {
              if (cancelled) return;
              trailAnnotationsCloudService.saveBootOverlaySnapshot(
                overlay.geojson,
                overlay.searchItems
              );
              applyOverlay(overlay);
            })
            .catch(() => undefined);
        })
      : () => {};

    return () => {
      cancelled = true;
      unsubRealtime();
    };
  }, [trailReleaseId, isOnline]);

  const pendingOsmSyncCount = useMemo(
    () =>
      communityRoads.filter(
        (road) =>
          road.status === 'active' &&
          !isRemovedOsmRoad(road) &&
          !(road.osmSync && Number(road.osmSync.syncedRevision) >= Number(road.revision))
      ).length,
    [communityRoads]
  );

  useEffect(() => {
    if (currentUser && isOnline) {
      void communityRoadsCloudService.syncPendingRoads(currentUser);
    }
  }, [currentUser, isOnline]);

  const communityRoadsGeoJSON = useMemo(
    () => buildCommunityRoadsGeoJSON(communityRoads),
    [communityRoads]
  );

  const overriddenOsmWayIds = useMemo(
    () => extractOverriddenOsmWayIds(communityRoads),
    [communityRoads]
  );

  const filteredTrailOverlayGeoJSON = useMemo(
    () => filterTrailOverlayByCommunityRoads(trailOverlayGeoJSON, communityRoads),
    [trailOverlayGeoJSON, communityRoads]
  );

  const communityRoadDraftGeoJSON = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    if (isTrailMarkingMode) {
      // Removed OSM roads stay visible as ghost lines while editing, so they can be picked and restored
      features.push(...buildRemovedRoadFeatures(communityRoads, roadDraft?.roadId));
    }
    if (roadDraft && roadDraft.coordinates.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { role: 'draft-line' },
        geometry: {
          type: 'LineString',
          coordinates: roadDraft.coordinates,
        },
      });
    }
    if (roadDraft) {
      roadDraft.coordinates.forEach((coord, idx) => {
        const isAnchored = roadDraft.anchors.some((a) => a.vertexIndex === idx);
        features.push({
          type: 'Feature',
          properties: {
            role: isAnchored ? 'anchor-vertex' : 'draft-vertex',
            vertexIndex: idx,
            selected: idx === selectedRoadVertexIndex,
          },
          geometry: { type: 'Point', coordinates: coord },
        });
        if (idx < roadDraft.coordinates.length - 1) {
          const nextCoord = roadDraft.coordinates[idx + 1];
          features.push({
            type: 'Feature',
            properties: {
              role: 'midpoint-handle',
              insertAfterIndex: idx,
            },
            geometry: {
              type: 'Point',
              coordinates: [(coord[0] + nextCoord[0]) / 2, (coord[1] + nextCoord[1]) / 2],
            },
          });
        }
      });
    }
    if ((isDrawingRoad || selectedRoadVertexIndex !== null) && roadSnapPreview) {
      features.push({
        type: 'Feature',
        properties: { role: 'snap-ring' },
        geometry: { type: 'Point', coordinates: roadSnapPreview.coord },
      });
    }
    return { type: 'FeatureCollection', features };
  }, [
    roadDraft,
    isDrawingRoad,
    selectedRoadVertexIndex,
    roadSnapPreview,
    isTrailMarkingMode,
    communityRoads,
  ]);

  const moveRoadDraftVertex = useCallback(
    (vertexIndex: number, lon: number, lat: number, snap: RoadSnapCandidate | null) => {
      const nextCoord: [number, number] = snap
        ? snap.coord
        : [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
      setRoadDraft((prev) => {
        if (!prev || vertexIndex < 0 || vertexIndex >= prev.coordinates.length) return prev;
        const nextCoords = prev.coordinates.slice();
        nextCoords[vertexIndex] = nextCoord;
        const filteredAnchors = prev.anchors.filter((a) => a.vertexIndex !== vertexIndex);
        const nextAnchors = snap
          ? [
              ...filteredAnchors,
              {
                vertexIndex,
                targetWayId: snap.targetWayId,
                coord: snap.coord,
                gx: snap.gx,
                gy: snap.gy,
                snapType: snap.snapType,
              },
            ]
          : filteredAnchors;
        return {
          ...prev,
          coordinates: nextCoords,
          anchors: nextAnchors,
        };
      });
    },
    []
  );

  const handleTrailMapClick = useCallback(
    async (event: maplibregl.MapMouseEvent) => {
      if (justDraggedRoadVertexRef.current) {
        justDraggedRoadVertexRef.current = false;
        return;
      }
      const map = mapRef.current;
      if (!map || !osmInfo || isNavigationActiveRef.current || map.getZoom() < 13.5) {
        showToast('יש להתקרב למפה לרמת שביל מפורטת לפני בחירה.');
        return;
      }

      if (roadDraftRef.current && map.getLayer('community-road-draft-vertices')) {
        const vertexHits = map.queryRenderedFeatures(
          [
            [event.point.x - 12, event.point.y - 12],
            [event.point.x + 12, event.point.y + 12],
          ],
          { layers: ['community-road-draft-vertices'] }
        );
        const hitIdx = vertexHits[0]?.properties?.vertexIndex;
        if (typeof hitIdx === 'number') {
          setSelectedRoadVertexIndex((prev) => (prev === hitIdx ? null : hitIdx));
          return;
        }
        if (map.getLayer('community-road-draft-midpoints')) {
          const midHits = map.queryRenderedFeatures(
            [
              [event.point.x - 10, event.point.y - 10],
              [event.point.x + 10, event.point.y + 10],
            ],
            { layers: ['community-road-draft-midpoints'] }
          );
          const insertAfter = midHits[0]?.properties?.insertAfterIndex;
          if (typeof insertAfter === 'number') {
            const newPt: [number, number] = [
              Number(event.lngLat.lng.toFixed(6)),
              Number(event.lngLat.lat.toFixed(6)),
            ];
            setRoadDraft((prev) => {
              if (!prev) return prev;
              const nextCoords = prev.coordinates.slice();
              nextCoords.splice(insertAfter + 1, 0, newPt);
              const nextAnchors = prev.anchors.map((a) => ({
                ...a,
                vertexIndex: a.vertexIndex > insertAfter ? a.vertexIndex + 1 : a.vertexIndex,
              }));
              return { ...prev, coordinates: nextCoords, anchors: nextAnchors };
            });
            setSelectedRoadVertexIndex(insertAfter + 1);
            showToast(`נוספה נקודה #${insertAfter + 2} באמצע הדרך — גרור או לחץ להזזה`);
            return;
          }
        }
        if (selectedRoadVertexIndexRef.current !== null) {
          const idxToMove = selectedRoadVertexIndexRef.current;
          const snap = await snapPointToExistingRoads(
            event.lngLat.lng,
            event.lngLat.lat,
            ROAD_SEGMENT_SNAP_METERS,
            ROAD_VERTEX_SNAP_METERS,
            roadDraftRef.current?.roadId,
            roadDraftRef.current?.sourceOsmWayId
          );
          moveRoadDraftVertex(idxToMove, event.lngLat.lng, event.lngLat.lat, snap);
          setSelectedRoadVertexIndex(null);
          setRoadSnapPreview(null);
          showToast(snap ? `נקודה #${idxToMove + 1} הוזזה והוצמדה ל-${snap.roadLabel}` : `נקודה #${idxToMove + 1} הוזזה`);
          return;
        }
      }

      if (isDrawingRoadRef.current) {
        const snap = await snapPointToExistingRoads(
          event.lngLat.lng,
          event.lngLat.lat,
          ROAD_SEGMENT_SNAP_METERS,
          ROAD_VERTEX_SNAP_METERS,
          roadDraftRef.current?.roadId,
          roadDraftRef.current?.sourceOsmWayId
        );
        const nextCoord: [number, number] = snap
          ? snap.coord
          : [Number(event.lngLat.lng.toFixed(6)), Number(event.lngLat.lat.toFixed(6))];
        setRoadDraft((prev) => {
          const base: CommunityRoadEditDraftInput = prev ?? {
            roadId: null,
            expectedRevision: 0,
            kind: 'new',
            coordinates: [],
            anchors: [],
            highwayClass: 'track',
          };
          const vertexIndex = base.coordinates.length;
          const nextAnchors = snap
            ? [
                ...base.anchors,
                {
                  vertexIndex,
                  targetWayId: snap.targetWayId,
                  coord: snap.coord,
                  gx: snap.gx,
                  gy: snap.gy,
                  snapType: snap.snapType,
                },
              ]
            : base.anchors;
          return {
            ...base,
            coordinates: [...base.coordinates, nextCoord],
            anchors: nextAnchors,
          };
        });
        if (snap) {
          showToast(`הוצמדה נקודה ל-${snap.roadLabel}`);
        }
        return;
      }

      if (trailSubModeRef.current === 'edit-road') {
        const commHitLayers = [
          'community-road-removed-line',
          ...COMMUNITY_ROADS_LINE_LAYER_IDS,
        ].filter((id) => Boolean(map.getLayer(id)));
        if (commHitLayers.length > 0) {
          const commHits = map.queryRenderedFeatures(
            [
              [event.point.x - 10, event.point.y - 10],
              [event.point.x + 10, event.point.y + 10],
            ],
            { layers: commHitLayers }
          );
          const hitRoadId = commHits[0]?.properties?.roadId;
          if (typeof hitRoadId === 'string') {
            const existing = communityRoadsCloudService
              .getCachedRoads()
              .find((r) => r.id === hitRoadId);
            if (existing) {
              setIsDrawingRoad(false);
              setRoadDraft({
                roadId: existing.id,
                expectedRevision: existing.revision,
                kind: existing.kind,
                sourceOsmWayId: existing.sourceOsmWayId,
                coordinates: existing.coordinates,
                anchors: existing.anchors,
                highwayClass: existing.highwayClass,
                tracktype: existing.tracktype,
                surface: existing.surface,
                name: existing.name,
                description: existing.description,
                oneway: existing.oneway,
                allow4x4: existing.allow4x4,
                allowFoot: existing.allowFoot,
                allowBicycle: existing.allowBicycle,
                trailColor: existing.trailColor || '',
                trailNumber: existing.trailNumber || '',
                trailName: existing.trailName || '',
                existingRecord: existing,
              });
              return;
            }
          }
        }
        const sourceLayerById = new Map(
          map.getStyle().layers.map((layer) => [
            layer.id,
            (layer as maplibregl.LayerSpecification & { 'source-layer'?: string })['source-layer'],
          ])
        );
        const layers = Array.from(HIGHWAY_LAYER_IDS).filter(
          (id) => Boolean(map.getLayer(id)) && sourceLayerById.get(id) === 'transportation'
        );
        const hits = layers.length
          ? map.queryRenderedFeatures(
              [
                [event.point.x - 12, event.point.y - 12],
                [event.point.x + 12, event.point.y + 12],
              ],
              { layers }
            )
          : [];
        const firstFeature = hits.find(
          (f) => sourceLayerById.get(f.layer.id) === 'transportation' && f.properties?.class && trailWayIdFromMvtId(f.id)
        );
        if (!firstFeature) {
          showToast('לא נמצאה דרך לעריכה בנקודה זו.');
          return;
        }
        const osmWayId = trailWayIdFromMvtId(firstFeature.id)!;
        const existingOverride = communityRoadsCloudService
          .getCachedRoads()
          .find((r) => r.kind === 'osm-override' && r.sourceOsmWayId === osmWayId && r.status === 'active');
        if (existingOverride) {
          setIsDrawingRoad(false);
          setRoadDraft({
            roadId: existingOverride.id,
            expectedRevision: existingOverride.revision,
            kind: 'osm-override',
            sourceOsmWayId: osmWayId,
            coordinates: existingOverride.coordinates,
            anchors: existingOverride.anchors,
            highwayClass: existingOverride.highwayClass,
            tracktype: existingOverride.tracktype,
            surface: existingOverride.surface,
            name: existingOverride.name,
            description: existingOverride.description,
            oneway: existingOverride.oneway,
            allow4x4: existingOverride.allow4x4,
            allowFoot: existingOverride.allowFoot,
            allowBicycle: existingOverride.allowBicycle,
            trailColor: existingOverride.trailColor || '',
            trailNumber: existingOverride.trailNumber || '',
            trailName: existingOverride.trailName || '',
            existingRecord: existingOverride,
          });
          return;
        }
        try {
          const resolved = await highwayWayGeometryService.resolveWayAt(
            osmWayId,
            event.lngLat.lng,
            event.lngLat.lat,
            getTrailMapReleaseId(osmInfo)
          );
          const rawClass = String(firstFeature.properties?.class || 'unclassified').toLowerCase();
          const highwayClass: CommunityHighwayClass = isCommunityHighwayClass(rawClass)
            ? rawClass
            : 'unclassified';
          const coords = (resolved.geometry.coordinates[0] || []).map(
            ([lon, lat]) => [lon, lat] as [number, number]
          );
          const existingTrailFeature = trailOverlayGeoJSON.features.find(
            (f) => f.properties?.wayId === osmWayId
          );
          setIsDrawingRoad(false);
          setRoadDraft({
            roadId: null,
            expectedRevision: 0,
            kind: 'osm-override',
            sourceOsmWayId: osmWayId,
            coordinates: coords,
            anchors: [],
            highwayClass,
            name: resolved.detectedName || '',
            trailColor:
              resolved.detectedColor ||
              (existingTrailFeature?.properties?.color as CommunityRoadEditDraftInput['trailColor']) ||
              '',
            trailNumber:
              resolved.detectedNumber || String(existingTrailFeature?.properties?.number || ''),
            trailName:
              resolved.detectedName || String(existingTrailFeature?.properties?.name || ''),
          });
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'טעינת הדרך לעריכה נכשלה.');
        }
        return;
      }

      const commMarkLayers = COMMUNITY_ROADS_LINE_LAYER_IDS.filter((id) =>
        Boolean(map.getLayer(id))
      );
      if (commMarkLayers.length > 0) {
        const commHits = map.queryRenderedFeatures(
          [
            [event.point.x - 10, event.point.y - 10],
            [event.point.x + 10, event.point.y + 10],
          ],
          { layers: commMarkLayers }
        );
        const hitRoadId = commHits[0]?.properties?.roadId;
        if (typeof hitRoadId === 'string') {
          await resolveTrailCandidate({
            wayId: `community:road:${hitRoadId}`,
            lon: event.lngLat.lng,
            lat: event.lngLat.lat,
            highwayClass: String(commHits[0]?.properties?.highwayClass || 'track'),
            highwaySubclass: String(commHits[0]?.properties?.tracktype || ''),
            layer: 0,
          });
          return;
        }
      }

      if (!isTrailAddWaysModeRef.current) {
        const overlayLayers = [
          'community-trails-track-right',
          'community-trails-track-left',
          'community-trails-path-line',
          'community-trails-casing',
          'community-trails-stale',
        ].filter((id) => Boolean(map.getLayer(id)));
        const overlayHit = overlayLayers.length
          ? map
              .queryRenderedFeatures(
                [
                  [event.point.x - 8, event.point.y - 8],
                  [event.point.x + 8, event.point.y + 8],
                ],
                { layers: overlayLayers }
              )
              .find((feature) => {
                const id = feature.properties?.trailId;
                return typeof id === 'string' && id !== '' && id !== 'selection-preview';
              })
          : undefined;
        if (overlayHit) {
          setTrailWayCandidates([]);
          setSelectedTrailAnnotationId(String(overlayHit.properties!.trailId));
          return;
        }
      }
      const sourceLayerById = new Map(
        map.getStyle().layers.map((layer) => [
          layer.id,
          (layer as maplibregl.LayerSpecification & { 'source-layer'?: string })['source-layer'],
        ])
      );
      const layers = Array.from(HIGHWAY_LAYER_IDS).filter((id) => {
        return Boolean(map.getLayer(id)) && sourceLayerById.get(id) === 'transportation';
      });
      if (layers.length === 0) {
        showToast('שכבות השבילים אינן זמינות בקובץ המפה הנוכחי.');
        return;
      }
      const hits = map.queryRenderedFeatures(
        [
          [event.point.x - 12, event.point.y - 12],
          [event.point.x + 12, event.point.y + 12],
        ],
        { layers }
      );
      const candidates = new Map<string, TrailWayCandidate>();
      for (const feature of hits) {
        if (sourceLayerById.get(feature.layer.id) !== 'transportation') continue;
        if (!feature.properties?.class) continue;
        const wayId = trailWayIdFromMvtId(feature.id);
        if (wayId) {
          candidates.set(wayId, {
            wayId,
            lon: event.lngLat.lng,
            lat: event.lngLat.lat,
            highwayClass: String(feature.properties.class || ''),
            highwaySubclass: String(feature.properties.subclass || ''),
            layer: Number(feature.properties.layer || 0),
          });
        }
      }
      if (candidates.size === 0) {
        showToast('לא נמצא כביש או שביל מזוהה בנקודה. נסה לבחור את הקו עצמו.');
        return;
      }
      if (candidates.size > 1) {
        setTrailWayCandidates(Array.from(candidates.values()));
        showToast('נמצאו כמה דרכים חופפות. בחר את הדרך המתאימה.');
        return;
      }
      const candidate = candidates.values().next().value as TrailWayCandidate | undefined;
      if (candidate) await resolveTrailCandidate(candidate);
    },
    [osmInfo, resolveTrailCandidate, moveRoadDraftVertex, showToast]
  );
  handleTrailMapClickRef.current = handleTrailMapClick;

  const handleTrailAddWaysModeChange = useCallback((enabled: boolean) => {
    isTrailAddWaysModeRef.current = enabled;
  }, []);

  const consumeSelectedTrailWay = useCallback(() => {
    setSelectedTrailWay(null);
  }, []);

  const consumeSelectedTrailAnnotation = useCallback(() => {
    setSelectedTrailAnnotationId(null);
  }, []);

  const exitTrailMarkingMode = useCallback(() => {
    setIsTrailMarkingMode(false);
    setTrailSubMode('edit-road');
    setIsDrawingRoad(false);
    setRoadDraft(null);
    setSelectedRoadVertexIndex(null);
    setRoadSnapPreview(null);
    setSelectedTrailWay(null);
    setSelectedTrailAnnotationId(null);
    setTrailWayCandidates([]);
  }, []);

  const switchTrailSubMode = useCallback(
    (nextMode: 'add-road' | 'edit-road') => {
      setTrailSubMode(nextMode);
      setSelectedTrailWay(null);
      setSelectedTrailAnnotationId(null);
      setTrailWayCandidates([]);
      setSelectedRoadVertexIndex(null);
      setRoadSnapPreview(null);
      if (nextMode === 'add-road') {
        setRoadDraft({
          roadId: null,
          expectedRevision: 0,
          kind: 'new',
          coordinates: [],
          anchors: [],
          highwayClass: 'track',
        });
        setIsDrawingRoad(true);
      } else {
        setIsDrawingRoad(false);
        setRoadDraft(null);
      }
    },
    []
  );

  // A newly opened window always starts expanded.
  useEffect(() => {
    setIsDesktopDrawerMinimized(false);
  }, [desktopDrawer]);
  useEffect(() => {
    setIsMobileSheetMinimized(false);
  }, [mobilePlanningOverlay, mobileNavOverlay, mobileTab, mobileDisplayMode]);
  useEffect(() => {
    setMobileSpeedDial(null);
  }, [mobileDisplayMode, mobileTab, isMobile]);
  useEffect(() => {
    if (!currentUser) {
      setMobilePlanningOverlay((prev) => (prev === 'google-account' ? null : prev));
      setMobileNavOverlay((prev) => (prev === 'google-account' ? null : prev));
    }
  }, [currentUser]);

  // ---- Add point: press the icon, click the map, the new-point window opens ----
  const [isPickingPoiLocation, setIsPickingPoiLocation] = useState(false);
  const [addPoiCoords, setAddPoiCoords] = useState<{ lon: number; lat: number; ele: number | null } | null>(
    null
  );
  const isPickingPoiRef = useRef(false);
  isPickingPoiRef.current = isPickingPoiLocation;

  const openAddPoiPanelAt = useCallback(
    (coords: { lon: number; lat: number; ele: number | null }) => {
      setAddPoiCoords(coords);
      setIsPickingPoiLocation(false);
      if (!isMobile) {
        setDesktopDrawer('add-poi');
      } else if (mobileDisplayMode === 'navigating') {
        setMobileNavOverlay('add-poi');
      } else {
        setMobilePlanningOverlay('add-poi');
      }
    },
    [isMobile, mobileDisplayMode]
  );
  const openAddPoiPanelAtRef = useRef(openAddPoiPanelAt);
  openAddPoiPanelAtRef.current = openAddPoiPanelAt;

  const startAddPoiPick = useCallback(() => {
    setMobileSpeedDial(null);
    if (isPickingPoiRef.current) {
      setIsPickingPoiLocation(false);
      return;
    }
    if (isPlanningRouteRef.current) return;
    exitTrailMarkingMode();
    // Close an already-open new-point window so the next map click starts a fresh point.
    setDesktopDrawer((prev) => (prev === 'add-poi' ? null : prev));
    setMobilePlanningOverlay((prev) => (prev === 'add-poi' ? null : prev));
    setMobileNavOverlay((prev) => (prev === 'add-poi' ? null : prev));
    setIsPickingPoiLocation(true);
  }, [exitTrailMarkingMode]);

  useEffect(() => {
    if (!isPickingPoiLocation) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setIsPickingPoiLocation(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPickingPoiLocation]);

  const toggleTrailMarkingMode = useCallback(() => {
    if (isTrailMarkingModeRef.current) {
      exitTrailMarkingMode();
      return;
    }
    if (!currentUserRef.current) return;
    setDesktopDrawer(null);
    setMobilePlanningOverlay(null);
    setMobileSheetExpanded(false);
    setIsTrailMarkingMode(true);
  }, [exitTrailMarkingMode]);

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
      mapStyle,
      visibility,
      navOrientation,
      planningMode,
      userIcon: userIconPref,
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSyncedConfigJsonRef.current) {
      return;
    }
    lastSyncedConfigJsonRef.current = serialized;
    UserStateSyncService.recordLocalConfig(snapshot, currentUserRef.current);
  }, [theme, mapStyle, visibility, navOrientation, planningMode, userIconPref]);

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
    setShareModalPoiId(null);
    setUnseenSharedCount(0);
    setIsNavigatingRoute(false);
    setOffRouteWarning(null);
    setRemainingDistKm(null);
    setPinnedBackgroundRouteIds([]);
    writeStoredPinnedRouteIds([]);
    editingRouteIdRef.current = null;
    setEditingRouteId(null);
    setPlanRouteName('');
    setPlanWaypoints([]);
    setPlanLegs([]);
    setPlanPreviewPoint(null);
    setPlanCursorCoord(null);
    setDisconnectedCandidate(null);
    lastRecordedEleRef.current = null;
    recordedStartedAtRef.current = null;
    recordedElevationsRef.current = [];
    recordedTimestampsRef.current = [];
    setIsRecordingTrack(false);
    setIsRecordingPaused(false);
    setRecordedCoords([]);
    setRecordedDistanceKm(0);
    setRecordedAscentMeters(0);
    setRecordElapsedSeconds(0);
    setPendingRecordingSave(null);
  }, []);

  // Global POIs live sync (readable by all users, signed-in or anonymous)
  useEffect(() => {
    if (!isOnline || !AuthService.isAvailable()) return;
    const unsubGlobalPois = GlobalPoiCloudService.subscribeGlobalPois((changed) => {
      if (changed) {
        void refreshPoisFromStore();
      }
    });
    return () => {
      unsubGlobalPois();
    };
  }, [isOnline, refreshPoisFromStore]);

  // Scoped route ownership isolation + Cloud sync on sign-in / user switch / sign-out
  const prevAuthUidRef = useRef<string | null>(currentUser?.uid ?? null);
  useEffect(() => {
    let cancelled = false;
    const nextUid = currentUser?.uid ?? null;
    const prevUid = prevAuthUidRef.current;
    prevAuthUidRef.current = nextUid;
    const prevStoredUid = readStoredLastAuthUid();

    if (!currentUser) {
      // Signed out: immediately hide/purge any signed-in or shared routes and private/shared POIs
      if (prevUid) {
        writeStoredLastAuthUid(prevUid);
        resetRouteSessionState();
        setRoutes((prev) => prev.filter((r) => RouteManager.isRouteVisibleForUser(r, null)));
        setPois((prev) => prev.filter((p) => p.visibility !== 'private'));
        setSelectedPoi((cur) => (cur && isPrivatePoi(cur) ? null : cur));
      }
      void Promise.all([
        RouteManager.purgeOtherUsersCachedRoutes(null),
        PoiManager.purgePrivateAndSharedPoisForUserSwitch(null),
      ]).then(async ([, purgedPois]) => {
        if (cancelled) return;
        const anonRoutes = (await RouteManager.listRouteSummaries(null)).filter(
          (r) => !deletedRouteIdsRef.current.has(r.id)
        );
        if (!cancelled) {
          setRoutes(anonRoutes);
          if (purgedPois > 0) {
            void refreshPoisFromStore();
          }
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
      setPois((prev) => prev.filter((p) => p.visibility !== 'private'));
      setSelectedPoi((cur) => (cur && isPrivatePoi(cur) ? null : cur));
    }
    writeStoredLastAuthUid(nextUid);

    (async () => {
      try {
        if (switchedFromAnotherUser) {
          await Promise.all([
            RouteManager.purgeOtherUsersCachedRoutes(nextUid),
            PoiManager.purgePrivateAndSharedPoisForUserSwitch(nextUid),
          ]);
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

        const [mergedState, syncedCount, downloaded, sharedRes, migrationRes] = await Promise.all([
          UserStateSyncService.pullAndMergeCloudState(currentUser),
          PlannedTracksCloudService.syncPendingRoutesForUser(currentUser),
          PlannedTracksCloudService.fetchUserPlannedRoutes(currentUser),
          PlannedTracksCloudService.fetchSharedWithMeRoutes(currentUser),
          GlobalPoiCloudService.migrateLegacyOhadPoiData(currentUser).catch((err) => {
            console.warn('[NavApp] Global POI migration warning:', err);
            return { migratedOverrides: 0, migratedPois: 0 };
          }),
          UserDirectoryService.registerCurrentUser(currentUser),
        ]);
        if (cancelled) return;

        const [flushedPoiOps, flushedPrivatePoiOps] = await Promise.all([
          GlobalPoiCloudService.flushPendingOperations(currentUser).catch(() => 0),
          PrivatePoiCloudService.flushPendingOperations(currentUser).catch(() => 0),
        ]);
        const [globalPoisChanged, privatePoisRes] = await Promise.all([
          GlobalPoiCloudService.fetchAndReconcileGlobalPois().catch(() => false),
          PrivatePoiCloudService.fetchPrivateAndSharedPois(currentUser).catch(() => ({
            changed: false,
            newlyArrivedShared: [] as PoiRecord[],
            revokedSharedIds: [] as string[],
          })),
        ]);
        if (cancelled) return;

        if (
          migrationRes.migratedOverrides > 0 ||
          migrationRes.migratedPois > 0 ||
          flushedPoiOps > 0 ||
          flushedPrivatePoiOps > 0 ||
          globalPoisChanged ||
          privatePoisRes.changed
        ) {
          void refreshPoisFromStore();
          if (migrationRes.migratedOverrides > 0 || migrationRes.migratedPois > 0) {
            showToast('נתוני נקודות העניין הועברו למפה הגלובלית');
          }
          if (privatePoisRes.newlyArrivedShared.length > 0) {
            const firstPoi = privatePoisRes.newlyArrivedShared[0];
            const sender = firstPoi.sharedByName || firstPoi.sharedByEmail || 'משתמש NavApp';
            showToast(
              privatePoisRes.newlyArrivedShared.length === 1
                ? `${sender} שיתף איתך נקודת עניין: ${firstPoi.nameHe || firstPoi.name}`
                : `התקבלו ${privatePoisRes.newlyArrivedShared.length} נקודות עניין משותפות חדשות`
            );
          }
        }

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
            if (downloaded.length > 0) {
              const downloadedIds = new Set(downloaded.map((r) => r.id));
              if (pinnedBackgroundRouteIdsRef.current.some((id) => downloadedIds.has(id))) {
                setBgHydrationSeq((s) => s + 1);
              }
              const curActive = activeRouteRef.current;
              if (curActive && downloadedIds.has(curActive.id)) {
                void RouteManager.loadFullRoute(curActive.id).then((refreshed) => {
                  if (!cancelled && refreshed) {
                    setActiveRoute((cur) => (cur?.id === refreshed.id ? refreshed : cur));
                  }
                });
              }
            }
            if (sharedRes.revokedIds.length > 0) {
              const revokedSet = new Set(sharedRes.revokedIds);
              setPinnedBackgroundRouteIds((prev) => prev.filter((id) => !revokedSet.has(id)));
            }
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

        if (event.revokedIds.length > 0) {
          const revokedSet = new Set(event.revokedIds);
          setPinnedBackgroundRouteIds((prev) => prev.filter((id) => !revokedSet.has(id)));
          if (
            activeRouteRef.current &&
            event.revokedIds.includes(activeRouteRef.current.id) &&
            !isNavigationActiveRef.current
          ) {
            setActiveRoute(null);
            showToast('הגישה למסלול המשותף בוטלה ע״י הבעלים');
          }
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

    const unsubPrivatePois = PrivatePoiCloudService.subscribePrivateAndSharedPois(
      currentUser,
      (event) => {
        if (cancelled) return;
        if (event.changed) {
          void refreshPoisFromStore();
        }
        if (!event.isInitial && event.newlyArrivedShared.length > 0) {
          const firstPoi = event.newlyArrivedShared[0];
          const sender = firstPoi.sharedByName || firstPoi.sharedByEmail || 'משתמש NavApp';
          showToast(
            event.newlyArrivedShared.length === 1
              ? `${sender} שיתף איתך נקודת עניין: ${firstPoi.nameHe || firstPoi.name}`
              : `התקבלו ${event.newlyArrivedShared.length} נקודות עניין משותפות חדשות`
          );
        }
        if (event.revokedSharedIds.length > 0) {
          const revokedSet = new Set(event.revokedSharedIds);
          setSelectedPoi((cur) => {
            if (cur && revokedSet.has(cur.id)) {
              showToast('הגישה לנקודת העניין המשותפת הוסרה ע״י הבעלים');
              return null;
            }
            return cur;
          });
        }
      }
    );

    return () => {
      cancelled = true;
      unsubRemoteState();
      unsubSharedRoutes();
      unsubPrivatePois();
    };
  }, [currentUser, isOnline, showToast, applyRemoteMergedState, resetRouteSessionState, refreshPoisFromStore]);

  // Toggle map interaction feedback while route planning or community way selection is active.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isPlanningRouteMode) {
      map.doubleClickZoom.disable();
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      map.doubleClickZoom.enable();
      map.getCanvas().style.cursor = isTrailMarkingMode || isPickingPoiLocation ? 'crosshair' : '';
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
    }
  }, [isPlanningRouteMode, isTrailMarkingMode, isPickingPoiLocation, isMapReady]);

  useEffect(() => {
    if (isTrailMarkingMode && (!currentUser || isPlanningRouteMode || isAddingPoiMode)) {
      exitTrailMarkingMode();
    }
  }, [isTrailMarkingMode, currentUser, isPlanningRouteMode, isAddingPoiMode, exitTrailMarkingMode]);

  const refreshOfflineDataConsumers = useCallback(
    async (kind: 'pois' | 'search' | 'all' = 'all', toastMessage?: string) => {
      if (kind === 'pois' || kind === 'all') {
        const reloaded = await PoiManager.initializePois();
        if (reloaded.length > 0) {
          setPois(reloaded);
        }
      }
      if (kind === 'search' || kind === 'all') {
        await pmtilesSearchService.reloadFromOfflineData();
      }
      if (toastMessage) {
        showToast(toastMessage);
      }
    },
    [showToast]
  );

  // Listen to background downloads from Firebase into persistent OPFS
  useEffect(() => {
    const unsubProgress = pmtilesRegistry.onDownloadProgress((fileName, loaded, total) => {
      const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
      setDownloadStatus({ fileName, loaded, total, percent });
    });

    const unsubUpdated = pmtilesRegistry.onArchiveUpdated((id, info) => {
      if (id === 'israel-osm') {
        highwayWayGeometryService.clearTileCache();
        setOsmInfo(info);
      }
      if (id === 'israel-dem') {
        setDemInfo(info);
        setIsDemUnavailable(false);
      }
      setDownloadStatus(null);
      showToast(`קובץ המפה ${info.record.fileName} נשמר במכשיר! פועל 100% אופליין.`);
    });

    const unsubDataUpdated = offlineDataFiles.onDataFileUpdated((fileName) => {
      if (fileName === 'Israel.search.idx') {
        void refreshOfflineDataConsumers('search', `אינדקס החיפוש ${fileName} עודכן ונשמר לאופליין.`);
      } else {
        void refreshOfflineDataConsumers('pois', `קובץ נקודות העניין ${fileName} עודכן ונשמר לאופליין.`);
      }
    });

    return () => {
      unsubProgress();
      unsubUpdated();
      unsubDataUpdated();
    };
  }, [showToast, refreshOfflineDataConsumers]);

  // Monitor Online / Offline connectivity (and retry DEM automatically if boot occurred offline)
  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      void pmtilesRegistry.retryDemIfUnavailable().then((dem) => {
        if (dem) {
          setDemInfo(dem);
          setIsDemUnavailable(false);
        }
      });
    };
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // Recording elapsed timer (active only while navigating)
  useEffect(() => {
    if (!isNavigationActive || !isRecordingTrack || isRecordingPaused) return;
    const timer = window.setInterval(() => {
      setRecordElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isNavigationActive, isRecordingTrack, isRecordingPaused]);

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
        const povActive = isPovNorthMode(northModeRef.current);
        const targetBearing = povActive ? frame.headingDeg ?? curMapBearing : 0;

        const curCenter = map.getCenter();
        const centerMoved =
          Math.abs(frame.lon - curCenter.lng) > 1e-7 ||
          Math.abs(frame.lat - curCenter.lat) > 1e-7;
        const bearingChanged =
          Math.abs(shortestAngleDeltaDeg(curMapBearing, targetBearing)) > 0.05;

        if (centerMoved || bearingChanged) {
          lastCameraBearingRef.current = { ts: perfNowMs, bearing: targetBearing };
          map.jumpTo(
            {
              center: [frame.lon, frame.lat],
              bearing: targetBearing,
              pitch: is3dNorthMode(northModeRef.current) ? 60 : 0,
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

  const shouldWatchGps = shouldRunGpsWatch({
    locationMode,
    isRecordingTrack,
    isNavigationActive,
    isLiveSharingActive,
  });

  // GPS position stream runs ONLY when Location mode is active (1-b/1-c) or Recording/Navigation/Live-Share needs it
  useEffect(() => {
    if (!shouldWatchGps) {
      return;
    }
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

        if (pendingLocateFlyRef.current) {
          pendingLocateFlyRef.current = false;
          if (locationModeRef.current !== 'none' && mapRef.current) {
            const targetLon = latestFrame?.lon ?? ingest.kalmanLon;
            const targetLat = latestFrame?.lat ?? ingest.kalmanLat;
            const curMapBearing = mapRef.current.getBearing();
            const flyHeading = latestFrame?.headingDeg ?? ingest.headingDeg;
            const isTrackingOrNav =
              locationModeRef.current === 'tracking' || isNavigationActiveRef.current;
            const povActive = isPovNorthMode(northModeRef.current);
            const targetBearing = povActive
              ? flyHeading ?? curMapBearing
              : isTrackingOrNav
                ? 0
                : undefined;
            const targetPitch = is3dNorthMode(northModeRef.current) ? 60 : undefined;
            if (targetBearing !== undefined) {
              lastCameraBearingRef.current = { ts: perfNow, bearing: targetBearing };
            }
            beginCameraTransition(1100);
            mapRef.current.flyTo({
              center: [targetLon, targetLat],
              zoom: Math.max(mapRef.current.getZoom(), isTrackingOrNav ? 15.5 : 15),
              ...(targetBearing !== undefined ? { bearing: targetBearing } : {}),
              ...(targetPitch !== undefined ? { pitch: targetPitch } : {}),
              speed: 1.4,
              essential: true,
            });
          }
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

        if (
          isNavigationActiveRef.current &&
          isRecordingTrackRef.current &&
          !isRecordingPausedRef.current &&
          ingest.accepted
        ) {
          const recLon = ingest.kalmanLon;
          const recLat = ingest.kalmanLat;
          const nextPt: [number, number] = [Number(recLon.toFixed(6)), Number(recLat.toFixed(6))];
          const prevCoords = recordedCoordsRef.current;
          let shouldAppend = true;
          let stepKm = 0;
          if (prevCoords.length > 0) {
            const last = prevCoords[prevCoords.length - 1];
            const stepMeters = turf.distance(turf.point(last), turf.point(nextPt), {
              units: 'meters',
            });
            if (stepMeters < 5) {
              shouldAppend = false;
            } else {
              stepKm = stepMeters / 1000;
            }
          }

          if (shouldAppend) {
            const ptIdx = prevCoords.length;
            const nextCoords = [...prevCoords, nextPt];
            const initialEle =
              typeof fix.altitude === 'number' && Number.isFinite(fix.altitude)
                ? Math.round(fix.altitude)
                : null;
            recordedCoordsRef.current = nextCoords;
            recordedTimestampsRef.current = [...recordedTimestampsRef.current, Date.now()];
            recordedElevationsRef.current = [...recordedElevationsRef.current, initialEle];
            setRecordedCoords(nextCoords);
            if (stepKm > 0) {
              setRecordedDistanceKm((d) => Number((d + stepKm).toFixed(2)));
            }

            const ele = await ElevationService.getElevationAt(recLon, recLat, 11, true);
            const resolvedEle = ele ?? initialEle;
            if (resolvedEle !== null) {
              if (ptIdx < recordedElevationsRef.current.length) {
                recordedElevationsRef.current[ptIdx] = resolvedEle;
              }
              if (lastRecordedEleRef.current !== null && resolvedEle > lastRecordedEleRef.current) {
                setRecordedAscentMeters((a) => a + (resolvedEle - (lastRecordedEleRef.current ?? resolvedEle)));
              }
              lastRecordedEleRef.current = resolvedEle;
            }
          }
        }
      },
      (err) => {
        if (pendingLocateFlyRef.current) {
          pendingLocateFlyRef.current = false;
          if (locationModeRef.current === 'none') {
            return;
          }
          if (locationModeRef.current === 'once') {
            applyLocationTransition('map-operation');
          }
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
    shouldWatchGps,
    gpsWatchRestartSeq,
    applySmoothedFrameToMap,
    scheduleSmoothLoop,
    beginCameraTransition,
    applyLocationTransition,
    showToast,
  ]);

  // Continuous device compass stream so user icon & POV-Up map turn smoothly even while stationary
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
        isPovNorthMode(northModeRef.current) &&
        !manualCompassHoldRef.current &&
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
            ...(isFollowingUserRef.current && curLoc ? { center: [curLoc.lon, curLoc.lat] } : {}),
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
          isNavigationActive,
          isLiveSharingActive
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
        isNavigationActive,
        isLiveSharingActive
      );
    }
  }, [isMapReady, userIconPref, isNavigationActive, isLiveSharingActive]);

  // Restore persisted live location sharing config on auth change
  useEffect(() => {
    if (!currentUser?.uid) {
      setLiveShareConfig({
        visibility: 'off',
        sharedWith: [],
        durationPreset: '4h',
        startedAt: new Date().toISOString(),
        expiresAt: null,
        expiresAtMs: null,
      });
      setLivePeers([]);
      setSelectedLivePeer(null);
      return;
    }
    const persisted = loadPersistedShareConfig(currentUser.uid);
    if (persisted) {
      setLiveShareConfig(persisted);
    }
  }, [currentUser?.uid]);

  // Publish GPS fixes while live location sharing is active
  useEffect(() => {
    if (!currentUser?.uid || !userLocation || liveShareConfig.visibility === 'off') {
      return;
    }
    void LiveLocationCloudService.publishFixIfNeeded(
      currentUser,
      liveShareConfig,
      userLocation,
      userIconPref,
      () => {
        setLiveShareConfig((prev) => ({
          ...prev,
          visibility: 'off',
          expiresAt: null,
          expiresAtMs: null,
        }));
        showToast('שיתוף המיקום החי הסתיים (פג תוקף)');
      }
    );
  }, [currentUser, userLocation, liveShareConfig, userIconPref, showToast]);

  // Subscribe to other users' live locations
  useEffect(() => {
    if (!currentUser?.uid || !isOnline || visibility.peerLocations === false) {
      setLivePeers([]);
      setSelectedLivePeer(null);
      return;
    }
    return LiveLocationCloudService.subscribeLiveLocations(
      currentUser,
      { includePublic: visibility.publicPeerLocations !== false },
      (peers) => {
        setLivePeers(peers);
        setSelectedLivePeer((prev) =>
          prev ? peers.find((p) => p.uid === prev.uid) ?? null : null
        );
      },
      (err: any) => {
        const code = String(err?.code || '');
        if (code === 'permission-denied') {
          showToast('אין הרשאת Firestore לקריאת מיקומים חיים (יש לפרוס firestore.rules)', 5000);
        }
      }
    );
  }, [
    currentUser,
    isOnline,
    visibility.peerLocations,
    visibility.publicPeerLocations,
  ]);

  // Render live peer markers on MapLibre
  useEffect(() => {
    const map = mapRef.current;
    const markersMap = peerMarkersRef.current;
    if (!map || !isMapReady || visibility.peerLocations === false) {
      markersMap.forEach((m) => m.remove());
      markersMap.clear();
      return;
    }

    const activeUids = new Set(livePeers.map((p) => p.uid));
    for (const [uid, marker] of markersMap.entries()) {
      if (!activeUids.has(uid)) {
        marker.remove();
        markersMap.delete(uid);
      }
    }

    const mapBearing = map.getBearing() ?? 0;
    for (const peer of livePeers) {
      const peerPref: UserLocationIconPreference = {
        icon: UserLocationIconService.resolveIconOptionById(peer.iconId),
        accentColor: peer.accentColor || '#0ea5e9',
      };
      let marker = markersMap.get(peer.uid);
      if (!marker) {
        const container = document.createElement('div');
        container.className = 'cursor-pointer select-none';
        container.style.position = 'absolute';
        container.style.top = '0';
        container.style.left = '0';
        container.style.zIndex = '18';

        const iconWrap = document.createElement('div');
        iconWrap.dataset.role = 'peer-icon-wrap';
        iconWrap.style.position = 'relative';
        iconWrap.style.width = '76px';
        iconWrap.style.height = '76px';
        UserLocationIconService.renderMarkerElement(
          iconWrap,
          peerPref,
          peer.heading,
          mapBearing,
          false,
          false
        );
        iconWrap.classList.remove('pointer-events-none');
        iconWrap.style.position = 'relative';
        container.appendChild(iconWrap);

        const label = document.createElement('div');
        label.dataset.role = 'peer-label';
        label.className =
          'px-1.5 py-0.5 rounded-md bg-slate-900/85 text-white text-[10px] font-bold whitespace-nowrap shadow border border-white/25 text-center mx-auto -mt-3 relative z-10';
        label.textContent = peer.displayName;
        container.appendChild(label);

        container.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const latest = livePeersRef.current.find((p) => p.uid === peer.uid) ?? peer;
          setSelectedLivePeer(latest);
        });

        marker = new maplibregl.Marker({ element: container, anchor: 'center' })
          .setLngLat([peer.lon, peer.lat])
          .addTo(map);
        markersMap.set(peer.uid, marker);
      } else {
        marker.setLngLat([peer.lon, peer.lat]);
        const el = marker.getElement();
        const iconWrap = el.querySelector<HTMLElement>('[data-role="peer-icon-wrap"]');
        if (iconWrap) {
          UserLocationIconService.renderMarkerElement(
            iconWrap,
            peerPref,
            peer.heading,
            mapBearing,
            false,
            false
          );
          iconWrap.classList.remove('pointer-events-none');
          iconWrap.style.position = 'relative';
        }
        const label = el.querySelector<HTMLElement>('[data-role="peer-label"]');
        if (label && label.textContent !== peer.displayName) {
          label.textContent = peer.displayName;
        }
      }
    }
  }, [isMapReady, livePeers, visibility.peerLocations]);

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

  // Automatically align camera & activate 1-c / 2-c when entering navigation mode, and reset to 1-a / 2-a on exit
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;
    const wasActive = wasNavigationActiveRef.current;
    wasNavigationActiveRef.current = isNavigationActive;

    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const resolvedHeading = resolveCurrentHeading();
    if (isNavigationActive && !wasActive) {
      applyLocationTransition('activate-tracking');
      const targetBearing = resolvedHeading ?? map.getBearing();
      lastCameraBearingRef.current = { ts: performance.now(), bearing: targetBearing };
      const centerCoord: [number, number] | null = latestFrame
        ? [latestFrame.lon, latestFrame.lat]
        : userLocationRef.current
          ? [userLocationRef.current.lon, userLocationRef.current.lat]
          : null;
      beginCameraTransition(500);
      map.easeTo({
        ...(centerCoord ? { center: centerCoord, zoom: Math.max(map.getZoom(), 15.5) } : {}),
        bearing: targetBearing,
        pitch: 60,
        duration: 500,
        essential: true,
      });
    } else if (!isNavigationActive && wasActive) {
      applyLocationTransition('deactivate-to-none');
      lastCameraBearingRef.current = { ts: performance.now(), bearing: 0 };
      beginCameraTransition(450);
      map.easeTo({ bearing: 0, pitch: 0, duration: 450, essential: true });
    }
  }, [isNavigationActive, isMapReady, resolveCurrentHeading, beginCameraTransition, applyLocationTransition]);

  // Mount GeoJSON overlays (POIs + Search Highlight + Saved/Active Routes + Live Recorded Track + Route Planner)
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

        // Place ground line overlays before the first non-RTT layer (symbol/circle/extrusion)
        // so MapLibre 3D RenderToTexture keeps all terrain-draped layers in one FBO stack.
        const rttBeforeId = findFirstNonRttOverlayLayerId(map);

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
          map.addLayer(
            {
              id: 'saved-routes-line',
              type: 'line',
              source: 'saved-routes-src',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: {
                'line-color': routeHighlightColor,
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 8.5, 16, 12],
                'line-opacity': 0.34,
              },
            },
            rttBeforeId
          );
          map.addLayer(
            {
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
            },
            rttBeforeId
          );
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
          map.addLayer(
            {
              id: 'active-route-line',
              type: 'line',
              source: 'active-route-src',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: {
                'line-color': routeHighlightColor,
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 7, 13, 11, 16, 15],
                'line-opacity': 0.44,
              },
            },
            rttBeforeId
          );
          map.addLayer(
            {
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
            },
            rttBeforeId
          );
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
            } else if (f.geometry?.type === 'Point' && f.geometry.coordinates.length >= 2) {
              activeCoordLists.push([f.geometry.coordinates]);
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
          map.addLayer(
            {
              id: 'live-track-line',
              type: 'line',
              source: 'live-track-src',
              paint: {
                'line-color': '#38bdf8',
                'line-width': 4,
                'line-dasharray': [2, 1],
              },
            },
            rttBeforeId
          );
        }

        const activeMapStyle = mapStyleRef.current;
        const isCompactPoiStyle = activeMapStyle === 'nms' || activeMapStyle === 'govmap';
        const poiIconExpression: any = buildPoiIconExpression();
        const poiIconSizeExpression: any = buildPoiIconSizeExpression(activeMapStyle);
        const poiTextColorExpression: any = buildPoiTextColorExpression(
          currentTheme === 'topo-dark'
        );

        // Unified Outdoor POIs Layers (tiered per category minzoom & text zoom thresholds)
        const poiTierSpecs: Array<{
          id: string;
          minzoom: number;
          categories: Array<'peak' | 'campsite' | 'heritage' | 'water' | 'offroad' | 'user'>;
          textField: any;
        }> = [
          {
            id: 'israel-pois-peaks',
            minzoom: POI_CATEGORY_ZOOM_RULES.peak.iconMinZoom,
            categories: ['peak'],
            textField: [
              'step',
              ['zoom'],
              '',
              POI_CATEGORY_ZOOM_RULES.peak.textMinZoom,
              ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
            ],
          },
          {
            id: 'israel-pois-midzoom',
            minzoom: POI_CATEGORY_ZOOM_RULES.campsite.iconMinZoom,
            categories: ['campsite', 'heritage'],
            textField: [
              'step',
              ['zoom'],
              '',
              POI_CATEGORY_ZOOM_RULES.campsite.textMinZoom,
              ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
            ],
          },
          {
            id: 'israel-pois-labels',
            minzoom: POI_CATEGORY_ZOOM_RULES.water.iconMinZoom,
            categories: ['water', 'offroad', 'user'],
            textField: ['coalesce', ['get', 'nameHe'], ['get', 'name'], ''],
          },
        ];

        const existingPoiSrc = map.getSource('israel-pois-src') as maplibregl.GeoJSONSource;
        if (!existingPoiSrc) {
          const poiGeoJson = PoiManager.toCompactMapGeoJSON(currentPois);
          lastPoiSyncRef.current = currentPois;
          map.addSource('israel-pois-src', { type: 'geojson', data: poiGeoJson });
        } else if (lastPoiSyncRef.current !== currentPois) {
          existingPoiSrc.setData(PoiManager.toCompactMapGeoJSON(currentPois));
          lastPoiSyncRef.current = currentPois;
        }

        const iconAllowOverlapExpr: any = ['step', ['zoom'], false, 15.5, true];
        const iconPaddingExpr: any = ['interpolate', ['linear'], ['zoom'], 11.5, 1.5, 14, 1.2, 16, 0.8];
        const textSizeExpr: any = isCompactPoiStyle
          ? ['interpolate', ['linear'], ['zoom'], 12.5, 9.8, 14, 11.0, 16, 12.2, 18, 12.8]
          : ['interpolate', ['linear'], ['zoom'], 12.5, 10.8, 14, 12.4, 16, 14];
        const textOffsetExpr: any = isCompactPoiStyle
          ? [
              'interpolate',
              ['linear'],
              ['zoom'],
              12.5,
              ['literal', [0, 0.62]],
              14,
              ['literal', [0, 0.74]],
              16,
              ['literal', [0, 0.86]],
              17.5,
              ['literal', [0, 0.94]],
            ]
          : [
              'interpolate',
              ['linear'],
              ['zoom'],
              12.5,
              ['literal', [0, 0.72]],
              14,
              ['literal', [0, 0.92]],
              16,
              ['literal', [0, 1.12]],
              17.5,
              ['literal', [0, 1.28]],
            ];
        const poiVisibilityValue = isMasterPoiActive(currentVis) ? 'visible' : 'none';
        const poiHaloColor =
          currentTheme === 'topo-dark' ? '#0b1015' : isCompactPoiStyle ? '#FFFFFF' : 'white';

        for (const tier of poiTierSpecs) {
          const tierFilter = buildPoiTieredLayerFilter(currentVis, tier.categories);
          if (map.getLayer(tier.id)) {
            map.setFilter(tier.id, tierFilter);
            map.setLayerZoomRange(tier.id, tier.minzoom, 24);
            map.setLayoutProperty(tier.id, 'visibility', poiVisibilityValue);
            map.setLayoutProperty(tier.id, 'icon-image', poiIconExpression);
            map.setLayoutProperty(tier.id, 'icon-size', poiIconSizeExpression);
            map.setLayoutProperty(tier.id, 'icon-allow-overlap', iconAllowOverlapExpr);
            map.setLayoutProperty(tier.id, 'icon-padding', iconPaddingExpr);
            map.setLayoutProperty(tier.id, 'text-field', tier.textField);
            map.setLayoutProperty(tier.id, 'text-size', textSizeExpr);
            map.setLayoutProperty(tier.id, 'text-offset', textOffsetExpr);
            map.setPaintProperty(tier.id, 'text-color', poiTextColorExpression);
            map.setPaintProperty(tier.id, 'text-halo-color', poiHaloColor);
          } else {
            map.addLayer({
              id: tier.id,
              type: 'symbol',
              source: 'israel-pois-src',
              minzoom: tier.minzoom,
              filter: tierFilter,
              layout: {
                visibility: poiVisibilityValue,
                'symbol-sort-key': ['coalesce', ['get', 'priority'], 500],
                'icon-image': poiIconExpression,
                'icon-size': poiIconSizeExpression,
                'icon-anchor': 'center',
                'icon-allow-overlap': iconAllowOverlapExpr,
                'icon-ignore-placement': false,
                'icon-padding': iconPaddingExpr,
                'text-field': tier.textField,
                'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
                'text-size': textSizeExpr,
                'text-offset': textOffsetExpr,
                'text-anchor': 'top',
                'text-max-width': 9,
                'text-allow-overlap': false,
                'text-ignore-placement': false,
                'text-optional': true,
                'text-padding': 3,
              },
              paint: {
                'text-color': poiTextColorExpression,
                'text-halo-color': poiHaloColor,
                'text-halo-width': 3,
                'text-halo-blur': 1.5,
              },
            });
          }
        }
        raiseRegionalTrailNamesAbove(
          map,
          poiTierSpecs.map((tier) => tier.id)
        );

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
          map.addLayer(
            {
              id: 'plan-route-network-casing',
              type: 'line',
              source: 'plan-route-network-src',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: {
                'line-color': planCasingColor,
                'line-width': 7.5,
                'line-opacity': 0.9,
              },
            },
            rttBeforeId
          );
          map.addLayer(
            {
              id: 'plan-route-network-line',
              type: 'line',
              source: 'plan-route-network-src',
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: {
                'line-color': ['coalesce', ['get', 'color'], modeColor],
                'line-width': 4.2,
                'line-opacity': 0.95,
              },
            },
            rttBeforeId
          );
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
          map.addLayer(
            {
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
            },
            rttBeforeId
          );
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
          map.addLayer(
            {
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
            },
            rttBeforeId
          );
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
    []
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
      existingDem?.contourProtocolUrl || pmtilesRegistry.getDefaultContourProtocolUrl() || null;

    mountedStyleKeyRef.current = `${initialOsmUrl}|${initialDemUrl}|${initialContourUrl || ''}|${themeRef.current}|${mapStyleRef.current}`;
    isStyleLoadedRef.current = false;

    const initialCommunityRoads = communityRoadsRef.current;
    const initialStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: initialOsmUrl,
      demProtocolUrl: initialDemUrl,
      contourProtocolUrl: initialContourUrl,
      worldProtocolUrl: pmtilesRegistry.getDefaultWorldProtocolUrl(),
      visibility: visibilityRef.current,
      theme: themeRef.current,
      mapStyle: mapStyleRef.current,
      overriddenOsmWayIds: extractOverriddenOsmWayIds(initialCommunityRoads),
      communityRoadsGeoJSON: buildCommunityRoadsGeoJSON(initialCommunityRoads),
      trailOverlayGeoJSON: filterTrailOverlayByCommunityRoads(
        trailOverlayGeoJSONRef.current,
        initialCommunityRoads
      ),
      showTrailOverlay: showTrailOverlayRef.current,
    });

    const startupCamera = UserStateSyncService.getStartupState().camera;
    lastRecordedCameraRef.current = { ...startupCamera };

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: initialStyle,
      center: [startupCamera.lon, startupCamera.lat],
      zoom: startupCamera.zoom,
      bearing: 0,
      pitch: 0,
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
        if (isStyleLoadedRef.current) {
          map.triggerRepaint();
        }
      });
      resizeObserver.observe(mapContainerRef.current);
    }

    map.on('load', () => {
      if (isCancelled) return;
      isStyleLoadedRef.current = true;
      setIsMapReady(true);
      setMapStyleRevision((revision) => revision + 1);
      map.resize();
      applyLayerVisibilityToMap(
        map,
        visibilityRef.current,
        PoiManager.getDeletedSignatures()
      );
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

    const syncNorthFromMapPitch = (fromUserGesture: boolean) => {
      if (!fromUserGesture) return;
      const nextFromPitch = resolveNorthModeFromMapPitch(northModeRef.current, map.getPitch());
      if (nextFromPitch !== northModeRef.current) {
        syncNorthModeStateRef.current(nextFromPitch, { fromGesture: true });
      }
    };

    const syncNorthFromManualRotate = (fromUserGesture: boolean) => {
      if (!fromUserGesture) return;
      const nextFromRotate = resolveNorthModeFromManualRotate(
        northModeRef.current,
        isFollowingUserRef.current
      );
      if (nextFromRotate !== northModeRef.current) {
        syncNorthModeStateRef.current(nextFromRotate, { fromGesture: true });
      }
    };

    const isSuppressedByProgrammaticNorth = (ev?: any) =>
      Boolean(
        ev?.programmaticNorthControl ||
          ev?.navFollowTick ||
          performance.now() < programmaticNorthUntilRef.current
      );

    map.on('mousedown', () => {
      if (isCancelled) return;
      programmaticNorthUntilRef.current = 0;
    });

    map.on('touchstart', () => {
      if (isCancelled) return;
      programmaticNorthUntilRef.current = 0;
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
      const fromUserRotate =
        !isSuppressedByProgrammaticNorth(ev) &&
        (Boolean(ev?.originalEvent) ||
          (userRotateGestureActiveRef.current && !cameraTransitionInFlightRef.current));
      syncNorthFromManualRotate(fromUserRotate);
    });

    map.on('rotatestart', (ev) => {
      if (isCancelled) return;
      if (!isSuppressedByProgrammaticNorth(ev) && ev?.originalEvent) {
        userRotateGestureActiveRef.current = true;
        manualCompassHoldRef.current = true;
        cameraTransitionInFlightRef.current = false;
        handleUserMapOperationRef.current();
        syncNorthFromManualRotate(true);
      }
    });

    map.on('rotateend', () => {
      if (isCancelled) return;
      userRotateGestureActiveRef.current = false;
    });

    map.on('dragstart', () => {
      if (isCancelled) return;
      handleUserMapOperationRef.current();
    });

    map.on('pitchstart', (ev) => {
      if (isCancelled) return;
      if (!isSuppressedByProgrammaticNorth(ev) && ev?.originalEvent) {
        userPitchGestureActiveRef.current = true;
        manualCompassHoldRef.current = true;
        cameraTransitionInFlightRef.current = false;
        handleUserMapOperationRef.current();
      }
    });

    map.on('pitch', (ev: any) => {
      if (isCancelled) return;
      if (isSuppressedByProgrammaticNorth(ev)) return;
      const fromUserPitch =
        Boolean(ev?.originalEvent) ||
        (userPitchGestureActiveRef.current && !cameraTransitionInFlightRef.current);
      syncNorthFromMapPitch(fromUserPitch);
    });

    map.on('pitchend', (ev: any) => {
      if (isCancelled) return;
      if (isSuppressedByProgrammaticNorth(ev)) {
        userPitchGestureActiveRef.current = false;
        return;
      }
      const fromUserPitch =
        Boolean(ev?.originalEvent) ||
        (userPitchGestureActiveRef.current && !cameraTransitionInFlightRef.current);
      syncNorthFromMapPitch(fromUserPitch);
      userPitchGestureActiveRef.current = false;
    });

    map.on('zoomstart', (ev) => {
      if (isCancelled) return;
      if (ev?.originalEvent) {
        userZoomingRef.current = true;
        handleUserMapOperationRef.current();
      }
    });

    map.on('zoomend', () => {
      if (isCancelled) return;
      userZoomingRef.current = false;
    });

    map.on('moveend', async (ev: any) => {
      if (isCancelled) return;
      if (ev?.programmaticNorthControl) {
        programmaticNorthUntilRef.current = 0;
      }
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
      if (
        isCancelled ||
        map.isMoving() ||
        map.isZooming() ||
        map.isRotating() ||
        (e.originalEvent?.buttons ?? 0) !== 0
      ) {
        return;
      }
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
      setCursorCoords((prev) => {
        const nextEle = ele !== null ? ele : prev.ele;
        if (prev.lon === lon && prev.lat === lat && prev.ele === nextEle && prev.zoom === zoom) {
          return prev;
        }
        return { lon, lat, ele: nextEle, zoom };
      });
    });

    const selectPoiFromRenderedFeature = (
      feature: any,
      fallbackLngLat: { lng: number; lat: number }
    ) => {
      if (!feature || !feature.properties) return;
      const p = feature.properties as any;
      const layerId = String(feature.layer?.id || '');
      const geomCoords =
        feature.geometry && feature.geometry.type === 'Point'
          ? (feature.geometry as GeoJSON.Point).coordinates
          : undefined;
      const lon = Number(p.lon ?? geomCoords?.[0] ?? fallbackLngLat.lng);
      const lat = Number(p.lat ?? geomCoords?.[1] ?? fallbackLngLat.lat);

      let clickedPoi: PoiRecord;
      if (
        layerId === 'israel-pois-labels' ||
        layerId === 'israel-pois-midzoom' ||
        layerId === 'israel-pois-peaks'
      ) {
        const featureId = String(p.id || feature.id || '');
        const fullRecord = featureId
          ? poisRef.current.find((item) => item.id === featureId)
          : undefined;
        clickedPoi = fullRecord ?? {
          id: featureId,
          name: p.nameHe || p.name,
          nameHe: p.nameHe || p.name,
          nameEn: p.nameEn || p.nameHe || p.name,
          category: p.category,
          subcategory: p.subcategory,
          lon,
          lat,
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
      } else {
        const resolved = PoiManager.resolveRenderedVectorPoi({
          featureProps: p,
          layerId,
          lon,
          lat,
          existingPois: poisRef.current,
          vectorCategory: getVectorPoiLayerCategory(layerId),
        });
        if (!resolved) return;
        clickedPoi = resolved;
      }

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

    const geoJsonPoiLayerIds = ['israel-pois-labels', 'israel-pois-midzoom', 'israel-pois-peaks'];
    const isSelectableRenderedFeature = (
      f: any,
      fallbackLngLat: { lng: number; lat: number }
    ): boolean => {
      const lid = String(f?.layer?.id || '');
      if (geoJsonPoiLayerIds.includes(lid)) return true;
      const fp = (f?.properties || {}) as Record<string, any>;
      const coords =
        f?.geometry && f.geometry.type === 'Point'
          ? (f.geometry as GeoJSON.Point).coordinates
          : undefined;
      const fLon = Number(fp.lon ?? coords?.[0] ?? fallbackLngLat.lng);
      const fLat = Number(fp.lat ?? coords?.[1] ?? fallbackLngLat.lat);
      return (
        PoiManager.resolveRenderedVectorPoi({
          featureProps: fp,
          layerId: lid,
          lon: fLon,
          lat: fLat,
          existingPois: poisRef.current,
          vectorCategory: getVectorPoiLayerCategory(lid),
        }) !== null
      );
    };

    const handleMapClick = (e: maplibregl.MapMouseEvent) => {
      if (isCancelled) return;
      handleUserMapOperationRef.current();
      if (isPickingPoiRef.current) {
        e.preventDefault();
        openAddPoiPanelAtRef.current({
          lon: Number(e.lngLat.lng.toFixed(6)),
          lat: Number(e.lngLat.lat.toFixed(6)),
          ele: null,
        });
        return;
      }
      if (isPlanningRouteRef.current) {
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
        return;
      }

      if (isTrailMarkingModeRef.current) {
        e.preventDefault();
        void handleTrailMapClickRef.current(e);
        return;
      }

      const clickableLayers = [...geoJsonPoiLayerIds, ...Array.from(POI_STYLE_LAYER_IDS)].filter((id) =>
        Boolean(map.getLayer(id))
      );
      if (clickableLayers.length === 0) return;
      const hitFeatures = map.queryRenderedFeatures(
        [
          [e.point.x - 8, e.point.y - 8],
          [e.point.x + 8, e.point.y + 8],
        ],
        { layers: clickableLayers }
      );
      if (!hitFeatures || hitFeatures.length === 0) return;
      const activeHits = hitFeatures.filter((f) => isSelectableRenderedFeature(f, e.lngLat));
      if (activeHits.length === 0) return;
      const preferred =
        activeHits.find((f) => geoJsonPoiLayerIds.includes(String(f.layer?.id || ''))) || activeHits[0];
      selectPoiFromRenderedFeature(preferred, e.lngLat);
    };

    const handleMapPlanDblClick = (e: maplibregl.MapMouseEvent) => {
      if (isCancelled) return;
      if (isTrailMarkingModeRef.current && trailSubModeRef.current === 'add-road' && isDrawingRoadRef.current) {
        e.preventDefault();
        if ((roadDraftRef.current?.coordinates.length ?? 0) >= 2) {
          setIsDrawingRoad(false);
          setRoadSnapPreview(null);
        }
        return;
      }
      if (!isPlanningRouteRef.current) return;
      e.preventDefault();
      if (clickTimerRef.current) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      void handleFinishPlanningRef.current();
    };

    const startRoadVertexDrag = (e: maplibregl.MapLayerMouseEvent | maplibregl.MapLayerTouchEvent) => {
      if (!isTrailMarkingModeRef.current || !roadDraftRef.current) return;
      const idx = e.features?.[0]?.properties?.vertexIndex;
      if (typeof idx !== 'number') return;
      e.preventDefault();
      draggingRoadVertexIdxRef.current = idx;
      setSelectedRoadVertexIndex(idx);
      map.dragPan.disable();
    };

    const handleTrailRoadMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (isCancelled || !isTrailMarkingModeRef.current) return;
      const dragIdx = draggingRoadVertexIdxRef.current;
      if (dragIdx !== null && roadDraftRef.current) {
        moveRoadDraftVertex(dragIdx, e.lngLat.lng, e.lngLat.lat, null);
        const now = performance.now();
        if (now - lastRoadSnapTsRef.current >= 80) {
          lastRoadSnapTsRef.current = now;
          void snapPointToExistingRoads(
            e.lngLat.lng,
            e.lngLat.lat,
            ROAD_SEGMENT_SNAP_METERS,
            ROAD_VERTEX_SNAP_METERS,
            roadDraftRef.current?.roadId,
            roadDraftRef.current?.sourceOsmWayId
          ).then((snap) => {
            if (!isCancelled && draggingRoadVertexIdxRef.current === dragIdx) {
              setRoadSnapPreview(snap);
            }
          });
        }
        return;
      }
      if (
        !(
          isDrawingRoadRef.current ||
          (roadDraftRef.current && selectedRoadVertexIndexRef.current !== null)
        )
      ) {
        return;
      }
      const now = performance.now();
      if (now - lastRoadSnapTsRef.current < 80) return;
      lastRoadSnapTsRef.current = now;
      void snapPointToExistingRoads(
        e.lngLat.lng,
        e.lngLat.lat,
        ROAD_SEGMENT_SNAP_METERS,
        ROAD_VERTEX_SNAP_METERS,
        roadDraftRef.current?.roadId,
        roadDraftRef.current?.sourceOsmWayId
      ).then((snap) => {
        if (!isCancelled) {
          setRoadSnapPreview(snap);
        }
      });
    };

    const finishRoadVertexDrag = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      const dragIdx = draggingRoadVertexIdxRef.current;
      if (dragIdx === null) return;
      draggingRoadVertexIdxRef.current = null;
      justDraggedRoadVertexRef.current = true;
      map.dragPan.enable();
      const lng = e.lngLat.lng;
      const lat = e.lngLat.lat;
      void snapPointToExistingRoads(
        lng,
        lat,
        ROAD_SEGMENT_SNAP_METERS,
        ROAD_VERTEX_SNAP_METERS,
        roadDraftRef.current?.roadId,
        roadDraftRef.current?.sourceOsmWayId
      ).then((snap) => {
        moveRoadDraftVertex(dragIdx, lng, lat, snap);
        setRoadSnapPreview(null);
      });
    };

    map.on('click', handleMapClick);
    map.on('dblclick', handleMapPlanDblClick);
    map.on('mousedown', 'community-road-draft-vertices', startRoadVertexDrag);
    map.on('touchstart', 'community-road-draft-vertices', startRoadVertexDrag);
    map.on('mousemove', handleTrailRoadMouseMove);
    map.on('touchmove', (e) => {
      if (draggingRoadVertexIdxRef.current !== null && roadDraftRef.current) {
        moveRoadDraftVertex(draggingRoadVertexIdxRef.current, e.lngLat.lng, e.lngLat.lat, null);
      }
    });
    map.on('mouseup', finishRoadVertexDrag);
    map.on('touchend', finishRoadVertexDrag);
    // Single throttled POI hover cursor probe (replaces 25+ per-layer delegated listeners that each triggered queryRenderedFeatures -> gl.readPixels in 3D)
    const hoverPoiLayerIds = [...geoJsonPoiLayerIds, ...Array.from(POI_STYLE_LAYER_IDS)];
    let lastHoverQueryTs = 0;
    let lastHoverX = -999;
    let lastHoverY = -999;
    let hasHoverPointer = false;
    const resetHoverCursor = () => {
      if (!hasHoverPointer) return;
      hasHoverPointer = false;
      map.getCanvas().style.cursor =
        isPlanningRouteRef.current || isPickingPoiRef.current ? 'crosshair' : '';
    };
    map.on('movestart', resetHoverCursor);
    map.on('mouseout', resetHoverCursor);
    map.on('mousemove', (e) => {
      if (isCancelled || isPlanningRouteRef.current || isTrailMarkingModeRef.current) return;
      if (
        map.isMoving() ||
        map.isZooming() ||
        map.isRotating() ||
        (e.originalEvent?.buttons ?? 0) !== 0
      ) {
        return;
      }
      if (Math.abs(e.point.x - lastHoverX) < 3 && Math.abs(e.point.y - lastHoverY) < 3) {
        return;
      }
      const now = performance.now();
      if (now - lastHoverQueryTs < 120) return;
      lastHoverQueryTs = now;
      lastHoverX = e.point.x;
      lastHoverY = e.point.y;

      const activeLayers = hoverPoiLayerIds.filter((id) => Boolean(map.getLayer(id)));
      const anySelectable =
        activeLayers.length > 0 &&
        map
          .queryRenderedFeatures(e.point, { layers: activeLayers })
          .some((f) => isSelectableRenderedFeature(f, e.lngLat));
      if (anySelectable !== hasHoverPointer) {
        hasHoverPointer = anySelectable;
        map.getCanvas().style.cursor = anySelectable
          ? 'pointer'
          : isPlanningRouteRef.current || isPickingPoiRef.current
            ? 'crosshair'
            : '';
      }
    });

    // Mount PMTiles DEM/OSM immediately without blocking behind Auth or Firestore startup timeouts
    const archivesPromise = pmtilesRegistry
      .initializeDefaultIsraelArchives()
      .then(({ dem, osm }) => {
        if (isCancelled) return { dem: null, osm: null };
        if (dem) {
          setDemInfo(dem);
          setIsDemUnavailable(false);
        } else {
          setIsDemUnavailable(true);
        }
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
        return { dem, osm };
      })
      .catch((err) => {
        console.warn('[App] Archive init warning:', err);
        return { dem: null, osm: null };
      });

    (async () => {
      try {
        const bootUser = currentUserRef.current ?? AuthService.getCurrentUser();
        const bootUid = bootUser?.uid ?? null;
        const prevStoredUid = readStoredLastAuthUid();
        if (bootUser) {
          if (prevStoredUid && prevStoredUid !== bootUser.uid) {
            await Promise.all([
              RouteManager.purgeOtherUsersCachedRoutes(bootUser.uid),
              PoiManager.purgePrivateAndSharedPoisForUserSwitch(bootUser.uid),
            ]);
          } else {
            await RouteManager.claimUnownedRoutesForUser(bootUser);
          }
          writeStoredLastAuthUid(bootUser.uid);
        } else {
          await Promise.all([
            RouteManager.purgeOtherUsersCachedRoutes(null),
            PoiManager.purgePrivateAndSharedPoisForUserSwitch(null),
          ]);
        }
        const [, loadedPois, loadedRoutes] = await Promise.all([
          archivesPromise,
          PoiManager.initializePois(),
          RouteManager.initializeStarterRoutes(bootUid),
        ]);

        if (isCancelled) return;
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

  // Effect A: Rebuild style only when theme or PMTiles archive URL changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const effectiveOsmUrl = osmInfo?.protocolUrl || pmtilesRegistry.getDefaultOsmProtocolUrl();
    const demDisabled = !demInfo && isDemUnavailable;
    const effectiveDemUrl = demDisabled
      ? ''
      : demInfo?.protocolUrl || pmtilesRegistry.getDefaultDemProtocolUrl();
    const effectiveContourUrl = demDisabled
      ? null
      : demInfo?.contourProtocolUrl || pmtilesRegistry.getDefaultContourProtocolUrl() || null;
    const nextStyleKey = `${effectiveOsmUrl}|${effectiveDemUrl}|${effectiveContourUrl || ''}|${demDisabled ? 'nodem' : 'dem'}|${theme}|${mapStyle}`;
    if (mountedStyleKeyRef.current === nextStyleKey) {
      return;
    }
    mountedStyleKeyRef.current = nextStyleKey;
    isStyleLoadedRef.current = false;
    lastPoiSyncRef.current = null;

    const currentCommunityRoads = communityRoadsRef.current;
    const newStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: effectiveOsmUrl,
      demProtocolUrl: effectiveDemUrl,
      contourProtocolUrl: effectiveContourUrl,
      disableDem: demDisabled,
      worldProtocolUrl: pmtilesRegistry.getDefaultWorldProtocolUrl(),
      visibility: visibilityRef.current,
      theme,
      mapStyle,
      overriddenOsmWayIds: extractOverriddenOsmWayIds(currentCommunityRoads),
      communityRoadsGeoJSON: buildCommunityRoadsGeoJSON(currentCommunityRoads),
      trailOverlayGeoJSON: filterTrailOverlayByCommunityRoads(
        trailOverlayGeoJSONRef.current,
        currentCommunityRoads
      ),
      showTrailOverlay: showTrailOverlayRef.current,
    });

    let completed = false;
    const restoreOverlays = () => {
      completed = true;
      if (mapRef.current !== map) return;
      baseHighwayLayerFiltersRef.current.clear();
      isStyleLoadedRef.current = true;
      setMapStyleRevision((revision) => revision + 1);
      applyLayerVisibilityToMap(
        map,
        visibilityRef.current,
        PoiManager.getDeletedSignatures()
      );
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
    // Detach active 3D terrain before diff:false reset so projection/shader state cannot race mid-reload.
    if (map.getTerrain?.()) {
      map.setTerrain(null);
    }
    map.setStyle(newStyle, { diff: false });

    return () => {
      map.off('style.load', restoreOverlays);
      if (!completed && mountedStyleKeyRef.current === nextStyleKey) {
        mountedStyleKeyRef.current = '';
      }
    };
  }, [isMapReady, demInfo, isDemUnavailable, osmInfo, theme, mapStyle, syncOverlaySourcesToMap]);

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

    applyLayerVisibilityToMap(map, visibility, PoiManager.getDeletedSignatures());
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;

    const existingRoadsSrc = map.getSource(COMMUNITY_ROADS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existingRoadsSrc) {
      existingRoadsSrc.setData(communityRoadsGeoJSON);
    } else {
      map.addSource(COMMUNITY_ROADS_SOURCE_ID, {
        type: 'geojson',
        data: communityRoadsGeoJSON,
      });
    }

    const hideCommunityRoads =
      isAerialOverlayActive(visibility) && Boolean(visibility.hideRoadsOnExternalMap);

    // The style ships with these layers (copies of the base highway layers); this only fills gaps
    ensureCommunityRoadLayersOnMap(map, theme, !hideCommunityRoads);

    const draftSourceId = 'community-road-draft-src';
    const existingDraftSrc = map.getSource(draftSourceId) as maplibregl.GeoJSONSource | undefined;
    if (existingDraftSrc) {
      existingDraftSrc.setData(communityRoadDraftGeoJSON);
    } else {
      map.addSource(draftSourceId, { type: 'geojson', data: communityRoadDraftGeoJSON });
    }
    if (!map.getLayer('community-road-removed-line')) {
      map.addLayer(
        {
          id: 'community-road-removed-line',
          type: 'line',
          source: draftSourceId,
          filter: ['==', ['get', 'role'], 'removed-road'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#e11d48',
            'line-width': 3,
            'line-opacity': 0.75,
            'line-dasharray': [1, 2],
          },
        },
        findFirstNonRttOverlayLayerId(map)
      );
    }
    if (!map.getLayer('community-road-draft-line')) {
      map.addLayer(
        {
          id: 'community-road-draft-line',
          type: 'line',
          source: draftSourceId,
          filter: ['==', ['get', 'role'], 'draft-line'],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#10b981',
            'line-width': 4,
            'line-dasharray': [3, 2],
          },
        },
        findFirstNonRttOverlayLayerId(map)
      );
      map.addLayer({
        id: 'community-road-draft-midpoints',
        type: 'circle',
        source: draftSourceId,
        filter: ['==', ['get', 'role'], 'midpoint-handle'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#ffffff',
          'circle-opacity': 0.85,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#10b981',
        },
      });
      map.addLayer({
        id: 'community-road-draft-vertices',
        type: 'circle',
        source: draftSourceId,
        filter: ['in', ['get', 'role'], ['literal', ['draft-vertex', 'anchor-vertex']]],
        paint: {
          'circle-radius': [
            'case',
            ['==', ['coalesce', ['get', 'selected'], false], true],
            8.5,
            ['==', ['get', 'role'], 'anchor-vertex'],
            6,
            4.5,
          ],
          'circle-color': [
            'case',
            ['==', ['coalesce', ['get', 'selected'], false], true],
            '#0ea5e9',
            ['==', ['get', 'role'], 'anchor-vertex'],
            '#10b981',
            '#f59e0b',
          ],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
        },
      });
      map.addLayer({
        id: 'community-road-snap-ring',
        type: 'circle',
        source: draftSourceId,
        filter: ['==', ['get', 'role'], 'snap-ring'],
        paint: {
          'circle-radius': 9,
          'circle-color': 'rgba(16, 185, 129, 0.2)',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#10b981',
        },
      });
    }

    // Hide base OSM highway features & labels that have an active osm-override so only the edited road renders
    applyHighwayOverrideFiltersToMap(
      map,
      overriddenOsmWayIds,
      baseHighwayLayerFiltersRef.current
    );

    // The road line layers follow their base highway layers (applyLayerVisibilityToMap); only the
    // label layer is toggled here.
    if (map.getLayer(COMMUNITY_ROADS_LABEL_LAYER_ID)) {
      map.setLayoutProperty(
        COMMUNITY_ROADS_LABEL_LAYER_ID,
        'visibility',
        hideCommunityRoads ? 'none' : 'visible'
      );
    }
  }, [
    isMapReady,
    theme,
    mapStyleRevision,
    visibility.googleSatellite,
    visibility.govmapOrtho,
    visibility.hideRoadsOnExternalMap,
    overriddenOsmWayIds,
    communityRoadsGeoJSON,
    communityRoadDraftGeoJSON,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !map.isStyleLoaded()) return;

    const existing = map.getSource(COMMUNITY_TRAILS_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(filteredTrailOverlayGeoJSON);
    } else {
      map.addSource(COMMUNITY_TRAILS_SOURCE_ID, {
        type: 'geojson',
        data: filteredTrailOverlayGeoJSON,
      });
    }

    const trailsVisible =
      showTrailOverlay &&
      !(isAerialOverlayActive(visibility) && Boolean(visibility.hideRoadsOnExternalMap));
    const beforeId = map.getLayer('saved-routes-line')
      ? 'saved-routes-line'
      : findFirstNonRttOverlayLayerId(map);

    if (!map.getLayer('community-trails-casing')) {
      const { groundLayers, symbolLayers } = buildCommunityTrailLayerSpecs(
        theme,
        trailsVisible
      );
      for (const layerSpec of groundLayers) {
        if (!map.getLayer(layerSpec.id)) {
          map.addLayer(layerSpec as maplibregl.AddLayerObject, beforeId);
        }
      }
      for (const layerSpec of symbolLayers) {
        if (!map.getLayer(layerSpec.id)) {
          map.addLayer(layerSpec as maplibregl.AddLayerObject);
        }
      }
    }

    for (const layerId of COMMUNITY_TRAILS_LAYER_IDS) {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', trailsVisible ? 'visible' : 'none');
      }
    }
  }, [
    isMapReady,
    mapStyleRevision,
    filteredTrailOverlayGeoJSON,
    showTrailOverlay,
    visibility.googleSatellite,
    visibility.govmapOrtho,
    visibility.hideRoadsOnExternalMap,
    theme,
  ]);

  // Mirror routes, user POIs, theme, layer visibility, and active navigation status for Android Auto
  useEffect(() => {
    carSyncService.scheduleSync({
      activeRoute,
      routes,
      pois,
      overriddenPoiIds: PoiManager.getOverriddenPoiIdsSnapshot(),
      deletedPoiIds: PoiManager.getDeletedPoiIdsSnapshot(),
      isNavigationActive: isNavigatingRoute || isFreeNavigation,
      theme,
      visibility,
    });
  }, [activeRoute, routes, pois, isNavigatingRoute, isFreeNavigation, theme, visibility]);

  // Initialize unified PMTiles full-map search index lazily (on search focus or after map settles)
  useEffect(() => {
    const unsubStatus = pmtilesSearchService.subscribeStatus((st) => {
      setSearchStatus(st);
    });
    return () => {
      unsubStatus();
    };
  }, []);

  useEffect(() => {
    if (isSearchFocused || isNavSearchOpen) {
      void pmtilesSearchService.ensureInitialized().then(() => {
        if (osmInfo) void pmtilesSearchService.syncWithOsmArchive(osmInfo);
      });
      return;
    }
    if (!isMapReady) return;
    const timer = window.setTimeout(() => {
      void pmtilesSearchService.ensureInitialized().then(() => {
        if (osmInfo) void pmtilesSearchService.syncWithOsmArchive(osmInfo);
      });
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [isSearchFocused, isNavSearchOpen, isMapReady, osmInfo]);

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

  // ---- Search during navigation: the search icon opens a search box, closing it discards the query ----
  const openNavSearch = useCallback(() => {
    setMobileSpeedDial(null);
    setIsNavSearchOpen(true);
    setIsSearchFocused(true);
  }, []);

  const closeNavSearch = useCallback(() => {
    setIsNavSearchOpen(false);
    setIsSearchFocused(false);
    setSearchQuery('');
    setExecutedSearchQuery('');
    setSearchResults([]);
  }, []);

  // Collapse mobile floating speed-dial when tapping outside the mobile control column.
  useEffect(() => {
    if (!mobileSpeedDial) return;
    const handlePointerDown = (ev: PointerEvent) => {
      if (
        mobileControlsRef.current &&
        ev.target instanceof Node &&
        !mobileControlsRef.current.contains(ev.target)
      ) {
        setMobileSpeedDial(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [mobileSpeedDial]);

  // Close desktop top dropdown menus ('מסלולים' / 'עריכת מפה') on outside click or Escape.
  useEffect(() => {
    if (!desktopTopMenu) return;
    const handlePointerDown = (ev: PointerEvent) => {
      if (
        desktopTopMenuRef.current &&
        ev.target instanceof Node &&
        !desktopTopMenuRef.current.contains(ev.target)
      ) {
        setDesktopTopMenu(null);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setDesktopTopMenu(null);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [desktopTopMenu]);

  const toggleDesktopTopMenu = useCallback((menu: 'trails' | 'map-edit') => {
    setLayerSheetSection(null);
    setIsUserIconPickerOpen(false);
    setIsGoogleMenuOpen(false);
    setDesktopTopMenu((prev) => (prev === menu ? null : menu));
  }, []);

  const toggleDesktopLayerSection = useCallback((sectionId: LayerSheetSection) => {
    setDesktopTopMenu(null);
    setIsUserIconPickerOpen(false);
    setIsGoogleMenuOpen(false);
    setLayerSheetSection((prev) => (prev === sectionId ? null : sectionId));
  }, []);

  const toggleDesktopUserIconPicker = useCallback(() => {
    setDesktopTopMenu(null);
    setLayerSheetSection(null);
    setIsGoogleMenuOpen(false);
    setIsUserIconPickerOpen((prev) => !prev);
  }, []);

  const handleDesktopGoogleMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      setDesktopTopMenu(null);
      setLayerSheetSection(null);
      setIsUserIconPickerOpen(false);
    }
    setIsGoogleMenuOpen(open);
  }, []);

  const openShareLocationModal = useCallback(() => {
    setDesktopTopMenu(null);
    setLayerSheetSection(null);
    setIsUserIconPickerOpen(false);
    setIsGoogleMenuOpen(false);
    setMobileSpeedDial(null);
    setIsShareLocationModalOpen(true);
  }, []);

  // Tapping anywhere outside the box closes it (the search icon itself is excluded: it toggles).
  useEffect(() => {
    if (!isNavSearchOpen) return;
    const handlePointerDown = (ev: PointerEvent) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;
      if (searchContainerRef.current?.contains(target)) return;
      if (target.closest('[data-nav-search-toggle]')) return;
      closeNavSearch();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [isNavSearchOpen, closeNavSearch]);

  // The box only exists in mobile navigating mode; never leave it flagged open elsewhere.
  useEffect(() => {
    if (isNavSearchOpen && !(isMobile && mobileDisplayMode === 'navigating')) {
      closeNavSearch();
    }
  }, [isNavSearchOpen, isMobile, mobileDisplayMode, closeNavSearch]);

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
        trailAnnotations: trailSearchItems,
        deletedSignatures: PoiManager.getDeletedSignatures(),
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
    trailSearchItems,
  ]);

  // Auto-select longest saved route when opening Routes drawer, or newest recording when opening Recordings
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

    const recordingsUiOpen =
      (!isMobile && desktopDrawer === 'recordings') ||
      (isMobile && mobileDisplayMode === 'planning' && mobileTab === 'recordings');
    if (
      recordingsUiOpen &&
      currentUser &&
      (!activeRoute || !isRecordedRouteFormat(activeRoute.sourceFormat))
    ) {
      const userRecordings = routes.filter(
        (r) =>
          isRecordedRouteFormat(r.sourceFormat) &&
          (r.ownership === 'shared'
            ? !r.sharedForUid || r.sharedForUid === currentUser.uid
            : r.ownerUid === currentUser.uid)
      );
      if (userRecordings.length > 0) {
        const newest = [...userRecordings].sort((a, b) =>
          (b.recordingMeta?.startedAt || b.createdAt).localeCompare(
            a.recordingMeta?.startedAt || a.createdAt
          )
        )[0];
        setActiveRoute(newest);
      }
    }
  }, [isMobile, desktopDrawer, mobileDisplayMode, mobileTab, activeRoute, routes, currentUser]);

  // Clear chart hover marker whenever the elevation / recordings drawer/tab closes
  useEffect(() => {
    const showingRoutes =
      (!isMobile && (desktopDrawer === 'routes' || desktopDrawer === 'recordings')) ||
      (isMobile &&
        mobileDisplayMode === 'planning' &&
        !mobilePlanningOverlay &&
        (mobileTab === 'routes' || mobileTab === 'recordings'));
    if (!showingRoutes && hoverMarkerRef.current) {
      hoverMarkerRef.current.remove();
      hoverMarkerRef.current = null;
    }
  }, [isMobile, desktopDrawer, mobileDisplayMode, mobilePlanningOverlay, mobileTab]);

  const referenceCoord = userLocation ?? { lon: cursorCoords.lon, lat: cursorCoords.lat };
  const isMobilePlanningSheetVisible =
    isMobile &&
    mobileDisplayMode === 'planning' &&
    ((mobilePlanningOverlay === 'poi' && Boolean(selectedPoi)) ||
      (mobilePlanningOverlay === 'google-account' && Boolean(currentUser)) ||
      mobilePlanningOverlay === 'user-icon' ||
      mobilePlanningOverlay === 'layers' ||
      mobilePlanningOverlay === 'add-poi' ||
      mobilePlanningOverlay === 'plan-route' ||
      mobileTab === 'routes' ||
      mobileTab === 'recordings' ||
      mobileTab === 'planning-db' ||
      mobileTab === 'map-edit' ||
      (mobileTab === 'offline' && Boolean(currentUser)));

  const activeMobileSheetKey =
    mobileDisplayMode === 'navigating'
      ? mobileNavOverlay
      : isMobilePlanningSheetVisible
        ? (mobilePlanningOverlay ?? mobileTab)
        : null;

  useEffect(() => {
    setIsMobileSheetMinimized(false);
  }, [activeMobileSheetKey, mobileDisplayMode]);

  useEffect(() => {
    setIsDesktopDrawerMinimized(false);
  }, [desktopDrawer]);

  const handleFlyTo = useCallback(
    (lon: number, lat: number, zoom = 14) => {
      beginCameraTransition(1000);
      mapRef.current?.flyTo({ center: [lon, lat], zoom, essential: true });
    },
    [beginCameraTransition, handleUserMapOperation]
  );

  const fitBoundsToRoutes = useCallback(
    (targetRoutes: SavedRouteRecord[]) => {
      handleUserMapOperation();
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
              zoom: 14.5,
              padding: isMobileRef.current
                ? { top: 115, bottom: 70, left: 40, right: 40 }
                : { top: 90, bottom: 90, left: 90, right: 430 },
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
    [beginCameraTransition, handleUserMapOperation]
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
    const res = applyLocationTransition('press-location');
    const map = mapRef.current;
    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const currentLoc = userLocationRef.current;

    if (res.locationMode === 'once') {
      if (latestFrame || currentLoc) {
        pendingLocateFlyRef.current = false;
        const targetLon = latestFrame?.lon ?? currentLoc!.lon;
        const targetLat = latestFrame?.lat ?? currentLoc!.lat;
        beginCameraTransition(1100);
        map?.flyTo({
          center: [targetLon, targetLat],
          zoom: Math.max(map.getZoom() || 14, 15),
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
        showToast('מאתר מיקום GPS...');
      }
      return;
    }

    if (res.locationMode === 'tracking') {
      if (latestFrame || currentLoc) {
        pendingLocateFlyRef.current = false;
        const targetLon = latestFrame?.lon ?? currentLoc!.lon;
        const targetLat = latestFrame?.lat ?? currentLoc!.lat;
        const targetBearing = resolveCurrentHeading() ?? map?.getBearing() ?? 0;
        lastCameraBearingRef.current = { ts: performance.now(), bearing: targetBearing };
        beginCameraTransition(900);
        map?.flyTo({
          center: [targetLon, targetLat],
          zoom: Math.max(map.getZoom() || 14, 15.5),
          bearing: targetBearing,
          pitch: 60,
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
      }
      showToast('מעקב רציף פעיל • 3D כיוון תנועה');
      return;
    }

    pendingLocateFlyRef.current = false;
    showToast('מעקב המיקום הופסק');
  };

  const handleLocateOnceFromPicker = () => {
    if (locationModeRef.current === 'none') {
      handleLocateMe();
      return;
    }
    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const currentLoc = userLocationRef.current;
    const map = mapRef.current;
    if (latestFrame || currentLoc) {
      const targetLon = latestFrame?.lon ?? currentLoc!.lon;
      const targetLat = latestFrame?.lat ?? currentLoc!.lat;
      beginCameraTransition(900);
      map?.flyTo({
        center: [targetLon, targetLat],
        zoom: Math.max(map.getZoom() || 14, 15),
        essential: true,
      });
    } else {
      pendingLocateFlyRef.current = true;
      setGpsWatchRestartSeq((s) => s + 1);
      showToast('מאתר מיקום GPS...');
    }
  };

  const handleCycleNorthMode = () => {
    // One-way coupling rule: 1-c activates 2-c, never the reverse (2-c leaves locationMode untouched).
    const map = mapRef.current;
    const res = resolveNorthModeTransition(locationModeRef.current, northModeRef.current, {
      currentBearingDeg: map?.getBearing() ?? mapBearing,
      isFollowingUser: isFollowingUserRef.current,
    });
    const nextMode = res.northMode;
    programmaticNorthUntilRef.current = performance.now() + 700;
    syncNorthModeState(nextMode);
    const next3d = is3dNorthMode(nextMode);
    const nextPov = isPovNorthMode(nextMode);

    const latestFrame = navSmootherRef.current?.getLatestFrame();
    const currentLoc = userLocationRef.current;
    const centerCoord: [number, number] | undefined = isFollowingUserRef.current
      ? latestFrame
        ? [latestFrame.lon, latestFrame.lat]
        : currentLoc
          ? [currentLoc.lon, currentLoc.lat]
          : undefined
      : undefined;
    const targetBearing = nextPov ? resolveCurrentHeading() ?? map?.getBearing() ?? 0 : 0;
    const targetPitch = next3d ? 60 : 0;
    lastCameraBearingRef.current = { ts: performance.now(), bearing: targetBearing };
    beginCameraTransition(500);
    map?.easeTo(
      {
        ...(centerCoord ? { center: centerCoord } : {}),
        bearing: targetBearing,
        pitch: targetPitch,
        duration: 500,
        essential: true,
      },
      { programmaticNorthControl: true }
    );
    // Re-arm after easeTo() so any synchronous stop()->moveend from prior drag inertia does not disarm the 500ms lock.
    beginCameraTransition(500);
    if (userMarkerRef.current) {
      UserLocationIconService.updateMarkerDirection(
        userMarkerRef.current.getElement(),
        userIconPrefRef.current,
        resolveCurrentHeading(),
        targetBearing,
        isNavigationActiveRef.current
      );
    }
    showToast(
      nextMode === '2d-north'
        ? 'כיוון מפה: 2D צפון למעלה'
        : nextMode === '2d-pov'
          ? 'כיוון מפה: 2D כיוון תנועה (POV)'
          : 'כיוון מפה: 3D כיוון תנועה (POV)'
    );
  };

  const handleToggleDesktopFreeNavigation = () => {
    setDesktopTopMenu(null);
    setLayerSheetSection(null);
    setIsUserIconPickerOpen(false);
    setIsGoogleMenuOpen(false);
    setMobileSpeedDial(null);
    if (isNavigationActive) {
      handleStopRouteNavigation();
      return;
    }
    void NavigationHeadingService.requestCompassPermissionIfNeeded();
    applyLocationTransition('activate-tracking');
    setIsFreeNavigation(true);
    if (isMobile) {
      setMobileDisplayMode('navigating');
      setMobileNavOverlay(null);
    }
    showToast('מצב ניווט הופעל • מעקב רציף 3D כיוון תנועה');
  };

  const handleUserIconPreferenceChange = (nextPref: UserLocationIconPreference) => {
    setUserIconPref(nextPref);
    const currentLoc = userLocationRef.current;
    const map = mapRef.current;
    if (currentLoc && map && locationModeRef.current !== 'none') {
      try {
        const bounds = map.getBounds();
        if (!bounds || !bounds.contains([currentLoc.lon, currentLoc.lat])) {
          handleFlyTo(currentLoc.lon, currentLoc.lat, Math.max(map.getZoom() || 14, 15));
        }
      } catch {
        // Ignore bounds check if map projection isn't ready yet
      }
    }
    showToast(`אייקון המיקום עודכן ל: ${nextPref.icon.labelHe}`);
  };

  const handleSelectPoi = (item: PoiRecord, zoom = 15.2) => {
    handleUserMapOperation();
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
    handleUserMapOperation();
    setSearchQuery('');
    setExecutedSearchQuery('');
    setSearchResults([]);
    setIsSearchFocused(false);
    setIsNavSearchOpen(false);

    const hasActiveOperation = isMobile
      ? isTrailMarkingMode ||
        mobileDisplayMode === 'navigating' ||
        mobileTab !== 'explore' ||
        (mobilePlanningOverlay !== null && mobilePlanningOverlay !== 'poi')
      : isTrailMarkingMode || (desktopDrawer !== null && desktopDrawer !== 'poi');

    if (item.kind === 'trail-annotation') {
      setShowTrailOverlay(true);
      handleFlyTo(item.lon, item.lat, item.recommendedZoom || 14.5);
      showToast(item.title);
      if (isTrailMarkingMode && item.trailAnnotationId) {
        setSelectedTrailAnnotationId(item.trailAnnotationId);
      }
      return;
    }

    if (item.kind === 'route' && item.routeRecord) {
      if (hasActiveOperation) {
        handleFlyTo(item.lon, item.lat, item.recommendedZoom || 13.5);
        showToast(item.title);
        return;
      }
      setSelectedPoi(null);
      void handleSelectRoute(item.routeRecord);
      const openRecordings =
        isRecordedRouteFormat(item.routeRecord.sourceFormat) && Boolean(currentUserRef.current);
      if (isMobile) {
        setMobileDisplayMode('planning');
        setMobileTab(openRecordings ? 'recordings' : 'routes');
        setMobilePlanningOverlay(null);
        setMobileSheetExpanded(true);
      } else {
        setDesktopDrawer(openRecordings ? 'recordings' : 'routes');
      }
      return;
    }

    const existingMatch = poisRef.current.find((p) => p.id === item.id);
    const poiRec = existingMatch || item.toPoiRecord();

    // Picked from the navigation search box: stay in navigating mode and show the compact point card.
    // GPS follow is paused (same as dragging the map), otherwise the camera snaps straight back to the user.
    if (isMobile && mobileDisplayMode === 'navigating') {
      pendingLocateFlyRef.current = false;
      locationModeRef.current = 'none';
      setLocationMode('none');
      isFollowingUserRef.current = false;
      setIsFollowingUser(false);
      setSelectedPoi(poiRec);
      handleFlyTo(poiRec.lon, poiRec.lat, item.recommendedZoom || 15.2);
      setMobileNavOverlay('poi-mini');
      return;
    }

    if (hasActiveOperation) {
      handleFlyTo(poiRec.lon, poiRec.lat, item.recommendedZoom || 15.2);
      showToast(item.title);
      return;
    }

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

  const handlePoiUpdated = useCallback(
    (updated: PoiRecord) => {
      setSelectedPoi(updated);
      setPois((prev) =>
        prev.some((p) => p.id === updated.id)
          ? prev.map((p) => (p.id === updated.id ? updated : p))
          : [...prev, updated]
      );
    },
    []
  );

  const handleDeletePoi = useCallback(
    async (poi: PoiRecord) => {
      if (!canUserDeletePoi(currentUser, poi) || !currentUser) {
        showToast('מחיקת נקודה זו מותרת רק לבעלים (בנקודה פרטית) או למשתמש מורשה.');
        return;
      }
      const actor = currentUser;
      const snapshot = await PoiManager.deletePoi(poi, actor.uid);
      setPois((prev) => prev.filter((p) => p.id !== poi.id));
      setSelectedPoi((prev) => (prev?.id === poi.id ? null : prev));
      setShareModalPoiId((prev) => (prev === poi.id ? null : prev));
      setDesktopDrawer((prev) => (prev === 'poi' ? null : prev));
      setMobilePlanningOverlay((prev) => (prev === 'poi' ? null : prev));
      setMobileNavOverlay((prev) => (prev === 'poi-mini' ? null : prev));

      try {
        const res = isPrivatePoi(poi)
          ? await PrivatePoiCloudService.deletePrivatePoi(poi, actor)
          : await GlobalPoiCloudService.deleteGlobalPoi(poi, actor);
        setUndoDeletedPoi(snapshot);
        setToastMessage(
          res.queuedOffline
            ? `הנקודה "${poi.nameHe || poi.name}" נמחקה מקומית ותסונכרן בענן כשיתאפשר`
            : `הנקודה "${poi.nameHe || poi.name}" נמחקה`
        );
      } catch (err) {
        const restored = await PoiManager.restoreDeletedPoi(snapshot, actor.uid);
        setPois((prev) => (prev.some((p) => p.id === restored.id) ? prev : [...prev, restored]));
        setSelectedPoi(restored);
        setUndoDeletedPoi(null);
        showToast(err instanceof Error ? err.message : 'מחיקת הנקודה נדחתה בשרת');
        return;
      }

      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => {
        setToastMessage(null);
        setUndoDeletedPoi(null);
      }, 6000);
    },
    [currentUser, showToast]
  );

  const handleUndoDeletePoi = useCallback(async () => {
    if (!undoDeletedPoi) return;
    if (!canUserDeletePoi(currentUser, undoDeletedPoi.poi) || !currentUser) {
      showToast('שחזור נקודות מחוקות מותר לבעלים או למשתמשים מורשים בלבד.');
      return;
    }
    const actor = currentUser;
    const snapshot = undoDeletedPoi;
    const restored = await PoiManager.restoreDeletedPoi(snapshot, actor.uid);
    setUndoDeletedPoi(null);
    setPois((prev) => (prev.some((p) => p.id === restored.id) ? prev : [...prev, restored]));
    setSelectedPoi(restored);
    try {
      const res = isPrivatePoi(snapshot.poi)
        ? await PrivatePoiCloudService.restoreDeletedPrivatePoi(snapshot, actor)
        : await GlobalPoiCloudService.restoreDeletedGlobalPoi(snapshot, actor);
      showToast(
        res.queuedOffline
          ? `הנקודה "${restored.nameHe || restored.name}" שוחזרה מקומית ותסונכרן כשיתאפשר`
          : `הנקודה "${restored.nameHe || restored.name}" שוחזרה`
      );
    } catch (err) {
      await PoiManager.deletePoi(restored, actor.uid).catch(() => undefined);
      setPois((prev) => prev.filter((p) => p.id !== restored.id));
      setSelectedPoi((prev) => (prev?.id === restored.id ? null : prev));
      showToast(err instanceof Error ? err.message : 'שחזור הנקודה נדחה בשרת');
    }
  }, [currentUser, undoDeletedPoi, showToast]);

  const shareModalPoi = useMemo(() => {
    if (!shareModalPoiId) return null;
    return (
      pois.find((p) => p.id === shareModalPoiId) ||
      (selectedPoi?.id === shareModalPoiId ? selectedPoi : null)
    );
  }, [shareModalPoiId, pois, selectedPoi]);

  const handleOpenSharePoiModal = useCallback(
    (poi: PoiRecord) => {
      if (!isOwnedPrivatePoi(poi, currentUser)) {
        showToast('ניתן לשתף רק נקודה פרטית שבבעלותך');
        return;
      }
      setShareModalPoiId(poi.id);
    },
    [currentUser, showToast]
  );

  const handleUpdatePoiSharing = useCallback(
    async (poi: PoiRecord, nextRecipients: PoiShareRecipient[]) => {
      if (!currentUser) {
        return {
          synced: false,
          poi,
          error: 'יש להתחבר לחשבון Google כדי לשתף נקודה',
        };
      }
      const res = await PrivatePoiCloudService.updatePrivatePoiSharing(
        poi,
        nextRecipients,
        currentUser
      );
      handlePoiUpdated(res.poi);
      return res;
    },
    [currentUser, handlePoiUpdated]
  );

  const handlePromotePoiToGlobal = useCallback(
    async (poi: PoiRecord) => {
      if (!currentUser) {
        showToast('יש להתחבר לחשבון Google כדי להפוך נקודה לגלובלית');
        return;
      }
      try {
        const res = await PrivatePoiCloudService.promotePrivatePoiToGlobal(poi, currentUser);
        handlePoiUpdated(res.poi);
        setShareModalPoiId((prev) => (prev === poi.id ? null : prev));
        showToast(
          res.queuedOffline
            ? `הנקודה "${res.poi.nameHe}" הועברה מקומית למפה הגלובלית ותסונכרן בענן כשיתאפשר`
            : `הנקודה "${res.poi.nameHe}" הפכה לגלובלית וגלויה לכולם!`
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'הפיכת הנקודה לגלובלית נכשלה');
      }
    },
    [currentUser, handlePoiUpdated, showToast]
  );

  const handleDismissSharedPoi = useCallback(
    async (poi: PoiRecord) => {
      if (!currentUser) return;
      try {
        await PrivatePoiCloudService.dismissSharedPoi(poi, currentUser);
        setPois((prev) => prev.filter((p) => p.id !== poi.id));
        setSelectedPoi((prev) => (prev?.id === poi.id ? null : prev));
        setDesktopDrawer((prev) => (prev === 'poi' ? null : prev));
        setMobilePlanningOverlay((prev) => (prev === 'poi' ? null : prev));
        setMobileNavOverlay((prev) => (prev === 'poi-mini' ? null : prev));
        showToast(`הנקודה "${poi.nameHe || poi.name}" הוסרה מהמפה שלך`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'הסרת הנקודה המשותפת נכשלה');
      }
    },
    [currentUser, showToast]
  );

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
    applyLocationTransition('activate-tracking');
    setRemainingDistKm(fullRoute.distanceKm);
    if (wasAlreadyNavigating) {
      const latestFrame = navSmootherRef.current?.getLatestFrame();
      const resolvedHeading = resolveCurrentHeading();
      const targetBearing = resolvedHeading ?? 0;
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
          pitch: 60,
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
    applyLocationTransition('deactivate-to-none');
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
    if (
      target &&
      currentUser &&
      (target.sourceFormat === 'planned' || isRecordedRouteFormat(target.sourceFormat))
    ) {
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
        (updated.sourceFormat === 'planned' || isRecordedRouteFormat(updated.sourceFormat)) &&
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
          exists
            ? 'המסלול הוסר מנעיצה במפה'
            : 'המסלול נעוץ במפה — יישאר מוצג גם לאחר סגירת החלונית'
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
        (cloned.sourceFormat === 'planned' || isRecordedRouteFormat(cloned.sourceFormat)) &&
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
    const wasPlanningTrail = Boolean(editingPlanningTrailIdRef.current);
    editingPlanningTrailIdRef.current = null;
    editingRouteIdRef.current = null;
    setEditingRouteId(null);
    setPlanRouteName('');
    handleClearPlan();
    if (isMobileRef.current) {
      setMobilePlanningOverlay(null);
      setMobileDisplayMode('planning');
      setMobileTab(wasPlanningTrail ? 'planning-db' : 'routes');
      setMobileSheetExpanded(true);
    } else {
      setDesktopDrawer(wasPlanningTrail ? 'planning-db' : 'routes');
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

  const handleCloseDesktopDrawer = useCallback(() => {
    if (desktopDrawer === 'poi') {
      setSelectedPoi(null);
      setDesktopDrawer(null);
      return;
    }
    if (desktopDrawer === 'plan-route') {
      handleClosePlannerPanel();
      return;
    }
    setDesktopDrawer(null);
  }, [desktopDrawer, handleClosePlannerPanel]);

  const handleCloseMobilePlanningSheet = useCallback(() => {
    if (mobilePlanningOverlay === 'poi') {
      setSelectedPoi(null);
      setMobilePlanningOverlay(null);
      return;
    }
    if (mobilePlanningOverlay === 'plan-route') {
      handleClosePlannerPanel();
      return;
    }
    if (mobilePlanningOverlay) {
      setMobilePlanningOverlay(null);
      return;
    }
    setMobileTab('explore');
  }, [mobilePlanningOverlay, handleClosePlannerPanel]);

  const handleToggleMobilePlanningHandle = useCallback(() => {
    if (isMobileSheetMinimized) {
      setIsMobileSheetMinimized(false);
      return;
    }
    if (mobilePlanningOverlay === 'poi' || mobilePlanningOverlay === 'plan-route') {
      setMobileSheetExpanded((v) => !v);
      return;
    }
    setIsMobileSheetMinimized(true);
  }, [isMobileSheetMinimized, mobilePlanningOverlay]);

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
    const targetPlanningTrailId = editingPlanningTrailIdRef.current;

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

      if (targetPlanningTrailId) {
        const updatedTrail = await PlanningTrailManager.updatePlannedTrailGeometry(
          targetPlanningTrailId,
          {
            name: finalName,
            mode,
            segments,
            waypoints: wps,
          }
        );
        if (updatedTrail) {
          setPlanningTrails((prev) =>
            prev.map((t) => (t.id === updatedTrail.id ? updatedTrail : t))
          );
          setSelectedPlanningTrailId(updatedTrail.id);
        }
        editingPlanningTrailIdRef.current = null;
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
          setMobileTab('planning-db');
          setMobileSheetExpanded(true);
        } else {
          setDesktopDrawer('planning-db');
        }
        showToast(`"${finalName}" עודכן במאגר התכנון`);
        return;
      }

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
        if (isLiveSharingActiveRef.current && isOnline) {
          await LiveLocationCloudService.stopSharing(
            currentUser,
            userLocationRef.current,
            userIconPrefRef.current
          ).catch(() => undefined);
        } else {
          savePersistedShareConfig(currentUser.uid, null);
        }
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

  const handleSaveLiveShareConfig = useCallback(
    async (nextConfig: LiveLocationShareConfig) => {
      if (!currentUser) return;
      setLiveShareConfig(nextConfig);
      savePersistedShareConfig(currentUser.uid, nextConfig);
      if (nextConfig.visibility === 'off') {
        await LiveLocationCloudService.stopSharing(
          currentUser,
          userLocationRef.current,
          userIconPrefRef.current
        );
        showToast('שיתוף המיקום הופסק');
        return;
      }
      if (userLocationRef.current) {
        await LiveLocationCloudService.publishNow(
          currentUser,
          nextConfig,
          userLocationRef.current,
          userIconPrefRef.current
        );
      }
      showToast(
        nextConfig.visibility === 'public'
          ? 'המיקום החי שלך משותף כעת עם כל משתמשי NavApp'
          : `המיקום החי שלך משותף עם ${nextConfig.sharedWith.length} משתמשים`
      );
    },
    [currentUser, showToast]
  );

  const handleStopLiveShare = useCallback(async () => {
    const offConfig: LiveLocationShareConfig = {
      ...liveShareConfig,
      visibility: 'off',
      expiresAt: null,
      expiresAtMs: null,
    };
    setLiveShareConfig(offConfig);
    if (currentUser) {
      await LiveLocationCloudService.stopSharing(
        currentUser,
        userLocationRef.current,
        userIconPrefRef.current
      );
    }
    showToast('שיתוף המיקום הופסק');
  }, [currentUser, liveShareConfig, showToast]);

  const handleNavigateToPeer = useCallback(
    (peer: LiveLocationRecord) => {
      void NavigationHeadingService.requestCompassPermissionIfNeeded();
      handleFlyTo(peer.lon, peer.lat, 15.2);
      showToast(`מכוון אל ${peer.displayName}`);
      if (isMobile) {
        setMobileDisplayMode('navigating');
      } else {
        setIsFreeNavigation(true);
      }
    },
    [handleFlyTo, isMobile, showToast]
  );

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

  const handleStartOrResumeRecording = useCallback(() => {
    if (!isNavigationActiveRef.current) {
      showToast('הקלטה פעילה רק בזמן ניווט');
      return;
    }
    if (!currentUserRef.current) {
      showToast('יש להתחבר עם Google כדי להקליט ולשמור מסלולי ניווט');
      void handleSignInGoogle();
      return;
    }
    if (!isRecordingTrackRef.current) {
      const latestFrame = navSmootherRef.current?.getLatestFrame();
      const curLoc = userLocationRef.current;
      const startPt: [number, number] = latestFrame
        ? [Number(latestFrame.kalmanLon.toFixed(6)), Number(latestFrame.kalmanLat.toFixed(6))]
        : curLoc
          ? [curLoc.lon, curLoc.lat]
          : [Number(cursorCoords.lon.toFixed(5)), Number(cursorCoords.lat.toFixed(5))];
      const startEle = curLoc?.altitude !== null && curLoc?.altitude !== undefined
        ? Math.round(curLoc.altitude)
        : cursorCoords.ele;
      const startIso = new Date().toISOString();
      recordedStartedAtRef.current = startIso;
      recordedCoordsRef.current = [startPt];
      recordedElevationsRef.current = [startEle];
      recordedTimestampsRef.current = [Date.now()];
      setRecordedCoords([startPt]);
      setRecordedDistanceKm(0);
      setRecordedAscentMeters(0);
      setRecordElapsedSeconds(0);
      lastRecordedEleRef.current = startEle;
      setIsRecordingTrack(true);
      setIsRecordingPaused(false);
      showToast('הקלטת מסלול GPS החלה');
    } else {
      setIsRecordingPaused(false);
      showToast('הקלטת מסלול נמשכת');
    }
  }, [cursorCoords.ele, cursorCoords.lat, cursorCoords.lon, handleSignInGoogle, showToast]);

  const handleDiscardRecordedTrack = useCallback(
    (options?: { silent?: boolean }) => {
      lastRecordedEleRef.current = null;
      recordedStartedAtRef.current = null;
      recordedCoordsRef.current = [];
      recordedElevationsRef.current = [];
      recordedTimestampsRef.current = [];
      setIsRecordingTrack(false);
      setIsRecordingPaused(false);
      setRecordedCoords([]);
      setRecordedDistanceKm(0);
      setRecordedAscentMeters(0);
      setRecordElapsedSeconds(0);
      if (!options?.silent) {
        showToast('ההקלטה בוטלה');
      }
    },
    [showToast]
  );

  const openRecordingSavePrompt = useCallback(
    (trigger: 'stop-recording' | 'stop-navigation') => {
      const user = currentUserRef.current;
      const coordsSnapshot = recordedCoordsRef.current;
      if (!user) {
        handleDiscardRecordedTrack({ silent: true });
        showToast('הקלטת מסלולי ניווט זמינה למשתמשים מחוברים בלבד');
        return;
      }
      if (coordsSnapshot.length < 2) {
        if (trigger === 'stop-navigation') {
          handleDiscardRecordedTrack({ silent: true });
        } else {
          showToast('נדרשות לפחות 2 נקודות תנועה לשמירת הקלטה');
        }
        return;
      }

      const startedIso = recordedStartedAtRef.current || new Date().toISOString();
      const endedIso = new Date().toISOString();
      const startedDate = new Date(startedIso);
      const dateStr = Number.isNaN(startedDate.getTime())
        ? ''
        : startedDate.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
      const timeStr = Number.isNaN(startedDate.getTime())
        ? ''
        : startedDate.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      const curActiveName = activeRouteRef.current?.name;
      const defaultName = curActiveName
        ? `${curActiveName} • הקלטה ${dateStr}`.trim()
        : `הקלטת ניווט ${dateStr} ${timeStr}`.trim();

      const snapshot = {
        trigger,
        defaultName,
        coordinates: [...coordsSnapshot],
        pointElevations: [...recordedElevationsRef.current],
        pointTimestamps: [...recordedTimestampsRef.current],
        distanceKm: recordedDistanceKmRef.current,
        ascentMeters: recordedAscentMetersRef.current,
        durationSeconds: recordElapsedSecondsRef.current,
        startedAt: startedIso,
        endedAt: endedIso,
      };

      if (trigger === 'stop-navigation') {
        handleDiscardRecordedTrack({ silent: true });
      } else {
        setIsRecordingPaused(true);
      }
      setPendingRecordingSave(snapshot);
    },
    [handleDiscardRecordedTrack, showToast]
  );

  const handleConfirmSaveRecording = useCallback(
    async ({ name, notes, exportGpx }: { name: string; notes: string; exportGpx: boolean }) => {
      const draft = pendingRecordingSave;
      const user = currentUserRef.current;
      if (!draft || !user) {
        setPendingRecordingSave(null);
        return;
      }
      setIsSavingRecording(true);
      try {
        const saved = await RouteManager.createAndSaveRecordedRoute({
          name,
          coordinates: draft.coordinates,
          pointElevations: draft.pointElevations,
          pointTimestamps: draft.pointTimestamps,
          startedAt: draft.startedAt,
          endedAt: draft.endedAt,
          durationSeconds: draft.durationSeconds,
          notes,
          color: '#0ea5e9',
          ownerUid: user.uid,
          ownerEmail: user.email ?? null,
          ownerDisplayName: user.displayName ?? null,
        });
        setRoutes((prev) => [RouteManager.splitRouteRecord(saved).summary, ...prev]);
        setActiveRoute(saved);
        setPendingRecordingSave(null);
        handleDiscardRecordedTrack({ silent: true });

        if (isMobileRef.current) {
          setMobileDisplayMode('planning');
          setMobilePlanningOverlay(null);
          setMobileTab('recordings');
          setMobileSheetExpanded(true);
        } else {
          setDesktopDrawer('recordings');
        }
        fitBoundsToRoutes([saved]);

        if (exportGpx) {
          try {
            const exportRes = await GpxExportService.exportAndSaveRouteGpx(saved);
            showToast(`ההקלטה "${saved.name}" נשמרה ויוצאה: ${exportRes.locationLabelHe}`);
          } catch (err: any) {
            showToast(err?.message || `ההקלטה "${saved.name}" נשמרה בהקלטות ניווט`);
          }
        } else {
          showToast(`ההקלטה "${saved.name}" נשמרה בהקלטות ניווט!`);
        }

        if (isOnline && AuthService.isAvailable()) {
          void PlannedTracksCloudService.savePlannedRouteToFirebase(saved, user).then(
            (cloudRes) => {
              if (deletedRouteIdsRef.current.has(saved.id)) return;
              const syncedRec = cloudRes.route;
              const syncedSummary = RouteManager.splitRouteRecord(syncedRec).summary;
              setRoutes((prev) => prev.map((r) => (r.id === syncedRec.id ? syncedSummary : r)));
              setActiveRoute((cur) =>
                cur?.id === syncedRec.id
                  ? {
                      ...cur,
                      ...syncedRec,
                      geojson: cur.geojson,
                      elevationProfile: cur.elevationProfile,
                      waypoints: cur.waypoints,
                      gpxXml: cur.gpxXml,
                      recordingPointTimestamps: cur.recordingPointTimestamps,
                    }
                  : cur
              );
            }
          );
        }
      } catch (err: any) {
        showToast(err?.message || 'שגיאה בשמירת ההקלטה');
      } finally {
        setIsSavingRecording(false);
      }
    },
    [fitBoundsToRoutes, handleDiscardRecordedTrack, isOnline, pendingRecordingSave, showToast]
  );

  // Enforce: track recording is active ONLY while navigation is active; prompt user on nav stop.
  useEffect(() => {
    if (isNavigationActive) return;
    setDesktopDrawer((prev) => (prev === 'record' ? null : prev));
    setMobileNavOverlay((prev) => (prev === 'record' ? null : prev));
    if (isRecordingTrackRef.current) {
      openRecordingSavePrompt('stop-navigation');
    }
  }, [isNavigationActive, openRecordingSavePrompt]);

  const openNavigationRecordings = useCallback(() => {
    setDesktopTopMenu(null);
    if (isMobileRef.current) {
      setMobileDisplayMode('planning');
      setMobilePlanningOverlay(null);
      setMobileNavOverlay(null);
      setMobileTab('recordings');
      setMobileSheetExpanded(true);
    } else {
      setDesktopDrawer((prev) => (prev === 'recordings' ? null : 'recordings'));
    }
  }, []);

  const handleUpdateRecordingNotes = useCallback(
    async (routeId: string, notes: string) => {
      const target = routesRef.current.find((r) => r.id === routeId) || activeRouteRef.current;
      if (target?.ownership === 'shared') {
        showToast('הקלטה משותפת היא לקריאה בלבד — לחץ "שמור עותק אצלי" כדי לערוך');
        return;
      }
      const updated = await RouteManager.updateRouteDetails(routeId, { notes });
      syncMutatedRouteState(updated, 'הערות התחקור עודכנו');
    },
    [showToast, syncMutatedRouteState]
  );

  const openMapEditRoadMode = useCallback(
    (subMode: 'edit-road' | 'add-road') => {
      setDesktopTopMenu(null);
      if (!currentUserRef.current) {
        showToast('יש להתחבר עם Google כדי לערוך דרכים וסימון שבילים');
        void handleSignInGoogle();
        return;
      }
      setIsPickingPoiLocation(false);
      setDesktopDrawer(null);
      setMobilePlanningOverlay(null);
      setMobileNavOverlay(null);
      if (isMobileRef.current) {
        setMobileTab('explore');
      }
      setMobileSheetExpanded(false);
      setIsTrailMarkingMode(true);
      switchTrailSubMode(subMode);
    },
    [handleSignInGoogle, showToast, switchTrailSubMode]
  );

  const handleUseRecordingForMapEdit = useCallback(
    (route: SavedRouteRecord, subMode: 'add-road' | 'edit-road' = 'add-road') => {
      setPinnedBackgroundRouteIds((prev) => (prev.includes(route.id) ? prev : [...prev, route.id]));
      if (!RouteManager.getCachedFullRoute(route.id)) {
        void RouteManager.loadFullRoute(route.id).then((loaded) => {
          if (loaded) setBgHydrationSeq((s) => s + 1);
        });
      }
      fitBoundsToRoutes([route]);
      openMapEditRoadMode(subMode);
      showToast(`ההקלטה "${route.name}" נעוצה על המפה — ניתן לעדכן דרכים ונקודות עניין מעליה`);
    },
    [fitBoundsToRoutes, openMapEditRoadMode, showToast]
  );

  const handleImportRecordingFile = useCallback(
    async (file: File) => {
      const user = currentUserRef.current;
      if (!user) {
        showToast('יש להתחבר עם Google כדי לטעון קבצי הקלטות');
        void handleSignInGoogle();
        return;
      }
      try {
        const { extractedLineCoordinates, extractedRoutes } =
          await CommunityPoiImporter.importWaypointsAndRoutesFromFile(file);
        const tracksToCreate =
          extractedRoutes.length > 0
            ? extractedRoutes
            : extractedLineCoordinates.map((coords) => ({ segments: [coords] }));
        if (tracksToCreate.length === 0) {
          showToast(`לא נמצא מסלול תקין בקובץ ${file.name}`);
          return;
        }
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const createdList: SavedRouteRecord[] = [];
        for (let i = 0; i < tracksToCreate.length; i++) {
          const track = tracksToCreate[i] as {
            name?: string;
            segments: Array<Array<[number, number]>>;
            pointElevations?: Array<Array<number | null>>;
            pointTimestamps?: Array<Array<number | null>>;
          };
          const flatCoords = track.segments.flat();
          if (flatCoords.length < 2) continue;
          const flatEles = track.pointElevations ? track.pointElevations.flat() : undefined;
          const derived = deriveRecordingMetaFromTimestamps(track.pointTimestamps);
          const nowIso = new Date().toISOString();
          const saved = await RouteManager.createAndSaveRecordedRoute({
            name:
              track.name?.trim() ||
              (tracksToCreate.length > 1 ? `${baseName} #${i + 1}` : baseName),
            coordinates: flatCoords,
            pointElevations: flatEles,
            pointTimestamps: derived?.pointTimestamps,
            startedAt: derived?.startedAt || nowIso,
            endedAt: derived?.endedAt || nowIso,
            durationSeconds: derived?.durationSeconds ?? 0,
            ownerUid: user.uid,
            ownerEmail: user.email ?? null,
            ownerDisplayName: user.displayName ?? null,
          });
          createdList.push(saved);
          if (isOnline && AuthService.isAvailable()) {
            void PlannedTracksCloudService.savePlannedRouteToFirebase(saved, user);
          }
        }
        if (createdList.length === 0) {
          showToast(`לא נמצאו מקטעי נסיעה/הליכה תקינים בקובץ ${file.name}`);
          return;
        }
        const summaries = createdList.map((c) => RouteManager.splitRouteRecord(c).summary);
        setRoutes((prev) => [...summaries, ...prev]);
        setActiveRoute(createdList[0]);
        fitBoundsToRoutes(createdList);
        showToast(
          createdList.length === 1
            ? `ההקלטה "${createdList[0].name}" נטענה להקלטות ניווט`
            : `נטענו ${createdList.length} הקלטות מתוך ${file.name}`
        );
      } catch (err: any) {
        showToast(err?.message || `שגיאה בטעינת ${file.name}`);
      }
    },
    [fitBoundsToRoutes, handleSignInGoogle, isOnline, showToast]
  );

  const openTrailsPlanningDb = useCallback(() => {
    setDesktopTopMenu(null);
    if (!currentUserRef.current) {
      showToast('יש להתחבר עם Google לגישה למאגר תכנון המסלולים');
      void handleSignInGoogle();
      return;
    }
    if (isMobileRef.current) {
      setMobileDisplayMode('planning');
      setMobilePlanningOverlay(null);
      setMobileTab('planning-db');
      setMobileSheetExpanded(true);
    } else {
      setDesktopDrawer((prev) => (prev === 'planning-db' ? null : 'planning-db'));
    }
  }, [handleSignInGoogle, showToast]);

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

  const handleOpenMapStorage = useCallback(() => {
    setDesktopTopMenu(null);
    setLayerSheetSection(null);
    setIsUserIconPickerOpen(false);
    setIsGoogleMenuOpen(false);
    setMobileSpeedDial(null);
    if (!currentUserRef.current) {
      showToast('ניהול מפות אופליין וייבוא זמין למשתמשים מחוברים בלבד');
      void handleSignInGoogle();
      return;
    }
    if (isMobileRef.current) {
      setMobileDisplayMode('planning');
      setMobilePlanningOverlay(null);
      setMobileTab('offline');
    } else {
      setIsStorageOpen(true);
    }
  }, [handleSignInGoogle, showToast]);

  const handleToggleDesktopRoutes = useCallback(() => {
    setDesktopDrawer((prev) => (prev === 'routes' ? null : 'routes'));
  }, []);

  useEffect(() => {
    PlanningTrailManager.clearCache();
    const uid = currentUser?.uid;
    if (!uid) {
      setPlanningFolders([]);
      setPlanningTrails([]);
      setSelectedPlanningTrailId(null);
      setSendToPlanningRouteTarget(null);
      setShowPlanningFolderOnMap(false);
      setIsStorageOpen(false);
      setDesktopDrawer((prev) => (prev === 'planning-db' ? null : prev));
      setMobileTab((prev) => (prev === 'planning-db' || prev === 'offline' ? 'explore' : prev));
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        await ensureZofimRoutesSeeded(uid);
        const [loadedFolders, loadedTrails] = await Promise.all([
          PlanningTrailManager.listFolders(uid),
          PlanningTrailManager.listTrailSummaries(uid),
        ]);
        if (!cancelled) {
          setPlanningFolders(loadedFolders);
          setPlanningTrails(loadedTrails);
        }
      } catch {
        // Ignore DB read errors in non-IndexedDB test environments
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.uid]);

  const handleCreatePlanningFolder = useCallback(
    async (params: { name: string; parentId: string | null }) => {
      if (!currentUser?.uid) return undefined;
      const created = await PlanningTrailManager.createFolder({
        ...params,
        ownerUid: currentUser.uid,
      });
      setPlanningFolders((prev) => [...prev, created]);
      return created;
    },
    [currentUser?.uid]
  );

  const handleRenamePlanningFolder = useCallback(async (folderId: string, newName: string) => {
    const updated = await PlanningTrailManager.renameFolder(folderId, newName);
    if (!updated) return;
    setPlanningFolders((prev) => prev.map((f) => (f.id === folderId ? updated : f)));
  }, []);

  const handleDeletePlanningFolder = useCallback(
    async (folderId: string) => {
      if (!currentUser?.uid) return;
      await PlanningTrailManager.deleteFolder(folderId, 'move-to-unfiled');
      const [nextFolders, nextTrails] = await Promise.all([
        PlanningTrailManager.listFolders(currentUser.uid),
        PlanningTrailManager.listTrailSummaries(currentUser.uid),
      ]);
      setPlanningFolders(nextFolders);
      setPlanningTrails(nextTrails);
      showToast('התיקייה נמחקה והמסלולים הועברו ל"לא ממוין"');
    },
    [currentUser?.uid]
  );

  const handleUpdatePlanningTrailMetadata = useCallback(
    async (
      trailId: string,
      patch: Partial<
        Pick<
          PlanningTrailRecord,
          'name' | 'folderId' | 'categoryId' | 'difficulty' | 'isStarred' | 'tags' | 'notes'
        >
      >
    ) => {
      const updated = await PlanningTrailManager.updateTrailMetadata(trailId, patch);
      if (!updated) return;
      setPlanningTrails((prev) => prev.map((t) => (t.id === trailId ? updated : t)));
    },
    []
  );

  const handleSelectPlanningTrail = useCallback(async (trailId: string) => {
    setSelectedPlanningTrailId(trailId);
    let full = await PlanningTrailManager.loadFullTrail(trailId);
    if (!full) return;
    if (!full.geojson?.features?.length && trailId.startsWith('pt-zofim-')) {
      const fallback = resolveZofimTrailFallback(trailId);
      if (fallback) {
        full = {
          ...full,
          geojson: fallback.geojson,
          bounds: fallback.bounds,
          hasFullPayload: fallback.hasFullPayload,
        };
      }
    }
    if (!full.geojson?.features?.length && full.bounds && full.bounds.length === 4) {
      const [minLon, minLat, maxLon, maxLat] = full.bounds;
      full = {
        ...full,
        geojson: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: full.name },
              geometry: {
                type: 'Point',
                coordinates: [(minLon + maxLon) / 2, (minLat + maxLat) / 2],
              },
            },
          ],
        },
      };
    }
    if (full.geojson?.features?.length) {
      const previewRoute: SavedRouteRecord = {
        id: full.id,
        name: full.name,
        sourceFormat: full.sourceFormat,
        planningMode: full.planningMode,
        waypoints: full.waypoints,
        distanceKm: full.distanceKm,
        ascentMeters: full.ascentMeters,
        descentMeters: full.descentMeters,
        minEle: full.minEle,
        maxEle: full.maxEle,
        color: full.color,
        visible: true,
        bounds: full.bounds,
        hasFullPayload: true,
        geojson: full.geojson,
        elevationProfile: full.elevationProfile,
        gpxXml: full.gpxXml,
        createdAt: full.createdAt,
        updatedAt: full.updatedAt,
      };
      setActiveRoute(previewRoute);
      fitBoundsToRoutes([previewRoute]);
    } else {
      showToast('למסלול זה אין נתוני מיקום או ציר במפה.');
    }
  }, [fitBoundsToRoutes, showToast]);

  const handleStartResizePlanningDb = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const maxAllowed = Math.max(360, Math.floor(window.innerWidth * 0.55));
      const startWidth = Math.min(planningDbWidthPx, maxAllowed);

      const onMove = (moveEvent: PointerEvent) => {
        const deltaX = startX - moveEvent.clientX;
        const maxW = Math.max(360, Math.floor(window.innerWidth * 0.55));
        const nextW = Math.min(maxW, Math.max(360, startWidth + deltaX));
        setPlanningDbWidthPx(nextW);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [planningDbWidthPx]
  );

  const handleEditPlanningTrailOnMap = useCallback(async (trailId: string) => {
    const full = await PlanningTrailManager.loadFullTrail(trailId);
    if (!full) return;

    const mode: PlanningMode =
      full.planningMode ||
      (full.categoryId === 'bicycle' ? 'bicycle' : full.categoryId === 'hiking' ? 'foot' : '4x4');

    let wps: PlannedWaypoint[] = (full.waypoints || []).map((wp) => ({
      ...wp,
      legType: wp.legType || 'network',
    }));
    const legs: PlannedLeg[] = [];
    const lineFeatures = (full.geojson?.features || []).filter(
      (f): f is GeoJSON.Feature<GeoJSON.LineString> =>
        f.geometry?.type === 'LineString' && f.geometry.coordinates.length >= 2
    );

    if (wps.length >= 2) {
      for (let i = 0; i < wps.length - 1; i++) {
        const segCoords = lineFeatures[i]?.geometry.coordinates as [number, number][] | undefined;
        const coords: [number, number][] =
          segCoords && segCoords.length >= 2
            ? segCoords
            : [
                [wps[i].lon, wps[i].lat],
                [wps[i + 1].lon, wps[i + 1].lat],
              ];
        legs.push({
          coordinates: coords,
          distanceKm: turf.length(turf.lineString(coords), { units: 'kilometers' }),
          legType: wps[i + 1].legType || 'network',
          roadLabels: wps[i + 1].roadLabel ? [wps[i + 1].roadLabel!] : [],
        });
      }
    } else if (lineFeatures.length > 0) {
      const flat = lineFeatures.flatMap((f) => f.geometry.coordinates as [number, number][]);
      if (flat.length >= 2) {
        wps = [
          { lon: flat[0][0], lat: flat[0][1], legType: 'network' },
          { lon: flat[flat.length - 1][0], lat: flat[flat.length - 1][1], legType: 'network' },
        ];
        legs.push({
          coordinates: flat,
          distanceKm: turf.length(turf.lineString(flat), { units: 'kilometers' }),
          legType: 'network',
          roadLabels: [],
        });
      }
    }

    editingPlanningTrailIdRef.current = full.id;
    editingRouteIdRef.current = null;
    setEditingRouteId(null);
    planningModeRef.current = mode;
    setPlanningMode(mode);
    setPlanRouteName(full.name);
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

    if (full.bounds) {
      const [minLon, minLat, maxLon, maxLat] = full.bounds;
      handleFlyTo((minLon + maxLon) / 2, (minLat + maxLat) / 2, 13);
    }
    if (legs.length > 0 && wps.length >= 2) {
      void recomputePlanElevationStats(legs, wps);
    }
  }, [recomputePlanElevationStats]);

  const handleDeletePlanningTrail = useCallback(
    async (trailId: string) => {
      await PlanningTrailManager.deleteTrail(trailId);
      setPlanningTrails((prev) => prev.filter((t) => t.id !== trailId));
      if (selectedPlanningTrailId === trailId) setSelectedPlanningTrailId(null);
      showToast('המסלול נמחק ממאגר התכנון');
    },
    [selectedPlanningTrailId]
  );

  const handleSendPlanningTrailToActiveRoutes = useCallback(
    async (trailId: string) => {
      if (!currentUser?.uid) return;
      const createdRoute = await PlanningTrailManager.sendPlanningTrailToActiveRoutes(
        trailId,
        currentUser.uid
      );
      if (!createdRoute) return;
      setRoutes((prev) => [RouteManager.splitRouteRecord(createdRoute).summary, ...prev]);
      setActiveRoute(createdRoute);
      if (isMobile) {
        setMobileDisplayMode('planning');
        setMobileTab('routes');
      } else {
        setDesktopDrawer('routes');
      }
      showToast(`"${createdRoute.name}" נשלח לתפריט המסלולים הפעילים`);
    },
    [currentUser?.uid, isMobile]
  );

  const handleConfirmSendRouteToPlanningDb = useCallback(
    async (options: {
      folderId: string | null;
      categoryId: TrailCategoryId;
      difficulty: TrailDifficulty;
      tags: string[];
    }) => {
      if (!sendToPlanningRouteTarget || !currentUser?.uid) return;
      const savedTrail = await PlanningTrailManager.sendActiveRouteToPlanningDb(
        sendToPlanningRouteTarget.id,
        {
          ...options,
          ownerUid: currentUser.uid,
        }
      );
      if (!savedTrail) return;
      setPlanningTrails((prev) => [savedTrail, ...prev]);
      setSelectedPlanningTrailId(savedTrail.id);
      showToast(`"${savedTrail.name}" נשמר במאגר התכנון`);
    },
    [currentUser?.uid, sendToPlanningRouteTarget]
  );

  const handleSelectSearchResultRef = useRef<(item: SearchResultItem) => void>(() => {});
  handleSelectSearchResultRef.current = handleSelectSearchResult;
  const handleSelectSearchResultStable = useCallback((item: SearchResultItem) => {
    handleSelectSearchResultRef.current(item);
  }, []);

  const isSearchingPending =
    searchQuery.trim().length > 0 && searchQuery.trim() !== executedSearchQuery.trim();

  const handleSearchFocusChange = useCallback((focused: boolean) => {
    setIsSearchFocused(focused);
    if (focused && isMobileRef.current) {
      setMobileTab('explore');
      setMobilePlanningOverlay(null);
    }
  }, []);

  const renderSearchBar = (compactMobile: boolean, navigationBox = false) => (
    <SearchBar
      compactMobile={compactMobile}
      autoFocus={navigationBox}
      onClose={navigationBox ? closeNavSearch : undefined}
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
      onChangeSearchFocused={handleSearchFocusChange}
      onClearSearch={handleClearSearch}
      onSelectResult={handleSelectSearchResultStable}
      onRebuildIndex={handleRebuildSearchIndex}
      hasOsmInfo={Boolean(osmInfo)}
      isOfflineReady={isOfflineReady}
      isOnline={isOnline}
      onOpenMobileOffline={handleOpenMapStorage}
      onToggleDesktopRoutes={handleToggleDesktopRoutes}
    />
  );

  const renderNorthModeButton = (mobile = false) => {
    const isOffNorthIn2d =
      northMode === '2d-north' &&
      Math.abs(normalizeBearingDeltaDeg(mapBearing)) >= NORTH_BEARING_SNAP_TOLERANCE_DEG;
    const label =
      northMode === '2d-north'
        ? isOffNorthIn2d
          ? 'מפה מסובבת — לחץ לאיפוס לצפון 2D'
          : 'כיוון מפה: 2D צפון למעלה — לחץ למעבר לכיוון תנועה 2D'
        : northMode === '2d-pov'
          ? 'כיוון מפה: 2D כיוון תנועה (POV) — לחץ למעבר ל-3D כיוון תנועה'
          : 'כיוון מפה: 3D כיוון תנועה (POV) — לחץ לאיפוס לצפון 2D';

    const ringClass =
      northMode === '2d-pov'
        ? `${t.pillBtn} border-red-500/80 ring-2 ring-red-500/20`
        : northMode === '3d-pov'
          ? `${t.pillBtn} border-emerald-500/80 ring-2 ring-emerald-500/25`
          : t.pillBtn;

    const darkContrastFilter =
      theme === 'topo-dark' && (northMode === '2d-north' || northMode === '3d-pov')
        ? 'drop-shadow(0 0 1.5px rgba(255,255,255,0.85))'
        : undefined;

    return (
      <button
        type="button"
        onClick={handleCycleNorthMode}
        data-north-mode={northMode}
        aria-label={label}
        title={label}
        className={`${
          mobile ? 'w-10 h-10 rounded-full' : 'w-10 h-10 rounded-xl'
        } border shadow-lg flex items-center justify-center transition-all shrink-0 ${ringClass}`}
      >
        <svg
          viewBox="0 0 24 24"
          className="w-[22px] h-[22px]"
          style={{
            transform: northMode === '2d-north' ? `rotate(${-mapBearing}deg)` : undefined,
            filter: darkContrastFilter,
          }}
          aria-hidden="true"
        >
          {northMode === '2d-north' && (
            <>
              {/* Modern open-crown compass bezel + crisp N + faceted black compass needle */}
              <path
                d="M15.7 5.2 A 8.8 8.8 0 1 1 8.3 5.2"
                fill="none"
                stroke="#000000"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeOpacity="0.45"
              />
              <path
                d="M10.4 5.9 V2.1 L13.6 5.9 V2.1"
                fill="none"
                stroke="#000000"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 7.4 L15.2 14.1 L12 12.7 L8.8 14.1 Z"
                fill="#000000"
                stroke="#000000"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
              <path
                d="M12 19.6 L15.2 14.1 L12 12.7 L8.8 14.1 Z"
                fill="none"
                stroke="#000000"
                strokeWidth="1.35"
                strokeLinejoin="round"
              />
            </>
          )}

          {northMode === '2d-pov' && (
            <>
              {/* Modern 2D POV forward field-of-view cone + sleek red chevron */}
              <path
                d="M12 14 L5.4 5.8 A 10 10 0 0 1 18.6 5.8 Z"
                fill="#dc2626"
                fillOpacity="0.18"
              />
              <path
                d="M5.4 5.8 A 10 10 0 0 1 18.6 5.8"
                fill="none"
                stroke="#dc2626"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
              <path
                d="M12 7 L18.2 19.6 L12 16.4 L5.8 19.6 Z"
                fill="#dc2626"
                stroke="#dc2626"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </>
          )}

          {northMode === '3d-pov' && (
            <>
              {/* Modern 3D glyph (green fill with crisp black outline) */}
              {[
                { stroke: '#000000', strokeWidth: 3.7 },
                { stroke: '#22c55e', strokeWidth: 2.0 },
              ].map((pass) => (
                <path
                  key={pass.stroke}
                  d="M 3.5 6.6 H 7.1 C 8.7 6.6 9.6 7.7 9.6 9.2 C 9.6 10.7 8.7 11.9 6.9 12.0 H 5.7 M 6.9 12.0 C 8.9 12.1 9.9 13.3 9.9 15.0 C 9.9 16.6 8.9 17.6 7.1 17.6 H 3.4 M 14.2 6.6 H 17.0 C 19.5 6.6 20.6 8.6 20.6 12.1 C 20.6 15.6 19.5 17.6 17.0 17.6 H 14.2 Z"
                  fill="none"
                  stroke={pass.stroke}
                  strokeWidth={pass.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </>
          )}
        </svg>
      </button>
    );
  };

  const renderLocationModeButton = (mobile = false, grouped = false) => {
    const label =
      locationMode === 'none'
        ? 'מיקום שלי: כבוי — לחץ לקפיצה למיקום'
        : locationMode === 'once'
          ? 'מיקום שלי: קפיצה חד-פעמית (כחול) — לחץ שוב למעקב רציף 3D'
          : 'מיקום שלי: מעקב רציף במרכז המסך (ירוק) — לחץ שוב לכיבוי';

    const btnCls =
      locationMode === 'once'
        ? grouped
          ? 'bg-sky-600 hover:bg-sky-500 text-white'
          : 'bg-sky-600 hover:bg-sky-500 border-sky-400 text-white ring-2 ring-sky-400/35'
        : locationMode === 'tracking'
          ? grouped
            ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
            : 'bg-emerald-600 hover:bg-emerald-500 border-emerald-400 text-white ring-2 ring-emerald-400/35'
          : grouped
            ? 'hover:bg-black/5'
            : t.pillBtn;

    const iconCls =
      locationMode === 'none'
        ? theme === 'topo-dark'
          ? 'text-slate-200'
          : 'text-slate-800'
        : !userLocation
          ? 'text-white animate-pulse'
          : 'text-white';

    return (
      <button
        type="button"
        onClick={() => {
          setDesktopTopMenu(null);
          setLayerSheetSection(null);
          setMobileSpeedDial(null);
          handleLocateMe();
        }}
        data-location-mode={locationMode}
        aria-label={label}
        aria-pressed={locationMode !== 'none'}
        title={label}
        className={`${
          grouped
            ? 'w-10 h-10 flex items-center justify-center transition-all shrink-0'
            : `${mobile ? 'w-10 h-10 rounded-full' : 'w-10 h-10 rounded-xl'} border shadow-lg flex items-center justify-center transition-all shrink-0`
        } ${btnCls}`}
      >
        <LocateFixed className={`w-[18px] h-[18px] ${iconCls}`} />
      </button>
    );
  };

  const renderLocationNavGroup = (mobile = false, locationButtonEl: React.ReactNode) => {
    const isRecordUiOpen = mobile
      ? mobileNavOverlay === 'record'
      : desktopDrawer === 'record';

    return (
      <div
        dir="ltr"
        data-testid="location-nav-group"
        className="flex items-end gap-1.5"
      >
        {/* Connected vertical capsule matching Style / Layers / POI: My Location + Navigation (icon-only) */}
        <div
          className={`w-10 flex flex-col border shadow-lg overflow-hidden shrink-0 ${
            mobile ? 'rounded-full' : 'rounded-xl'
          } ${t.pillBtn}`}
        >
          {locationButtonEl}
          <div className="h-px bg-current opacity-15" />
          <button
            type="button"
            data-testid="nav-toggle-btn"
            onClick={handleToggleDesktopFreeNavigation}
            aria-pressed={isNavigationActive}
            aria-label={isNavigationActive ? 'צא ממצב ניווט' : 'ניווט חי'}
            className={`w-10 h-10 flex items-center justify-center transition-colors shrink-0 ${
              isNavigationActive ? 'bg-emerald-600 text-white' : 'hover:bg-black/5'
            }`}
            title={
              isNavigationActive
                ? 'צא ממצב ניווט'
                : 'התחל מצב ניווט חי (כיוון מפה + שמירת מסך דולק)'
            }
          >
            <Navigation
              className={`w-[18px] h-[18px] ${
                isNavigationActive ? 'text-white' : 'text-emerald-500'
              }`}
            />
          </button>
        </div>

        {/* Record spans out next to Navigate ONLY while Navigation is active */}
        {isNavigationActive && (
          <button
            type="button"
            data-testid="record-toggle-btn"
            onClick={() => {
              setDesktopTopMenu(null);
              setLayerSheetSection(null);
              setIsUserIconPickerOpen(false);
              setIsGoogleMenuOpen(false);
              setMobileSpeedDial(null);
              if (mobile) {
                setMobileNavOverlay((prev) => (prev === 'record' ? null : 'record'));
              } else {
                setDesktopDrawer((prev) => (prev === 'record' ? null : 'record'));
              }
            }}
            aria-pressed={isRecordUiOpen || isRecordingTrack}
            aria-label="הקלטת מסלול GPS"
            className={`h-10 border shadow-lg flex items-center justify-center gap-1.5 text-xs font-semibold transition-all shrink-0 ${
              mobile ? 'rounded-full' : 'rounded-xl'
            } ${isRecordingTrack ? 'px-2.5' : 'w-10'} ${
              isRecordUiOpen || isRecordingTrack
                ? 'bg-rose-600 border-rose-500 text-white'
                : t.pillBtn
            }`}
            title="הקלטת מסלול GPS (זמינה בזמן ניווט)"
          >
            <span
              className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                isRecordUiOpen || isRecordingTrack
                  ? 'border-white'
                  : 'border-rose-500'
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isRecordingTrack && !isRecordingPaused
                    ? 'bg-white animate-pulse'
                    : isRecordingTrack
                      ? 'bg-amber-300'
                      : isRecordUiOpen
                        ? 'bg-white'
                        : 'bg-rose-500'
                }`}
              />
            </span>
            {isRecordingTrack && (
              <span dir="ltr" className="tabular-nums">
                {formatDuration(recordElapsedSeconds)}
              </span>
            )}
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      dir="rtl"
      className={`relative w-screen h-screen h-dvh overflow-hidden bg-slate-950 select-none flex flex-col ${
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
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white rounded-full shadow-2xl px-4 py-2 flex items-center gap-2.5 text-xs font-bold">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{toastMessage}</span>
            {undoDeletedPoi && (
              <button
                type="button"
                onClick={() => void handleUndoDeletePoi()}
                className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white text-emerald-700 hover:bg-emerald-50 text-xs font-extrabold transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>בטל מחיקה</span>
              </button>
            )}
          </div>
        )}

        {/* Pick POI on Map Hint Banner (Touch & Desktop clarity) */}
        {isPickingPoiLocation && (
          <div
            className={`absolute left-1/2 -translate-x-1/2 z-40 px-3.5 py-1.5 rounded-full bg-sky-600 text-white text-xs font-bold shadow-2xl flex items-center gap-2 whitespace-nowrap pointer-events-auto ${
              isMobile ? 'bottom-12' : 'top-16'
            }`}
          >
            <span>לחץ על נקודה במפה למיקום הנקודה החדשה</span>
            <button
              type="button"
              onClick={() => setIsPickingPoiLocation(false)}
              className="px-2 py-0.5 rounded-full bg-white/20 hover:bg-white/30 text-[11px] transition-colors"
            >
              ביטול
            </button>
          </div>
        )}

        <div
          className={`fixed z-[55] flex flex-col gap-2 ${
            isMobile ? 'bottom-20 left-2 right-2' : 'top-16 right-3 w-[380px] max-w-[calc(100vw-24px)]'
          }`}
        >
          {isTrailMarkingMode && (
            <div
              dir="rtl"
              className={`flex items-center gap-1 rounded-xl border p-1 shadow-lg ${t.panel}`}
              role="tablist"
              aria-label="מצבי עריכת דרכים וסימון שבילים"
            >
              {[
                { id: 'edit-road' as const, label: 'עריכת דרך / סימון' },
                { id: 'add-road' as const, label: 'הוספת דרך חדשה' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={trailSubMode === tab.id}
                  onClick={() => switchTrailSubMode(tab.id)}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors ${
                    trailSubMode === tab.id ? 'bg-emerald-600 text-white' : t.hoverRow
                  }`}
                >
                  {tab.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setIsOsmSyncFullPage(false);
                  setIsOsmSyncOpen(true);
                }}
                className={`shrink-0 rounded-lg border px-2 py-1.5 text-[11px] font-bold flex items-center gap-1 transition-colors ${t.pillBtn}`}
                title="סנכרון דרכים קהילתיות ל-OpenStreetMap"
              >
                <UploadCloud className="h-3.5 w-3.5 text-sky-500" />
                <span>OSM{pendingOsmSyncCount > 0 ? ` (${pendingOsmSyncCount})` : ''}</span>
              </button>
              <button
                type="button"
                onClick={exitTrailMarkingMode}
                className={`shrink-0 rounded-lg p-1.5 transition-colors ${t.hoverRow} ${t.muted}`}
                title="סיום מצב עריכת דרכים"
                aria-label="סיום מצב עריכת דרכים"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {isTrailMarkingMode && isDrawingRoad && roadSnapPreview && (
            <div
              dir="rtl"
              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[11px] font-semibold shadow ${t.panel}`}
            >
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span>
                נצמד ל-{roadSnapPreview.roadLabel} ({roadSnapPreview.distMeters} מ׳)
              </span>
            </div>
          )}

          {isTrailMarkingMode && roadDraft && (
            <Suspense fallback={null}>
              <CommunityRoadEditor
                theme={theme}
                currentUser={currentUser}
                isOnline={isOnline}
                draft={roadDraft}
                isDrawingGeometry={isDrawingRoad}
                selectedVertexIndex={selectedRoadVertexIndex}
                onClearSelectedVertex={() => setSelectedRoadVertexIndex(null)}
                onDeleteSelectedVertex={() => {
                  const delIdx = selectedRoadVertexIndex;
                  if (delIdx === null) return;
                  setRoadDraft((prev) => {
                    if (!prev || prev.coordinates.length <= 2) return prev;
                    const nextCoords = prev.coordinates.filter((_, i) => i !== delIdx);
                    const nextAnchors = prev.anchors
                      .filter((a) => a.vertexIndex !== delIdx)
                      .map((a) => ({
                        ...a,
                        vertexIndex: a.vertexIndex > delIdx ? a.vertexIndex - 1 : a.vertexIndex,
                      }));
                    return { ...prev, coordinates: nextCoords, anchors: nextAnchors };
                  });
                  setSelectedRoadVertexIndex(null);
                }}
                onStartExtendDrawing={() => {
                  setSelectedRoadVertexIndex(null);
                  setIsDrawingRoad(true);
                }}
                onUndoLastVertex={() =>
                  setRoadDraft((prev) => {
                    if (!prev || prev.coordinates.length === 0) return prev;
                    const removedIdx = prev.coordinates.length - 1;
                    if (selectedRoadVertexIndex === removedIdx) setSelectedRoadVertexIndex(null);
                    return {
                      ...prev,
                      coordinates: prev.coordinates.slice(0, -1),
                      anchors: prev.anchors.filter((a) => a.vertexIndex !== removedIdx),
                    };
                  })
                }
                onFinishDrawing={() => {
                  setIsDrawingRoad(false);
                  setSelectedRoadVertexIndex(null);
                  setRoadSnapPreview(null);
                }}
                onCancel={() => {
                  setIsDrawingRoad(false);
                  setRoadDraft(null);
                  setSelectedRoadVertexIndex(null);
                  setRoadSnapPreview(null);
                  setTrailSubMode('edit-road');
                }}
                onSaved={() => {
                  setIsDrawingRoad(false);
                  setRoadDraft(null);
                  setSelectedRoadVertexIndex(null);
                  setRoadSnapPreview(null);
                  setTrailSubMode('edit-road');
                }}
                onDeleted={() => {
                  setIsDrawingRoad(false);
                  setRoadDraft(null);
                  setSelectedRoadVertexIndex(null);
                  setRoadSnapPreview(null);
                  setTrailSubMode('edit-road');
                }}
                onNotify={showToast}
              />
            </Suspense>
          )}
        </div>

        {/* ================= DESKTOP / WEB FLOATING CHROME ================= */}
        {!isMobile && (
          <>
            {/* Top-Right (RTL Start): Search Capsule + Contextual Floating Drawer */}
            <div className="absolute top-3 right-3 z-30 max-w-[calc(100vw-24px)] flex flex-col gap-2 pointer-events-none">
              <div className="pointer-events-auto w-[380px] max-w-full ml-auto">
                {renderSearchBar(false)}
              </div>

              {desktopDrawer && (
                <div
                  style={
                    desktopDrawer === 'planning-db'
                      ? {
                          width: `min(${planningDbWidthPx}px, 55vw)`,
                          height: !isDesktopDrawerMinimized ? 'calc(100vh - 196px)' : undefined,
                        }
                      : { width: '380px' }
                  }
                  className={`relative ml-auto max-w-full pointer-events-auto rounded-2xl border overflow-hidden flex flex-col max-h-[calc(100vh-196px)] ${t.panel}`}
                >
                  {desktopDrawer === 'planning-db' && !isDesktopDrawerMinimized && (
                    <div
                      onPointerDown={handleStartResizePlanningDb}
                      title="גרור לשינוי רוחב החלון (עד 55%)"
                      className="absolute top-0 bottom-0 left-0 w-2 cursor-ew-resize hover:bg-emerald-500/35 active:bg-emerald-500/50 transition-colors z-20"
                    />
                  )}
                  <SheetChromeHeader
                    title={DESKTOP_DRAWER_TITLES[desktopDrawer] ?? ''}
                    minimized={isDesktopDrawerMinimized}
                    onToggleMinimize={() => setIsDesktopDrawerMinimized((v) => !v)}
                    onClose={handleCloseDesktopDrawer}
                    theme={theme}
                  />
                  <div
                    className={
                      isDesktopDrawerMinimized
                        ? 'hidden'
                        : 'contents'
                    }
                  >
                  {desktopDrawer === 'poi' && (
                    <PoiInspectorSheet
                      poi={selectedPoi}
                      theme={theme}
                      referenceCoord={referenceCoord}
                      currentUser={currentUser}
                      canDeletePoi={canUserDeletePoi(currentUser, selectedPoi)}
                      isAuthBusy={isAuthBusy}
                      onSignInGoogle={handleSignInGoogle}
                      embedded
                      hideCloseButton
                      onClose={() => {
                        setSelectedPoi(null);
                        setDesktopDrawer(null);
                      }}
                      onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 15.2)}
                      onNavigateToPoi={handleNavigateToPoi}
                      onPoiUpdated={handlePoiUpdated}
                      onDeletePoi={canUserDeletePoi(currentUser, selectedPoi) ? handleDeletePoi : undefined}
                      onSharePoi={handleOpenSharePoiModal}
                      onPromoteToGlobal={handlePromotePoiToGlobal}
                      onDismissSharedPoi={handleDismissSharedPoi}
                      onNotify={showToast}
                    />
                  )}

                  {desktopDrawer === 'planning-db' && currentUser && (
                    <Suspense fallback={null}>
                      <PlanningTrailDbDrawer
                        theme={theme}
                        hideCloseButton
                        folders={planningFolders}
                        trails={planningTrails}
                        selectedTrailId={selectedPlanningTrailId}
                        onSelectTrail={handleSelectPlanningTrail}
                        onCreateFolder={handleCreatePlanningFolder}
                        onRenameFolder={handleRenamePlanningFolder}
                        onDeleteFolder={handleDeletePlanningFolder}
                        onUpdateTrailMetadata={handleUpdatePlanningTrailMetadata}
                        onEditTrailOnMap={handleEditPlanningTrailOnMap}
                        onDeleteTrail={handleDeletePlanningTrail}
                        onSendTrailToActiveRoutes={handleSendPlanningTrailToActiveRoutes}
                      />
                    </Suspense>
                  )}

                  {desktopDrawer === 'routes' && (
                    <Suspense fallback={null}>
                      <ElevationProfileDrawer
                      route={activeRoute}
                      routes={routes}
                      pois={pois}
                      theme={theme}
                      embedded
                      hideCloseButton
                      isNavigating={isNavigatingRoute}
                      routeDisplayMode={resolvedRouteDisplay.mode}
                      backgroundRouteIds={pinnedBackgroundRouteIds}
                      unseenSharedCount={unseenSharedCount}
                      onSelectRoute={handleSelectRoute}
                      onStartNavigation={handleStartRouteNavigation}
                      onStopNavigation={handleStopRouteNavigation}
                      onOpenImporter={currentUser ? handleOpenMapStorage : undefined}
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
                      onSendToPlanningDb={
                        currentUser ? (r) => setSendToPlanningRouteTarget(r) : undefined
                      }
                      onClose={() => setDesktopDrawer(null)}
                      onHoverPoint={handleHoverElevationChart}
                      onSelectPoint={(pt) =>
                        handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                      }
                      onFlyToRoute={handleFlyToRoute}
                      onNotify={showToast}
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
                    </Suspense>
                  )}

                  {desktopDrawer === 'recordings' && (
                    <Suspense fallback={null}>
                      <NavigationRecordingsPanel
                        theme={theme}
                        hideCloseButton
                        currentUser={currentUser}
                        isAuthBusy={isAuthBusy}
                        onSignInGoogle={handleSignInGoogle}
                        routes={routes}
                        selectedRoute={activeRoute}
                        pois={pois}
                        routeDisplayMode={resolvedRouteDisplay.mode}
                        backgroundRouteIds={pinnedBackgroundRouteIds}
                        unseenSharedCount={unseenSharedCount}
                        onSelectRoute={handleSelectRoute}
                        onStartNavigation={handleStartRouteNavigation}
                        onDeleteRoute={handleDeleteRoute}
                        onShareRoute={handleOpenShareModal}
                        onViewSharedTab={() => setUnseenSharedCount(0)}
                        onDuplicateSharedRoute={handleDuplicateSharedRoute}
                        onDismissSharedRoute={handleDismissSharedRoute}
                        onRenameRoute={handleRenameRoute}
                        onUpdateNotes={handleUpdateRecordingNotes}
                        onChangeRouteColor={handleChangeRouteColor}
                        onToggleBackgroundRoute={handleToggleBackgroundRoute}
                        onReverseRoute={handleReverseRoute}
                        onUseForMapEdit={handleUseRecordingForMapEdit}
                        onSendToPlanningDb={
                          currentUser ? (r) => setSendToPlanningRouteTarget(r) : undefined
                        }
                        onImportRecordingFile={handleImportRecordingFile}
                        onFlyToRoute={handleFlyToRoute}
                        onHoverPoint={handleHoverElevationChart}
                        onSelectPoint={(pt) =>
                          handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                        }
                        onNotify={showToast}
                        onClose={() => setDesktopDrawer(null)}
                      />
                    </Suspense>
                  )}

                  {desktopDrawer === 'plan-route' && (
                    <RoutePlannerPanel
                      theme={theme}
                      hideCloseButton
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
                      hideCloseButton
                      currentUser={currentUser}
                      isAuthBusy={isAuthBusy}
                      onSignInGoogle={handleSignInGoogle}
                      onOpenRecordings={openNavigationRecordings}
                      isRecording={isRecordingTrack}
                      isPaused={isRecordingPaused}
                      elapsedSeconds={recordElapsedSeconds}
                      distanceKm={recordedDistanceKm}
                      ascentMeters={recordedAscentMeters}
                      currentElevation={cursorCoords.ele}
                      pointsCount={recordedCoords.length}
                      onStartOrResume={handleStartOrResumeRecording}
                      onPause={() => setIsRecordingPaused(true)}
                      onSaveRoute={() => openRecordingSavePrompt('stop-recording')}
                      onDiscard={() => handleDiscardRecordedTrack()}
                      onDropWaypoint={() => openAddPoiPanelAt({ lon: cursorCoords.lon, lat: cursorCoords.lat, ele: cursorCoords.ele })}
                      onClose={() => setDesktopDrawer(null)}
                    />
                  )}

                  {desktopDrawer === 'add-poi' && (
                    <AddPoiPanel
                      theme={theme}
                      hideCloseButton
                      centerCoords={addPoiCoords ?? cursorCoords}
                      currentUser={currentUser}
                      isOnline={isOnline}
                      firebaseAvailable={AuthService.isAvailable()}
                      isAuthBusy={isAuthBusy}
                      onSignInGoogle={handleSignInGoogle}
                      onClose={() => setDesktopDrawer(null)}
                      onCreated={(created, meta) => {
                        setPois((prev) => [...prev, created]);
                        setSelectedPoi(created);
                        setDesktopDrawer('poi');
                        const sharedCount = created.sharedWith?.length || 0;
                        showToast(
                          meta?.queuedOffline
                            ? `הנקודה "${created.nameHe}" נשמרה מקומית ותסונכרן בענן כשיתאפשר`
                            : created.visibility === 'private'
                              ? sharedCount > 0
                                ? `הנקודה "${created.nameHe}" נשמרה כפרטית ושותפה עם ${sharedCount} משתמשים`
                                : `הנקודה "${created.nameHe}" נשמרה כפרטית (גלויה רק לך)`
                              : `הנקודה "${created.nameHe}" נשמרה במפה הגלובלית!`
                        );
                      }}
                    />
                  )}

                  </div>
                </div>
              )}
            </div>

            {/* Top-Left (RTL End): Trails Menu + Map Edit Menu + Offline Status + Active Route Banner */}
            <div
              dir="ltr"
              className="absolute top-3 left-3 z-30 max-w-[calc(100vw-408px)] flex flex-wrap items-center gap-2 pointer-events-auto"
            >
              {/* Grouped Dropdown Menus: מסלולים + עריכת מפה */}
              <div
                ref={desktopTopMenuRef}
                dir="rtl"
                className="relative flex items-center gap-1.5"
              >
                {(() => {
                  const isTrailsActive =
                    desktopTopMenu === 'trails' ||
                    desktopDrawer === 'routes' ||
                    desktopDrawer === 'recordings' ||
                    desktopDrawer === 'planning-db' ||
                    desktopDrawer === 'plan-route';
                  return (
                    <div className="relative">
                      <button
                        type="button"
                        data-testid="menu-trails-btn"
                        aria-expanded={desktopTopMenu === 'trails'}
                        aria-haspopup="menu"
                        onClick={() => toggleDesktopTopMenu('trails')}
                        className={`px-3 py-2 rounded-full border text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors ${
                          desktopDrawer === 'plan-route' && desktopTopMenu !== 'trails'
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : isTrailsActive
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : t.panel
                        }`}
                      >
                        <RouteIcon
                          className={`w-3.5 h-3.5 ${
                            isTrailsActive ? 'text-white' : 'text-emerald-500'
                          }`}
                        />
                        <span>מסלולים</span>
                        {unseenSharedCount > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full bg-violet-600 text-white text-[10px] font-bold leading-none">
                            +{unseenSharedCount}
                          </span>
                        )}
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${
                            desktopTopMenu === 'trails' ? 'rotate-180' : ''
                          }`}
                        />
                      </button>

                      {desktopTopMenu === 'trails' && (
                        <div
                          role="menu"
                          data-testid="menu-trails-dropdown"
                          className={`absolute top-full left-0 mt-1.5 w-64 rounded-2xl border p-1.5 shadow-2xl z-40 space-y-1 ${t.panel}`}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setDesktopTopMenu(null);
                              setDesktopDrawer((prev) => (prev === 'routes' ? null : 'routes'));
                            }}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition-colors ${
                              desktopDrawer === 'routes' ? 'bg-emerald-600 text-white' : t.hoverRow
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <RouteIcon
                                className={`w-4 h-4 shrink-0 ${
                                  desktopDrawer === 'routes' ? 'text-white' : 'text-emerald-500'
                                }`}
                              />
                              <span className="min-w-0">
                                <span className="font-bold block">המסלולים שלי</span>
                                <span
                                  className={`text-[11px] block truncate ${
                                    desktopDrawer === 'routes' ? 'text-emerald-100' : t.muted
                                  }`}
                                >
                                  ניהול, משותפים ופרופיל גובה
                                </span>
                              </span>
                            </span>
                            {unseenSharedCount > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-violet-600 text-white text-[10px] font-bold shrink-0">
                                +{unseenSharedCount}
                              </span>
                            )}
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            data-testid="menu-recordings-btn"
                            onClick={() => openNavigationRecordings()}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition-colors ${
                              desktopDrawer === 'recordings'
                                ? 'bg-rose-600 text-white'
                                : t.hoverRow
                            }`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <Activity
                                className={`w-4 h-4 shrink-0 ${
                                  desktopDrawer === 'recordings' ? 'text-white' : 'text-rose-500'
                                }`}
                              />
                              <span className="min-w-0">
                                <span className="font-bold block">הקלטות ניווט</span>
                                <span
                                  className={`text-[11px] block truncate ${
                                    desktopDrawer === 'recordings' ? 'text-rose-100' : t.muted
                                  }`}
                                >
                                  {currentUser
                                    ? 'תחקור, שיתוף, עדכון מפה וייצוא GPX'
                                    : 'דורש התחברות Google'}
                                </span>
                              </span>
                            </span>
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setDesktopTopMenu(null);
                              setDesktopDrawer((prev) =>
                                prev === 'plan-route' ? null : 'plan-route'
                              );
                            }}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${
                              desktopDrawer === 'plan-route' ? 'bg-blue-600 text-white' : t.hoverRow
                            }`}
                          >
                            <PenTool
                              className={`w-4 h-4 shrink-0 ${
                                desktopDrawer === 'plan-route' ? 'text-white' : 'text-blue-500'
                              }`}
                            />
                            <span className="min-w-0">
                              <span className="font-bold block">תכנון מסלול</span>
                              <span
                                className={`text-[11px] block truncate ${
                                  desktopDrawer === 'plan-route' ? 'text-blue-100' : t.muted
                                }`}
                              >
                                בניית מסלול רגלי, אופניים או 4x4
                              </span>
                            </span>
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => openTrailsPlanningDb()}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${
                              desktopDrawer === 'planning-db'
                                ? 'bg-emerald-600 text-white'
                                : t.hoverRow
                            }`}
                          >
                            <FolderTree
                              className={`w-4 h-4 shrink-0 ${
                                desktopDrawer === 'planning-db'
                                  ? 'text-white'
                                  : 'text-emerald-500'
                              }`}
                            />
                            <span className="min-w-0">
                              <span className="font-bold block">מאגר תכנון</span>
                              <span
                                className={`text-[11px] block truncate ${
                                  desktopDrawer === 'planning-db' ? 'text-emerald-100' : t.muted
                                }`}
                              >
                                {currentUser ? 'תיקיות וספריית מסלולים' : 'דורש התחברות Google'}
                              </span>
                            </span>
                          </button>

                          {currentUser && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => handleOpenMapStorage()}
                              className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${t.hoverRow}`}
                            >
                              <Download className="w-4 h-4 shrink-0 text-sky-500" />
                              <span className="min-w-0">
                                <span className="font-bold block">ייבוא GPX / KML</span>
                                <span className={`text-[11px] block truncate ${t.muted}`}>
                                  ייבוא קבצי מסלולים ונקודות
                                </span>
                              </span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {(() => {
                  const isMapEditActive =
                    desktopTopMenu === 'map-edit' ||
                    isPickingPoiLocation ||
                    isAddingPoiMode ||
                    desktopDrawer === 'add-poi' ||
                    isTrailMarkingMode ||
                    isOsmSyncOpen;
                  return (
                    <div className="relative">
                      <button
                        type="button"
                        data-testid="menu-map-edit-btn"
                        aria-expanded={desktopTopMenu === 'map-edit'}
                        aria-haspopup="menu"
                        onClick={() => toggleDesktopTopMenu('map-edit')}
                        className={`px-3 py-2 rounded-full border text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors ${
                          isPickingPoiLocation || isAddingPoiMode
                            ? 'bg-sky-600 border-sky-500 text-white'
                            : isMapEditActive
                              ? 'bg-emerald-600 border-emerald-500 text-white'
                              : t.panel
                        }`}
                      >
                        <Pencil
                          className={`w-3.5 h-3.5 ${
                            isMapEditActive ? 'text-white' : 'text-amber-500'
                          }`}
                        />
                        <span>עריכת מפה</span>
                        {pendingOsmSyncCount > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full bg-sky-600 text-white text-[10px] font-bold leading-none">
                            {pendingOsmSyncCount}
                          </span>
                        )}
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${
                            desktopTopMenu === 'map-edit' ? 'rotate-180' : ''
                          }`}
                        />
                      </button>

                      {desktopTopMenu === 'map-edit' && (
                        <div
                          role="menu"
                          data-testid="menu-map-edit-dropdown"
                          className={`absolute top-full left-0 mt-1.5 w-64 rounded-2xl border p-1.5 shadow-2xl z-40 space-y-1 ${t.panel}`}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setDesktopTopMenu(null);
                              startAddPoiPick();
                            }}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${
                              isPickingPoiLocation || isAddingPoiMode
                                ? 'bg-sky-600 text-white'
                                : t.hoverRow
                            }`}
                          >
                            <Plus
                              className={`w-4 h-4 shrink-0 ${
                                isPickingPoiLocation || isAddingPoiMode
                                  ? 'text-white'
                                  : 'text-sky-500'
                              }`}
                            />
                            <span className="min-w-0">
                              <span className="font-bold block">הוסף נקודה (POI)</span>
                              <span
                                className={`text-[11px] block truncate ${
                                  isPickingPoiLocation || isAddingPoiMode
                                    ? 'text-sky-100'
                                    : t.muted
                                }`}
                              >
                                בחירת מיקום במפה להוספת נקודה
                              </span>
                            </span>
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => openMapEditRoadMode('edit-road')}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${
                              isTrailMarkingMode && trailSubMode === 'edit-road'
                                ? 'bg-emerald-600 text-white'
                                : t.hoverRow
                            }`}
                          >
                            <MapPin
                              className={`w-4 h-4 shrink-0 ${
                                isTrailMarkingMode && trailSubMode === 'edit-road'
                                  ? 'text-white'
                                  : 'text-rose-500'
                              }`}
                            />
                            <span className="min-w-0">
                              <span className="font-bold block">עריכת דרך / סימון שבילים</span>
                              <span
                                className={`text-[11px] block truncate ${
                                  isTrailMarkingMode && trailSubMode === 'edit-road'
                                    ? 'text-emerald-100'
                                    : t.muted
                                }`}
                              >
                                {currentUser
                                  ? 'עריכת דרך קיימת וסימון שבילים'
                                  : 'דורש התחברות Google'}
                              </span>
                            </span>
                          </button>

                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => openMapEditRoadMode('add-road')}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${
                              isTrailMarkingMode && trailSubMode === 'add-road'
                                ? 'bg-emerald-600 text-white'
                                : t.hoverRow
                            }`}
                          >
                            <PenTool
                              className={`w-4 h-4 shrink-0 ${
                                isTrailMarkingMode && trailSubMode === 'add-road'
                                  ? 'text-white'
                                  : 'text-emerald-500'
                              }`}
                            />
                            <span className="min-w-0">
                              <span className="font-bold block">הוספת דרך חדשה</span>
                              <span
                                className={`text-[11px] block truncate ${
                                  isTrailMarkingMode && trailSubMode === 'add-road'
                                    ? 'text-emerald-100'
                                    : t.muted
                                }`}
                              >
                                {currentUser
                                  ? 'שרטוט דרך או שביל חדש במפה'
                                  : 'דורש התחברות Google'}
                              </span>
                            </span>
                          </button>

                          {activeRoute && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setDesktopTopMenu(null);
                                void handleEditRouteInPlanner(activeRoute);
                              }}
                              className={`w-full text-right px-3 py-2 rounded-xl flex items-center gap-2 text-xs transition-colors ${t.hoverRow}`}
                            >
                              <RouteIcon className="w-4 h-4 shrink-0 text-blue-500" />
                              <span className="min-w-0">
                                <span className="font-bold block truncate">
                                  עריכת מסלול: {activeRoute.name}
                                </span>
                                <span className={`text-[11px] block truncate ${t.muted}`}>
                                  עריכת תוואי המסלול הפעיל
                                </span>
                              </span>
                            </button>
                          )}

                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setDesktopTopMenu(null);
                              setIsOsmSyncFullPage(false);
                              setIsOsmSyncOpen(true);
                            }}
                            className={`w-full text-right px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition-colors ${t.hoverRow}`}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <UploadCloud className="w-4 h-4 shrink-0 text-sky-500" />
                              <span className="min-w-0">
                                <span className="font-bold block">סנכרון ל-OpenStreetMap</span>
                                <span className={`text-[11px] block truncate ${t.muted}`}>
                                  העלאה וניהול שינויים קהילתיים
                                </span>
                              </span>
                            </span>
                            {pendingOsmSyncCount > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-sky-600 text-white text-[10px] font-bold shrink-0">
                                {pendingOsmSyncCount}
                              </span>
                            )}
                          </button>

                          {isTrailMarkingMode && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setDesktopTopMenu(null);
                                exitTrailMarkingMode();
                              }}
                              className="w-full text-right px-3 py-1.5 rounded-xl flex items-center gap-2 text-xs font-bold text-rose-500 hover:bg-rose-500/10 transition-colors"
                            >
                              <X className="w-3.5 h-3.5 shrink-0" />
                              <span>סיום מצב עריכת דרכים</span>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Active Route Navigation Status Pill (Alert + Remaining Distance + Stop) */}
              {isNavigatingRoute && activeRoute && (
                <div
                  dir="rtl"
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
              )}
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

            {/* GROUP 1 — Bottom-Left (RTL End): Combined My Location + Navigate (-> Record) on Top, above Layers, North, Zoom */}
            <div dir="ltr" className="absolute bottom-4 left-4 z-20 flex items-end gap-2.5 pointer-events-auto">
              <div className="flex flex-col items-start gap-1.5">
                {renderLocationNavGroup(false, renderLocationModeButton(false, true))}

                {/* Connected Layers Sub-Capsule (Style / Layers / POI) */}
                <div className={`flex flex-col rounded-xl border shadow-lg overflow-hidden ${t.pillBtn}`}>
                  {LAYER_SECTION_BUTTONS.map(({ id, title, Icon }, idx) => (
                    <React.Fragment key={id}>
                      {idx > 0 && <div className="h-px bg-current opacity-15" />}
                      <button
                        type="button"
                        onClick={() => toggleDesktopLayerSection(id)}
                        className={`w-10 h-10 flex items-center justify-center transition-colors ${
                          layerSheetSection === id
                            ? 'bg-emerald-600 text-white'
                            : 'hover:bg-black/5'
                        }`}
                        title={title}
                        aria-label={title}
                        aria-expanded={layerSheetSection === id}
                      >
                        <Icon className="w-[18px] h-[18px]" />
                      </button>
                    </React.Fragment>
                  ))}
                </div>

                {/* Zero-to-North 3-state Orientation Button (2D North / 2D POV / 3D POV) */}
                {renderNorthModeButton(false)}

                <div className={`flex flex-col rounded-xl border shadow-lg overflow-hidden ${t.pillBtn}`}>
                  <button
                    type="button"
                    onClick={() => {
                      handleUserMapOperation();
                      mapRef.current?.zoomIn();
                    }}
                    className="w-10 h-9 flex items-center justify-center text-base font-bold hover:bg-black/10 transition-colors"
                    title="התקרב"
                    aria-label="התקרב"
                  >
                    +
                  </button>
                  <div className="h-px bg-current opacity-15" />
                  <button
                    type="button"
                    onClick={() => {
                      handleUserMapOperation();
                      mapRef.current?.zoomOut();
                    }}
                    className="w-10 h-9 flex items-center justify-center text-base font-bold hover:bg-black/10 transition-colors"
                    title="התרחק"
                    aria-label="התרחק"
                  >
                    −
                  </button>
                </div>
              </div>
            </div>

            {/* GROUP 2 — Bottom-Right (above Scale Bar): User Parameters */}
            <div className="absolute bottom-12 right-4 z-20 flex flex-col items-center gap-1.5 pointer-events-auto">
              <GoogleAccountButton
                currentUser={currentUser}
                firebaseAvailable={AuthService.isAvailable()}
                isAuthBusy={isAuthBusy}
                isOnline={isOnline}
                isSyncingCloud={isSyncingCloud}
                lastSyncedAt={lastSyncedAt}
                theme={theme}
                menuAlign="open-left"
                isMenuOpen={isGoogleMenuOpen}
                onMenuOpenChange={handleDesktopGoogleMenuOpenChange}
                onSignInGoogle={handleSignInGoogle}
                onSignOutGoogle={handleSignOutGoogle}
                onSyncNow={handleSyncPendingNow}
                onOpenMapStorage={handleOpenMapStorage}
                isOfflineReady={isOfflineReady}
              />

              <button
                type="button"
                onClick={toggleDesktopUserIconPicker}
                className={`w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${
                  isLiveSharingActive
                    ? 'border-red-500 ring-2 ring-red-500/70'
                    : isUserIconPickerOpen
                      ? 'border-emerald-500 ring-2 ring-emerald-500/40'
                      : ''
                } ${t.pillBtn}`}
                title={`שנה אייקון מיקום (${userIconPref.icon.labelHe})`}
                aria-label={`שנה אייקון מיקום (${userIconPref.icon.labelHe})`}
              >
                <UserLocationIconBadge
                  icon={userIconPref.icon}
                  accentColor={userIconPref.accentColor}
                  size="sm"
                />
              </button>

              <button
                type="button"
                onClick={openShareLocationModal}
                className={`relative w-10 h-10 rounded-xl border shadow-lg flex items-center justify-center transition-all ${
                  isLiveSharingActive
                    ? 'bg-red-600 border-red-400 text-white'
                    : t.pillBtn
                }`}
                title={
                  isLiveSharingActive
                    ? 'שיתוף מיקום חי פעיל — לחץ לניהול'
                    : 'שתף מיקום חי עם משתמשים'
                }
                aria-label="שיתוף מיקום חי"
              >
                <Radio className={`w-[18px] h-[18px] ${isLiveSharingActive ? 'animate-pulse' : ''}`} />
                {livePeers.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center shadow">
                    {livePeers.length}
                  </span>
                )}
              </button>
            </div>

            {/* User Position Icon Picker Floating Popover */}
            <UserIconPickerSheet
              isOpen={isUserIconPickerOpen}
              theme={theme}
              anchorSide="right"
              preference={userIconPref}
              isOnline={isOnline}
              hasGpsFix={Boolean(userLocation)}
              onLocateOnMap={handleLocateOnceFromPicker}
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
              isOpen={layerSheetSection !== null}
              section={layerSheetSection ?? undefined}
              onClose={() => setLayerSheetSection(null)}
              visibility={visibility}
              onChangeVisibility={setVisibility}
              theme={theme}
              onSelectTheme={setTheme}
              mapStyle={mapStyle}
              onSelectMapStyle={setMapStyle}
            />
          </>
        )}

        {/* ================= MOBILE CHROME (PLANNING vs NAVIGATING) ================= */}
        {isMobile && (
          <>
            {/* MODE B: NAVIGATING — No search pill, no chips (search opens on demand from the icon column). Compact Icon Navigation Status + Planning Icon */}
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

            {/* Mobile map controls: Combined My Location + Navigate (-> Record) on TOP, then Search (Nav), Group 1, Group 2, Orientation. */}
            <div
              ref={mobileControlsRef}
              dir="ltr"
              className={`absolute left-3 z-20 pointer-events-auto pt-safe flex flex-col items-start gap-2 landscape:gap-1.5 ${
                mobileDisplayMode === 'navigating'
                  ? isNavigatingRoute && activeRoute
                    ? 'top-[5.25rem]'
                    : 'top-[4rem]'
                  : 'top-[4.5rem]'
              }`}
            >
              {/* Combined 3-State My Location + Navigate (expands to Record while navigating) on top of ALL icons */}
              {renderLocationNavGroup(true, renderLocationModeButton(true, true))}

              {/* Navigating mode has no search pill: this icon opens the search box next to it. */}
              {mobileDisplayMode === 'navigating' && (
                <button
                  type="button"
                  data-nav-search-toggle
                  onClick={isNavSearchOpen ? closeNavSearch : openNavSearch}
                  className={`w-10 h-10 rounded-full border shadow-lg flex items-center justify-center transition-all ${
                    isNavSearchOpen ? 'bg-emerald-600 border-emerald-400 text-white' : t.pillBtn
                  }`}
                  title="חיפוש"
                  aria-label="חיפוש"
                  aria-expanded={isNavSearchOpen}
                >
                  <Search className={`w-[18px] h-[18px] ${isNavSearchOpen ? '' : 'text-emerald-500'}`} />
                </button>
              )}

              {/* GROUP 1 COLLAPSED TRIGGER: Map Layers & Operations */}
              {(() => {
                const isLayersOverlayOpen =
                  mobileDisplayMode === 'navigating'
                    ? mobileNavOverlay === 'layers'
                    : mobilePlanningOverlay === 'layers';
                const isMapGroupActive = mobileSpeedDial === 'map' || isLayersOverlayOpen;
                const hasCustomMapMode =
                  visibility.terrain3d || isAerialOverlayActive(visibility) || !isMasterPoiActive(visibility);
                return (
                  <div className="relative flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsNavSearchOpen(false);
                        setMobileSpeedDial((prev) => (prev === 'map' ? null : 'map'));
                      }}
                      aria-expanded={mobileSpeedDial === 'map'}
                      aria-label="שכבות ופעולות מפה"
                      title="שכבות ופעולות מפה"
                      className={`relative w-10 h-10 rounded-full border shadow-lg flex items-center justify-center transition-all ${
                        isMapGroupActive
                          ? 'bg-emerald-600 border-emerald-400 text-white'
                          : isPickingPoiLocation || isAddingPoiMode
                            ? 'bg-sky-600 border-sky-400 text-white'
                            : t.pillBtn
                      }`}
                    >
                      <Layers className="w-[18px] h-[18px]" />
                      {hasCustomMapMode && !isMapGroupActive && (
                        <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white" />
                      )}
                    </button>

                    {mobileSpeedDial === 'map' && (
                      <div
                        className={`flex items-center gap-1 p-1 rounded-full border shadow-2xl ${t.panel}`}
                        role="toolbar"
                        aria-label="תפריט שכבות ופעולות מפה"
                      >
                        {LAYER_SECTION_BUTTONS.map(({ id, title, Icon }) => {
                          const secActive = isLayersOverlayOpen && mobileLayerSection === id;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                const openSame = secActive;
                                setMobileLayerSection(id);
                                setMobileSpeedDial(null);
                                if (mobileDisplayMode === 'navigating') {
                                  setMobileNavOverlay(openSame ? null : 'layers');
                                } else {
                                  setMobilePlanningOverlay(openSame ? null : 'layers');
                                }
                              }}
                              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                                secActive ? 'bg-emerald-600 text-white' : t.hoverRow
                              }`}
                              title={title}
                              aria-label={title}
                            >
                              <Icon className="w-[18px] h-[18px]" />
                            </button>
                          );
                        })}

                        <button
                          type="button"
                          onClick={startAddPoiPick}
                          className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                            isPickingPoiLocation || isAddingPoiMode
                              ? 'bg-sky-600 text-white'
                              : `text-sky-500 ${t.hoverRow}`
                          }`}
                          title="הוסף נקודה (לחץ ואז בחר מיקום במפה)"
                          aria-label="הוסף נקודה"
                        >
                          <Plus className="w-[18px] h-[18px]" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* GROUP 2 COLLAPSED TRIGGER: User Parameters (Google Account, User Icon, Live Share) */}
              {(() => {
                const activeOverlay =
                  mobileDisplayMode === 'navigating' ? mobileNavOverlay : mobilePlanningOverlay;
                const isUserGroupActive =
                  mobileSpeedDial === 'user' ||
                  activeOverlay === 'user-icon' ||
                  activeOverlay === 'google-account';
                return (
                  <div className="relative flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setIsNavSearchOpen(false);
                        setMobileSpeedDial((prev) => (prev === 'user' ? null : 'user'));
                      }}
                      aria-expanded={mobileSpeedDial === 'user'}
                      aria-label="פרמטרי משתמש"
                      title="פרמטרי משתמש (חשבון, אייקון מיקום, שיתוף חי)"
                      className={`relative w-10 h-10 rounded-full border shadow-lg flex items-center justify-center transition-all ${
                        isLiveSharingActive
                          ? 'border-red-500 ring-2 ring-red-500/75'
                          : isUserGroupActive
                            ? 'border-emerald-500 ring-2 ring-emerald-500/50'
                            : ''
                      } ${t.pillBtn}`}
                    >
                      <UserLocationIconBadge
                        icon={userIconPref.icon}
                        accentColor={userIconPref.accentColor}
                        size="sm"
                      />
                      {currentUser && (
                        <span
                          className={`absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border-2 ${
                            theme === 'topo-dark' ? 'border-slate-900' : 'border-white'
                          } ${isOnline ? 'bg-emerald-500' : 'bg-amber-400'}`}
                        />
                      )}
                      {livePeers.length > 0 && (
                        <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center shadow">
                          {livePeers.length}
                        </span>
                      )}
                    </button>

                    {mobileSpeedDial === 'user' && (
                      <div
                        className={`flex items-center gap-1 p-1 rounded-full border shadow-2xl ${t.panel}`}
                        role="toolbar"
                        aria-label="תפריט פרמטרי משתמש"
                      >
                        <GoogleAccountButton
                          currentUser={currentUser}
                          firebaseAvailable={AuthService.isAvailable()}
                          isAuthBusy={isAuthBusy}
                          isOnline={isOnline}
                          isSyncingCloud={isSyncingCloud}
                          lastSyncedAt={lastSyncedAt}
                          theme={theme}
                          mobile
                          compact
                          onOpenSignedInMenu={() => {
                            setMobileSpeedDial(null);
                            setMobileSheetExpanded(true);
                            if (mobileDisplayMode === 'navigating') {
                              setMobileNavOverlay(
                                mobileNavOverlay === 'google-account' ? null : 'google-account'
                              );
                            } else {
                              setMobilePlanningOverlay(
                                mobilePlanningOverlay === 'google-account' ? null : 'google-account'
                              );
                            }
                          }}
                          onSignInGoogle={() => {
                            setMobileSpeedDial(null);
                            void handleSignInGoogle();
                          }}
                          onSignOutGoogle={handleSignOutGoogle}
                          onSyncNow={handleSyncPendingNow}
                        />

                        <button
                          type="button"
                          onClick={() => {
                            setMobileSpeedDial(null);
                            if (mobileDisplayMode === 'navigating') {
                              setMobileNavOverlay(
                                mobileNavOverlay === 'user-icon' ? null : 'user-icon'
                              );
                            } else {
                              setMobilePlanningOverlay(
                                mobilePlanningOverlay === 'user-icon' ? null : 'user-icon'
                              );
                            }
                          }}
                          className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                            activeOverlay === 'user-icon' ? 'bg-emerald-600/20 ring-1 ring-emerald-500' : t.hoverRow
                          }`}
                          title={`שנה אייקון מיקום (${userIconPref.icon.labelHe})`}
                          aria-label="שנה אייקון מיקום"
                        >
                          <UserLocationIconBadge
                            icon={userIconPref.icon}
                            accentColor={userIconPref.accentColor}
                            size="sm"
                          />
                        </button>

                        <button
                          type="button"
                          onClick={openShareLocationModal}
                          className={`relative w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                            isLiveSharingActive ? 'bg-red-600 text-white' : t.hoverRow
                          }`}
                          title={
                            isLiveSharingActive
                              ? 'שיתוף מיקום חי פעיל — לחץ לניהול'
                              : 'שתף מיקום חי עם משתמשים'
                          }
                          aria-label="שיתוף מיקום חי"
                        >
                          <Radio className={`w-[18px] h-[18px] ${isLiveSharingActive ? 'animate-pulse' : ''}`} />
                          {livePeers.length > 0 && (
                            <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-emerald-500 text-white text-[9px] font-bold flex items-center justify-center shadow">
                              {livePeers.length}
                            </span>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Zero-to-North (2D North / 2D POV / 3D POV) */}
              {renderNorthModeButton(true)}
            </div>

            {/* Mobile Planning Mode Compact HUD Pill (anchored bottom-right; ScaleControl sits opposite at bottom-left) */}
            {mobileDisplayMode === 'planning' && (
              <button
                type="button"
                onClick={() => handleCopyGrid(milCoords.idfGrid8Digit)}
                dir="rtl"
                data-testid="mobile-coords-pill"
                className={`absolute bottom-3 right-3 z-20 max-w-[calc(100vw-150px)] px-2.5 py-1 rounded-full border shadow-lg text-[11px] leading-tight font-mono pointer-events-auto inline-flex items-center gap-1.5 whitespace-nowrap ${t.panel}`}
              >
                <span className="text-emerald-500 font-bold tabular-nums shrink-0">
                  {cursorCoords.ele !== null ? `${cursorCoords.ele}m` : '---'}
                </span>
                <span className="opacity-30 shrink-0">•</span>
                <span className="text-amber-500 font-bold inline-flex items-center gap-1 min-w-0 truncate">
                  <span className="font-sans">נ.צ.</span>
                  <span dir="ltr" className="tabular-nums">
                    {milCoords.idfGrid8Digit}
                  </span>
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

      {/* MODE B: NAVIGATING — Search box opened from the search icon. It sits on the icon's row, right of the
          icon column(s), so the route / off-route banner above stays visible. Rendered here for the same
          keyboard-resize reason as the planning pill. */}
      {isMobile && mobileDisplayMode === 'navigating' && isNavSearchOpen && (
        <div
          className={`absolute right-3 left-[3.75rem] z-[45] pt-safe pointer-events-none ${
            isNavigatingRoute && activeRoute ? 'top-[11rem]' : 'top-[9.75rem]'
          }`}
        >
          <div className="pointer-events-auto pt-px">{renderSearchBar(true, true)}</div>
        </div>
      )}

      {/* ================= MOBILE BOTTOM AREA ================= */}
      {isMobile && mobileDisplayMode === 'planning' && (
        <>
          {/* Planning Expandable Bottom Sheet (hidden in default map view; no Nearby strip) */}
          {isMobilePlanningSheetVisible && (
          <div className={`relative z-30 rounded-t-3xl border-t shadow-2xl shrink-0 overflow-hidden ${t.panel}`}>
            <SheetChromeHeader
              title={MOBILE_SHEET_TITLES[mobilePlanningOverlay ?? mobileTab] ?? ''}
              minimized={isMobileSheetMinimized}
              onToggleMinimize={() => setIsMobileSheetMinimized((v) => !v)}
              onClose={handleCloseMobilePlanningSheet}
              onToggleHandle={handleToggleMobilePlanningHandle}
              showHandlePill
              theme={theme}
            />
            <div className={isMobileSheetMinimized ? 'hidden' : 'contents'}>

            {mobilePlanningOverlay === 'poi' && selectedPoi ? (
              <div className="max-h-[60vh] overflow-y-auto">
                <PoiInspectorSheet
                  poi={selectedPoi}
                  theme={theme}
                  referenceCoord={referenceCoord}
                  currentUser={currentUser}
                  canDeletePoi={canUserDeletePoi(currentUser, selectedPoi)}
                  isAuthBusy={isAuthBusy}
                  onSignInGoogle={handleSignInGoogle}
                  embedded
                  hideCloseButton
                  isExpanded={mobileSheetExpanded}
                  onToggleExpand={() => setMobileSheetExpanded(!mobileSheetExpanded)}
                  onClose={() => {
                    setSelectedPoi(null);
                    setMobilePlanningOverlay(null);
                  }}
                  onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 15.2)}
                  onNavigateToPoi={handleNavigateToPoi}
                  onPoiUpdated={handlePoiUpdated}
                  onDeletePoi={canUserDeletePoi(currentUser, selectedPoi) ? handleDeletePoi : undefined}
                  onSharePoi={handleOpenSharePoiModal}
                  onPromoteToGlobal={handlePromotePoiToGlobal}
                  onDismissSharedPoi={handleDismissSharedPoi}
                  onNotify={showToast}
                />
              </div>
            ) : mobilePlanningOverlay === 'google-account' && currentUser ? (
              <GoogleAccountMenuCard
                currentUser={currentUser}
                isOnline={isOnline}
                isSyncingCloud={isSyncingCloud}
                lastSyncedAt={lastSyncedAt}
                theme={theme}
                embedded
                hideCloseButton
                onSyncNow={handleSyncPendingNow}
                onSignOutGoogle={handleSignOutGoogle}
                onClose={() => setMobilePlanningOverlay(null)}
                onOpenMapStorage={handleOpenMapStorage}
                isOfflineReady={isOfflineReady}
              />
            ) : mobilePlanningOverlay === 'user-icon' ? (
              <UserIconPickerSheet
                isOpen
                embedded
                hideCloseButton
                theme={theme}
                preference={userIconPref}
                isOnline={isOnline}
                hasGpsFix={Boolean(userLocation)}
                onLocateOnMap={handleLocateOnceFromPicker}
                onSelectPreference={handleUserIconPreferenceChange}
                onClose={() => setMobilePlanningOverlay(null)}
              />
            ) : mobilePlanningOverlay === 'layers' ? (
              <LayerSwitcherSheet
                isOpen
                embedded
                hideCloseButton
                section={mobileLayerSection}
                onSelectSection={setMobileLayerSection}
                onClose={() => setMobilePlanningOverlay(null)}
                visibility={visibility}
                onChangeVisibility={setVisibility}
                theme={theme}
                onSelectTheme={setTheme}
                mapStyle={mapStyle}
                onSelectMapStyle={setMapStyle}
              />
            ) : mobilePlanningOverlay === 'add-poi' ? (
              <div className="max-h-[60vh] overflow-y-auto">
                <AddPoiPanel
                  theme={theme}
                  hideCloseButton
                  centerCoords={addPoiCoords ?? cursorCoords}
                  currentUser={currentUser}
                  isOnline={isOnline}
                  firebaseAvailable={AuthService.isAvailable()}
                  isAuthBusy={isAuthBusy}
                  onSignInGoogle={handleSignInGoogle}
                  onClose={() => setMobilePlanningOverlay(null)}
                  onCreated={(created, meta) => {
                    setPois((prev) => [...prev, created]);
                    setSelectedPoi(created);
                    setMobilePlanningOverlay('poi');
                    const sharedCount = created.sharedWith?.length || 0;
                    showToast(
                      meta?.queuedOffline
                        ? `הנקודה "${created.nameHe}" נשמרה מקומית ותסונכרן בענן כשיתאפשר`
                        : created.visibility === 'private'
                          ? sharedCount > 0
                            ? `הנקודה "${created.nameHe}" נשמרה כפרטית ושותפה עם ${sharedCount} משתמשים`
                            : `הנקודה "${created.nameHe}" נשמרה כפרטית (גלויה רק לך)`
                          : `הנקודה "${created.nameHe}" נשמרה במפה הגלובלית!`
                    );
                  }}
                />
              </div>
            ) : mobilePlanningOverlay === 'plan-route' ? (
              mobileSheetExpanded ? (
                <div className="max-h-[56vh] overflow-y-auto">
                  <RoutePlannerPanel
                    theme={theme}
                    hideCloseButton
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
            ) : mobileTab === 'routes' || mobileTab === 'recordings' || mobileTab === 'planning-db' ? (
              <div className="max-h-[60vh] flex flex-col">
                {/* Unified מסלולים Sub-Menu: המסלולים שלי / הקלטות ניווט / תכנון מסלול / מאגר תכנון */}
                <div className="px-3 py-2 border-b border-current/10 grid grid-cols-2 gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setMobileTab('routes')}
                    className={`min-w-0 justify-center px-2 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 whitespace-nowrap transition-colors ${
                      mobileTab === 'routes' ? 'bg-emerald-600 text-white' : t.subCard
                    }`}
                  >
                    <RouteIcon className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">המסלולים שלי</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMobileTab('recordings')}
                    className={`min-w-0 justify-center px-2 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 whitespace-nowrap transition-colors ${
                      mobileTab === 'recordings' ? 'bg-rose-600 text-white' : t.subCard
                    }`}
                  >
                    <Activity className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">הקלטות ניווט</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMobileDisplayMode('planning');
                      setMobilePlanningOverlay('plan-route');
                      exitTrailMarkingMode();
                      setMobileSheetExpanded(true);
                    }}
                    className={`min-w-0 justify-center px-2 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 whitespace-nowrap transition-colors ${t.subCard}`}
                  >
                    <PenTool className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <span className="truncate">תכנון מסלול</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openTrailsPlanningDb()}
                    className={`min-w-0 justify-center px-2 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 whitespace-nowrap transition-colors ${
                      mobileTab === 'planning-db' ? 'bg-emerald-600 text-white' : t.subCard
                    }`}
                  >
                    <FolderTree className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">מאגר תכנון</span>
                  </button>
                </div>

                {mobileTab === 'recordings' ? (
                  <div className="overflow-y-auto flex-1">
                    <Suspense fallback={null}>
                      <NavigationRecordingsPanel
                        theme={theme}
                        hideCloseButton
                        currentUser={currentUser}
                        isAuthBusy={isAuthBusy}
                        onSignInGoogle={handleSignInGoogle}
                        routes={routes}
                        selectedRoute={activeRoute}
                        pois={pois}
                        routeDisplayMode={resolvedRouteDisplay.mode}
                        backgroundRouteIds={pinnedBackgroundRouteIds}
                        unseenSharedCount={unseenSharedCount}
                        onSelectRoute={handleSelectRoute}
                        onStartNavigation={handleStartRouteNavigation}
                        onDeleteRoute={handleDeleteRoute}
                        onShareRoute={handleOpenShareModal}
                        onViewSharedTab={() => setUnseenSharedCount(0)}
                        onDuplicateSharedRoute={handleDuplicateSharedRoute}
                        onDismissSharedRoute={handleDismissSharedRoute}
                        onRenameRoute={handleRenameRoute}
                        onUpdateNotes={handleUpdateRecordingNotes}
                        onChangeRouteColor={handleChangeRouteColor}
                        onToggleBackgroundRoute={handleToggleBackgroundRoute}
                        onReverseRoute={handleReverseRoute}
                        onUseForMapEdit={handleUseRecordingForMapEdit}
                        onSendToPlanningDb={
                          currentUser ? (r) => setSendToPlanningRouteTarget(r) : undefined
                        }
                        onImportRecordingFile={handleImportRecordingFile}
                        onFlyToRoute={handleFlyToRoute}
                        onHoverPoint={handleHoverElevationChart}
                        onSelectPoint={(pt) =>
                          handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                        }
                        onNotify={showToast}
                        onClose={() => setMobileTab('explore')}
                      />
                    </Suspense>
                  </div>
                ) : mobileTab === 'planning-db' && currentUser ? (
                  <div className="overflow-y-auto flex-1">
                    <Suspense fallback={null}>
                      <PlanningTrailDbDrawer
                        theme={theme}
                        isMobile
                        hideCloseButton
                        folders={planningFolders}
                        trails={planningTrails}
                        selectedTrailId={selectedPlanningTrailId}
                        onSelectTrail={handleSelectPlanningTrail}
                        onCreateFolder={handleCreatePlanningFolder}
                        onRenameFolder={handleRenamePlanningFolder}
                        onDeleteFolder={handleDeletePlanningFolder}
                        onUpdateTrailMetadata={handleUpdatePlanningTrailMetadata}
                        onEditTrailOnMap={handleEditPlanningTrailOnMap}
                        onDeleteTrail={handleDeletePlanningTrail}
                        onSendTrailToActiveRoutes={handleSendPlanningTrailToActiveRoutes}
                        onClose={() => setMobileTab('explore')}
                      />
                    </Suspense>
                  </div>
                ) : (
                  <div className="overflow-y-auto flex-1">
                    <Suspense fallback={null}>
                      <ElevationProfileDrawer
                        route={activeRoute}
                        routes={routes}
                        pois={pois}
                        theme={theme}
                        embedded
                        hideCloseButton
                        isNavigating={isNavigatingRoute}
                        routeDisplayMode={resolvedRouteDisplay.mode}
                        backgroundRouteIds={pinnedBackgroundRouteIds}
                        unseenSharedCount={unseenSharedCount}
                        onSelectRoute={handleSelectRoute}
                        onStartNavigation={handleStartRouteNavigation}
                        onStopNavigation={handleStopRouteNavigation}
                        onOpenImporter={currentUser ? handleOpenMapStorage : undefined}
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
                        onSendToPlanningDb={
                          currentUser ? (r) => setSendToPlanningRouteTarget(r) : undefined
                        }
                        onClose={() => setMobileTab('explore')}
                        onHoverPoint={handleHoverElevationChart}
                        onSelectPoint={(pt) =>
                          handleFlyTo(pt.lon, pt.lat, Math.max(14, mapRef.current?.getZoom() || 14))
                        }
                        onFlyToRoute={handleFlyToRoute}
                        onNotify={showToast}
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
                    </Suspense>
                  </div>
                )}
              </div>
            ) : mobileTab === 'map-edit' ? (
              <div dir="rtl" className="p-3.5 space-y-2 max-h-[58vh] overflow-y-auto">
                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setMobileTab('explore');
                      startAddPoiPick();
                    }}
                    className={`w-full text-right p-2.5 rounded-xl border flex items-center gap-2.5 text-xs font-bold ${t.subCard}`}
                  >
                    <Plus className="w-4 h-4 text-sky-500 shrink-0" />
                    <span>הוסף נקודה (POI) על המפה</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openMapEditRoadMode('edit-road')}
                    className={`w-full text-right p-2.5 rounded-xl border flex items-center gap-2.5 text-xs font-bold ${t.subCard}`}
                  >
                    <MapPin className="w-4 h-4 text-rose-500 shrink-0" />
                    <span>עריכת דרך / סימון שבילים</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openMapEditRoadMode('add-road')}
                    className={`w-full text-right p-2.5 rounded-xl border flex items-center gap-2.5 text-xs font-bold ${t.subCard}`}
                  >
                    <PenTool className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span>הוספת דרך חדשה</span>
                  </button>
                  {activeRoute && (
                    <button
                      type="button"
                      onClick={() => {
                        setMobileTab('explore');
                        void handleEditRouteInPlanner(activeRoute);
                      }}
                      className={`w-full text-right p-2.5 rounded-xl border flex items-center gap-2.5 text-xs font-bold ${t.subCard}`}
                    >
                      <RouteIcon className="w-4 h-4 text-blue-500 shrink-0" />
                      <span className="truncate">עריכת מסלול פעיל: {activeRoute.name}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setMobileTab('explore');
                      setIsOsmSyncFullPage(false);
                      setIsOsmSyncOpen(true);
                    }}
                    className={`w-full text-right p-2.5 rounded-xl border flex items-center justify-between gap-2 text-xs font-bold ${t.subCard}`}
                  >
                    <span className="flex items-center gap-2.5">
                      <UploadCloud className="w-4 h-4 text-sky-500 shrink-0" />
                      <span>סנכרון ל-OpenStreetMap</span>
                    </span>
                    {pendingOsmSyncCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-sky-600 text-white text-[10px] font-bold">
                        {pendingOsmSyncCount}
                      </span>
                    )}
                  </button>
                </div>
              </div>
            ) : mobileTab === 'offline' && currentUser ? (
              <Suspense fallback={null}>
                <MapStorageModal
                  isOpen
                  embedded
                  hideCloseButton
                  theme={theme}
                  currentUser={currentUser}
                  onClose={() => setMobileTab('explore')}
                  demInfo={demInfo}
                  osmInfo={osmInfo}
                  onArchivesUpdated={(nextDem, nextOsm) => {
                    setDemInfo(nextDem);
                    if (nextDem) setIsDemUnavailable(false);
                    setOsmInfo(nextOsm);
                  }}
                  onDataBundleUpdated={() => {
                    void refreshOfflineDataConsumers('all');
                  }}
                  onPoisAndRoutesImported={handleImportedData}
                />
              </Suspense>
            ) : null}
            </div>
          </div>
          )}

          {/* Mobile Bottom Menu Bar (Planning Mode: מסלולים, עריכת מפה, Login/Account — pb-safe sits outside min-h so Android/iOS insets never crush the buttons) */}
          <nav
            aria-label="תפריט ניווט תחתון"
            className={`border-t shrink-0 z-40 pb-safe ${t.navBar}`}
          >
            <div className="min-h-[3.75rem] px-2 py-1 grid grid-cols-3 items-stretch gap-1">
              {[
                {
                  id: 'routes' as const,
                  label: 'מסלולים',
                  icon: (
                    <>
                      <RouteIcon className="w-5 h-5 shrink-0" />
                      {unseenSharedCount > 0 && (
                        <span className="absolute -top-1 -right-2 px-1 min-w-[16px] h-4 rounded-full bg-violet-600 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                          {unseenSharedCount}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  id: 'map-edit' as const,
                  label: 'עריכת מפה',
                  icon: <Pencil className="w-5 h-5 shrink-0" />,
                },
              ].map((tab) => {
                const active =
                  (tab.id === 'routes'
                    ? mobileTab === 'routes' ||
                      mobileTab === 'recordings' ||
                      mobileTab === 'planning-db'
                    : mobileTab === tab.id) && !mobilePlanningOverlay;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setMobileTab((prev) =>
                        prev === tab.id ||
                        (tab.id === 'routes' &&
                          (prev === 'recordings' || prev === 'planning-db'))
                          ? 'explore'
                          : tab.id
                      );
                      setMobilePlanningOverlay(null);
                      exitTrailMarkingMode();
                    }}
                    className={`min-w-0 rounded-xl py-1 px-1 flex flex-col items-center justify-center gap-1 text-xs leading-tight font-bold transition-colors active:scale-[0.98] ${
                      active ? 'text-emerald-500 bg-emerald-500/10' : t.hoverRow
                    }`}
                  >
                    <span className="relative w-6 h-6 shrink-0 flex items-center justify-center">
                      {tab.icon}
                    </span>
                    <span className="whitespace-nowrap truncate max-w-full">{tab.label}</span>
                  </button>
                );
              })}

              <button
                type="button"
                data-testid="mobile-bottom-auth-btn"
                disabled={isAuthBusy}
                onClick={() => {
                  setMobileSpeedDial(null);
                  exitTrailMarkingMode();
                  if (currentUser) {
                    setMobileTab('explore');
                    setMobileSheetExpanded(true);
                    setMobilePlanningOverlay((prev) =>
                      prev === 'google-account' ? null : 'google-account'
                    );
                  } else {
                    void handleSignInGoogle();
                  }
                }}
                className={`min-w-0 rounded-xl py-1 px-1 flex flex-col items-center justify-center gap-1 text-xs leading-tight font-bold transition-colors active:scale-[0.98] ${
                  mobilePlanningOverlay === 'google-account'
                    ? 'text-emerald-500 bg-emerald-500/10'
                    : t.hoverRow
                }`}
                title={
                  currentUser
                    ? `${currentUser.displayName || currentUser.email || 'חשבון Google'} (אופליין / התנתקות)`
                    : 'התחבר עם Google'
                }
              >
                <span className="relative w-6 h-6 shrink-0 flex items-center justify-center">
                  {currentUser ? (
                    <>
                      {currentUser.photoURL ? (
                        <img
                          src={currentUser.photoURL}
                          alt={currentUser.displayName || 'Google'}
                          referrerPolicy="no-referrer"
                          className="w-5 h-5 rounded-full object-cover border border-emerald-500/60"
                        />
                      ) : (
                        <span className="w-5 h-5 rounded-full bg-emerald-600 text-white text-[10px] font-bold flex items-center justify-center">
                          {(currentUser.displayName || currentUser.email || 'G').trim().charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span
                        className={`absolute bottom-0 right-0 w-2 h-2 rounded-full border ${
                          theme === 'topo-dark' ? 'border-slate-900' : 'border-white'
                        } ${isOnline ? 'bg-emerald-500' : 'bg-amber-400'}`}
                      />
                    </>
                  ) : (
                    <GoogleGIcon className="w-5 h-5 shrink-0" />
                  )}
                </span>
                <span className="whitespace-nowrap truncate max-w-full">
                  {currentUser ? 'חשבון' : 'התחבר'}
                </span>
              </button>
            </div>
          </nav>
        </>
      )}

      {/* MODE B: NAVIGATING BOTTOM BAR (No bottom 4-tab menu! Just slim telemetry or temporary overlay) */}
      {isMobile && mobileDisplayMode === 'navigating' && (
        <div className={`relative z-30 border-t shadow-2xl shrink-0 pb-safe ${t.panel}`}>
          {mobileNavOverlay && (
            <SheetChromeHeader
              title={MOBILE_SHEET_TITLES[mobileNavOverlay] ?? ''}
              minimized={isMobileSheetMinimized}
              onToggleMinimize={() => setIsMobileSheetMinimized((v) => !v)}
              onClose={() => setMobileNavOverlay(null)}
              onToggleHandle={() => setIsMobileSheetMinimized((v) => !v)}
              showHandlePill
              theme={theme}
            />
          )}
          <div className={mobileNavOverlay && isMobileSheetMinimized ? 'hidden' : 'contents'}>
          {mobileNavOverlay === 'google-account' && currentUser ? (
            <GoogleAccountMenuCard
              currentUser={currentUser}
              isOnline={isOnline}
              isSyncingCloud={isSyncingCloud}
              lastSyncedAt={lastSyncedAt}
              theme={theme}
              embedded
              hideCloseButton
              onSyncNow={handleSyncPendingNow}
              onSignOutGoogle={handleSignOutGoogle}
              onClose={() => setMobileNavOverlay(null)}
              onOpenMapStorage={handleOpenMapStorage}
              isOfflineReady={isOfflineReady}
            />
          ) : mobileNavOverlay === 'user-icon' ? (
            <UserIconPickerSheet
              isOpen
              embedded
              hideCloseButton
              theme={theme}
              preference={userIconPref}
              isOnline={isOnline}
              hasGpsFix={Boolean(userLocation)}
              onLocateOnMap={handleLocateOnceFromPicker}
              onSelectPreference={handleUserIconPreferenceChange}
              onClose={() => setMobileNavOverlay(null)}
            />
          ) : mobileNavOverlay === 'layers' ? (
            <LayerSwitcherSheet
              isOpen
              embedded
              hideCloseButton
              section={mobileLayerSection}
              onSelectSection={setMobileLayerSection}
              onClose={() => setMobileNavOverlay(null)}
              visibility={visibility}
              onChangeVisibility={setVisibility}
              theme={theme}
              onSelectTheme={setTheme}
              mapStyle={mapStyle}
              onSelectMapStyle={setMapStyle}
            />
          ) : mobileNavOverlay === 'add-poi' ? (
            <div className="max-h-[58vh] overflow-y-auto">
              <AddPoiPanel
                theme={theme}
                hideCloseButton
                centerCoords={addPoiCoords ?? cursorCoords}
                currentUser={currentUser}
                isOnline={isOnline}
                firebaseAvailable={AuthService.isAvailable()}
                isAuthBusy={isAuthBusy}
                onSignInGoogle={handleSignInGoogle}
                onClose={() => setMobileNavOverlay(null)}
                onCreated={(created, meta) => {
                  setPois((prev) => [...prev, created]);
                  setSelectedPoi(created);
                  setMobileNavOverlay('poi-mini');
                  const sharedCount = created.sharedWith?.length || 0;
                  showToast(
                    meta?.queuedOffline
                      ? `הנקודה "${created.nameHe}" נשמרה מקומית ותסונכרן בענן כשיתאפשר`
                      : created.visibility === 'private'
                        ? sharedCount > 0
                          ? `הנקודה "${created.nameHe}" נשמרה כפרטית ושותפה עם ${sharedCount} משתמשים`
                          : `הנקודה "${created.nameHe}" נשמרה כפרטית (גלויה רק לך)`
                        : `הנקודה "${created.nameHe}" נשמרה במפה הגלובלית!`
                  );
                }}
              />
            </div>
          ) : mobileNavOverlay === 'poi-mini' && selectedPoi ? (
            <PoiInspectorSheet
              poi={selectedPoi}
              theme={theme}
              referenceCoord={referenceCoord}
              currentUser={currentUser}
              canDeletePoi={canUserDeletePoi(currentUser, selectedPoi)}
              isAuthBusy={isAuthBusy}
              onSignInGoogle={handleSignInGoogle}
              compactNavigating
              hideCloseButton
              onClose={() => setMobileNavOverlay(null)}
              onOpenFullPlanning={() => {
                setMobileNavOverlay(null);
                setMobileDisplayMode('planning');
                setMobileTab('explore');
                setMobilePlanningOverlay('poi');
                setMobileSheetExpanded(true);
              }}
              onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 15.2)}
              onPoiUpdated={handlePoiUpdated}
              onDeletePoi={canUserDeletePoi(currentUser, selectedPoi) ? handleDeletePoi : undefined}
              onSharePoi={handleOpenSharePoiModal}
              onPromoteToGlobal={handlePromotePoiToGlobal}
              onDismissSharedPoi={handleDismissSharedPoi}
              onNotify={showToast}
            />
          ) : mobileNavOverlay === 'record' ? (
            <div className="max-h-[60vh] overflow-y-auto">
              <TrackRecorderPanel
                theme={theme}
                hideCloseButton
                currentUser={currentUser}
                isAuthBusy={isAuthBusy}
                onSignInGoogle={handleSignInGoogle}
                onOpenRecordings={openNavigationRecordings}
                isRecording={isRecordingTrack}
                isPaused={isRecordingPaused}
                elapsedSeconds={recordElapsedSeconds}
                distanceKm={recordedDistanceKm}
                ascentMeters={recordedAscentMeters}
                currentElevation={cursorCoords.ele}
                pointsCount={recordedCoords.length}
                onStartOrResume={handleStartOrResumeRecording}
                onPause={() => setIsRecordingPaused(true)}
                onSaveRoute={() => openRecordingSavePrompt('stop-recording')}
                onDiscard={() => handleDiscardRecordedTrack()}
                onDropWaypoint={() =>
                  openAddPoiPanelAt({
                    lon: cursorCoords.lon,
                    lat: cursorCoords.lat,
                    ele: cursorCoords.ele,
                  })
                }
                onClose={() => setMobileNavOverlay(null)}
              />
            </div>
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
                  onClick={() =>
                    setMobileNavOverlay((prev) => (prev === 'record' ? null : 'record'))
                  }
                  className={`px-2.5 h-9 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                    isRecordingTrack
                      ? 'bg-rose-600 border-rose-500 text-white'
                      : t.pillBtn
                  }`}
                  title="פאנל הקלטת מסלול (שמירה / השהייה)"
                  aria-label="פרטי הקלטה"
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isRecordingTrack && !isRecordingPaused
                        ? 'bg-white animate-pulse'
                        : isRecordingTrack
                          ? 'bg-amber-300'
                          : 'bg-rose-500'
                    }`}
                  />
                  <span dir="ltr" className="tabular-nums">
                    {isRecordingTrack ? formatDuration(recordElapsedSeconds) : 'הקלטה'}
                  </span>
                </button>

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
        </div>
      )}

      {/* Prompt User to Name & Save Navigation Recording on Stop Recording / Stop Navigating */}
      {pendingRecordingSave && (
        <SaveRecordingModal
          isOpen
          theme={theme}
          trigger={pendingRecordingSave.trigger}
          initialName={pendingRecordingSave.defaultName}
          distanceKm={pendingRecordingSave.distanceKm}
          ascentMeters={pendingRecordingSave.ascentMeters}
          durationSeconds={pendingRecordingSave.durationSeconds}
          pointsCount={pendingRecordingSave.coordinates.length}
          startedAt={pendingRecordingSave.startedAt}
          isSaving={isSavingRecording}
          onConfirmSave={handleConfirmSaveRecording}
          onContinueRecording={
            pendingRecordingSave.trigger === 'stop-recording' && isNavigationActive
              ? () => {
                  setPendingRecordingSave(null);
                  setIsRecordingPaused(false);
                  showToast('הקלטת המסלול נמשכת');
                }
              : undefined
          }
          onDiscard={() => {
            setPendingRecordingSave(null);
            handleDiscardRecordedTrack();
          }}
        />
      )}

      {/* Desktop Modal: Offline Maps Manager & KML/GPX Importer (Logged-in users only) */}
      {!isMobile && currentUser && isStorageOpen && (
        <Suspense fallback={null}>
          <MapStorageModal
            isOpen
            onClose={() => setIsStorageOpen(false)}
            theme={theme}
            currentUser={currentUser}
            demInfo={demInfo}
            osmInfo={osmInfo}
            onArchivesUpdated={(nextDem, nextOsm) => {
              setDemInfo(nextDem);
              if (nextDem) setIsDemUnavailable(false);
              setOsmInfo(nextOsm);
            }}
            onDataBundleUpdated={() => {
              void refreshOfflineDataConsumers('all');
            }}
            onPoisAndRoutesImported={handleImportedData}
          />
        </Suspense>
      )}

      {/* Route Sharing Modal (Gmail / Registered Users) */}
      {shareModalRoute && (
        <Suspense fallback={null}>
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
        </Suspense>
      )}

      {/* Send Active Route to Planning Trail DB Modal (Logged-in users only) */}
      {currentUser && Boolean(sendToPlanningRouteTarget) && (
        <Suspense fallback={null}>
          <SendToPlanningDbModal
            isOpen
            theme={theme}
            route={sendToPlanningRouteTarget}
            folders={planningFolders}
            onClose={() => setSendToPlanningRouteTarget(null)}
            onCreateFolder={(name, parentId) =>
              handleCreatePlanningFolder({ name, parentId })
            }
            onConfirm={handleConfirmSendRouteToPlanningDb}
          />
        </Suspense>
      )}

      {/* Private POI Sharing Modal (Gmail / Registered Users) */}
      {shareModalPoi && (
        <Suspense fallback={null}>
          <SharePoiModal
            poi={shareModalPoi}
            theme={theme}
            currentUser={currentUser}
            isOnline={isOnline}
            firebaseAvailable={AuthService.isAvailable()}
            isAuthBusy={isAuthBusy}
            onSignInGoogle={handleSignInGoogle}
            onUpdateRecipients={handleUpdatePoiSharing}
            onClose={() => setShareModalPoiId(null)}
          />
        </Suspense>
      )}

      {/* Live Location Sharing Modal */}
      {isShareLocationModalOpen && (
        <Suspense fallback={null}>
          <ShareLocationModal
          theme={theme}
          currentUser={currentUser}
          isOnline={isOnline}
          firebaseAvailable={AuthService.isAvailable()}
          isAuthBusy={isAuthBusy}
          hasGpsFix={Boolean(userLocation)}
          userLocation={userLocation}
          shareConfig={liveShareConfig}
          peers={livePeers}
          showPeerLocations={visibility.peerLocations !== false}
          showPublicPeerLocations={visibility.publicPeerLocations !== false}
          onToggleShowPeerLocations={(next) =>
            setVisibility((prev) => ({ ...prev, peerLocations: next }))
          }
          onToggleShowPublicPeerLocations={(next) =>
            setVisibility((prev) => ({ ...prev, publicPeerLocations: next }))
          }
          onSignInGoogle={handleSignInGoogle}
          onSaveShareConfig={handleSaveLiveShareConfig}
          onStopSharing={handleStopLiveShare}
          onFocusPeer={(peer) => {
            handleFlyTo(peer.lon, peer.lat, 15);
            setSelectedLivePeer(peer);
          }}
          onClose={() => setIsShareLocationModalOpen(false)}
        />
        </Suspense>
      )}

      {/* Peer Live Location Inspector */}
      {selectedLivePeer && (
        <PeerLocationInspector
          peer={selectedLivePeer}
          userLocation={userLocation}
          theme={theme}
          onCenterPeer={(peer) => handleFlyTo(peer.lon, peer.lat, 15)}
          onNavigateToPeer={handleNavigateToPeer}
          onClose={() => setSelectedLivePeer(null)}
        />
      )}

      {/* OpenStreetMap Community Roads Sync UI (/osm-sync & /osm-callback & in-app modal) */}
      {isHandlingOsmCallback ? (
        <div
          dir="rtl"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/90 text-slate-100 text-sm font-semibold"
        >
          משלים התחברות ל-OpenStreetMap...
        </div>
      ) : (
        isOsmSyncOpen && (
          <Suspense fallback={null}>
            <OsmSyncPanel
              theme={theme}
              currentUser={currentUser}
              firebaseAvailable={AuthService.isAvailable()}
              isAuthBusy={isAuthBusy}
              isOnline={isOnline}
              fullPage={isOsmSyncFullPage}
              initialCallbackError={osmCallbackError}
              onSignInGoogle={handleSignInGoogle}
              onClose={() => {
                setIsOsmSyncOpen(false);
                setIsOsmSyncFullPage(false);
                setOsmCallbackError(null);
                if (typeof window !== 'undefined') {
                  const p = window.location.pathname;
                  const sp = new URLSearchParams(window.location.search);
                  if (p === '/osm-sync' || p === '/osm-callback' || sp.has('osmSync')) {
                    window.history.replaceState({}, '', '/');
                  }
                }
              }}
            />
          </Suspense>
        )
      )}
    </div>
  );
};

export default App;
