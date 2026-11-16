import type { PlanningMode } from '../routing/RoutingProfiles';

export type TrailDifficulty = 'light' | 'medium' | 'hard' | 'extreme';

export interface TrailDifficultySpec {
  id: TrailDifficulty;
  labelHe: string;
  labelEn: string;
  color: string;
  order: number;
  badgeClass: string;
}

export const TRAIL_DIFFICULTY_ORDER: TrailDifficulty[] = [
  'light',
  'medium',
  'hard',
  'extreme',
];

export const TRAIL_DIFFICULTY_META: Record<TrailDifficulty, TrailDifficultySpec> = {
  light: {
    id: 'light',
    labelHe: 'קל',
    labelEn: 'Light',
    color: '#10b981',
    order: 1,
    badgeClass: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/35',
  },
  medium: {
    id: 'medium',
    labelHe: 'בינוני',
    labelEn: 'Medium',
    color: '#f59e0b',
    order: 2,
    badgeClass: 'bg-amber-500/15 text-amber-500 border-amber-500/35',
  },
  hard: {
    id: 'hard',
    labelHe: 'קשה',
    labelEn: 'Hard',
    color: '#ef4444',
    order: 3,
    badgeClass: 'bg-red-500/15 text-red-500 border-red-500/35',
  },
  extreme: {
    id: 'extreme',
    labelHe: 'אקסטרים',
    labelEn: 'Extreme',
    color: '#a855f7',
    order: 4,
    badgeClass: 'bg-purple-500/15 text-purple-500 border-purple-500/35',
  },
};

export type TrailCategoryId =
  | '4x4'
  | 'hiking'
  | 'bicycle'
  | 'family'
  | 'water'
  | 'overnight'
  | 'scenic'
  | 'custom';

export interface TrailCategorySpec {
  id: TrailCategoryId;
  labelHe: string;
  emoji: string;
  color: string;
  defaultPlanningMode: PlanningMode;
}

export const TRAIL_CATEGORY_ORDER: TrailCategoryId[] = [
  '4x4',
  'hiking',
  'bicycle',
  'family',
  'water',
  'overnight',
  'scenic',
  'custom',
];

export const TRAIL_CATEGORY_META: Record<TrailCategoryId, TrailCategorySpec> = {
  '4x4': {
    id: '4x4',
    labelHe: 'שטח 4x4',
    emoji: '🚙',
    color: '#f59e0b',
    defaultPlanningMode: '4x4',
  },
  hiking: {
    id: 'hiking',
    labelHe: 'הליכה / טרק',
    emoji: '🥾',
    color: '#10b981',
    defaultPlanningMode: 'foot',
  },
  bicycle: {
    id: 'bicycle',
    labelHe: 'אופניים / MTB',
    emoji: '🚵',
    color: '#06b6d4',
    defaultPlanningMode: 'bicycle',
  },
  family: {
    id: 'family',
    labelHe: 'משפחתי / קליל',
    emoji: '👨‍👩‍👧',
    color: '#38bdf8',
    defaultPlanningMode: 'foot',
  },
  water: {
    id: 'water',
    labelHe: 'מים וגבים',
    emoji: '💧',
    color: '#3b82f6',
    defaultPlanningMode: 'foot',
  },
  overnight: {
    id: 'overnight',
    labelHe: 'לילה וחניונים',
    emoji: '⛺',
    color: '#6366f1',
    defaultPlanningMode: '4x4',
  },
  scenic: {
    id: 'scenic',
    labelHe: 'תצפיות ונוף',
    emoji: '🏔️',
    color: '#a855f7',
    defaultPlanningMode: '4x4',
  },
  custom: {
    id: 'custom',
    labelHe: 'מותאם אישית',
    emoji: '🏷️',
    color: '#64748b',
    defaultPlanningMode: '4x4',
  },
};

export function inferDefaultCategoryFromPlanningMode(
  mode?: PlanningMode
): TrailCategoryId {
  if (mode === 'foot') return 'hiking';
  if (mode === 'bicycle') return 'bicycle';
  return '4x4';
}
