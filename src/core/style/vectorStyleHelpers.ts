export type MapStyleId = 'ihm' | 'nms' | 'govmap';

export interface RoadPaletteEntry {
  fillDay: string;
  fillDark: string;
  casingDay: string;
  casingDark: string;
}

export interface SymbolHierarchyPalette {
  haloColor: string;
  primaryTextColor: string;
  secondaryTextColor: string;
  waterTextColor: string;
  parkTextColor: string;
  contourTextColor: string;
}

export function getRoadClassFromLayerId(
  layerId: string,
  palette: Record<string, RoadPaletteEntry>
): string | null {
  for (const roadClass of Object.keys(palette)) {
    if (
      layerId === `road-${roadClass}` ||
      layerId.endsWith(`-road-${roadClass}`) ||
      layerId === `casing-${roadClass}` ||
      layerId.endsWith(`-casing-${roadClass}`)
    ) {
      return roadClass;
    }
  }
  return null;
}

export function replaceGrayFallbackInExpr(expr: any, replacement: string): any {
  if (expr === '#808080' || expr === '#E0E0E0') {
    return replacement;
  }
  if (Array.isArray(expr)) {
    return expr.map((item) => replaceGrayFallbackInExpr(item, replacement));
  }
  return expr;
}

export const COMPACT_SHIELD_TEXT_SIZE_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  6,
  9.5,
  10,
  10.5,
  14,
  11.5,
  17,
  12.5,
];

const VECTOR_POI_COMPACT_MINZOOM: Record<string, number> = {
  'name-peak': 11.5,
  'icon-viewpoint': 13,
  'icon-cave': 13,
  'icon-ruins': 13,
  'icon-archaeological': 13,
  'icon-camp_site': 13,
  'icon-picnic': 13,
  'name-water-point': 13.5,
  'water-hole': 13.5,
  'water-well': 13.5,
  'water-waterfall': 13.5,
  'water-tank': 14,
  'water-drinking': 14,
  'icon-fuel': 14,
  'icon-rail_station': 14,
  'icon-memorial': 14,
  'icon-holy': 14,
  'icon-jewish': 14,
  'icon-muslim': 14,
  'icon-christian': 14,
  'icon-guidepost': 14,
  'icon-tree': 15,
  'icon-quarry': 15,
  'icon-cemerery': 15,
  'icon-parking': 16,
};

const COMPACT_POI_ICON_SIZE_PRIMARY_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11.5,
  0.36,
  13,
  0.46,
  14,
  0.56,
  15.5,
  0.68,
  17.5,
  0.78,
];

const COMPACT_POI_ICON_SIZE_SECONDARY_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11.5,
  0.34,
  13,
  0.44,
  14,
  0.54,
  15.5,
  0.64,
  17.5,
  0.74,
];

const SECONDARY_VECTOR_POI_IDS = new Set<string>([
  'name-peak',
  'icon-picnic',
  'icon-tree',
  'icon-quarry',
  'icon-cemerery',
  'icon-guidepost',
  'icon-parking',
  'water-tank',
  'water-drinking',
]);

const COMPACT_POI_TEXT_SIZE_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11.5,
  9.5,
  13.5,
  10.8,
  15.5,
  12,
  17.5,
  12.8,
];

const COMPACT_POI_TEXT_OFFSET_EXPR: any = [
  'interpolate',
  ['linear'],
  ['zoom'],
  12,
  ['literal', [0, 0.62]],
  14.5,
  ['literal', [0, 0.76]],
  17.5,
  ['literal', [0, 0.92]],
];

export function applyCompactShieldLayout(
  layout: Record<string, any>,
  paint: Record<string, any>
): void {
  layout['text-size'] = COMPACT_SHIELD_TEXT_SIZE_EXPR;
  layout['icon-text-fit-padding'] = [1.5, 5, 1.5, 5];
  layout['text-letter-spacing'] = 0.04;
  layout['icon-padding'] = 2;
  layout['symbol-spacing'] = 360;
  paint['text-halo-width'] = 0;
}

/**
 * Applies zoom-progressive symbol sizing, minzooms, padding, and halos to
 * contour labels, place labels, road/trail/water/park names, and vector POIs.
 */
