import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';
import ihmLayersRaw from './ihmLayers.json';

export interface OutdoorLayerVisibility {
  hillshade: boolean;
  terrain3d: boolean;
  contours: boolean;
  tacticalGrid: boolean;
  militaryZones: boolean;
  hikingTrails: boolean;
  offroad4x4: boolean;
  natureParks: boolean;
  fuelAndFlood: boolean;
  poiWater: boolean;
  poiHeritage: boolean;
  poiCampsites: boolean;
  poiOffroad: boolean;
  poiPeaks: boolean;
}

export const DEFAULT_LAYER_VISIBILITY: OutdoorLayerVisibility = {
  hillshade: true,
  terrain3d: false,
  contours: true,
  tacticalGrid: true,
  militaryZones: true,
  hikingTrails: true,
  offroad4x4: true,
  natureParks: true,
  fuelAndFlood: true,
  poiWater: true,
  poiHeritage: true,
  poiCampsites: true,
  poiOffroad: true,
  poiPeaks: true,
};

export interface BuildIsraelStyleParams {
  osmProtocolUrl: string;
  demProtocolUrl: string;
  contourProtocolUrl?: string;
  visibility: OutdoorLayerVisibility;
  theme?: 'topo-day' | 'topo-dark';
}

function getVisibilityForIhmLayer(
  layerId: string,
  visibility: OutdoorLayerVisibility
): boolean | null {
  if (layerId === 'Terrain') return visibility.hillshade;
  if (layerId.startsWith('contour-')) return visibility.contours;
  if (layerId === 'area-military' || layerId === 'boundary-military') {
    return visibility.militaryZones;
  }
  if (layerId === 'boundary-park-casing' || layerId === 'boundary-park' || layerId === 'name-park') {
    return visibility.natureParks;
  }
  if (layerId.includes('track') || layerId === 'name-track' || layerId.startsWith('ihm-marked-track-')) {
    return visibility.offroad4x4;
  }
  if (
    layerId.includes('path') ||
    layerId.includes('steps') ||
    layerId.startsWith('trail-') ||
    layerId.startsWith('name-trail-') ||
    layerId === 'ihm-marked-int-glow' ||
    layerId.startsWith('ihm-marked-path') ||
    layerId === 'ihm-marked-trail-label'
  ) {
    return visibility.hikingTrails;
  }
  if (layerId === 'name-peak') {
    return visibility.poiPeaks;
  }
  if (
    [
      'name-water-point',
      'water-hole',
      'water-well',
      'water-waterfall',
      'water-tank',
      'water-drinking',
    ].includes(layerId)
  ) {
    return visibility.poiWater;
  }
  if (['icon-camp_site', 'icon-picnic'].includes(layerId)) {
    return visibility.poiCampsites;
  }
  if (
    [
      'icon-viewpoint',
      'icon-cave',
      'icon-ruins',
      'icon-archaeological',
      'icon-memorial',
      'icon-holy',
      'icon-jewish',
      'icon-muslim',
      'icon-christian',
    ].includes(layerId)
  ) {
    return visibility.poiHeritage;
  }
  if (layerId.startsWith('barrier-') || layerId.startsWith('power-')) {
    return visibility.fuelAndFlood;
  }
  return null;
}

/**
 * Generates the authentic Israel Hiking Map (IHM) Vector Style (247 layers + 72 sprite icons)
 * powered 100% offline by:
 *  - C:\dev\NavApp\data\Israel.osm.pmtiles (OpenMapTiles vector layers)
 *  - C:\dev\NavApp\data\Israel.dem.pmtiles (Terrarium 256px DEM -> Hillshade, 3D, 10m/50m Contours)
 *  - C:\dev\NavApp\public\assets\sprites\sprite (Official Israel Hiking Map sprite sheet & patterns)
 */
