import type { LayerSpecification } from 'maplibre-gl';
import navappLayersRaw from './navappLayer.json';

export const COMMUNITY_ROADS_SOURCE_ID = 'community-roads-src';
export const COMMUNITY_ROADS_LABEL_LAYER_ID = 'community-roads-label';

const COMMUNITY_ROADS_LAYER_ID_PREFIX = 'community-roads-';

/**
 * Base-map layers that can never draw a community road: bridge/tunnel variants (community roads
 * carry no `brunnel`), non-highway transport, and trail networks driven by OSM relation tags.
 */
const NEVER_DRAWS_A_COMMUNITY_ROAD =
  /^(layer-?\d|casing-pier$|rail-|cable_car$|goods_conveyor|trail-israel-|trail-regional-)/;

/**
 * The base-map highway line layers, in draw order. Community roads are drawn by one copy of each
 * (see `buildCommunityRoadLineLayers`), so an added or edited road looks exactly like the base map.
 */
export const COMMUNITY_ROAD_BASE_LAYER_IDS: readonly string[] = (
  navappLayersRaw as Array<{ id: string; type: string; 'source-layer'?: string }>
)
  .filter(
    (layer) =>
      layer['source-layer'] === 'transportation' &&
      layer.type === 'line' &&
      !NEVER_DRAWS_A_COMMUNITY_ROAD.test(layer.id)
  )
  .map((layer) => layer.id);

const COMMUNITY_ROAD_LAYER_ID_BY_BASE_ID = new Map<string, string>(
  COMMUNITY_ROAD_BASE_LAYER_IDS.map((baseId) => [
    baseId,
    `${COMMUNITY_ROADS_LAYER_ID_PREFIX}${baseId}`,
  ])
);
const BASE_LAYER_ID_BY_COMMUNITY_ROAD_LAYER_ID = new Map<string, string>(
  Array.from(COMMUNITY_ROAD_LAYER_ID_BY_BASE_ID, ([baseId, layerId]) => [layerId, baseId])
);

/** Line layers that draw community roads: one per base highway layer, e.g. `community-roads-casing-track`. */
export const COMMUNITY_ROADS_LINE_LAYER_IDS: readonly string[] = Array.from(
  COMMUNITY_ROAD_LAYER_ID_BY_BASE_ID.values()
);

export const COMMUNITY_ROADS_LAYER_IDS: readonly string[] = [
  ...COMMUNITY_ROADS_LINE_LAYER_IDS,
  COMMUNITY_ROADS_LABEL_LAYER_ID,
];

export const COMMUNITY_TRAILS_SOURCE_ID = 'community-trails-src';
export const COMMUNITY_TRAILS_LAYER_IDS = [
  'community-trails-casing',
  'community-trails-track-right',
  'community-trails-track-left',
  'community-trails-path-line',
  'community-trails-line',
  'community-trails-stale',
  'community-trails-number',
] as const;

/** The base-map layer a community-road line layer copies, or undefined for any other layer. */
export function getCommunityRoadBaseLayerId(layerId: string): string | undefined {
  return BASE_LAYER_ID_BY_COMMUNITY_ROAD_LAYER_ID.get(layerId);
}

export interface CommunityRoadLineLayer {
  /** The base-map layer this layer copies; it belongs directly above that layer in the stack. */
  baseLayerId: string;
  layer: LayerSpecification;
}

/**
 * Builds the line layers that draw community roads & OSM road overrides: a copy of each base highway
 * layer (filter, zoom range, paint and layout as currently styled) bound to the community roads source.
 * Pass the base layers after theme/visibility styling so the copies inherit it.
 */
export function buildCommunityRoadLineLayers(
  styledBaseLayers: readonly LayerSpecification[]
): CommunityRoadLineLayer[] {
  const result: CommunityRoadLineLayer[] = [];
  for (const baseLayer of styledBaseLayers) {
    const id = COMMUNITY_ROAD_LAYER_ID_BY_BASE_ID.get(baseLayer.id);
    if (!id || baseLayer.type !== 'line') continue;
    const { 'source-layer': _sourceLayer, ...copy } = structuredClone(
      baseLayer
    ) as LayerSpecification & { 'source-layer'?: string };
    result.push({
      baseLayerId: baseLayer.id,
      layer: { ...copy, id, source: COMMUNITY_ROADS_SOURCE_ID } as LayerSpecification,
    });
  }
  return result;
}

