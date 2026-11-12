#!/usr/bin/env node
/**
 * devops/convert-offroad-pois.mjs
 *
 * Converts community Off-Road.io POI exports in devops/offroad_pois/ into a clean,
 * boundary-verified, deduplicated, NavApp-compatible GeoJSON overlay placed on top
 * of the OSM POI dataset:
 *   - data/Israel.offroad.pois.geojson
 *   - public/data/Israel.offroad.pois.geojson
 *
 * Processing pipeline:
 *  1. Reads public radius-by-hash POIs + track-scoped POIs, merging duplicate IDs
 *     (keeping the newest `updated` record and preserving richest metadata).
 *  2. Enforces Israel + Golan + Judea & Samaria boundary using admin polygons inside
 *     data/Israel.osm.pmtiles (reusing `createIsraelBoundaryChecker`).
 *  3. Filters empty titles, test/demo spam, grid codes (`A008`), downvoted entries
 *     (`unlikes > likes`), community-flagged junk/deleted pins, and ephemeral route notes.
 *  4. Classifies all 21 Off-Road `mapItemType` values plus `typeKey`, `attrsJson`, and
 *     Hebrew/English keywords into NavApp categories (`water`, `offroad`, `campsite`,
 *     `heritage`, `peak`) with granular subcategories and 4x4/water metadata.
 *  5. Sanitizes `externalUrl`, extracting `he.wikipedia.org` / `wikipedia.org` slugs
 *     into `wikipedia` (`he:...`) and keeping valid reference URLs (`inature.info`,
 *     `parks.org.il`, `antiquities.org.il`, `hamaayanot.co.il`, `shimur.org`, etc.).
 *  6. Spatially deduplicates identical titles within 75m (and generic road-block pins
 *     within 45m), retaining the highest-quality entry while merging missing metadata.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIsraelBoundaryChecker } from './fetch-israel-pois.mjs';
import { loadPoiClassifierModule } from './load-poi-classifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLIC_DATA_DIR = path.join(ROOT_DIR, 'public', 'data');
const OFFROAD_RAW_DIR = path.join(__dirname, 'offroad_pois');
const PMTILES_PATH = path.join(DATA_DIR, 'Israel.osm.pmtiles');

const INPUT_GEOJSON_FILES = [
  path.join(
    OFFROAD_RAW_DIR,
    'api.off-road.io_ah_api_offroadApi_v2_mapItemsByRadiusByHash',
    'pois.geojson'
  ),
  path.join(OFFROAD_RAW_DIR, 'api.off-road.io_ah_api_tracks_filter', 'pois.geojson'),
];

const OUTPUT_FILES = [
  path.join(DATA_DIR, 'Israel.offroad.pois.geojson'),
  path.join(PUBLIC_DATA_DIR, 'Israel.offroad.pois.geojson'),
];

const VALID_2CHAR_TOPO = new Set([
  'גב',
  'גת',
  'תל',
  'בור',
  'באר',
  'עין',
  'הר',
  'נוף',
  'צל',
  'עץ',
]);

const JUNK_EXACT_RE =
  /^(?:test|tset|נסיון|ניסיון|מסיון|בדיקה|בדיק|סתם|דוגמה|נקודת הדגמה|asdf|qwerty|abc|none|null|undefined|yyy|xxx|aaa+|\.+|-+|\?+|!+|[\d\s.,-]+|[א-ת]\d{1,3}|[a-z]\d{1,4})$/i;

const EPHEMERAL_TRACK_NOTE_RE =
  /^(?:התחלה|סוף(?:\s+מסלול|\s+מקטע.*)?|מכאן\s+רגלי|נקודה\s*\d+|נ"צ\s*\d+|נצ\s*\d+|חוליה\s*\d+|מת\s*\d+|אוטו|רכב|הליכה\s+במטע|קקי(?:\s|$))/i;

export function normalizeTextForDedupe(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u0591-\u05C7"'״׳`.,:;!?()[\]\-—–/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasHebrewChars(s) {
  return /[\u0590-\u05FF]/.test(String(s || ''));
}

/**
 * Validates `externalUrl` and extracts Hebrew/English Wikipedia article references (`he:...`).
 */
export function sanitizeExternalUrl(rawUrl) {
  const cleaned = cleanText(rawUrl);
  if (!cleaned || /^(?:null|none|undefined|-+|\.+)$/i.test(cleaned)) {
    return { url: null, wikipedia: null };
  }

  let candidate = cleaned;
  const embeddedHttpMatch = /https?:\/\/[^\s"'<>]+/i.exec(cleaned);
  if (embeddedHttpMatch) {
    // Prefer an HTTPS link embedded inside free text if the whole string isn't a valid URL
    const allMatches = cleaned.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    const preferred =
      allMatches.find((u) => /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(u)) || embeddedHttpMatch[0];
    candidate = preferred;
  } else if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|$)/i.test(cleaned)) {
    candidate = `https://${cleaned}`;
  } else {
    return { url: null, wikipedia: null };
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { url: null, wikipedia: null };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, wikipedia: null };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes('.') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !/\.[a-z]{2,}$/.test(host)) {
    return { url: null, wikipedia: null };
  }

  const normalizedUrl = parsed.toString();
  const wikiMatch = /^([a-z]{2,3})(?:\.m)?\.wikipedia\.org$/i.exec(host);
  if (wikiMatch) {
    const lang = wikiMatch[1].toLowerCase();
    const pathMatch = /^\/wiki\/(.+)$/i.exec(parsed.pathname);
    if (pathMatch?.[1]) {
      let decodedTitle = pathMatch[1];
      try {
        decodedTitle = decodeURIComponent(decodedTitle);
      } catch {
        // preserve raw segment if malformed percent encoding
      }
      decodedTitle = decodedTitle.replace(/_/g, ' ').trim();
      if (decodedTitle) {
        return {
          url: normalizedUrl,
          wikipedia: `${lang}:${decodedTitle}`,
        };
      }
    }
    const curid = parsed.searchParams.get('curid');
    if (curid && /^\d+$/.test(curid)) {
      return {
        url: normalizedUrl,
        wikipedia: `${lang}:?curid=${curid}`,
      };
    }
  }

  return { url: normalizedUrl, wikipedia: null };
}

