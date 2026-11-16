import type { LayerSpecification } from 'maplibre-gl';
import type { OutdoorLayerVisibility } from './israelOutdoorStyle';
import {
  applyCompactShieldLayout,
  applyCompactSymbolHierarchy,
  getRoadClassFromLayerId,
  type RoadPaletteEntry,
} from './vectorStyleHelpers';

const GOVMAP_DAY_BG = '#FFFFFF';
const GOVMAP_DARK_BG = '#0b1015';

/**
 * Road palette modeled after GovMap b=9 (Survey of Israel 1:25,000 Topo25k):
 * - Motorways: steel-blue fill with crisp black casing
 * - Trunk & Primary intercity roads: terracotta/brick-red fill with black casing
 * - Secondary regional arterials: warm taupe/tan fill with black casing
 * - Tertiary & local streets: pale butter-yellow fill with black casing
 */
const GOVMAP_ROAD_PALETTE: Record<string, RoadPaletteEntry> = {
  motorway: {
    fillDay: '#4E74A8',
    fillDark: '#36547D',
    casingDay: '#1A1A1A',
    casingDark: '#020617',
  },
  trunk: {
    fillDay: '#B84B31',
    fillDark: '#8F3924',
    casingDay: '#1A1A1A',
    casingDark: '#020617',
  },
  primary: {
    fillDay: '#B84B31',
    fillDark: '#8F3924',
    casingDay: '#1A1A1A',
    casingDark: '#020617',
  },
  secondary: {
    fillDay: '#B89F8D',
    fillDark: '#756558',
    casingDay: '#1A1A1A',
    casingDark: '#020617',
  },
  tertiary: {
    fillDay: '#F5EE9E',
    fillDark: '#70683A',
    casingDay: '#1A1A1A',
    casingDark: '#0F172A',
  },
  minor: {
    fillDay: '#F5EE9E',
    fillDark: '#475569',
    casingDay: '#1A1A1A',
    casingDark: '#0F172A',
  },
};

/**
 * Applies Survey of Israel / GovMap 1:25,000 (b=9 / Topo25k) cartographic styling
 * onto a cloned NavApp vector layer stack for 100% offline use.
 */
