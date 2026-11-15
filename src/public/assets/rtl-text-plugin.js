/**
 * NavApp 100% Offline Hebrew & BiDi RTL Text Plugin for MapLibre GL JS Web Worker
 * Enables 'Hebr' script rendering in MapLibre v5 and converts logical Hebrew + mixed LTR
 * strings into visual Left-to-Right glyph layout order.
 */
(function () {
  var HEBREW_CHAR_REGEX = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
  var RTL_CHAR_REGEX = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
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
    if (rawText.indexOf('\u200B|||') !== -1) {
      var sp = rawText.split('\u200B|||');
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

    var lines = candidate.split('\n');
    var cleanedLines = [];
    for (var idx = 0; idx < lines.length; idx++) {
      var line = lines[idx].trim();
      if (!line) continue;
      if (HEBREW_CHAR_REGEX.test(line)) {
        var hebLine = line;
        if (/\s*(?:\/|\||—|–|\s-\s)\s*/.test(hebLine)) {
          var parts = hebLine.split(/\s*(?:\/|\||—|–|\s-\s)\s*/).map(function (p) { return p.trim(); }).filter(function (p) {
            return HEBREW_CHAR_REGEX.test(p) || /^[0-9()mMמ׳'״.,+-]+$/.test(p);
          });
          if (parts.length > 0) hebLine = parts.join(' — ');
        }
        hebLine = hebLine
          .replace(/[^\u0590-\u05FF\uFB1D-\uFB4F0-9\s'"׳״־–—()\[\].,:;!?+-/*°%xXmM▲]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (hebLine && (HEBREW_CHAR_REGEX.test(hebLine) || /[0-9]/.test(hebLine))) {
          cleanedLines.push(hebLine);
        }
      } else if (STRONG_LTR_REGEX.test(line)) {
        var engLine = line;
        if (/\s*(?:\/|\||—|–|\s-\s)\s*/.test(engLine)) {
          var eParts = engLine.split(/\s*(?:\/|\||—|–|\s-\s)\s*/).map(function (p) { return p.trim(); }).filter(function (p) {
            return STRONG_LTR_REGEX.test(p);
          });
          if (eParts.length > 0) engLine = eParts.join(' - ');
        }
        engLine = engLine
          .replace(/[^\u0020-\u007E\u00A0-\u024F–—()\[\]'".,:;!?0-9+-/*°%]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (engLine && STRONG_LTR_REGEX.test(engLine)) {
          cleanedLines.push(engLine);
        }
      }
    }
    return cleanedLines.join('\n');
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
