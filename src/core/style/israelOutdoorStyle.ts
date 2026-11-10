import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';
import navappLayersRaw from './navappLayer.json';
import { REMOTE_DATA_ORIGIN } from '../dataUrls';
import { SHVIL_ISRAEL_LOWZOOM_LINES } from './shvilIsraelLowZoom';

export interface OutdoorLayerVisibility {
  hillshade: boolean;
  terrain3d: boolean;
  contours: boolean;
  tacticalGrid: boolean;
  militaryZones: boolean;
  hikingTrails: boolean;
  cycleways: boolean;
  offroad4x4: boolean;
  natureParks: boolean;
  fuelAndFlood: boolean;
  pois: boolean;
  poiWater: boolean;
  poiHeritage: boolean;
  poiCampsites: boolean;
  poiOffroad: boolean;
  poiPeaks: boolean;
  poiUser: boolean;
  poiCommunityOffroad?: boolean;
}

export type PoiLayerKey =
  | 'poiWater'
  | 'poiOffroad'
  | 'poiHeritage'
  | 'poiCampsites'
  | 'poiPeaks'
  | 'poiUser';

export const POI_LAYER_KEYS: PoiLayerKey[] = [
  'poiWater',
  'poiOffroad',
  'poiHeritage',
  'poiCampsites',
  'poiPeaks',
  'poiUser',
];

export const DEFAULT_LAYER_VISIBILITY: OutdoorLayerVisibility = {
  hillshade: true,
  terrain3d: false,
  contours: true,
  tacticalGrid: true,
  militaryZones: true,
  hikingTrails: true,
  cycleways: false,
  offroad4x4: true,
  natureParks: true,
  fuelAndFlood: true,
  pois: true,
  poiWater: true,
  poiHeritage: true,
  poiCampsites: true,
  poiOffroad: true,
  poiPeaks: true,
  poiUser: true,
  poiCommunityOffroad: true,
};

export function countActivePoiCategories(visibility: OutdoorLayerVisibility): number {
  return POI_LAYER_KEYS.filter((key) => visibility[key]).length;
}

export function isMasterPoiActive(visibility: OutdoorLayerVisibility): boolean {
  return visibility.pois && countActivePoiCategories(visibility) > 0;
}

export function isOffroadCommunityActive(visibility: OutdoorLayerVisibility): boolean {
  return isMasterPoiActive(visibility) && (visibility.poiCommunityOffroad ?? true);
}

export function buildOffroadPoiLayerFilter(visibility: OutdoorLayerVisibility): any {
  const activeCategories: string[] = [];
  if (visibility.poiWater) activeCategories.push('water');
  if (visibility.poiOffroad) activeCategories.push('offroad');
  if (visibility.poiHeritage) activeCategories.push('heritage');
  if (visibility.poiCampsites) activeCategories.push('campsite');
  if (visibility.poiPeaks) activeCategories.push('peak');
  if (visibility.poiUser ?? true) activeCategories.push('user');
  return ['in', ['get', 'category'], ['literal', activeCategories]];
}

export function enableAllPoiVisibility(
  visibility: OutdoorLayerVisibility
): OutdoorLayerVisibility {
  return {
    ...visibility,
    pois: true,
    poiWater: true,
    poiOffroad: true,
    poiHeritage: true,
    poiCampsites: true,
    poiPeaks: true,
    poiUser: true,
    poiCommunityOffroad: true,
  };
}

export function toggleMasterPoiVisibility(
  visibility: OutdoorLayerVisibility
): OutdoorLayerVisibility {
  if (isMasterPoiActive(visibility)) {
    return { ...visibility, pois: false };
  }
  if (countActivePoiCategories(visibility) === 0) {
    return enableAllPoiVisibility(visibility);
  }
  return { ...visibility, pois: true };
}

export function togglePoiCategoryVisibility(
  visibility: OutdoorLayerVisibility,
  key: PoiLayerKey
): OutdoorLayerVisibility {
  if (!visibility.pois) {
    return {
      ...visibility,
      pois: true,
      poiWater: key === 'poiWater',
      poiOffroad: key === 'poiOffroad',
      poiHeritage: key === 'poiHeritage',
      poiCampsites: key === 'poiCampsites',
      poiPeaks: key === 'poiPeaks',
      poiUser: key === 'poiUser',
    };
  }
  const nextVis: OutdoorLayerVisibility = {
    ...visibility,
    [key]: !visibility[key],
  };
  nextVis.pois = countActivePoiCategories(nextVis) > 0;
  return nextVis;
}

export interface BuildIsraelStyleParams {
  osmProtocolUrl?: string | null;
  demProtocolUrl?: string | null;
  contourProtocolUrl?: string | null;
  visibility: OutdoorLayerVisibility;
  theme?: 'topo-day' | 'topo-dark';
}

const DEFAULT_TRAIL_BROWN = '#AA8166';
const DEFAULT_STEPS_BROWN = '#8E5632';
const CYCLE_PURPLE = '#9333EA';

