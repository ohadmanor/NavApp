#!/usr/bin/env node
/**
 * devops/generate-offline-assets.mjs
 *
 * Generates 100% offline-ready static assets inside public/:
 *  1. public/manifest.webmanifest (PWA manifest for offline installation)
 *  2. public/assets/rtl-text-plugin.js (100% Offline MapLibre Web Worker RTL/Hebrew BiDi Plugin)
 *  3. public/sw.js (Offline-first Service Worker caching app shell, RTL plugin, icons, and POIs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCarStyleAssets } from './build-car-styles.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const SPRITES_DIR = path.join(ASSETS_DIR, 'sprites');

fs.mkdirSync(SPRITES_DIR, { recursive: true });

// 1. PWA Web Manifest
const manifest = {
  name: 'NavApp — ניווט שטח טופוגרפי 1:50,000',
  short_name: 'NavApp IL',
  description: 'מערכת ניווט שטח טופוגרפית 100% אופליין מבוססת MapLibre GL JS ו-PMTiles (Israel.dem + Israel.osm)',
  lang: 'he-IL',
  dir: 'rtl',
  start_url: '/',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#10b981',
  orientation: 'any',
  icons: [
    {
      src: '/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any'
    },
    {
      src: '/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any'
    },
    {
      src: '/icon-512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable'
    }
  ]
};
fs.writeFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2), 'utf-8');

// 3. 100% Offline MapLibre GL JS RTL / Hebrew BiDi Worker Plugin (public/assets/rtl-text-plugin.js)
const rtlPluginCode = `/**
 * NavApp 100% Offline Hebrew & BiDi RTL Text Plugin for MapLibre GL JS Web Worker
 * Enables 'Hebr' script rendering in MapLibre v5 and converts logical Hebrew + mixed LTR
 * strings into visual Left-to-Right glyph layout order.
 */
