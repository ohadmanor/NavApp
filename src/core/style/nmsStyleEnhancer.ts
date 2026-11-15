import type { LayerSpecification } from 'maplibre-gl';
import type { OutdoorLayerVisibility } from './israelOutdoorStyle';

export type MapStyleId = 'ihm' | 'nms';

const NMS_DAY_BG = '#FFFFFF';
const NMS_DARK_BG = '#0b1015';

interface RoadPaletteEntry {
  fillDay: string;
  fillDark: string;
  casingDay: string;
  casingDark: string;
}

const NMS_ROAD_PALETTE: Record<string, RoadPaletteEntry> = {
  motorway: {
    fillDay: '#E56B4E',
    fillDark: '#B44B34',
    casingDay: '#9A3412',
    casingDark: '#5C2214',
  },
  trunk: {
    fillDay: '#F29E4C',
    fillDark: '#B86D28',
    casingDay: '#9A5512',
    casingDark: '#5C340E',
  },
  primary: {
    fillDay: '#F5C756',
    fillDark: '#A68224',
    casingDay: '#8F6A10',
    casingDark: '#54400E',
  },
  secondary: {
    fillDay: '#FCE48B',
    fillDark: '#786933',
    casingDay: '#786855',
    casingDark: '#403828',
  },
  tertiary: {
    fillDay: '#FFFDF5',
    fillDark: '#475569',
    casingDay: '#78716C',
    casingDark: '#1E293B',
  },
  minor: {
    fillDay: '#FFFFFF',
    fillDark: '#334155',
    casingDay: '#8E8A82',
    casingDark: '#1E293B',
  },
};

function getRoadClassFromLayerId(layerId: string): keyof typeof NMS_ROAD_PALETTE | null {
  for (const roadClass of Object.keys(NMS_ROAD_PALETTE)) {
    if (
      layerId === `road-${roadClass}` ||
      layerId.endsWith(`-road-${roadClass}`) ||
      layerId === `casing-${roadClass}` ||
      layerId.endsWith(`-casing-${roadClass}`)
    ) {
      return roadClass;
    }
  }
  return null;
}

function replaceGrayFallbackInExpr(expr: any, replacement: string): any {
  if (expr === '#808080' || expr === '#E0E0E0') {
    return replacement;
  }
  if (Array.isArray(expr)) {
    return expr.map((item) => replaceGrayFallbackInExpr(item, replacement));
  }
  return expr;
}

const VECTOR_POI_NMS_MINZOOM: Record<string, number> = {
  'name-peak': 11.5,
  'icon-viewpoint': 13,
  'icon-cave': 13,
  'icon-ruins': 13,
  'icon-archaeological': 13,
  'icon-camp_site': 13,
  'icon-picnic': 13,
  'name-water-point': 13.5,
  'water-hole': 13.5,
  'water-well': 13.5,
  'water-waterfall': 13.5,
  'water-tank': 14,
  'water-drinking': 14,
  'icon-fuel': 14,
  'icon-rail_station': 14,
  'icon-memorial': 14,
  'icon-holy': 14,
  'icon-jewish': 14,
  'icon-muslim': 14,
  'icon-christian': 14,
  'icon-guidepost': 14,
  'icon-tree': 15,
  'icon-quarry': 15,
  'icon-cemerery': 15,
  'icon-parking': 16,
};

const NMS_POI_ICON_SIZE_PRIMARY_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11.5,
  0.36,
  13,
  0.46,
  14,
  0.56,
  15.5,
  0.68,
  17.5,
  0.78,
];

const NMS_POI_ICON_SIZE_SECONDARY_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11.5,
  0.34,
  13,
  0.44,
  14,
  0.54,
  15.5,
  0.64,
  17.5,
  0.74,
];

const SECONDARY_VECTOR_POI_IDS = new Set<string>([
  'name-peak',
  'icon-picnic',
  'icon-tree',
  'icon-quarry',
  'icon-cemerery',
  'icon-guidepost',
  'icon-parking',
  'water-tank',
  'water-drinking',
]);

const NMS_POI_TEXT_SIZE_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11.5,
  9.5,
  13.5,
  10.8,
  15.5,
  12,
  17.5,
  12.8,
];