export function buildIsraelOutdoorStyle(params: BuildIsraelStyleParams): StyleSpecification {
  const {
    osmProtocolUrl,
    demProtocolUrl,
    contourProtocolUrl,
    visibility,
    theme = 'topo-day',
  } = params;

  const isDark = theme === 'topo-dark';

  const sources: StyleSpecification['sources'] = {
    'israel-osm': {
      type: 'vector',
      url: osmProtocolUrl,
      minzoom: 0,
      maxzoom: 14,
    },
    'israel-dem': {
      type: 'raster-dem',
      url: demProtocolUrl,
      encoding: 'terrarium',
      tileSize: 512,
      minzoom: 0,
      maxzoom: 14,
    },
  };

  if (contourProtocolUrl) {
    sources['israel-contours'] = {
      type: 'vector',
      tiles: [contourProtocolUrl],
      minzoom: 10,
      maxzoom: 14,
    };
  }

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';

  sources['israel-trails'] = {
    type: 'geojson',
    data: `${origin}/data/Israel.trails.geojson`,
  };

  const baseLayers = structuredClone(ihmLayersRaw) as LayerSpecification[];
  const layers: LayerSpecification[] = [];

  for (const layer of baseLayers) {
    if (!contourProtocolUrl && (layer as any).source === 'israel-contours') {
      continue;
    }

    if (layer.id === 'background' && isDark) {
      layer.paint = { 'background-color': '#0b1015' };
    }

    const visToggle = getVisibilityForIhmLayer(layer.id, visibility);
    if (visToggle !== null) {
      layer.layout = {
        ...(layer.layout || {}),
        visibility: visToggle ? 'visible' : 'none',
      } as any;
    }

    layers.push(layer);
  }

  const spniColorMatch = (prop: 'colour' | 'colour2') => [
    'match',
    ['coalesce', ['get', prop], ''],
    'red',
    '#FF0000',
    'blue',
    '#0044FF',
    'green',
    '#00B800',
    'black',
    '#111111',
    'purple',
    '#800080',
    'orange',
    '#FF8000',
    '#FF8000',
  ];

  const markedTrailLineLayers: LayerSpecification[] = [
    {
      id: 'ihm-marked-int-glow',
      type: 'line',
      source: 'israel-trails',
      minzoom: 8,
      filter: ['==', ['get', 'isInt'], 1],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: visibility.hikingTrails ? 'visible' : 'none',
      },
      paint: {
        'line-color': '#FFC264',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 7.5, 16, 14] as any,
        'line-opacity': 0.85,
      },
    },
    {
      id: 'ihm-marked-track-casing',
      type: 'line',
      source: 'israel-trails',
      minzoom: 10,
      filter: ['==', ['get', 'kind'], 'track'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: visibility.offroad4x4 ? 'visible' : 'none',
      },
      paint: {
        'line-color': '#FFFFFF',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 13, 6, 16, 10] as any,
        'line-opacity': 0.9,
      },
    },
    {
      id: 'ihm-marked-track-right',
      type: 'line',
      source: 'israel-trails',
      minzoom: 10,
      filter: ['==', ['get', 'kind'], 'track'],
      layout: {
        'line-cap': 'butt',
        'line-join': 'round',
        visibility: visibility.offroad4x4 ? 'visible' : 'none',
      },
      paint: {
        'line-color': spniColorMatch('colour') as any,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.3, 13, 2.0, 16, 3.2] as any,
        'line-offset': ['interpolate', ['linear'], ['zoom'], 10, 1.1, 13, 1.8, 16, 3.0] as any,
        'line-dasharray': [5, 2],
      },
    },
    {
      id: 'ihm-marked-track-left',
      type: 'line',
      source: 'israel-trails',
      minzoom: 10,
      filter: ['==', ['get', 'kind'], 'track'],
      layout: {
        'line-cap': 'butt',
        'line-join': 'round',
        visibility: visibility.offroad4x4 ? 'visible' : 'none',
      },
      paint: {
        'line-color': spniColorMatch('colour2') as any,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.3, 13, 2.0, 16, 3.2] as any,
        'line-offset': ['interpolate', ['linear'], ['zoom'], 10, -1.1, 13, -1.8, 16, -3.0] as any,
        'line-dasharray': [5, 2],
      },
    },
    {
      id: 'ihm-marked-path-casing',
      type: 'line',
      source: 'israel-trails',
      minzoom: 10.5,
      filter: ['!=', ['get', 'kind'], 'track'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: visibility.hikingTrails ? 'visible' : 'none',
      },
      paint: {
        'line-color': '#FFFFFF',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10.5, 3.2, 13, 4.5, 16, 7.5] as any,
        'line-opacity': 0.9,
      },
    },
    {
      id: 'ihm-marked-path',
      type: 'line',
      source: 'israel-trails',
      minzoom: 10.5,
      filter: ['!=', ['get', 'kind'], 'track'],
      layout: {
        'line-cap': 'butt',
        'line-join': 'round',
        visibility: visibility.hikingTrails ? 'visible' : 'none',
      },
      paint: {
        'line-color': spniColorMatch('colour') as any,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10.5, 1.8, 13, 2.5, 16, 4.2] as any,
        'line-dasharray': [3.5, 2],
      },
    },
  ];

  // Insert marked trail line layers right before the first symbol layer so all text/icons sit on top
  const firstSymbolIdx = layers.findIndex((l) => l.type === 'symbol');
  if (firstSymbolIdx !== -1) {
    layers.splice(firstSymbolIdx, 0, ...markedTrailLineLayers);
  } else {
    layers.push(...markedTrailLineLayers);
  }

  // Add Hebrew trail name labels along marked trails
  layers.push({
    id: 'ihm-marked-trail-label',
    type: 'symbol',
    source: 'israel-trails',
    minzoom: 12,
    filter: ['!=', ['coalesce', ['get', 'nameHe'], ''], ''],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 380,
      'text-field': ['get', 'nameHe'],
      'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
      'text-size': 13,
      'text-offset': [0, -0.8],
      visibility: visibility.hikingTrails ? 'visible' : 'none',
    },
    paint: {
      'text-color': spniColorMatch('colour') as any,
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 3,
      'text-halo-blur': 1,
    },
  });

  const style: StyleSpecification = {
    version: 8,
    name: 'Israel Hiking Map (Official IHM Vector Style + 10m Contours + Offline Sprites)',
    sprite: `${origin}/assets/sprites/sprite`,
    sources,
    layers,
  };

  if (visibility.terrain3d) {
    style.terrain = {
      source: 'israel-dem',
      exaggeration: 1.35,
    };
  }

  return style;
}

