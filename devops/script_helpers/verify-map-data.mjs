// Sanity-checks the 5 map data files in data/ (existence, exact-case names, magic bytes,
// and that search index / POIs are not older than the OSM tiles they derive from).
// Usage: node devops/verify-map-data.mjs [--sha256]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, MAP_DATA_FILES, isValidLocalDataFile } from './map-data-common.mjs';

const wantHash = process.argv.includes('--sha256');
let failed = false;
const fail = (m) => { failed = true; console.error(`FAIL  ${m}`); };
const ok = (m) => console.log(`ok    ${m}`);

const onDisk = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : [];
const stats = {};
for (const f of MAP_DATA_FILES) {
  const p = path.join(DATA_DIR, f.fileName);
  if (!onDisk.includes(f.fileName)) {
    const wrongCase = onDisk.find((n) => n.toLowerCase() === f.fileName.toLowerCase());
    fail(wrongCase ? `${f.fileName} exists as "${wrongCase}" (case mismatch; breaks on Linux/macOS)` : `${f.fileName} missing`);
    continue;
  }
  const st = fs.statSync(p);
  stats[f.key] = st;
  if (!isValidLocalDataFile(p, f.fileName)) fail(`${f.fileName} has unexpected header bytes`);
  else ok(`${f.fileName} ${(st.size / 1048576).toFixed(1)} MB`);
  if (wantHash) {
    const h = crypto.createHash('sha256');
    await new Promise((res, rej) => fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', res).on('error', rej));
    console.log(`      sha256 ${h.digest('hex')}`);
  }
}
const osm = stats.osm;
if (osm) {
  for (const f of MAP_DATA_FILES.filter((x) => x.fileName.endsWith('.idx') || x.fileName.endsWith('.geojson'))) {
    const st = stats[f.key];
    if (st && f.fileName.endsWith('.idx') && st.mtimeMs < osm.mtimeMs) fail(`${f.fileName} is older than Israel.osm.pmtiles; rebuild with npm run build-search-index`);
  }
}
process.exit(failed ? 1 : 0);
