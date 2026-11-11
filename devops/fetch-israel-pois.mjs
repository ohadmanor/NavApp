#!/usr/bin/env node
/**
 * devops/fetch-israel-pois.mjs
 *
 * Harvests, boundary-filters, deduplicates, and prioritizes Israeli outdoor
 * Points of Interest (POIs) from OpenStreetMap Overpass API + Curated Encyclopedia
 * into BOTH:
 *   - data/Israel.pois.geojson        (used by upload-map-data.bat / build pipelines)
 *   - public/data/Israel.pois.geojson (bundled & offline-cached for app runtime)
 *
 * Boundary Filtering:
 *  Every harvested coordinate is verified against actual admin polygons inside
 *  data/Israel.osm.pmtiles (admin_level=2 ישראל + admin_level=4 יהודה ושומרון),
 *  strictly excluding Jordan, Egypt/Sinai, Lebanon, Syria, Gaza, and open sea.
 *
 * Categories:
 *  - water      : Springs (מעיין), Waterholes (גב), Waterfalls (מפל), Cisterns (בור מים), Wells (באר)
 *  - offroad    : 4x4 Ascents (מעלה), Mountain Passes, Fords, Extreme Obstacles, Trail Gates
 *  - campsite   : Night Campsites (חניון לילה), Caravan Sites, Huts, Shelters, Picnic Sites
 *  - heritage   : Viewpoints (תצפית), Caves (מערה), Archaeology, Ruins (חורבה), Forts, Memorials
 *  - peak       : Named Mountain Peaks (פסגה / הר)
 */

import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import * as turf from '@turf/turf';

// Avoid Node/undici 30s IPv6 connection stalls on Windows networks
dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PUBLIC_DATA_DIR = path.join(ROOT_DIR, 'public', 'data');
const PMTILES_PATH = path.join(DATA_DIR, 'Israel.osm.pmtiles');
const OUTPUT_FILES = [
  path.join(DATA_DIR, 'Israel.pois.geojson'),
  path.join(PUBLIC_DATA_DIR, 'Israel.pois.geojson'),
];

const DEFAULT_BBOX = {
  minLon: 33.9999,
  minLat: 29.4396,
  maxLon: 35.9153,
  maxLat: 33.4544,
};

const OVERPASS_ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

const EXCLUDED_MAALE_HIGHWAYS = new Set([
  'residential',
  'living_street',
  'tertiary',
  'tertiary_link',
  'secondary',
  'secondary_link',
  'primary',
  'primary_link',
  'trunk',
  'trunk_link',
  'motorway',
  'motorway_link',
  'service',
  'footway',
  'steps',
  'pedestrian',
  'cycleway',
  'bus_guideway',
  'raceway',
  'construction',
  'proposed',
]);

const URBAN_HAZARD_VALUES = new Set([
  'speed_camera',
  'school_zone',
  'pedestrian',
  'crosswalk',
  'bump',
  'traffic_signals',
  'children',
  'cyclists',
  'turn',
  'curve',
]);

const TRAIL_GATE_BARRIERS = new Set([
  'gate',
  'lift_gate',
  'swing_gate',
  'chain',
  'block',
  'bollard',
  'log',
  'jersey_barrier',
  'kissing_gate',
  'stile',
]);

const OUTDOOR_SHELTER_TYPES = new Set([
  'weather_shelter',
  'lean_to',
  'picnic_shelter',
  'rock_shelter',
  'field_shelter',
]);

/**
 * Curated Core Israeli Backcountry Encyclopedia (Israel Hiking / Off-Road iconic landmarks).
 * Guarantees rich Hebrew & English field descriptions even completely offline.
 */
