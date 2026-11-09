import type { PoiCategory } from '../db/NavDatabase';

export type SearchFilterCategory = 'all' | 'places' | 'nature' | 'roads' | 'pois' | 'routes';

export interface SearchTaxonomyInfo {
  heLabel: string;
  emoji: string;
  poiCategory: PoiCategory;
  filterGroup: Exclude<SearchFilterCategory, 'all' | 'routes'>;
  recommendedZoom: number;
  synonyms: string;
}

export const SEARCH_FILTER_TABS: Array<{
  id: SearchFilterCategory;
  label: string;
  emoji: string;
}> = [
  { id: 'all', label: 'הכל', emoji: '✦' },
  { id: 'places', label: 'יישובים', emoji: '🏙️' },
  { id: 'nature', label: 'טבע ופסגות', emoji: '🏔️' },
  { id: 'roads', label: 'כבישים ושבילים', emoji: '🛣️' },
  { id: 'pois', label: 'נקודות עניין', emoji: '📍' },
  { id: 'routes', label: 'מסלולים', emoji: '🥾' },
];

export function resolveSearchTaxonomy(
  layer: string,
  cls: string,
  subclass: string
): SearchTaxonomyInfo {
  if (layer === 'place') {
    switch (cls) {
      case 'country':
        return {
          heLabel: 'מדינה',
          emoji: '🇮🇱',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 7.5,
          synonyms: 'מדינה ארץ country state',
        };
      case 'region':
      case 'state':
        return {
          heLabel: 'אזור / חבל ארץ',
          emoji: '🗺️',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 9.8,
          synonyms: 'אזור חבל ארץ מחוז נגב גליל ערבה region',
        };
      case 'city':
        return {
          heLabel: 'עיר',
          emoji: '🏙️',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 12.2,
          synonyms: 'עיר ערים מרכז city',
        };
      case 'town':
        return {
          heLabel: 'עיר / מועצה',
          emoji: '🏘️',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 13.2,
          synonyms: 'עיר מועצה מקומית יישוב town city',
        };
      case 'village':
        return {
          heLabel: 'יישוב / קיבוץ / מושב',
          emoji: '🏡',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 14.2,
          synonyms: 'יישוב כפר קיבוץ מושב מצפה קהילתי village kibbutz moshav',
        };
      case 'suburb':
      case 'quarter':
      case 'neighbourhood':
        return {
          heLabel: 'שכונה / רובע',
          emoji: '🏘️',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 14.8,
          synonyms: 'שכונה רובע אזור suburb neighbourhood quarter',
        };
      case 'square':
        return {
          heLabel: 'כיכר',
          emoji: '⛲',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 16.0,
          synonyms: 'כיכר רחבה מרכז square plaza',
        };
      case 'island':
        return {
          heLabel: 'אי',
          emoji: '🏝️',
          poiCategory: 'heritage',
          filterGroup: 'nature',
          recommendedZoom: 14.5,
          synonyms: 'אי איים island',
        };
      default:
        return {
          heLabel: 'יישוב / חווה / אתר',
          emoji: '🏡',
          poiCategory: 'heritage',
          filterGroup: 'places',
          recommendedZoom: 14.6,
          synonyms: 'חווה יישוב קטן מאחז אתר locality farm hamlet',
        };
    }
  }

  if (layer === 'admin_area') {
    return {
      heLabel:
        cls === 'lvl_2'
          ? 'מדינה / גבול'
          : cls === 'lvl_4'
            ? 'מחוז'
            : 'נפה / מועצה אזורית',
      emoji: '🗺️',
      poiCategory: 'heritage',
      filterGroup: 'places',
      recommendedZoom: cls === 'lvl_2' ? 7.5 : cls === 'lvl_4' ? 9.5 : 10.8,
      synonyms: 'מחוז נפה מועצה אזורית רשות מקומית admin district council region',
    };
  }

  if (layer === 'mountain_peak') {
    return {
      heLabel: 'פסגה / הר',
      emoji: '🏔️',
      poiCategory: 'peak',
      filterGroup: 'nature',
      recommendedZoom: 14.5,
      synonyms: 'הר פסגה גבעה מצוק נג טריגונומטרית הר גבוה mountain peak hill mount summit',
    };
  }

  if (layer === 'park') {
    return {
      heLabel: 'שמורת טבע / גן לאומי',
      emoji: '🌲',
      poiCategory: 'campsite',
      filterGroup: 'nature',
      recommendedZoom: 13.0,
      synonyms: 'שמורת טבע שמורה גן לאומי פארק יער national park nature reserve forest',
    };
  }

  if (layer === 'aerodrome_label') {
    return {
      heLabel: 'שדה תעופה / מנחת',
      emoji: '✈️',
      poiCategory: 'offroad',
      filterGroup: 'pois',
      recommendedZoom: 13.6,
      synonyms: 'שדה תעופה נמל תעופה מנחת בסיס חיל אוויר תעופה airport airfield airbase',
    };
  }

  if (layer === 'aeroway') {
    return {
      heLabel: 'מסלול תעופה',
      emoji: '🛫',
      poiCategory: 'offroad',
      filterGroup: 'roads',
      recommendedZoom: 14.5,
      synonyms: 'מסלול המראה נחיתה תעופה runway taxiway',
    };
  }

  if (layer === 'water') {
    if (cls === 'lake') {
      return {
        heLabel: 'אגם / מאגר מים',
        emoji: '🏞️',
        poiCategory: 'water',
        filterGroup: 'nature',
        recommendedZoom: 13.2,
        synonyms: 'אגם מאגר ים כנרת מלוח מים בריכה lake reservoir sea pond',
      };
    }
    if (cls === 'river') {
      return {
        heLabel: 'נהר / נחל ראשי',
        emoji: '🌊',
        poiCategory: 'water',
        filterGroup: 'nature',
        recommendedZoom: 13.6,
        synonyms: 'נהר נחל ואדי ערוץ מים river stream wadi',
      };
    }
    if (cls === 'canal' || cls === 'drain' || cls === 'ditch') {
      return {
        heLabel: 'תעלה / אמת מים',
        emoji: '💧',
        poiCategory: 'water',
        filterGroup: 'nature',
        recommendedZoom: 14.5,
        synonyms: 'תעלה אמה ניקוז מים canal drain',
      };
    }
    return {
      heLabel: 'נחל / ואדי / ערוץ',
      emoji: '💧',
      poiCategory: 'water',
      filterGroup: 'nature',
      recommendedZoom: 14.2,
      synonyms: 'נחל ואדי ערוץ מים מעיין עין גב stream wadi creek spring',
    };
  }

  if (layer === 'flood_defence') {
    if (cls === 'ridge' || cls === 'embankment') {
      return {
        heLabel: 'שלוחה / רכס / מצוק',
        emoji: '⛰️',
        poiCategory: 'peak',
        filterGroup: 'nature',
        recommendedZoom: 14.5,
        synonyms: 'שלוחה רכס הר סוללה מצוק ridge',
      };
    }
    if (cls === 'breakwater') {
      return {
        heLabel: 'שובר גלים / מזח',
        emoji: '⚓',
        poiCategory: 'heritage',
        filterGroup: 'nature',
        recommendedZoom: 15.2,
        synonyms: 'שובר גלים מזח נמל חוף breakwater pier',
      };
    }
    return {
      heLabel: 'סכר / מאגר',
      emoji: '🚧',
      poiCategory: 'water',
      filterGroup: 'nature',
      recommendedZoom: 15.0,
      synonyms: 'סכר מים מאגר נחל dam weir',
    };
  }

  if (layer === 'road') {
    if (cls === 'motorway' || cls === 'trunk') {
      return {
        heLabel: 'כביש מהיר / ראשי',
        emoji: '🛣️',
        poiCategory: 'offroad',
        filterGroup: 'roads',
        recommendedZoom: 13.5,
        synonyms: 'כביש דרך מהירה מחלף route highway motorway trunk road',
      };
    }
    if (cls === 'primary' || cls === 'secondary' || cls === 'tertiary') {
      return {
        heLabel: 'כביש / דרך ראשית',
        emoji: '🛣️',
        poiCategory: 'offroad',
        filterGroup: 'roads',
        recommendedZoom: 14.5,
        synonyms: 'כביש צומת דרך מסלול route road primary secondary',
      };
    }
    if (cls === 'track') {
      return {
        heLabel: 'דרך עפר / מעלה 4x4',
        emoji: '🚙',
        poiCategory: 'offroad',
        filterGroup: 'roads',
        recommendedZoom: 15.0,
        synonyms: 'דרך עפר שביל גיפים מעלה עבירות שטח 4x4 track offroad pass trail',
      };
    }
    if (cls === 'path') {
      return {
        heLabel: 'שביל הליכה',
        emoji: '🥾',
        poiCategory: 'heritage',
        filterGroup: 'roads',
        recommendedZoom: 15.2,
        synonyms: 'שביל הליכה מסלול טיול רגלי סימון שבילים path trail hiking',
      };
    }
    if (cls === 'cycleway') {
      return {
        heLabel: 'שביל אופניים / סינגל',
        emoji: '🚴',
        poiCategory: 'offroad',
        filterGroup: 'roads',
        recommendedZoom: 15.2,
        synonyms: 'אופניים סינגל שביל אופניים cycleway mtb bike',
      };
    }
    if (cls === 'rail') {
      return {
        heLabel: 'מסילת רכבת',
        emoji: '🚆',
        poiCategory: 'offroad',
        filterGroup: 'roads',
        recommendedZoom: 14.2,
        synonyms: 'רכבת מסילה rail railway',
      };
    }
    if (cls === 'aerialway') {
      return {
        heLabel: 'רכבל',
        emoji: '🚡',
        poiCategory: 'heritage',
        filterGroup: 'roads',
        recommendedZoom: 15.0,
        synonyms: 'רכבל גונדולה cable car aerialway',
      };
    }
    if (cls === 'ferry') {
      return {
        heLabel: 'מעבורת / שיט',
        emoji: '⛴️',
        poiCategory: 'water',
        filterGroup: 'roads',
        recommendedZoom: 14.2,
        synonyms: 'מעבורת שיט סירה ferry',
      };
    }
    return {
      heLabel: 'רחוב / דרך',
      emoji: '🛣️',
      poiCategory: 'heritage',
      filterGroup: 'roads',
      recommendedZoom: 16.0,
      synonyms: 'רחוב שדרות סמטה דרך כתובת street road avenue alley',
    };
  }

  if (layer === 'building') {
    return {
      heLabel: 'מבנה',
      emoji: '🏢',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'בניין מבנה מרכז building tower',
    };
  }

  if (layer === 'landcover') {
    return {
      heLabel: 'יער / תכסית טבע',
      emoji: '🌿',
      poiCategory: 'campsite',
      filterGroup: 'nature',
      recommendedZoom: 14.5,
      synonyms: 'יער חורשה שטח טבעי forest wood landcover',
    };
  }

  // layer === 'poi'
  const pair = `${cls}:${subclass}`;
  if (pair === 'attraction:viewpoint') {
    return {
      heLabel: 'תצפית / מצפה',
      emoji: '🔭',
      poiCategory: 'heritage',
      filterGroup: 'nature',
      recommendedZoom: 15.5,
      synonyms: 'תצפית מצפה נוף תצפיות viewpoint lookout vista',
    };
  }
  if (cls === 'castle' || subclass === 'ruins' || pair === 'historic:monument') {
    return {
      heLabel:
        pair === 'historic:monument' ? 'אנדרטה / אתר הנצחה' : 'עתיקות / חורבה / מצודה',
      emoji: pair === 'historic:monument' ? '🗿' : '🏛️',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 15.5,
      synonyms: 'חורבה עתיקות תל מבצר מצודה אנדרטה זיכרון ארכיאולוגיה ruins castle monument memorial',
    };
  }
  if (cls === 'campsite' || subclass === 'camp_site' || subclass === 'caravan_site') {
    return {
      heLabel: 'חניון לילה / קמפינג',
      emoji: '⛺',
      poiCategory: 'campsite',
      filterGroup: 'nature',
      recommendedZoom: 15.2,
      synonyms: 'חניון לילה קמפינג לינת שטח אוהלים קראוונים campsite camping',
    };
  }
  if (subclass === 'picnic_site' || subclass === 'bbq') {
    return {
      heLabel: 'חניון פיקניק / יום',
      emoji: '🧺',
      poiCategory: 'campsite',
      filterGroup: 'nature',
      recommendedZoom: 15.5,
      synonyms: 'חניון פיקניק חניון יום מנגל קקל שולחנות picnic bbq day',
    };
  }
  if (subclass === 'alpine_hut' || subclass === 'shelter') {
    return {
      heLabel: 'מחסה / בקתת מטיילים / סככה',
      emoji: '🛖',
      poiCategory: 'campsite',
      filterGroup: 'nature',
      recommendedZoom: 15.6,
      synonyms: 'מחסה בקתה סככה צל מסתור מלאך שביל shelter hut',
    };
  }
  if (cls === 'lodging') {
    return {
      heLabel: 'אירוח / מלון / צימר',
      emoji: '🏨',
      poiCategory: 'campsite',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'מלון אכסניה אירוח צימר לינה חאן hotel hostel guesthouse lodging',
    };
  }
  if (cls === 'park' || subclass === 'garden' || subclass === 'dog_park' || subclass === 'playground') {
    return {
      heLabel: 'פארק / גן',
      emoji: '🌳',
      poiCategory: 'campsite',
      filterGroup: 'nature',
      recommendedZoom: 15.8,
      synonyms: 'פארק גן גינה משחקים טבע park garden playground',
    };
  }
  if (subclass === 'swimming' || subclass === 'swimming_area' || cls === 'swimming') {
    return {
      heLabel: 'מעיין / בריכה / רחצה',
      emoji: '💧',
      poiCategory: 'water',
      filterGroup: 'nature',
      recommendedZoom: 15.6,
      synonyms: 'מים בריכה רחצה מעיין גב ים חוף swimming spring pool',
    };
  }
  if (cls === 'harbor' || subclass === 'ferry_terminal') {
    return {
      heLabel: 'נמל / מרינה / מעגן',
      emoji: '⚓',
      poiCategory: 'water',
      filterGroup: 'pois',
      recommendedZoom: 15.2,
      synonyms: 'נמל מרינה מעגן סירות מעבורת harbor marina port',
    };
  }
  if (subclass === 'fuel') {
    return {
      heLabel: 'תחנת דלק',
      emoji: '⛽',
      poiCategory: 'offroad',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'תחנת דלק תדלוק בנזין סולר גז fuel gas station',
    };
  }
  if (subclass === 'parking' || subclass === 'bicycle_parking' || subclass === 'motorcycle_parking') {
    return {
      heLabel: 'חניה / חניון',
      emoji: '🅿️',
      poiCategory: 'offroad',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'חניה חניון מגרש רכב parking lot',
    };
  }
  if (cls === 'railway' || subclass === 'train_station_entrance' || subclass === 'subway_entrance') {
    return {
      heLabel: 'תחנת רכבת / רק״ל',
      emoji: '🚆',
      poiCategory: 'offroad',
      filterGroup: 'pois',
      recommendedZoom: 15.6,
      synonyms: 'תחנת רכבת רכבת ישראל רכבת קלה מטרו railway train station tram',
    };
  }
  if (subclass === 'bus_station') {
    return {
      heLabel: 'תחנה מרכזית / מסוף',
      emoji: '🚉',
      poiCategory: 'offroad',
      filterGroup: 'pois',
      recommendedZoom: 15.6,
      synonyms: 'תחנה מרכזית מסוף אוטובוסים bus station terminal',
    };
  }
  if (cls === 'bus' || subclass === 'bus_stop') {
    return {
      heLabel: 'תחנת אוטובוס',
      emoji: '🚌',
      poiCategory: 'offroad',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'תחנת אוטובוס אוטובוס bus stop',
    };
  }
  if (cls === 'hospital' || subclass === 'clinic' || subclass === 'doctors' || subclass === 'dentist') {
    return {
      heLabel: subclass === 'hospital' ? 'בית חולים / מרכז רפואי' : 'מרפאה / רופא',
      emoji: '🏥',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'בית חולים מרפאה קופת חולים רופא מיון רפואה עזרה ראשונה hospital clinic medical',
    };
  }
  if (subclass === 'pharmacy') {
    return {
      heLabel: 'בית מרקחת',
      emoji: '💊',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.4,
      synonyms: 'בית מרקחת סופר פארם תרופות pharmacy',
    };
  }
  if (subclass === 'police' || subclass === 'fire_station') {
    return {
      heLabel: subclass === 'police' ? 'תחנת משטרה' : 'תחנת כיבוי אש',
      emoji: subclass === 'police' ? '🚓' : '🚒',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'משטרה כיבוי אש כבאות הצלה ביטחון police fire station',
    };
  }
  if (cls === 'barrier') {
    return {
      heLabel: subclass === 'border_control' ? 'מעבר גבול' : 'שער / מחסום',
      emoji: '🚧',
      poiCategory: 'offroad',
      filterGroup: 'roads',
      recommendedZoom: 16.0,
      synonyms: 'שער מחסום מעבר גבול בקר שטח gate barrier border',
    };
  }
  if (cls === 'information') {
    return {
      heLabel: subclass === 'visitor_centre' ? 'מרכז מבקרים' : 'תחנת מידע / שלט',
      emoji: 'ℹ️',
      poiCategory: 'heritage',
      filterGroup: 'nature',
      recommendedZoom: 16.0,
      synonyms: 'מרכז מבקרים מידע שלט הכוונה מפה visitor centre information guidepost',
    };
  }
  if (cls === 'place_of_worship') {
    if (subclass === 'jewish') {
      return {
        heLabel: 'בית כנסת / אתר יהודי',
        emoji: '🕍',
        poiCategory: 'heritage',
        filterGroup: 'pois',
        recommendedZoom: 16.2,
        synonyms: 'בית כנסת ישיבה תפילה קבר יהודי synagogue jewish',
      };
    }
    if (subclass === 'muslim') {
      return {
        heLabel: 'מסגד / מקאם',
        emoji: '🕌',
        poiCategory: 'heritage',
        filterGroup: 'pois',
        recommendedZoom: 16.2,
        synonyms: 'מסגד מקאם תפילה מוסלמי mosque muslim',
      };
    }
    if (subclass === 'christian') {
      return {
        heLabel: 'כנסייה / מנזר',
        emoji: '⛪',
        poiCategory: 'heritage',
        filterGroup: 'pois',
        recommendedZoom: 16.2,
        synonyms: 'כנסייה מנזר נוצרי church monastery christian',
      };
    }
    return {
      heLabel: 'אתר דת ותפילה',
      emoji: '🛐',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'אתר דת מקדש תפילה worship',
    };
  }
  if (cls === 'attraction' || cls === 'tourism' || cls === 'art_gallery') {
    return {
      heLabel:
        subclass === 'museum'
          ? 'מוזיאון'
          : subclass === 'zoo'
            ? 'גן חיות'
            : subclass === 'theme_park'
              ? 'פארק שעשועים'
              : 'אטרקציה / תרבות',
      emoji: '🏛️',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 15.8,
      synonyms: 'אטרקציה מוזיאון גלריה אמנות תיירות מבקרים museum attraction gallery tourism',
    };
  }
  if (cls === 'amenity' && subclass === 'restaurant') {
    return {
      heLabel: 'מסעדה',
      emoji: '🍽️',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'מסעדה אוכל ארוחה חומוס בשרים restaurant dining',
    };
  }
  if (cls === 'fast_food') {
    return {
      heLabel: 'מזון מהיר / מזנון',
      emoji: '🍔',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'מזון מהיר פלאפל שווארמה פיצה המבורגר fast food',
    };
  }
  if (cls === 'cafe' || cls === 'ice_cream') {
    return {
      heLabel: 'בית קפה / גלידריה',
      emoji: '☕',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'קפה בית קפה עגלת קפה מאפה גלידה cafe coffee ice cream',
    };
  }
  if (cls === 'bar' || cls === 'beer') {
    return {
      heLabel: 'בר / פאב',
      emoji: '🍺',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'בר פאב מבשלה בירה יין pub bar',
    };
  }
  if (cls === 'grocery' || subclass === 'supermarket' || subclass === 'convenience' || subclass === 'mall') {
    return {
      heLabel:
        subclass === 'mall' || subclass === 'shopping_centre'
          ? 'קניון / מרכז קניות'
          : subclass === 'bakery'
            ? 'מאפייה'
            : 'סופרמרקט / מכולת',
      emoji: '🛒',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'סופר סופרמרקט מכולת מינימרקט חנות קניון מרכז מסחרי צרכניה supermarket grocery convenience mall',
    };
  }
  if (cls === 'shop' || cls === 'clothing_store' || cls === 'car' || cls === 'alcohol_shop') {
    return {
      heLabel: subclass === 'bakery' ? 'מאפייה' : subclass === 'car_repair' ? 'מוסך / רכב' : 'חנות / עסק',
      emoji: subclass === 'car_repair' ? '🔧' : '🛍️',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'חנות מוסך ציוד קניות עסק shop store bakery',
    };
  }
  if (cls === 'school' || cls === 'college') {
    return {
      heLabel:
        cls === 'college'
          ? 'אוניברסיטה / מכללה'
          : subclass === 'kindergarten'
            ? 'גן ילדים'
            : 'בית ספר',
      emoji: '🎓',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'בית ספר תיכון יסודי גן אוניברסיטה מכללה קמפוס school college university kindergarten',
    };
  }
  if (cls === 'sport' || cls === 'pitch' || cls === 'stadium' || cls === 'leisure' || cls === 'golf') {
    return {
      heLabel: cls === 'stadium' ? 'אצטדיון' : 'מתקן ספורט / מגרש',
      emoji: '⚽',
      poiCategory: 'campsite',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'ספורט אצטדיון מגרש כדורגל כדורסל טניס בריכה קאנטרי sport pitch stadium pool',
    };
  }
  if (subclass === 'bank') {
    return {
      heLabel: 'בנק / כספומט',
      emoji: '🏦',
      poiCategory: 'user',
      filterGroup: 'pois',
      recommendedZoom: 16.2,
      synonyms: 'בנק כספומט bank atm',
    };
  }
  if (subclass === 'toilets') {
    return {
      heLabel: 'שירותים ציבוריים',
      emoji: '🚻',
      poiCategory: 'campsite',
      filterGroup: 'pois',
      recommendedZoom: 16.4,
      synonyms: 'שירותים נוחיות toilets restroom wc',
    };
  }
  if (cls === 'cemetery') {
    return {
      heLabel: 'בית עלמין',
      emoji: '🪦',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 15.8,
      synonyms: 'בית קברות בית עלמין קבר cemetery grave',
    };
  }
  if (cls === 'town_hall' || cls === 'post' || cls === 'library') {
    return {
      heLabel:
        subclass === 'townhall'
          ? 'עירייה / מועצה'
          : cls === 'post'
            ? 'דואר'
            : cls === 'library'
              ? 'ספרייה'
              : 'מוסד ציבורי',
      emoji: '🏛️',
      poiCategory: 'heritage',
      filterGroup: 'pois',
      recommendedZoom: 16.0,
      synonyms: 'עירייה מועצה מתנס בית קהילה דואר ספרייה תרבות townhall community post library',
    };
  }

  return {
    heLabel: 'נקודת עניין',
    emoji: '📍',
    poiCategory: 'heritage',
    filterGroup: 'pois',
    recommendedZoom: 15.6,
    synonyms: 'נקודת עניין אתר מקום poi place',
  };
}