function parseAttrsJson(rawAttrs) {
  if (!rawAttrs) return {};
  if (typeof rawAttrs === 'object') return rawAttrs;
  try {
    const parsed = JSON.parse(String(rawAttrs));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function extractWaterStatus(combinedText) {
  if (!combinedText) return null;
  if (/(יבש|אין מים|חרב|נטול מים|ריק)/i.test(combinedText)) {
    return 'דיווח יובש / אין מים (קהילה)';
  }
  if (/(זיהום|מזוהם|ביוב|עכור מאוד|ירוקת|לא לטבול|לא לשתיה|לא לשתייה|לשתיה בלבד|לשתייה)/i.test(combinedText)) {
    if (/(לשתייה|לשתיה|מי שתייה)/i.test(combinedText)) {
      return 'דיווח מים לשתייה (קהילה)';
    }
    return 'אזהרת איכות מים / לא לטבול (קהילה)';
  }
  if (/(שוחים|עמוק|מלא|זורם|זרימה|איתן|מפכה|צלול|נקי|בריכה|טבילה)/i.test(combinedText)) {
    return 'דיווח מים מלאים / זורמים (קהילה)';
  }
  return null;
}

function extractDifficulty4x4(mapItemType, combinedText, descHe, attrs) {
  const vehicle = String(attrs?.vehicle || '').toLowerCase();
  if (/(קשה|קשוח|אכזרי|מוגבה|נעילה|נעילות|ממוגן|כבד|אתגרי|למנוסים|סכנה|בולדר|הצלבה)/i.test(combinedText)) {
    if (descHe && descHe.length <= 90) return descHe;
    return vehicle === '4x4' || mapItemType === 'Upward'
      ? '4x4 קשוח / דורש הגבהה ונעילה'
      : 'עבירות קשה / מכשול שטח';
  }
  if (/(בינוני|מדרגה|דרדרת|שיפוע|בוץ|שקיעה|חריצים|טכני|גבוה)/i.test(combinedText)) {
    if (descHe && descHe.length <= 90) return descHe;
    return 'עבירות בינונית / 4x4 (מדרגה או דרדרת)';
  }
  if (/(קל|רך|ג׳יפון|ג\'יפון|כל רכב|suv)/i.test(combinedText)) {
    if (descHe && descHe.length <= 90) return descHe;
    return 'עבירות קלה-בינונית (רכב גבוה / 4x4)';
  }
  if (mapItemType === 'BlockedRoad') {
    return 'ציר חסום / שער סגור (דיווח שטח)';
  }
  if (mapItemType === 'Floods') {
    return 'הצפה / בוץ / זרימה בנחל';
  }
  if (mapItemType === 'Danger') {
    return 'אזהרת שטח / מכשול עבירות';
  }
  if (mapItemType === 'Upward') {
    return 'מעלה / ירידת 4x4 (קהילה)';
  }
  if (mapItemType === 'RatagInspectorInfo') {
    return 'אין כניסה לכלי רכב — שביל רגלי בלבד (רט״ג)';
  }
  if (vehicle === '4x4') {
    return 'מעבר 4x4';
  }
  return null;
}

const RTG_CAMP_META_RE = /(?:מקומות לינה|פיתוח:|גנרטור:)/;
const NON_PEAK_SETTLEMENT_INTRO_RE =
  /(?:^|\s)(?:הוא|היא)\s+(?:כיום\s+מקום\s+מושבו|משכונות|מושב|קיבוץ|התנחלות|יישוב|ישוב|שכונה|כפר|מועצה מקומית|עיר בישראל|מוסד חינוכי|חטיבת ביניים|בית ספר|קבוצה של שישה בתים|אזור בירושלים|אתר התיישבות)|^\s*(?:קיבוץ|מושב|שכונה|שכונת|יישוב|ישוב|אתר הנצחה)\s|\),\s*(?:מושב|קיבוץ|יישוב|ישוב|כפר|שכונה)(?:\s|$)/;
const NON_PEAK_SETTLEMENT_HINT_RE =
  /(?:\((?:מושב|יישוב|קיבוץ|מוסד חינוכי|שכונה|ירושלים)\)|^(?:שכונת|מושב|קיבוץ)\s)/;
const BOTANICAL_OR_MEMORIAL_HILL_RE =
  /(?:^|\s)גבעת\s+(?:הכלניות|הרקפות|האירוסים|החלמוניות|הנרקיסים|הפרחים|התורמוסים|הקוצים)|גבעת השבשבת|גבעת הקיבוצים|גבעת רועי|גבעת תום ותומר|חורשת שולה וגבעת שולה/;
const HERITAGE_GATE_EXCEPTIONS_RE =
  /שער\s+(?:הגיא|העמק|הניצחון|ציון|יפו|שכם|האריות|הרחמים|המוגרבים|אפרים|מנשה)/;
const MUNICIPAL_MAALE_EXCEPTIONS_RE =
  /מעלה\s+(?:אדומים|אפרים|החמישה|לבונה|שומרון|מכמש|גלבוע|גמלא|עמוס|חבר)/;
const TOWN_BEER_EXCEPTIONS_RE = /באר\s+(?:שבע|יעקב|טוביה|גנים|אורה)/;
const NON_WATER_HAZARD_OR_BASIN_RE =
  /(?:זהירות בור|בור פתוח|בור ביוב|ביוב זורם|סכנת שקיעה|שקיעה בבוץ|בריכות\s+(?:דגים|שיקוע|חימצון|חמצון|משקעים|ביוב)|מאגרי\s+השיקוע|לצפרות|מכון\s+טיהור)/i;

function stripNiqqud(s) {
  return String(s || '').replace(/[\u0591-\u05C7]/g, '');
}

function isGenuinePeak(title, desc) {
  const plainTitle = stripNiqqud(title);
  if (/^(?:נ\.ג\.?(?:\s|\d|$)|טריג(?:\s|\d|$))/i.test(plainTitle)) {
    return true;
  }
  const hasPeakHead =
    /^(?:הר(?!צליה)\s|הרי\s|פסגת\s|פסגה(?:\s|$)|גבעת\s|mountain peak|\bpeak\b)/i.test(plainTitle);
  if (!hasPeakHead) return false;
  if (BOTANICAL_OR_MEMORIAL_HILL_RE.test(plainTitle)) return false;
  const trimmedDesc = stripNiqqud(cleanText(desc));
  if (NON_PEAK_SETTLEMENT_HINT_RE.test(plainTitle)) return false;
  if (NON_PEAK_SETTLEMENT_INTRO_RE.test(trimmedDesc.slice(0, 180))) {
    // Keep genuine geographical peaks whose prose mentions a nearby village only if intro calls it a peak/hill
    const explicitPeakIntro = /(?:^|\s)(?:הוא\s+הר|היא\s+גבעה|פסגה\s+בהר)/.test(
      trimmedDesc.slice(0, 100)
    );
    if (!explicitPeakIntro) return false;
  }
  if (/^\s*(?:גבעת\s+רועי|גבעת\s+שולה)/.test(plainTitle) && /לזכר|אנדרטה/.test(trimmedDesc)) {
    return false;
  }
  return true;
}

export function classifyByKeywords(
  title,
  desc,
  typeKey,
  defaultCategory,
  defaultSubcategory,
  options = {}
) {
  const { preserveWaterSubcategory = false } = options;
  const cleanTitle = stripNiqqud(cleanText(title));
  const cleanDesc = stripNiqqud(cleanText(desc));
  const combined = `${cleanTitle} ${cleanDesc}`.toLowerCase();

  // Check explicit typeKey first when structured
  if (typeKey === 'gate') return { category: 'offroad', subcategory: 'gate' };
  if (typeKey === 'obstacle' || typeKey === 'vehicle_limit') {
    return { category: 'offroad', subcategory: 'danger' };
  }
  if (typeKey === 'rescue_axis' || typeKey === 'anchor') {
    return { category: 'offroad', subcategory: '4x4_pass' };
  }
  if (typeKey === 'water') return { category: 'water', subcategory: 'spring' };
  if (typeKey === 'cave') return { category: 'heritage', subcategory: 'cave' };
  if (typeKey === 'viewpoint') return { category: 'heritage', subcategory: 'viewpoint' };
  if (typeKey === 'rv_point') return { category: 'campsite', subcategory: 'camp_site' };

  // 0. Unambiguous Head-Noun Prefix Rules on Title (prevents mentioned nearby landmark names from stealing category)
  if (/^(?:תצפית|מצפה|מצפור|מרפסת נוף|נקודת נוף)(?:\s|$)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'viewpoint' };
  }
  if (
    /^(?:חניון לילה|לינת לילה|לינת שטח|מאהל|קמפינג|חאן\s)/i.test(cleanTitle) ||
    (/^(?:חניון\s|חניון$)/.test(cleanTitle) && /(?:חניון לילה|לינת לילה|לינת שטח|קמפינג)/i.test(cleanDesc))
  ) {
    return { category: 'campsite', subcategory: 'camp_site' };
  }
  if (
    /^(?:חניון\s(?!(?:רכבים|מכוניות|פרטיים|אוטובוסים|לנחל))|חניון$|זולה(?:\s|$)|ספסל(?:\s|$)|פרגולה(?:\s|$)|פינת\s+(?:ישיבה|קפה|צל|פיקניק)|שולחן\s+פיקניק)/i.test(
      cleanTitle
    )
  ) {
    return { category: 'campsite', subcategory: 'picnic_site' };
  }
  if (
    /^(?:שער(?:\s|\d|$)|מחסום(?:\s|$))/i.test(cleanTitle) &&
    !HERITAGE_GATE_EXCEPTIONS_RE.test(cleanTitle)
  ) {
    return { category: 'offroad', subcategory: 'gate' };
  }
  if (
    /^(?:מעלה|ירידה|ירידת|עלייה|עליית|עליה)\s/i.test(cleanTitle) &&
    !MUNICIPAL_MAALE_EXCEPTIONS_RE.test(cleanTitle) &&
    !RTG_CAMP_META_RE.test(cleanDesc)
  ) {
    return { category: 'offroad', subcategory: 'upward' };
  }
  if (/^(?:מערת|מערה|מערות|הוטה|הוטת)(?:\s|$)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'cave' };
  }
  if (/^(?:חורבת|חירבת|חרבת|ח['׳]\s|חירב['׳]?\s)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'ruins' };
  }
  if (/^(?:שרידי\s|חפירות\s|מצודת\s|מבצר\s|אמת\s+מים)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'archaeological_site' };
  }
  if (/^(?:אנדרטה|אנדרטת|גלעד\s|יד\s+ל|בית\s+קברות|קבר\s|קברי\s)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'memorial' };
  }
  if (
    /^(?:מעקף(?:\s|$)|(?:שביל|ציר|מסלול|מעבר)\s+עוקף|מעבר\s+(?:נחל|מים|טכני|צר|סלע|בוץ)|(?:פנייה|פניה|פנו)\s+(?:שמאלה|ימינה|דרומה|צפונה|מזרחה|מערבה|בצומת|לכיוון|ל\S)|גישה\s+ל|דרך\s+גישה|שביל\s+(?:גישה|כניסה|כורכר|הליכה|לג'יפ|לג׳יפ|גיפים|ג'יפים)|ציר\s+(?:גישה|כניסה|יציאה|סובב|הקפי|היקפי|ה?מעיינות|המעינות|מפל|מפלי|מאגור|מאגר|עין|ל\S)|(?:כניסה|יציאה)\s+(?:לציר|למסלול|לשביל|לדרך|לכיוון|לחני|לחניון|מ(?:עין|מעיין|נחל|ציר|שביל)))/i.test(
      cleanTitle
    )
  ) {
    return { category: 'offroad', subcategory: '4x4_pass' };
  }

  // 1. Blocked roads & trail gates
  if (
    (/(שער נעול|שער סגור|שער חסום|שער בקר|שער חקלאי|שער חשמלי|אין מעבר|אין יציאה|אין המשך|דרך חסומה|חסימה|^חסום(?:\s|$)|\sחסום(?:\s|$)|חסום למ|ציר חסום|מחסום|סגור לתנועה|דרך מגודרת)/i.test(
      cleanTitle
    ) ||
      /\sשער(?:\s|\d|$)/i.test(cleanTitle)) &&
    !HERITAGE_GATE_EXCEPTIONS_RE.test(cleanTitle)
  ) {
    const isGate = /(שער|מחסום|gate|barrier)/i.test(cleanTitle);
    return { category: 'offroad', subcategory: isGate ? 'gate' : 'blocked_road' };
  }

  // 2. Water sources (check title, avoiding towns/hazards/commercial fishponds)
  const looksLikeNonWaterBasin = NON_WATER_HAZARD_OR_BASIN_RE.test(combined);
  if (!looksLikeNonWaterBasin) {
    const titleWithoutTowns = cleanTitle
      .replace(/באר\s+(?:שבע|יעקב|טוביה|גנים|אורה)/g, '')
      .trim();

    if (/(^|\s)(?:מפל|מפלי|מפלים)(?:\s|$)|waterfall/i.test(titleWithoutTowns)) {
      return { category: 'water', subcategory: 'waterfall' };
    }
    if (
      /(^|\s)(?:גב|גבי|מאגר|אגם|אגמון)(?:\s|$)|בריכת חורף|שלולית חורף|waterhole/i.test(
        titleWithoutTowns
      )
    ) {
      return { category: 'water', subcategory: 'waterhole' };
    }
    if (/(בור\s*מים|בורות\s*מים|מאגור|מאגורת|^בור(?:\s|$)|cistern)/i.test(titleWithoutTowns)) {
      return { category: 'water', subcategory: 'cistern' };
    }
    if (
      /(?:^באר(?:\s|$)|\sבאר\s|בארות(?:\s|$)|באר מים|water well)/i.test(titleWithoutTowns) &&
      !TOWN_BEER_EXCEPTIONS_RE.test(cleanTitle)
    ) {
      return { category: 'water', subcategory: 'water_well' };
    }
    if (/(ברז(?:\s|$)|מילוי מים|מי שתייה|מי שתיה|שוקת(?:\s|$)|drinking water)/i.test(titleWithoutTowns)) {
      return { category: 'water', subcategory: 'drinking_water' };
    }
    if (
      /(?:^עין\s|\sעין\s|^עינות\s|\sעינות\s|^עיינות\s|\sעיינות\s|מעיין|מעין|מעיינות|מעינות|נקבת\s|ניקבת\s|נביעה|נביעות|מקור מים|בריכת\s|בריכות\s|בריכה\s|^בריכה$|^בריכות$|מקווה(?:\s|$)|spring)/i.test(
        titleWithoutTowns
      )
    ) {
      return {
        category: 'water',
        subcategory: preserveWaterSubcategory && defaultCategory === 'water' ? defaultSubcategory : 'spring',
      };
    }
  }

  // 3. 4x4 climbs, obstacles, mud, hazards & offroad trail junctions
  if (
    /(^מעלה\s|\sמעלה\s|^מעלה$|כניסה למעלה|ירידה|ירידת\s|עלייה|עליית\s|עליה תלולה|מדרגה|מדרגת\s|מדרגות|דרדרת|בולדר|בולען|דשדש|הצלבה|הצלבות|שיפוע|בוץ|שקיעה|עבירות|4x4|4\+4|4\*4|4×4|רכב שטח|ג'יפ|ג׳יפ|גיפ|חילוץ|פיצול|מסעף|^ציר\s|\sציר\s|כניסה לציר|צומת צירים|מפגש צירים|מזלג דרכים|^מעבר\s|מעבר נחל|מעבר מים|מעבר טכני|מעבר צר|מעבר סלע|^מעקף(?:\s|$)|\sמעקף\s|פודרה|דיונה|דיונת|דיונות|שלוליות עמוקות|דרך משובשת|שטח אש|סכנה)/i.test(
      cleanTitle
    ) &&
    !MUNICIPAL_MAALE_EXCEPTIONS_RE.test(cleanTitle)
  ) {
    const isDanger =
      /(בוץ|שקיעה|סכנה|מכשול|זהירות|בור פתוח|דרדרת|בולדר|בולען|דשדש|הצלבה|הצלבות|שיפוע|שלוליות עמוקות|דרך משובשת)/i.test(
        cleanTitle
      );
    const isUpward = /(מעלה|ירידה|ירידת|עלייה|עליית|מדרגה|מדרגת|מדרגות)/i.test(cleanTitle);
    return {
      category: 'offroad',
      subcategory: isUpward ? 'upward' : isDanger ? 'danger' : '4x4_pass',
    };
  }

  // 4. Night camps & picnic/shade
  if (
    /(חניון לילה|לינת לילה|לינת שטח|מאהל|קמפינג|\bcamp(?:ing|site)?\b)/i.test(cleanTitle) ||
    RTG_CAMP_META_RE.test(cleanDesc)
  ) {
    return { category: 'campsite', subcategory: 'camp_site' };
  }
  if (
    /(חניון\s(?!(?:רכבים|מכוניות|פרטיים))|חניון$|פיקניק|^ספסל(?:\s|$)|\sספסל(?:\s|$)|שולחן קק|שולחן פיקניק|שולחנות|^סככה(?:\s|$)|^חאן\s|^זולה(?:\s|$)|\sזולה(?:\s|$)|פינת קפה|פינת ישיבה|מקום מוצל|פינת צל|picnic)/i.test(
      cleanTitle
    ) &&
    !/^(?:הר|גבעת)\s/.test(cleanTitle)
  ) {
    return { category: 'campsite', subcategory: 'picnic_site' };
  }

  // 5. Genuine Mountain Peaks & Trig Points (excludes settlements, schools, neighborhoods, flower hills)
  if (isGenuinePeak(cleanTitle, cleanDesc)) {
    return { category: 'peak', subcategory: 'peak' };
  }

  // 6. Heritage / Viewpoints / Nature / Caves / Ruins / Memorials / Archaeology
  if (/(מערה|מערת|מערות|הוטה|הוטת|\bcave\b)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'cave' };
  }
  if (/(חורבה|חורבת|חירבת|חרבת|ח['׳]\s|חירב['׳]?\s|\bruins?\b)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'ruins' };
  }
  if (/(אנדרטה|אנדרטת|גלעד|הנצחה|יד ל|לזכר\s|בית קברות|קבר\s|קברי\s|memorial)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'memorial' };
  }
  if (
    /(^תל\s|\sתל\s|מצד\s|מצודת|מבצר|עתיק|עתיקות|בית בד|גת\s|גתות|פסיפס|קולומבריום|מוצב|בונקר|בית כנסת|מנזר|כנסייה|טחנת\s+(?:ה)?קמח|גשר\s|מחצבה|אמת מים|שרידי\s|חפירות\s|archaeolog)/i.test(
      cleanTitle
    )
  ) {
    return { category: 'heritage', subcategory: 'archaeological_site' };
  }
  if (/(פריחה|אירוס|כלניות|רקפות|חלמוניות|נרקיסים|תורמוסים|שמורת|שמורה\s|בוסתן|חורשת|יער\s|שקדיות|עץ עתיק)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'nature_site' };
  }
  if (/(תצפית|מצפה|מצפור|נקודת נוף|מרפסת נוף|פנורמה|נוף\s|viewpoint|lookout)/i.test(cleanTitle)) {
    return { category: 'heritage', subcategory: 'viewpoint' };
  }

  return { category: defaultCategory, subcategory: defaultSubcategory };
}

