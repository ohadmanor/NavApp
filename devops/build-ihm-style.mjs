#!/usr/bin/env node
/**
 * devops/build-ihm-style.mjs
 *
 * Converts the official Israel Hiking Map style (IHM.json from IsraelHikingMap/VectorMap)
 * into src/core/style/ihmLayers.json adapted for:
 *  - C:\dev\NavApp\data\Israel.osm.pmtiles (OpenMapTiles schema)
 *  - C:\dev\NavApp\data\Israel.dem.pmtiles (Terrarium 256px DEM + 10m/50m maplibre-contour)
 *  - C:\dev\NavApp\public\assets\sprites\sprite (72 official Israel Hiking Map sprites & patterns)
 *  - 100% offline Hebrew RTL TinySDF font rendering with zero symbol/circle overlap
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ihmRawPath = 'C:/Users/Manor/.gemini/antigravity/brain/eed1f3b5-86b9-40f1-b64f-3378c44f9f11/scratch/IHM.json';
const outPath = path.resolve(__dirname, '..', 'src', 'core', 'style', 'ihmLayers.json');

const ihm = JSON.parse(fs.readFileSync(ihmRawPath, 'utf8'));

function transformFilter(filter) {
  if (!Array.isArray(filter)) return filter;
  const op = filter[0];

  // Legacy ["==", "ihm_class", val] or ["!=", "ihm_class", val]
  if ((op === '==' || op === '!=') && filter[1] === 'ihm_class') {
    const val = filter[2];
    if (['footway', 'pedestrian', 'cycleway', 'steps'].includes(val)) {
      return op === '=='
        ? ['any', ['==', 'class', val], ['==', 'subclass', val]]
        : ['all', ['!=', 'class', val], ['!=', 'subclass', val]];
    }
    return [op, 'class', val];
  }

  // Legacy ["in", "ihm_class", ...vals] or ["!in", "ihm_class", ...vals]
  if ((op === 'in' || op === '!in') && filter[1] === 'ihm_class') {
    const vals = filter.slice(2);
    const hasSub = vals.some((v) => ['footway', 'pedestrian', 'cycleway', 'steps'].includes(v));
    const expanded = vals.includes('minor') && !vals.includes('minor_construction')
      ? [...vals, 'minor_construction']
      : vals;
    if (hasSub) {
      return op === 'in'
        ? ['any', ['in', 'class', ...expanded], ['in', 'subclass', ...expanded]]
        : ['all', ['!in', 'class', ...expanded], ['!in', 'subclass', ...expanded]];
    }
    return [op, 'class', ...expanded];
  }

  return filter.map(transformFilter);
}

function transformExpression(expr) {
  if (!Array.isArray(expr)) return expr;

  // Replace ["coalesce", ["get", "name:he"], ...] with composite "primary\u200B|||englishFallback"
  // so sanitizeToHebrewOrEnglish displays ONLY Hebrew if available, or English if no Hebrew exists.
  if (
    expr[0] === 'coalesce' &&
    JSON.stringify(expr).includes('"name:he"')
  ) {
    const primaryExpr = [
      'coalesce',
      ['get', 'name:he'],
      ['get', 'name:latin'],
      ['get', 'name'],
      '',
    ];
    const enExpr = [
      'coalesce',
      ['get', 'name:en'],
      ['get', 'name_en'],
      ['get', 'int_name'],
      '',
    ];
    return [
      'case',
      ['all', ['!=', primaryExpr, ''], ['!=', enExpr, ''], ['!=', primaryExpr, enExpr]],
      ['concat', primaryExpr, '\u200B|||', enExpr],
      ['!=', primaryExpr, ''],
      primaryExpr,
      enExpr,
    ];
  }

  // Replace ["match", ["get", "colour"], "green", "#00C000", ["to-color", ["get", "colour"], FALLBACK]]
  if (
    expr[0] === 'match' &&
    Array.isArray(expr[1]) &&
    expr[1][0] === 'get' &&
    expr[1][1] === 'colour'
  ) {
    const last = expr[expr.length - 1];
    let fallback = '#6B3E26';
    if (typeof last === 'string') {
      fallback = last;
    } else if (Array.isArray(last) && last[0] === 'to-color' && typeof last[2] === 'string') {
      fallback = last[2];
    }
    if (fallback === '#AA8166') {
      fallback = [
        'case',
        ['==', ['get', 'bicycle'], 'designated'],
        '#9333EA',
        ['in', ['coalesce', ['get', 'sac_scale'], ''], ['literal', ['demanding_mountain_hiking', 'alpine_hiking']]],
        '#DC2626',
        ['==', ['get', 'sac_scale'], 'mountain_hiking'],
        '#00A800',
        ['in', ['coalesce', ['get', 'tracktype'], ''], ['literal', ['grade4', 'grade5']]],
        '#991B1B',
        ['in', ['coalesce', ['get', 'smoothness'], ''], ['literal', ['very_bad', 'horrible', 'impassable']]],
        '#991B1B',
        '#6B3E26',
      ];
    }
    return [
      'match',
      ['coalesce', ['get', 'colour'], ''],
      'green',
      '#00C000',
      'blue',
      '#0044FF',
      'red',
      '#FF0000',
      'black',
      '#111111',
      'purple',
      '#800080',
      'orange',
      '#FF8000',
      fallback,
    ];
  }

  // Replace ["let", "colour", ["coalesce", ["get", "colour2"], ["get", "colour"], FALLBACK], ...]
  if (expr[0] === 'let' && expr[1] === 'colour' && Array.isArray(expr[2])) {
    const fallback = [
      'case',
      ['==', ['get', 'bicycle'], 'designated'],
      '#9333EA',
      ['in', ['coalesce', ['get', 'tracktype'], ''], ['literal', ['grade4', 'grade5']]],
      '#991B1B',
      ['in', ['coalesce', ['get', 'smoothness'], ''], ['literal', ['very_bad', 'horrible', 'impassable']]],
      '#991B1B',
      '#6B3E26',
    ];
    return [
      'match',
      ['coalesce', ['get', 'colour2'], ['get', 'colour'], ''],
      'green',
      '#00C000',
      'blue',
      '#0044FF',
      'red',
      '#FF0000',
      'black',
      '#111111',
      'purple',
      '#800080',
      'orange',
      '#FF8000',
      fallback,
    ];
  }

  // Safe ["get", "military"] inside ["match", ...]
  if (
    expr[0] === 'match' &&
    Array.isArray(expr[1]) &&
    expr[1][0] === 'get' &&
    expr[1][1] === 'military'
  ) {
    return ['match', ['coalesce', ['get', 'military'], ''], ...expr.slice(2).map(transformExpression)];
  }

  return expr.map(transformExpression);
}

const adaptedLayers = [];

for (const rawLayer of ihm.layers) {
  const layer = structuredClone(rawLayer);

  // Skip IHM internal grid layers and custom source-layers not in OpenMapTiles
  const sl = layer['source-layer'];
  if (['itm_grid', 'minefield', 'ihm_natural', 'barrier'].includes(sl)) {
    continue;
  }

  // Skip separate circle/ele layers that bypass symbol collision detection;
  // these are unified into their respective symbol layers ('name-peak' and 'name-water-point')
  // using official sprite icons ('dot', 'spring', 'cistern') so symbols never mix on top of each other.
  if (
    [
      'peak-dot',
      'peak-ele',
      'water-spring',
      'water-cistern-bg',
      'water-cistern-circle',
    ].includes(layer.id)
  ) {
    continue;
  }

  // Map sources
  if (layer.source === 'IHM') {
    layer.source = 'israel-osm';
  } else if (layer.source === 'TerrainRGB') {
    layer.source = 'israel-dem';
  } else if (layer.source === 'Contour') {
    layer.source = 'israel-contours';
  }

  // Map source-layers
  if (sl === 'ihm_boundary') {
    layer['source-layer'] = 'boundary';
  } else if (sl === 'contour') {
    layer['source-layer'] = 'contours';
  } else if (sl === 'ihm_lines') {
    if (layer.id.includes('cliff') || layer.id.includes('wall')) {
      layer['source-layer'] = 'flood_defence';
    } else {
      layer['source-layer'] = 'fuel_line';
    }
  } else if (sl === 'trail') {
    layer['source-layer'] = layer.type === 'symbol' ? 'transportation_name' : 'transportation';
  }

  // Adapt contour layers to our 10m (level=0) & 50m (level=1) maplibre-contour schema
  if (layer.id === 'contour-line-casing') {
    layer.paint = {
      'line-color': 'white',
      'line-width': ['match', ['get', 'level'], 0, 1.8, 3.0],
      'line-blur': 2,
    };
  } else if (layer.id === 'contour-line') {
    layer.paint = {
      'line-color': 'rgb(161, 127, 86)',
      'line-width': ['match', ['get', 'level'], 0, 0.85, 1.85],
      'line-opacity': ['match', ['get', 'level'], 0, 0.68, 0.92],
    };
  } else if (layer.id === 'contour-label') {
    delete layer.filter;
    layer.filter = ['>', ['get', 'level'], 0];
    layer.layout = {
      ...layer.layout,
      'text-field': ['to-string', ['get', 'ele']],
      'symbol-placement': 'line',
      'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
      'text-size': 11,
      'symbol-avoid-edges': true,
      'text-max-angle': 45,
      'text-keep-upright': true,
    };
    delete layer.layout['text-letter-spacing'];
    layer.paint = {
      'text-color': 'rgb(161, 127, 86)',
      'text-halo-color': 'rgba(255, 255, 255, 0.85)',
      'text-halo-width': 3,
      'text-halo-blur': 1.5,
    };
  }

  // Transform filters
  if (layer.filter) {
    layer.filter = transformFilter(layer.filter);
  }

  // Fix park label filter so polygon nature reserves in Israel.osm.pmtiles are labeled
  if (layer.id === 'name-park') {
    layer.filter = ['in', 'class', 'national_park', 'nature_reserve', 'protected_area'];
  }

  // Keep city and town names visible up to z16
  if (layer.id === 'place-city' || layer.id === 'place-town') {
    layer.maxzoom = 16;
  }

  // Ensure tracks, footpaths, buildings, and road names are visible from medium zoom (z10-12+)
  if (layer.id === 'track-line') {
    layer.minzoom = 10;
  }
  if (['casing-path', 'path-path', 'path-footway', 'path-cycleway'].includes(layer.id)) {
    layer.minzoom = 11.5;
  }
  if (layer.id === 'building') {
    layer.minzoom = 13;
  }
  if (layer.id === 'name-primary' || layer.id === 'name-secondary') {
    layer.minzoom = 11;
  }
  if (layer.id === 'name-tertiary') {
    layer.minzoom = 12;
  }

  // Transform layout expressions & fonts
  if (layer.layout) {
    for (const [k, v] of Object.entries(layer.layout)) {
      layer.layout[k] = transformExpression(v);
    }
    if (layer.layout['text-font']) {
      layer.layout['text-font'] = ['bold', 'Arial', 'Tahoma', 'sans-serif'];
    }
    if (layer.layout['text-field'] === '{ref}') {
      layer.layout['text-field'] = ['to-string', ['coalesce', ['get', 'ref'], '']];
    }
    if (!layer.id.startsWith('shield-') && layer.layout['text-letter-spacing'] !== undefined) {
      delete layer.layout['text-letter-spacing'];
    }

    // Prevent symbol mixing on all point symbol layers:
    // Never allow point icons or labels to overlap each other.
    const placement = layer.layout['symbol-placement'];
    const isLinePlacement = placement === 'line' || placement === 'line-center';
    if (layer.type === 'symbol' && !isLinePlacement) {
      layer.layout['icon-allow-overlap'] = false;
      layer.layout['text-allow-overlap'] = false;
      layer.layout['icon-ignore-placement'] = false;
      layer.layout['text-ignore-placement'] = false;
      if (layer.layout['icon-image']) {
        layer.layout['icon-anchor'] = 'center';
        layer.layout['icon-padding'] = 3;
        if (layer.layout['text-field']) {
          layer.layout['text-anchor'] = 'top';
          layer.layout['text-offset'] = [0, 0.75];
          layer.layout['text-size'] = 14;
        }
      }
    }
  }

  // Unify springs & cisterns into 'name-water-point' using official 'spring' & 'cistern' sprite icons
  if (layer.id === 'name-water-point') {
    layer.minzoom = 11.5;
    layer.layout = {
      ...layer.layout,
      'icon-image': [
        'match',
        ['coalesce', ['get', 'subclass'], ''],
        'cistern',
        'cistern',
        'spring',
      ],
      'icon-size': [
        'match',
        ['coalesce', ['get', 'subclass'], ''],
        'cistern',
        0.55,
        0.75,
      ],
      'icon-anchor': 'center',
      'icon-allow-overlap': false,
      'icon-padding': 3,
      'text-allow-overlap': false,
      'text-optional': true,
      'text-anchor': 'top',
      'text-offset': [0, 0.65],
      'text-size': 14,
    };
  }

  // Unify mountain peaks ('peak-dot' + 'peak-ele' + 'name-peak') into one atomic symbol layer 'name-peak'
  // so the peak dot, elevation, and name move & collide together and never mix with viewpoint icons.
  if (layer.id === 'name-peak') {
    layer.minzoom = 11;
    delete layer.filter;
    const nameExpr = [
      'coalesce',
      ['get', 'name:he'],
      ['get', 'name:latin'],
      ['get', 'name'],
      ['get', 'name_en'],
      ['get', 'name:en'],
      '',
    ];
    layer.layout = {
      'symbol-placement': 'point',
      'icon-image': 'dot',
      'icon-size': 0.45,
      'icon-anchor': 'center',
      'icon-allow-overlap': false,
      'icon-padding': 4,
      'text-allow-overlap': false,
      'text-optional': false,
      'text-font': ['bold', 'Arial', 'Tahoma', 'sans-serif'],
      'text-size': 14,
      'text-max-width': 10,
      'text-anchor': 'top',
      'text-offset': [0, 0.55],
      'text-padding': 2,
      'text-field': [
        'case',
        ['all', ['!=', nameExpr, ''], ['has', 'ele']],
        ['concat', nameExpr, ' (', ['to-string', ['get', 'ele']], ')'],
        ['!=', nameExpr, ''],
        nameExpr,
        ['has', 'ele'],
        ['to-string', ['get', 'ele']],
        '',
      ],
    };
    layer.paint = {
      'text-color': '#404040',
      'text-halo-color': 'white',
      'text-halo-width': 3,
      'text-halo-blur': 1.5,
    };
  }

  // Transform paint expressions
  if (layer.paint) {
    for (const [k, v] of Object.entries(layer.paint)) {
      layer.paint[k] = transformExpression(v);
    }
  }

  adaptedLayers.push(layer);
}

// Add 10m minor contour elevation labels at high zoom (z13.5+) right after contour-label
const contourLabelIdx = adaptedLayers.findIndex((l) => l.id === 'contour-label');
if (contourLabelIdx !== -1) {
  adaptedLayers.splice(contourLabelIdx + 1, 0, {
    id: 'contour-label-10m',
    type: 'symbol',
    source: 'israel-contours',
    'source-layer': 'contours',
    minzoom: 13.5,
    filter: ['==', ['get', 'level'], 0],
    layout: {
      'text-field': ['to-string', ['get', 'ele']],
      'symbol-placement': 'line',
      'symbol-spacing': 360,
      'text-font': ['Arial', 'Tahoma', 'sans-serif'],
      'text-size': 9.5,
      'symbol-avoid-edges': true,
      'text-max-angle': 40,
      'text-keep-upright': true,
    },
    paint: {
      'text-color': 'rgb(161, 127, 86)',
      'text-halo-color': 'rgba(255, 255, 255, 0.85)',
      'text-halo-width': 2.5,
      'text-halo-blur': 1,
    },
  });
}

fs.writeFileSync(outPath, JSON.stringify(adaptedLayers, null, 2), 'utf8');
console.log(`[build-ihm-style] Wrote ${adaptedLayers.length} Israel Hiking Map layers to ${outPath}`);
