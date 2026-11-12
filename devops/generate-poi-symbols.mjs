#!/usr/bin/env node
/**
 * devops/generate-poi-symbols.mjs
 *
 * Compiles the 31 exclusive modern POI SVG symbols from src/core/pois/poiSymbolSvg.ts into:
 *   1. public/assets/poi-symbols/<symbolId>.svg (standalone vector icons)
 *   2. public/assets/sprites/sprite.png + sprite.json (@1x, preserving all non-POI sprites in-place)
 *   3. public/assets/sprites/sprite@2x.png + sprite@2x.json (@2x, preserving all non-POI sprites in-place)
 *   4. Syncs updated sprite files into android/app/src/main/assets/public/assets/sprites/ if present.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const SPRITES_DIR = path.join(ROOT_DIR, 'public', 'assets', 'sprites');
const SVG_OUT_DIR = path.join(ROOT_DIR, 'public', 'assets', 'poi-symbols');
const ANDROID_SPRITES_DIR = path.join(
  ROOT_DIR,
  'android',
  'app',
  'src',
  'main',
  'assets',
  'public',
  'assets',
  'sprites'
);

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Could not find Chrome/Edge executable to rasterize SVG sprites.');
}

async function loadSymbolSvgEntries() {
  const entryPath = path.join(ROOT_DIR, 'src', 'core', 'pois', 'poiSymbolSvg.ts');
  const bundled = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
  });
  const moduleShim = { exports: {} };
  const context = vm.createContext({
    module: moduleShim,
    exports: moduleShim.exports,
    console,
  });
  vm.runInContext(bundled.outputFiles[0].text, context);
  const { getAllPoiSymbolSvgEntries } = moduleShim.exports;
  if (typeof getAllPoiSymbolSvgEntries !== 'function') {
    throw new Error('Failed to load getAllPoiSymbolSvgEntries');
  }
  return getAllPoiSymbolSvgEntries();
}

function getBaseCropExtent(spriteJson, pixelRatio) {
  let maxX = 0;
  let maxY = 0;
  const cleaned = {};
  for (const [k, v] of Object.entries(spriteJson)) {
    if (k.startsWith('poi-')) continue;
    cleaned[k] = v;
    const right = Number(v.x || 0) + Number(v.width || 0);
    const bottom = Number(v.y || 0) + Number(v.height || 0);
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  return {
    cleanedJson: cleaned,
    baseWidth: Math.max(maxX, 512 * pixelRatio),
    baseHeight: maxY,
  };
}

async function main() {
  const entries = await loadSymbolSvgEntries();
  fs.mkdirSync(SVG_OUT_DIR, { recursive: true });
  for (const entry of entries) {
    fs.writeFileSync(path.join(SVG_OUT_DIR, `${entry.id}.svg`), entry.svg1x, 'utf-8');
  }
  console.log(`[POI Symbols] Wrote ${entries.length} standalone SVGs to public/assets/poi-symbols/`);

  const spriteJson1Path = path.join(SPRITES_DIR, 'sprite.json');
  const spritePng1Path = path.join(SPRITES_DIR, 'sprite.png');
  const spriteJson2Path = path.join(SPRITES_DIR, 'sprite@2x.json');
  const spritePng2Path = path.join(SPRITES_DIR, 'sprite@2x.png');

  const rawJson1 = JSON.parse(fs.readFileSync(spriteJson1Path, 'utf-8'));
  const rawJson2 = JSON.parse(fs.readFileSync(spriteJson2Path, 'utf-8'));
  const rawPng1 = fs.readFileSync(spritePng1Path);
  const rawPng2 = fs.readFileSync(spritePng2Path);

  const base1 = getBaseCropExtent(rawJson1, 1);
  const base2 = getBaseCropExtent(rawJson2, 2);

  const browserPath = findBrowserExecutable();
  const cols = 10;
  const cell1x = 40;
  const icon1x = 36;
  const rows = Math.ceil(entries.length / cols);
  const outWidth1x = Math.max(base1.baseWidth, 512);
  const startY1x = Math.ceil((base1.baseHeight + 8) / 2) * 2;
  const outHeight1x = startY1x + rows * cell1x + 8;

  const cell2x = cell1x * 2;
  const icon2x = icon1x * 2;
  const outWidth2x = outWidth1x * 2;
  const startY2x = startY1x * 2;
  const outHeight2x = outHeight1x * 2;

  let resultPayload = null;
  let serverError = null;

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<script>
const ENTRIES = ${JSON.stringify(entries)};
const CONFIG = ${JSON.stringify({
    cols,
    cell1x,
    icon1x,
    startY1x,
    outWidth1x,
    outHeight1x,
    baseHeight1x: base1.baseHeight,
    cell2x,
    icon2x,
    startY2x,
    outWidth2x,
    outHeight2x,
    baseHeight2x: base2.baseHeight,
  })};

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Image load failed: ' + src.slice(0, 64)));
    img.src = src;
  });
}

async function run() {
  try {
    const [baseImg1, baseImg2] = await Promise.all([
      loadImage('/base-sprite-1x.png'),
      loadImage('/base-sprite-2x.png'),
    ]);

    const c1 = document.createElement('canvas');
    c1.width = CONFIG.outWidth1x;
    c1.height = CONFIG.outHeight1x;
    const ctx1 = c1.getContext('2d');
    ctx1.drawImage(
      baseImg1,
      0, 0, Math.min(baseImg1.width, CONFIG.outWidth1x), CONFIG.baseHeight1x,
      0, 0, Math.min(baseImg1.width, CONFIG.outWidth1x), CONFIG.baseHeight1x
    );

    const c2 = document.createElement('canvas');
    c2.width = CONFIG.outWidth2x;
    c2.height = CONFIG.outHeight2x;
    const ctx2 = c2.getContext('2d');
    ctx2.drawImage(
      baseImg2,
      0, 0, Math.min(baseImg2.width, CONFIG.outWidth2x), CONFIG.baseHeight2x,
      0, 0, Math.min(baseImg2.width, CONFIG.outWidth2x), CONFIG.baseHeight2x
    );

    const additions1x = {};
    const additions2x = {};

    for (let i = 0; i < ENTRIES.length; i++) {
      const e = ENTRIES[i];
      const col = i % CONFIG.cols;
      const row = Math.floor(i / CONFIG.cols);
      const x1 = col * CONFIG.cell1x + 4;
      const y1 = CONFIG.startY1x + row * CONFIG.cell1x;
      const x2 = x1 * 2;
      const y2 = y1 * 2;

      const svgBlob1 = new Blob([e.svg1x], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl1 = URL.createObjectURL(svgBlob1);
      const img1 = await loadImage(svgUrl1);
      ctx1.drawImage(img1, x1, y1, CONFIG.icon1x, CONFIG.icon1x);
      URL.revokeObjectURL(svgUrl1);

      const svgBlob2 = new Blob([e.svg2x], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl2 = URL.createObjectURL(svgBlob2);
      const img2 = await loadImage(svgUrl2);
      ctx2.drawImage(img2, x2, y2, CONFIG.icon2x, CONFIG.icon2x);
      URL.revokeObjectURL(svgUrl2);

      additions1x[e.id] = {
        width: CONFIG.icon1x,
        height: CONFIG.icon1x,
        x: x1,
        y: y1,
        pixelRatio: 1,
      };
      additions2x[e.id] = {
        width: CONFIG.icon2x,
        height: CONFIG.icon2x,
        x: x2,
        y: y2,
        pixelRatio: 2,
      };
    }

    await fetch('/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        png1x: c1.toDataURL('image/png'),
        png2x: c2.toDataURL('image/png'),
        additions1x,
        additions2x,
      }),
    });
  } catch (err) {
    await fetch('/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: String(err && err.stack ? err.stack : err) }),
    });
  }
}

run();
</script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && req.url === '/base-sprite-1x.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(rawPng1);
      return;
    }
    if (req.method === 'GET' && req.url === '/base-sprite-2x.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(rawPng2);
      return;
    }
    if (req.method === 'POST' && (req.url === '/done' || req.url === '/error')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (req.url === '/error') {
            serverError = new Error(body.message || 'Unknown browser rasterizer error');
          } else {
            resultPayload = body;
          }
        } catch (parseErr) {
          serverError = parseErr;
        }
        res.writeHead(200);
        res.end('ok');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const userDataDir = path.join(ROOT_DIR, '.tmp-sprite-browser');
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    browserPath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${userDataDir}`,
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: 'ignore' }
  );

  try {
    const startMs = Date.now();
    while (!resultPayload && !serverError) {
      if (Date.now() - startMs > 25000) {
        throw new Error('Timed out waiting for headless browser sprite rasterization.');
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    if (serverError) throw serverError;
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    server.close();
    await new Promise((r) => setTimeout(r, 350));
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // ignore lingering browser lock on Windows
    }
  }

  const nextPng1 = Buffer.from(resultPayload.png1x.replace(/^data:image\/png;base64,/, ''), 'base64');
  const nextPng2 = Buffer.from(resultPayload.png2x.replace(/^data:image\/png;base64,/, ''), 'base64');
  const nextJson1 = { ...base1.cleanedJson, ...resultPayload.additions1x };
  const nextJson2 = { ...base2.cleanedJson, ...resultPayload.additions2x };

  fs.writeFileSync(spritePng1Path, nextPng1);
  fs.writeFileSync(spritePng2Path, nextPng2);
  fs.writeFileSync(spriteJson1Path, JSON.stringify(nextJson1, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(spriteJson2Path, JSON.stringify(nextJson2, null, 2) + '\n', 'utf-8');

  if (fs.existsSync(ANDROID_SPRITES_DIR)) {
    fs.writeFileSync(path.join(ANDROID_SPRITES_DIR, 'sprite.png'), nextPng1);
    fs.writeFileSync(path.join(ANDROID_SPRITES_DIR, 'sprite@2x.png'), nextPng2);
    fs.writeFileSync(
      path.join(ANDROID_SPRITES_DIR, 'sprite.json'),
      JSON.stringify(nextJson1, null, 2) + '\n',
      'utf-8'
    );
    fs.writeFileSync(
      path.join(ANDROID_SPRITES_DIR, 'sprite@2x.json'),
      JSON.stringify(nextJson2, null, 2) + '\n',
      'utf-8'
    );
    console.log('[POI Symbols] Synced updated sprites into android assets.');
  }

  console.log(
    `[POI Symbols] Generated sprite.png (${outWidth1x}x${outHeight1x}) and sprite@2x.png (${outWidth2x}x${outHeight2x}) with ${entries.length} exclusive poi-* glyphs.`
  );
}

main().catch((err) => {
  console.error('[POI Symbols] Failed:', err);
  process.exit(1);
});
