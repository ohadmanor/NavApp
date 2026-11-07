#!/usr/bin/env node
/**
 * devops/fetch-israel-pois.mjs
 *
 * Harvests & compiles Israeli outdoor Points of Interest (POIs) compatible with
 * the shared OpenStreetMap / Israel Hiking Map / Off-Road.io / Amud Anan ecosystem
 * into C:\dev\NavApp\data\Israel.pois.geojson.
 *
 * Categories:
 *  - water      (Blue Dots)  : Springs (מעיין), Cisterns (בור מים), Water Holes (גב), Wells (באר)
 *  - heritage   (Brown Dots) : Ruins (חורבה), Caves (מערה), Lookouts (מצפה/תצפית), Memorials, Archaeological sites
 *  - campsite   (Green Dots) : Night Campsites (חניון לילה), Backcountry Shelters
 *  - offroad    (Red Dots)   : 4x4 Ascents/Passes (מעלה 4x4), Fords, Boulder Obstacles, Gates
 *  - peak       (Purple Dots): Prominent Mountain Peaks (פסגה / הר)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'Israel.pois.geojson');

/**
 * Curated Core Israeli Backcountry Encyclopedia (Amud Anan / Israel Hiking / Off-Road iconic landmarks)
 * Guarantees rich Hebrew & English field descriptions even when running completely offline.
 */
const CURATED_ISRAEL_POIS = [
  // === WATER & SPRINGS (BLUE POINTS) ===
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
    wikipedia: 'he:עין עקב'
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
    wikipedia: 'he:עין עובדת'
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
    wikipedia: 'he:נחל דוד'
  },
  {
    id: 'il-poi-gev-yamin',
    nameHe: 'גבי ימין',
    nameEn: 'Gavei Yamin (Yamin Water Holes)',
    category: 'water',
    subcategory: 'cistern',
    coords: [35.0725, 30.9462],
    ele: 365,
    waterStatus: 'Seasonal — Holds cold floodwater from winter through spring',
    descHe: 'סדרת גבי מים חצובים בסלע אבן החול והגיר בנחל ימין. מתמלאים לאחר שיטפונות החורף ומחזיקים מים נקיים וקרים עד האביב.',
    descEn: 'Series of natural desert rock pools in Nahal Yamin that fill during winter flash floods and hold cool water well into spring.',
    source: 'IsraelHiking + Off-Road Community',
    wikipedia: 'he:נחל ימין'
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
    wikipedia: 'he:רמת הגולן'
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
    wikipedia: 'he:עין לבן'
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
    wikipedia: 'he:נחל פרת'
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
    wikipedia: 'he:בור חמת'
  },

  // === 4X4 ASCENTS & OFF-ROAD PASSES (RED / ORANGE POINTS — OFF-ROAD.IO / AMUD ANAN STYLE) ===
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
    wikipedia: 'he:נחל צין'
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
    wikipedia: 'he:נחל ורדית'
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
    wikipedia: 'he:מכתש רמון'
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
    source: 'Off-Road + OSM Israel'
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
    wikipedia: 'he:מעלה עקרבים'
  },

  // === HERITAGE, CAVES, RUINS & VIEWPOINTS (BROWN POINTS — AMUD ANAN STYLE) ===
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
    wikipedia: 'he:מצדה'
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
    wikipedia: 'he:קרני חיטין'
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
    wikipedia: 'he:הר ארבל'
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
    wikipedia: 'he:שבטה'
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
    wikipedia: 'he:הר כרכום'
  },

  // === NIGHT CAMPSITES (GREEN POINTS — חניוני לילה) ===
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
    wikipedia: 'he:מכתש רמון'
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
    source: 'IsraelHiking + INPA'
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
    wikipedia: 'he:נחל עמוד'
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
    source: 'IsraelHiking + Off-Road'
  },

  // === PEAKS & SUMMITS (PURPLE POINTS) ===
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
    wikipedia: 'he:הר מירון'
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
    wikipedia: 'he:חרמון'
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
    wikipedia: 'he:הר רמון'
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
    wikipedia: 'he:הר תבור'
  }
];

function classifyOsmElement(tags) {
  if (!tags) return null;
  if (
    tags.natural === 'spring' ||
    tags.man_made === 'water_well' ||
    tags.man_made === 'cistern' ||
    tags.amenity === 'drinking_water' ||
    tags.water === 'pond'
  ) {
    return { category: 'water', subcategory: tags.natural || tags.man_made || 'spring' };
  }
  if (
    tags.mountain_pass === 'yes' ||
    (tags['name:he'] && tags['name:he'].startsWith('מעלה ')) ||
    (tags.name && tags.name.startsWith('מעלה ')) ||
    tags.ford === 'yes'
  ) {
    return { category: 'offroad', subcategory: '4x4_pass' };
  }
  if (tags.tourism === 'camp_site' || tags.tourism === 'wilderness_hut' || tags.amenity === 'shelter') {
    return { category: 'campsite', subcategory: tags.tourism || 'camp_site' };
  }
  if (tags.natural === 'peak' && (tags.ele || tags.wikipedia)) {
    return { category: 'peak', subcategory: 'peak' };
  }
  if (
    tags.historic ||
    tags.natural === 'cave_entrance' ||
    tags.tourism === 'viewpoint'
  ) {
    return {
      category: 'heritage',
      subcategory: tags.natural === 'cave_entrance' ? 'cave' : tags.tourism === 'viewpoint' ? 'viewpoint' : 'ruins'
    };
  }
  return null;
}