const RAW_COLOUR_EXPR: any = [
  'let',
  'raw',
  ['coalesce', ['get', 'colour'], ''],
  [
    'let',
    'sep',
    ['index-of', ';', ['var', 'raw']],
    ['case', ['>=', ['var', 'sep'], 0], ['slice', ['var', 'raw'], 0, ['var', 'sep']], ['var', 'raw']],
  ],
];

const SECONDARY_COLOUR_EXPR: any = [
  'let',
  'raw',
  ['coalesce', ['get', 'colour'], ''],
  [
    'let',
    'sep',
    ['index-of', ';', ['var', 'raw']],
    [
      'coalesce',
      ['get', 'colour2'],
      [
        'case',
        ['>=', ['var', 'sep'], 0],
        [
          'let',
          'rest',
          ['slice', ['var', 'raw'], ['+', ['var', 'sep'], 1]],
          [
            'let',
            'sep2',
            ['index-of', ';', ['var', 'rest']],
            [
              'case',
              ['>=', ['var', 'sep2'], 0],
              ['slice', ['var', 'rest'], 0, ['var', 'sep2']],
              ['var', 'rest'],
            ],
          ],
        ],
        ['var', 'raw'],
      ],
    ],
  ],
];

const HAS_SPNI_TRAIL_EXPR: any = [
  'any',
  ['in', RAW_COLOUR_EXPR, ['literal', ['red', 'blue', 'green', 'black', 'purple', 'orange', 'yellow']]],
  ['>=', ['index-of', '_stripe', ['coalesce', ['get', 'osmc_symbol'], '']], 0],
];

const IS_PURPLE_CYCLE_ATTR_EXPR: any = [
  'any',
  ['in', ['coalesce', ['get', 'bicycle'], ''], ['literal', ['designated', 'mtb']]],
  ['all', ['has', 'mtb_scale'], ['!=', ['to-string', ['coalesce', ['get', 'mtb_scale'], '']], '']],
];

const TRACK_GRADE_COLOR_EXPR: any = [
  'case',
  [
    'any',
    ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade5'],
    ['in', ['coalesce', ['get', 'smoothness'], ''], ['literal', ['horrible', 'impassable']]],
  ],
  '#991B1B',
  [
    'any',
    ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade4'],
    ['==', ['coalesce', ['get', 'smoothness'], ''], 'very_bad'],
  ],
  '#C2410C',
  [
    'any',
    ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade3'],
    ['==', ['coalesce', ['get', 'smoothness'], ''], 'bad'],
  ],
  '#B45309',
  ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade2'],
  '#8C6239',
  ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade1'],
  '#64748B',
  DEFAULT_TRAIL_BROWN,
];

const TRACK_LINE_GRADE_COLOR_EXPR: any = [
  'case',
  [
    'any',
    ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade5'],
    ['in', ['coalesce', ['get', 'smoothness'], ''], ['literal', ['horrible', 'impassable']]],
  ],
  'rgba(153, 27, 27, 0.72)',
  [
    'any',
    ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade4'],
    ['==', ['coalesce', ['get', 'smoothness'], ''], 'very_bad'],
  ],
  'rgba(194, 65, 12, 0.70)',
  [
    'any',
    ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade3'],
    ['==', ['coalesce', ['get', 'smoothness'], ''], 'bad'],
  ],
  'rgba(180, 83, 9, 0.65)',
  ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade2'],
  'rgba(140, 98, 57, 0.60)',
  ['==', ['coalesce', ['get', 'tracktype'], ''], 'grade1'],
  'rgba(100, 116, 139, 0.60)',
  'rgba(170, 129, 102, 0.5)',
];

const DEFAULT_TRACK_CASING_COLOR_EXPR: any = [
  'match',
  ['coalesce', ['get', 'tracktype'], ''],
  ['grade1', 'grade2'],
  '#E8D3B2',
  '#F7F4F2',
];

function buildSpniColorMatchExpr(side: 'primary' | 'secondary', fallback: any): any {
  const inputExpr = side === 'secondary' ? SECONDARY_COLOUR_EXPR : RAW_COLOUR_EXPR;
  return [
    'match',
    inputExpr,
    'green',
    '#00C000',
    'blue',
    '#0044FF',
    'red',
    '#FF0000',
    'black',
    '#111111',
    'purple',
    '#800080',
    'orange',
    '#FF8000',
    'yellow',
    '#EAB308',
    [
      'match',
      ['coalesce', ['get', 'osmc_symbol'], ''],
      'green:white:green_stripe',
      '#00C000',
      'blue:white:blue_stripe',
      '#0044FF',
      'red:white:red_stripe',
      '#FF0000',
      'black:white:black_stripe',
      '#111111',
      'purple:white:purple_stripe',
      '#800080',
      'orange:white:orange_stripe',
      '#FF8000',
      'yellow:white:yellow_stripe',
      '#EAB308',
      'orange:orange:white_right:blue_stripe',
      '#FF8000',
      fallback,
    ],
  ];
}

