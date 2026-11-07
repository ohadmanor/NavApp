import maplibregl from 'maplibre-gl';

/**
 * 100% Offline Procedural PBF Glyph Protocol (`offline-glyphs://{fontstack}/{range}.pbf`).
 *
 * MapLibre GL JS requires PBF-encoded Signed Distance Field (SDF) glyphs to render
 * contour elevation numbers ("120m", "250m"), mountain peak elevations, and Hebrew/Latin names.
 * Instead of relying on an internet font server (which fails offline), this protocol rasterizes
 * requested Unicode codepoints (ASCII digits, Latin, Punctuation, and Hebrew א-ת) on the fly
 * using the device's system fonts and encodes a valid Mapbox/MapLibre Glyph PBF in-memory.
 */

const glyphRangeCache = new Map<string, ArrayBuffer>();

function writeVarint(bytes: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
}

function writeSVarint(bytes: number[], value: number): void {
  const zigzag = (value << 1) ^ (value >> 31);
  writeVarint(bytes, zigzag);
}

function writeTag(bytes: number[], fieldNumber: number, wireType: number): void {
  writeVarint(bytes, (fieldNumber << 3) | wireType);
}

function writeBytesField(bytes: number[], fieldNumber: number, payload: number[] | Uint8Array): void {
  writeTag(bytes, fieldNumber, 2);
  writeVarint(bytes, payload.length);
  for (let i = 0; i < payload.length; i++) {
    bytes.push(payload[i]);
  }
}

function writeStringField(bytes: number[], fieldNumber: number, str: string): void {
  const encoded = new TextEncoder().encode(str);
  writeBytesField(bytes, fieldNumber, encoded);
}

/**
 * Renders a single Unicode character into a 24pt SDF alpha bitmap wrapped in a 3px border.
 */