export function applyCompactSymbolHierarchy(
  layer: any,
  id: string,
  layout: Record<string, any>,
  paint: Record<string, any>,
  palette: SymbolHierarchyPalette
): boolean {
  const {
    haloColor,
    primaryTextColor,
    secondaryTextColor,
    waterTextColor,
    parkTextColor,
    contourTextColor,
  } = palette;

  if (id === 'barrier-cliff-icon') {
    layout['icon-size'] = 0.32;
    return true;
  }
  if (id === 'barrier-fence-x') {
    layout['icon-size'] = 0.14;
    return true;
  }

  if (id === 'contour-label') {
    layer.minzoom = 12;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 9.5, 15, 11];
    paint['text-color'] = contourTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'contour-label-10m') {
    layer.minzoom = 13.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 13.5, 8.5, 16, 10];
    paint['text-color'] = contourTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'place-city') {
    layer.minzoom = 5;
    layer.maxzoom = 16;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 6, 12.5, 9, 15, 12, 17.5, 15, 19];
    layout['text-padding'] = 6;
    paint['text-color'] = primaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.4;
    paint['text-halo-blur'] = 0.8;
    return true;
  }

  if (id === 'place-town') {
    layer.minzoom = 8.5;
    layer.maxzoom = 16;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 8.5, 11, 11, 13.5, 14, 15.5];
    layout['text-padding'] = 5;
    paint['text-color'] = primaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.3;
    paint['text-halo-blur'] = 0.8;
    return true;
  }

  if (id === 'place-suburb') {
    layer.minzoom = 12.5;
    layer.maxzoom = 16;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12.5, 10.5, 15, 12.5];
    layout['text-padding'] = 4;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'place-village') {
    layer.minzoom = 10.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 10.5, 10.5, 13, 12.5, 15, 13.5];
    layout['text-padding'] = 4;
    paint['text-color'] = primaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'place-hamlet') {
    layer.minzoom = 12;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 10, 15, 12];
    layout['text-padding'] = 4;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'place-farm') {
    layer.minzoom = 13;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 13, 9.5, 15.5, 11];
    layout['text-padding'] = 3;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'name-primary') {
    layer.minzoom = 11;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11, 10, 14, 11.5, 17, 13];
    layout['text-padding'] = 4;
    layout['symbol-spacing'] = 320;
    layout['text-max-angle'] = 45;
    paint['text-color'] = primaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'name-secondary') {
    layer.minzoom = 11.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11.5, 9.8, 14, 11.2, 17, 12.5];
    layout['text-padding'] = 4;
    layout['symbol-spacing'] = 320;
    layout['text-max-angle'] = 45;
    paint['text-color'] = primaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'name-tertiary') {
    layer.minzoom = 12.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12.5, 9.5, 15, 11, 17, 12];
    layout['text-padding'] = 3;
    layout['symbol-spacing'] = 300;
    layout['text-max-angle'] = 45;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'name-minor') {
    layer.minzoom = 14.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 14.5, 9.5, 17, 11.5];
    layout['text-padding'] = 3;
    layout['symbol-spacing'] = 280;
    layout['text-max-angle'] = 45;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'name-track') {
    layer.minzoom = 13.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 13.5, 9.5, 16, 11];
    layout['text-padding'] = 3;
    layout['symbol-spacing'] = 300;
    layout['text-max-angle'] = 45;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'name-path') {
    layer.minzoom = 14.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 14.5, 9, 17, 10.8];
    layout['text-padding'] = 3;
    layout['symbol-spacing'] = 300;
    layout['text-max-angle'] = 45;
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id === 'name-trail-regional') {
    layer.minzoom = 11.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11.5, 10, 14, 11.5, 17, 12.8];
    layout['text-padding'] = 4;
    layout['symbol-spacing'] = 320;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'name-trail-local') {
    layer.minzoom = 12.5;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12.5, 9.5, 15, 11, 17, 12.2];
    layout['text-padding'] = 3;
    layout['symbol-spacing'] = 300;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'name-water-line') {
    layer.minzoom = 12;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 12, 10, 14.5, 12, 17, 13.5];
    layout['text-padding'] = 4;
    paint['text-color'] = waterTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'water-area-name' || id === 'water-area-name-deprecated') {
    layer.minzoom = 9;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 9, 11, 13, 13.5, 16, 15.5];
    paint['text-color'] = waterTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'name-park') {
    layer.minzoom = 11;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 11, 10.5, 14, 13, 16, 14.5];
    paint['text-color'] = parkTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.2;
    return true;
  }

  if (id === 'name-building') {
    layer.minzoom = 16;
    layout['text-size'] = ['interpolate', ['linear'], ['zoom'], 16, 9.5, 18, 11.5];
    paint['text-color'] = secondaryTextColor;
    paint['text-halo-color'] = haloColor;
    paint['text-halo-width'] = 2.0;
    return true;
  }

  if (id in VECTOR_POI_COMPACT_MINZOOM) {
    layer.minzoom = VECTOR_POI_COMPACT_MINZOOM[id];
    layout['icon-size'] = SECONDARY_VECTOR_POI_IDS.has(id)
      ? COMPACT_POI_ICON_SIZE_SECONDARY_EXPR
      : COMPACT_POI_ICON_SIZE_PRIMARY_EXPR;
    layout['icon-padding'] = 2;
    layout['text-padding'] = 2.5;
    layout['text-optional'] = true;
    if (layout['text-field'] !== undefined) {
      layout['text-size'] = COMPACT_POI_TEXT_SIZE_EXPR;
      layout['text-offset'] = COMPACT_POI_TEXT_OFFSET_EXPR;
    }
    if (paint['text-color'] !== undefined || layout['text-field'] !== undefined) {
      if (id.startsWith('water-') || id === 'name-water-point') {
        paint['text-color'] = waterTextColor;
      } else if (!paint['text-color'] || paint['text-color'] === '#404040') {
        paint['text-color'] = primaryTextColor;
      }
      paint['text-halo-color'] = haloColor;
      paint['text-halo-width'] = 2.2;
      paint['text-halo-blur'] = 0.8;
    }
    return true;
  }

  return false;
}
