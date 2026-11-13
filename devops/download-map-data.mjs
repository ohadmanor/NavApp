#!/usr/bin/env node
/**
 * devops/download-map-data.mjs
 *
 * Downloads/syncs the authoritative map data files from Firebase Hosting
 * (https://navapp-israel-topo-data.web.app/data/) into local data/:
 *   - Israel.dem.pmtiles
 *   - Israel.osm.pmtiles
 *   - Israel.pois.geojson
 *   - Israel.offroad.pois.geojson
 *   - Israel.search.idx
 *
 * Flags:
 *   --only <list>   Comma-separated keys or filenames (dem,osm,pois,offroad,search)
 *   --skip-dem      Skip the 1.40 GB Israel.dem.pmtiles archive
 *   --force         Re-download even when size and ETag already match
 *   --dest <dir>    Target directory (default: data/)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DATA_DIR,
  MAP_DATA_FILES,
  downloadRemoteDataFile,
  findDataFileSpec,
  formatBytes,
  isValidLocalDataFile,
  probeRemoteDataFile,
  readSyncMeta,
  writeSyncMeta,
} from './map-data-common.mjs';

function parseArgs(argv) {
  let only = null;
  let skipDem = false;
  let force = false;
  let destDir = DATA_DIR;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--skip-dem') {
      skipDem = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--only' && argv[i + 1]) {
      only = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--dest' && argv[i + 1]) {
      destDir = path.resolve(argv[++i]);
    } else if (arg === '-h' || arg === '--help') {
      console.log(`Usage: node devops/download-map-data.mjs [--only dem,osm,pois,offroad,search] [--skip-dem] [--force]`);
      process.exit(0);
    }
  }
  return { only, skipDem, force, destDir };
}

async function main() {
  const { only, skipDem, force, destDir } = parseArgs(process.argv.slice(2));
  let targets = MAP_DATA_FILES;

  if (only && only.length > 0) {
    const resolved = [];
    for (const token of only) {
      const spec = findDataFileSpec(token);
      if (!spec) {
        console.error(`[Download] Unknown data file/key: "${token}"`);
        process.exit(1);
      }
      if (!resolved.includes(spec)) resolved.push(spec);
    }
    targets = resolved;
  } else if (skipDem) {
    targets = MAP_DATA_FILES.filter((f) => f.key !== 'dem');
  }

  fs.mkdirSync(destDir, { recursive: true });
  const meta = readSyncMeta();
  let downloadedCount = 0;
  let skippedCount = 0;
  let missingRemoteCount = 0;

  console.log(`[Download] Checking ${targets.length} data files against Firebase Hosting...`);
  for (const spec of targets) {
    const localPath = path.join(destDir, spec.fileName);
    const remote = await probeRemoteDataFile(spec.fileName);
    if (!remote) {
      console.warn(`  [MISS] ${spec.fileName} is not available on Firebase Hosting (404/offline).`);
      missingRemoteCount++;
      continue;
    }

    const validLocal = isValidLocalDataFile(localPath, spec.fileName);
    const localSize = validLocal ? fs.statSync(localPath).size : 0;
    const prevMeta = meta[spec.fileName];
    const sizeMatches = localSize === remote.size;
    const etagMatches = !remote.etag || !prevMeta?.etag || prevMeta.etag === remote.etag;

    if (!force && validLocal && sizeMatches && etagMatches) {
      console.log(`  [OK]   ${spec.fileName} (${formatBytes(localSize)}) — already up to date.`);
      meta[spec.fileName] = { size: localSize, etag: remote.etag, syncedAt: prevMeta?.syncedAt || new Date().toISOString() };
      skippedCount++;
      continue;
    }

    console.log(
      `  [SYNC] ${spec.fileName} (${formatBytes(remote.size)})${validLocal ? ` [local ${formatBytes(localSize)} differs]` : ' [not present locally]'}`
    );
    const result = await downloadRemoteDataFile(spec.fileName, localPath, remote);
    meta[spec.fileName] = {
      size: result.size,
      etag: result.etag,
      syncedAt: new Date().toISOString(),
    };
    downloadedCount++;
  }

  if (destDir === DATA_DIR) {
    writeSyncMeta(meta);
  }

  console.log(
    `[Download] Complete: ${downloadedCount} downloaded, ${skippedCount} up to date, ${missingRemoteCount} unavailable remotely.`
  );
  if (missingRemoteCount > 0 && downloadedCount === 0 && skippedCount === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Download] Failed:', err.message || err);
  process.exit(1);
});
