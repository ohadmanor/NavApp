import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import type { MapStyleId } from './vectorStyleHelpers';

export const WORLD_BASEMAP_SOURCE_ID = 'world-basemap';
export const WORLD_BASEMAP_SOURCE_LAYER = 'world';
export const WORLD_BASEMAP_ASSET_PATH = '/assets/world-globe/world-basemap.pmtiles';

export const WORLD_OCEAN_LAYER_ID = 'world-ocean';
export const WORLD_GRATICULE_LAYER_ID = 'world-graticule';
export const WORLD_COASTLINE_LAYER_ID = 'world-coastline';
export const WORLD_BORDERS_LAYER_ID = 'world-borders';
export const WORLD_SEA_LABELS_LAYER_ID = 'world-sea-labels';
export const WORLD_CONTINENT_LABELS_LAYER_ID = 'world-continent-labels';
export const WORLD_COUNTRY_LABELS_LAYER_ID = 'world-country-labels';

export const WORLD_GLOBE_LAYER_IDS = new Set<string>([
  WORLD_OCEAN_LAYER_ID,
  WORLD_GRATICULE_LAYER_ID,
  WORLD_COASTLINE_LAYER_ID,
  WORLD_BORDERS_LAYER_ID,
  WORLD_SEA_LABELS_LAYER_ID,
  WORLD_CONTINENT_LABELS_LAYER_ID,
  WORLD_COUNTRY_LABELS_LAYER_ID,
]);

export function buildWorldBasemapSource(worldUrlOrOrigin: string): SourceSpecification {
  const url = worldUrlOrOrigin.startsWith('pmtiles://')
    ? worldUrlOrOrigin
    : `pmtiles://${worldUrlOrOrigin}${WORLD_BASEMAP_ASSET_PATH}`;
  return {
    type: 'vector',
    url,
  };
}

function getOceanFillColorExpression(mapStyle: MapStyleId, isDark: boolean): any {
  if (isDark) {
    return [
      'interpolate',
      ['linear'],
      ['zoom'],
      2,
      '#0F253E',
      7,
      mapStyle === 'govmap' ? '#163250' : '#173354',
    ];
  }
  if (mapStyle === 'ihm') {
    return ['interpolate', ['linear'], ['zoom'], 2, '#82BCE6', 7, '#A6CFEF'];
  }
  if (mapStyle === 'govmap') {
    return ['interpolate', ['linear'], ['zoom'], 2, '#ADD6F2', 7, '#D8ECFA'];
  }
  return ['interpolate', ['linear'], ['zoom'], 2, '#78B9EB', 7, '#9AD0F5'];
}

/**
 * Builds the 100% offline global ocean, graticule, coastline, and international border
 * layers rendered beneath Israel's topographic layers on MapLibre's 3D globe.
 */
export function buildWorldGlobeBaseLayers(params: {
  mapStyle: MapStyleId;
  isDark: boolean;
  visible: boolean;
}): LayerSpecification[] {
  const { mapStyle, isDark, visible } = params;
  const vis = visible ? 'visible' : 'none';
  const coastlineColor = isDark ? '#3B78A8' : mapStyle === 'govmap' ? '#4B8EC2' : '#5EA4D8';

  return [
    {
      id: WORLD_OCEAN_LAYER_ID,
      type: 'fill',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      filter: ['==', ['get', 'kind'], 'ocean'],
      layout: { visibility: vis },
      paint: {
        'fill-color': getOceanFillColorExpression(mapStyle, isDark),
        'fill-antialias': true,
      },
    },
    {
      id: WORLD_GRATICULE_LAYER_ID,
      type: 'line',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      maxzoom: 7,
      filter: ['==', ['get', 'kind'], 'graticule'],
      layout: { visibility: vis },
      paint: {
        'line-color': isDark ? '#38BDF8' : '#0284C7',
        'line-width': ['case', ['==', ['get', 'major'], true], 0.75, 0.4],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.16, 4.5, 0.1, 6.5, 0],
      },
    },
    {
      id: WORLD_COASTLINE_LAYER_ID,
      type: 'line',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      maxzoom: 8,
      filter: ['==', ['get', 'kind'], 'coastline'],
      layout: {
        visibility: vis,
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': coastlineColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.65, 5, 0.9, 8, 1.1],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 5.5, 0.55, 7.5, 0],
      },
    },
    {
      id: WORLD_BORDERS_LAYER_ID,
      type: 'line',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      maxzoom: 8,
      filter: ['==', ['get', 'kind'], 'border'],
      layout: {
        visibility: vis,
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': isDark ? '#475569' : '#94A3B8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 5, 0.9],
        'line-dasharray': [3, 2],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.65, 5.5, 0.55, 7.5, 0],
      },
    },
  ];
}