export function applyGovmapStyleEnhancements(
  layers: LayerSpecification[],
  theme: 'topo-day' | 'topo-dark',
  visibility: OutdoorLayerVisibility
): void {
  const isDark = theme === 'topo-dark';
  const haloColor = isDark ? GOVMAP_DARK_BG : GOVMAP_DAY_BG;
  const symbolPalette = {
    haloColor,
    primaryTextColor: isDark ? '#E2E8F0' : '#111827',
    secondaryTextColor: isDark ? '#CBD5E1' : '#1F2937',
    waterTextColor: isDark ? '#7DD3FC' : '#1D6FA8',
    parkTextColor: isDark ? '#F0ABFC' : '#9D177D',
    contourTextColor: isDark ? '#B89878' : '#7A5438',
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

    // Settlements render individual building footprints on white ground at z13+,
    // with a faint warm tint only at lower zooms before buildings appear.
    if (id === 'area-residential') {
      paint['fill-color'] = isDark
        ? '#141C26'
        : [
            'interpolate',
            ['linear'],
            ['zoom'],
            11.5,
            'rgba(232, 226, 214, 0.45)',
            13.5,
            'rgba(232, 226, 214, 0.06)',
          ];
      paint['fill-outline-color'] = isDark
        ? 'rgba(148, 163, 184, 0.12)'
        : 'rgba(120, 113, 108, 0.14)';
      continue;
    }

    if (id === 'area-landcover-low') {
      paint['fill-color'] = [
        'match',
        ['get', 'class'],
        'sand',
        ['match', ['get', 'subclass'], 'beach', isDark ? '#2B2416' : '#F4EBC4', 'transparent'],
        'wood',
        isDark ? '#16291D' : '#D5E8D0',
        'grass',
        isDark ? '#1A261C' : '#E6F1E0',
        'transparent',
      ];
      continue;
    }

    if (id === 'area-cemetery') {
      paint['fill-color'] = isDark ? '#1A261E' : '#DCEAD4';
      continue;
    }

    if (id === 'area-quarry') {
      paint['fill-color'] = isDark ? '#22272E' : '#E2DDD3';
      continue;
    }

    if (id === 'area-AB' || id === 'area-A') {
      delete paint['fill-pattern'];
      paint['fill-color'] = isDark ? '#3B1F38' : '#F3DCF0';
      paint['fill-opacity'] = isDark ? 0.28 : 0.45;
      continue;
    }

    if (id === 'boundary-area-AB') {
      paint['line-color'] = isDark ? '#C084FC' : '#C060B8';
      paint['line-opacity'] = 0.6;
      paint['line-dasharray'] = [4, 2];
      continue;
    }

    if (id === 'area-park') {
      paint['fill-color'] = isDark ? '#C026D3' : '#B8339E';
      paint['fill-opacity'] = isDark ? 0.08 : 0.06;
      continue;
    }

    if (id === 'boundary-park-casing') {
      delete paint['line-pattern'];
      paint['line-color'] = 'transparent';
      paint['line-opacity'] = 0;
      continue;
    }

    if (id === 'boundary-park') {
      paint['line-color'] = isDark ? '#E879F9' : '#B81D8A';
      paint['line-width'] = 1.8;
      paint['line-dasharray'] = [6, 2, 1.5, 2];
      continue;
    }

    if (id === 'area-military') {
      paint['fill-color'] = isDark ? '#EF4444' : '#DC2626';
      paint['fill-opacity'] = ['step', ['zoom'], 0, 9.5, isDark ? 0.1 : 0.07];
      continue;
    }

    if (id === 'water-area') {
      paint['fill-color'] = isDark ? '#163250' : '#D8ECFA';
      paint['fill-outline-color'] = [
        'match',
        ['get', 'class'],
        'ocean',
        'transparent',
        isDark ? '#2B5B8C' : '#4B8EC2',
      ];
      continue;
    }

    if (id === 'water-line' || id === 'water-line-intermittent') {
      paint['line-color'] = isDark ? '#3B82F6' : '#3B8AC4';
      continue;
    }

    if (id === 'area-pier' || id === 'water-area-breakwater') {
      paint['fill-color'] = isDark ? '#1F2937' : '#F3F1EA';
      continue;
    }

    if (id === 'building') {
      paint['fill-extrusion-color'] = [
        'coalesce',
        ['get', 'colour'],
        isDark ? '#334155' : '#6E6556',
      ];
      paint['fill-extrusion-opacity'] = isDark ? 0.84 : 0.88;
      if (!visibility.terrain3d) {
        paint['fill-extrusion-height'] = 0;
        paint['fill-extrusion-base'] = 0;
      }
      continue;
    }

    if (id === 'Terrain' && layer.type === 'hillshade') {
      // GovMap Topo25k is a clean white contour sheet without heavy shaded relief.
      paint['hillshade-exaggeration'] = isDark ? 0.25 : 0.12;
      if (isDark) {
        paint['hillshade-shadow-color'] = '#05080C';
        paint['hillshade-highlight-color'] = '#2A3544';
      }
      continue;
    }

    if (id === 'contour-line') {
      paint['line-color'] = isDark ? '#7C5E44' : '#7A5438';
      paint['line-width'] = ['match', ['get', 'level'], 0, 0.75, 1.85];
      paint['line-opacity'] = ['match', ['get', 'level'], 0, 0.62, 0.92];
      continue;
    }

    if (id === 'contour-line-casing') {
      paint['line-color'] = haloColor;
      continue;
    }

    if (id === 'barrier-cliff') {
      paint['line-color'] = isDark ? '#9A7B5C' : '#7A5438';
      paint['line-width'] = 1.4;
      continue;
    }

    if (id === 'tactical-grid-minor') {
      paint['line-color'] = isDark ? '#64748B' : '#262626';
      paint['line-opacity'] = ['step', ['zoom'], isDark ? 0.35 : 0.32, 16, isDark ? 0.22 : 0.22];
      continue;
    }

    if (id === 'tactical-grid-major') {
      paint['line-color'] = isDark ? '#94A3B8' : '#111111';
      paint['line-opacity'] = isDark ? 0.55 : 0.58;
      continue;
    }

    if (id === 'tactical-grid-labels') {
      paint['text-color'] = isDark ? '#CBD5E1' : '#1F2937';
      paint['text-halo-color'] = haloColor;
      continue;
    }

    if (id === 'track-line-lowzoom' || id === 'track-line' || id.endsWith('-track-line')) {
      if (!visibility.offroad4x4) {
        paint['line-color'] = isDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(30, 30, 30, 0.42)';
      }
      continue;
    }

    const roadClass = getRoadClassFromLayerId(id, GOVMAP_ROAD_PALETTE);
    if (roadClass && layer.type === 'line') {
      const palette = GOVMAP_ROAD_PALETTE[roadClass];
      if (id === `road-${roadClass}` || id.endsWith(`-road-${roadClass}`)) {
        paint['line-color'] = isDark ? palette.fillDark : palette.fillDay;
      } else {
        paint['line-color'] = isDark ? palette.casingDark : palette.casingDay;
      }
      continue;
    }

    if (layer.type !== 'symbol') continue;

    if (id.startsWith('shield-')) {
      applyCompactShieldLayout(layout, paint);
      if (id === 'shield-motorway') {
        paint['text-color'] = '#1D4ED8';
      } else if (id === 'shield-trunk') {
        paint['text-color'] = '#B82925';
      } else if (id === 'shield-primary') {
        layout['icon-image'] = 'shield_red';
        paint['text-color'] = '#B82925';
      } else {
        paint['text-color'] = '#111111';
      }
      continue;
    }

    applyCompactSymbolHierarchy(layer, id, layout, paint, symbolPalette);
  }
}
