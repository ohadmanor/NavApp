import {
  POI_CATEGORY_SPECS,
  POI_SYMBOL_BY_ID,
  POI_SYMBOL_LIST,
  type PoiBadgeShape,
  type PoiSymbolId,
} from './poiTaxonomy';

interface InnerGlyph {
  paths: string;
}

const INNER_GLYPHS: Record<PoiSymbolId, InnerGlyph> = {
  // ---- WATER (5) ----
  'poi-water-spring': {
    paths: `
      <path d="M18 9.2C18 9.2 12.6 15.8 12.6 19.8A5.4 5.4 0 0 0 23.4 19.8C23.4 15.8 18 9.2 18 9.2Z" fill="#ffffff"/>
      <path d="M15.8 20.2A2.4 2.4 0 0 0 18.2 22.6" fill="none" stroke="#0284c7" stroke-width="1.8" stroke-linecap="round"/>
    `,
  },
  'poi-water-pool': {
    paths: `
      <path d="M10.5 16.5C12.3 14.8 14.2 14.8 16 16.5C17.8 18.2 19.7 18.2 21.5 16.5C23.1 15 24.4 15 25.5 16.3" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M10.5 21.2C12.3 19.5 14.2 19.5 16 21.2C17.8 22.9 19.7 22.9 21.5 21.2C23.1 19.7 24.4 19.7 25.5 21" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <circle cx="18" cy="11.6" r="1.7" fill="#ffffff"/>
    `,
  },
  'poi-water-waterfall': {
    paths: `
      <path d="M12.5 11H22C23.4 11 24.2 11.9 24.2 13.4V20.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M19.8 13.5V21" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M15.2 14V21.2" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M11 24.3C12.7 23 14.5 23 16.2 24.3C17.9 25.6 19.7 25.6 21.4 24.3C22.8 23.2 24.1 23.2 25.2 24.3" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round"/>
    `,
  },
  'poi-water-cistern': {
    paths: `
      <path d="M11.5 23.5V15.5A6.5 6.5 0 0 1 24.5 15.5V23.5Z" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      <path d="M12.5 19.2C14.2 18 16 18 17.8 19.2C19.6 20.4 21.4 20.4 23.5 19.2V23H12.5Z" fill="#ffffff"/>
    `,
  },
  'poi-water-tap': {
    paths: `
      <path d="M11.5 14.5H20.5C22.2 14.5 23.5 15.8 23.5 17.5V19" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M14.5 11.5H19.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M17 11.5V14.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M23.5 21.2C23.5 21.2 21.4 23.7 21.4 25A2.1 2.1 0 0 0 25.6 25C25.6 23.7 23.5 21.2 23.5 21.2Z" fill="#ffffff"/>
    `,
  },

  // ---- OFFROAD (6) ----
  'poi-offroad-pass': {
    paths: `
      <path d="M12.2 18.6L18 12.6L23.8 18.6" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M12.2 23.6L18 17.6L23.8 23.6" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    `,
  },
  'poi-offroad-blocked': {
    paths: `
      <circle cx="18" cy="18" r="6.8" fill="none" stroke="#ffffff" stroke-width="2.2"/>
      <path d="M13 18H23" fill="none" stroke="#ffffff" stroke-width="2.8" stroke-linecap="round"/>
    `,
  },
  'poi-offroad-danger': {
    paths: `
      <path d="M18 11.2V19" fill="none" stroke="#ffffff" stroke-width="2.8" stroke-linecap="round"/>
      <circle cx="18" cy="23.5" r="1.75" fill="#ffffff"/>
    `,
  },
  'poi-offroad-mud': {
    paths: `
      <path d="M11.5 15.5L14.5 12.5L17.5 15.5L20.5 12.5L24.5 15.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M10.8 20.5C12.7 18.8 14.5 18.8 16.4 20.5C18.3 22.2 20.1 22.2 22 20.5C23.3 19.3 24.3 19.3 25.2 20.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M12.5 24.4H23.5" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/>
    `,
  },
  'poi-offroad-track': {
    paths: `
      <path d="M12.5 24C12.5 19.5 16.5 19.5 18 17.5C19.5 15.5 23.5 15.5 23.5 11.5" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="12.5" cy="24" r="1.8" fill="#ffffff"/>
      <circle cx="23.5" cy="11.5" r="1.8" fill="#ffffff"/>
    `,
  },
  'poi-offroad-service': {
    paths: `
      <rect x="12" y="12.2" width="7.8" height="11.5" rx="1.4" fill="none" stroke="#ffffff" stroke-width="2"/>
      <path d="M14 15.2H17.8" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
      <path d="M20 14.8L22.5 12.8V21.8A1.5 1.5 0 0 1 20 21.8" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    `,
  },

  // ---- CAMPSITE (4) ----
  'poi-campsite-night': {
    paths: `
      <path d="M18 10.8L10.5 23.5H25.5L18 10.8Z" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M18 17.2L15.4 23.5H20.6L18 17.2Z" fill="#ffffff"/>
    `,
  },
  'poi-campsite-picnic': {
    paths: `
      <path d="M11 14H25" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M9.5 18.8H26.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M14.2 14L11.8 23.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M21.8 14L24.2 23.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
    `,
  },
  'poi-campsite-khan': {
    paths: `
      <path d="M10.5 17.2L18 11.2L25.5 17.2" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M12.8 16.5V23.5H23.2V16.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      <path d="M16.2 23.5V19.2A1.8 1.8 0 0 1 19.8 19.2V23.5Z" fill="#ffffff"/>
    `,
  },
  'poi-campsite-fire': {
    paths: `
      <path d="M18.2 10.4C20.5 13.4 22.8 15.6 22.8 18.5A4.8 4.8 0 0 1 13.2 18.5C13.2 16.2 14.8 14.3 16 13C16.2 14.8 17.2 15.6 18 15.6C17.8 13.4 17.8 11.8 18.2 10.4Z" fill="#ffffff"/>
      <path d="M12.2 24.4L23.8 22.4" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
      <path d="M12.2 22.4L23.8 24.4" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
    `,
  },

  // ---- HERITAGE (7) ----
  'poi-heritage-landmark': {
    paths: `
      <path d="M11 14L18 10.4L25 14H11Z" fill="#ffffff"/>
      <path d="M13.2 15.8V21.8M18 15.8V21.8M22.8 15.8V21.8" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M10.8 23.6H25.2" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
    `,
  },
  'poi-heritage-ruins': {
    paths: `
      <path d="M11.5 23.5V14H14.5V16.5H17.5V12.5H20.8V18.5H24.5V23.5Z" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      <path d="M15.5 23.5V20A2.5 2.5 0 0 1 20.5 20V23.5" fill="none" stroke="#ffffff" stroke-width="1.9"/>
    `,
  },
  'poi-heritage-cave': {
    paths: `
      <path d="M9.8 23.5L13 13.8L18.2 11.2L23.5 14L26.2 23.5Z" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      <path d="M14.2 23.5V19.2A3.8 3.8 0 0 1 21.8 19.2V23.5Z" fill="#ffffff"/>
    `,
  },
  'poi-heritage-viewpoint': {
    paths: `
      <path d="M9.5 18C11.8 13.8 14.8 12.2 18 12.2C21.2 12.2 24.2 13.8 26.5 18C24.2 22.2 21.2 23.8 18 23.8C14.8 23.8 11.8 22.2 9.5 18Z" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linejoin="round"/>
      <circle cx="18" cy="18" r="2.7" fill="#ffffff"/>
    `,
  },
  'poi-heritage-monument': {
    paths: `
      <path d="M18 10L20.5 13.5V21.5H15.5V13.5L18 10Z" fill="#ffffff"/>
      <path d="M12.5 23.8H23.5" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>
    `,
  },
  'poi-heritage-nature': {
    paths: `
      <circle cx="18" cy="13.2" r="2.3" fill="#ffffff"/>
      <circle cx="13.5" cy="16.8" r="2.3" fill="#ffffff"/>
      <circle cx="22.5" cy="16.8" r="2.3" fill="#ffffff"/>
      <path d="M18 17.5V24.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round"/>
      <path d="M18 21.5C15.5 21.5 14 20.2 13.5 19" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"/>
    `,
  },
  'poi-heritage-holy': {
    paths: `
      <path d="M18 10.6L21.5 15.2H14.5L18 10.6Z" fill="#ffffff"/>
      <path d="M13 15.8H23V23.5H13Z" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="18" cy="19.6" r="1.8" fill="#ffffff"/>
    `,
  },

  // ---- PEAK (4) ----
  'poi-peak-summit': {
    paths: `
      <path d="M10.5 24.5L18 12.2L25.5 24.5Z" fill="#ffffff"/>
      <path d="M15.4 16.5L18 18.2L20.6 16.5" fill="none" stroke="#000000" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    `,
  },
  'poi-peak-saddle': {
    paths: `
      <path d="M10.2 24.2L14.6 15L18 20L21.4 15L25.8 24.2" fill="none" stroke="#ffffff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    `,
  },
  'poi-peak-crater': {
    paths: `
      <path d="M10.2 24.2L14.2 14.8H16.5L18 16.8L19.5 14.8H21.8L25.8 24.2Z" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linejoin="round"/>
    `,
  },
  'poi-peak-tower': {
    paths: `
      <path d="M13.5 15.5H22.5L21 12H15L13.5 15.5Z" fill="#ffffff"/>
      <path d="M15.2 15.5L13.2 24.8M20.8 15.5L22.8 24.8M14.5 20.5H21.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
    `,
  },

  // ---- USER (5) ----
  'poi-user-pin': {
    paths: `
      <circle cx="18" cy="15.5" r="4.2" fill="#ffffff"/>
      <circle cx="18" cy="15.5" r="1.8" fill="#911EB4"/>
    `,
  },
  'poi-user-flag': {
    paths: `
      <path d="M13.8 23.2V10.6" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M14.2 11L23.5 14L14.2 17.5Z" fill="#ffffff"/>
    `,
  },
  'poi-user-note': {
    paths: `
      <rect x="12.2" y="10.8" width="11.6" height="12.2" rx="2.2" fill="none" stroke="#ffffff" stroke-width="2"/>
      <path d="M15 14.6H21M15 18H19.5" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round"/>
    `,
  },
  'poi-user-star': {
    paths: `
      <path d="M18 10L20.1 14.2L24.7 14.9L21.3 18.1L22.1 22.7L18 20.5L13.9 22.7L14.7 18.1L11.3 14.9L15.9 14.2Z" fill="#ffffff"/>
    `,
  },
  'poi-user-service': {
    paths: `
      <path d="M18 11.2V21.2M13 16.2H23" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    `,
  },
};