/**
 * Inserts the community-road line layers into a style's layer list, each directly above the base
 * layer it copies, so casings, fills and junctions stack exactly as they do for base-map roads.
 */
export function insertCommunityRoadLineLayers(layers: LayerSpecification[]): void {
  const copyByBaseId = new Map(
    buildCommunityRoadLineLayers(layers).map((entry) => [entry.baseLayerId, entry.layer])
  );
  for (let i = layers.length - 1; i >= 0; i--) {
    const copy = copyByBaseId.get(layers[i].id);
    if (copy) layers.splice(i + 1, 0, copy);
  }
}

/**
 * Builds the name / trail-number label layer for community roads & OSM road overrides.
 */
export function buildCommunityRoadLabelLayer(
  theme: 'topo-day' | 'topo-dark',
  visible: boolean
): LayerSpecification {
  return {
    id: COMMUNITY_ROADS_LABEL_LAYER_ID,
    type: 'symbol',
    source: COMMUNITY_ROADS_SOURCE_ID,
    minzoom: 13,
    filter: [
      'any',
      ['!=', ['coalesce', ['get', 'name'], ''], ''],
      ['!=', ['coalesce', ['get', 'trailNumber'], ''], ''],
      ['!=', ['coalesce', ['get', 'trailName'], ''], ''],
    ],
    layout: {
      visibility: visible ? 'visible' : 'none',
      'symbol-placement': 'line',
      'text-field': [
        'case',
        ['!=', ['coalesce', ['get', 'trailNumber'], ''], ''],
        ['get', 'trailNumber'],
        ['!=', ['coalesce', ['get', 'trailName'], ''], ''],
        ['get', 'trailName'],
        ['get', 'name'],
      ],
      'text-size': 11,
      'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
    },
    paint: {
      'text-color': [
        'match',
        ['coalesce', ['get', 'trailColor'], ''],
        '#dc2626',
        '#FF0000',
        '#2563eb',
        '#0044FF',
        '#16a34a',
        '#00C000',
        '#334155',
        '#111111',
        theme === 'topo-dark' ? '#f8fafc' : '#1e293b',
      ],
      'text-halo-color': theme === 'topo-dark' ? '#0f172a' : '#ffffff',
      'text-halo-width': 2,
    },
  };
}

/** The slice of a MapLibre map needed to add layers to a live style. */
interface LayerHostMap {
  getStyle(): { layers?: LayerSpecification[] } | undefined;
  getLayer(id: string): unknown;
  addLayer(layer: any, beforeId?: string): unknown;
}

/**
 * Adds any community-road layers missing from a live map. The built style normally ships with them;
 * this covers a style that was built without a community roads source.
 */
export function ensureCommunityRoadLayersOnMap(
  map: LayerHostMap,
  theme: 'topo-day' | 'topo-dark',
  labelsVisible: boolean
): void {
  // Cheap check first: serializing the live style is costly and this runs on every road-draft change
  const hasAllLayers =
    Boolean(map.getLayer(COMMUNITY_ROADS_LABEL_LAYER_ID)) &&
    COMMUNITY_ROAD_BASE_LAYER_IDS.every(
      (baseId) =>
        !map.getLayer(baseId) || map.getLayer(COMMUNITY_ROAD_LAYER_ID_BY_BASE_ID.get(baseId)!)
    );
  if (hasAllLayers) return;

  const styleLayers = map.getStyle()?.layers;
  if (!Array.isArray(styleLayers)) return;
  const order = styleLayers.map((layer) => layer.id);
  for (const { baseLayerId, layer } of buildCommunityRoadLineLayers(styleLayers)) {
    if (map.getLayer(layer.id)) continue;
    const aboveBaseId = order[order.indexOf(baseLayerId) + 1];
    map.addLayer(layer, aboveBaseId && map.getLayer(aboveBaseId) ? aboveBaseId : undefined);
  }
  if (!map.getLayer(COMMUNITY_ROADS_LABEL_LAYER_ID)) {
    map.addLayer(buildCommunityRoadLabelLayer(theme, labelsVisible));
  }
}

/**
 * Builds the MapLibre ground and symbol layers for community trail annotations.
 */
