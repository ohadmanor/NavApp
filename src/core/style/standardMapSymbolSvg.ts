export interface StandardMapSymbolSvgEntry {
  id: string;
  svg1x: string;
  svg2x: string;
}

const SHADOW_DEFS = `<defs>
  <filter id="stdShadow" x="-18%" y="-18%" width="136%" height="140%">
    <feDropShadow dx="0" dy="1.1" stdDeviation="1.1" flood-color="#0f172a" flood-opacity="0.34"/>
  </filter>
</defs>`;

function wrapSvg(inner: string, pixelSize: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="0 0 36 36">${SHADOW_DEFS}${inner}</svg>`;
}

function circleBadge(fillHex: string, paths: string): string {
  return `<g filter="url(#stdShadow)">
    <circle cx="18" cy="18" r="13.8" fill="${fillHex}" stroke="#ffffff" stroke-width="2.2"/>
  </g>${paths}`;
}

function squircleBadge(fillHex: string, paths: string): string {
  return `<g filter="url(#stdShadow)">
    <rect x="4.6" y="4.6" width="26.8" height="26.8" rx="7.2" fill="${fillHex}" stroke="#ffffff" stroke-width="2.2"/>
  </g>${paths}`;
}

function lightCircleBadge(ringHex: string, paths: string): string {
  return `<g filter="url(#stdShadow)">
    <circle cx="18" cy="18" r="13.6" fill="#ffffff" stroke="${ringHex}" stroke-width="2.2"/>
  </g>${paths}`;
}

function haloGlyph(paths: string): string {
  return `<g filter="url(#stdShadow)">${paths}</g>`;
}

const STANDARD_MAP_SVG_INNER: Record<string, string> = {
  // Core navigation, transit & utility icons
  parking: squircleBadge(
    '#2563EB',
    `<path d="M13.5 25V11H19C21.9 11 23.7 12.7 23.7 15.3C23.7 17.9 21.9 19.6 19 19.6H13.5" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
  ),
  gas: circleBadge(
    '#334155',
    `<rect x="11.5" y="11" width="9" height="14" rx="1.6" fill="none" stroke="#ffffff" stroke-width="2.1"/>
     <rect x="13.4" y="13.2" width="5.2" height="3.6" rx="0.6" fill="#ffffff"/>
     <path d="M20.5 14.2L23 12.2V21.5A1.6 1.6 0 0 1 20.5 21.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
     <path d="M10.2 25H21.8" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`
  ),
  square: squircleBadge(
    '#1D4ED8',
    `<rect x="11.5" y="10.2" width="13" height="12.6" rx="2.6" fill="none" stroke="#ffffff" stroke-width="2.1"/>
     <path d="M12.2 16.4H23.8" fill="none" stroke="#ffffff" stroke-width="1.9"/>
     <circle cx="14.5" cy="19.8" r="1.2" fill="#ffffff"/>
     <circle cx="21.5" cy="19.8" r="1.2" fill="#ffffff"/>
     <path d="M14 23L11.8 26M22 23L24.2 26" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`
  ),
  info: circleBadge(
    '#0D9488',
    `<circle cx="18" cy="12.2" r="1.7" fill="#ffffff"/>
     <path d="M18 16.2V24.2" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>`
  ),
  sign: circleBadge(
    '#0F766E',
    `<path d="M18 10.2V25.6" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>
     <path d="M11.5 12.6H22.2L24.6 14.8L22.2 17H11.5Z" fill="#ffffff"/>
     <path d="M24.5 18.4H13.8L11.4 20.6L13.8 22.8H24.5Z" fill="#ffffff" fill-opacity="0.9"/>`
  ),

  // Places of worship (clean neutral slate-indigo badges)
  synagogue: circleBadge(
    '#475569',
    `<polygon points="18,9.8 24.8,21.6 11.2,21.6" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
     <polygon points="18,26.2 24.8,14.4 11.2,14.4" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>`
  ),
  mosque: circleBadge(
    '#475569',
    `<path d="M12 24.2V19.6C12 16.5 14.5 14.6 18 12.4C21.5 14.6 24 16.5 24 19.6V24.2Z" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linejoin="round"/>
     <path d="M18 9.2V12.2M10.5 24.2H25.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
     <path d="M16.2 19.2A2.2 2.2 0 1 0 19.6 21.2A1.8 1.8 0 1 1 16.2 19.2Z" fill="#ffffff"/>`
  ),
  church: circleBadge(
    '#475569',
    `<path d="M18 10V25.5M13 15.2H23" fill="none" stroke="#ffffff" stroke-width="2.8" stroke-linecap="round"/>`
  ),
  holy_place: circleBadge(
    '#475569',
    `<path d="M11.5 24.5V19C11.5 15.4 14.4 12.5 18 12.5C21.6 12.5 24.5 15.4 24.5 19V24.5Z" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linejoin="round"/>
     <path d="M18 9.5V12.5M10 24.5H26" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
     <circle cx="18" cy="19" r="2" fill="#ffffff"/>`
  ),

  // Civic, cultural & utility map features
  monument: lightCircleBadge(
    '#64748B',
    `<path d="M18 9.6L20.5 13V22.4H15.5V13Z" fill="#475569"/>
     <rect x="12.5" y="22.4" width="11" height="2.8" rx="0.8" fill="#475569"/>`
  ),
  water_tank: lightCircleBadge(
    '#0284C7',
    `<rect x="13" y="10.8" width="10" height="6.2" rx="1.4" fill="#0284C7"/>
     <path d="M14.5 17L12.5 25M21.5 17L23.5 25M13.6 21.5H22.4" fill="none" stroke="#0369A1" stroke-width="2" stroke-linecap="round"/>`
  ),
  tap: lightCircleBadge(
    '#0891B2',
    `<path d="M11.5 16.5H19.5C21.2 16.5 22.2 17.5 22.2 19.2V20" fill="none" stroke="#0891B2" stroke-width="2.4" stroke-linecap="round"/>
     <path d="M16 16.5V12.8M13.5 12.8H18.5" fill="none" stroke="#0891B2" stroke-width="2.2" stroke-linecap="round"/>
     <path d="M22.2 21.8C22.2 21.8 20.2 24.2 20.2 25.4A2 2 0 0 0 24.2 25.4C24.2 24.2 22.2 21.8 22.2 21.8Z" fill="#0284C7"/>`
  ),
  tree: haloGlyph(
    `<path d="M18 6.5C13.8 6.5 10.6 9.6 10.6 13.6C10.6 15.1 11.1 16.5 11.9 17.6C10.8 18.6 10.2 20 10.2 21.5C10.2 24.3 12.5 26.5 15.4 26.5H20.6C23.5 26.5 25.8 24.3 25.8 21.5C25.8 20 25.2 18.6 24.1 17.6C24.9 16.5 25.4 15.1 25.4 13.6C25.4 9.6 22.2 6.5 18 6.5Z" fill="#16A34A" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>
     <path d="M18 20V30.2" fill="none" stroke="#78350F" stroke-width="3" stroke-linecap="round"/>`
  ),
  quarry: lightCircleBadge(
    '#64748B',
    `<path d="M12.2 23.8L22.6 13.4M23.8 23.8L13.4 13.4" fill="none" stroke="#475569" stroke-width="2.3" stroke-linecap="round"/>
     <path d="M19.8 11.2L24.8 16.2M16.2 11.2L11.2 16.2" fill="none" stroke="#475569" stroke-width="2.2" stroke-linecap="round"/>`
  ),
  cemetery: lightCircleBadge(
    '#64748B',
    `<path d="M13 24.5V16.5C13 13.8 15.2 11.5 18 11.5C20.8 11.5 23 13.8 23 16.5V24.5Z" fill="none" stroke="#475569" stroke-width="2.2" stroke-linejoin="round"/>
     <path d="M11 24.5H25M15.5 16.5H20.5" fill="none" stroke="#475569" stroke-width="2" stroke-linecap="round"/>`
  ),

  // Additional standard facilities in the base sprite atlas
  first_aid: lightCircleBadge(
    '#DC2626',
    `<path d="M18 11.5V24.5M11.5 18H24.5" fill="none" stroke="#DC2626" stroke-width="3.4" stroke-linecap="round"/>`
  ),
  toilet: circleBadge(
    '#475569',
    `<circle cx="14" cy="12.5" r="1.7" fill="#ffffff"/>
     <path d="M12 16H16V20.5H15V24.5H13V20.5H12Z" fill="#ffffff"/>
     <circle cx="22" cy="12.5" r="1.7" fill="#ffffff"/>
     <path d="M20.2 16H23.8L25 21H23V24.5H21V21H19Z" fill="#ffffff"/>`
  ),
  hotel: circleBadge(
    '#4F46E5',
    `<path d="M10.5 23.5V14.5M25.5 23.5V18.5C25.5 17.2 24.5 16.2 23.2 16.2H16.5V21H10.5M10.5 21H25.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
     <circle cx="13.5" cy="17.2" r="1.6" fill="#ffffff"/>`
  ),
  food: circleBadge(
    '#D97706',
    `<path d="M13.5 10.5V16.5M11.5 10.5V15C11.5 16.2 12.4 17 13.5 17C14.6 17 15.5 16.2 15.5 15V10.5M13.5 17V25" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round"/>
     <path d="M21.5 10.5V25M21.5 10.5C23.2 11.5 23.8 14 23.5 17.5H21.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
  ),
  cafe: circleBadge(
    '#78350F',
    `<path d="M11.5 15.5H21.5V20.2C21.5 22.4 19.7 24 17.5 24H15.5C13.3 24 11.5 22.4 11.5 20.2Z" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
     <path d="M21.5 16.5H23.2C24.3 16.5 25 17.3 25 18.4C25 19.5 24.3 20.3 23.2 20.3H21.5" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round"/>
     <path d="M14.5 12.2C14.5 11.2 15.3 10.8 15.3 10M18.5 12.2C18.5 11.2 19.3 10.8 19.3 10" fill="none" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>`
  ),
  shopping: circleBadge(
    '#6D28D9',
    `<path d="M12.2 15.2H23.8L22.8 24.5H13.2Z" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linejoin="round"/>
     <path d="M15 15.2V13.4C15 11.7 16.3 10.5 18 10.5C19.7 10.5 21 11.7 21 13.4V15.2" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`
  ),
  bench: lightCircleBadge(
    '#64748B',
    `<path d="M11.5 16.5H24.5M10.5 19.5H25.5M13 19.5V24M23 19.5V24M14 14.5V16.5M22 14.5V16.5" fill="none" stroke="#475569" stroke-width="2.1" stroke-linecap="round"/>`
  ),
  playground: circleBadge(
    '#0D9488',
    `<path d="M11.5 23.5L16 14H20L24.5 23.5M14 19H22M18 14V11.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`
  ),
  artwork: circleBadge(
    '#7E22CE',
    `<circle cx="18" cy="18" r="6.5" fill="none" stroke="#ffffff" stroke-width="2"/>
     <circle cx="15.8" cy="16" r="1.2" fill="#ffffff"/>
     <circle cx="20.2" cy="16" r="1.2" fill="#ffffff"/>
     <circle cx="18" cy="20.5" r="1.3" fill="#ffffff"/>`
  ),
  tower: lightCircleBadge(
    '#475569',
    `<path d="M15.2 11H20.8L22.5 25H13.5Z" fill="none" stroke="#475569" stroke-width="2.1" stroke-linejoin="round"/>
     <path d="M14.2 15.5H21.8M14.5 20.2H21.5" fill="none" stroke="#475569" stroke-width="1.8"/>`
  ),
  airfield: circleBadge(
    '#0369A1',
    `<path d="M18 10L20 16L25.5 18.5V20.5L20 19.2V23.5L22 25V26.5L18 25.5L14 26.5V25L16 23.5V19.2L10.5 20.5V18.5L16 16Z" fill="#ffffff"/>`
  ),
  alpinehut: circleBadge(
    '#3F6212',
    `<path d="M10.5 19.5L18 11.5L25.5 19.5M13 17.5V24.8H23V17.5" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`
  ),
  antenna: haloGlyph(
    `<circle cx="18" cy="14" r="2.3" fill="#334155" stroke="#ffffff" stroke-width="1.8"/>
     <path d="M18 16.5V27M13.5 11.2A6.5 6.5 0 0 0 13.5 17.2M22.5 11.2A6.5 6.5 0 0 1 22.5 17.2" fill="none" stroke="#334155" stroke-width="2.2" stroke-linecap="round"/>`
  ),
  gate_closed: lightCircleBadge(
    '#DC2626',
    `<path d="M11 18H25M13.5 14V22M22.5 14V22" fill="none" stroke="#DC2626" stroke-width="2.4" stroke-linecap="round"/>`
  ),
  gate_open: lightCircleBadge(
    '#16A34A',
    `<path d="M12.5 14V22M23.5 14V22M12.5 15.5L17.5 13.2" fill="none" stroke="#16A34A" stroke-width="2.3" stroke-linecap="round"/>`
  ),
  bollards: lightCircleBadge(
    '#64748B',
    `<path d="M13 14.5V22.5M18 14.5V22.5M23 14.5V22.5" fill="none" stroke="#475569" stroke-width="2.8" stroke-linecap="round"/>`
  ),
  cattle_grid: lightCircleBadge(
    '#64748B',
    `<path d="M11.5 14.5H24.5M11.5 18H24.5M11.5 21.5H24.5" fill="none" stroke="#475569" stroke-width="2.2" stroke-linecap="round"/>`
  ),
  construction: lightCircleBadge(
    '#D97706',
    `<path d="M18 11L25 23.5H11Z" fill="none" stroke="#D97706" stroke-width="2.3" stroke-linejoin="round"/>
     <path d="M18 15.5V19.5" fill="none" stroke="#D97706" stroke-width="2.2" stroke-linecap="round"/>
     <circle cx="18" cy="21.6" r="1.1" fill="#D97706"/>`
  ),
  flower: haloGlyph(
    `<circle cx="18" cy="18" r="3.4" fill="#F59E0B" stroke="#ffffff" stroke-width="1.4"/>
     <circle cx="18" cy="12" r="3" fill="#EC4899" stroke="#ffffff" stroke-width="1.4"/>
     <circle cx="23.7" cy="16.1" r="3" fill="#EC4899" stroke="#ffffff" stroke-width="1.4"/>
     <circle cx="21.5" cy="22.8" r="3" fill="#EC4899" stroke="#ffffff" stroke-width="1.4"/>
     <circle cx="14.5" cy="22.8" r="3" fill="#EC4899" stroke="#ffffff" stroke-width="1.4"/>
     <circle cx="12.3" cy="16.1" r="3" fill="#EC4899" stroke="#ffffff" stroke-width="1.4"/>`
  ),
};

export const MODERN_STANDARD_MAP_SYMBOL_IDS = new Set<string>(Object.keys(STANDARD_MAP_SVG_INNER));

export function getAllStandardMapSymbolSvgEntries(): StandardMapSymbolSvgEntry[] {
  return Object.entries(STANDARD_MAP_SVG_INNER).map(([id, inner]) => ({
    id,
    svg1x: wrapSvg(inner, 36),
    svg2x: wrapSvg(inner, 72),
  }));
}