/**
 * Builds the 100% offline Hebrew/English sea, continent, and country label layers,
 * placed in the symbol stack below Israel's city/place labels so local names retain priority.
 */
export function buildWorldGlobeLabelLayers(params: {
  mapStyle: MapStyleId;
  isDark: boolean;
  visible: boolean;
}): LayerSpecification[] {
  const { mapStyle, isDark, visible } = params;
  const vis = visible ? 'visible' : 'none';
  const landHalo = isDark ? '#0b1015' : '#FFFFFF';
  const oceanLabelHalo = isDark
    ? '#0F253E'
    : mapStyle === 'govmap'
      ? '#ADD6F2'
      : mapStyle === 'ihm'
        ? '#82BCE6'
        : '#78B9EB';
  const textFont = ['bold', 'Arial', 'Tahoma', 'sans-serif'];

  return [
    {
      id: WORLD_SEA_LABELS_LAYER_ID,
      type: 'symbol',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      minzoom: 0,
      maxzoom: 6.5,
      filter: ['==', ['get', 'kind'], 'sea'],
      layout: {
        visibility: vis,
        'text-field': ['coalesce', ['get', 'nameHe'], ['get', 'name']],
        'text-font': textFont,
        'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 4, 12.5],
        'text-max-width': 8,
        'text-padding': 4,
      },
      paint: {
        'text-color': isDark ? '#7DD3FC' : '#0F4C81',
        'text-halo-color': oceanLabelHalo,
        'text-halo-width': 1.6,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.78, 5, 0.7, 6.4, 0],
      },
    },
    {
      id: WORLD_CONTINENT_LABELS_LAYER_ID,
      type: 'symbol',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      minzoom: 0,
      maxzoom: 4,
      filter: ['==', ['get', 'kind'], 'continent'],
      layout: {
        visibility: vis,
        'text-field': ['coalesce', ['get', 'nameHe'], ['get', 'name']],
        'text-font': textFont,
        'text-size': ['interpolate', ['linear'], ['zoom'], 0, 11.5, 3, 14.5],
        'text-max-width': 7,
        'text-padding': 6,
      },
      paint: {
        'text-color': isDark ? '#CBD5E1' : '#475569',
        'text-halo-color': landHalo,
        'text-halo-width': 2.0,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 0, 0.88, 3, 0.78, 3.9, 0],
      },
    },
    {
      id: WORLD_COUNTRY_LABELS_LAYER_ID,
      type: 'symbol',
      source: WORLD_BASEMAP_SOURCE_ID,
      'source-layer': WORLD_BASEMAP_SOURCE_LAYER,
      minzoom: 2,
      maxzoom: 7,
      filter: ['==', ['get', 'kind'], 'country'],
      layout: {
        visibility: vis,
        'text-field': ['coalesce', ['get', 'nameHe'], ['get', 'name']],
        'text-font': textFont,
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 5, 12.5],
        'text-max-width': 6,
        'text-padding': 4,
      },
      paint: {
        'text-color': isDark ? '#E2E8F0' : '#334155',
        'text-halo-color': landHalo,
        'text-halo-width': 2.0,
        'text-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2,
          ['case', ['<=', ['get', 'rank'], 3], 0.9, 0],
          3.5,
          0.9,
          5.5,
          0.85,
          6.8,
          0,
        ],
      },
    },
  ];
}
