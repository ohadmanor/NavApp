#!/usr/bin/env node
/**
 * devops/upload-map-data.mjs
 *
 * Uploads NavApp map & POI datasets to the dedicated Firebase Hosting data site
 * (target `hosting:data` -> https://navapp-israel-topo-data.web.app):
 *   - Israel.dem.pmtiles
 *   - Israel.osm.pmtiles
 *   - Israel.pois.geojson
 *   - Israel.offroad.pois.geojson
 *   - Israel.search.idx
 *
 * Features:
 *  - Accepts dragged-and-dropped / CLI file paths for ANY of the 5 data files.
 *  - Copies files from data/ into deploy_data/data/ (and rebuilds Israel.search.idx
 *    when Israel.osm.pmtiles is present and the index is missing or stale).
 *  - Safely preserves remote files: Firebase Hosting replaces the entire site on
 *    deploy, so any of the 5 files missing locally from deploy_data/data/ that still
 *    exists on Firebase Hosting is downloaded into data/ + deploy_data/data/ first
 *    (unless --allow-delete is explicitly passed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DATA_DIR,
  DEPLOY_DATA_DIR,
  MAP_DATA_FILES,
  ROOT_DIR,
  downloadRemoteDataFile,
  findDataFileSpec,
  formatBytes,
  isValidLocalDataFile,
  probeRemoteDataFile,
  readSyncMeta,
  writeSyncMeta,
} from './map-data-common.mjs';

function parseArgs(argv) {
  let allowDelete = false;
  let dryRun = false;
  const inputPaths = [];

  for (const arg of argv) {
    if (arg === '--allow-delete') {
      allowDelete = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node devops/upload-map-data.mjs [file1 file2 ...] [--allow-delete] [--dry-run]'
      );
      process.exit(0);
    } else {
      inputPaths.push(arg);
    }
  }
  return { allowDelete, dryRun, inputPaths };
}

function copyIfNewerOrMissing(src, dst) {
  if (!fs.existsSync(src)) return false;
  const srcStat = fs.statSync(src);
  if (fs.existsSync(dst)) {
    const dstStat = fs.statSync(dst);
    if (dstStat.size === srcStat.size && Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1000) {
      return false;
    }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

async function main() {
  const { allowDelete, dryRun, inputPaths } = parseArgs(process.argv.slice(2));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DEPLOY_DATA_DIR, { recursive: true });

  // 1. Handle explicit file arguments (e.g. drag-and-drop onto upload-map-data.bat)
  for (const rawPath of inputPaths) {
    const resolved = path.resolve(rawPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      console.error(`[Upload] File not found: ${rawPath}`);
      process.exit(1);
    }
    const baseName = path.basename(resolved);
    const spec = findDataFileSpec(baseName);
    if (!spec) {
      console.error(
        `[Upload] Unrecognized data filename "${baseName}". Expected one of: ${MAP_DATA_FILES.map((f) => f.fileName).join(', ')}`
      );
      process.exit(1);
    }
    if (!isValidLocalDataFile(resolved, spec.fileName)) {
      console.error(`[Upload] File failed integrity check: ${resolved}`);
      process.exit(1);
    }
    const dataTarget = path.join(DATA_DIR, spec.fileName);
    const deployTarget = path.join(DEPLOY_DATA_DIR, spec.fileName);
    if (path.resolve(dataTarget) !== resolved) {
      fs.copyFileSync(resolved, dataTarget);
    }
    fs.copyFileSync(resolved, deployTarget);
    console.log(`  [INPUT] Staged ${spec.fileName} (${formatBytes(fs.statSync(deployTarget).size)})`);
  }

  // 2. Sync all valid local files from data/ -> deploy_data/data/
  console.log('[1/4] Checking local data/ and deploy_data/data/...');
  for (const spec of MAP_DATA_FILES) {
    const dataFile = path.join(DATA_DIR, spec.fileName);
    const deployFile = path.join(DEPLOY_DATA_DIR, spec.fileName);

    if (isValidLocalDataFile(dataFile, spec.fileName)) {
      const copied = copyIfNewerOrMissing(dataFile, deployFile);
      const size = fs.statSync(deployFile).size;
      console.log(`  [${copied ? 'COPIED' : 'READY'}]  ${spec.fileName} (${formatBytes(size)})`);
    } else if (isValidLocalDataFile(deployFile, spec.fileName)) {
      const size = fs.statSync(deployFile).size;
      console.log(`  [STAGED] ${spec.fileName} (${formatBytes(size)}) in deploy_data/`);
    } else {
      console.log(`  [ABSENT] ${spec.fileName} not present locally.`);
    }
  }

  // 3. Rebuild Israel.search.idx if Israel.osm.pmtiles is staged and index is missing/stale
  const stagedOsm = path.join(DEPLOY_DATA_DIR, 'Israel.osm.pmtiles');
  const dataIdx = path.join(DATA_DIR, 'Israel.search.idx');
  const deployIdx = path.join(DEPLOY_DATA_DIR, 'Israel.search.idx');
  if (isValidLocalDataFile(stagedOsm, 'Israel.osm.pmtiles')) {
    const osmMtime = fs.statSync(stagedOsm).mtimeMs;
    const idxStale =
      !isValidLocalDataFile(dataIdx, 'Israel.search.idx') ||
      fs.statSync(dataIdx).mtimeMs < osmMtime;
    if (idxStale) {
      console.log('[2/4] Rebuilding Israel.search.idx from staged Israel.osm.pmtiles...');
      const buildRes = spawnSync(
        process.execPath,
        [path.join(ROOT_DIR, 'devops', 'build-pmtiles-search-index.mjs'), '--if-present', '--input', stagedOsm],
        { cwd: ROOT_DIR, stdio: 'inherit' }
      );
      if (buildRes.status !== 0) {
        process.exit(buildRes.status || 1);
      }
      copyIfNewerOrMissing(dataIdx, deployIdx);
    } else {
      console.log('[2/4] Israel.search.idx is already up to date with Israel.osm.pmtiles.');
    }
  } else {
    console.log('[2/4] Skipping search index rebuild (Israel.osm.pmtiles not staged locally).');
  }

  // 4. Preserve existing remote Firebase files missing locally so deploy doesn't delete them
  console.log('[3/4] Checking Firebase Hosting (hosting:data) to preserve remote files...');
  for (const spec of MAP_DATA_FILES) {
    const deployFile = path.join(DEPLOY_DATA_DIR, spec.fileName);
    if (isValidLocalDataFile(deployFile, spec.fileName)) continue;

    const remote = await probeRemoteDataFile(spec.fileName);
    if (!remote) continue;

    if (allowDelete) {
      console.warn(`  [WARN] ${spec.fileName} exists on Firebase (${formatBytes(remote.size)}) and will be DELETED (--allow-delete).`);
      continue;
    }

    if (dryRun) {
      console.log(
        `  [PRESERVE (dry-run)] ${spec.fileName} (${formatBytes(remote.size)}) exists on Firebase and would be downloaded before deploy to prevent deletion.`
      );
      continue;
    }

    console.log(
      `  [PRESERVE] ${spec.fileName} (${formatBytes(remote.size)}) exists on Firebase but is missing locally — downloading so it isn't deleted on deploy...`
    );
    const dataFile = path.join(DATA_DIR, spec.fileName);
    await downloadRemoteDataFile(spec.fileName, dataFile, remote);
    fs.copyFileSync(dataFile, deployFile);
  }

  const stagedFiles = MAP_DATA_FILES.filter((spec) =>
    isValidLocalDataFile(path.join(DEPLOY_DATA_DIR, spec.fileName), spec.fileName)
  );
  if (stagedFiles.length === 0) {
    console.error('[Upload] No valid map/POI/search files found to upload.');
    process.exit(1);
  }

  console.log('[4/4] Uploading staged files to Firebase Hosting (hosting:data):');
  for (const spec of stagedFiles) {
    const size = fs.statSync(path.join(DEPLOY_DATA_DIR, spec.fileName)).size;
    console.log(`  - ${spec.fileName} (${formatBytes(size)})`);
  }

  if (dryRun) {
    console.log('[Upload] Dry run complete — skipped firebase deploy.');
    return;
  }

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const deployRes = spawnSync(
    npxCmd,
    ['firebase-tools', 'deploy', '--only', 'hosting:data'],
    { cwd: ROOT_DIR, stdio: 'inherit', shell: process.platform === 'win32' }
  );
  if (deployRes.status !== 0) {
    process.exit(deployRes.status || 1);
  }

  // Refresh local sync metadata from deployed remote headers
  const meta = readSyncMeta();
  for (const spec of stagedFiles) {
    const remote = await probeRemoteDataFile(spec.fileName);
    const localSize = fs.statSync(path.join(DEPLOY_DATA_DIR, spec.fileName)).size;
    meta[spec.fileName] = {
      size: remote?.size || localSize,
      etag: remote?.etag,
      syncedAt: new Date().toISOString(),
    };
  }
  writeSyncMeta(meta);
}

main().catch((err) => {
  console.error('[Upload] Failed:', err.message || err);
  process.exit(1);
});
