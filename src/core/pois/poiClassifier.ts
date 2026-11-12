import type { PoiCategory } from '../db/NavDatabase';
import {
  isValidPoiCategory,
  normalizeSubcategoryForCategory,
  resolvePoiSymbolId,
  type PoiSymbolId,
} from './poiTaxonomy';

export interface ClassifyPoiInput {
  nameHe?: string | null;
  nameEn?: string | null;
  name?: string | null;
  descHe?: string | null;
  descEn?: string | null;
  waterStatus?: string | null;
  difficulty4x4?: string | null;
  existingCategory?: PoiCategory | string | null;
  existingSubcategory?: string | null;
  source?: string | null;
  ele?: number | null;
  wikipedia?: string | null;
}

export interface ClassifyPoiResult {
  category: PoiCategory;
  subcategory: string;
  symbolId: PoiSymbolId;
  confidence: number;
  scores: Record<PoiCategory, number>;
  reasons: string[];
}

const ALL_CATEGORIES: readonly PoiCategory[] = [
  'water',
  'offroad',
  'campsite',
  'heritage',
  'peak',
  'user',
];

const BOILERPLATE_DESC_PREFIX_RE =
  /^(?:אתר ארכיאולוגי|חורבה \/ שרידים עתיקים|נקודת תצפית|מערה|אנדרטה|אתר הנצחה|מעיין|גב מים|בור מים|חניון לילה|חניון יום|פסגה|מעלה|נקודת עניין)\s*[—–-]\s*/i;

const BOILERPLATE_DESC_SUFFIX_RE =
  /\(מתוך מאגר OpenStreetMap.*?\)|מקור\s*:?\s*עמוד ענן/gi;

const MUNICIPAL_OR_NON_FEATURE_RE =
  /(?:באר שבע|באר יעקב|באר טוביה|מעלה אדומים|מעלה אפרים|מעלה עירון|ראש העין|גבעתיים|רמת גן|רמת השרון|מבשרת ציון|נוף הגליל|עין כרם\s*\(שכונה\)|העין של|עין הרע|שומר החומות)/gi;

