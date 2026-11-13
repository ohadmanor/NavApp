#!/usr/bin/env node
/**
 * devops/recategorize-pois.mjs
 *
 * Text-integrated recategorization pipeline for both bundled POI datasets:
 *   - data/Israel.pois.geojson -> public/data/Israel.pois.geojson
 *   - data/Israel.offroad.pois.geojson -> public/data/Israel.offroad.pois.geojson
 *
 * Uses src/core/pois/poiClassifier.ts and src/core/pois/poiTaxonomy.ts via esbuild
 * so offline migration matches runtime import classification 1-to-1.
 *
 * Flags:
 *   --dry-run   Compute transitions and print audit report without modifying files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPoiClassifierModule } from './load-poi-classifier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const DATASETS = [
  {
    name: 'Israel.pois.geojson',
    dataPath: path.join(ROOT_DIR, 'data', 'Israel.pois.geojson'),
  },
  {
    name: 'Israel.offroad.pois.geojson',
    dataPath: path.join(ROOT_DIR, 'data', 'Israel.offroad.pois.geojson'),
  },
];

function summarizeMap(mapObj, topN = 18) {
  return Object.entries(mapObj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const { classifyPoiWithText, resolvePoiSymbolId, POI_SYMBOL_BY_ID } =
    await loadPoiClassifierModule();

  for (const ds of DATASETS) {
    const raw = fs.readFileSync(ds.dataPath, 'utf8');
    const fc = JSON.parse(raw);
    const features = Array.isArray(fc.features) ? fc.features : [];

    const beforeCats = {};
    const afterCats = {};
    const beforeSubcats = {};
    const afterSubcats = {};
    const catTransitions = {};
    const samplesChanged = [];

    for (const feat of features) {
      const p = feat.properties || {};
      const prevCat = String(p.category || 'heritage');
      const prevSub = String(p.subcategory || '');

      beforeCats[prevCat] = (beforeCats[prevCat] || 0) + 1;
      beforeSubcats[`${prevCat}:${prevSub}`] = (beforeSubcats[`${prevCat}:${prevSub}`] || 0) + 1;

      const classified = classifyPoiWithText({
        nameHe: p.nameHe,
        nameEn: p.nameEn,
        name: p.name,
        descHe: p.descHe,
        descEn: p.descEn,
        waterStatus: p.waterStatus,
        difficulty4x4: p.difficulty4x4,
        existingCategory: prevCat,
        existingSubcategory: prevSub,
        source: p.source,
        ele: typeof p.ele === 'number' ? p.ele : null,
        wikipedia: p.wikipedia,
      });

      const resolvedSymbol = resolvePoiSymbolId(classified.category, classified.subcategory);
      const spec = POI_SYMBOL_BY_ID[resolvedSymbol];
      if (!spec || spec.category !== classified.category) {
        throw new Error(
          `1-to-1 invariant violated on ${p.id || p.nameHe}: ${classified.category}/${classified.subcategory} -> ${resolvedSymbol}`
        );
      }

      afterCats[classified.category] = (afterCats[classified.category] || 0) + 1;
      afterSubcats[`${classified.category}:${classified.subcategory}`] =
        (afterSubcats[`${classified.category}:${classified.subcategory}`] || 0) + 1;

      const trKey = `${prevCat} -> ${classified.category}`;
      catTransitions[trKey] = (catTransitions[trKey] || 0) + 1;

      if (prevCat !== classified.category || prevSub !== classified.subcategory) {
        if (
          samplesChanged.length < 25 &&
          (prevSub === 'offroad_poi' || prevSub === 'offroad_photo' || prevCat !== classified.category)
        ) {
          samplesChanged.push({
            nameHe: p.nameHe || p.name,
            from: `${prevCat}:${prevSub}`,
            to: `${classified.category}:${classified.subcategory}`,
            symbol: resolvedSymbol,
            desc: String(p.descHe || '').slice(0, 70),
          });
        }
      }

      p.category = classified.category;
      p.subcategory = classified.subcategory;
      p.symbolId = resolvedSymbol;
      feat.properties = p;
    }

    // Assert zero legacy catch-alls
    if ((afterSubcats['heritage:offroad_poi'] || 0) > 0 || (afterSubcats['heritage:offroad_photo'] || 0) > 0) {
      throw new Error(`Legacy catch-all subcategories still present in ${ds.name}`);
    }

    console.log(`\n==================== ${ds.name} (${features.length} POIs) ====================`);
    console.log('Before categories:', beforeCats);
    console.log('After categories: ', afterCats);
    console.log('Top transitions:  ', summarizeMap(catTransitions, 15));
    console.log('Top subcategories (after):', summarizeMap(afterSubcats, 24));
    console.log('Sample transitions:');
    for (const s of samplesChanged.slice(0, 15)) {
      console.log(`  [${s.from}] -> [${s.to}] (${s.symbol}) | "${s.nameHe}" | "${s.desc}"`);
    }

    if (!isDryRun) {
      fc.metadata = {
        ...(fc.metadata || {}),
        recategorizedAt: new Date().toISOString(),
        taxonomyVersion: '2.0-exclusive-31',
      };
      const outJson = JSON.stringify(fc);
      fs.writeFileSync(ds.dataPath, outJson, 'utf8');
      console.log(`✓ Written migrated dataset to data/${ds.name}`);
    }
  }
}

main().catch((err) => {
  console.error('[recategorize-pois] Failed:', err);
  process.exit(1);
});