function renderBadgeShape(
  shape: PoiBadgeShape,
  fillHex: string,
  accentHex: string,
  includeShadow: boolean
): string {
  const stroke = '#ffffff';
  const filterAttr = includeShadow ? ' filter="url(#badgeShadow)"' : '';

  switch (shape) {
    case 'circle-drop':
      return `<g${filterAttr}>
        <circle cx="18" cy="18" r="14.2" fill="${fillHex}" stroke="${stroke}" stroke-width="2.3"/>
        <circle cx="18" cy="18" r="11.8" fill="none" stroke="${accentHex}" stroke-opacity="0.35" stroke-width="1"/>
      </g>`;
    case 'diamond-shield':
      return `<g${filterAttr}>
        <path d="M18 3.2L32.8 18L18 32.8L3.2 18Z" fill="${fillHex}" stroke="${stroke}" stroke-width="2.3" stroke-linejoin="round"/>
      </g>`;
    case 'rounded-square':
      return `<g${filterAttr}>
        <rect x="4.5" y="4.5" width="27" height="27" rx="7.5" fill="${fillHex}" stroke="${stroke}" stroke-width="2.3"/>
      </g>`;
    case 'octagon':
      return `<g${filterAttr}>
        <polygon points="12.2,4 23.8,4 32,12.2 32,23.8 23.8,32 12.2,32 4,23.8 4,12.2" fill="${fillHex}" stroke="${stroke}" stroke-width="2.3" stroke-linejoin="round"/>
        <polygon points="12.9,5.6 23.1,5.6 30.4,12.9 30.4,23.1 23.1,30.4 12.9,30.4 5.6,23.1 5.6,12.9" fill="none" stroke="#111827" stroke-opacity="0.22" stroke-width="1" stroke-linejoin="round"/>
      </g>`;
    case 'triangle':
      return `<g${filterAttr}>
        <path d="M18 3.8L32.4 29.8H3.6Z" fill="${fillHex}" stroke="${stroke}" stroke-width="2.3" stroke-linejoin="round"/>
      </g>`;
    case 'pin-star':
      return `<g${filterAttr}>
        <path d="M18 3.6C11.4 3.6 6.2 8.8 6.2 15.2C6.2 22.8 15.6 31.2 17.3 32.6C17.7 32.9 18.3 32.9 18.7 32.6C20.4 31.2 29.8 22.8 29.8 15.2C29.8 8.8 24.6 3.6 18 3.6Z" fill="${fillHex}" stroke="${stroke}" stroke-width="2.3" stroke-linejoin="round"/>
      </g>`;
  }
}

