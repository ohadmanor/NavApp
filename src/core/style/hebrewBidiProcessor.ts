import maplibregl from 'maplibre-gl';

const HEBREW_CHAR_REGEX = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
const RTL_CHAR_REGEX = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
const STRONG_LTR_REGEX = /[A-Za-z0-9]/;
const LATIN_LETTER_REGEX = /[A-Za-z]/;
const NUMERIC_OR_LATIN_CONNECTOR_REGEX = /[.,/:+%°-]/;
const HEBREW_INTERNAL_PUNCT_REGEX = /['"׳״־-]/;

const MIRRORED_BRACKETS: Record<string, string> = {
  '(': ')',
  ')': '(',
  '[': ']',
  ']': '[',
  '{': '}',
  '}': '{',
  '<': '>',
  '>': '<',
  '«': '»',
  '»': '«',
};

type BidiCharType = 'R' | 'L' | 'N';

interface IndexedChar {
  char: string;
  styleIndex: number;
  type: BidiCharType;
}

/**
 * Sanitizes any map or POI label so that:
 *  1. If Hebrew exists, ONLY Hebrew (plus attached numbers/elevations like "(574)" or "4x4") is displayed.
 *  2. If no Hebrew exists, ONLY English / Latin / numeric text is displayed.
 *  3. Any other script (e.g. Arabic "البقار", Cyrillic, etc.) is stripped or hidden ("").
 */
export function sanitizeToHebrewOrEnglish(rawText: string): string {
  if (!rawText) return '';

  // Handle "primary\u200B|||englishFallback" composite expressions from style layers
  let candidate = rawText;
  if (rawText.includes('\u200B|||')) {
    const [primary = '', fallbackEn = ''] = rawText.split('\u200B|||');
    if (HEBREW_CHAR_REGEX.test(primary)) {
      candidate = primary;
    } else if (LATIN_LETTER_REGEX.test(fallbackEn)) {
      candidate = fallbackEn;
    } else {
      candidate = primary || fallbackEn;
    }
  }

  const lines = candidate.split('\n');
  const cleanedLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (HEBREW_CHAR_REGEX.test(line)) {
      // Line contains Hebrew: if it is a multi-language delimited string (e.g. "ירושלים / القدس / Jerusalem"),
      // keep only segments that contain Hebrew or numbers/elevations.
      let hebLine = line;
      if (/\s*(?:\/|\||—|–|\s-\s)\s*/.test(hebLine)) {
        const parts = hebLine
          .split(/\s*(?:\/|\||—|–|\s-\s)\s*/)
          .map((p) => p.trim())
          .filter((p) => HEBREW_CHAR_REGEX.test(p) || /^[0-9()mMמ׳'״.,+-]+$/.test(p));
        if (parts.length > 0) {
          hebLine = parts.join(' — ');
        }
      }
      // Strip any non-Hebrew, non-Latin-numeric/punctuation scripts (such as Arabic)
      // Also if Hebrew is present, strip trailing/leading pure-English translation words unless part of "4x4"
      hebLine = hebLine
        .replace(/[^\u0590-\u05FF\uFB1D-\uFB4F0-9\s'"׳״־–—()\[\].,:;!?+-/*°%xXmM▲]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (hebLine && (HEBREW_CHAR_REGEX.test(hebLine) || /[0-9]/.test(hebLine))) {
        cleanedLines.push(hebLine);
      }
    } else if (STRONG_LTR_REGEX.test(line)) {
      // No Hebrew on this line, fall back to English / Latin / Numbers
      let engLine = line;
      if (/\s*(?:\/|\||—|–|\s-\s)\s*/.test(engLine)) {
        const parts = engLine
          .split(/\s*(?:\/|\||—|–|\s-\s)\s*/)
          .map((p) => p.trim())
          .filter((p) => STRONG_LTR_REGEX.test(p));
        if (parts.length > 0) {
          engLine = parts.join(' - ');
        }
      }
      engLine = engLine
        .replace(/[^\u0020-\u007E\u00A0-\u024F–—()\[\]'".,:;!?0-9+-/*°%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (engLine && STRONG_LTR_REGEX.test(engLine)) {
        cleanedLines.push(engLine);
      }
    }
    // If neither Hebrew nor English/digits exist (e.g. pure Arabic "البقار"), drop the line completely.
  }

  return cleanedLines.join('\n');
}

/**
 * Determines whether a string contains any Hebrew RTL characters.
 */
export function containsRtlText(text: string): boolean {
  return RTL_CHAR_REGEX.test(text);
}

/**
 * Converts a single logical line of text (and its per-character style indices)
 * into visual Left-to-Right glyph order for MapLibre GL JS rendering.
 */
export function convertLineToVisualOrder(
  lineText: string,
  styleIndices?: number[]
): { text: string; styles: number[] } {
  const sanitized = sanitizeToHebrewOrEnglish(lineText);
  if (!sanitized) {
    return { text: '', styles: [] };
  }

  const chars = Array.from(sanitized);
  const styles =
    styleIndices && styleIndices.length === chars.length
      ? [...styleIndices]
      : chars.map(() => 0);

  if (!containsRtlText(sanitized)) {
    return { text: sanitized, styles };
  }

  // Step 1: Initial character classification
  const items: IndexedChar[] = chars.map((char, idx) => {
    let type: BidiCharType = 'N';
    if (RTL_CHAR_REGEX.test(char)) {
      type = 'R';
    } else if (STRONG_LTR_REGEX.test(char)) {
      type = 'L';
    }
    return {
      char,
      styleIndex: styles[idx] ?? 0,
      type,
    };
  });

  // Step 2: Context resolution for internal punctuation and number/unit suffixes
  for (let i = 0; i < items.length; i++) {
    if (items[i].type !== 'N') continue;
    const prevType = i > 0 ? items[i - 1].type : null;
    const nextType = i + 1 < items.length ? items[i + 1].type : null;
    const ch = items[i].char;

    // Keep Hebrew abbreviations & hyphenated words together (e.g., ת"א, ג'בל, באר-שבע)
    if (prevType === 'R' && nextType === 'R' && HEBREW_INTERNAL_PUNCT_REGEX.test(ch)) {
      items[i].type = 'R';
      continue;
    }

    // Keep trailing geresh on Hebrew abbreviations (e.g., רח', הר')
    if (prevType === 'R' && (ch === "'" || ch === '׳')) {
      items[i].type = 'R';
      continue;
    }

    // Keep numbers with decimals, slashes, or minus signs together (e.g., 12.5, 4x4, -150m)
    if (
      NUMERIC_OR_LATIN_CONNECTOR_REGEX.test(ch) &&
      (prevType === 'L' || nextType === 'L')
    ) {
      items[i].type = 'L';
    }
  }

  // Step 3: Group consecutive characters with the same resolved BiDi class into runs
  const runs: Array<{ type: BidiCharType; items: IndexedChar[] }> = [];
  for (const item of items) {
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.type === item.type) {
      lastRun.items.push(item);
    } else {
      runs.push({ type: item.type, items: [item] });
    }
  }

  // Step 4: Under RTL base direction, reverse the run sequence
  runs.reverse();

  // Step 5: Order characters within each run
  const visualItems: IndexedChar[] = [];
  for (const run of runs) {
    if (run.type === 'R') {
      const reversed = [...run.items].reverse();
      visualItems.push(...reversed);
    } else if (run.type === 'L') {
      visualItems.push(...run.items);
    } else {
      const reversed = [...run.items].reverse().map((it) => ({
        ...it,
        char: MIRRORED_BRACKETS[it.char] ?? it.char,
      }));
      visualItems.push(...reversed);
    }
  }

  return {
    text: visualItems.map((it) => it.char).join(''),
    styles: visualItems.map((it) => it.styleIndex),
  };
}

/**
 * Splits logical text by MapLibre's UTF-16 code unit lineBreakPoints.
 */
function splitLinesWithStyles(
  text: string,
  styleIndices: number[] | undefined,
  lineBreakPoints: number[] | undefined
): Array<{ line: string; styles: number[] }> {
  const fullStyles =
    styleIndices && styleIndices.length === text.length
      ? styleIndices
      : Array.from({ length: text.length }, () => 0);

  if (!lineBreakPoints || lineBreakPoints.length === 0) {
    return [{ line: text, styles: fullStyles }];
  }

  const lines: Array<{ line: string; styles: number[] }> = [];
  let start = 0;

  for (const rawBreak of lineBreakPoints) {
    const bp = Math.max(start, Math.min(text.length, rawBreak));
    if (bp > start) {
      let sliceText = text.substring(start, bp);
      let sliceStyles = fullStyles.slice(start, bp);
      while (sliceText.length > 0 && /\s/.test(sliceText[sliceText.length - 1])) {
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
    const remText = text.substring(start);
    const remStyles = fullStyles.slice(start);
    if (remText.length > 0) {
      lines.push({ line: remText, styles: remStyles });
    }
  }

  return lines.length > 0 ? lines : [{ line: text, styles: fullStyles }];
}

/**
 * MapLibre GL JS calls applyArabicShaping on EVERY text section before shaping glyphs.
 * By running sanitizeToHebrewOrEnglish here, any non-Hebrew/non-English label (like Arabic "البقار")
 * is filtered out or replaced by its Hebrew/English equivalent before MapLibre renders it.
 */
export function applyArabicShaping(text: string): string {
  return sanitizeToHebrewOrEnglish(text);
}

export function processBidirectionalText(
  text: string,
  lineBreakPoints: number[]
): string[] {
  const sanitized = sanitizeToHebrewOrEnglish(text);
  if (!sanitized) return [];
  const rawLines = splitLinesWithStyles(sanitized, undefined, lineBreakPoints);
  return rawLines.map(({ line }) => convertLineToVisualOrder(line).text).filter(Boolean);
}

export function processStyledBidirectionalText(
  text: string,
  styleIndices: number[],
  lineBreakPoints: number[]
): Array<[string, number[]]> {
  const sanitized = sanitizeToHebrewOrEnglish(text);
  if (!sanitized) return [];
  const rawLines = splitLinesWithStyles(sanitized, styleIndices, lineBreakPoints);
  return rawLines
    .map(({ line, styles }) => {
      const res = convertLineToVisualOrder(line, styles);
      return [res.text, res.styles] as [string, number[]];
    })
    .filter(([t]) => Boolean(t));
}

let rtlRegistered = false;

const RTL_WORKER_SCRIPT = `(function () {
  var HEBREW_CHAR_REGEX = /[\\u0590-\\u05FF\\uFB1D-\\uFB4F]/;
  var RTL_CHAR_REGEX = /[\\u0590-\\u05FF\\uFB1D-\\uFB4F]/;
  var STRONG_LTR_REGEX = /[A-Za-z0-9]/;
  var LATIN_LETTER_REGEX = /[A-Za-z]/;
  var NUMERIC_CONNECTOR_REGEX = /[.,/:+%°-]/;
  var HEBREW_INTERNAL_PUNCT_REGEX = /['"׳״־-]/;
  var MIRRORED_BRACKETS = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

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
    var styles = styleIndices && styleIndices.length === chars.length ? styleIndices.slice() : chars.map(function () { return 0; });
    if (!containsRtlText(sanitized)) return { text: sanitized, styles: styles };

    var items = chars.map(function (ch, idx) {
      var type = 'N';
      if (RTL_CHAR_REGEX.test(ch)) type = 'R';
      else if (STRONG_LTR_REGEX.test(ch)) type = 'L';
      return { char: ch, styleIndex: styles[idx] !== undefined ? styles[idx] : 0, type: type };
    });

    for (var i = 0; i < items.length; i++) {
      if (items[i].type !== 'N') continue;
      var prevType = i > 0 ? items[i - 1].type : null;
      var nextType = i + 1 < items.length ? items[i + 1].type : null;
      var ch = items[i].char;
      if (prevType === 'R' && nextType === 'R' && HEBREW_INTERNAL_PUNCT_REGEX.test(ch)) { items[i].type = 'R'; continue; }
      if (prevType === 'R' && (ch === "'" || ch === '׳')) { items[i].type = 'R'; continue; }
      if (NUMERIC_CONNECTOR_REGEX.test(ch) && (prevType === 'L' || nextType === 'L')) { items[i].type = 'L'; }
    }

    var runs = [];
    for (var j = 0; j < items.length; j++) {
      var item = items[j];
      var lastRun = runs.length > 0 ? runs[runs.length - 1] : null;
      if (lastRun && lastRun.type === item.type) lastRun.items.push(item);
      else runs.push({ type: item.type, items: [item] });
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
          visualItems.push({ char: MIRRORED_BRACKETS[it.char] || it.char, styleIndex: it.styleIndex, type: it.type });
        }
      }
    }

    return {
      text: visualItems.map(function (it) { return it.char; }).join(''),
      styles: visualItems.map(function (it) { return it.styleIndex; })
    };
  }

  function splitLinesWithStyles(text, styleIndices, lineBreakPoints) {
    var fullStyles = styleIndices && styleIndices.length === text.length ? styleIndices : Array.from({ length: text.length }, function () { return 0; });
    if (!lineBreakPoints || lineBreakPoints.length === 0) return [{ line: text, styles: fullStyles }];
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
        if (sliceText.length > 0) lines.push({ line: sliceText, styles: sliceStyles });
        start = bp;
      }
    }
    if (start < text.length) {
      var remText = text.substring(start);
      var remStyles = fullStyles.slice(start);
      if (remText.length > 0) lines.push({ line: remText, styles: remStyles });
    }
    return lines.length > 0 ? lines : [{ line: text, styles: fullStyles }];
  }

  if (typeof self !== 'undefined' && typeof self.registerRTLTextPlugin === 'function') {
    self.registerRTLTextPlugin({
      applyArabicShaping: function (t) { return sanitizeToHebrewOrEnglish(t); },
      processBidirectionalText: function (text, lineBreakPoints) {
        var sanitized = sanitizeToHebrewOrEnglish(text);
        if (!sanitized) return [];
        return splitLinesWithStyles(sanitized, undefined, lineBreakPoints).map(function (e) {
          return convertLineToVisualOrder(e.line).text;
        }).filter(Boolean);
      },
      processStyledBidirectionalText: function (text, styleIndices, lineBreakPoints) {
        var sanitized = sanitizeToHebrewOrEnglish(text);
        if (!sanitized) return [];
        return splitLinesWithStyles(sanitized, styleIndices, lineBreakPoints).map(function (e) {
          var res = convertLineToVisualOrder(e.line, e.styles);
          return [res.text, res.styles];
        }).filter(function (pair) { return Boolean(pair[0]); });
      }
    });
  }
})();`;

/**
 * Registers the 100% offline Hebrew/RTL text plugin with MapLibre GL JS via an in-memory Blob URL
 * so that:
 *  1. Only Hebrew names/tags are displayed (or English if no Hebrew exists; Arabic/other scripts are stripped).
 *  2. All Hebrew place names, peaks, wadis, parks, trails, and POIs render Right-to-Left.
 */
export function registerOfflineRtlTextPlugin(): void {
  if (rtlRegistered) return;
  try {
    const status =
      typeof maplibregl.getRTLTextPluginStatus === 'function'
        ? maplibregl.getRTLTextPluginStatus()
        : 'unavailable';

    if (status === 'unavailable' && typeof maplibregl.setRTLTextPlugin === 'function') {
      let pluginUrl: string;
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const blob = new Blob([RTL_WORKER_SCRIPT], { type: 'application/javascript' });
        pluginUrl = URL.createObjectURL(blob);
      } else {
        const origin =
          typeof window !== 'undefined' && window.location?.origin
            ? window.location.origin
            : 'http://localhost:5173';
        pluginUrl = `${origin}/assets/rtl-text-plugin.js`;
      }
      maplibregl.setRTLTextPlugin(pluginUrl, false).catch(() => {});
    }
    rtlRegistered = true;
  } catch {
    // Ignore in headless test environments where Worker is mocked
  }
}