(function () {
  var HEBREW_CHAR_REGEX = /[\\u0590-\\u05FF\\uFB1D-\\uFB4F]/;
  var RTL_CHAR_REGEX = /[\\u0590-\\u05FF\\uFB1D-\\uFB4F]/;
  var STRONG_LTR_REGEX = /[A-Za-z0-9]/;
  var LATIN_LETTER_REGEX = /[A-Za-z]/;
  var NUMERIC_CONNECTOR_REGEX = /[.,/:+%°-]/;
  var HEBREW_INTERNAL_PUNCT_REGEX = /['"׳״־-]/;

  var MIRRORED_BRACKETS = {
    '(': ')',
    ')': '(',
    '[': ']',
    ']': '[',
    '{': '}',
    '}': '{',
    '<': '>',
    '>': '<',
    '«': '»',
    '»': '«'
  };

  function sanitizeToHebrewOrEnglish(rawText) {
    if (!rawText) return '';
    var candidate = rawText;
    if (rawText.indexOf('\\u200B|||') !== -1) {
      var sp = rawText.split('\\u200B|||');
      var primary = sp[0] || '';
      var fallbackEn = sp[1] || '';
      if (HEBREW_CHAR_REGEX.test(primary)) {
        candidate = primary;
      } else if (LATIN_LETTER_REGEX.test(fallbackEn)) {
        candidate = fallbackEn;
      } else {
        candidate = primary || fallbackEn;
      }
    }

    var lines = candidate.split('\\n');
    var cleanedLines = [];
    for (var idx = 0; idx < lines.length; idx++) {
      var line = lines[idx].trim();
      if (!line) continue;
      if (HEBREW_CHAR_REGEX.test(line)) {
        var hebLine = line;
        if (/\\s*(?:\\/|\\||—|–|\\s-\\s)\\s*/.test(hebLine)) {
          var parts = hebLine.split(/\\s*(?:\\/|\\||—|–|\\s-\\s)\\s*/).map(function (p) { return p.trim(); }).filter(function (p) {
            return HEBREW_CHAR_REGEX.test(p) || /^[0-9()mMמ׳'״.,+-]+$/.test(p);
          });
          if (parts.length > 0) hebLine = parts.join(' — ');
        }
        hebLine = hebLine
          .replace(/[^\\u0590-\\u05FF\\uFB1D-\\uFB4F0-9\\s'"׳״־–—()\\[\\].,:;!?+-/*°%xXmM▲]/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
        if (hebLine && (HEBREW_CHAR_REGEX.test(hebLine) || /[0-9]/.test(hebLine))) {
          cleanedLines.push(hebLine);
        }
      } else if (STRONG_LTR_REGEX.test(line)) {
        var engLine = line;
        if (/\\s*(?:\\/|\\||—|–|\\s-\\s)\\s*/.test(engLine)) {
          var eParts = engLine.split(/\\s*(?:\\/|\\||—|–|\\s-\\s)\\s*/).map(function (p) { return p.trim(); }).filter(function (p) {
            return STRONG_LTR_REGEX.test(p);
          });
          if (eParts.length > 0) engLine = eParts.join(' - ');
        }
        engLine = engLine
          .replace(/[^\\u0020-\\u007E\\u00A0-\\u024F–—()\\[\\]'".,:;!?0-9+-/*°%]/g, ' ')
          .replace(/\\s+/g, ' ')
          .trim();
        if (engLine && STRONG_LTR_REGEX.test(engLine)) {
          cleanedLines.push(engLine);
        }
      }
    }
    return cleanedLines.join('\\n');
  }

  function containsRtlText(text) {
    return RTL_CHAR_REGEX.test(text);
  }

  function convertLineToVisualOrder(lineText, styleIndices) {
    var sanitized = sanitizeToHebrewOrEnglish(lineText);
    if (!sanitized) return { text: '', styles: [] };
    var chars = Array.from(sanitized);
    var styles =
      styleIndices && styleIndices.length === chars.length
        ? styleIndices.slice()
        : chars.map(function () { return 0; });

    if (!containsRtlText(sanitized)) {
      return { text: sanitized, styles: styles };
    }

    var items = chars.map(function (ch, idx) {
      var type = 'N';
      if (RTL_CHAR_REGEX.test(ch)) {
        type = 'R';
      } else if (STRONG_LTR_REGEX.test(ch)) {
        type = 'L';
      }
      return {
        char: ch,
        styleIndex: styles[idx] !== undefined ? styles[idx] : 0,
        type: type
      };
    });

    for (var i = 0; i < items.length; i++) {
      if (items[i].type !== 'N') continue;
      var prevType = i > 0 ? items[i - 1].type : null;
      var nextType = i + 1 < items.length ? items[i + 1].type : null;
      var ch = items[i].char;

      if (prevType === 'R' && nextType === 'R' && HEBREW_INTERNAL_PUNCT_REGEX.test(ch)) {
        items[i].type = 'R';
        continue;
      }
      if (prevType === 'R' && (ch === "'" || ch === '׳')) {
        items[i].type = 'R';
        continue;
      }
      if (NUMERIC_CONNECTOR_REGEX.test(ch) && (prevType === 'L' || nextType === 'L')) {
        items[i].type = 'L';
      }
    }

    var runs = [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
      if (lastRun && lastRun.type === item.type) {
        lastRun.items.push(item);
      } else {
        runs.push({ type: item.type, items: [item] });
      }
    }

    runs.reverse();

    var visualItems = [];
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (run.type === 'R') {
        var revR = run.items.slice().reverse();
        for (var k = 0; k < revR.length; k++) visualItems.push(revR[k]);
      } else if (run.type === 'L') {
        for (var m = 0; m < run.items.length; m++) visualItems.push(run.items[m]);
      } else {
        var revN = run.items.slice().reverse();
        for (var n = 0; n < revN.length; n++) {
          var it = revN[n];
          visualItems.push({
            char: MIRRORED_BRACKETS[it.char] || it.char,
            styleIndex: it.styleIndex,
            type: it.type
          });
        }
      }
    }

    return {
      text: visualItems.map(function (it) { return it.char; }).join(''),
      styles: visualItems.map(function (it) { return it.styleIndex; })
    };
  }

  function splitLinesWithStyles(text, styleIndices, lineBreakPoints) {
    var fullStyles =
      styleIndices && styleIndices.length === text.length
        ? styleIndices
        : Array.from({ length: text.length }, function () { return 0; });

    if (!lineBreakPoints || lineBreakPoints.length === 0) {
      return [{ line: text, styles: fullStyles }];
    }

    var lines = [];
    var start = 0;

    for (var i = 0; i < lineBreakPoints.length; i++) {
      var bp = Math.max(start, Math.min(text.length, lineBreakPoints[i]));
      if (bp > start) {
        var sliceText = text.substring(start, bp);
        var sliceStyles = fullStyles.slice(start, bp);
        while (sliceText.length > 0 && /\\s/.test(sliceText[sliceText.length - 1])) {
          sliceText = sliceText.slice(0, -1);
          sliceStyles = sliceStyles.slice(0, -1);
        }
        if (sliceText.length > 0) {
          lines.push({ line: sliceText, styles: sliceStyles });
        }
        start = bp;
      }
    }

    if (start < text.length) {
      var remText = text.substring(start);
      var remStyles = fullStyles.slice(start);
      if (remText.length > 0) {
        lines.push({ line: remText, styles: remStyles });
      }
    }

    return lines.length > 0 ? lines : [{ line: text, styles: fullStyles }];
  }

  function applyArabicShaping(text) {
    return sanitizeToHebrewOrEnglish(text);
  }

  function processBidirectionalText(text, lineBreakPoints) {
    var sanitized = sanitizeToHebrewOrEnglish(text);
    if (!sanitized) return [];
    var rawLines = splitLinesWithStyles(sanitized, undefined, lineBreakPoints);
    return rawLines.map(function (entry) {
      return convertLineToVisualOrder(entry.line).text;
    }).filter(Boolean);
  }

  function processStyledBidirectionalText(text, styleIndices, lineBreakPoints) {
    var sanitized = sanitizeToHebrewOrEnglish(text);
    if (!sanitized) return [];
    var rawLines = splitLinesWithStyles(sanitized, styleIndices, lineBreakPoints);
    return rawLines.map(function (entry) {
      var res = convertLineToVisualOrder(entry.line, entry.styles);
      return [res.text, res.styles];
    }).filter(function (pair) { return Boolean(pair[0]); });
  }

  if (typeof self !== 'undefined' && typeof self.registerRTLTextPlugin === 'function') {
    self.registerRTLTextPlugin({
      applyArabicShaping: applyArabicShaping,
      processBidirectionalText: processBidirectionalText,
      processStyledBidirectionalText: processStyledBidirectionalText
    });
  }
})();
`;
fs.writeFileSync(path.join(ASSETS_DIR, 'rtl-text-plugin.js'), rtlPluginCode, 'utf-8');

// 4. Offline Service Worker (public/sw.js)
// Note: Map data files (*.pmtiles, *.geojson, *.idx) live on Firebase Data Hosting
// (navapp-israel-topo-data.web.app) and are cached in OPFS / Native storage, never in APP_SHELL.
const userIconsDir = path.join(ASSETS_DIR, 'user-icons');
const userIconAssets = fs.existsSync(userIconsDir)
  ? fs
      .readdirSync(userIconsDir)
      .filter((f) => f.endsWith('.svg') || f.endsWith('.json'))
      .map((f) => `/assets/user-icons/${f}`)
  : [];

const poiSymbolsDir = path.join(ASSETS_DIR, 'poi-symbols');
const poiSymbolAssets = fs.existsSync(poiSymbolsDir)
  ? fs
      .readdirSync(poiSymbolsDir)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => `/assets/poi-symbols/${f}`)
  : [];

const appShellEntries = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/assets/rtl-text-plugin.js',
  '/assets/sprites/sprite.json',
  '/assets/sprites/sprite.png',
  '/assets/sprites/sprite@2x.json',
  '/assets/sprites/sprite@2x.png',
  ...userIconAssets,
  ...poiSymbolAssets
];

const swCode = `const CACHE_NAME = 'navapp-offline-v12';
const APP_SHELL = ${JSON.stringify(appShellEntries, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept byte-range requests to large .pmtiles files or cross-origin requests (e.g. Google Satellite tiles)
  if (
    url.pathname.endsWith('.pmtiles') ||
    event.request.headers.get('range') ||
    url.origin !== self.location.origin
  ) {
    return;
  }
  // Network-first for updatable lightweight data files (POIs & search index) so updates propagate without losing offline fallback
  if (
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.pathname === '/data/Israel.pois.geojson' ||
      url.pathname === '/data/Israel.offroad.pois.geojson' ||
      url.pathname === '/data/Israel.search.idx')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((response) => {
            if (
              event.request.method === 'GET' &&
              response.status === 200 &&
              url.origin === self.location.origin
            ) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match('/index.html'))
      );
    })
  );
});
`;
fs.writeFileSync(path.join(PUBLIC_DIR, 'sw.js'), swCode, 'utf-8');

console.log('[Offline Assets] Generated manifest.webmanifest, rtl-text-plugin.js, and sw.js in public/');

await generateCarStyleAssets();
