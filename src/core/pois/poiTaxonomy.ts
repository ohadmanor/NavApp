import type { PoiCategory } from '../db/NavDatabase';

export type PoiBadgeShape =
  | 'circle-drop'
  | 'diamond-shield'
  | 'rounded-square'
  | 'octagon'
  | 'triangle'
  | 'pin-star';

export type PoiSymbolId =
  // 1. water (5 exclusive symbols)
  | 'poi-water-spring'
  | 'poi-water-pool'
  | 'poi-water-waterfall'
  | 'poi-water-cistern'
  | 'poi-water-tap'
  // 2. offroad (6 exclusive symbols)
  | 'poi-offroad-pass'
  | 'poi-offroad-blocked'
  | 'poi-offroad-danger'
  | 'poi-offroad-mud'
  | 'poi-offroad-track'
  | 'poi-offroad-service'
  // 3. campsite (4 exclusive symbols)
  | 'poi-campsite-night'
  | 'poi-campsite-picnic'
  | 'poi-campsite-khan'
  | 'poi-campsite-fire'
  // 4. heritage (7 exclusive symbols)
  | 'poi-heritage-landmark'
  | 'poi-heritage-ruins'
  | 'poi-heritage-cave'
  | 'poi-heritage-viewpoint'
  | 'poi-heritage-monument'
  | 'poi-heritage-nature'
  | 'poi-heritage-holy'
  // 5. peak (4 exclusive symbols)
  | 'poi-peak-summit'
  | 'poi-peak-saddle'
  | 'poi-peak-crater'
  | 'poi-peak-tower'
  // 6. user (5 exclusive symbols)
  | 'poi-user-pin'
  | 'poi-user-flag'
  | 'poi-user-note'
  | 'poi-user-star'
  | 'poi-user-service';

export interface PoiCategorySpec {
  id: PoiCategory;
  labelHe: string;
  shortLabelHe: string;
  fullLabelHe: string;
  labelEn: string;
  layerKey: 'poiWater' | 'poiOffroad' | 'poiCampsites' | 'poiHeritage' | 'poiPeaks' | 'poiUser';
  shape: PoiBadgeShape;
  fillHex: string;
  accentHex: string;
  textDayHex: string;
  textDarkHex: string;
  defaultSubcategory: string;
  defaultSymbolId: PoiSymbolId;
  activeClass: string;
  badgeClass: string;
}

export interface PoiSymbolSpec {
  id: PoiSymbolId;
  category: PoiCategory;
  subcategory: string;
  labelHe: string;
  labelEn: string;
  aliases: readonly string[];
  fillHex?: string;
  accentHex?: string;
  mapScale?: number;
}

export const POI_CATEGORIES: readonly PoiCategory[] = [
  'water',
  'offroad',
  'campsite',
  'heritage',
  'peak',
  'user',
] as const;

export interface PoiZoomRule {
  iconMinZoom: number;
  textMinZoom: number;
}

export const POI_CATEGORY_ZOOM_RULES: Record<PoiCategory, PoiZoomRule> = {
  peak: { iconMinZoom: 11.5, textMinZoom: 12.5 },
  campsite: { iconMinZoom: 13, textMinZoom: 14 },
  heritage: { iconMinZoom: 13, textMinZoom: 14 },
  water: { iconMinZoom: 14, textMinZoom: 14 },
  offroad: { iconMinZoom: 14, textMinZoom: 14 },
  user: { iconMinZoom: 14, textMinZoom: 14 },
};

