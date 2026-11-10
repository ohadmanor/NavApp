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

function classifyByKeywords(title, desc, typeKey, defaultCategory, defaultSubcategory) {
  const combined = `${title} ${desc}`.toLowerCase();

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

  // 1. Blocked roads & trail gates
  if (
    /(שער נעול|שער סגור|שער חסום|שער בקר|אין מעבר|דרך חסומה|חסימה|חסום למ|ציר חסום|מחסום)/i.test(
      title
    )
  ) {
    const isGate = /(שער|מחסום|gate|barrier)/i.test(title);
    return { category: 'offroad', subcategory: isGate ? 'gate' : 'blocked_road' };
  }

  // 2. Water sources (exclude warnings like "בור פתוח" / "זהירות בור")
  const looksLikeHazardPit = /(זהירות בור|בור פתוח|בור ביוב|ביוב זורם|שקיעה)/i.test(combined);
  if (!looksLikeHazardPit) {
    if (/(מפל\s|מפל$|מפלי\s|waterfall)/i.test(title)) {
      return { category: 'water', subcategory: 'waterfall' };
    }
    if (/(^גב\s|\sגב\s|\sגב$|גבי\s|גב מים|מאגר\s|אגם\s|בריכת חורף|waterhole)/i.test(title)) {
      return { category: 'water', subcategory: 'waterhole' };
    }
    if (/(בור מים|^בור\s|בורות מים|cistern)/i.test(combined)) {
      return { category: 'water', subcategory: 'cistern' };
    }
    if (/(^באר\s|\sבאר\s|באר מים|water well)/i.test(title)) {
      return { category: 'water', subcategory: 'water_well' };
    }
    if (/(ברז\s|מילוי מים|מי שתייה|drinking water)/i.test(title)) {
      return { category: 'water', subcategory: 'drinking_water' };
    }
    if (/(^עין\s|\sעין\s|מעיין|מעין|בריכת\s|בריכה\s|^בריכה$|נביעה|spring)/i.test(title)) {
      return { category: 'water', subcategory: 'spring' };
    }
  }

  // 3. 4x4 climbs, obstacles, mud, hazards & offroad trail junctions
  if (
    /(^מעלה\s|\sמעלה\s|^מעלה$|ירידה|ירידת\s|עלייה|עליית\s|עליה תלולה|מדרגה|מדרגת\s|מדרגות|דרדרת|בולדר|הצלבה|שיפוע|בוץ|שקיעה|עבירות|4x4|4\+4|4\*4|רכב שטח|ג'יפ|גיפ|חילוץ|פיצול|מסעף|^ציר\s|\sציר\s|^מעבר\s|מעבר נחל|מעבר מים|מעבר טכני|מעבר צר|מעבר סלע|שטח אש|סכנה)/i.test(
      title
    )
  ) {
    const isDanger = /(בוץ|שקיעה|סכנה|מכשול|זהירות|בור פתוח|דרדרת|בולדר|הצלבה|שיפוע)/i.test(title);
    const isUpward = /(מעלה|ירידה|ירידת|עלייה|עליית|מדרגה|מדרגת|מדרגות)/i.test(title);
    return {
      category: 'offroad',
      subcategory: isUpward ? 'upward' : isDanger ? 'danger' : '4x4_pass',
    };
  }

  // 4. Night camps & picnic/shade
  if (/(חניון לילה|לינת לילה|לינת שטח|מאהל|קמפינג|camp(?:ing|site)?)/i.test(combined)) {
    return { category: 'campsite', subcategory: 'camp_site' };
  }
  if (/(חניון\s|חניון$|פיקניק|ספסל|שולחן קק|שולחנות|סככה|חאן\s|זולה|פינת קפה|פינת ישיבה|מקום מוצל|פינת צל|picnic)/i.test(title)) {
    return { category: 'campsite', subcategory: 'picnic_site' };
  }

  // 5. Mountain peaks & trig points
  if (/(^הר\s|^הרי\s|פסגת\s|פסגה|גבעת\s|נ\.ג\.?|טריג\s|mountain peak|\bpeak\b)/i.test(title)) {
    return { category: 'peak', subcategory: 'peak' };
  }

  // 6. Heritage / Viewpoints / Nature / Caves / Ruins / Memorials / Archaeology
  if (/(מערה|מערת|\bcave\b)/i.test(title)) {
    return { category: 'heritage', subcategory: 'cave' };
  }
  if (/(חורבה|חורבת|חירבת|ח['׳]\s|\bruins?\b)/i.test(title)) {
    return { category: 'heritage', subcategory: 'ruins' };
  }
  if (/(אנדרטה|אנדרטת|גלעד|הנצחה|יד ל|בית קברות|קבר\s|קברי\s|memorial)/i.test(title)) {
    return { category: 'heritage', subcategory: 'memorial' };
  }
  if (
    /(^תל\s|\sתל\s|מצד\s|מצודת|מבצר|עתיק|בית בד|גת\s|גתות|פסיפס|מוצב|בונקר|בית כנסת|מנזר|כנסייה|טחנת קמח|גשר\s|מחצבה|אמת מים|archaeolog)/i.test(
      title
    )
  ) {
    return { category: 'heritage', subcategory: 'archaeological_site' };
  }
  if (/(פריחה|אירוס|כלניות|רקפות|חלמוניות|שמורת|שמורה\s|בוסתן|חורשת|עץ עתיק)/i.test(title)) {
    return { category: 'heritage', subcategory: 'nature_site' };
  }
  if (/(תצפית|מצפה|מצפור|נקודת נוף|מרפסת נוף|פנורמה|נוף\s|viewpoint|lookout)/i.test(title)) {
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
      category = 'water';
      if (/(מפל|waterfall)/i.test(combined)) subcategory = 'waterfall';
      else if (/(^גב\s|\sגב\s|\sגב$|גבי\s|בריכה|בריכת|waterhole)/i.test(combined)) {
        subcategory = 'waterhole';
      } else if (/(בור\s|בורות\s|cistern)/i.test(combined)) subcategory = 'cistern';
      else if (/(באר\s|well)/i.test(combined)) subcategory = 'water_well';
      else if (/(ברז|שוקת|שתייה|שתיה)/i.test(combined)) subcategory = 'drinking_water';
      else subcategory = 'spring';
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
      const res = classifyByKeywords(title, descHe, typeKey, 'heritage', 'offroad_photo');
      category = res.category;
      subcategory = res.subcategory;
      break;
    }
    case 'POI':
    default: {
      const res = classifyByKeywords(title, descHe, typeKey, 'heritage', 'offroad_poi');
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
 * Lower numbers win placement within `israel-offroad-pois-labels`.
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
      source: 'Off-Road.io Community Export (Overlay on Top of OSM)',
      generatedUtc: new Date().toISOString(),
      minRenderZoom: 15,
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

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  convertOffroadPois().catch((err) => {
    console.error('[Off-Road Converter] Failed:', err);
    process.exit(1);
  });
}