/**
 * Updates layer visibility and 3D terrain in-place on an active MapLibre instance
 * without calling map.setStyle(), avoiding full tile reloads or canvas flashing.
 */
export function applyLayerVisibilityToMap(
  map: any,
  visibility: OutdoorLayerVisibility
): void {
  const style = map.getStyle?.();
  if (!style || !Array.isArray(style.layers)) return;

  for (const layer of style.layers) {
    const visToggle = getVisibilityForIhmLayer(layer.id, visibility);
    if (visToggle !== null && map.getLayer(layer.id)) {
      map.setLayoutProperty(layer.id, 'visibility', visToggle ? 'visible' : 'none');
    }
  }

  for (const gridLayerId of ['tactical-grid-minor', 'tactical-grid-major', 'tactical-grid-labels']) {
    if (map.getLayer(gridLayerId)) {
      map.setLayoutProperty(
        gridLayerId,
        'visibility',
        visibility.tacticalGrid ? 'visible' : 'none'
      );
    }
  }

  try {
    if (visibility.terrain3d && map.getSource('israel-dem')) {
      map.setTerrain({ source: 'israel-dem', exaggeration: 1.35 });
    } else if (!visibility.terrain3d && map.getTerrain?.()) {
      map.setTerrain(null);
    }
  } catch {
    // Ignore if style is still initializing
  }
}