export const POI_CATEGORY_SPECS: Record<PoiCategory, PoiCategorySpec> = {
  water: {
    id: 'water',
    labelHe: 'מים ומעיינות',
    shortLabelHe: 'מעיינות',
    fullLabelHe: 'מעיין / גב / בור מים',
    labelEn: 'Water & Springs',
    layerKey: 'poiWater',
    shape: 'circle-drop',
    fillHex: '#0284C7',
    accentHex: '#0369A1',
    textDayHex: '#0369A1',
    textDarkHex: '#38BDF8',
    defaultSubcategory: 'spring',
    defaultSymbolId: 'poi-water-spring',
    activeClass: 'bg-sky-600 text-white border-transparent shadow-md',
    badgeClass: 'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/35',
  },
  offroad: {
    id: 'offroad',
    labelHe: 'מעלות ועבירות 4x4',
    shortLabelHe: '4x4',
    fullLabelHe: 'מעלה / מעבר / מכשול 4x4',
    labelEn: 'Off-Road 4x4',
    layerKey: 'poiOffroad',
    shape: 'diamond-shield',
    fillHex: '#E6194B',
    accentHex: '#BE123C',
    textDayHex: '#B80F3A',
    textDarkHex: '#FB7185',
    defaultSubcategory: 'maale',
    defaultSymbolId: 'poi-offroad-pass',
    activeClass: 'bg-[#E6194B] text-white border-transparent shadow-md',
    badgeClass: 'bg-[#E6194B]/15 text-[#BE123C] dark:text-[#FB7185] border-[#E6194B]/35',
  },
  campsite: {
    id: 'campsite',
    labelHe: 'חניונים ולינה',
    shortLabelHe: 'חניונים',
    fullLabelHe: 'חניון לילה / יום / חאן',
    labelEn: 'Campsites & Rest',
    layerKey: 'poiCampsites',
    shape: 'rounded-square',
    fillHex: '#009000',
    accentHex: '#007000',
    textDayHex: '#006B00',
    textDarkHex: '#4ADE80',
    defaultSubcategory: 'camp_site',
    defaultSymbolId: 'poi-campsite-night',
    activeClass: 'bg-[#009000] text-white border-transparent shadow-md',
    badgeClass: 'bg-[#009000]/15 text-[#007000] dark:text-[#4ADE80] border-[#009000]/35',
  },
  heritage: {
    id: 'heritage',
    labelHe: 'מורשת, טבע ותצפיות',
    shortLabelHe: 'מורשת ותצפיות',
    fullLabelHe: 'תצפית / מערה / אתר מורשת',
    labelEn: 'Heritage & Viewpoints',
    layerKey: 'poiHeritage',
    shape: 'octagon',
    fillHex: '#FFE119',
    accentHex: '#CA8A04',
    textDayHex: '#7A6300',
    textDarkHex: '#FFE119',
    defaultSubcategory: 'heritage_site',
    defaultSymbolId: 'poi-heritage-landmark',
    activeClass: 'bg-[#FFE119] text-slate-950 border-transparent shadow-md',
    badgeClass: 'bg-[#FFE119]/25 text-amber-900 dark:text-[#FFE119] border-[#CA8A04]/45',
  },
  peak: {
    id: 'peak',
    labelHe: 'פסגות והרים',
    shortLabelHe: 'פסגות',
    fullLabelHe: 'פסגה / הר / נ.ג.',
    labelEn: 'Peaks & Ridges',
    layerKey: 'poiPeaks',
    shape: 'triangle',
    fillHex: '#000000',
    accentHex: '#1F2937',
    textDayHex: '#000000',
    textDarkHex: '#E2E8F0',
    defaultSubcategory: 'peak',
    defaultSymbolId: 'poi-peak-summit',
    activeClass: 'bg-neutral-900 text-white border-transparent shadow-md',
    badgeClass: 'bg-neutral-500/15 text-neutral-900 dark:text-neutral-200 border-neutral-500/35',
  },
  user: {
    id: 'user',
    labelHe: 'נקודות משתמש',
    shortLabelHe: 'שטח ואישי',
    fullLabelHe: 'דיווח מטייל / נקודה אישית',
    labelEn: 'User & Field Notes',
    layerKey: 'poiUser',
    shape: 'pin-star',
    fillHex: '#911EB4',
    accentHex: '#73168F',
    textDayHex: '#6B1286',
    textDarkHex: '#D875F5',
    defaultSubcategory: 'custom_pin',
    defaultSymbolId: 'poi-user-pin',
    activeClass: 'bg-[#911EB4] text-white border-transparent shadow-md',
    badgeClass: 'bg-[#911EB4]/15 text-[#73168F] dark:text-[#D875F5] border-[#911EB4]/35',
  },
};

/**
 * STRICT 1-TO-1 SYMBOL REGISTRY (31 exclusive symbols).
 * Invariant:
 *   1. Each symbol ID belongs to strictly ONE PoiCategory.
 *   2. Every subcategory/alias string appears in AT MOST ONE symbol across all 6 categories.
 *   3. No symbol or fallback is shared across categories.
 */
