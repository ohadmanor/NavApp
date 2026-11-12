import type { PoiCategory } from '../../core/db/NavDatabase';
import { POI_CATEGORY_SPECS } from '../../core/pois/poiTaxonomy';

export type MapTheme = 'topo-day' | 'topo-dark';

export interface SurfaceTokens {
  panel: string;
  panelSolid: string;
  subCard: string;
  pillBtn: string;
  chipIdle: string;
  muted: string;
  divider: string;
  input: string;
  fieldBox: string;
  navBar: string;
  hoverRow: string;
}

export function getSurfaceTheme(theme: MapTheme): SurfaceTokens {
  if (theme === 'topo-day') {
    return {
      panel: 'bg-white/95 text-slate-900 border-slate-200/90 backdrop-blur-md shadow-xl',
      panelSolid: 'bg-white text-slate-900 border-slate-200 shadow-2xl',
      subCard: 'bg-slate-50/95 border-slate-200 text-slate-800',
      pillBtn: 'bg-white/95 hover:bg-slate-100 text-slate-800 border-slate-200/90',
      chipIdle: 'bg-white/95 text-slate-700 border-slate-200/90 hover:bg-slate-50',
      muted: 'text-slate-500',
      divider: 'border-slate-200',
      input: 'text-slate-900 placeholder-slate-400',
      fieldBox: 'bg-white border-slate-300 text-slate-900 placeholder-slate-400',
      navBar: 'bg-white/95 border-slate-200 text-slate-500 backdrop-blur-md',
      hoverRow: 'hover:bg-emerald-50/80',
    };
  }

  return {
    panel: 'bg-slate-900/95 text-slate-100 border-slate-700/80 backdrop-blur-md shadow-2xl',
    panelSolid: 'bg-slate-900 text-slate-100 border-slate-700 shadow-2xl',
    subCard: 'bg-slate-950/80 border-slate-800 text-slate-200',
    pillBtn: 'bg-slate-900/95 hover:bg-slate-800 text-slate-100 border-slate-700/80',
    chipIdle: 'bg-slate-900/90 text-slate-200 border-slate-700/80 hover:bg-slate-800',
    muted: 'text-slate-400',
    divider: 'border-slate-800',
    input: 'text-white placeholder-slate-400',
    fieldBox: 'bg-slate-950 border-slate-700 text-slate-100 placeholder-slate-500',
    navBar: 'bg-slate-950/95 border-slate-800 text-slate-400 backdrop-blur-md',
    hoverRow: 'hover:bg-slate-800/80',
  };
}

export const POI_CATEGORY_META: Record<
  PoiCategory | 'all',
  {
    id: PoiCategory | 'all';
    label: string;
    fullLabel: string;
    emoji: string;
    activeClass: string;
    badgeClass: string;
  }
> = {
  all: {
    id: 'all',
    label: 'הכל',
    fullLabel: 'כל הנקודות',
    emoji: '✦',
    activeClass: 'bg-slate-800 text-white border-transparent shadow-md',
    badgeClass: 'bg-slate-500/15 text-slate-500 border-slate-500/30',
  },
  water: {
    id: 'water',
    label: POI_CATEGORY_SPECS.water.shortLabelHe,
    fullLabel: POI_CATEGORY_SPECS.water.fullLabelHe,
    emoji: '💧',
    activeClass: POI_CATEGORY_SPECS.water.activeClass,
    badgeClass: POI_CATEGORY_SPECS.water.badgeClass,
  },
  offroad: {
    id: 'offroad',
    label: POI_CATEGORY_SPECS.offroad.shortLabelHe,
    fullLabel: POI_CATEGORY_SPECS.offroad.fullLabelHe,
    emoji: '🚙',
    activeClass: POI_CATEGORY_SPECS.offroad.activeClass,
    badgeClass: POI_CATEGORY_SPECS.offroad.badgeClass,
  },
  campsite: {
    id: 'campsite',
    label: POI_CATEGORY_SPECS.campsite.shortLabelHe,
    fullLabel: POI_CATEGORY_SPECS.campsite.fullLabelHe,
    emoji: '⛺',
    activeClass: POI_CATEGORY_SPECS.campsite.activeClass,
    badgeClass: POI_CATEGORY_SPECS.campsite.badgeClass,
  },
  heritage: {
    id: 'heritage',
    label: POI_CATEGORY_SPECS.heritage.shortLabelHe,
    fullLabel: POI_CATEGORY_SPECS.heritage.fullLabelHe,
    emoji: '🏛️',
    activeClass: POI_CATEGORY_SPECS.heritage.activeClass,
    badgeClass: POI_CATEGORY_SPECS.heritage.badgeClass,
  },
  peak: {
    id: 'peak',
    label: POI_CATEGORY_SPECS.peak.shortLabelHe,
    fullLabel: POI_CATEGORY_SPECS.peak.fullLabelHe,
    emoji: '🏔️',
    activeClass: POI_CATEGORY_SPECS.peak.activeClass,
    badgeClass: POI_CATEGORY_SPECS.peak.badgeClass,
  },
  user: {
    id: 'user',
    label: POI_CATEGORY_SPECS.user.shortLabelHe,
    fullLabel: POI_CATEGORY_SPECS.user.fullLabelHe,
    emoji: '📍',
    activeClass: POI_CATEGORY_SPECS.user.activeClass,
    badgeClass: POI_CATEGORY_SPECS.user.badgeClass,
  },
};