function buildPathLineColorExpr(params: {
  allowSpni: boolean;
  allowPurpleCycle: boolean;
  isDedicatedCycleway: boolean;
  defaultColor: string;
}): any {
  const { allowSpni, allowPurpleCycle, isDedicatedCycleway, defaultColor } = params;
  let fallback: any = defaultColor;
  if (allowPurpleCycle) {
    fallback = isDedicatedCycleway
      ? CYCLE_PURPLE
      : ['case', IS_PURPLE_CYCLE_ATTR_EXPR, CYCLE_PURPLE, defaultColor];
  }
  if (!allowSpni) {
    return fallback;
  }
  return buildSpniColorMatchExpr('primary', fallback);
}

function buildTrackRailColorExpr(params: {
  side: 'right' | 'left';
  allowSpniAndGrades: boolean;
  allowPurpleCycle: boolean;
}): any {
  const { side, allowSpniAndGrades, allowPurpleCycle } = params;
  const baseFallback = allowSpniAndGrades ? TRACK_GRADE_COLOR_EXPR : DEFAULT_TRAIL_BROWN;
  const fallback = allowPurpleCycle
    ? ['case', IS_PURPLE_CYCLE_ATTR_EXPR, CYCLE_PURPLE, baseFallback]
    : baseFallback;
  if (!allowSpniAndGrades) {
    return fallback;
  }
  return buildSpniColorMatchExpr(side === 'left' ? 'secondary' : 'primary', fallback);
}

function buildTrackLineColorExpr(allowGrades: boolean, allowPurpleCycle: boolean): any {
  const base = allowGrades ? TRACK_LINE_GRADE_COLOR_EXPR : 'rgba(170, 129, 102, 0.5)';
  if (!allowPurpleCycle) return base;
  return ['case', IS_PURPLE_CYCLE_ATTR_EXPR, 'rgba(147, 51, 234, 0.72)', base];
}

function buildTrackCasingColorExpr(allowSpniOnTracks: boolean): any {
  if (!allowSpniOnTracks) {
    return DEFAULT_TRACK_CASING_COLOR_EXPR;
  }
  return ['case', HAS_SPNI_TRAIL_EXPR, '#FFFFFF', DEFAULT_TRACK_CASING_COLOR_EXPR];
}

const rawLayerById = new Map<string, any>(
  (navappLayersRaw as any[]).map((l) => [l.id, l])
);

const PATH_REGULAR_LAYER_IDS = new Set([
  'path-path',
  'layer-1-path-path',
  'layer1-path-path',
  'layer2-path-path',
  'path-footway',
  'layer-1-path-footway',
  'layer1-path-footway',
  'layer2-path-footway',
  'layer3-path-footway',
]);

const PATH_CYCLEWAY_LAYER_IDS = new Set([
  'path-cycleway',
  'layer-1-path-cycleway',
  'layer1-path-cycleway',
  'layer2-path-cycleway',
]);

const PATH_STEPS_LINE_IDS = new Set([
  'path-steps-line',
  'layer-1-path-steps-line',
  'layer1-path-steps-line',
  'layer2-path-steps-line',
]);

const PATH_STEPS_IDS = new Set([
  'path-steps',
  'layer-1-path-steps',
  'layer1-path-steps',
  'layer2-path-steps',
]);

const TRACK_CASING_IDS = new Set(['casing-track', 'layer-1-casing-track', 'layer1-casing-track']);
const TRACK_LINE_IDS = new Set(['track-line', 'layer-1-track-line', 'layer1-track-line']);
const TRACK_RIGHT_IDS = new Set([
  'track-right',
  'track-right-grade1-2',
  'track-right-grade4',
  'track-right-grade5',
  'layer-1-track-right',
  'layer-1-track-right-grade1-2',
  'layer-1-track-right-grade4',
  'layer-1-track-right-grade5',
  'layer1-track-right',
  'layer1-track-right-grade1-2',
  'layer1-track-right-grade4',
  'layer1-track-right-grade5',
]);
const TRACK_LEFT_IDS = new Set([
  'track-left',
  'track-left-grade1-2',
  'track-left-grade4',
  'track-left-grade5',
  'layer-1-track-left',
  'layer-1-track-left-grade1-2',
  'layer-1-track-left-grade4',
  'layer-1-track-left-grade5',
  'layer1-track-left',
  'layer1-track-left-grade1-2',
  'layer1-track-left-grade4',
  'layer1-track-left-grade5',
]);

const ROAD_CASING_GRAY_IDS = new Set([
  'casing-minor',
  'layer1-casing-minor',
  'casing-tertiary',
  'layer1-casing-tertiary',
  'casing-secondary',
  'layer1-casing-secondary',
]);
const ROAD_CASING_TUNNEL_IDS = new Set(['layer-1-casing-minor', 'layer-1-casing-tertiary']);
const ROAD_CASING_ZOOM_GUARDED_IDS = new Set(['casing-primary', 'casing-trunk']);