export const POI_SYMBOL_LIST: readonly PoiSymbolSpec[] = [
  // ---- WATER (5) ----
  {
    id: 'poi-water-spring',
    category: 'water',
    subcategory: 'spring',
    labelHe: 'מעיין / נביעה',
    labelEn: 'Spring',
    aliases: ['spring', 'water'],
    mapScale: 0.72,
  },
  {
    id: 'poi-water-pool',
    category: 'water',
    subcategory: 'water_pool',
    labelHe: 'גב / בריכת טבע',
    labelEn: 'Waterhole / Pool',
    aliases: ['water_pool', 'water_hole', 'waterhole', 'stream_pool', 'pool', 'swimming'],
    fillHex: '#0EA5E9',
    mapScale: 0.72,
  },
  {
    id: 'poi-water-waterfall',
    category: 'water',
    subcategory: 'waterfall',
    labelHe: 'מפל',
    labelEn: 'Waterfall',
    aliases: ['waterfall'],
    fillHex: '#0284C7',
    mapScale: 0.72,
  },
  {
    id: 'poi-water-cistern',
    category: 'water',
    subcategory: 'cistern',
    labelHe: 'בור מים / באר / מאגורה',
    labelEn: 'Cistern / Well',
    aliases: ['cistern', 'water_well', 'well', 'birket', 'maagora'],
    fillHex: '#0369A1',
    mapScale: 0.68,
  },
  {
    id: 'poi-water-tap',
    category: 'water',
    subcategory: 'drinking_water',
    labelHe: 'ברז מי שתייה',
    labelEn: 'Drinking Water',
    aliases: ['drinking_water', 'tap', 'fountain'],
    fillHex: '#06B6D4',
    mapScale: 0.66,
  },

  // ---- OFFROAD (6) ----
  {
    id: 'poi-offroad-pass',
    category: 'offroad',
    subcategory: 'maale',
    labelHe: 'מעלה / מעבר 4x4',
    labelEn: '4x4 Pass / Ascent',
    aliases: ['maale', 'mountain_pass', 'pass', 'sand_dune', '4x4_pass', 'upward'],
    fillHex: '#E6194B',
    mapScale: 0.74,
  },
  {
    id: 'poi-offroad-blocked',
    category: 'offroad',
    subcategory: 'blocked_road',
    labelHe: 'שער סגור / דרך חסומה',
    labelEn: 'Blocked / Gate',
    aliases: ['blocked_road', 'gate_closed', 'gate', 'barrier', 'blocked'],
    fillHex: '#E6194B',
    accentHex: '#9F1239',
    mapScale: 0.72,
  },
  {
    id: 'poi-offroad-danger',
    category: 'offroad',
    subcategory: 'danger',
    labelHe: 'סכנה / מדרגת סלע / הצלבה',
    labelEn: '4x4 Hazard / Obstacle',
    aliases: ['danger', 'hazard', 'obstacle', 'rock_step', 'ford'],
    fillHex: '#E6194B',
    mapScale: 0.76,
  },
  {
    id: 'poi-offroad-mud',
    category: 'offroad',
    subcategory: 'mud',
    labelHe: 'בוץ / הצפה / חציית נחל',
    labelEn: 'Mud / Flood Crossing',
    aliases: ['mud', 'wadi_crossing', 'floods'],
    fillHex: '#E6194B',
    mapScale: 0.72,
  },
  {
    id: 'poi-offroad-track',
    category: 'offroad',
    subcategory: 'offroad_track',
    labelHe: 'נקודת ציר / עבירות שטח',
    labelEn: '4x4 Trail Point',
    aliases: ['offroad_track', 'scenic_4x4', 'parking_4x4', 'ratag_info', 'wifi_sos'],
    fillHex: '#E6194B',
    mapScale: 0.68,
  },
  {
    id: 'poi-offroad-service',
    category: 'offroad',
    subcategory: 'fuel_4x4',
    labelHe: 'דלק שטח / פנצ׳רייה / חילוץ',
    labelEn: 'Off-Road Service / Fuel',
    aliases: ['fuel_4x4', 'recovery_service', 'clunker'],
    fillHex: '#E6194B',
    mapScale: 0.68,
  },

  // ---- CAMPSITE (4) ----
  {
    id: 'poi-campsite-night',
    category: 'campsite',
    subcategory: 'camp_site',
    labelHe: 'חניון לילה / קמפינג',
    labelEn: 'Night Campsite',
    aliases: ['camp_site', 'campsite', 'night_camp', 'camping', 'caravan_site'],
    fillHex: '#009000',
    mapScale: 0.72,
  },
  {
    id: 'poi-campsite-picnic',
    category: 'campsite',
    subcategory: 'picnic_site',
    labelHe: 'חניון יום / פיקניק / צל',
    labelEn: 'Picnic / Day Camp',
    aliases: ['picnic_site', 'picnic', 'shade_grove'],
    fillHex: '#009000',
    mapScale: 0.68,
  },
  {
    id: 'poi-campsite-khan',
    category: 'campsite',
    subcategory: 'khan',
    labelHe: 'חאן / בקתה / מחסה',
    labelEn: 'Khan / Shelter / Hut',
    aliases: ['khan', 'shelter', 'wilderness_hut', 'alpine_hut', 'alpinehut'],
    fillHex: '#009000',
    mapScale: 0.7,
  },
  {
    id: 'poi-campsite-fire',
    category: 'campsite',
    subcategory: 'coffee_spot',
    labelHe: 'פינת קפה / מדורה / עצירה',
    labelEn: 'Coffee Spot / Firepit',
    aliases: ['coffee_spot', 'rest_stop', 'bonfire'],
    fillHex: '#009000',
    mapScale: 0.68,
  },

  // ---- HERITAGE (7) ----
  {
    id: 'poi-heritage-landmark',
    category: 'heritage',
    subcategory: 'heritage_site',
    labelHe: 'אתר מורשת / נקודת עניין',
    labelEn: 'Heritage Landmark',
    aliases: ['heritage_site', 'info', 'museum', 'landmark'],
    fillHex: '#FFE119',
    mapScale: 0.68,
  },
  {
    id: 'poi-heritage-ruins',
    category: 'heritage',
    subcategory: 'ruins',
    labelHe: 'חורבה / ארכיאולוגיה / מצודה',
    labelEn: 'Ruins & Archaeology',
    aliases: ['ruins', 'archaeological_site', 'fort', 'castle'],
    fillHex: '#FFE119',
    mapScale: 0.7,
  },
  {
    id: 'poi-heritage-cave',
    category: 'heritage',
    subcategory: 'cave',
    labelHe: 'מערה',
    labelEn: 'Cave',
    aliases: ['cave', 'cave_entrance'],
    fillHex: '#FFE119',
    mapScale: 0.7,
  },
  {
    id: 'poi-heritage-viewpoint',
    category: 'heritage',
    subcategory: 'viewpoint',
    labelHe: 'תצפית / מצפור',
    labelEn: 'Viewpoint',
    aliases: ['viewpoint', 'scenic_view'],
    fillHex: '#FFE119',
    mapScale: 0.72,
  },
  {
    id: 'poi-heritage-monument',
    category: 'heritage',
    subcategory: 'monument',
    labelHe: 'אנדרטה / מצבה / זיכרון',
    labelEn: 'Monument / Memorial',
    aliases: ['monument', 'memorial', 'tomb'],
    fillHex: '#FFE119',
    mapScale: 0.68,
  },
  {
    id: 'poi-heritage-nature',
    category: 'heritage',
    subcategory: 'nature_site',
    labelHe: 'טבע / פריחה / עץ עתיק',
    labelEn: 'Nature / Flora / Geology',
    aliases: ['nature_site', 'flowers', 'ancient_tree', 'geology', 'botany'],
    fillHex: '#FFE119',
    mapScale: 0.68,
  },
  {
    id: 'poi-heritage-holy',
    category: 'heritage',
    subcategory: 'holy_site',
    labelHe: 'אתר קדוש / בית כנסת / מנזר',
    labelEn: 'Holy Site / Historic Shrine',
    aliases: ['holy_site', 'synagogue', 'monastery', 'mosque'],
    fillHex: '#FFE119',
    mapScale: 0.68,
  },

  // ---- PEAK (4) ----
  {
    id: 'poi-peak-summit',
    category: 'peak',
    subcategory: 'peak',
    labelHe: 'פסגה / הר / גבעה',
    labelEn: 'Summit / Peak',
    aliases: ['peak', 'summit', 'hill'],
    fillHex: '#000000',
    mapScale: 0.66,
  },
  {
    id: 'poi-peak-saddle',
    category: 'peak',
    subcategory: 'saddle',
    labelHe: 'אוכף / שלוחה / מצוק',
    labelEn: 'Saddle / Ridge / Cliff',
    aliases: ['saddle', 'ridge', 'cliff'],
    fillHex: '#000000',
    mapScale: 0.66,
  },
  {
    id: 'poi-peak-crater',
    category: 'peak',
    subcategory: 'crater',
    labelHe: 'תל געשי / מכתש / לוע',
    labelEn: 'Crater / Volcanic Cone',
    aliases: ['crater', 'volcano', 'tel_ridge'],
    fillHex: '#000000',
    mapScale: 0.68,
  },
  {
    id: 'poi-peak-tower',
    category: 'peak',
    subcategory: 'fire_lookout',
    labelHe: 'מגדל תצפית פסגה / משואה',
    labelEn: 'Peak Lookout / Beacon',
    aliases: ['fire_lookout', 'beacon', 'tower_peak'],
    fillHex: '#000000',
    mapScale: 0.68,
  },

  // ---- USER (5) ----
  {
    id: 'poi-user-pin',
    category: 'user',
    subcategory: 'custom_pin',
    labelHe: 'נקודה אישית',
    labelEn: 'Custom Pin',
    aliases: ['custom_pin', 'user', 'poi'],
    fillHex: '#911EB4',
    mapScale: 0.74,
  },
  {
    id: 'poi-user-flag',
    category: 'user',
    subcategory: 'waypoint',
    labelHe: 'יעד / נקודת ציון',
    labelEn: 'Waypoint / Flag',
    aliases: ['waypoint', 'flag', 'target'],
    fillHex: '#911EB4',
    mapScale: 0.74,
  },
  {
    id: 'poi-user-note',
    category: 'user',
    subcategory: 'field_note',
    labelHe: 'דיווח שטח / הערה',
    labelEn: 'Field Note / Report',
    aliases: ['field_note', 'report'],
    fillHex: '#911EB4',
    mapScale: 0.74,
  },
  {
    id: 'poi-user-star',
    category: 'user',
    subcategory: 'favorite',
    labelHe: 'מועדף / מומלץ',
    labelEn: 'Favorite / Star',
    aliases: ['favorite', 'star'],
    fillHex: '#911EB4',
    mapScale: 0.76,
  },
  {
    id: 'poi-user-service',
    category: 'user',
    subcategory: 'civic_amenity',
    labelHe: 'שירותים אזרחיים / רפואה / מזון',
    labelEn: 'Civic Amenity / Service',
    aliases: ['civic_amenity', 'hospital', 'restaurant', 'shop'],
    fillHex: '#911EB4',
    mapScale: 0.7,
  },
] as const;