export function buildCommunityTrailLayerSpecs(
  theme: 'topo-day' | 'topo-dark',
  visible: boolean
): { groundLayers: LayerSpecification[]; symbolLayers: LayerSpecification[] } {
  const vis = visible ? 'visible' : 'none';
  const spniMapColorExpr: any = [
    'match',
    ['coalesce', ['get', 'color'], ''],
    '#dc2626',
    '#FF0000',
    '#ea580c',
    '#FF8000',
    '#ca8a04',
    '#EAB308',
    '#16a34a',
    '#00C000',
    '#2563eb',
    '#0044FF',
    '#7c3aed',
    '#800080',
    '#334155',
    '#111111',
    ['coalesce', ['get', 'color'], '#FF0000'],
  ];

  const isTrackOrRoadFilter: any = [
    'all',
    ['!=', ['coalesce', ['get', 'stale'], false], true],
    ['!=', ['get', 'trailId'], 'selection-preview'],
    ['!', ['in', ['coalesce', ['get', 'highwayClass'], ''], ['literal', ['path', 'footway']]]],
  ];

  const groundLayers: LayerSpecification[] = [
    {
      id: 'community-trails-casing',
      type: 'line',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: isTrackOrRoadFilter,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': theme === 'topo-dark' ? '#1e293b' : '#FFFFFF',
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 3.5, 13, 5, 16, 8, 22, 32],
      },
    },
    {
      id: 'community-trails-track-right',
      type: 'line',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: isTrackOrRoadFilter,
      layout: { 'line-cap': 'round', 'line-join': 'miter', visibility: vis },
      paint: {
        'line-color': spniMapColorExpr,
        'line-dasharray': [8, 2.5],
        'line-offset': ['interpolate', ['exponential', 2], ['zoom'], 12, 1, 16, 2, 22, 8],
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 1, 16, 2.5, 22, 10],
      },
    },
    {
      id: 'community-trails-track-left',
      type: 'line',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: isTrackOrRoadFilter,
      layout: { 'line-cap': 'round', 'line-join': 'miter', visibility: vis },
      paint: {
        'line-color': spniMapColorExpr,
        'line-dasharray': [8, 2.5],
        'line-offset': ['interpolate', ['exponential', 2], ['zoom'], 12, -1, 16, -2, 22, -8],
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, 1, 16, 2.5, 22, 10],
      },
    },
    {
      id: 'community-trails-path-line',
      type: 'line',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: [
        'all',
        ['!=', ['coalesce', ['get', 'stale'], false], true],
        ['!=', ['get', 'trailId'], 'selection-preview'],
        ['in', ['coalesce', ['get', 'highwayClass'], ''], ['literal', ['path', 'footway']]],
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': spniMapColorExpr,
        'line-dasharray': [4, 3],
        'line-width': ['interpolate', ['exponential', 2], ['zoom'], 11, 1.8, 13, 2, 16, 4, 22, 16],
      },
    },
    {
      id: 'community-trails-line',
      type: 'line',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: ['==', ['get', 'trailId'], 'selection-preview'],
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
      paint: {
        'line-color': '#facc15',
        'line-width': 5,
        'line-opacity': 0.9,
      },
    },
    {
      id: 'community-trails-stale',
      type: 'line',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: ['==', ['get', 'stale'], true],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: vis,
      },
      paint: {
        'line-color': '#f59e0b',
        'line-width': 3.5,
        'line-opacity': 0.9,
        'line-dasharray': [2, 1],
      },
    },
  ];

  const symbolLayers: LayerSpecification[] = [
    {
      id: 'community-trails-number',
      type: 'symbol',
      source: COMMUNITY_TRAILS_SOURCE_ID,
      filter: ['!=', ['get', 'trailId'], 'selection-preview'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'text-offset': [0, -1],
        'text-field': [
          'case',
          ['!=', ['coalesce', ['get', 'name'], ''], ''],
          ['concat', ['get', 'name'], ' (', ['coalesce', ['get', 'number'], ''], ')'],
          ['coalesce', ['get', 'number'], ''],
        ],
        'text-size': 12,
        'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
        'text-allow-overlap': false,
        visibility: vis,
      },
      paint: {
        'text-color': spniMapColorExpr,
        'text-halo-color': theme === 'topo-dark' ? '#0B1015' : '#FFFFFF',
        'text-halo-width': 2.5,
        'text-halo-blur': 1,
      },
    },
  ];

  return { groundLayers, symbolLayers };
}