const HAS_LANES_EXPR: any = ['all', ['has', 'lanes'], ['>', ['to-number', ['get', 'lanes'], 0], 0]];
const CLAMPED_LANES_EXPR: any = ['min', 6, ['max', 1, ['to-number', ['get', 'lanes'], 2]]];
const IS_RAMP_EXPR: any = ['==', ['coalesce', ['to-number', ['get', 'ramp'], 0], 0], 1];
const IS_ONEWAY_EXPR: any = ['!=', ['coalesce', ['to-number', ['get', 'oneway'], 0], 0], 0];

const Z16_FILL_WIDTH_MOTORWAY: any = [
  'case',
  HAS_LANES_EXPR,
  ['+', ['*', CLAMPED_LANES_EXPR, 3.6], 2.0],
  IS_RAMP_EXPR,
  5.6,
  9.2,
];

const Z16_FILL_WIDTH_TRUNK: any = [
  'case',
  HAS_LANES_EXPR,
  ['+', ['*', CLAMPED_LANES_EXPR, 3.5], 1.8],
  IS_RAMP_EXPR,
  5.3,
  8.8,
];

const Z16_FILL_WIDTH_PRIMARY: any = [
  'case',
  HAS_LANES_EXPR,
  ['+', ['*', CLAMPED_LANES_EXPR, 3.4], 1.4],
  IS_RAMP_EXPR,
  5.0,
  8.2,
];

const Z16_FILL_WIDTH_SECONDARY: any = [
  'case',
  HAS_LANES_EXPR,
  ['+', ['*', CLAMPED_LANES_EXPR, 3.2], 1.0],
  IS_RAMP_EXPR,
  4.5,
  7.4,
];

const Z16_FILL_WIDTH_TERTIARY: any = [
  'case',
  HAS_LANES_EXPR,
  ['+', ['*', CLAMPED_LANES_EXPR, 3.1], 0.9],
  IS_RAMP_EXPR,
  4.2,
  IS_ONEWAY_EXPR,
  5.5,
  6.8,
];

const Z16_FILL_WIDTH_MINOR: any = [
  'case',
  HAS_LANES_EXPR,
  ['+', ['*', CLAMPED_LANES_EXPR, 3.0], 1.0],
  ['==', ['coalesce', ['get', 'class'], ''], 'service'],
  4.0,
  IS_ONEWAY_EXPR,
  5.2,
  6.5,
];

const Z16_CASING_WIDTH_MOTORWAY: any = ['+', Z16_FILL_WIDTH_MOTORWAY, 3.0];
const Z16_CASING_WIDTH_TRUNK: any = ['+', Z16_FILL_WIDTH_TRUNK, 3.0];
const Z16_CASING_WIDTH_PRIMARY: any = ['+', Z16_FILL_WIDTH_PRIMARY, 3.0];
const Z16_CASING_WIDTH_SECONDARY: any = ['+', Z16_FILL_WIDTH_SECONDARY, 2.6];
const Z16_CASING_WIDTH_TERTIARY: any = ['+', Z16_FILL_WIDTH_TERTIARY, 2.4];
const Z16_CASING_WIDTH_MINOR: any = ['+', Z16_FILL_WIDTH_MINOR, 2.2];

const Z16_BOX_WIDTH_HIGHWAYS: any = [
  'match',
  ['coalesce', ['get', 'class'], ''],
  'motorway',
  ['+', Z16_CASING_WIDTH_MOTORWAY, 4.0],
  'trunk',
  ['+', Z16_CASING_WIDTH_TRUNK, 4.0],
  ['+', Z16_CASING_WIDTH_PRIMARY, 4.0],
];

const Z16_BOX_WIDTH_PAVED_LOCAL: any = [
  'match',
  ['coalesce', ['get', 'class'], ''],
  'secondary',
  ['+', Z16_CASING_WIDTH_SECONDARY, 3.0],
  'tertiary',
  ['+', Z16_CASING_WIDTH_TERTIARY, 3.0],
  ['+', Z16_CASING_WIDTH_MINOR, 3.0],
];

const Z16_BOX_WIDTH_ALL_PAVED: any = [
  'match',
  ['coalesce', ['get', 'class'], ''],
  'motorway',
  ['+', Z16_CASING_WIDTH_MOTORWAY, 4.0],
  'trunk',
  ['+', Z16_CASING_WIDTH_TRUNK, 4.0],
  'primary',
  ['+', Z16_CASING_WIDTH_PRIMARY, 4.0],
  'secondary',
  ['+', Z16_CASING_WIDTH_SECONDARY, 3.0],
  'tertiary',
  ['+', Z16_CASING_WIDTH_TERTIARY, 3.0],
  ['+', Z16_CASING_WIDTH_MINOR, 3.0],
];

const Z16_BOX_WIDTH_TRACK_AND_MINOR: any = [
  'case',
  ['==', ['coalesce', ['get', 'class'], ''], 'track'],
  6.4,
  ['+', Z16_CASING_WIDTH_MINOR, 3.0],
];

