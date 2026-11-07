import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  Search,
  Layers,
  HardDrive,
  Compass,
  LocateFixed,
  Route as RouteIcon,
  Wifi,
  WifiOff,
  Mountain,
  PlusCircle,
  Play,
  Square,
  AlertTriangle,
  Crosshair,
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
import type { PoiRecord, SavedRouteRecord, PoiCategory } from './core/db/NavDatabase';
import { PoiInspectorSheet } from './components/pois/PoiInspectorSheet';
import { MapStorageModal } from './components/maps-manager/MapStorageModal';
import { ElevationProfileDrawer } from './components/navigation/ElevationProfileDrawer';
import { LayerSwitcherSheet } from './components/map/LayerSwitcherSheet';

export const App: React.FC = () => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null);
  const mountedStyleKeyRef = useRef<string>('');
  const lastMouseMoveTsRef = useRef<number>(0);

  const [isMapReady, setIsMapReady] = useState(false);
  const [demInfo, setDemInfo] = useState<MountedArchiveInfo | null>(null);
  const [osmInfo, setOsmInfo] = useState<MountedArchiveInfo | null>(null);
  const [visibility, setVisibility] = useState<OutdoorLayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const [theme, setTheme] = useState<'topo-day' | 'topo-dark'>('topo-day');

  const [pois, setPois] = useState<PoiRecord[]>([]);
  const [selectedPoi, setSelectedPoi] = useState<PoiRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PoiRecord[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<PoiCategory | 'all'>('all');

  const [routes, setRoutes] = useState<SavedRouteRecord[]>([]);
  const [activeRoute, setActiveRoute] = useState<SavedRouteRecord | null>(null);

  const [isStorageOpen, setIsStorageOpen] = useState(false);
  const [isLayerSheetOpen, setIsLayerSheetOpen] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [showCenterCrosshair, setShowCenterCrosshair] = useState<boolean>(false);

  const [cursorCoords, setCursorCoords] = useState<{
    lon: number;
    lat: number;
    ele: number | null;
    zoom: number;
  }>({ lon: 34.8134, lat: 30.8281, ele: 390, zoom: 12.6 });

  const [isRecordingTrack, setIsRecordingTrack] = useState(false);
  const [recordedCoords, setRecordedCoords] = useState<Array<[number, number]>>([]);
  const [offRouteWarning, setOffRouteWarning] = useState<number | null>(null);
  const [isAddingPoiMode, setIsAddingPoiMode] = useState(false);

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

  // Update the Military Tactical UTM/ITM Grid GeoJSON on the map
  const updateTacticalGridOnMap = useCallback(
    (map: maplibregl.Map, showGrid: boolean, currentTheme: 'topo-day' | 'topo-dark') => {
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
      } catch {
        // Ignore if style is mid-transition
      }
    },
    []
  );

  // Mount GeoJSON overlays (Tactical Grid + POIs + Active Route + Live Recorded Breadcrumb)
  const syncOverlaySourcesToMap = useCallback(
    (
      map: maplibregl.Map,
      currentPois: PoiRecord[],
      currentVis: OutdoorLayerVisibility,
      currentRoute: SavedRouteRecord | null,
      liveTrack: Array<[number, number]>,
      currentTheme: 'topo-day' | 'topo-dark'
    ) => {
      try {
        if (!map.getStyle()) return;

        // 0. Military Tactical Grid Overlay
        updateTacticalGridOnMap(map, currentVis.tacticalGrid, currentTheme);

        // 1. Active Route Line Overlay
        const routeGeoJson: GeoJSON.FeatureCollection = currentRoute
          ? currentRoute.geojson
          : { type: 'FeatureCollection', features: [] };

        const existingRouteSrc = map.getSource('active-route-src') as maplibregl.GeoJSONSource;
        if (existingRouteSrc) {
          existingRouteSrc.setData(routeGeoJson);
        } else {
          map.addSource('active-route-src', {
            type: 'geojson',
            data: routeGeoJson,
          });
          map.addLayer({
            id: 'active-route-casing',
            type: 'line',
            source: 'active-route-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': '#022c22',
              'line-width': 7,
              'line-opacity': 0.85,
            },
          });
          map.addLayer({
            id: 'active-route-line',
            type: 'line',
            source: 'active-route-src',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
              'line-color': ['coalesce', ['get', 'color'], '#10b981'],
              'line-width': 4,
            },
          });
        }

        // 2. Live GPS Track Breadcrumb Overlay
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

        // 3. Interactive Israel POIs — single unified symbol layer using official IHM sprites
        // (No separate circle/glow layers underneath icons, and strict collision detection so symbols never mix)
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

            // White upward chevron inside the red pass circle
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
          map.addSource('israel-pois-src', {
            type: 'geojson',
            data: poiGeoJson,
          });
          map.addLayer({
            id: 'israel-pois-labels',
            type: 'symbol',
            source: 'israel-pois-src',
            minzoom: 9,
            layout: {
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
                currentTheme === 'topo-dark' ? '#fbbf24' : '#404040',
              ],
              'text-halo-color': currentTheme === 'topo-dark' ? '#0b1015' : 'white',
              'text-halo-width': 3,
              'text-halo-blur': 1.5,
            },
          });
        }

        map.triggerRepaint();
      } catch {
        // Ignore if style is mid-transition
      }
    },
    [updateTacticalGridOnMap]
  );

  // Initialize PMTiles Archives (Israel.dem.pmtiles + Israel.osm.pmtiles), POIs, Routes, and MapLibre
  useEffect(() => {
    let isCancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    async function boot() {
      const [{ dem, osm }, loadedPois, loadedRoutes] = await Promise.all([
        pmtilesRegistry.initializeDefaultIsraelArchives(),
        PoiManager.initializePois(),
        RouteManager.initializeStarterRoutes(),
      ]);

      if (isCancelled) return;

      // Record initial style key BEFORE setting state so the theme/archive effect does not double-load
      mountedStyleKeyRef.current = `${osm.protocolUrl}|${dem.protocolUrl}|topo-day`;

      setDemInfo(dem);
      setOsmInfo(osm);
      setPois(loadedPois);
      setRoutes(loadedRoutes);
      setActiveRoute(null);

      if (!mapContainerRef.current || mapRef.current) return;

      const initialStyle = buildIsraelOutdoorStyle({
        osmProtocolUrl: osm.protocolUrl,
        demProtocolUrl: dem.protocolUrl,
        contourProtocolUrl: dem.contourProtocolUrl,
        visibility: DEFAULT_LAYER_VISIBILITY,
        theme: 'topo-day',
      });

      // Start zoomed into Nahal Aqev / Ein Aqev (z12.6) so 10m & 50m contours + wadis + 4x4 tracks are immediately visible!
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

      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 140, unit: 'metric' }), 'bottom-left');

      // Keep WebGL canvas resized whenever container dimensions change
      if (typeof ResizeObserver !== 'undefined' && mapContainerRef.current) {
        resizeObserver = new ResizeObserver(() => {
          map.resize();
          map.triggerRepaint();
        });
        resizeObserver.observe(mapContainerRef.current);
      }

      map.on('load', async () => {
        if (isCancelled) return;
        setIsMapReady(true);
        syncOverlaySourcesToMap(
          map,
          loadedPois,
          DEFAULT_LAYER_VISIBILITY,
          null,
          [],
          'topo-day'
        );
      });

      map.on('moveend', async () => {
        const c = map.getCenter();
        const lon = Number(c.lng.toFixed(4));
        const lat = Number(c.lat.toFixed(4));
        const zoom = Number(map.getZoom().toFixed(1));
        const ele = await ElevationService.getElevationAt(lon, lat, 11, false);
        setCursorCoords({ lon, lat, ele, zoom });
      });

      // Throttled mousemove (skipped while dragging/panning/zooming and using only cached DEM tiles)
      map.on('mousemove', async (e) => {
        if (map.isMoving() || map.isZooming() || map.isRotating()) return;
        const now = performance.now();
        if (now - lastMouseMoveTsRef.current < 150) return;
        lastMouseMoveTsRef.current = now;

        const lon = Number(e.lngLat.lng.toFixed(4));
        const lat = Number(e.lngLat.lat.toFixed(4));
        const zoom = Number(map.getZoom().toFixed(1));
        const ele = await ElevationService.getElevationAt(lon, lat, 11, true);
        setCursorCoords((prev) => ({
          lon,
          lat,
          ele: ele !== null ? ele : prev.ele,
          zoom,
        }));
      });

      const handlePoiFeatureClick = (e: maplibregl.MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature || !feature.properties) return;
        const p = feature.properties as any;
        setSelectedPoi({
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
        });
      };

      map.on('click', 'israel-pois-labels', handlePoiFeatureClick);

      mapRef.current = map;
    }

    boot();
    return () => {
      isCancelled = true;
      resizeObserver?.disconnect();
    };
  }, [syncOverlaySourcesToMap]);

  // Refresh tactical grid when panning/zooming (depends on isMapReady so it attaches after async boot)
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

  // Handle clicking map in "Add Field POI" mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    const handleMapClickForNewPoi = async (e: maplibregl.MapMouseEvent) => {
      if (!isAddingPoiMode) return;
      const lon = e.lngLat.lng;
      const lat = e.lngLat.lat;
      const ele = await ElevationService.getElevationAt(lon, lat, 12);
      const nameHe = window.prompt('שם נקודת העניין החדשה בשטח (לדוגמה: גב מים מלא / תצפית):');
      if (!nameHe) {
        setIsAddingPoiMode(false);
        return;
      }
      const descHe =
        window.prompt('תיאור / הערת שטח למטיילים:') || 'נקודת עניין שנוספה בשטח (אופליין)';
      const created = await PoiManager.addCustomUserPoi({
        nameHe,
        category: 'water',
        lon,
        lat,
        ele,
        descHe,
      });
      const nextPois = [...pois, created];
      setPois(nextPois);
      setSelectedPoi(created);
      setIsAddingPoiMode(false);
      syncOverlaySourcesToMap(map, nextPois, visibility, activeRoute, recordedCoords, theme);
    };

    map.on('click', handleMapClickForNewPoi);
    return () => {
      map.off('click', handleMapClickForNewPoi);
    };
  }, [isMapReady, isAddingPoiMode, pois, visibility, activeRoute, recordedCoords, theme, syncOverlaySourcesToMap]);

  // Effect A: Only call map.setStyle() when the base theme ('topo-day' | 'topo-dark') or PMTiles archive URL actually changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady || !demInfo || !osmInfo) return;

    const nextStyleKey = `${osmInfo.protocolUrl}|${demInfo.protocolUrl}|${theme}`;
    if (mountedStyleKeyRef.current === nextStyleKey) {
      return;
    }
    mountedStyleKeyRef.current = nextStyleKey;

    const newStyle = buildIsraelOutdoorStyle({
      osmProtocolUrl: osmInfo.protocolUrl,
      demProtocolUrl: demInfo.protocolUrl,
      contourProtocolUrl: demInfo.contourProtocolUrl,
      visibility,
      theme,
    });

    map.setStyle(newStyle, { diff: false });
    const restoreOverlays = () => {
      applyLayerVisibilityToMap(map, visibility);
      syncOverlaySourcesToMap(map, pois, visibility, activeRoute, recordedCoords, theme);
    };
    map.once('style.load', restoreOverlays);
  }, [isMapReady, demInfo, osmInfo, theme, visibility, pois, activeRoute, recordedCoords, syncOverlaySourcesToMap]);

  // Effect B: Instant in-place refresh for layer visibility, POIs, active route, and GPS track (zero setStyle reloads!)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isMapReady) return;

    applyLayerVisibilityToMap(map, visibility);
    syncOverlaySourcesToMap(map, pois, visibility, activeRoute, recordedCoords, theme);
  }, [isMapReady, visibility, pois, activeRoute, recordedCoords, theme, syncOverlaySourcesToMap]);

  // Filter POIs on search query change
  useEffect(() => {
    if (!searchQuery.trim() && categoryFilter === 'all') {
      setSearchResults([]);
      return;
    }
    PoiManager.searchPois(searchQuery, categoryFilter).then((res) => {
      setSearchResults(res.slice(0, 12));
    });
  }, [searchQuery, categoryFilter, pois]);

  const handleFlyTo = (lon: number, lat: number, zoom = 13.8) => {
    mapRef.current?.flyTo({ center: [lon, lat], zoom, essential: true });
  };

  const handleFlyToRoute = (route: SavedRouteRecord) => {
    const pts = route.elevationProfile;
    if (pts.length === 0 || !mapRef.current) return;
    const mid = pts[Math.floor(pts.length / 2)];
    mapRef.current.flyTo({ center: [mid.lon, mid.lat], zoom: 13.0, essential: true });
  };

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
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className =
        'w-4 h-4 rounded-full bg-emerald-400 border-2 border-white shadow-lg pointer-events-none';
      hoverMarkerRef.current = new maplibregl.Marker({ element: el })
        .setLngLat([pt.lon, pt.lat])
        .addTo(map);
    } else {
      hoverMarkerRef.current.setLngLat([pt.lon, pt.lat]);
    }
  };

  const handleLocateMe = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lon = pos.coords.longitude;
        const lat = pos.coords.latitude;
        handleFlyTo(lon, lat, 13.5);
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
      }
    );
  };

  const handleToggleTrackRecording = () => {
    if (isRecordingTrack) {
      setIsRecordingTrack(false);
      return;
    }
    setIsRecordingTrack(true);
    const center = mapRef.current?.getCenter();
    if (center) {
      const next: Array<[number, number]> = [
        ...recordedCoords,
        [Number(center.lng.toFixed(5)), Number(center.lat.toFixed(5))],
      ];
      setRecordedCoords(next);
      if (mapRef.current) {
        syncOverlaySourcesToMap(mapRef.current, pois, visibility, activeRoute, next, theme);
      }
    }
  };

  const milCoords = MilitaryGridService.toMilitaryCoords(cursorCoords.lon, cursorCoords.lat);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 select-none">
      {/* Top Floating Navigation & Search Header */}
      <header className="fixed top-3 left-3 right-3 z-30 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        {/* Left: Brand + Offline Hebrew/English Search + Category Filter Pills */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pointer-events-auto w-full sm:w-auto">
          <div className="relative flex items-center bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl shadow-xl px-3 py-2 gap-2.5 sm:w-96">
            <Compass className="w-5 h-5 text-emerald-400 shrink-0" />
            <input
              type="text"
              dir="auto"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="חפש מעיין, מעלה 4x4, חניון לילה, הר..."
              className="w-full bg-transparent text-xs text-white placeholder-slate-400 focus:outline-none"
            />
            <Search className="w-4 h-4 text-slate-400 shrink-0" />

            {/* Instant Offline Search Dropdown */}
            {searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-2 bg-slate-900/95 backdrop-blur-md border border-slate-700 rounded-2xl shadow-2xl overflow-hidden max-h-80 overflow-y-auto z-50">
                {searchResults.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setSelectedPoi(item);
                      handleFlyTo(item.lon, item.lat, 13.8);
                      setSearchQuery('');
                      setSearchResults([]);
                    }}
                    className="w-full text-right px-3.5 py-2.5 hover:bg-slate-800/90 border-b border-slate-800/70 flex items-center justify-between gap-2 transition-colors"
                  >
                    <span className="text-xs font-mono text-slate-400 shrink-0">
                      {item.ele !== null ? `${item.ele}m` : item.category}
                    </span>
                    <div className="truncate" dir="rtl">
                      <div className="text-xs font-bold text-white truncate">{item.nameHe}</div>
                      <div className="text-xs text-slate-400 truncate">{item.descHe}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quick POI Category Filter Pills */}
          <div className="flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md border border-slate-700/80 rounded-2xl p-1.5 shadow-xl overflow-x-auto">
            {[
              { id: 'all', label: 'הכל', color: 'bg-slate-700 text-white' },
              { id: 'water', label: '💧 מעיינות וגבים', color: 'bg-sky-600 text-white' },
              { id: 'offroad', label: '🚙 מעלות 4x4', color: 'bg-red-600 text-white' },
              { id: 'campsite', label: '⛺ חניוני לילה', color: 'bg-emerald-600 text-white' },
              { id: 'heritage', label: '🏛️ תצפיות ומערות', color: 'bg-amber-600 text-white' },
            ].map((pill) => (
              <button
                key={pill.id}
                onClick={() => {
                  const nextCat = pill.id as PoiCategory | 'all';
                  setCategoryFilter(nextCat);
                  if (nextCat !== 'all') {
                    PoiManager.searchPois(searchQuery, nextCat).then((r) => setSearchResults(r));
                  } else {
                    setSearchResults([]);
                  }
                }}
                className={`px-2.5 py-1 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                  categoryFilter === pill.id
                    ? pill.color
                    : 'text-slate-300 hover:bg-slate-800'
                }`}
              >
                {pill.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Action Toolbar (Offline Badge, Route Selector, PMTiles Manager, Layers) */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Online / Offline Status Pill */}
          <div
            className={`px-3 py-2 rounded-2xl border text-xs font-semibold flex items-center gap-1.5 shadow-xl backdrop-blur-md ${
              isOnline
                ? 'bg-slate-900/90 border-emerald-500/40 text-emerald-300'
                : 'bg-amber-950/90 border-amber-500/60 text-amber-200'
            }`}
          >
            {isOnline ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            <span className="hidden md:inline">
              {isOnline ? 'מפה טופוגרפית 1:50,000 (קווי גובה 10 מ׳)' : 'מצב ניווט שטח 100% אופליין'}
            </span>
          </div>

          {/* Starter / Imported Route Picker */}
          <div className="bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl px-2.5 py-1.5 shadow-xl flex items-center gap-1.5">
            <RouteIcon className="w-4 h-4 text-emerald-400" />
            <select
              value={activeRoute?.id || ''}
              onChange={async (e) => {
                const found = routes.find((r) => r.id === e.target.value) || null;
                if (found) {
                  const refreshed = await RouteManager.refreshRouteElevationsFromDem(found);
                  setActiveRoute(refreshed);
                  handleFlyToRoute(refreshed);
                } else {
                  setActiveRoute(null);
                }
              }}
              className="bg-transparent text-xs font-semibold text-slate-100 focus:outline-none max-w-[170px] truncate"
              dir="rtl"
            >
              <option value="" className="bg-slate-900">ללא מסלול פעיל</option>
              {routes.map((r) => (
                <option key={r.id} value={r.id} className="bg-slate-900">
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          {/* Add Field POI Button */}
          <button
            onClick={() => setIsAddingPoiMode(!isAddingPoiMode)}
            className={`px-3 py-2 rounded-2xl border text-xs font-semibold flex items-center gap-1.5 shadow-xl transition-colors ${
              isAddingPoiMode
                ? 'bg-emerald-600 border-emerald-400 text-white'
                : 'bg-slate-900/95 border-slate-700/80 text-slate-200 hover:bg-slate-800'
            }`}
            title="הוסף נקודת עניין חדשה על המפה"
          >
            <PlusCircle className="w-4 h-4 text-emerald-400" />
            <span className="hidden lg:inline">
              {isAddingPoiMode ? 'לחץ על המפה למיקום...' : 'דווח נקודה'}
            </span>
          </button>

          {/* PMTiles Storage & Update Manager Button */}
          <button
            onClick={() => setIsStorageOpen(true)}
            className="px-3 py-2 rounded-2xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700/80 text-xs font-semibold text-slate-100 flex items-center gap-1.5 shadow-xl transition-colors"
          >
            <HardDrive className="w-4 h-4 text-sky-400" />
            <span className="hidden sm:inline">מפות וייבוא (PMTiles)</span>
          </button>

          {/* Layers & 3D Toggle Button */}
          <button
            onClick={() => setIsLayerSheetOpen(!isLayerSheetOpen)}
            className="px-3 py-2 rounded-2xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700/80 text-xs font-semibold text-slate-100 flex items-center gap-1.5 shadow-xl transition-colors"
          >
            <Layers className="w-4 h-4 text-emerald-400" />
            <span className="hidden sm:inline">שכבות</span>
          </button>
        </div>
      </header>

      {/* Off-Route Deviation Alert Banner */}
      {offRouteWarning !== null && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-40 bg-red-600/95 text-white px-4 py-2 rounded-2xl shadow-2xl flex items-center gap-2 text-xs font-bold animate-bounce">
          <AlertTriangle className="w-4 h-4" />
          <span>התראת סטייה מציר: מרחק מהמסלול {offRouteWarning} מטרים!</span>
        </div>
      )}

      {/* Center Tactical Reticle Crosshair */}
      {showCenterCrosshair && (
        <div className="fixed inset-0 pointer-events-none flex items-center justify-center z-10">
          <div className="relative flex items-center justify-center">
            <div className="w-8 h-[1.5px] bg-red-600/80" />
            <div className="h-8 w-[1.5px] bg-red-600/80 absolute" />
            <div className="w-4 h-4 rounded-full border border-red-600/80 absolute" />
          </div>
        </div>
      )}

      {/* Right-Side Quick Tactical Controls (3D Pitch, Crosshair, GPS Locate, Record Breadcrumb) */}
      <div className="fixed right-4 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-2">
        <button
          onClick={() => {
            const next3d = !visibility.terrain3d;
            setVisibility({ ...visibility, terrain3d: next3d });
            mapRef.current?.easeTo({ pitch: next3d ? 60 : 0, duration: 700 });
          }}
          className={`p-3 rounded-2xl border shadow-xl font-bold text-xs transition-all ${
            visibility.terrain3d
              ? 'bg-emerald-600 border-emerald-400 text-white'
              : 'bg-slate-900/95 border-slate-700/80 text-slate-200 hover:bg-slate-800'
          }`}
          title="Toggle 3D Terrain (Israel.dem.pmtiles)"
        >
          3D
        </button>

        <button
          onClick={() => setShowCenterCrosshair(!showCenterCrosshair)}
          className={`p-3 rounded-2xl border shadow-xl transition-colors ${
            showCenterCrosshair
              ? 'bg-amber-600 border-amber-400 text-white'
              : 'bg-slate-900/95 border-slate-700/80 text-slate-300 hover:bg-slate-800'
          }`}
          title="צלב כוונת מרכז מפה (Tactical Crosshair)"
        >
          <Crosshair className="w-4 h-4" />
        </button>

        <button
          onClick={handleLocateMe}
          className="p-3 rounded-2xl bg-slate-900/95 hover:bg-slate-800 border border-slate-700/80 text-sky-400 shadow-xl transition-colors"
          title="המיקום שלי (GPS)"
        >
          <LocateFixed className="w-4 h-4" />
        </button>

        <button
          onClick={handleToggleTrackRecording}
          className={`p-3 rounded-2xl border shadow-xl transition-colors ${
            isRecordingTrack
              ? 'bg-red-600 border-red-400 text-white animate-pulse'
              : 'bg-slate-900/95 border-slate-700/80 text-emerald-400 hover:bg-slate-800'
          }`}
          title={isRecordingTrack ? 'עצור הקלטת מסלול' : 'הקלט מסלול GPS'}
        >
          {isRecordingTrack ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
      </div>

      {/* Tactical HUD Bar (ITM / 8-Digit Grid / UTM 36N / 10m DEM Altitude) */}
      <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none bg-slate-950/95 backdrop-blur-md border border-amber-500/40 rounded-2xl px-4 py-1.5 text-xs font-mono text-slate-100 flex flex-wrap items-center justify-center gap-3 shadow-2xl">
        <span className="flex items-center gap-1.5 text-emerald-400 font-bold">
          <Mountain className="w-3.5 h-3.5" />
          <span>גובה: {cursorCoords.ele !== null ? `${cursorCoords.ele}m` : '---'} (קווי גובה: 10m)</span>
        </span>
        <span className="text-slate-600">|</span>
        <span className="text-amber-300 font-bold" title="8-Digit Grid Reference (נ.צ. 8 ספרות)">
          נ.צ. {milCoords.idfGrid8Digit}
        </span>
        <span className="text-slate-600 hidden sm:inline">|</span>
        <span className="text-sky-300 hidden sm:inline" title="Israel Transverse Mercator (רשת ישראל החדשה)">
          ITM: {milCoords.itmFormatted}
        </span>
        <span className="text-slate-600 hidden lg:inline">|</span>
        <span className="text-slate-300 hidden lg:inline" title="NATO UTM Zone 36N">
          UTM: {milCoords.utmFormatted}
        </span>
        <span className="text-slate-600">|</span>
        <span className="text-slate-400">z{cursorCoords.zoom}</span>
      </div>

      {/* Fullscreen MapLibre GL JS Canvas */}
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Layer Switcher Floating Sheet */}
      <LayerSwitcherSheet
        isOpen={isLayerSheetOpen}
        onClose={() => setIsLayerSheetOpen(false)}
        visibility={visibility}
        onChangeVisibility={setVisibility}
        theme={theme}
        onToggleTheme={() => setTheme(theme === 'topo-day' ? 'topo-dark' : 'topo-day')}
      />

      {/* Interactive POI Inspector Sheet (Springs, 4x4 Passes, Ruins, Campsites) */}
      <PoiInspectorSheet
        poi={selectedPoi}
        onClose={() => setSelectedPoi(null)}
        onFlyTo={(lon, lat) => handleFlyTo(lon, lat, 14)}
        onPoiUpdated={(updated) => {
          setSelectedPoi(updated);
          setPois((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        }}
      />

      {/* Interactive Route Elevation Profile Drawer */}
      {!selectedPoi && (
        <ElevationProfileDrawer
          route={activeRoute}
          onClose={() => setActiveRoute(null)}
          onHoverPoint={handleHoverElevationChart}
          onFlyToRoute={handleFlyToRoute}
        />
      )}

      {/* Dual PMTiles Storage Manager & KML/GPX Importer Modal */}
      <MapStorageModal
        isOpen={isStorageOpen}
        onClose={() => setIsStorageOpen(false)}
        demInfo={demInfo}
        osmInfo={osmInfo}
        onArchivesUpdated={(nextDem, nextOsm) => {
          setDemInfo(nextDem);
          setOsmInfo(nextOsm);
        }}
        onPoisAndRoutesImported={async () => {
          const [updatedPois, updatedRoutes] = await Promise.all([
            PoiManager.getAllPois(),
            RouteManager.initializeStarterRoutes(),
          ]);
          setPois(updatedPois);
          setRoutes(updatedRoutes);
          if (updatedRoutes.length > 0) {
            setActiveRoute(updatedRoutes[updatedRoutes.length - 1]);
          }
        }}
      />
    </div>
  );
};

export default App;
