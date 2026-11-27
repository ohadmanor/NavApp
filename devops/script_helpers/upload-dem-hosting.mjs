#!/usr/bin/env node
/**
 * devops/script_helpers/upload-dem-hosting.mjs
 *
 * One-time uploader for the static, immutable Israel.dem.pmtiles archive onto the
 * dedicated Firebase Hosting site (`hosting:dem` -> https://navapp-israel-topo-dem.web.app).
 *
 * Because `hosting:dem` is completely separate from `hosting:data` (upload-map-data.bat)
 * and `hosting:app` (deploy-firebase.bat), normal OSM/POI/search/code deployments never
 * upload, download, or overwrite the 1.40 GB DEM file.
 */

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DATA_DIR,
  DEPLOY_DEM_DIR,
  REMOTE_DEM_HOSTING_ORIGIN,
  ROOT_DIR,
  formatBytes,
  isValidLocalDataFile,
} from './map-data-common.mjs';

const DEM_FILE_NAME = 'Israel.dem.pmtiles';
const DEM_SITE_ID = 'navapp-israel-topo-dem';
const PROJECT_ID = 'navapp-israel-topo';

function parseArgs(argv) {
  let force = false;
  let dryRun = false;
  let inputPath = null;

  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node devops/script_helpers/upload-dem-hosting.mjs [path/to/Israel.dem.pmtiles] [--force] [--dry-run]');
      process.exit(0);
    } else if (!inputPath) {
      inputPath = arg;
    }
  }
  return { force, dryRun, inputPath };
}

function probeDemHostingRemote() {
  const targetUrl = `${REMOTE_DEM_HOSTING_ORIGIN}/data/${DEM_FILE_NAME}`;
  return new Promise((resolve) => {
    const req = https.request(
      targetUrl,
      {
        method: 'HEAD',
        headers: {
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        },
        timeout: 10000,
      },
      (res) => {
        res.resume();
        const code = res.statusCode || 0;
        const ct = String(res.headers['content-type'] || '');
        const size = Number(res.headers['content-length'] || 0);
        if (code >= 200 && code < 300 && !ct.includes('text/html') && size > 0) {
          resolve({ url: targetUrl, size });
          return;
        }
        resolve(null);
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
    req.end();
  });
}

function runFirebaseCmd(args, allowNonZero = false) {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const res = spawnSync(npxCmd, ['firebase-tools', ...args], {
    cwd: ROOT_DIR,
    stdio: allowNonZero ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (!allowNonZero && res.status !== 0) {
    process.exit(res.status || 1);
  }
  return res;
}

async function main() {
  const { force, dryRun, inputPath } = parseArgs(process.argv.slice(2));
  const sourceFile = inputPath ? path.resolve(inputPath) : path.join(DATA_DIR, DEM_FILE_NAME);

  if (!isValidLocalDataFile(sourceFile, DEM_FILE_NAME)) {
    console.error(`[DEM Upload] Missing or invalid ${DEM_FILE_NAME}: ${sourceFile}`);
    process.exit(1);
  }

  const localSize = fs.statSync(sourceFile).size;
  console.log(`[DEM Upload] Local archive: ${sourceFile} (${formatBytes(localSize)})`);

  const remote = await probeDemHostingRemote();
  if (remote && remote.size === localSize && !force) {
    console.log(
      `[DEM Upload] ${DEM_FILE_NAME} (${formatBytes(remote.size)}) is ALREADY deployed on ${REMOTE_DEM_HOSTING_ORIGIN}.`
    );
    console.log('[DEM Upload] Static DEM never needs routine re-uploads (pass --force to re-deploy).');
    return;
  }

  fs.mkdirSync(DEPLOY_DEM_DIR, { recursive: true });
  const stagedFile = path.join(DEPLOY_DEM_DIR, DEM_FILE_NAME);
  const stagedValid =
    fs.existsSync(stagedFile) && fs.statSync(stagedFile).size === localSize && isValidLocalDataFile(stagedFile, DEM_FILE_NAME);
  if (!stagedValid) {
    console.log(`[DEM Upload] Staging ${DEM_FILE_NAME} into deploy_dem/data/...`);
    fs.copyFileSync(sourceFile, stagedFile);
  } else {
    console.log('[DEM Upload] Staged deploy_dem/data/Israel.dem.pmtiles is already up to date.');
  }

  if (dryRun) {
    console.log(`[DEM Upload] Dry run complete — skipped Firebase site creation and deploy (--only hosting:dem -> ${REMOTE_DEM_HOSTING_ORIGIN}).`);
    return;
  }

  console.log(`[DEM Upload] Ensuring Firebase Hosting site "${DEM_SITE_ID}" exists...`);
  const createRes = runFirebaseCmd(['hosting:sites:create', DEM_SITE_ID, '--project', PROJECT_ID], true);
  if (createRes.status !== 0) {
    const out = `${createRes.stdout || ''}\n${createRes.stderr || ''}`;
    if (!/already exists|ALREADY_EXISTS/i.test(out)) {
      console.warn(`[DEM Upload] hosting:sites:create note: ${out.trim()}`);
    }
  }

  runFirebaseCmd(['target:apply', 'hosting', 'dem', DEM_SITE_ID, '--project', PROJECT_ID], true);

  console.log(`[DEM Upload] Deploying ONLY hosting:dem (${REMOTE_DEM_HOSTING_ORIGIN})...`);
  runFirebaseCmd(['deploy', '--only', 'hosting:dem', '--project', PROJECT_ID], false);

  const verified = await probeDemHostingRemote();
  if (verified) {
    console.log(`[DEM Upload] Verified ${verified.url} (${formatBytes(verified.size)}).`);
  }
}

main().catch((err) => {
  console.error('[DEM Upload] Failed:', err.message || err);
  process.exit(1);
});