export const POI_SYMBOL_BY_ID: Record<PoiSymbolId, PoiSymbolSpec> = Object.fromEntries(
  POI_SYMBOL_LIST.map((sym) => [sym.id, sym])
) as Record<PoiSymbolId, PoiSymbolSpec>;

export const POI_SYMBOLS_BY_CATEGORY: Record<PoiCategory, readonly PoiSymbolSpec[]> = {
  water: POI_SYMBOL_LIST.filter((s) => s.category === 'water'),
  offroad: POI_SYMBOL_LIST.filter((s) => s.category === 'offroad'),
  campsite: POI_SYMBOL_LIST.filter((s) => s.category === 'campsite'),
  heritage: POI_SYMBOL_LIST.filter((s) => s.category === 'heritage'),
  peak: POI_SYMBOL_LIST.filter((s) => s.category === 'peak'),
  user: POI_SYMBOL_LIST.filter((s) => s.category === 'user'),
};

const ALIAS_TO_SYMBOL = new Map<string, PoiSymbolSpec>();
for (const spec of POI_SYMBOL_LIST) {
  for (const alias of spec.aliases) {
    const key = alias.toLowerCase();
    const existing = ALIAS_TO_SYMBOL.get(key);
    if (existing && existing.id !== spec.id) {
      throw new Error(
        `[poiTaxonomy] Alias "${key}" is assigned to both ${existing.id} and ${spec.id}`
      );
    }
    ALIAS_TO_SYMBOL.set(key, spec);
  }
}