const NMS_POI_TEXT_OFFSET_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  12,
  ['literal', [0, 0.62]],
  14.5,
  ['literal', [0, 0.76]],
  17.5,
  ['literal', [0, 0.92]],
];

const NMS_SHIELD_TEXT_SIZE_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6,
  9.5,
  10,
  10.5,
  14,
  11.5,
  17,
  12.5,
];

/**
 * Applies the NavApp Map Style (NMS) visual enhancements onto a cloned layer stack
 * without mutating the classic IHM style.
 *
 * Focuses on:
 * 1. Cohesive cartographic color palette (warm parchment day / tactical dark,
 *    harmonized highway hierarchy that never clashes with SPNI trail colors,
 *    refined landcover, water, and contour tones).
 * 2. Zoom-progressive symbol hierarchy (tiered minzooms, interpolated icon & text
 *    sizes, balanced padding, optional text fallback, and crisp halos).
 */
export function applyNmsStyleEnhancements(
  layers: LayerSpecification[],
  theme: 'topo-day' | 'topo-dark',
  visibility: OutdoorLayerVisibility
): void {
  const isDark = theme === 'topo-dark';
  const haloColor = isDark ? NMS_DARK_BG : NMS_DAY_BG;
  const primaryTextColor = isDark ? '#E2E8F0' : '#1E293B';
  const secondaryTextColor = isDark ? '#CBD5E1' : '#334155';
  const waterTextColor = isDark ? '#7DD3FC' : '#0F4C81';
  const parkTextColor = isDark ? '#86EFAC' : '#166534';

  for (const rawLayer of layers) {
    const layer = rawLayer as any;
    const id: string = layer.id;
    const paint: Record<string, any> = layer.paint || (layer.paint = {});
    const layout: Record<string, any> = layer.layout || (layer.layout = {});

    // 1. Background & Landcover / Landuse / Water / Terrain
    if (id === 'background') {
      paint['background-color'] = isDark ? NMS_DARK_BG : NMS_DAY_BG;
      continue;
    }

    if (id === 'area-residential') {
      paint['fill-color'] = isDark ? '#171F2A' : '#EAE5D9';
      paint['fill-outline-color'] = isDark
        ? 'rgba(148, 163, 184, 0.14)'
        : 'rgba(140, 128, 108, 0.22)';
      continue;
    }

    if (id === 'area-landcover-low') {
      paint['fill-color'] = [
        'match',
        ['get', 'class'],
        'sand',
        ['match', ['get', 'subclass'], 'beach', isDark ? '#282317' : '#F4EBC4', 'transparent'],
        'wood',
        isDark ? '#16261B' : '#CDE2B0',
        'grass',
        isDark ? '#19241B' : '#E1EECA',
        'transparent',
      ];
      continue;
    }

    if (id === 'area-cemetery') {
      paint['fill-color'] = isDark ? '#1A261E' : '#D7E4C8';
      continue;
    }

    if (id === 'area-quarry') {
      paint['fill-color'] = isDark ? '#22272E' : '#DDD7CA';
      continue;
    }

    if (id === 'area-park') {
      paint['fill-color'] = isDark ? '#22C55E' : '#16A34A';
      paint['fill-opacity'] = isDark ? 0.1 : 0.11;
      continue;
    }

    if (id === 'area-military') {
      paint['fill-color'] = isDark ? '#EF4444' : '#DC2626';
      paint['fill-opacity'] = ['step', ['zoom'], 0, 9.5, isDark ? 0.1 : 0.08];
      continue;
    }

    if (id === 'water-area') {
      paint['fill-color'] = isDark ? '#173354' : '#9AD0F5';
      paint['fill-outline-color'] = [
        'match',
        ['get', 'class'],
        'ocean',
        'transparent',
        isDark ? '#255284' : '#6BB3E8',
      ];
      continue;
    }

    if (id === 'water-line' || id === 'water-line-intermittent') {
      paint['line-color'] = isDark ? '#3B82F6' : '#5EA8E6';
      continue;
    }

    if (id === 'area-pier' || id === 'water-area-breakwater') {
      paint['fill-color'] = isDark ? '#1F2937' : '#EFECE2';
      continue;
    }

    if (id === 'building') {
      paint['fill-extrusion-color'] = [
        'coalesce',
        ['get', 'colour'],
        isDark ? '#2B3544' : '#D4CEC3',
      ];
      paint['fill-extrusion-opacity'] = isDark ? 0.8 : 0.78;
      continue;
    }

    if (id === 'Terrain' && layer.type === 'hillshade') {
      paint['hillshade-exaggeration'] = isDark ? 0.45 : 0.38;
      if (isDark) {
        paint['hillshade-shadow-color'] = '#05080C';
        paint['hillshade-highlight-color'] = '#2A3544';
      }
      continue;
    }

    if (id === 'contour-line') {
      paint['line-color'] = isDark ? '#6B5842' : '#9E7B56';
      continue;
    }

    if (id === 'contour-line-casing') {
      paint['line-color'] = haloColor;
      continue;
    }

    // 2. Highways & Road Casings
    const roadClass = getRoadClassFromLayerId(id);
    if (roadClass && layer.type === 'line') {
      const palette = NMS_ROAD_PALETTE[roadClass];
      if (id === `road-${roadClass}` || id.endsWith(`-road-${roadClass}`)) {
        paint['line-color'] = isDark ? palette.fillDark : palette.fillDay;
      } else {
        const casingFallback = isDark ? palette.casingDark : palette.casingDay;
        if (visibility.hikingTrails && Array.isArray(paint['line-color'])) {
          paint['line-color'] = replaceGrayFallbackInExpr(paint['line-color'], casingFallback);
        } else {
          paint['line-color'] = casingFallback;
        }
      }
      continue;
    }

    if (layer.type !== 'symbol') continue;

    // 3. Highway Shields (icon-text-fit: "both" sizes the shield box around the text)
    if (id.startsWith('shield-')) {
      layout['text-size'] = NMS_SHIELD_TEXT_SIZE_EXPR;
      layout['icon-text-fit-padding'] = [1.5, 5, 1.5, 5];
      layout['text-letter-spacing'] = 0.04;
      layout['icon-padding'] = 2;
      layout['symbol-spacing'] = 360;
      paint['text-halo-width'] = 0;
      if (id === 'shield-motorway') {
        paint['text-color'] = '#1D4ED8';
      } else if (id === 'shield-trunk') {
        paint['text-color'] = '#B91C1C';
      } else if (id === 'shield-primary') {
        paint['text-color'] = '#15803D';
      } else {
        paint['text-color'] = '#1E293B';
      }
      continue;
    }

    // 3b. Barrier Line Icons
    if (id === 'barrier-cliff-icon') {
      layout['icon-size'] = 0.32;
      continue;
    }
    if (id === 'barrier-fence-x') {
      layout['icon-size'] = 0.14;
      continue;
    }

    // 4. Contour Labels
    if (id === 'contour-label') {
      layer.minzoom = 12;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 9.5, 15, 11];
      paint['text-color'] = isDark ? '#A89070' : '#8A6844';
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'contour-label-10m') {
      layer.minzoom = 13.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 13.5, 8.5, 16, 10];
      paint['text-color'] = isDark ? '#A89070' : '#8A6844';
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    // 5. Place Labels (zoom-progressive hierarchy, capped at high zoom)
    if (id === 'place-city') {
      layer.minzoom = 5;
      layer.maxzoom = 16;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 6, 12.5, 9, 15, 12, 17.5, 15, 19];
      layout['text-padding'] = 6;
      paint['text-color'] = primaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.4;
      paint['text-halo-blur'] = 0.8;
      continue;
    }

    if (id === 'place-town') {
      layer.minzoom = 8.5;
      layer.maxzoom = 16;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 8.5, 11, 11, 13.5, 14, 15.5];
      layout['text-padding'] = 5;
      paint['text-color'] = primaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.3;
      paint['text-halo-blur'] = 0.8;
      continue;
    }

    if (id === 'place-suburb') {
      layer.minzoom = 12.5;
      layer.maxzoom = 16;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12.5, 10.5, 15, 12.5];
      layout['text-padding'] = 4;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'place-village') {
      layer.minzoom = 10.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 10.5, 10.5, 13, 12.5, 15, 13.5];
      layout['text-padding'] = 4;
      paint['text-color'] = primaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'place-hamlet') {
      layer.minzoom = 12;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 10, 15, 12];
      layout['text-padding'] = 4;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    if (id === 'place-farm') {
      layer.minzoom = 13;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 13, 9.5, 15.5, 11];
      layout['text-padding'] = 3;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    // 6. Road, Trail, Water & Park Names
    if (id === 'name-primary') {
      layer.minzoom = 11;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11, 10, 14, 11.5, 17, 13];
      layout['text-padding'] = 4;
      layout['symbol-spacing'] = 320;
      layout['text-max-angle'] = 45;
      paint['text-color'] = primaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'name-secondary') {
      layer.minzoom = 11.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11.5, 9.8, 14, 11.2, 17, 12.5];
      layout['text-padding'] = 4;
      layout['symbol-spacing'] = 320;
      layout['text-max-angle'] = 45;
      paint['text-color'] = primaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'name-tertiary') {
      layer.minzoom = 12.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12.5, 9.5, 15, 11, 17, 12];
      layout['text-padding'] = 3;
      layout['symbol-spacing'] = 300;
      layout['text-max-angle'] = 45;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    if (id === 'name-minor') {
      layer.minzoom = 14.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 14.5, 9.5, 17, 11.5];
      layout['text-padding'] = 3;
      layout['symbol-spacing'] = 280;
      layout['text-max-angle'] = 45;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    if (id === 'name-track') {
      layer.minzoom = 13.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 13.5, 9.5, 16, 11];
      layout['text-padding'] = 3;
      layout['symbol-spacing'] = 300;
      layout['text-max-angle'] = 45;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    if (id === 'name-path') {
      layer.minzoom = 14.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 14.5, 9, 17, 10.8];
      layout['text-padding'] = 3;
      layout['symbol-spacing'] = 300;
      layout['text-max-angle'] = 45;
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    if (id === 'name-trail-regional') {
      layer.minzoom = 11.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11.5, 10, 14, 11.5, 17, 12.8];
      layout['text-padding'] = 4;
      layout['symbol-spacing'] = 320;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'name-trail-local') {
      layer.minzoom = 12.5;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12.5, 9.5, 15, 11, 17, 12.2];
      layout['text-padding'] = 3;
      layout['symbol-spacing'] = 300;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'name-water-line') {
      layer.minzoom = 12;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 10, 14.5, 12, 17, 13.5];
      layout['text-padding'] = 4;
      paint['text-color'] = waterTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'water-area-name' || id === 'water-area-name-deprecated') {
      layer.minzoom = 9;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13.5, 16, 15.5];
      paint['text-color'] = waterTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'name-park') {
      layer.minzoom = 11;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11, 10.5, 14, 13, 16, 14.5];
      paint['text-color'] = parkTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      continue;
    }

    if (id === 'name-building') {
      layer.minzoom = 16;
      layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 16, 9.5, 18, 11.5];
      paint['text-color'] = secondaryTextColor;
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.0;
      continue;
    }

    // 7. Vector POI Symbols (zoom-tiered minzoom, resolution-balanced icon/text sizes, padding, halos)
    if (id in VECTOR_POI_NMS_MINZOOM) {
      layer.minzoom = VECTOR_POI_NMS_MINZOOM[id];
      layout['icon-size'] = SECONDARY_VECTOR_POI_IDS.has(id)
        ? NMS_POI_ICON_SIZE_SECONDARY_EXPR
        : NMS_POI_ICON_SIZE_PRIMARY_EXPR;
      layout['icon-padding'] = 2;
      layout['text-padding'] = 2.5;
      layout['text-optional'] = true;
      if (layout['text-field'] !== undefined) {
        layout['text-size'] = NMS_POI_TEXT_SIZE_EXPR;
        layout['text-offset'] = NMS_POI_TEXT_OFFSET_EXPR;
      }
      if (paint['text-color'] !== undefined || layout['text-field'] !== undefined) {
        if (id.startsWith('water-') || id === 'name-water-point') {
          paint['text-color'] = waterTextColor;
        } else if (!paint['text-color'] || paint['text-color'] === '#404040') {
          paint['text-color'] = primaryTextColor;
        }
        paint['text-halo-color'] = haloColor;
        paint['text-halo-width'] = 2.2;
        paint['text-halo-blur'] = 0.8;
      }
    }
  }
}
