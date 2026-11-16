import type { LayerSpecification } from 'maplibre-gl';
import type { OutdoorLayerVisibility } from './israelOutdoorStyle';
import {
  applyCompactShieldLayout,
  applyCompactSymbolHierarchy,
  getRoadClassFromLayerId,
  replaceGrayFallbackInExpr,
  type MapStyleId,
  type RoadPaletteEntry,
} from './vectorStyleHelpers';

export type { MapStyleId };

const NMS_DAY_BG = '#FFFFFF';
const NMS_DARK_BG = '#0b1015';

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

/**
 * Applies the NavApp Map Style (NMS) visual enhancements onto a cloned layer stack
 * without mutating the classic IHM style.
 */
export function applyNmsStyleEnhancements(
  layers: LayerSpecification[],
  theme: 'topo-day' | 'topo-dark',
  visibility: OutdoorLayerVisibility
): void {
  const isDark = theme === 'topo-dark';
  const haloColor = isDark ? NMS_DARK_BG : NMS_DAY_BG;
  const symbolPalette = {
    haloColor,
    primaryTextColor: isDark ? '#E2E8F0' : '#1E293B',
    secondaryTextColor: isDark ? '#CBD5E1' : '#334155',
    waterTextColor: isDark ? '#7DD3FC' : '#0F4C81',
    parkTextColor: isDark ? '#86EFAC' : '#166534',
    contourTextColor: isDark ? '#A89070' : '#8A6844',
  };

  for (const rawLayer of layers) {
    const layer = rawLayer as any;
    const id: string = layer.id;
    const paint: Record<string, any> = layer.paint || (layer.paint = {});
    const layout: Record<string, any> = layer.layout || (layer.layout = {});

    if (id === 'background') {
      paint['background-color'] = haloColor;
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

    const roadClass = getRoadClassFromLayerId(id, NMS_ROAD_PALETTE);
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

    if (id.startsWith('shield-')) {
      applyCompactShieldLayout(layout, paint);
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

    applyCompactSymbolHierarchy(layer, id, layout, paint, symbolPalette);
  }
}
