#!/usr/bin/env node
/**
 * devops/build-car-styles.mjs
 *
 * Compiles src/core/style/israelOutdoorStyle.ts via esbuild (bundled with Vite) and emits
 * MapLibre-Native-compatible Style v8 JSON templates for Android Auto:
 *   - android/app/src/main/assets/car_style_day.json
 *   - android/app/src/main/assets/car_style_dark.json
 *
 * Placeholders replaced at runtime by CarStyleBuilder.java:
 *   __OSM_URL__    -> pmtiles://file:///.../Israel.osm.pmtiles (or remote https fallback)
 *   __DEM_URL__    -> pmtiles://file:///.../Israel.dem.pmtiles (or remote https fallback)
 *   __SPRITE_URL__ -> asset://public/assets/sprites/sprite
 *   __GLYPHS_URL__ -> http://127.0.0.1:<port>/glyphs/{fontstack}/{range}.pbf
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const ANDROID_ASSETS_DIR = path.join(ROOT_DIR, 'android', 'app', 'src', 'main', 'assets');

export async function generateCarStyleAssets() {
  if (!fs.existsSync(path.join(ROOT_DIR, 'android', 'app', 'src', 'main'))) {
    console.log('[Car Styles] android/ module not present yet; skipping native car style generation.');
    return;
  }

  const entryPath = path.join(ROOT_DIR, 'src', 'core', 'style', 'israelOutdoorStyle.ts');
  const bundled = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
  });

  const code = bundled.outputFiles[0].text;
  const moduleShim = { exports: {} };
  const context = vm.createContext({
    module: moduleShim,
    exports: moduleShim.exports,
    console,
    structuredClone,
  });
  vm.runInContext(code, context);

  const { buildIsraelOutdoorStyle, DEFAULT_LAYER_VISIBILITY } = moduleShim.exports;
  if (typeof buildIsraelOutdoorStyle !== 'function') {
    throw new Error('Failed to load buildIsraelOutdoorStyle from src/core/style/israelOutdoorStyle.ts');
  }

  fs.mkdirSync(ANDROID_ASSETS_DIR, { recursive: true });

  for (const theme of ['topo-day', 'topo-dark']) {
    const style = buildIsraelOutdoorStyle({
      osmProtocolUrl: '__OSM_URL__',
      demProtocolUrl: '__DEM_URL__',
      contourProtocolUrl: undefined, // MapLibre Native renders vector trails + DEM hillshade directly
      tacticalGridProtocolUrl: null, // Web tactical-grid:// protocol is JS-only
      visibility: {
        ...DEFAULT_LAYER_VISIBILITY,
        terrain3d: false,
        contours: false,
      },
      theme,
    });

    style.sprite = '__SPRITE_URL__';
    style.glyphs = '__GLYPHS_URL__';

    const fileName = theme === 'topo-dark' ? 'car_style_dark.json' : 'car_style_day.json';
    const outPath = path.join(ANDROID_ASSETS_DIR, fileName);
    fs.writeFileSync(outPath, JSON.stringify(style), 'utf-8');
    console.log(
      `[Car Styles] Generated ${path.relative(ROOT_DIR, outPath)} (${style.layers.length} layers)`
    );
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  generateCarStyleAssets().catch((err) => {
    console.error('[Car Styles] Failed:', err);
    process.exit(1);
  });
}