export function isValidPoiCategory(cat: unknown): cat is PoiCategory {
  return typeof cat === 'string' && Object.prototype.hasOwnProperty.call(POI_CATEGORY_SPECS, cat);
}

/**
 * Strictly resolves the map sprite symbol ID for a (category, subcategory) pair.
 * Never returns a symbol belonging to another category; falls back to the category's
 * own exclusive default symbol.
 */
export function resolvePoiSymbolId(
  category: PoiCategory | string | null | undefined,
  subcategory?: string | null
): PoiSymbolId {
  const safeCat: PoiCategory = isValidPoiCategory(category) ? category : 'heritage';
  const rawSub = String(subcategory || '').trim().toLowerCase();

  if (rawSub && Object.prototype.hasOwnProperty.call(POI_SYMBOL_BY_ID, rawSub)) {
    const direct = POI_SYMBOL_BY_ID[rawSub as PoiSymbolId];
    if (direct.category === safeCat) {
      return direct.id;
    }
  }

  if (rawSub) {
    const byAlias = ALIAS_TO_SYMBOL.get(rawSub);
    if (byAlias && byAlias.category === safeCat) {
      return byAlias.id;
    }
  }

  return POI_CATEGORY_SPECS[safeCat].defaultSymbolId;
}

/**
 * Normalizes a subcategory so it belongs strictly to `category`.
 */
