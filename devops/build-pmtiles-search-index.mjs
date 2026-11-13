#!/usr/bin/env node
/**
 * devops/build-pmtiles-search-index.mjs
 *
 * Extracts ALL searchable vector features across every zoom level & layer inside
 * data/Israel.osm.pmtiles (places, settlements, admin areas, peaks, nature reserves,
 * waterways, dams/ridges, airports, POIs, streets, highway refs, tracks, runways)
 * and serializes a compact gzip-compressed columnar search index to:
 *   - data/Israel.search.idx
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PMTiles } from 'pmtiles';
import {
  extractSearchIndexFromPmtiles,
  serializeSearchIndexPayload,
} from '../src/core/search/pmtilesSearchCore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const inputFlagIdx = process.argv.indexOf('--input');
const INPUT_PMTILES =
  inputFlagIdx !== -1 && process.argv[inputFlagIdx + 1]
    ? path.resolve(ROOT_DIR, process.argv[inputFlagIdx + 1])
    : path.join(ROOT_DIR, 'data', 'Israel.osm.pmtiles');
const OUT_DATA_IDX = path.join(ROOT_DIR, 'data', 'Israel.search.idx');

const ifPresent = process.argv.includes('--if-present');
const ifStale = process.argv.includes('--if-stale');

if (!fs.existsSync(INPUT_PMTILES)) {
  if (ifPresent) {
    console.warn(`[SearchIndex] Skipping generation — ${INPUT_PMTILES} not found.`);
    process.exit(0);
  }
  console.error(`[SearchIndex] ERROR: Input archive not found: ${INPUT_PMTILES}`);
  process.exit(1);
}

if (ifStale && fs.existsSync(OUT_DATA_IDX)) {
  const srcMtime = fs.statSync(INPUT_PMTILES).mtimeMs;
  const dstDataMtime = fs.statSync(OUT_DATA_IDX).mtimeMs;
  if (dstDataMtime >= srcMtime) {
    console.log('[SearchIndex] Up to date — skipping rebuild.');
    process.exit(0);
  }
}

const t0 = performance.now();
const fd = fs.openSync(INPUT_PMTILES, 'r');

try {
  const source = {
    getKey: () => INPUT_PMTILES,
    async getBytes(offset, length) {
      const buf = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      return {
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead),
      };
    },
  };

  const pmtiles = new PMTiles(source);
  let lastLoggedPct = -10;
  const payload = await extractSearchIndexFromPmtiles(pmtiles, {
    gunzip: async (bytes) => new Uint8Array(zlib.gunzipSync(bytes)),
    yieldEvery: 0,
    onProgress: (done, total) => {
      const pct = Math.floor((done / Math.max(1, total)) * 100);
      if (pct >= lastLoggedPct + 25 || done === total) {
        lastLoggedPct = pct;
        console.log(`[SearchIndex] Scanning vector tiles: ${done}/${total} (${pct}%)`);
      }
    },
  });

  const layerCounts = {};
  for (const row of payload.rows) {
    const lname = payload.layers[row[0]] || 'unknown';
    layerCounts[lname] = (layerCounts[lname] || 0) + 1;
  }

  const rawJsonBytes = await serializeSearchIndexPayload(payload, { gzip: false });
  const gzippedBytes = await serializeSearchIndexPayload(payload, {
    gzip: true,
    gzipFn: async (bytes) => new Uint8Array(zlib.gzipSync(bytes, { level: 9 })),
  });

  fs.mkdirSync(path.dirname(OUT_DATA_IDX), { recursive: true });
  fs.writeFileSync(OUT_DATA_IDX, gzippedBytes);

  const elapsedSec = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(`[SearchIndex] Built ${payload.totalFeatures.toLocaleString()} searchable records in ${elapsedSec}s`);
  console.log(`[SearchIndex] Fingerprint: ${payload.fingerprint}`);
  console.log(`[SearchIndex] Breakdown by layer:`, layerCounts);
  console.log(
    `[SearchIndex] Size: ${(rawJsonBytes.byteLength / (1024 * 1024)).toFixed(2)} MB JSON -> ${(
      gzippedBytes.byteLength /
      (1024 * 1024)
    ).toFixed(2)} MB gzipped`
  );
  console.log(`[SearchIndex] Wrote: ${OUT_DATA_IDX}`);
} finally {
  fs.closeSync(fd);
}