// Relational phrases in descriptions usually reference nearby landmarks, not the POI itself.
const RELATIONAL_CLAUSE_RE =
  /(?:^|[\s,.;])(?:מעל|מול|לכיוון|בדרך אל|בדרך ל|בדרך מ|סמוך ל|ליד ה|ליד|קרוב ל|משקיף על|צופה אל|צופה על|מדרום ל|מצפון ל|ממזרח ל|ממערב ל|מערבית ל|מזרחית ל|צפונית ל|דרומית ל|מתחת ל|בואכה)\s+[א-ת"׳'\-]{2,}(?:\s+[א-ת"׳'\-]{2,})?/g;

const NEGATIVE_WATER_CONTEXT_RE =
  /(?:בור (?:ריק|יבש|סתום)|מעיין (?:יבש|אכזב|סתום)|אמה יבשה|אין מים|ללא מים|יבש רוב השנה|חרב|שרידי (?:אמה|בריכה רומית))/i;

const BOTANICAL_OR_MEMORIAL_HILL_RE =
  /^(?:ה)?גבעת\s+(?:הכלניות|הרקפות|האירוסים|החלמוניות|הנרקיסים|הפרחים|התורמוסים|הקוצים|השבשבת|הקיבוצים|רועי|תום\s+ותומר)/i;

const NON_PEAK_SETTLEMENT_INTRO_RE =
  /(?:^|\s)(?:הוא|היא)\s+(?:כיום\s+מקום\s+מושבו|משכונות|מושב|קיבוץ|התנחלות|יישוב|ישוב|שכונה|כפר|מועצה\s+מקומית|עיר\s+בישראל|מוסד\s+חינוכי|חטיבת\s+ביניים|בית\s+ספר)|^\s*(?:קיבוץ|מושב|שכונת|יישוב|ישוב)\s|(?:\((?:מושב|יישוב|קיבוץ|מוסד\s+חינוכי|שכונה|ירושלים)\))/i;

const EXPLICIT_PEAK_INTRO_RE = /(?:^|\s)(?:הוא\s+הר|היא\s+גבעה|פסגה\s+בהר)/;

const ACTIVE_WATER_STATUS_RE =
  /(?:מלא|זורם|נובע|שכשוכית|טבילה|רחצה|מים נקיים|מים קרים|עמוק|רדוד|קיים מים|יש מים)/i;

const DRY_WATER_STATUS_RE = /(?:יבש|אין מים|ריק|סתום)/i;

interface KeywordRule {
  category: PoiCategory;
  subcategory: string;
  re: RegExp;
  weight: number;
  label: string;
}

// ---- Title Head Noun Rules (strongest indicator of what the POI actually IS) ----
const TITLE_HEAD_RULES: readonly KeywordRule[] = [
  // Water head nouns
  { category: 'water', subcategory: 'waterfall', re: /^(?:ה)?מפל(?:ון|י)?(?:\s|$|-)/i, weight: 95, label: 'head:waterfall' },
  { category: 'water', subcategory: 'spring', re: /^(?:ה)?(?:עין|עיינות|עינות|מעיין|מעין|נביעת|מבוע|מעיינות)(?:\s|$|-)/i, weight: 92, label: 'head:spring' },
  { category: 'water', subcategory: 'water_pool', re: /^(?:ה)?(?:גב|גבי|גבים|בריכת|בריכות|ברכת|שכשוכית|מעגורה|מאגר|אגם|נקבת)(?:\s|$|-)/i, weight: 92, label: 'head:pool' },
  { category: 'water', subcategory: 'cistern', re: /^(?:ה)?(?:בור|בורות|מאגורת|מאגורות|מאגורה|באר|בארות|ביר|ביאר|סכר|מקווה\s*מים|קבר\s*מים)(?:\s|$|-)/i, weight: 90, label: 'head:cistern' },
  { category: 'water', subcategory: 'drinking_water', re: /^(?:ה)?(?:ברז|ברזיית|מילוי\s*מים|מי\s*שתייה|מי\s*שתיה|שוקת)(?:\s|$|-)/i, weight: 90, label: 'head:tap' },

  // Offroad head nouns
  { category: 'offroad', subcategory: 'maale', re: /^(?:ה)?(?:מעלה|מעלות|דיונה|דיונת|מחמר|סרפנטינות)(?:\s|$|-)/i, weight: 92, label: 'head:maale' },
  { category: 'offroad', subcategory: 'blocked_road', re: /^(?:ה)?(?:שער\s*(?:נעול|סגור|חשמלי|צהוב|ברזל|בקר|חוסם|מעבר)|מחסום|חסימה|(?<!אין\s+)עץ\s*(?:חוסם|נפל)|דרך\s*חסומה|ציר\s*סגור|דרך\s*סגורה|בולי עץ|בולדר חוסם)(?:\s|$|-)/i, weight: 96, label: 'head:blocked' },
  { category: 'offroad', subcategory: 'danger', re: /^(?:ה)?(?:מדרגת|מדרגה|הצלבה|בור\s*בכביש|מפולת|סכנה|זהירות|אזהרה|קוליסים|מעבר\s*קשה|עבירות\s*קשה)(?:\s|$|-)/i, weight: 90, label: 'head:danger' },
  { category: 'offroad', subcategory: 'mud', re: /^(?:ה)?(?:בוץ|ביצה|שקיעה|הצפה|חציית\s*נחל|מעבר\s*מים|פורד)(?:\s|$|-)/i, weight: 90, label: 'head:mud' },
  { category: 'offroad', subcategory: 'fuel_4x4', re: /^(?:תחנת\s*דלק|דלק|פנצ['׳]?ריה|מוסך|חילוץ)(?:\s|$|-)/i, weight: 88, label: 'head:fuel' },
  { category: 'offroad', subcategory: 'offroad_track', re: /^(?:ציר\s*4x4|שביל\s*4x4|כניסה\s*ל(?:שטח|שביל|מסלול|נחל)|תחילת\s*מסלול|חניית\s*שטח|חנייה\s*חופשית)/i, weight: 88, label: 'head:track' },

  // Campsite head nouns
  { category: 'campsite', subcategory: 'camp_site', re: /^(?:ה)?(?:חניון\s*לילה|אתר\s*קמפינג|קמפינג|לינת\s*שטח|מחנה(?!\s+(?:צה["׳]?ל|צבאי|רע|עמיעד|נחשונים|נתן|יהודה|גלעד)))(?:\s|$|-)/i, weight: 95, label: 'head:night_camp' },
  { category: 'campsite', subcategory: 'picnic_site', re: /^(?:ה)?(?:חניון|חניון\s*יום|פארק\s*פיקניק|פארק(?!\s*\(?\s*גן\s*לאומי)|פינת\s*צל|חורשת|יער\s*פיקניק)(?:\s|$|-)/i, weight: 86, label: 'head:picnic' },
  { category: 'campsite', subcategory: 'khan', re: /^(?:ה)?(?:חאן|בקתת|בקתה|מחסה|אירוח\s*כפרי|אוהל\s*בדואי|צימר\s*שטח|אכסניית)(?:\s|$|-)/i, weight: 90, label: 'head:khan' },
  { category: 'campsite', subcategory: 'coffee_spot', re: /^(?:פינת\s*קפה|עצירה\s*לקפה|קפה\s*בשטח|מדורה|זולה)(?:\s|$|-)/i, weight: 90, label: 'head:coffee' },

  // Heritage head nouns
  { category: 'heritage', subcategory: 'viewpoint', re: /^(?:ה)?(?:תצפית|מצפה|מצפור|גג\s*נוף|מרפסת\s*נוף|lookout|viewpoint)(?:\s|$|-)/i, weight: 95, label: 'head:viewpoint' },
  { category: 'heritage', subcategory: 'cave', re: /^(?:ה)?(?:מערת|מערה|מערכת\s*מסתור|מחילת|נקרת|ניקרה|כוכי)(?:\s|$|-)/i, weight: 94, label: 'head:cave' },
  { category: 'heritage', subcategory: 'ruins', re: /^(?:ה)?(?:חורבת|חורבה|חירבת|חרבת|מצודת|מצודה|מבצר|מצד|תל|קסטל|ארמון|כנסייה\s*עתיקה|אמת\s*מים|עתיקות|פסיפס|גת|בית\s*בד|רוג['׳]ום)(?:\s|$|-)/i, weight: 92, label: 'head:ruins' },
  { category: 'heritage', subcategory: 'monument', re: /^(?:ה)?(?:אנדרטת|אנדרטה|מצבת|מצבה|יד\s*ל|קבר|מאוזוליאום|אתר\s*הנצחה|גלעד)(?:\s|$|-)/i, weight: 92, label: 'head:monument' },
  { category: 'heritage', subcategory: 'holy_site', re: /^(?:ה)?(?:בית\s*כנסת\s*עתיק|מנזר|מסגד|קבר\s*(?:צדיק|רבי|שייח)|נבי|מקדש)(?:\s|$|-)/i, weight: 92, label: 'head:holy' },
  { category: 'heritage', subcategory: 'nature_site', re: /^(?:ה)?(?:עץ|פריחת|אירוס|כלניות|צניר|עמוד\s*מלח|ארובה|מחשוף|קניון\s*גאולוגי|קשת\s*אבן|גשר\s*טבעי)(?:\s|$|-)/i, weight: 88, label: 'head:nature' },
  { category: 'heritage', subcategory: 'heritage_site', re: /^(?:מוזיאון|מרכז\s*מבקרים|בית\s*הביטחון|מגדל\s*שמירה|שלט\s*הסבר|מחנה\s*צאלים)(?:\s|$|-)/i, weight: 84, label: 'head:landmark' },

  // Peak head nouns
  { category: 'peak', subcategory: 'peak', re: /^(?:ה)?(?:הר|פסגת|פסגה|כיפת|גבעת|נ\.?\s*ג\.?|טריג)(?:\s|$|-)/i, weight: 88, label: 'head:peak' },
  { category: 'peak', subcategory: 'saddle', re: /^(?:ה)?(?:אוכף|שלוחת|שלוחה|רכס|כתף|סכין)(?:\s|$|-)/i, weight: 86, label: 'head:saddle' },
  { category: 'peak', subcategory: 'crater', re: /^(?:ה)?(?:מכתש|הר\s*געש|תל\s*געשי|לוע\s*געשי)(?:\s|$|-)/i, weight: 88, label: 'head:crater' },
  { category: 'peak', subcategory: 'fire_lookout', re: /^(?:מגדל\s*תצפית|מגדל\s*אש|מצפה\s*יערות)(?:\s|$|-)/i, weight: 86, label: 'head:tower' },

  // User / civic service head nouns
  { category: 'user', subcategory: 'civic_amenity', re: /^(?:בית\s*חולים|מרפאה|מיון|בית\s*מרקחת|סופרמרקט|מכולת|מסעדה|בית\s*קפה|אקווריום|גן\s*חיות|תחנת\s*רכבת|קניון\s*קניות)(?:\s|$|-)/i, weight: 85, label: 'head:civic' },
];

function kw(body: string, allowHebrewPrefix = true): RegExp {
  const prefix = allowHebrewPrefix ? '[בלהמכוש]?' : '';
  return new RegExp(
    `(?<![A-Za-z0-9\\u0590-\\u05FF])${prefix}(?:${body})(?![A-Za-z0-9\\u0590-\\u05FF])`,
    'i'
  );
}

// ---- Full-text weighted evidence patterns ----
const BODY_EVIDENCE_RULES: readonly KeywordRule[] = [
  // WATER
  { category: 'water', subcategory: 'waterfall', re: kw('waterfall|מפל\\s*מים|מפל\\s*יפה|מפלים|מפלונים|קניון\\s*עם\\s*מפלים|מפל(?:ון)?'), weight: 46, label: 'kw:waterfall' },
  { category: 'water', subcategory: 'water_pool', re: kw('water\\s*hole|swimming\\s*hole|גב\\s*מים|גבי\\s+[א-ת]{2,}|גבים(?:\\s*(?:מלאים|יפים|אחרי\\s*שיטפון))?|אחרי\\s*שיטפון|בריכת\\s*(?:שכשוך|קצינים|אגירה|מים|טבעית)|בריכות\\s*(?:אישיות|מים|טבעיות)|בריכה|שכשוכית|אמבטיות\\s*טבעיות|מעגורה|מים\\s*חמים\\s*וקרים'), weight: 48, label: 'kw:pool' },
  { category: 'water', subcategory: 'spring', re: kw('natural\\s*spring|נביעה|נביעות|מעיין(?:ות)?|מעין\\s+[א-ת]{2,}|עין\\s+[א-ת]{2,}|זרימה\\s*יפה'), weight: 42, label: 'kw:spring' },
  { category: 'water', subcategory: 'cistern', re: kw('water\\s*cistern|בור\\s*מים|בורות\\s*מים|מאגורה|מאגורות|באר\\s*מים|באר\\s*עמוקה|באר\\s*עתיקה|בית\\s*באר'), weight: 44, label: 'kw:cistern' },
  { category: 'water', subcategory: 'drinking_water', re: kw('drinking\\s*water|ברז\\s*מים|ברז\\s*שתייה|ברזיה|ברזייה|מי\\s*שתייה|מי\\s*שתיה|נקודת\\s*מילוי\\s*מים|מים\\s*זורמים\\s*בברז'), weight: 48, label: 'kw:tap' },

  // OFFROAD
  { category: 'offroad', subcategory: 'blocked_road', re: kw('שער\\s*(?:נעול|סגור|חשמלי|צהוב|ברזל|בקר)|מחסום\\s*פיזי|ציר\\s*חסום|דרך\\s*חסומה|חוסם\\s*את\\s*השביל|(?<!אין\\s+)עץ\\s*(?:נפל|חוסם)|דד\\s*אנד|סגור\\s*למעבר|אין\\s*מעבר|gate\\s*closed|road\\s*blocked'), weight: 58, label: 'kw:blocked' },
  { category: 'offroad', subcategory: 'danger', re: kw('מדרגת\\s*סלע|מדרגה\\s*(?:גבוהה|תלולה|קשה)|הצלבה|הצלבות|שיפוע\\s*צד|בולדרים|סכנת\\s*התהפכות|נעילת\\s*דיפרנציאל|הילוך\\s*כוח|low\\s*range|עבירות\\s*קשה|לרכבים\\s*גבוהים\\s*בלבד'), weight: 50, label: 'kw:danger' },
  { category: 'offroad', subcategory: 'mud', re: kw('בוץ\\s*עמוק|סכנת\\s*שקיעה|שקיעה\\s*בבוץ|הצפה|סכנת\\s*שיטפון|שיטפון\\s*חוסם|שביל\\s*מוצף|חציית\\s*נחל\\s*במים|ערוץ\\s*בוצי'), weight: 48, label: 'kw:mud' },
  { category: 'offroad', subcategory: 'maale', re: kw("מעלה(?:\\s+[א-ת]{2,})?|מעלה\\s*4x4|עלייה\\s*טכנית|עליה\\s*טכנית|ירידה\\s*תלולה|דרגת\\s*קושי|עבירות\\s*(?:בינונית|קלה|טכנית)|4x4|ג['׳]יפים|שטח\\s*טכני|מעברים\\s*טכניים|שנכבש"), weight: 46, label: 'kw:maale' },
  { category: 'offroad', subcategory: 'fuel_4x4', re: kw("תחנת\\s*דלק|סולר|פנצ['׳]רייה|פנצ['׳]ריה|תיקון\\s*תקרים|חילוץ\\s*שטח"), weight: 46, label: 'kw:fuel' },
  { category: 'offroad', subcategory: 'offroad_track', re: kw('ציר\\s*שטח|שביל\\s*לבן|דרך\\s*עפר|רחבת\\s*עפר|חניית\\s*שטח|נקודת\\s*התארגנות|הורדת\\s*אוויר|מילוי\\s*אוויר|מעבר\\s*טכני|פרויקט\\s*SOS\\s*WiFi'), weight: 44, label: 'kw:track' },

  // CAMPSITE
  { category: 'campsite', subcategory: 'camp_site', re: kw("חניון\\s*לילה|לינת\\s*שטח|שינה\\s*באוהלים|מתאים\\s*ללינה|לילה\\s*בשטח|campsite|camp\\s*site|קמפינג"), weight: 58, label: 'kw:night_camp' },
  { category: 'campsite', subcategory: 'camp_site', re: /אזור:\s*[^\n]+\s+גישה:\s*[^\n]+\s+מס['׳]?\s*מקומות\s*לינה/i, weight: 115, label: 'kw:rtg_camp_card' },
  { category: 'campsite', subcategory: 'picnic_site', re: kw('שולחנות\\s*פיקניק|ספסלי\\s*עץ|פיקניק|הצללה|עצי\\s*צל|חניון\\s*יום|חניון|ברזיית\\s*פיקניק|מנגל|picnic'), weight: 44, label: 'kw:picnic' },
  { category: 'campsite', subcategory: 'khan', re: kw('חאן|אירוח\\s*כפרי|מקלט\\s*מטיילים|בקתה|מאהל|לינה\\s*מסודרת|חדרי\\s*אירוח'), weight: 46, label: 'kw:khan' },
  { category: 'campsite', subcategory: 'coffee_spot', re: kw('פינת\\s*קפה|פינה\\s*יפה\\s*לקפה|מקום\\s*מושלם\\s*לקפה|פינת\\s*חמד\\s*לקפה|קפה\\s*בשטח|מדורה|מגרש\\s*מדורה|לקפה'), weight: 48, label: 'kw:coffee' },

  // HERITAGE
  { category: 'heritage', subcategory: 'viewpoint', re: kw('תצפית(?:\\s*(?:מרהיבה|פנורמית|יפה|מדהימה|נוף|על))?|מצפור|מצפה|נוף\\s*עוצר\\s*נשימה|viewpoint|panoram(?:ic|a)'), weight: 48, label: 'kw:viewpoint' },
  { category: 'heritage', subcategory: 'cave', re: kw('מערה|מערת\\s+[א-ת]{2,}|מערות|מערכת\\s*מסתור|נכנסים\\s*עם\\s*פנס|זחילה\\s*במערה|cave'), weight: 48, label: 'kw:cave' },
  { category: 'heritage', subcategory: 'ruins', re: kw("אתר\\s*ארכיאולוגי|חורבה|חורבת|חירבת|שרידי\\s*(?:מבנה|כפר|מצודה|פסיפס|אמת)|מצודה|מבצר|רומי|ביזנטי|נבטי|עות['׳]מאני|צלבני|archaeolog|ruins|עתיקות|פסיפס"), weight: 46, label: 'kw:ruins' },
  { category: 'heritage', subcategory: 'monument', re: kw('אנדרטה|אנדרטת|אתר\\s*הנצחה|זכרו\\s*של|לזכר|חללי|נופלים|מצבה|memorial|monument'), weight: 48, label: 'kw:monument' },
  { category: 'heritage', subcategory: 'holy_site', re: kw('בית\\s*כנסת\\s*עתיק|מנזר|מסגד|כנסייה|מקאם|אתר\\s*קדוש|קבר\\s*צדיק'), weight: 46, label: 'kw:holy' },
  { category: 'heritage', subcategory: 'nature_site', re: kw('פריחה|אירוסים|צבעונים|שקדיות|עץ\\s*(?:עתיק|ענק|שיטה|תות|אלון|זית)|צניר(?:ים)?|גאולוגי|מאובנים|עמוד\\s*מלח|ארובה|בולען'), weight: 44, label: 'kw:nature' },
  { category: 'heritage', subcategory: 'heritage_site', re: kw('מרכז\\s*מבקרים|מוזיאון|סיפור\\s*היסטורי|שלט\\s*הסבר|התיישבות|אונייה|ספינה\\s*טרופה'), weight: 38, label: 'kw:landmark' },

  // PEAK
  { category: 'peak', subcategory: 'peak', re: kw('פסגת\\s*ההר|פסגה|נקודת\\s*טריג|נקודה\\s*גבוהה|גג\\s*האזור|הר\\s*גבוה|elevation\\s*\\d{3,4}|summit|mountain\\s*peak'), weight: 44, label: 'kw:peak' },
  { category: 'peak', subcategory: 'saddle', re: kw('אוכף|מעבר\\s*הרים|שלוחה\\s*צרה|מצוק\\s*מרשים'), weight: 42, label: 'kw:saddle' },
  { category: 'peak', subcategory: 'crater', re: kw('מכתש|הר\\s*געש|לוע\\s*געשי|תל\\s*געשי|קילוח\\s*בזלת'), weight: 44, label: 'kw:crater' },

  // USER / CIVIC
  { category: 'user', subcategory: 'civic_amenity', re: kw('מסעדה|מסעדות|גלידות|אזור\\s*בילוי|קניון\\s*קניות|סופרמרקט|מרפאה|חדר\\s*מיון|בית\\s*מרקחת|אקווריום|גן\\s*חיות'), weight: 42, label: 'kw:civic' },
];

export function sanitizePoiText(raw?: string | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/[\u0591-\u05C7]/g, '') // strip niqqud
    .replace(/[\r\n\t]+/g, ' ')
    .replace(BOILERPLATE_DESC_SUFFIX_RE, ' ')
    .replace(BOILERPLATE_DESC_PREFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskMunicipalNames(text: string): string {
  return text.replace(MUNICIPAL_OR_NON_FEATURE_RE, ' ');
}

function splitFirstSentence(desc: string): { firstSentence: string; rest: string } {
  if (!desc) return { firstSentence: '', rest: '' };
  const idx = desc.search(/[.!?•|](?:\s|$)/);
  if (idx === -1 || idx > 160) {
    return { firstSentence: desc.slice(0, 160), rest: desc.slice(160) };
  }
  return { firstSentence: desc.slice(0, idx + 1), rest: desc.slice(idx + 1) };
}

function stripRelationalClauses(desc: string): { subjectText: string; relationalText: string } {
  const relMatches: string[] = [];
  const subjectText = desc.replace(RELATIONAL_CLAUSE_RE, (m) => {
    relMatches.push(m);
    return ' ';
  });
  return {
    subjectText: subjectText.replace(/\s+/g, ' ').trim(),
    relationalText: relMatches.join(' ').trim(),
  };
}

/**
 * Text-integrated multi-signal POI classifier.
 * Analyzes title head-noun, title keywords, structured fields (waterStatus, difficulty4x4),
 * contextualized description sentences, and source priors while preserving strict
 * 1-to-1 category-to-symbol partitioning via `poiTaxonomy.ts`.
 */
export function classifyPoiWithText(input: ClassifyPoiInput): ClassifyPoiResult {
  const titleRaw = sanitizePoiText(input.nameHe || input.name || input.nameEn || '');
  const titleEnRaw = sanitizePoiText(input.nameEn || '');
  const titleClean = maskMunicipalNames(`${titleRaw} ${titleEnRaw}`.trim());

  const descHeClean = sanitizePoiText(input.descHe);
  const descEnClean = sanitizePoiText(input.descEn);
  const combinedDesc = maskMunicipalNames(`${descHeClean} ${descEnClean}`.trim());

  const waterStatus = sanitizePoiText(input.waterStatus);
  const diff4x4 = sanitizePoiText(input.difficulty4x4);

  const scores: Record<PoiCategory, number> = {
    water: 0,
    offroad: 0,
    campsite: 0,
    heritage: 0,
    peak: 0,
    user: 0,
  };

  const subScores: Record<PoiCategory, Map<string, number>> = {
    water: new Map(),
    offroad: new Map(),
    campsite: new Map(),
    heritage: new Map(),
    peak: new Map(),
    user: new Map(),
  };

  const reasons: string[] = [];

  const addScore = (
    cat: PoiCategory,
    sub: string,
    pts: number,
    reason?: string
  ) => {
    if (!Number.isFinite(pts) || pts === 0) return;
    scores[cat] += pts;
    const prev = subScores[cat].get(sub) ?? 0;
    subScores[cat].set(sub, prev + pts);
    if (reason) reasons.push(`${reason}(+${pts})`);
  };

  // 1. Structured domain attributes
  if (waterStatus) {
    if (ACTIVE_WATER_STATUS_RE.test(waterStatus)) {
      addScore('water', 'spring', 110, 'field:waterStatusActive');
    } else if (!DRY_WATER_STATUS_RE.test(waterStatus)) {
      addScore('water', 'spring', 65, 'field:waterStatus');
    } else {
      addScore('water', 'cistern', 22, 'field:waterStatusDry');
    }
  }
  if (diff4x4) {
    addScore('offroad', 'maale', 110, 'field:difficulty4x4');
  }

  const isBotanicalOrMemorialHill = BOTANICAL_OR_MEMORIAL_HILL_RE.test(titleRaw);
  const isSettlementDesc =
    Boolean(combinedDesc) &&
    NON_PEAK_SETTLEMENT_INTRO_RE.test(combinedDesc.slice(0, 180)) &&
    !EXPLICIT_PEAK_INTRO_RE.test(combinedDesc.slice(0, 100));

  // 2. Title Head-Noun matching (strongest linguistic identity signal)
  for (const rule of TITLE_HEAD_RULES) {
    if (rule.re.test(titleRaw) || (titleEnRaw && rule.re.test(titleEnRaw))) {
      if (rule.label === 'head:peak' && (isBotanicalOrMemorialHill || isSettlementDesc)) {
        continue;
      }
      addScore(rule.category, rule.subcategory, rule.weight, rule.label);
    }
  }
  if (isSettlementDesc && /^(?:הר|גבעת|נ\.?\s*ג\.?)\s/i.test(titleRaw)) {
    addScore('heritage', 'heritage_site', 75, 'guard:settlement_hill');
  }

  // 3. Body/keyword evidence on Title (weight x1.15)
  for (const rule of BODY_EVIDENCE_RULES) {
    if (rule.re.test(titleClean)) {
      addScore(rule.category, rule.subcategory, Math.round(rule.weight * 1.15), `title:${rule.label}`);
    }
  }

  // 4. Contextualized Description Scoring (guard against relational phrases like "מעל עין עקב")
  if (combinedDesc) {
    const { firstSentence, rest } = splitFirstSentence(combinedDesc);
    const firstCtx = stripRelationalClauses(firstSentence);
    const restCtx = stripRelationalClauses(rest);

    const hasNegWater = NEGATIVE_WATER_CONTEXT_RE.test(combinedDesc);

    for (const rule of BODY_EVIDENCE_RULES) {
      let pts = 0;
      if (firstCtx.subjectText && rule.re.test(firstCtx.subjectText)) {
        pts += rule.weight;
      } else if (restCtx.subjectText && rule.re.test(restCtx.subjectText)) {
        pts += Math.round(rule.weight * 0.65);
      } else if (
        (firstCtx.relationalText && rule.re.test(firstCtx.relationalText)) ||
        (restCtx.relationalText && rule.re.test(restCtx.relationalText))
      ) {
        // Relational mention (e.g. "view overlooking spring") contributes very little
        pts += Math.round(rule.weight * 0.15);
      }

      if (pts > 0) {
        if (rule.category === 'water' && hasNegWater && !ACTIVE_WATER_STATUS_RE.test(waterStatus)) {
          pts = Math.round(pts * 0.35);
        }
        addScore(rule.category, rule.subcategory, pts, `desc:${rule.label}`);
      }
    }
  }

  // 5. Existing Source Tag Prior (helps preserve genuine OSM/specific tags; ignores generic catch-alls)
  const rawSub = String(input.existingSubcategory || '').trim().toLowerCase();
  const isGenericCatchAll =
    !rawSub ||
    rawSub === 'poi' ||
    rawSub === 'offroad_poi' ||
    rawSub === 'offroad_photo' ||
    rawSub === 'imported_wpt' ||
    rawSub === 'imported_kml' ||
    rawSub === 'imported_geojson' ||
    rawSub === 'imported_twl';

  if (isValidPoiCategory(input.existingCategory)) {
    if (!isGenericCatchAll) {
      const normalizedSub = normalizeSubcategoryForCategory(input.existingCategory, rawSub);
      const priorWeight =
        rawSub === 'wifi_sos' || rawSub === 'ratag_info'
          ? 125
          : input.existingCategory === 'peak'
            ? 68
            : rawSub === 'offroad_track'
              ? 35
              : 65;
      addScore(input.existingCategory, normalizedSub, priorWeight, `prior:${input.existingCategory}:${rawSub}`);
    } else if (rawSub === 'offroad_poi' || rawSub === 'offroad_photo') {
      // Tiny heritage prior only if NO water/offroad/campsite/peak cues appear anywhere
      addScore('heritage', 'heritage_site', 6, `weak_fallback:${rawSub}`);
    }
  }

  // Extra disambiguation: Off-Road.io photo/POI describing trail navigation without landmark/view/water cues
  const srcLower = String(input.source || '').toLowerCase();
  if (
    srcLower.includes('off-road') &&
    (rawSub === 'offroad_poi' || rawSub === 'offroad_photo')
  ) {
    if (/(?:ציר|מסלול|שבילים|ק"מ|פנייה|מזלג|פיצול|צומת\s*שבילים|רמפה|מחסום)/.test(`${titleRaw} ${combinedDesc}`)) {
      addScore('offroad', 'offroad_track', 24, 'offroad:trail_context');
    } else if (
      scores.water === 0 &&
      scores.offroad === 0 &&
      scores.campsite === 0 &&
      /(?:צילום|תמונה|נוף)/.test(`${titleRaw} ${combinedDesc}`)
    ) {
      addScore('heritage', 'viewpoint', 14, 'offroad:photo_scenic');
    }
  }

  // 6. Pick winning category deterministically
  let bestCategory: PoiCategory = 'heritage';
  let bestScore = -1;
  for (const cat of ALL_CATEGORIES) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      bestCategory = cat;
    }
  }

  // If no signal scored cleanly at all, fall back safely
  if (bestScore <= 0) {
    bestCategory = isValidPoiCategory(input.existingCategory) ? input.existingCategory : 'heritage';
  }

  // Pick winning exclusive subcategory strictly within `bestCategory`
  let bestSubcategory = '';
  let bestSubScore = -1;
  for (const [sub, sc] of subScores[bestCategory].entries()) {
    if (sc > bestSubScore) {
      bestSubScore = sc;
      bestSubcategory = sub;
    }
  }

  const normalizedSub = normalizeSubcategoryForCategory(bestCategory, bestSubcategory);
  const symbolId = resolvePoiSymbolId(bestCategory, normalizedSub);

  const sortedVals = Object.values(scores).sort((a, b) => b - a);
  const runnerUp = sortedVals[1] ?? 0;
  const confidence =
    bestScore <= 0
      ? 0.25
      : Number(Math.min(0.99, Math.max(0.35, (bestScore - runnerUp * 0.45) / Math.max(40, bestScore))).toFixed(2));

  return {
    category: bestCategory,
    subcategory: normalizedSub,
    symbolId,
    confidence,
    scores,
    reasons,
  };
}