function renderCharToSdfGlyph(charCode: number): number[] | null {
  if (typeof document === 'undefined') return null;

  // Only rasterize printable ranges we actually use on maps:
  // Basic ASCII (32..126), Latin-1 (160..255), Hebrew (1488..1514), General Punctuation / Symbols
  const isPrintable =
    (charCode >= 32 && charCode <= 126) ||
    (charCode >= 160 && charCode <= 255) ||
    (charCode >= 1488 && charCode <= 1514) ||
    charCode === 9650; // ▲ peak triangle

  if (!isPrintable) return null;

  const ch = String.fromCodePoint(charCode);
  const fontSize = 24;
  const buffer = 3;
  const canvasSize = 40;

  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvasSize, canvasSize);
  ctx.font = `bold ${fontSize}px "Segoe UI", "Arial", sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';

  const metrics = ctx.measureText(ch);
  const rawWidth = Math.ceil(metrics.width);
  const advance = Math.max(6, rawWidth + 1);

  if (charCode === 32) {
    // Space character: no bitmap needed, only advance
    const glyphMsg: number[] = [];
    writeTag(glyphMsg, 1, 0);
    writeVarint(glyphMsg, charCode);
    writeTag(glyphMsg, 3, 0);
    writeVarint(glyphMsg, 0);
    writeTag(glyphMsg, 4, 0);
    writeVarint(glyphMsg, 0);
    writeTag(glyphMsg, 5, 0);
    writeSVarint(glyphMsg, 0);
    writeTag(glyphMsg, 6, 0);
    writeSVarint(glyphMsg, 0);
    writeTag(glyphMsg, 7, 0);
    writeVarint(glyphMsg, advance);
    return glyphMsg;
  }

  const glyphW = Math.min(30, Math.max(8, rawWidth + 2));
  const glyphH = 26;
  const drawX = buffer + 1;
  const drawY = buffer + 20;

  ctx.fillText(ch, drawX, drawY);
  const imgData = ctx.getImageData(0, 0, glyphW + buffer * 2, glyphH + buffer * 2);
  const rgba = imgData.data;
  const outW = glyphW + buffer * 2;
  const outH = glyphH + buffer * 2;

  // Build approximate SDF around the alpha channel (0..255 with 192 as the 0.75 contour threshold)
  const sdf = new Uint8Array(outW * outH);
  const inside = new Uint8Array(outW * outH);
  for (let i = 0; i < outW * outH; i++) {
    inside[i] = rgba[i * 4 + 3] > 96 ? 1 : 0;
  }

  const maxRadius = 4;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const idx = y * outW + x;
      const isIn = inside[idx];
      let minDistSq = maxRadius * maxRadius;

      for (let dy = -maxRadius; dy <= maxRadius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= outH) continue;
        for (let dx = -maxRadius; dx <= maxRadius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= outW) continue;
          if (inside[ny * outW + nx] !== isIn) {
            const dSq = dx * dx + dy * dy;
            if (dSq < minDistSq) minDistSq = dSq;
          }
        }
      }

      const dist = Math.sqrt(minDistSq);
      const signed = isIn ? dist : -dist;
      // MapLibre SDF cutoff is 0.25 from top (192 = edge)
      const val = Math.round(192 + (signed / maxRadius) * 63);
      sdf[idx] = Math.max(0, Math.min(255, val));
    }
  }

  const glyphMsg: number[] = [];
  // 1: id (uint32)
  writeTag(glyphMsg, 1, 0);
  writeVarint(glyphMsg, charCode);
  // 2: bitmap (bytes)
  writeBytesField(glyphMsg, 2, sdf);
  // 3: width (uint32, excluding buffer)
  writeTag(glyphMsg, 3, 0);
  writeVarint(glyphMsg, glyphW);
  // 4: height (uint32, excluding buffer)
  writeTag(glyphMsg, 4, 0);
  writeVarint(glyphMsg, glyphH);
  // 5: left (sint32)
  writeTag(glyphMsg, 5, 0);
  writeSVarint(glyphMsg, 0);
  // 6: top (sint32)
  writeTag(glyphMsg, 6, 0);
  writeSVarint(glyphMsg, 10);
  // 7: advance (uint32)
  writeTag(glyphMsg, 7, 0);
  writeVarint(glyphMsg, advance);

  return glyphMsg;
}

function buildGlyphRangePbf(fontstack: string, startCode: number, endCode: number): ArrayBuffer {
  const cacheKey = `${fontstack}:${startCode}-${endCode}`;
  const existing = glyphRangeCache.get(cacheKey);
  if (existing) return existing;

  const stackMsg: number[] = [];
  writeStringField(stackMsg, 1, fontstack);
  writeStringField(stackMsg, 2, `${startCode}-${endCode}`);

  for (let code = startCode; code <= endCode; code++) {
    const glyphBytes = renderCharToSdfGlyph(code);
    if (glyphBytes) {
      writeBytesField(stackMsg, 3, glyphBytes);
    }
  }

  const rootMsg: number[] = [];
  writeBytesField(rootMsg, 1, stackMsg);

  const buf = new Uint8Array(rootMsg).buffer;
  glyphRangeCache.set(cacheKey, buf);
  return buf;
}

let isGlyphProtocolRegistered = false;

export function registerOfflineGlyphsProtocol(): void {
  if (isGlyphProtocolRegistered) return;
  isGlyphProtocolRegistered = true;

  maplibregl.addProtocol('offline-glyphs', async (params) => {
    // URL format: offline-glyphs://{fontstack}/{start}-{end}.pbf
    const match = /offline-glyphs:\/\/([^/]+)\/(\d+)-(\d+)\.pbf/.exec(
      decodeURIComponent(params.url)
    );
    const fontstack = match ? match[1] : 'Military-Sans';
    const start = match ? parseInt(match[2], 10) : 0;
    const end = match ? parseInt(match[3], 10) : 255;

    const data = buildGlyphRangePbf(fontstack, start, end);
    return { data };
  });
}