export const CURATED_ISRAEL_POIS = [
  // === WATER & SPRINGS ===
  {
    id: 'il-poi-ein-aqev',
    nameHe: 'עין עקב תחתון',
    nameEn: 'Ein Aqev (Lower Spring)',
    category: 'water',
    subcategory: 'spring',
    coords: [34.8134, 30.8281],
    ele: 390,
    waterStatus: 'Perennial — Deep natural pool year-round (בריכה עמוקה כל השנה)',
    descHe: 'מעיין שכבה איתן בנחל עקב בנגב התיכון. מפל בגובה 10 מטרים הנופל לבריכה עמוקה וצוננת כל ימות השנה. הגישה ברגל בשביל מסומן כחול או ברכב 4x4 עד חניון עין עקב.',
    descEn: 'Perennial desert spring in Nahal Aqev (Central Negev) feeding a deep 10m waterfall pool with cool water year-round. Accessible via blue-blazed trail or 4x4 track to the parking area.',
    source: 'IsraelHiking + OSM + Wikimedia',
    wikipedia: 'he:עין עקב',
  },
  {
    id: 'il-poi-ein-avdat',
    nameHe: 'עין עובדת',
    nameEn: 'Ein Avdat Canyon & Spring',
    category: 'water',
    subcategory: 'spring',
    coords: [34.7695, 30.8322],
    ele: 445,
    waterStatus: 'Perennial — Flowing canyon pools (Entry only, no swimming)',
    descHe: 'קניון מצוקי מרשים באפיק נחל צין ובו מעיינות הזורמים כל השנה בין עצי צפצפה פרתית. רחצה אסורה (גן לאומי).',
    descEn: 'Spectacular white-chalk desert canyon along Nahal Tzin featuring perennial springs, waterfalls, and Euphrates poplar groves.',
    source: 'IsraelHiking + INPA',
    wikipedia: 'he:עין עובדת',
  },
  {
    id: 'il-poi-ein-gedi-dodim',
    nameHe: 'גב חלון ומערת דודים — נחל דוד',
    nameEn: 'Dodim Cave & Window Pool (Nahal David)',
    category: 'water',
    subcategory: 'spring',
    coords: [35.3849, 31.4682],
    ele: -210,
    waterStatus: 'Perennial — Freshwater waterfall & pool overlooking the Dead Sea',
    descHe: 'מערה יפהפייה ומפל מים מתוקים בנחל דוד בשמורת עין גדי, ומעליה גב חלון המשקיף אל ים המלח.',
    descEn: 'Lush oasis cave and infinity rock pool in Nahal David (Ein Gedi Nature Reserve) with sweeping views toward the Dead Sea.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:נחל דוד',
  },
  {
    id: 'il-poi-gev-yamin',
    nameHe: 'גבי ימין',
    nameEn: 'Gavei Yamin (Yamin Water Holes)',
    category: 'water',
    subcategory: 'waterhole',
    coords: [35.0725, 30.9462],
    ele: 365,
    waterStatus: 'Seasonal — Holds cold floodwater from winter through spring',
    descHe: 'סדרת גבי מים חצובים בסלע אבן החול והגיר בנחל ימין. מתמלאים לאחר שיטפונות החורף ומחזיקים מים נקיים וקרים עד האביב.',
    descEn: 'Series of natural desert rock pools in Nahal Yamin that fill during winter flash floods and hold cool water well into spring.',
    source: 'IsraelHiking + Off-Road Community',
    wikipedia: 'he:נחל ימין',
  },
  {
    id: 'il-poi-ein-shoka',
    nameHe: 'עין שוקו (עין א-תינה דרום רמת הגולן)',
    nameEn: 'Ein Shoko (Southern Golan Spring)',
    category: 'water',
    subcategory: 'spring',
    coords: [35.6752, 32.7568],
    ele: 195,
    waterStatus: 'Perennial — Built stone pool with views of the Sea of Galilee',
    descHe: 'מעיין נובע בדרום רמת הגולן מעל נחל עין גב. בריכת בטון ואבן עם מים צלולים ותצפית מרהיבה לכנרת ולהרי הגליל.',
    descEn: 'Popular stone-lined spring pool in the southern Golan Heights overlooking the Sea of Galilee and Nahal Ein Gev.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:רמת הגולן',
  },
  {
    id: 'il-poi-ein-lavan',
    nameHe: 'עין לבן — הרי ירושלים',
    nameEn: 'Ein Lavan (Jerusalem Hills Spring)',
    category: 'water',
    subcategory: 'spring',
    coords: [35.1618, 31.7478],
    ele: 625,
    waterStatus: 'Perennial — Two stone agricultural pools fed by spring tunnel',
    descHe: 'מעיין ניקבה ברכס לבן בהרי ירושלים. שתי בריכות אבן עתיקות מוקפות עצי תאנה, אגוז ושקד על שביל ישראל.',
    descEn: 'Ancient spring-tunnel feeding two terraced stone pools shaded by fig and almond trees in the Jerusalem Hills along the Israel National Trail.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:עין לבן',
  },
  {
    id: 'il-poi-ein-kelt',
    nameHe: 'עין קלט — נחל פרת',
    nameEn: 'Ein Qelt (Wadi Qelt Pools)',
    category: 'water',
    subcategory: 'spring',
    coords: [35.3492, 31.8384],
    ele: 45,
    waterStatus: 'Perennial — Flowing desert stream and deep rock pools',
    descHe: 'אחד ממעיינות נחל פרת (ואדי קלט) במדבר יהודה. זרימה איתנה כל השנה, בריכות סלע עמוקות ואמות מים קדומות.',
    descEn: 'Perennial spring in Wadi Qelt (Judean Desert) creating deep natural rock pools and aqueduct cascades.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:נחל פרת',
  },
  {
    id: 'il-poi-bor-hemet',
    nameHe: 'בור חמת — הר הנגב',
    nameEn: 'Bor Hemet (Ancient Nabataean Cistern)',
    category: 'water',
    subcategory: 'cistern',
    coords: [34.6778, 30.5831],
    ele: 905,
    waterStatus: 'Historical Cistern — Protected dark water reservoir near Mitzpe Ramon',
    descHe: 'בור מים עתיק ומקורה מתקופת הברונזה והנבטים ברמת מטרד בהר הנגב הגבוה, סמוך למצפה רמון.',
    descEn: 'Ancient stone-roofed cistern in the High Negev plateau near Mitzpe Ramon, engineered to collect desert runoff.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:בור חמת',
  },

  // === 4X4 ASCENTS & OFF-ROAD PASSES ===
  {
    id: 'il-poi-maale-zik',
    nameHe: 'מעלה זיק — נחל צין',
    nameEn: 'Maale Zik (4x4 High-Difficulty Ascent)',
    category: 'offroad',
    subcategory: '4x4_pass',
    coords: [34.8355, 30.8245],
    ele: 460,
    difficulty4x4: 'Hard / Extreme — הילוך כוח ונעילות דיפרנציאל מומלצות, דרדרת ומדרגות סלע',
    descHe: 'אחד ממעלות ה-4x4 המפורסמים והמאתגרים בנגב. עלייה תלולה עם דרדרת פודרה ומדרגות סלע גבוהות מעל בקעת צין. מחייב רכב שטח קשוח עם הילוך כוח (LOW) ונהג מנוסה.',
    descEn: 'Famous steep 4x4 climb in the Tzin Valley featuring deep loose fesh-fesh dust and high limestone rock steps. Requires Low-Range 4WD and high ground clearance.',
    source: 'Off-Road + OSM Israel',
    wikipedia: 'he:נחל צין',
  },
  {
    id: 'il-poi-maale-vardit',
    nameHe: 'מעלה ורדית — קניון ורדית',
    nameEn: 'Maale Vardit (4x4 Technical Rock Steps)',
    category: 'offroad',
    subcategory: '4x4_pass',
    coords: [35.0211, 30.3318],
    ele: 375,
    difficulty4x4: 'Hard — מדרגות סלע גבוהות והצלבות צירים חריפות',
    descHe: 'מעלה 4x4 טכני וקשה ביציאה מקניון ורדית בנגב הדרומי. כולל מדרגת סלע אלכסונית המחייבת הכוונה קרקעית, מרווח גחון גבוה והילוך כוח.',
    descEn: 'Technical 4x4 ascent above Vardit Canyon in the southern Negev with deep axle-articulation ruts and a steep diagonal rock ledge.',
    source: 'Off-Road + OSM Israel',
    wikipedia: 'he:נחל ורדית',
  },
  {
    id: 'il-poi-maale-noah',
    nameHe: 'מעלה נח — מכתש רמון',
    nameEn: 'Maale Noah (Makhtesh Ramon North Rim 4x4)',
    category: 'offroad',
    subcategory: '4x4_pass',
    coords: [34.8924, 30.6691],
    ele: 740,
    difficulty4x4: 'Medium-Hard — מדרגות סלע ושיפועי צד ביציאה הצפונית ממכתש רמון',
    descHe: 'מעלה היסטורי ומרשים המטפס מתוך מכתש רמון אל מצוק הצינים הצפוני. תצפית פנורמית אדירה על המכתש והר ארדון.',
    descEn: 'Historic 4x4 trail climbing the northern wall of Makhtesh Ramon with dramatic panoramic views of Mount Ardon and the crater floor.',
    source: 'Off-Road + IsraelHiking',
    wikipedia: 'he:מכתש רמון',
  },
  {
    id: 'il-poi-maale-dekla',
    nameHe: 'מעלה דקלים / מעלה עוזי — מדבר יהודה',
    nameEn: 'Maale Uzi / Judean Desert 4x4 Pass',
    category: 'offroad',
    subcategory: '4x4_pass',
    coords: [35.3312, 31.5945],
    ele: 120,
    difficulty4x4: 'Medium-Hard — מדרגות גיר ודרדרת ברמת מדבר יהודה',
    descHe: 'מעלה שטח בציר מצוק ההעתקים במדבר יהודה. כולל מדרגות גיר ושיפוע תלול עם תצפית אל ים המלח והרי מואב.',
    descEn: '4x4 desert ascent near the Judean Desert fault scarp with limestone steps and views across the Dead Sea to Moab.',
    source: 'Off-Road + OSM Israel',
  },
  {
    id: 'il-poi-maale-akrabim',
    nameHe: 'מעלה עקרבים הרומי והמנדטורי',
    nameEn: 'Scorpions Pass (Maale Akrabim Historic & Hiking Pass)',
    category: 'offroad',
    subcategory: '4x4_pass',
    coords: [35.1319, 30.9094],
    ele: 320,
    difficulty4x4: 'Scenic Historic Serpentine Road & Roman Stepped Trail',
    descHe: 'דרך פיתולים מנדטורית היסטורית (18 סרפנטינות ותחביות חביות) לצד מעלה עקרבים הרומי החצוב בסלע, בין המכתש הקטן לבקעת צין.',
    descEn: 'Iconic 18-hairpin British Mandate desert pass alongside the ancient stepped Roman Nabataean road descending toward Nahal Tzin.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:מעלה עקרבים',
  },

  // === HERITAGE, CAVES, RUINS & VIEWPOINTS ===
  {
    id: 'il-poi-masada',
    nameHe: 'מצדה — שביל הנחש והרמון',
    nameEn: 'Masada Fortress & Snake Path',
    category: 'heritage',
    subcategory: 'archaeological_site',
    coords: [35.3536, 31.3156],
    ele: 58,
    descHe: 'מבצר הר מלכותי מתקופת הבית השני על צוק מבודד במזרח מדבר יהודה מול ים המלח. עלייה רגלית משביל הנחש ממזרח או מהסוללה הרומית ממערב.',
    descEn: 'UNESCO World Heritage cliff-top fortress overlooking the Dead Sea, accessible via the eastern Snake Path or western Roman Ramp.',
    source: 'IsraelHiking + UNESCO + OSM',
    wikipedia: 'he:מצדה',
  },
  {
    id: 'il-poi-karnei-hittin',
    nameHe: 'קרני חיטין — תצפית והר געש כבוי',
    nameEn: 'Horns of Hattin (Volcanic Ridge & Lookout)',
    category: 'heritage',
    subcategory: 'viewpoint',
    coords: [35.4489, 32.8012],
    ele: 326,
    descHe: 'הר געש כבוי בעל שתי פסגות בגליל התחתון על שביל ישראל. אתר הקרב ההיסטורי משנת 1187 ותצפית של 360 מעלות על בקעת ארבל, הכנרת והתבור.',
    descEn: 'Twin-peaked extinct volcano along the Israel National Trail, site of the historic 1187 Battle of Hattin with 360° views of Mount Arbel and the Sea of Galilee.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:קרני חיטין',
  },
  {
    id: 'il-poi-arbel-cliff',
    nameHe: 'מצוק הארבל ומבצר המערות',
    nameEn: 'Mount Arbel Cliff & Cave Fortress',
    category: 'heritage',
    subcategory: 'viewpoint',
    coords: [35.4958, 32.8256],
    ele: 181,
    descHe: 'מצוק אדיר המתנשא מעל הכנרת ובקעת גינוסר. בדופן המצוק חצובות מערות מפלט ומבצר מהתקופה ההרודיאנית והעות׳מאנית, עם שביל יתדות אתגרי.',
    descEn: 'Towering limestone cliff above the Sea of Galilee featuring ancient cliffside cave fortifications and a dramatic via-ferrata rung trail.',
    source: 'IsraelHiking + INPA',
    wikipedia: 'he:הר ארבל',
  },
  {
    id: 'il-poi-shivta',
    nameHe: 'שבטה — עיר נבטית עתיקה',
    nameEn: 'Shivta (Ancient Nabataean-Byzantine Desert City)',
    category: 'heritage',
    subcategory: 'archaeological_site',
    coords: [34.6308, 30.8811],
    ele: 350,
    descHe: 'עיר נבטית-ביזנטית שמורה להפליא בנגב המערבי, כוללת בורות מים ציבוריים, גתות יין עתיקות ושלוש כנסיות מרשימות.',
    descEn: 'Remarkably preserved Nabataean and Byzantine desert settlement in the Negev featuring engineered runoff water reservoirs and ancient winepresses.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:שבטה',
  },
  {
    id: 'il-poi-har-karkom',
    nameHe: 'הר כרכום — ציורי סלע ומזבחות קדומים',
    nameEn: 'Har Karkom (Ancient Rock Art & Desert Mesa)',
    category: 'heritage',
    subcategory: 'archaeological_site',
    coords: [34.7412, 30.2895],
    ele: 842,
    descHe: 'הר שולחן מבודד בנגב הדרומי ובו אלפי חריטות סלע (פטרוגליפים), מצבות אבן ומקדשים פרהיסטוריים. שטח אש — כניסה בסופי שבוע וחגים בתיאום בלבד.',
    descEn: 'Remote plateau mountain in the southern Negev rich in Bronze Age rock engravings (petroglyphs), standing stones, and geoglyphs.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:הר כרכום',
  },

  // === NIGHT CAMPSITES ===
  {
    id: 'il-poi-camp-beeri',
    nameHe: 'חניון לילה בארות — מכתש רמון',
    nameEn: 'Beerot Night Campsite (Makhtesh Ramon)',
    category: 'campsite',
    subcategory: 'camp_site',
    coords: [34.9182, 30.6194],
    ele: 495,
    descHe: 'חניון לילה מוסדר בלב מכתש רמון (רט"ג). כולל מים לשתייה, מקלחות חמות, שירותים, סככות צל ונקודת יציאה מעולה לשביל ישראל ולהר ארדון.',
    descEn: 'Organized desert campsite in the heart of Makhtesh Ramon offering drinking water, showers, shade structures, and direct access to Mount Ardon and the Israel National Trail.',
    source: 'IsraelHiking + INPA',
    wikipedia: 'he:מכתש רמון',
  },
  {
    id: 'il-poi-camp-ein-aqev',
    nameHe: 'חניון לילה עין עקב — נחל עקב',
    nameEn: 'Ein Aqev Backcountry Night Campsite',
    category: 'campsite',
    subcategory: 'camp_site',
    coords: [34.8192, 30.8389],
    ele: 370,
    descHe: 'חניון לילה פתוח בשטח (ללא מים וללא שירותים) במפגש שבילים צפונית לעין עקב. לינה מותרת רק בשטח המסומן באבנים כדי לא להפריע לחיות הבר ליד המעיין.',
    descEn: 'Designated primitive desert night camp north of Ein Aqev spring (no water or facilities; camping directly at the spring is prohibited to allow wildlife access at night).',
    source: 'IsraelHiking + INPA',
  },
  {
    id: 'il-poi-camp-amud',
    nameHe: 'חניון לילה נחל עמוד (פיתול העמוד)',
    nameEn: 'Nahal Amud Night Campsite',
    category: 'campsite',
    subcategory: 'camp_site',
    coords: [35.4685, 32.9762],
    ele: 615,
    descHe: 'חניון לילה מבוקש על שביל ישראל בכניסה לנחל עמוד עליון בגליל העליון, סמוך למירון.',
    descEn: 'Key Israel National Trail campsite at the entrance to Upper Nahal Amud in the Upper Galilee near Mount Meron.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:נחל עמוד',
  },
  {
    id: 'il-poi-camp-barak',
    nameHe: 'חניון לילה נחל ברק — הערבה',
    nameEn: 'Nahal Barak Night Campsite',
    category: 'campsite',
    subcategory: 'camp_site',
    coords: [35.0982, 30.4021],
    ele: 110,
    descHe: 'חניון לילה מדברי פתוח בכניסה לקניון נחל ברק ומסלול הסולמות. מתאים לרכבי שטח ולמטיילים רגליים.',
    descEn: 'Open desert night campsite at the mouth of Nahal Barak slot canyon and ladder trail in the Arava.',
    source: 'IsraelHiking + Off-Road',
  },

  // === PEAKS & SUMMITS ===
  {
    id: 'il-poi-peak-meron',
    nameHe: 'הר מירון — שביל הפסגה',
    nameEn: 'Mount Meron Summit Trail',
    category: 'peak',
    subcategory: 'peak',
    coords: [35.4126, 32.9969],
    ele: 1204,
    descHe: 'הפסגה הגבוהה ביותר בגליל (1,204 מ׳). שביל הפסגה המוצל בחורש ים-תיכוני סבוך מציע תצפיות מרהיבות ללבנון, לחרמון, לגולן ולכנרת.',
    descEn: 'Highest peak in the Galilee (1,204m) featuring a circular summit trail through dense Mediterranean oak woodland with views to Mount Hermon and the Sea of Galilee.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:הר מירון',
  },
  {
    id: 'il-poi-peak-hermon',
    nameHe: 'הר החרמון — מצפה שלגים',
    nameEn: 'Mount Hermon (Mitzpe Shlagim)',
    category: 'peak',
    subcategory: 'peak',
    coords: [35.7865, 33.3075],
    ele: 2224,
    descHe: 'הנקודה הגבוהה ביותר בישראל, מתנשאת מעל עמק החולה ורמת הגולן וניזונה משלגי החורף.',
    descEn: 'Highest mountain ridge in Israel towering above the Hula Valley and the Golan Heights.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:חרמון',
  },
  {
    id: 'il-poi-peak-ramon',
    nameHe: 'הר רמון — הפסגה הגבוהה בנגב',
    nameEn: 'Mount Ramon (Highest Peak in the Negev)',
    category: 'peak',
    subcategory: 'peak',
    coords: [34.6431, 30.5015],
    ele: 1037,
    descHe: 'הפסגה הגבוהה ביותר בנגב (1,037 מ׳) בקצה המערבי של מכתש רמון, סמוך לקרני רמון ובור חמת.',
    descEn: 'Highest summit in the Negev desert (1,037m) on the western rim of Makhtesh Ramon.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:הר רמון',
  },
  {
    id: 'il-poi-peak-tavor',
    nameHe: 'הר תבור — שביל סובב פסגה',
    nameEn: 'Mount Tabor Summit Loop',
    category: 'peak',
    subcategory: 'peak',
    coords: [35.3911, 32.6869],
    ele: 588,
    descHe: 'הר כיפתי בולט בגליל התחתון המתנשא מעל עמק יזרעאל. סביב הפסגה שביל מעגלי מוצל עם שרידי חומה מימי בית שני ותצפית פנורמית.',
    descEn: 'Iconic dome-shaped mountain rising above the Jezreel Valley with a shaded panoramic summit loop trail along the Israel National Trail.',
    source: 'IsraelHiking + OSM',
    wikipedia: 'he:הר תבור',
  },
];

