import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

let cachedModule = null;

export async function loadPoiClassifierModule() {
  if (cachedModule) return cachedModule;

  const entryCode = `
    export { classifyPoiWithText } from './src/core/pois/poiClassifier';
    export {
      resolvePoiSymbolId,
      normalizeSubcategoryForCategory,
      POI_SYMBOL_BY_ID,
      POI_CATEGORY_SPECS,
    } from './src/core/pois/poiTaxonomy';
  `;

  const bundled = await esbuild.build({
    stdin: {
      contents: entryCode,
      resolveDir: ROOT_DIR,
      loader: 'ts',
    },
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
  cachedModule = moduleShim.exports;
  return cachedModule;
}