function buildProportionalZoomExpr(
  existingValue: any,
  z16Value: any
): any {
  const args: any[] = [];
  if (
    existingValue &&
    typeof existingValue === 'object' &&
    !Array.isArray(existingValue) &&
    Array.isArray(existingValue.stops)
  ) {
    for (const stop of existingValue.stops) {
      if (Array.isArray(stop) && stop.length >= 2 && typeof stop[0] === 'number' && stop[0] < 16) {
        args.push(stop[0], stop[1]);
      }
    }
  }
  const z22Value =
    typeof z16Value === 'number'
      ? Number((z16Value * 64).toFixed(2))
      : ['*', z16Value, 64];
  args.push(16, z16Value, 22, z22Value);
  return ['interpolate', ['exponential', 2], ['zoom'], ...args];
}

function getProportionalLinePaintUpdates(
  layer: LayerSpecification
): Record<string, any> | null {
  if (layer.type !== 'line') return null;
  if (typeof layer.maxzoom === 'number' && layer.maxzoom < 16) return null;

  const id = layer.id;
  const paint: any = (layer as any).paint || {};
  const updates: Record<string, any> = {};

  if (id === 'road-motorway' || id.endsWith('-road-motorway')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_FILL_WIDTH_MOTORWAY);
  } else if (id === 'road-trunk' || id.endsWith('-road-trunk')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_FILL_WIDTH_TRUNK);
  } else if (id === 'road-primary' || id.endsWith('-road-primary')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_FILL_WIDTH_PRIMARY);
  } else if (id === 'road-secondary' || id.endsWith('-road-secondary')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_FILL_WIDTH_SECONDARY);
  } else if (id === 'road-tertiary' || id.endsWith('-road-tertiary')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_FILL_WIDTH_TERTIARY);
  } else if (id === 'road-minor' || id.endsWith('-road-minor')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_FILL_WIDTH_MINOR);
  } else if (id === 'casing-motorway' || id.endsWith('-casing-motorway')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_CASING_WIDTH_MOTORWAY);
  } else if (id === 'casing-trunk' || id.endsWith('-casing-trunk')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_CASING_WIDTH_TRUNK);
  } else if (id === 'casing-primary' || id.endsWith('-casing-primary')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_CASING_WIDTH_PRIMARY);
  } else if (id === 'casing-secondary' || id.endsWith('-casing-secondary')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_CASING_WIDTH_SECONDARY);
  } else if (id === 'casing-tertiary' || id.endsWith('-casing-tertiary')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_CASING_WIDTH_TERTIARY);
  } else if (id === 'casing-minor' || id.endsWith('-casing-minor')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_CASING_WIDTH_MINOR);
  } else if (id === 'casing-minor-colour2') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], [
      '*',
      Z16_CASING_WIDTH_MINOR,
      0.5,
    ]);
    updates['line-offset'] = buildProportionalZoomExpr(paint['line-offset'], [
      '*',
      Z16_CASING_WIDTH_MINOR,
      0.25,
    ]);
  } else if (id === 'layer1-box-highways') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_BOX_WIDTH_HIGHWAYS);
  } else if (id === 'layer1-box-paved') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_BOX_WIDTH_PAVED_LOCAL);
  } else if (id === 'layer2-box-paved') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], Z16_BOX_WIDTH_ALL_PAVED);
  } else if (id === 'layer-1-box-track+minor') {
    updates['line-width'] = buildProportionalZoomExpr(
      paint['line-width'],
      Z16_BOX_WIDTH_TRACK_AND_MINOR
    );
  } else if (id === 'layer1-box-track') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 6.4);
  } else if (TRACK_CASING_IDS.has(id)) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.6);
  } else if (TRACK_RIGHT_IDS.has(id)) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 1.3);
    updates['line-offset'] = buildProportionalZoomExpr(paint['line-offset'], 1.25);
  } else if (TRACK_LEFT_IDS.has(id)) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 1.3);
    updates['line-offset'] = buildProportionalZoomExpr(paint['line-offset'], -1.25);
  } else if (
    id === 'path-path' ||
    id.endsWith('-path-path') ||
    id === 'path-footway' ||
    id.endsWith('-path-footway') ||
    id === 'casing-path' ||
    id.endsWith('-casing-path')
  ) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 2.5);
  } else if (
    id === 'path-cycleway' ||
    id.endsWith('-path-cycleway') ||
    id === 'casing-cycleway' ||
    id.endsWith('-casing-cycleway')
  ) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 3.0);
  } else if (id === 'casing-marked-path' || id === 'casing-marked-cycleway') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.8);
  } else if (id === 'path-steps' || id.endsWith('-path-steps') || id === 'casing-steps' || id.endsWith('-casing-steps')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 3.5);
  } else if (id.endsWith('-box-path')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.5);
  } else if (id.endsWith('-box-cycleway')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 5.0);
  } else if (id.endsWith('-box-steps')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 6.0);
  } else if (id === 'rail-casing' || id.endsWith('-rail-casing')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.5);
  } else if (id === 'rail-dash' || id.endsWith('-rail-dash') || id === 'layer-1-rail-dash-tunnel') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 2.2);
  } else if (id.endsWith('-box-rail')) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 7.0);
  } else if (id === 'trail-israel-secondary-') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 16);
  } else if (id === 'trail-israel-primary+') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 24);
  } else if (
    id === 'trail-regional-line' ||
    id === 'trail-regional-line-purple' ||
    id === 'trail-regional-dash'
  ) {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.0);
    updates['line-offset'] = buildProportionalZoomExpr(
      paint['line-offset'],
      id === 'trail-regional-line-purple' ? -6.0 : 6.0
    );
  } else if (id === 'aeroway-runway') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 45);
  } else if (id === 'aeroway-taxiway') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 22);
  } else if (id === 'casing-pier') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.0);
  } else if (id === 'goods_conveyor' || id === 'goods_conveyor-dash') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 4.0);
  } else if (id === 'goods_conveyor-bridge') {
    updates['line-width'] = buildProportionalZoomExpr(paint['line-width'], 8.0);
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

function getDynamicPaintUpdates(
  layerId: string,
  visibility: OutdoorLayerVisibility
): Record<string, any> | null {
  if (PATH_REGULAR_LAYER_IDS.has(layerId)) {
    return {
      'line-color': buildPathLineColorExpr({
        allowSpni: visibility.hikingTrails,
        allowPurpleCycle: visibility.cycleways,
        isDedicatedCycleway: false,
        defaultColor: DEFAULT_TRAIL_BROWN,
      }),
    };
  }
  if (PATH_CYCLEWAY_LAYER_IDS.has(layerId)) {
    return {
      'line-color': buildPathLineColorExpr({
        allowSpni: visibility.hikingTrails,
        allowPurpleCycle: visibility.cycleways,
        isDedicatedCycleway: true,
        defaultColor: DEFAULT_TRAIL_BROWN,
      }),
    };
  }
  if (PATH_STEPS_LINE_IDS.has(layerId)) {
    return {
      'line-color': buildPathLineColorExpr({
        allowSpni: visibility.hikingTrails,
        allowPurpleCycle: false,
        isDedicatedCycleway: false,
        defaultColor: DEFAULT_TRAIL_BROWN,
      }),
    };
  }
  if (PATH_STEPS_IDS.has(layerId)) {
    return {
      'line-color': buildPathLineColorExpr({
        allowSpni: visibility.hikingTrails,
        allowPurpleCycle: false,
        isDedicatedCycleway: false,
        defaultColor: DEFAULT_STEPS_BROWN,
      }),
    };
  }
  if (TRACK_CASING_IDS.has(layerId)) {
    return {
      'line-color': buildTrackCasingColorExpr(visibility.offroad4x4),
    };
  }
  if (TRACK_LINE_IDS.has(layerId)) {
    return {
      'line-color': buildTrackLineColorExpr(visibility.offroad4x4, visibility.cycleways),
    };
  }
  if (TRACK_RIGHT_IDS.has(layerId)) {
    return {
      'line-color': buildTrackRailColorExpr({
        side: 'right',
        allowSpniAndGrades: visibility.offroad4x4,
        allowPurpleCycle: visibility.cycleways,
      }),
    };
  }
  if (TRACK_LEFT_IDS.has(layerId)) {
    return {
      'line-color': buildTrackRailColorExpr({
        side: 'left',
        allowSpniAndGrades: visibility.offroad4x4,
        allowPurpleCycle: visibility.cycleways,
      }),
    };
  }
  if (ROAD_CASING_GRAY_IDS.has(layerId)) {
    return {
      'line-color': visibility.hikingTrails ? buildSpniColorMatchExpr('primary', '#808080') : '#808080',
    };
  }
  if (ROAD_CASING_TUNNEL_IDS.has(layerId)) {
    return {
      'line-color': visibility.hikingTrails ? buildSpniColorMatchExpr('primary', '#E0E0E0') : '#E0E0E0',
    };
  }
  if (ROAD_CASING_ZOOM_GUARDED_IDS.has(layerId)) {
    return {
      'line-color': visibility.hikingTrails
        ? ['step', ['zoom'], '#808080', 11, buildSpniColorMatchExpr('primary', '#808080')]
        : '#808080',
    };
  }
  if (layerId === 'name-trail-local') {
    const rawPaint = rawLayerById.get('name-trail-local')?.paint || {};
    return {
      'text-color': visibility.hikingTrails ? structuredClone(rawPaint['text-color']) : '#404040',
      'text-halo-color': visibility.hikingTrails
        ? structuredClone(rawPaint['text-halo-color'])
        : 'white',
    };
  }
  if (layerId === 'name-trail-regional') {
    const rawPaint = rawLayerById.get('name-trail-regional')?.paint || {};
    return {
      'text-color': visibility.hikingTrails
        ? structuredClone(rawPaint['text-color'])
        : [
            'match',
            ['coalesce', ['get', 'osmc_symbol'], ''],
            [
              'purple:white:purple_stripe',
              'orange:white:orange_stripe',
              'blue:blue:white_right:purple_stripe',
              'green:green:white_right:blue_stripe',
              'yellow:blue:yellow_stripe',
            ],
            '#404040',
            ['match', ['coalesce', ['get', 'name'], ''], 'שביל ואדיות חיפה', '#404040', 'transparent'],
          ],
      'text-halo-color': visibility.hikingTrails
        ? structuredClone(rawPaint['text-halo-color'])
        : 'white',
    };
  }
  return null;
}

function getVisibilityForIhmLayer(
  layerId: string,
  visibility: OutdoorLayerVisibility
): boolean | null {
  if (layerId === 'Terrain') return visibility.hillshade;
  if (layerId.startsWith('contour-')) return visibility.contours;
  // Military boundary outline stays drawn in default red dashed; only red area fill toggles
  if (layerId === 'area-military') {
    return visibility.militaryZones;
  }
  if (layerId === 'boundary-military') {
    return true;
  }
  if (layerId === 'boundary-park-casing' || layerId === 'boundary-park' || layerId === 'name-park') {
    return visibility.natureParks;
  }
  // Base tracks, paths, cycleways, steps & casings remain visible in default color; switches toggle overlay colors only
  if (
    layerId === 'trail-line-cycleway-purple' ||
    layerId === 'trail-line-track-cycle'
  ) {
    return visibility.cycleways;
  }
  if (layerId === 'trail-line-track') {
    return visibility.offroad4x4;
  }
  if (
    layerId.startsWith('trail-israel-') ||
    layerId.startsWith('trail-regional-') ||
    layerId === 'trail-line-path' ||
    layerId === 'trail-line-cycleway' ||
    layerId === 'trail-line-road' ||
    layerId === 'casing-marked-path' ||
    layerId === 'casing-marked-cycleway' ||
    layerId === 'casing-minor-colour2'
  ) {
    return visibility.hikingTrails;
  }
  if (
    TRACK_CASING_IDS.has(layerId) ||
    TRACK_LINE_IDS.has(layerId) ||
    TRACK_RIGHT_IDS.has(layerId) ||
    TRACK_LEFT_IDS.has(layerId) ||
    layerId === 'track-line-lowzoom' ||
    layerId === 'name-track' ||
    layerId === 'layer1-box-track' ||
    layerId === 'layer-1-box-track+minor' ||
    PATH_REGULAR_LAYER_IDS.has(layerId) ||
    PATH_CYCLEWAY_LAYER_IDS.has(layerId) ||
    PATH_STEPS_LINE_IDS.has(layerId) ||
    PATH_STEPS_IDS.has(layerId) ||
    layerId.includes('casing-path') ||
    layerId.includes('casing-cycleway') ||
    layerId.includes('casing-steps') ||
    layerId.includes('box-path') ||
    layerId.includes('box-cycleway') ||
    layerId.includes('box-steps') ||
    layerId === 'name-path' ||
    layerId === 'name-trail-local' ||
    layerId === 'name-trail-regional'
  ) {
    return true;
  }
  if (layerId === 'name-peak') {
    return visibility.pois && visibility.poiPeaks;
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
    return visibility.pois && visibility.poiWater;
  }
  if (['icon-camp_site', 'icon-picnic'].includes(layerId)) {
    return visibility.pois && visibility.poiCampsites;
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
    return visibility.pois && visibility.poiHeritage;
  }
  if (['icon-tree', 'icon-rail_station', 'icon-fuel', 'icon-parking', 'icon-guidepost'].includes(layerId)) {
    return visibility.pois;
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

  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:5173';

  const defaultOsmUrl = `pmtiles://${REMOTE_DATA_ORIGIN}/data/Israel.osm.pmtiles`;
  const defaultDemUrl = `pmtiles://${REMOTE_DATA_ORIGIN}/data/Israel.dem.pmtiles`;
  const effectiveOsmUrl = osmProtocolUrl || defaultOsmUrl;
  const effectiveDemUrl = demProtocolUrl || defaultDemUrl;

  const sources: StyleSpecification['sources'] = {
    'israel-osm': {
      type: 'vector',
      url: effectiveOsmUrl,
      minzoom: 0,
      maxzoom: 14,
    },
    'israel-shvil-lowzoom': {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'MultiLineString',
              coordinates: SHVIL_ISRAEL_LOWZOOM_LINES,
            },
          },
        ],
      },
    },
  };

  if (effectiveDemUrl) {
    sources['israel-dem'] = {
      type: 'raster-dem',
      url: effectiveDemUrl,
      encoding: 'terrarium',
      tileSize: 256,
      minzoom: 0,
      maxzoom: 14,
    };
    // Dedicated hillshade DEM source (prevents MapLibre v5 terrain vs hillshade source conflict)
    sources['israel-dem-hillshade'] = {
      type: 'raster-dem',
      url: effectiveDemUrl,
      encoding: 'terrarium',
      tileSize: 256,
      minzoom: 0,
      maxzoom: 14,
    };
  }

  if (contourProtocolUrl) {
    sources['israel-contours'] = {
      type: 'vector',
      tiles: [contourProtocolUrl],
      minzoom: 10,
      maxzoom: 14,
    };
  }

  const baseLayers = structuredClone(navappLayersRaw) as LayerSpecification[];
  const layers: LayerSpecification[] = [];

  for (const layer of baseLayers) {
    if (!contourProtocolUrl && (layer as any).source === 'israel-contours') {
      continue;
    }
    if (!effectiveDemUrl && (layer as any).source === 'israel-dem') {
      continue;
    }

    if (layer.id === 'Terrain' && effectiveDemUrl) {
      (layer as any).source = 'israel-dem-hillshade';
    }

    if (layer.id === 'background') {
      if (isDark) {
        layer.paint = { 'background-color': '#0b1015' };
      }
      layers.push(layer);
      continue;
    }

    if (layer.id === 'trail-israel-secondary-' && SHVIL_ISRAEL_LOWZOOM_LINES.length > 0) {
      layers.push({
        id: 'trail-israel-lowzoom',
        type: 'line',
        source: 'israel-shvil-lowzoom',
        minzoom: 7,
        maxzoom: 9,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          visibility: visibility.hikingTrails ? 'visible' : 'none',
        },
        paint: {
          'line-color': '#FFC264',
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 9, 3.5],
        },
      });
    }

    const visToggle = getVisibilityForIhmLayer(layer.id, visibility);
    if (visToggle !== null) {
      layer.layout = {
        ...(layer.layout || {}),
        visibility: visToggle ? 'visible' : 'none',
      } as any;
    }

    const proportionalUpdates = getProportionalLinePaintUpdates(layer);
    const paintUpdates = getDynamicPaintUpdates(layer.id, visibility);
    if (proportionalUpdates || paintUpdates) {
      (layer as any).paint = {
        ...((layer as any).paint || {}),
        ...(proportionalUpdates || {}),
        ...(paintUpdates || {}),
      };
    }

    layers.push(layer);
  }

  // Place Terrain hillshade right after landcover polygons and before contours/trails/roads
  // so 3D shaded relief never washes out contour lines or track/trail colors.
  const terrainIdx = layers.findIndex((l) => l.id === 'Terrain');
  if (terrainIdx !== -1) {
    const [terrainLayer] = layers.splice(terrainIdx, 1);
    const contourInsertIdx = layers.findIndex(
      (l) => l.id === 'contour-line-casing' || l.id === 'contour-line' || l.id === 'water-area'
    );
    if (contourInsertIdx !== -1) {
      layers.splice(contourInsertIdx, 0, terrainLayer);
    } else {
      layers.push(terrainLayer);
    }
  }

  const style: StyleSpecification = {
    version: 8,
    name: 'Israel Hiking Map (Official IHM Vector Style + 10m Contours + Offline Sprites)',
    sprite: `${origin}/assets/sprites/sprite`,
    sources,
    layers,
  };

  if (visibility.terrain3d && effectiveDemUrl) {
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
    if (!map.getLayer(layer.id)) continue;
    const visToggle = getVisibilityForIhmLayer(layer.id, visibility);
    if (visToggle !== null) {
      map.setLayoutProperty(layer.id, 'visibility', visToggle ? 'visible' : 'none');
    }
    if (typeof map.setPaintProperty === 'function') {
      const paintUpdates = getDynamicPaintUpdates(layer.id, visibility);
      if (paintUpdates) {
        for (const [prop, val] of Object.entries(paintUpdates)) {
          map.setPaintProperty(layer.id, prop, val);
        }
      }
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

  if (map.getLayer('israel-offroad-pois-labels')) {
    map.setLayoutProperty(
      'israel-offroad-pois-labels',
      'visibility',
      isOffroadCommunityActive(visibility) ? 'visible' : 'none'
    );
    if (typeof map.setFilter === 'function') {
      map.setFilter('israel-offroad-pois-labels', buildOffroadPoiLayerFilter(visibility));
    }
  }

  if (map.getLayer('israel-pois-labels')) {
    map.setLayoutProperty(
      'israel-pois-labels',
      'visibility',
      isMasterPoiActive(visibility) ? 'visible' : 'none'
    );
  }

  try {
    if (visibility.terrain3d && map.getSource('israel-dem')) {
      const currentTerrain = map.getTerrain?.();
      if (!currentTerrain || currentTerrain.source !== 'israel-dem') {
        map.setTerrain({ source: 'israel-dem', exaggeration: 1.35 });
      }
    } else if (!visibility.terrain3d && map.getTerrain?.()) {
      map.setTerrain(null);
    }
  } catch (err) {
    console.warn('[israelOutdoorStyle] setTerrain error:', err);
  }
}