export function buildPoiSymbolSvgInner(
  symbolId: PoiSymbolId,
  options: { includeShadow?: boolean } = {}
): string {
  const spec = POI_SYMBOL_BY_ID[symbolId];
  const catSpec = POI_CATEGORY_SPECS[spec.category];
  const fillHex = spec.fillHex || catSpec.fillHex;
  const accentHex = spec.accentHex || catSpec.accentHex;
  const includeShadow = options.includeShadow ?? false;
  const glyph = INNER_GLYPHS[symbolId];
  const glyphPaths =
    spec.category === 'heritage' ? glyph.paths.replace(/#ffffff/gi, '#111827') : glyph.paths;

  const defs = includeShadow
    ? `<defs>
        <filter id="badgeShadow" x="-15%" y="-15%" width="130%" height="135%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-color="#0f172a" flood-opacity="0.38"/>
        </filter>
      </defs>`
    : '';

  return `${defs}${renderBadgeShape(catSpec.shape, fillHex, accentHex, includeShadow)}${glyphPaths}`;
}

export function buildPoiSymbolSvgMarkup(
  symbolId: PoiSymbolId,
  options: { pixelSize?: number; includeShadow?: boolean } = {}
): string {
  const size = options.pixelSize ?? 36;
  const inner = buildPoiSymbolSvgInner(symbolId, { includeShadow: options.includeShadow });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 36 36">${inner}</svg>`;
}

export function getAllPoiSymbolSvgEntries(): Array<{ id: PoiSymbolId; svg1x: string; svg2x: string }> {
  return POI_SYMBOL_LIST.map((sym) => ({
    id: sym.id,
    svg1x: buildPoiSymbolSvgMarkup(sym.id, { pixelSize: 36, includeShadow: true }),
    svg2x: buildPoiSymbolSvgMarkup(sym.id, { pixelSize: 72, includeShadow: true }),
  }));
}