/**
 * Classifies one raw Off-Road GeoJSON feature property bag into NavApp schema,
 * or returns `null` when it is junk, downvoted, deleted, or ephemeral.
 */
export function classifyOffroadItem(rawProps, options = {}) {
  if (!rawProps || typeof rawProps !== 'object') return null;

  const idNum = String(rawProps.id || '').trim();
  if (!idNum) return null;

  const title = cleanText(rawProps.title || rawProps.name);
  let descHe = cleanText(rawProps.description);
  const likes = Math.max(0, Number(rawProps.likes || 0) || 0);
  const unlikes = Math.max(0, Number(rawProps.unlikes || 0) || 0);
  const reqDel = Math.max(0, Number(rawProps.requestToDelet || 0) || 0);
  const mit = String(rawProps.mapItemType || 'POI').trim();
  const typeKey = String(rawProps.typeKey || '').trim().toLowerCase();
  const attrs = parseAttrsJson(rawProps.attrsJson);

  // 1. Quality / Noise Filtering
  if (!title) return null;
  if (!/[\u0590-\u05FFA-Za-z]/.test(title)) return null;
  if (title.length <= 2 && !VALID_2CHAR_TOPO.has(title) && !descHe) return null;
  if (JUNK_EXACT_RE.test(title) || /נקודת\s*הדגמה/.test(title)) return null;
  if (mit === 'DirectionCustom' && /^[A-Z]\d{2,4}$/i.test(title)) return null;

  // Avoid rejecting legit popular items (e.g. "באר המושבים" likes:31 reqDel:5)
  if (unlikes > likes && unlikes >= 1) return null;
  if (reqDel >= 2 && likes === 0 && !descHe) return null;
  if (reqDel >= 3 && likes <= 1 && !descHe) return null;
  if (reqDel >= 4 && likes <= 1) return null;

  if (EPHEMERAL_TRACK_NOTE_RE.test(title) && !descHe && likes === 0) return null;

  // Suppress duplicate descHe if identical to title
  if (descHe && normalizeTextForDedupe(descHe) === normalizeTextForDedupe(title)) {
    descHe = '';
  }

  const { url: externalUrl, wikipedia } = sanitizeExternalUrl(rawProps.externalUrl);
  const updatedRaw = String(rawProps.updated || rawProps.created || '').trim();
  const updatedAt = /^\d{4}-\d{2}-\d{2}/.test(updatedRaw) ? updatedRaw.slice(0, 10) : '';

  // 2. Category & Subcategory Mapping
  let category = 'heritage';
  let subcategory = 'offroad_poi';
  const combined = `${title} ${descHe}`;

  switch (mit) {
    case 'Fountain': {
      let defaultWaterSub = 'spring';
      if (/(מפל|waterfall)/i.test(combined)) defaultWaterSub = 'waterfall';
      else if (/(^גב\s|\sגב\s|\sגב$|גבי\s|בריכה|בריכת|waterhole)/i.test(combined)) {
        defaultWaterSub = 'waterhole';
      } else if (/(בור\s|בורות\s|cistern)/i.test(combined)) defaultWaterSub = 'cistern';
      else if (/(באר\s|well)/i.test(combined)) defaultWaterSub = 'water_well';
      else if (/(ברז|שוקת|שתייה|שתיה)/i.test(combined)) defaultWaterSub = 'drinking_water';
      const res = classifyByKeywords(title, descHe, typeKey, 'water', defaultWaterSub, {
        preserveWaterSubcategory: true,
      });
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
    case 'Upward':
      category = 'offroad';
      subcategory = 'upward';
      break;
    case 'BlockedRoad':
      category = 'offroad';
      subcategory = /(שער|מחסום|gate|barrier)/i.test(combined) ? 'gate' : 'blocked_road';
      break;
    case 'Danger':
      category = 'offroad';
      subcategory = 'danger';
      break;
    case 'Floods':
      category = 'offroad';
      subcategory = 'floods';
      break;
    case 'WifiSos':
      category = 'offroad';
      subcategory = 'wifi_sos';
      break;
    case 'RatagInspectorInfo':
      category = 'offroad';
      subcategory = 'ratag_info';
      break;
    case 'Clunker':
      category = 'offroad';
      subcategory = 'clunker';
      break;
    case 'ViewPoint':
      category = 'heritage';
      subcategory = 'viewpoint';
      break;
    case 'Camp':
    case 'NationalCamp':
    case 'PaidCamp':
      category = 'campsite';
      subcategory = 'camp_site';
      break;
    case 'Picnic':
      category = 'campsite';
      subcategory = 'picnic_site';
      break;
    case 'Ruins':
      category = 'heritage';
      subcategory = 'ruins';
      break;
    case 'HeritageSite':
      category = 'heritage';
      subcategory = /(אנדרטה|הנצחה|גלעד|מוזיאון|צריף)/i.test(combined)
        ? 'memorial'
        : 'archaeological_site';
      break;
    case 'INature':
    case 'NationalPark': {
      const res = classifyByKeywords(title, descHe, typeKey, 'heritage', 'nature_site');
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
    case 'Wiki': {
      const res = classifyByKeywords(title, descHe, typeKey, 'heritage', 'archaeological_site');
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
    case 'DirectionCustom': {
      const res = classifyByKeywords(title, descHe, typeKey, 'offroad', '4x4_pass');
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
    case 'Image': {
      const res = classifyByKeywords(title, descHe, typeKey, 'heritage', 'heritage_site');
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
    case 'POI':
    default: {
      const res = classifyByKeywords(title, descHe, typeKey, 'heritage', 'heritage_site');
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
  }

  // Enrich description when helpful context exists in attrsJson/likes
  const sector = cleanText(attrs.sector);
  if (sector && !descHe.includes(sector)) {
    descHe = descHe ? `${descHe} • גזרה: ${sector}` : `גזרה: ${sector}`;
  }
  if (!descHe && externalUrl && mit !== 'POI' && mit !== 'Image') {
    try {
      const host = new URL(externalUrl).hostname.replace(/^www\./, '');
      descHe = `מקור מידע חיצוני: ${host}`;
    } catch {
      // ignore
    }
  }

  const waterStatus = category === 'water' ? extractWaterStatus(combined) : null;
  const difficulty4x4 =
    category === 'offroad' ? extractDifficulty4x4(mit, combined, descHe, attrs) : null;

  const id = `or-${idNum}`;
  const priority = computeOffroadPriority({
    mapItemType: mit,
    category,
    subcategory,
    likes,
    reqDel,
    hasDesc: Boolean(descHe),
    hasWikipedia: Boolean(wikipedia),
    hasExternalUrl: Boolean(externalUrl),
    sameAsOsmNearby: Boolean(options.sameAsOsmNearby),
  });

  return {
    id,
    nameHe: title,
    category,
    subcategory,
    waterStatus,
    difficulty4x4,
    descHe,
    wikipedia,
    externalUrl: externalUrl && !wikipedia ? externalUrl : null,
    likes,
    unlikes,
    reqDel,
    updatedAt,
    mapItemType: mit,
    priority,
    isHebrewTitle: hasHebrewChars(title),
  };
}

/**
 * Computes deterministic MapLibre `symbol-sort-key` priority for Off-Road POIs.
 * Lower numbers win placement within `israel-pois-labels`.
 */
export function computeOffroadPriority(params) {
  const {
    mapItemType = 'POI',
    category = 'heritage',
    likes = 0,
    reqDel = 0,
    hasDesc = false,
    hasWikipedia = false,
    hasExternalUrl = false,
    sameAsOsmNearby = false,
  } = params;

  const baseByType = {
    WifiSos: 170,
    RatagInspectorInfo: 190,
    Upward: 205,
    BlockedRoad: 215,
    Floods: 225,
    Danger: 240,
    Fountain: 255,
    Camp: 295,
    NationalCamp: 290,
    PaidCamp: 300,
    Wiki: 310,
    INature: 315,
    NationalPark: 315,
    HeritageSite: 320,
    Ruins: 325,
    ViewPoint: 335,
    Picnic: 375,
    Clunker: 390,
    DirectionCustom: 410,
    POI: category === 'water' ? 280 : category === 'offroad' ? 270 : category === 'campsite' ? 320 : 410,
    Image: category === 'water' ? 310 : category === 'offroad' ? 305 : 465,
  };

  let score = baseByType[mapItemType] ?? 420;
  if (likes > 0) {
    score -= Math.min(115, Math.round(Math.log2(1 + likes) * 26));
  }
  if (hasDesc) score -= 22;
  if (hasWikipedia) score -= 28;
  else if (hasExternalUrl) score -= 14;
  if (reqDel > 0) score += Math.min(90, reqDel * 25);
  if (sameAsOsmNearby) score += 90;

  return Math.max(120, Math.round(score));
}

function buildCompactFeature(item) {
  const props = {
    nameHe: item.nameHe,
    category: item.category,
    subcategory: item.subcategory,
    symbolId: item.symbolId,
    priority: item.priority,
  };
  if (item.waterStatus) props.waterStatus = item.waterStatus;
  if (item.difficulty4x4) props.difficulty4x4 = item.difficulty4x4;
  if (item.descHe) props.descHe = item.descHe;
  if (item.wikipedia) props.wikipedia = item.wikipedia;
  if (item.externalUrl) props.externalUrl = item.externalUrl;
  if (item.likes > 0) props.likes = item.likes;
  if (item.updatedAt) props.updatedAt = item.updatedAt;

  return {
    type: 'Feature',
    id: item.id,
    geometry: {
      type: 'Point',
      coordinates: [Number(item.lon.toFixed(6)), Number(item.lat.toFixed(6))],
    },
    properties: props,
  };
}

export async function convertOffroadPois(options = {}) {
  const { classifyPoiWithText, normalizeSubcategoryForCategory, resolvePoiSymbolId } =
    await loadPoiClassifierModule();
  const inputFiles = options.inputFiles || INPUT_GEOJSON_FILES;
  const outputFiles = options.outputFiles || OUTPUT_FILES;
  const pmtilesPath = options.pmtilesPath || PMTILES_PATH;
  const osmPoiFile = options.osmPoiFile || path.join(DATA_DIR, 'Israel.pois.geojson');

  // 1. Load & merge all raw features by ID (newest `updated` wins)
  const rawById = new Map();
  let totalRawFeatures = 0;

  for (const filePath of inputFiles) {
    if (!fs.existsSync(filePath)) {
      console.warn(`[Off-Road Converter] Skipping missing input file: ${filePath}`);
      continue;
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const feats = Array.isArray(parsed.features) ? parsed.features : [];
    totalRawFeatures += feats.length;

    for (const f of feats) {
      const p = f.properties || {};
      const id = String(p.id || '').trim();
      if (!id) continue;
      const existing = rawById.get(id);
      if (!existing) {
        rawById.set(id, f);
      } else {
        const exP = existing.properties || {};
        const preferNew = String(p.updated || '') >= String(exP.updated || '');
        const primary = preferNew ? f : existing;
        const secondary = preferNew ? existing : f;
        const primProps = primary.properties || {};
        const secProps = secondary.properties || {};
        rawById.set(id, {
          ...primary,
          properties: {
            ...secProps,
            ...primProps,
            description: primProps.description || secProps.description || '',
            externalUrl: primProps.externalUrl || secProps.externalUrl || '',
          },
        });
      }
    }
  }

  // Optional: build lightweight OSM proximity lookup to avoid ranking exact duplicates over canonical OSM
  const osmGrid = new Map();
  const step = 0.0007;
  if (fs.existsSync(osmPoiFile)) {
    const osmData = JSON.parse(fs.readFileSync(osmPoiFile, 'utf-8'));
    for (const f of osmData.features || []) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const gk = `${Math.floor(lon / step)},${Math.floor(lat / step)}`;
      if (!osmGrid.has(gk)) osmGrid.set(gk, []);
      osmGrid.get(gk).push({
        lon,
        lat,
        norm: normalizeTextForDedupe(f.properties?.nameHe || f.properties?.name || ''),
      });
    }
  }

  // 2. Enforce Israel + Golan + Judea & Samaria boundary & quality filter
  const boundaryChecker = await createIsraelBoundaryChecker(pmtilesPath);
  const stats = {
    totalRawFeatures,
    uniqueInputIds: rawById.size,
    outsideBoundary: 0,
    invalidCoords: 0,
    rejectedQuality: 0,
    internalDuplicates: 0,
    sameAsOsmNearby: 0,
  };

  const candidates = [];
  try {
    for (const f of rawById.values()) {
      const [lon, lat] = f.geometry?.coordinates || [];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        stats.invalidCoords++;
        continue;
      }
      if (!(await boundaryChecker.isInside(lon, lat))) {
        stats.outsideBoundary++;
        continue;
      }

      const rawTitleNorm = normalizeTextForDedupe(f.properties?.title || f.properties?.name || '');
      let sameAsOsmNearby = false;
      if (osmGrid.size > 0 && rawTitleNorm) {
        const gx = Math.floor(lon / step);
        const gy = Math.floor(lat / step);
        for (let dx = -1; dx <= 1 && !sameAsOsmNearby; dx++) {
          for (let dy = -1; dy <= 1 && !sameAsOsmNearby; dy++) {
            const bucket = osmGrid.get(`${gx + dx},${gy + dy}`);
            if (!bucket) continue;
            for (const ex of bucket) {
              const dMeters = Math.hypot((ex.lon - lon) * 95000, (ex.lat - lat) * 111320);
              if (
                dMeters <= 75 &&
                ex.norm &&
                (ex.norm === rawTitleNorm || ex.norm.includes(rawTitleNorm) || rawTitleNorm.includes(ex.norm))
              ) {
                sameAsOsmNearby = true;
                break;
              }
            }
          }
        }
      }

      const classified = classifyOffroadItem(f.properties, { sameAsOsmNearby });
      if (!classified) {
        stats.rejectedQuality++;
        continue;
      }
      const unified = classifyPoiWithText({
        nameHe: classified.nameHe,
        descHe: classified.descHe,
        waterStatus: classified.waterStatus,
        difficulty4x4: classified.difficulty4x4,
        existingCategory: classified.category,
        existingSubcategory: classified.subcategory,
        source: 'Off-Road.io',
        wikipedia: classified.wikipedia,
      });
      classified.category = unified.category;
      classified.subcategory = normalizeSubcategoryForCategory(unified.category, unified.subcategory);
      classified.symbolId = unified.symbolId || resolvePoiSymbolId(unified.category, classified.subcategory);
      classified.waterStatus = unified.category === 'water' ? classified.waterStatus : null;
      classified.difficulty4x4 = unified.category === 'offroad' ? classified.difficulty4x4 : null;
      if (sameAsOsmNearby) stats.sameAsOsmNearby++;

      candidates.push({
        ...classified,
        lon,
        lat,
        normName: normalizeTextForDedupe(classified.nameHe),
        richnessScore:
          classified.likes * 12 +
          (classified.descHe ? 18 : 0) +
          (classified.wikipedia ? 14 : 0) +
          (classified.externalUrl ? 10 : 0) -
          classified.reqDel * 6,
      });
    }
  } finally {
    boundaryChecker.close();
  }

  // 3. Spatial + title deduplication (keep richest / highest likes / newest entry)
  candidates.sort((a, b) => {
    if (b.richnessScore !== a.richnessScore) return b.richnessScore - a.richnessScore;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt.localeCompare(a.updatedAt);
    return a.priority - b.priority;
  });

  const spatialGrid = new Map();
  const kept = [];

  for (const item of candidates) {
    const gx = Math.floor(item.lon / step);
    const gy = Math.floor(item.lat / step);
    let duplicateOf = null;

    for (let dx = -1; dx <= 1 && !duplicateOf; dx++) {
      for (let dy = -1; dy <= 1 && !duplicateOf; dy++) {
        const bucket = spatialGrid.get(`${gx + dx},${gy + dy}`);
        if (!bucket) continue;
        for (const existing of bucket) {
          const dMeters = Math.hypot((existing.lon - item.lon) * 95000, (existing.lat - item.lat) * 111320);
          const sameNameWithin75m = dMeters <= 75 && existing.normName === item.normName;
          const sameBlockWithin45m =
            dMeters <= 45 &&
            item.mapItemType === 'BlockedRoad' &&
            existing.mapItemType === 'BlockedRoad';
          if (sameNameWithin75m || sameBlockWithin45m) {
            duplicateOf = existing;
            break;
          }
        }
      }
    }

    if (duplicateOf) {
      stats.internalDuplicates++;
      if (!duplicateOf.descHe && item.descHe) duplicateOf.descHe = item.descHe;
      if (!duplicateOf.wikipedia && item.wikipedia) duplicateOf.wikipedia = item.wikipedia;
      if (!duplicateOf.externalUrl && item.externalUrl) duplicateOf.externalUrl = item.externalUrl;
      continue;
    }

    const gk = `${gx},${gy}`;
    if (!spatialGrid.has(gk)) spatialGrid.set(gk, []);
    spatialGrid.get(gk).push(item);
    kept.push(item);
  }

  // Sort final output deterministically by ascending priority (MapLibre placement order), then ID
  kept.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  const categoryCounts = {};
  const subcategoryCounts = {};
  let withWikipedia = 0;
  let withExternalUrl = 0;
  let withDesc = 0;

  const features = kept.map((item) => {
    categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
    subcategoryCounts[item.subcategory] = (subcategoryCounts[item.subcategory] || 0) + 1;
    if (item.wikipedia) withWikipedia++;
    if (item.externalUrl) withExternalUrl++;
    if (item.descHe) withDesc++;
    return buildCompactFeature(item);
  });

  const collection = {
    type: 'FeatureCollection',
    metadata: {
      source: 'Off-Road.io Community Export (Unified with OSM in NavApp)',
      generatedUtc: new Date().toISOString(),
      minRenderZoom: 13,
      boundarySource: 'data/Israel.osm.pmtiles (admin_area)',
      totalRawRecords: stats.totalRawFeatures,
      uniqueInputIds: stats.uniqueInputIds,
      keptFeatures: features.length,
      categoryCounts,
    },
    features,
  };

  const jsonPayload = JSON.stringify(collection);
  for (const outPath of outputFiles) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpPath = `${outPath}.tmp`;
    fs.writeFileSync(tmpPath, jsonPayload, 'utf-8');
    fs.renameSync(tmpPath, outPath);
  }

  const sizeMb = (Buffer.byteLength(jsonPayload, 'utf-8') / (1024 * 1024)).toFixed(2);
  console.log(
    `[Off-Road Converter] Saved ${features.length} clean POIs (${sizeMb} MB) to ${outputFiles.length} files.`
  );
  console.log('[Off-Road Converter] Pipeline stats:', {
    ...stats,
    keptFeatures: features.length,
    withDesc,
    withWikipedia,
    withExternalUrl,
    categoryCounts,
  });
  console.log('[Off-Road Converter] Subcategory breakdown:', subcategoryCounts);

  return { collection, stats, categoryCounts, subcategoryCounts, sizeMb: Number(sizeMb) };
}

function inferMitFromExisting(category, subcategory) {
  if (category === 'offroad') {
    if (subcategory === 'wifi_sos') return 'WifiSos';
    if (subcategory === 'ratag_info') return 'RatagInspectorInfo';
    if (subcategory === 'upward') return 'Upward';
    if (subcategory === 'blocked_road') return 'BlockedRoad';
    if (subcategory === 'floods') return 'Floods';
    if (subcategory === 'danger') return 'Danger';
    if (subcategory === 'clunker') return 'Clunker';
    return 'POI';
  }
  if (category === 'water') return 'Fountain';
  if (category === 'campsite') return subcategory === 'camp_site' ? 'Camp' : 'Picnic';
  if (subcategory === 'offroad_photo') return 'Image';
  if (subcategory === 'viewpoint') return 'ViewPoint';
  if (subcategory === 'ruins') return 'Ruins';
  if (subcategory === 'nature_site') return 'INature';
  if (subcategory === 'archaeological_site' || subcategory === 'memorial') return 'HeritageSite';
  return 'POI';
}

export function reclassifyExistingFeature(feature) {
  const props = { ...(feature.properties || {}) };
  const title = cleanText(props.nameHe || props.name || '');
  const descHe = cleanText(props.descHe || '');
  const combined = `${title} ${descHe}`;
  const origCategory = String(props.category || 'heritage');
  const origSubcategory = String(props.subcategory || 'offroad_poi');

  let nextCat = origCategory;
  let nextSub = origSubcategory;

  const isProtectedOffroad =
    origCategory === 'offroad' &&
    ['floods', 'wifi_sos', 'ratag_info', 'clunker', 'blocked_road', 'danger', 'gate'].includes(
      origSubcategory
    );

  if (isProtectedOffroad) {
    // Keep explicit trail barriers, floods, WiFi/SOS, hazards
  } else if (origCategory === 'offroad' && origSubcategory === 'upward') {
    if (MUNICIPAL_MAALE_EXCEPTIONS_RE.test(title) && !RTG_CAMP_META_RE.test(descHe)) {
      const res = classifyByKeywords(title, descHe, '', 'heritage', 'offroad_poi');
      nextCat = res.category;
      nextSub = res.subcategory;
    }
  } else if (origCategory === 'campsite') {
    const hasCampSignal =
      RTG_CAMP_META_RE.test(descHe) ||
      /(?:חניון|קמפינג|מאהל|לינת|לינה|פיקניק|ספסל|חאן|קרון|מדורה|מנגל|שולחן|זולה|פרגולה|camp|picnic)/i.test(
        title
      );
    if (!hasCampSignal) {
      const res = classifyByKeywords(title, descHe, '', origCategory, origSubcategory);
      nextCat = res.category;
      nextSub = res.subcategory;
    }
  } else if (origCategory === 'water') {
    const res = classifyByKeywords(title, descHe, '', 'water', origSubcategory, {
      preserveWaterSubcategory: true,
    });
    nextCat = res.category;
    nextSub = res.subcategory;
  } else if (origCategory === 'peak') {
    if (!isGenuinePeak(title, descHe)) {
      const res = classifyByKeywords(title, descHe, '', 'heritage', 'offroad_poi');
      nextCat = res.category;
      nextSub = res.subcategory;
    }
  } else {
    const res = classifyByKeywords(title, descHe, '', origCategory, origSubcategory);
    nextCat = res.category;
    nextSub = res.subcategory;
  }

  const updatedProps = {
    ...props,
    category: nextCat,
    subcategory: nextSub,
  };

  if (nextCat === 'water') {
    const status = updatedProps.waterStatus || extractWaterStatus(combined);
    if (status) updatedProps.waterStatus = status;
  } else {
    delete updatedProps.waterStatus;
  }

  if (nextCat === 'offroad') {
    const mit = inferMitFromExisting(nextCat, nextSub);
    const diff = updatedProps.difficulty4x4 || extractDifficulty4x4(mit, combined, descHe, {});
    if (diff) updatedProps.difficulty4x4 = diff;
  } else {
    delete updatedProps.difficulty4x4;
  }

  if (nextCat !== origCategory || nextSub !== origSubcategory) {
    const mit = inferMitFromExisting(nextCat, nextSub);
    updatedProps.priority = computeOffroadPriority({
      mapItemType: mit,
      category: nextCat,
      subcategory: nextSub,
      likes: Number(updatedProps.likes || 0) || 0,
      reqDel: 0,
      hasDesc: Boolean(descHe),
      hasWikipedia: Boolean(updatedProps.wikipedia),
      hasExternalUrl: Boolean(updatedProps.externalUrl),
      sameAsOsmNearby: false,
    });
  }

  return {
    ...feature,
    properties: updatedProps,
  };
}

export async function reclassifyExistingOffroadGeojson(options = {}) {
  const inputFile = options.inputFile || path.join(DATA_DIR, 'Israel.offroad.pois.geojson');
  const outputFiles = options.outputFiles || OUTPUT_FILES;

  const raw = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const feats = Array.isArray(raw.features) ? raw.features : [];
  let changedCategory = 0;
  let changedSubcategory = 0;
  const transitions = {};

  const updatedFeatures = feats.map((f) => {
    const prevCat = f.properties?.category;
    const prevSub = f.properties?.subcategory;
    const next = reclassifyExistingFeature(f);
    const nextCat = next.properties.category;
    const nextSub = next.properties.subcategory;
    if (nextCat !== prevCat) {
      changedCategory++;
      const tk = `${prevCat}->${nextCat}`;
      transitions[tk] = (transitions[tk] || 0) + 1;
    } else if (nextSub !== prevSub) {
      changedSubcategory++;
    }
    return next;
  });

  updatedFeatures.sort(
    (a, b) =>
      (a.properties?.priority ?? 500) - (b.properties?.priority ?? 500) ||
      String(a.id).localeCompare(String(b.id))
  );

  const categoryCounts = {};
  const subcategoryCounts = {};
  for (const f of updatedFeatures) {
    const p = f.properties || {};
    categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1;
    subcategoryCounts[p.subcategory] = (subcategoryCounts[p.subcategory] || 0) + 1;
  }

  const collection = {
    ...raw,
    metadata: {
      ...(raw.metadata || {}),
      source: 'Off-Road.io Community Export (Unified with OSM in NavApp)',
      generatedUtc: new Date().toISOString(),
      minRenderZoom: 13,
      keptFeatures: updatedFeatures.length,
      categoryCounts,
    },
    features: updatedFeatures,
  };

  const jsonPayload = JSON.stringify(collection);
  for (const outPath of outputFiles) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpPath = `${outPath}.tmp`;
    fs.writeFileSync(tmpPath, jsonPayload, 'utf-8');
    fs.renameSync(tmpPath, outPath);
  }

  console.log(
    `[Off-Road Reclassifier] Updated ${updatedFeatures.length} features (${changedCategory} category changes, ${changedSubcategory} subcategory refinements).`
  );
  console.log('[Off-Road Reclassifier] Category transitions:', transitions);
  console.log('[Off-Road Reclassifier] New category counts:', categoryCounts);
  console.log('[Off-Road Reclassifier] New subcategory counts:', subcategoryCounts);

  return {
    collection,
    changedCategory,
    changedSubcategory,
    transitions,
    categoryCounts,
    subcategoryCounts,
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const run = process.argv.includes('--reclassify-existing')
    ? reclassifyExistingOffroadGeojson
    : convertOffroadPois;
  run().catch((err) => {
    console.error('[Off-Road Converter] Failed:', err);
    process.exit(1);
  });
}