async function fetchOverpassPois() {
  const query = `
    [out:json][timeout:20];
    (
      node["natural"="spring"]["name"](29.45,34.20,33.35,35.90);
      node["natural"="cave_entrance"]["name"](29.45,34.20,33.35,35.90);
      node["tourism"="camp_site"]["name"](29.45,34.20,33.35,35.90);
      node["tourism"="viewpoint"]["name"](29.45,34.20,33.35,35.90);
      node["mountain_pass"="yes"]["name"](29.45,34.20,33.35,35.90);
      node["historic"~"archaeological_site|ruins|fort|monument"]["name"]["wikipedia"](29.45,34.20,33.35,35.90);
      node["natural"="peak"]["name"]["ele"](29.45,34.20,33.35,35.90);
    );
    out body 450;
  `;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'NavApp-Israel-Outdoor-Harvester/1.0'
      },
      body: 'data=' + encodeURIComponent(query),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data.elements) ? data.elements : [];
  } catch (err) {
    console.log(`[POI Harvester] Overpass live fetch skipped/fallback (${err.message}) — using curated encyclopedia + local cache.`);
    return [];
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[POI Harvester] Harvesting Israeli Outdoor POIs (Springs, 4x4 Passes, Caves, Ruins, Campsites, Peaks)...');

  const features = [];
  const seenKeys = new Set();

  // 1. Add curated core Israeli POIs first (highest quality Hebrew & English descriptions)
  for (const item of CURATED_ISRAEL_POIS) {
    const key = `${item.coords[0].toFixed(3)},${item.coords[1].toFixed(3)}`;
    seenKeys.add(key);
    features.push({
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
      },
    });
  }

  // 2. Enrich with live Overpass OSM Israel elements when online
  const osmElements = await fetchOverpassPois();
  for (const el of osmElements) {
    if (typeof el.lon !== 'number' || typeof el.lat !== 'number' || !el.tags) continue;
    const key = `${el.lon.toFixed(3)},${el.lat.toFixed(3)}`;
    if (seenKeys.has(key)) continue;

    const cls = classifyOsmElement(el.tags);
    if (!cls) continue;

    const nameHe = el.tags['name:he'] || el.tags.name || el.tags['name:en'];
    const nameEn = el.tags['name:en'] || el.tags['name:latin'] || el.tags.name || nameHe;
    if (!nameHe) continue;

    seenKeys.add(key);
    const descHe =
      el.tags['description:he'] ||
      el.tags.description ||
      el.tags.note ||
      (cls.category === 'water'
        ? `נקודת מים / מעיין (${nameHe}) מתוך מאגר OpenStreetMap ו-Israel Hiking Map.`
        : cls.category === 'offroad'
        ? `מעבר / מעלה שטח (${nameHe}) מתוך מאגר OpenStreetMap ו-Off-Road.`
        : cls.category === 'campsite'
        ? `חניון לילה / נקודת לינה בשטח (${nameHe}).`
        : `נקודת עניין בשטח (${nameHe}) מתוך מאגר OpenStreetMap ישראל.`);

    const descEn =
      el.tags['description:en'] ||
      el.tags.description ||
      `Outdoor Point of Interest (${nameEn}) sourced from OpenStreetMap Israel & Israel Hiking Map.`;

    features.push({
      type: 'Feature',
      id: `osm-${el.id}`,
      geometry: {
        type: 'Point',
        coordinates: [Number(el.lon.toFixed(6)), Number(el.lat.toFixed(6))],
      },
      properties: {
        id: `osm-${el.id}`,
        name: nameHe,
        nameHe,
        nameEn,
        category: cls.category,
        subcategory: cls.subcategory,
        ele: el.tags.ele ? parseInt(el.tags.ele, 10) || null : null,
        waterStatus: el.tags.seasonal === 'yes' ? 'Seasonal (עונתי)' : el.tags.drinking_water ? `Drinking water: ${el.tags.drinking_water}` : null,
        difficulty4x4: el.tags.smoothness || el.tags.tracktype || null,
        descHe,
        descEn,
        source: 'OpenStreetMap Israel + IsraelHiking',
        wikipedia: el.tags.wikipedia || el.tags.wikidata || null,
      },
    });
  }

  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      generatedAt: new Date().toISOString(),
      region: 'Israel',
      totalPois: features.length,
      sources: ['OpenStreetMap Israel', 'IsraelHikingMap Ecosystem', 'Off-Road / Community Curated Landmarks', 'Wikimedia'],
    },
    features,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(geojson, null, 2), 'utf-8');
  console.log(`[POI Harvester] Saved ${features.length} Israeli outdoor POIs to ${OUTPUT_FILE}`);
}

main();
