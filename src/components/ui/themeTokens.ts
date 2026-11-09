import type { PoiCategory } from '../../core/db/NavDatabase';

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
    label: 'מעיינות',
    fullLabel: 'מעיין / גב / בור מים',
    emoji: '💧',
    activeClass: 'bg-sky-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-sky-500/15 text-sky-500 border-sky-500/35',
  },
  offroad: {
    id: 'offroad',
    label: '4x4',
    fullLabel: 'מעלה / עבירות 4x4',
    emoji: '🚙',
    activeClass: 'bg-red-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-red-500/15 text-red-500 border-red-500/35',
  },
  campsite: {
    id: 'campsite',
    label: 'חניונים',
    fullLabel: 'חניון לילה / שטח כינוס',
    emoji: '⛺',
    activeClass: 'bg-emerald-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/35',
  },
  heritage: {
    id: 'heritage',
    label: 'תצפיות',
    fullLabel: 'תצפית / מערה / אתר מורשת',
    emoji: '🏛️',
    activeClass: 'bg-amber-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-amber-500/15 text-amber-500 border-amber-500/35',
  },
  peak: {
    id: 'peak',
    label: 'פסגות',
    fullLabel: 'פסגה / נ.ג. טריגונומטרית',
    emoji: '🏔️',
    activeClass: 'bg-purple-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-purple-500/15 text-purple-500 border-purple-500/35',
  },
  user: {
    id: 'user',
    label: 'שטח',
    fullLabel: 'דיווח מטייל',
    emoji: '📍',
    activeClass: 'bg-teal-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-teal-500/15 text-teal-500 border-teal-500/35',
  },
};