export function normalizeSubcategoryForCategory(
  category: PoiCategory,
  subcategory?: string | null
): string {
  const symId = resolvePoiSymbolId(category, subcategory);
  return POI_SYMBOL_BY_ID[symId].subcategory;
}

export function getPoiSymbolSpec(
  category: PoiCategory | string | null | undefined,
  subcategory?: string | null
): PoiSymbolSpec {
  return POI_SYMBOL_BY_ID[resolvePoiSymbolId(category, subcategory)];
}

/**
 * Builds the MapLibre expression mapping `properties.symbolId` (or category+subcategory fallback)
 * strictly to one of the 31 exclusive `poi-<category>-<slug>` sprite keys.
 */
export function buildPoiIconExpression(): any[] {
  const catBranches: any[] = ['match', ['get', 'category']];
  for (const cat of POI_CATEGORIES) {
    const catMeta = POI_CATEGORY_SPECS[cat];
    const subExpr: any[] = ['match', ['coalesce', ['get', 'subcategory'], '']];
    for (const sym of POI_SYMBOLS_BY_CATEGORY[cat]) {
      if (sym.id === catMeta.defaultSymbolId) continue;
      for (const alias of sym.aliases) {
        subExpr.push(alias, sym.id);
      }
    }
    subExpr.push(catMeta.defaultSymbolId);
    catBranches.push(cat, subExpr);
  }
  catBranches.push(POI_CATEGORY_SPECS.heritage.defaultSymbolId);

  const validSymbolIds = POI_SYMBOL_LIST.map((s) => s.id);
  return [
    'case',
    ['in', ['coalesce', ['get', 'symbolId'], ''], ['literal', validSymbolIds]],
    ['get', 'symbolId'],
    catBranches,
  ];
}

export function buildPoiIconSizeExpression(): any[] {
  const stopForZoom = (zoomMult: number): any[] => {
    const expr: any[] = ['match', ['get', 'category']];
    for (const cat of POI_CATEGORIES) {
      const baseScale =
        cat === 'offroad' ? 1.02 : cat === 'peak' ? 0.94 : cat === 'user' ? 1.06 : 0.98;
      expr.push(cat, Number((zoomMult * baseScale).toFixed(3)));
    }
    expr.push(Number((zoomMult * 0.96).toFixed(3)));
    return expr;
  };

  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    11.5,
    stopForZoom(0.45),
    13,
    stopForZoom(0.62),
    14,
    stopForZoom(0.78),
    15.5,
    stopForZoom(1.0),
    17.5,
    stopForZoom(1.28),
  ];
}

export function buildPoiTextColorExpression(isDark: boolean): any[] {
  const expr: any[] = ['match', ['get', 'category']];
  for (const cat of POI_CATEGORIES) {
    const spec = POI_CATEGORY_SPECS[cat];
    expr.push(cat, isDark ? spec.textDarkHex : spec.textDayHex);
  }
  expr.push(isDark ? POI_CATEGORY_SPECS.heritage.textDarkHex : POI_CATEGORY_SPECS.heritage.textDayHex);
  return expr;
}