const HEBREW_RE = /[\u0590-\u05FF]/;
const LATIN_RE = /[A-Za-z]/;

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
    )
  );
  return { x, y };
}

function normalizeNameForDedupe(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/[׳'״"`.,:;!?()[\]{}\-—–/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function pickPreferredNames(tags, fallbackHe, fallbackEn) {
  const rawName = typeof tags.name === 'string' ? tags.name.trim() : '';
  const rawHe = typeof tags['name:he'] === 'string' ? tags['name:he'].trim() : '';
  const rawEn = typeof tags['name:en'] === 'string' ? tags['name:en'].trim() : '';
  const rawLatin = typeof tags['name:latin'] === 'string' ? tags['name:latin'].trim() : '';

  const nameHe =
    rawHe ||
    (HEBREW_RE.test(rawName) ? rawName : '') ||
    rawEn ||
    rawLatin ||
    rawName ||
    fallbackHe ||
    '';

  const nameEn =
    rawEn ||
    rawLatin ||
    (!HEBREW_RE.test(rawName) && LATIN_RE.test(rawName) ? rawName : '') ||
    rawName ||
    nameHe ||
    fallbackEn ||
    '';

  return {
    nameHe,
    nameEn,
    hasExplicitName: Boolean(rawHe || rawEn || rawLatin || rawName),
  };
}

/**
 * Classifies an OSM element (node / way / relation) into NavApp POI categories,
 * rejecting urban transit, commercial/building noise, and city streets named "מעלה ...".
 */
export function classifyOsmElement(el) {
  const tags = el?.tags;
  if (!tags || typeof tags !== 'object') return null;

  // Reject transit/commercial/urban clutter immediately
  if (
    tags.public_transport ||
    tags.highway === 'bus_stop' ||
    tags.amenity === 'bus_station' ||
    tags.amenity === 'bus_terminal' ||
    tags.advertising ||
    tags.shop ||
    tags.shelter_type === 'public_transport' ||
    tags.shelter_type === 'bomb_shelter' ||
    tags.shelter_type === 'basic_hut' ||
    tags.bus === 'yes'
  ) {
    return null;
  }

  // Filter out urban buildings unless specifically marked as fortress/castle/wilderness_hut
  if (
    tags.building &&
    tags.historic !== 'fort' &&
    tags.historic !== 'castle' &&
    tags.tourism !== 'wilderness_hut'
  ) {
    return null;
  }

  const { nameHe, nameEn, hasExplicitName } = pickPreferredNames(tags);

  // 1. WATER SOURCES (springs, waterholes, waterfalls, cisterns, wells)
  if (
    tags.natural === 'spring' ||
    tags.natural === 'waterhole' ||
    tags.water === 'waterhole' ||
    tags.waterway === 'waterfall' ||
    tags.man_made === 'cistern' ||
    tags.man_made === 'water_well'
  ) {
    let subcategory = 'spring';
    let defHe = 'מעיין';
    let defEn = 'Spring';
    if (tags.natural === 'waterhole' || tags.water === 'waterhole') {
      subcategory = 'waterhole';
      defHe = 'גב מים';
      defEn = 'Desert Water Hole';
    } else if (tags.waterway === 'waterfall') {
      subcategory = 'waterfall';
      defHe = 'מפל מים';
      defEn = 'Waterfall';
    } else if (tags.man_made === 'cistern') {
      subcategory = 'cistern';
      defHe = 'בור מים';
      defEn = 'Water Cistern';
    } else if (tags.man_made === 'water_well') {
      subcategory = 'water_well';
      defHe = 'באר מים';
      defEn = 'Water Well';
    }
    return {
      category: 'water',
      subcategory,
      nameHe: nameHe || defHe,
      nameEn: nameEn || defEn,
      hasExplicitName,
    };
  }

  // 2. OFF-ROAD 4x4 ASCENTS, PASSES, FORDS, OBSTACLES & NAMED TRAIL GATES
  const rawNameStr = String(tags['name:he'] || tags.name || '').trim();
  const startsWithMaale = rawNameStr.startsWith('מעלה ');
  if (startsWithMaale) {
    if (el.type === 'way' && tags.highway && EXCLUDED_MAALE_HIGHWAYS.has(tags.highway)) {
      return null;
    }
    if (tags.place || tags.boundary || tags.landuse) {
      return null;
    }
    return {
      category: 'offroad',
      subcategory: '4x4_pass',
      nameHe: nameHe || rawNameStr,
      nameEn: nameEn || rawNameStr,
      hasExplicitName: true,
    };
  }

  if (tags.mountain_pass === 'yes') {
    if (!hasExplicitName && tags.highway && EXCLUDED_MAALE_HIGHWAYS.has(tags.highway)) {
      return null;
    }
    return {
      category: 'offroad',
      subcategory: '4x4_pass',
      nameHe: nameHe || 'מעבר הרים / שטח',
      nameEn: nameEn || 'Mountain / Trail Pass',
      hasExplicitName,
    };
  }

  if (tags.ford === 'yes') {
    if (!hasExplicitName) return null;
    if (tags.highway && EXCLUDED_MAALE_HIGHWAYS.has(tags.highway)) return null;
    return {
      category: 'offroad',
      subcategory: 'ford',
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  if (tags['4wd_only'] === 'yes') {
    if (el.type === 'way' && !hasExplicitName) {
      return null;
    }
    return {
      category: 'offroad',
      subcategory: '4x4_pass',
      nameHe: nameHe || 'נקודת עבירות 4x4',
      nameEn: nameEn || '4WD Only Obstacle',
      hasExplicitName,
    };
  }

  if (
    tags.obstacle ||
    tags.smoothness === 'very_horrible' ||
    tags.smoothness === 'impassable' ||
    (tags.hazard && !URBAN_HAZARD_VALUES.has(tags.hazard))
  ) {
    if (tags.barrier && !hasExplicitName) return null;
    return {
      category: 'offroad',
      subcategory: 'obstacle',
      nameHe: nameHe || (tags.obstacle ? `מכשול שטח (${tags.obstacle})` : 'מכשול עבירות 4x4'),
      nameEn: nameEn || (tags.obstacle ? `Trail Obstacle (${tags.obstacle})` : '4x4 Terrain Obstacle'),
      hasExplicitName,
    };
  }

  // 3. CAMPSITES & BACKCOUNTRY SHELTERS
  if (
    tags.tourism === 'camp_site' ||
    tags.tourism === 'caravan_site' ||
    tags.tourism === 'wilderness_hut'
  ) {
    const sub = tags.tourism;
    const defHe =
      sub === 'caravan_site'
        ? 'חניון קרוואנים'
        : sub === 'wilderness_hut'
          ? 'בקתת מטיילים / מחסה'
          : 'חניון לילה';
    const defEn =
      sub === 'caravan_site'
        ? 'Caravan Site'
        : sub === 'wilderness_hut'
          ? 'Wilderness Hut'
          : 'Night Campsite';
    return {
      category: 'campsite',
      subcategory: sub,
      nameHe: nameHe || defHe,
      nameEn: nameEn || defEn,
      hasExplicitName,
    };
  }

  if (tags.tourism === 'picnic_site') {
    if (!hasExplicitName) return null;
    return {
      category: 'campsite',
      subcategory: 'picnic_site',
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  if (tags.amenity === 'shelter') {
    const isOutdoorShelterType = Boolean(
      tags.shelter_type && OUTDOOR_SHELTER_TYPES.has(tags.shelter_type)
    );
    const isUrbanBombShelterName = /^מקלט(\s|$|\d|-)/.test(nameHe) || /מקלט\s+(ציבורי|שכונ|עירונ|וידאו)/.test(nameHe);
    if (isUrbanBombShelterName || tags.civil_defense === 'yes') {
      return null;
    }
    if (!hasExplicitName && !isOutdoorShelterType) {
      return null;
    }
    return {
      category: 'campsite',
      subcategory: 'shelter',
      nameHe: nameHe || 'סככה / מחסה למטיילים',
      nameEn: nameEn || 'Trail Shelter',
      hasExplicitName,
    };
  }

  // 4. HERITAGE, VIEWPOINTS, CAVES, RUINS & ARCHAEOLOGY (require name)
  if (tags.natural === 'cave_entrance') {
    if (!hasExplicitName) return null;
    return {
      category: 'heritage',
      subcategory: 'cave',
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  if (tags.tourism === 'viewpoint') {
    if (!hasExplicitName) return null;
    return {
      category: 'heritage',
      subcategory: 'viewpoint',
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  if (
    tags.historic === 'archaeological_site' ||
    tags.historic === 'ruins' ||
    tags.historic === 'fort' ||
    tags.historic === 'castle' ||
    tags.historic === 'memorial' ||
    tags.historic === 'monument'
  ) {
    if (!hasExplicitName) return null;
    return {
      category: 'heritage',
      subcategory: tags.historic,
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  // 5. MOUNTAIN PEAKS (require name)
  if (tags.natural === 'peak') {
    if (!hasExplicitName) return null;
    return {
      category: 'peak',
      subcategory: 'peak',
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  // 6. NAMED OFF-ROAD / TRACK GATES (checked last so walled ruins/parks don't misclassify as gates)
  if (
    el.type === 'node' &&
    tags.barrier &&
    TRAIL_GATE_BARRIERS.has(tags.barrier) &&
    hasExplicitName
  ) {
    return {
      category: 'offroad',
      subcategory: 'gate',
      nameHe,
      nameEn,
      hasExplicitName: true,
    };
  }

  return null;
}

/**
 * Computes deterministic priority score matching PoiManager.getPoiSortPriority:
 * lower numbers = higher importance (rendered first on collision & listed first).
 */
export function computePoiPriority({
  isCurated = false,
  curatedIndex = 0,
  category,
  subcategory,
  ele = null,
  wikipedia = null,
  nameHe = '',
  hasExplicitDescription = false,
  hasExplicitName = true,
}) {
  if (isCurated) {
    return 100 + curatedIndex;
  }

  let score = 550;
  if (category === 'offroad') {
    score =
      subcategory === '4x4_pass'
        ? 200
        : subcategory === 'ford'
          ? 215
          : subcategory === 'obstacle'
            ? 220
            : 235;
  } else if (category === 'water') {
    score =
      subcategory === 'spring'
        ? 300
        : subcategory === 'waterhole'
          ? 305
          : subcategory === 'waterfall'
            ? 310
            : subcategory === 'cistern'
              ? 320
              : 330;
  } else if (category === 'campsite') {
    score =
      subcategory === 'camp_site' || subcategory === 'caravan_site'
        ? 400
        : subcategory === 'wilderness_hut'
          ? 405
          : subcategory === 'shelter'
            ? 415
            : 430;
  } else if (category === 'heritage') {
    score =
      subcategory === 'archaeological_site' || subcategory === 'fort' || subcategory === 'castle'
        ? 495
        : subcategory === 'viewpoint'
          ? 500
          : subcategory === 'cave'
            ? 505
            : subcategory === 'ruins'
              ? 515
              : 535;
  } else if (category === 'peak') {
    score = 620;
    if (typeof ele === 'number' && Number.isFinite(ele)) {
      score -= Math.min(80, Math.max(0, Math.round(ele / 30)));
    }
  }

  if (wikipedia) score -= 25;
  if (HEBREW_RE.test(nameHe)) score -= 10;
  if (hasExplicitDescription) score -= 8;
  if (!hasExplicitName) score += 40;

  return Math.max(150, score);
}

const VALID_WB_L4 = new Set([
  'יהודה ושומרון',
  'الضفة الغربية',
  'Judea and Samaria',
  'West Bank',
]);

/**
 * Decodes `admin_area` vector tiles directly from data/Israel.osm.pmtiles
 * so only coordinates inside Israel + Golan + Judea & Samaria are kept.
 */
export async function createIsraelBoundaryChecker(pmtilesPath = PMTILES_PATH) {
  if (!fs.existsSync(pmtilesPath)) {
    console.warn(`[POI Harvester] Warning: ${pmtilesPath} not found — falling back to rectangular bbox filter.`);
    return {
      bbox: DEFAULT_BBOX,
      usesPolygonBoundary: false,
      isInside: async (lon, lat) =>
        lon >= DEFAULT_BBOX.minLon &&
        lon <= DEFAULT_BBOX.maxLon &&
        lat >= DEFAULT_BBOX.minLat &&
        lat <= DEFAULT_BBOX.maxLat,
      close: () => {},
    };
  }

  const fd = fs.openSync(pmtilesPath, 'r');
  const pmtiles = new PMTiles({
    getKey: () => pmtilesPath,
    async getBytes(offset, length) {
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      return {
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead),
      };
    },
  });

  const header = await pmtiles.getHeader();
  const bbox = {
    minLon: Number.isFinite(header.minLon) ? header.minLon : DEFAULT_BBOX.minLon,
    minLat: Number.isFinite(header.minLat) ? header.minLat : DEFAULT_BBOX.minLat,
    maxLon: Number.isFinite(header.maxLon) ? header.maxLon : DEFAULT_BBOX.maxLon,
    maxLat: Number.isFinite(header.maxLat) ? header.maxLat : DEFAULT_BBOX.maxLat,
  };

  const tileCache = new Map();
  const MAX_CACHE_TILES = 3000;

  async function getAdminPolys(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tileCache.has(key)) return tileCache.get(key);

    const resp = await pmtiles.getZxy(z, x, y);
    let polys = [];
    if (resp?.data) {
      let bytes = new Uint8Array(resp.data);
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        bytes = new Uint8Array(zlib.gunzipSync(bytes));
      }
      const vt = new VectorTile(new PbfReader(bytes));
      const layer = vt.layers['admin_area'];
      if (layer) {
        polys = [];
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          if (f.type !== 3) continue;
          const p = f.properties || {};
          polys.push({
            level: Number(p.admin_level),
            name: String(p.name || ''),
            nameEn: String(p['name:en'] || ''),
            geom: f.toGeoJSON(x, y, z),
          });
        }
      }
    }

    if (tileCache.size >= MAX_CACHE_TILES) {
      const oldestKey = tileCache.keys().next().value;
      if (oldestKey !== undefined) tileCache.delete(oldestKey);
    }
    tileCache.set(key, polys);
    return polys;
  }

  async function isInside(lon, lat) {
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      lon < bbox.minLon ||
      lon > bbox.maxLon ||
      lat < bbox.minLat ||
      lat > bbox.maxLat
    ) {
      return false;
    }

    const pt = turf.point([lon, lat]);
    for (const z of [14, 10]) {
      const { x, y } = lonLatToTile(lon, lat, z);
      const polys = await getAdminPolys(z, x, y);
      if (polys.length === 0) continue;

      for (const poly of polys) {
        const isIsrael =
          poly.level === 2 && (poly.name === 'ישראל' || poly.nameEn === 'Israel');
        const isJudeaSamaria =
          poly.level === 4 &&
          (VALID_WB_L4.has(poly.name) || VALID_WB_L4.has(poly.nameEn));
        if ((isIsrael || isJudeaSamaria) && turf.booleanPointInPolygon(pt, poly.geom)) {
          return true;
        }
      }

      if (z === 14 && polys.length > 0) {
        return false;
      }
    }
    return false;
  }

  return {
    bbox,
    usesPolygonBoundary: true,
    isInside,
    close: () => {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore double close
      }
    },
  };
}

function buildOverpassBatches(bboxStr) {
  return [
    {
      name: 'water',
      query: `[out:json][timeout:90];(nwr["natural"="spring"](${bboxStr}); nwr["natural"="waterhole"](${bboxStr}); nwr["water"="waterhole"](${bboxStr}); nwr["waterway"="waterfall"](${bboxStr}); nwr["man_made"="cistern"](${bboxStr}); nwr["man_made"="water_well"](${bboxStr}););out center;`,
    },
    {
      name: 'viewpoint',
      query: `[out:json][timeout:90];nwr["tourism"="viewpoint"](${bboxStr});out center;`,
    },
    {
      name: 'cave',
      query: `[out:json][timeout:90];nwr["natural"="cave_entrance"](${bboxStr});out center;`,
    },
    {
      name: 'archaeology_ruins',
      query: `[out:json][timeout:90];(nw["historic"="archaeological_site"](${bboxStr}); nw["historic"="ruins"](${bboxStr}););out center;`,
    },
    {
      name: 'fort_memorial_monument',
      query: `[out:json][timeout:90];(nw["historic"="fort"](${bboxStr}); nw["historic"="castle"](${bboxStr}); nw["historic"="memorial"](${bboxStr}); nw["historic"="monument"](${bboxStr}););out center;`,
    },
    {
      name: 'campsite',
      query: `[out:json][timeout:90];(nwr["tourism"="camp_site"](${bboxStr}); nwr["tourism"="caravan_site"](${bboxStr}); nwr["tourism"="wilderness_hut"](${bboxStr}); nwr["tourism"="picnic_site"](${bboxStr}););out center;`,
    },
    {
      name: 'shelter',
      query: `[out:json][timeout:90];nwr["amenity"="shelter"]["shelter_type"!="public_transport"]["shelter_type"!="bomb_shelter"]["shelter_type"!="basic_hut"](${bboxStr});out center;`,
    },
    {
      name: 'offroad_tags',
      query: `[out:json][timeout:90];(nwr["mountain_pass"="yes"](${bboxStr}); nwr["ford"="yes"](${bboxStr}); nwr["4wd_only"="yes"](${bboxStr}); node["obstacle"](${bboxStr}); node["smoothness"~"^(very_horrible|impassable)$"](${bboxStr}); node["hazard"](${bboxStr}););out center;`,
    },
    {
      name: 'offroad_maale',
      query: `[out:json][timeout:90];(node["name"~"^מעלה "](${bboxStr}); way["highway"]["name"~"^מעלה "](${bboxStr}););out center;`,
    },
    {
      name: 'track_barriers',
      query: `[out:json][timeout:90];way["highway"="track"](${bboxStr})->.t;node(w.t)["barrier"];out body;`,
    },
    {
      name: 'peaks',
      query: `[out:json][timeout:90];node["natural"="peak"](${bboxStr});out body;`,
    },
  ];
}

async function fetchOverpassBatch(batch) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    const t0 = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': 'NavApp-Israel-Outdoor-Harvester/2.0',
        },
        body: 'data=' + encodeURIComponent(batch.query),
        signal: AbortSignal.timeout(95000),
      });
      if (!res.ok) {
        const bodySnippet = (await res.text()).replace(/\s+/g, ' ').slice(0, 140);
        throw new Error(`HTTP ${res.status} (${bodySnippet})`);
      }
      const data = await res.json();
      const elements = Array.isArray(data?.elements) ? data.elements : [];
      console.log(
        `[POI Harvester]   ✓ ${batch.name.padEnd(23)} ${String(elements.length).padStart(5)} elements (${Date.now() - t0}ms)`
      );
      return elements;
    } catch (err) {
      lastErr = err;
      const waitMs = attempt === 0 ? 1500 : 3500;
      console.warn(
        `[POI Harvester]   ! ${batch.name} attempt ${attempt + 1}/3 failed (${err.message}) — retrying in ${waitMs}ms...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr || new Error(`Batch ${batch.name} failed`);
}

function buildWaterStatus(tags) {
  const parts = [];
  if (tags.intermittent === 'yes' || tags.seasonal === 'yes') {
    parts.push('עונתי / זמני (Seasonal / Intermittent)');
  }
  if (tags.drinking_water === 'yes') {
    parts.push('מי שתייה (Drinking water)');
  } else if (tags.drinking_water === 'no') {
    parts.push('לא מיועד לשתייה (Non-potable)');
  }
  if (tags.depth) {
    parts.push(`עומק: ${tags.depth}`);
  }
  return parts.length > 0 ? parts.join(' • ') : null;
}

function buildDifficulty4x4(tags) {
  const parts = [];
  if (tags['4wd_only'] === 'yes') parts.push('4x4 בלבד (4WD Only)');
  if (tags.smoothness) parts.push(`עבירות: ${tags.smoothness}`);
  if (tags.tracktype) parts.push(`דרגת דרך: ${tags.tracktype}`);
  if (tags.sac_scale) parts.push(`דרגת שביל: ${tags.sac_scale}`);
  if (tags.obstacle) parts.push(`מכשול: ${tags.obstacle}`);
  if (tags.access) parts.push(`גישה: ${tags.access}`);
  return parts.length > 0 ? parts.join(' • ') : null;
}

function buildDescriptions(cls, nameHe, nameEn, tags) {
  const explicitHe =
    (typeof tags['description:he'] === 'string' && tags['description:he'].trim()) ||
    (typeof tags['note:he'] === 'string' && tags['note:he'].trim()) ||
    '';
  const explicitGeneric =
    (typeof tags.description === 'string' && tags.description.trim()) ||
    (typeof tags.note === 'string' && tags.note.trim()) ||
    '';
  const explicitEn =
    (typeof tags['description:en'] === 'string' && tags['description:en'].trim()) ||
    (!HEBREW_RE.test(explicitGeneric) ? explicitGeneric : '');

  const subLabelsHe = {
    spring: 'מעיין / מקור מים',
    waterhole: 'גב מים מדברי',
    waterfall: 'מפל מים',
    cistern: 'בור מים',
    water_well: 'באר מים',
    '4x4_pass': 'מעלה / מעבר 4x4',
    ford: 'מעבר מים בדרך עפר',
    obstacle: 'מכשול עבירות בשטח',
    gate: 'שער / מחסום בציר',
    camp_site: 'חניון לילה',
    caravan_site: 'חניון קרוואנים',
    wilderness_hut: 'בקתת שטח / מחסה',
    shelter: 'סככה / מחסה למטיילים',
    picnic_site: 'חניון פיקניק ויום',
    viewpoint: 'נקודת תצפית',
    cave: 'מערה',
    archaeological_site: 'אתר ארכיאולוגי',
    ruins: 'חורבה / שרידים עתיקים',
    fort: 'מבצר / מצד',
    castle: 'מצודה היסטורית',
    memorial: 'אנדרטה / אתר הנצחה',
    monument: 'ציון היסטורי / מונומנט',
    peak: 'פסגה / הר',
  };

  const heDefault = `${subLabelsHe[cls.subcategory] || 'נקודת עניין'} — ${nameHe} (מתוך מאגר OpenStreetMap ו-Israel Hiking Map).`;
  const descHe =
    explicitHe ||
    (HEBREW_RE.test(explicitGeneric) ? explicitGeneric : '') ||
    (explicitGeneric ? `${explicitGeneric} — ${heDefault}` : heDefault);

  const descEn =
    explicitEn ||
    `${nameEn} (${cls.category}: ${cls.subcategory}) sourced from OpenStreetMap Israel & Israel Hiking Map.`;

  return {
    descHe,
    descEn,
    hasExplicitDescription: Boolean(explicitHe || explicitEn || explicitGeneric),
  };
}

function getElementCoords(el) {
  if (typeof el.lon === 'number' && typeof el.lat === 'number') {
    return [el.lon, el.lat];
  }
  if (el.center && typeof el.center.lon === 'number' && typeof el.center.lat === 'number') {
    return [el.center.lon, el.center.lat];
  }
  return null;
}

function addToSpatialGrid(mapGrid, feature, stepDeg) {
  const [lon, lat] = feature.geometry.coordinates;
  const gx = Math.floor(lon / stepDeg);
  const gy = Math.floor(lat / stepDeg);
  const key = `${gx},${gy}`;
  let bucket = mapGrid.get(key);
  if (!bucket) {
    bucket = [];
    mapGrid.set(key, bucket);
  }
  bucket.push(feature);
}

function findMatchingNearby(mapGrid, lon, lat, stepDeg, radiusMeters, predicate) {
  const gx = Math.floor(lon / stepDeg);
  const gy = Math.floor(lat / stepDeg);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const maxMetersSq = radiusMeters * radiusMeters;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = mapGrid.get(`${gx + dx},${gy + dy}`);
      if (!bucket) continue;
      for (const existing of bucket) {
        const [elon, elat] = existing.geometry.coordinates;
        const mLon = (elon - lon) * 111320 * cosLat;
        const mLat = (elat - lat) * 111320;
        if (mLon * mLon + mLat * mLat <= maxMetersSq && predicate(existing)) {
          return existing;
        }
      }
    }
  }
  return null;
}

function writeFileAtomic(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, targetPath);
}

export async function runHarvester() {
  const tStart = Date.now();
  const boundary = await createIsraelBoundaryChecker(PMTILES_PATH);

  try {
    const { minLon, minLat, maxLon, maxLat } = boundary.bbox;
    const bboxStr = `${minLat.toFixed(4)},${minLon.toFixed(4)},${maxLat.toFixed(4)},${maxLon.toFixed(4)}`;
    console.log(
      `[POI Harvester] Bounding box: (${bboxStr}) | Polygon boundary: ${
        boundary.usesPolygonBoundary ? 'Israel + Golan + Judea & Samaria (from PMTiles)' : 'bbox fallback'
      }`
    );

    const batches = buildOverpassBatches(bboxStr);
    const osmByKey = new Map();
    let failedBatches = 0;

    for (const batch of batches) {
      try {
        const els = await fetchOverpassBatch(batch);
        for (const el of els) {
          if (!el || !el.type || !el.id) continue;
          const k = `${el.type[0]}${el.id}`;
          if (!osmByKey.has(k)) {
            osmByKey.set(k, el);
          }
        }
      } catch (err) {
        failedBatches++;
        console.error(`[POI Harvester]   ✗ Batch ${batch.name} failed completely: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 350));
    }

    if (osmByKey.size === 0 || failedBatches > 2) {
      throw new Error(
        `Overpass harvest aborted (${failedBatches}/${batches.length} failed batches, ${osmByKey.size} raw elements) — keeping existing POI files untouched.`
      );
    }

    console.log(`[POI Harvester] Raw unique OSM elements fetched: ${osmByKey.size}. Filtering by boundary & classifying...`);

    const features = [];
    // Spatial grids: tightGrid (~70m cell) for point dedupe; nameGrid (~650m cell) for split-way/node-vs-way collapse
    const tightGrid = new Map();
    const nameGrid = new Map();

    // 1. Curated flagship POIs first
    for (let idx = 0; idx < CURATED_ISRAEL_POIS.length; idx++) {
      const item = CURATED_ISRAEL_POIS[idx];
      const priority = computePoiPriority({
        isCurated: true,
        curatedIndex: idx,
        category: item.category,
        subcategory: item.subcategory,
        ele: item.ele ?? null,
        wikipedia: item.wikipedia ?? null,
        nameHe: item.nameHe,
        hasExplicitDescription: true,
        hasExplicitName: true,
      });

      const feat = {
        type: 'Feature',
        id: item.id,
        geometry: {
          type: 'Point',
          coordinates: item.coords,
        },
        properties: {
          id: item.id,
          name: item.nameHe,
          nameHe: item.nameHe,
          nameEn: item.nameEn,
          category: item.category,
          subcategory: item.subcategory,
          ele: item.ele ?? null,
          waterStatus: item.waterStatus ?? null,
          difficulty4x4: item.difficulty4x4 ?? null,
          descHe: item.descHe,
          descEn: item.descEn,
          source: item.source,
          wikipedia: item.wikipedia ?? null,
          priority,
        },
      };

      features.push(feat);
      addToSpatialGrid(tightGrid, feat, 0.0007);
      addToSpatialGrid(nameGrid, feat, 0.018);
    }

    // 2. Process OSM elements: sort nodes before ways, explicit names & wikipedia first so best representative wins dedupe
    const rawElements = Array.from(osmByKey.values());
    const typeRank = { node: 0, way: 1, relation: 2 };
    rawElements.sort((a, b) => {
      const ta = typeRank[a.type] ?? 3;
      const tb = typeRank[b.type] ?? 3;
      if (ta !== tb) return ta - tb;
      const wa = a.tags?.wikipedia || a.tags?.wikidata ? 0 : 1;
      const wb = b.tags?.wikipedia || b.tags?.wikidata ? 0 : 1;
      if (wa !== wb) return wa - wb;
      const ha = a.tags?.['name:he'] ? 0 : 1;
      const hb = b.tags?.['name:he'] ? 0 : 1;
      return ha - hb;
    });

    let skippedOutside = 0;
    let skippedClassifiedNull = 0;
    let skippedDuplicate = 0;

    for (const el of rawElements) {
      const coords = getElementCoords(el);
      if (!coords) continue;
      const [rawLon, rawLat] = coords;
      const lon = Number(rawLon.toFixed(6));
      const lat = Number(rawLat.toFixed(6));

      const cls = classifyOsmElement(el);
      if (!cls) {
        skippedClassifiedNull++;
        continue;
      }

      const inside = await boundary.isInside(lon, lat);
      if (!inside) {
        skippedOutside++;
        continue;
      }

      const tags = el.tags || {};
      const normHe = normalizeNameForDedupe(cls.nameHe);

      // Dedupe near curated or previously accepted POIs
      const nearSameCat = findMatchingNearby(
        tightGrid,
        lon,
        lat,
        0.0007,
        75,
        (existing) => existing.properties.category === cls.category
      );
      if (nearSameCat) {
        skippedDuplicate++;
        continue;
      }

      if (cls.hasExplicitName && normHe.length >= 3) {
        const normEn = normalizeNameForDedupe(cls.nameEn);
        const nameDedupeMeters =
          el.type === 'way' && cls.category === 'offroad' ? 1600 : 450;
        const nearSameName = findMatchingNearby(
          nameGrid,
          lon,
          lat,
          0.018,
          nameDedupeMeters,
          (existing) => {
            const exHe = normalizeNameForDedupe(existing.properties.nameHe);
            const exEn = normalizeNameForDedupe(existing.properties.nameEn);
            return exHe === normHe || (exEn && normEn && exEn === normEn);
          }
        );
        if (nearSameName) {
          skippedDuplicate++;
          continue;
        }
      }

      const parsedEle = tags.ele ? Number.parseInt(String(tags.ele), 10) : NaN;
      const ele = Number.isFinite(parsedEle) ? parsedEle : null;
      const wikipedia = tags.wikipedia || tags.wikidata || null;
      const { descHe, descEn, hasExplicitDescription } = buildDescriptions(
        cls,
        cls.nameHe,
        cls.nameEn,
        tags
      );

      const priority = computePoiPriority({
        isCurated: false,
        category: cls.category,
        subcategory: cls.subcategory,
        ele,
        wikipedia,
        nameHe: cls.nameHe,
        hasExplicitDescription,
        hasExplicitName: cls.hasExplicitName,
      });

      const id = `osm-${el.type[0]}${el.id}`;
      const feat = {
        type: 'Feature',
        id,
        geometry: {
          type: 'Point',
          coordinates: [lon, lat],
        },
        properties: {
          id,
          name: cls.nameHe,
          nameHe: cls.nameHe,
          nameEn: cls.nameEn,
          category: cls.category,
          subcategory: cls.subcategory,
          ele,
          waterStatus: cls.category === 'water' ? buildWaterStatus(tags) : null,
          difficulty4x4: cls.category === 'offroad' ? buildDifficulty4x4(tags) : null,
          descHe,
          descEn,
          source: 'OpenStreetMap Israel + IsraelHiking',
          wikipedia,
          priority,
        },
      };

      features.push(feat);
      addToSpatialGrid(tightGrid, feat, 0.0007);
      if (cls.hasExplicitName) {
        addToSpatialGrid(nameGrid, feat, 0.018);
      }
    }

    // 3. Reorder POIs strictly by priority (ascending), then North->South, id
    features.sort((a, b) => {
      const pa = a.properties.priority ?? 999;
      const pb = b.properties.priority ?? 999;
      if (pa !== pb) return pa - pb;
      const latDiff = b.geometry.coordinates[1] - a.geometry.coordinates[1];
      if (Math.abs(latDiff) > 1e-6) return latDiff;
      return String(a.id).localeCompare(String(b.id));
    });

    const countsByCategory = {};
    for (const f of features) {
      countsByCategory[f.properties.category] = (countsByCategory[f.properties.category] || 0) + 1;
    }

    const geojson = {
      type: 'FeatureCollection',
      metadata: {
        generatedAt: new Date().toISOString(),
        region: 'Israel + Golan + Judea & Samaria (Boundary Clipped)',
        minRenderZoom: 13,
        totalPois: features.length,
        countsByCategory,
        stats: {
          rawOverpassElements: osmByKey.size,
          skippedOutsideBoundary: skippedOutside,
          skippedFilteredTags: skippedClassifiedNull,
          skippedDuplicates: skippedDuplicate,
          failedBatches,
        },
        sources: [
          'OpenStreetMap Overpass API',
          'Israel.osm.pmtiles admin_area boundary',
          'IsraelHikingMap / Off-Road Community Curated Encyclopedia',
        ],
      },
      features,
    };

    const jsonString = JSON.stringify(geojson);
    for (const outPath of OUTPUT_FILES) {
      writeFileAtomic(outPath, jsonString);
      console.log(`[POI Harvester] Saved ${features.length} POIs (${(Buffer.byteLength(jsonString) / (1024 * 1024)).toFixed(2)} MB) -> ${outPath}`);
    }

    console.log('[POI Harvester] Summary by category:', JSON.stringify(countsByCategory));
    console.log(
      `[POI Harvester] Boundary excluded: ${skippedOutside} outside IL/J&S | Filtered noise: ${skippedClassifiedNull} | Deduped: ${skippedDuplicate} | Elapsed: ${((Date.now() - tStart) / 1000).toFixed(1)}s`
    );

    return geojson;
  } finally {
    boundary.close();
  }
}

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  runHarvester().catch((err) => {
    console.error('[POI Harvester] Fatal error:', err);
    process.exit(1);
  });
}
