#!/usr/bin/env node
/**
 * devops/poi-sync.mjs
 *
 * Firebase Hosting is the source of truth for data/Israel.pois.geojson.
 *   node devops/poi-sync.mjs pull   # always download the remote file into data/
 *   node devops/poi-sync.mjs push   # validate + upload data/Israel.pois.geojson
 *
 * Scripts that edit the POI file should use withPoiFile(): it pulls first, runs the
 * edit, and pushes automatically only if the file changed. Push refuses when the remote
 * file changed since the last pull (stale local copy), unless force is passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  DATA_DIR,
  ROOT_DIR,
  downloadRemoteDataFile,
  probeRemoteDataFile,
  readSyncMeta,
  writeSyncMeta,
} from './map-data-common.mjs';

export const POI_FILE = 'Israel.pois.geojson';
export const POI_PATH = path.join(DATA_DIR, POI_FILE);

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

export async function pullPois() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const remote = await probeRemoteDataFile(POI_FILE);
  if (!remote) throw new Error(`${POI_FILE} not found on Firebase Hosting; cannot pull.`);
  const res = await downloadRemoteDataFile(POI_FILE, POI_PATH, remote);
  const meta = readSyncMeta();
  meta[POI_FILE] = { size: res.size, etag: res.etag, syncedAt: new Date().toISOString() };
  writeSyncMeta(meta);
  console.log(`[POI] Pulled ${POI_FILE} (${res.size} bytes) from Firebase.`);
}

function validatePois() {
  const fc = JSON.parse(fs.readFileSync(POI_PATH, 'utf8'));
  if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features) || fc.features.length === 0) {
    throw new Error('POI file is not a non-empty GeoJSON FeatureCollection.');
  }
  const ids = new Set();
  for (const f of fc.features) {
    const id = f?.properties?.id ?? f?.id;
    if (!id || ids.has(id)) throw new Error(`Missing or duplicate POI id: ${id}`);
    ids.add(id);
    const c = f.geometry?.coordinates;
    if (f.geometry?.type !== 'Point' || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      throw new Error(`POI ${id} has invalid geometry.`);
    }
  }
  return fc.features.length;
}

export async function pushPois({ force = false } = {}) {
  const count = validatePois();
  const meta = readSyncMeta()[POI_FILE];
  const remote = await probeRemoteDataFile(POI_FILE);
  if (!force && remote && meta?.etag && remote.etag && remote.etag !== meta.etag) {
    throw new Error('Remote POI file changed since your last pull. Run "pull" and redo the edit (or pass --force).');
  }
  console.log(`[POI] Uploading ${count} POIs to Firebase...`);
  const res = spawnSync(process.execPath, [path.join(ROOT_DIR, 'devops', 'upload-map-data.mjs'), POI_PATH], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  if (res.status !== 0) throw new Error('POI upload failed.');
}

/** Pull -> edit -> push (only if the content changed). */
export async function withPoiFile(editFn, { dryRun = false } = {}) {
  await pullPois();
  const before = sha(POI_PATH);
  await editFn(POI_PATH);
  if (sha(POI_PATH) === before) {
    console.log('[POI] No changes; nothing to upload.');
    return;
  }
  if (dryRun) {
    console.log('[POI] Dry run: skipping upload.');
    return;
  }
  await pushPois();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cmd = process.argv[2];
  const run = cmd === 'pull' ? pullPois() : cmd === 'push' ? pushPois({ force: process.argv.includes('--force') }) : null;
  if (!run) {
    console.log('Usage: node devops/poi-sync.mjs <pull|push> [--force]');
    process.exit(1);
  }
  run.catch((e) => {
    console.error('[POI]', e.message || e);
    process.exit(1);
  });
}
