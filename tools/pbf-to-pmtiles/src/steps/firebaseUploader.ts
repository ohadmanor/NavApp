import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../paths.js';
import type { CountrySpec, LogLevel } from '../types.js';

type Logger = (level: LogLevel, message: string) => void;

export async function uploadToFirebaseHosting(
  country: CountrySpec,
  pmtilesPath: string,
  options: { searchIndexPath?: string; signal?: AbortSignal; log: Logger }
): Promise<string> {
  if (country.outputPrefix !== 'Israel') {
    throw new Error(
      `upload-map-data.mjs currently manages Israel.* archives on hosting:data. Built ${path.basename(pmtilesPath)} locally without overwriting Israel.osm.pmtiles.`
    );
  }

  const targetPmtiles = path.join(REPO_ROOT, 'data', 'Israel.osm.pmtiles');
  fs.mkdirSync(path.dirname(targetPmtiles), { recursive: true });
  fs.copyFileSync(pmtilesPath, targetPmtiles);

  const uploadScript = path.join(REPO_ROOT, 'devops', 'script_helpers', 'upload-map-data.mjs');
  const filesToUpload = [targetPmtiles];
  if (options.searchIndexPath && fs.existsSync(options.searchIndexPath)) {
    filesToUpload.push(options.searchIndexPath);
  }

  options.log('info', `Uploading ${filesToUpload.map((f) => path.basename(f)).join(', ')} to Firebase Hosting (hosting:data)...`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [uploadScript, ...filesToUpload], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error('Firebase upload cancelled by user.'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const forward = (chunk: Buffer, level: LogLevel) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) options.log(level, `[Firebase] ${line}`);
    };

    child.stdout.on('data', (c: Buffer) => forward(c, 'info'));
    child.stderr.on('data', (c: Buffer) => forward(c, 'warn'));
    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`upload-map-data.mjs exited with code ${code}`));
    });
  });

  const deployedUrl = 'https://navapp-israel-topo-data.web.app/data/Israel.osm.pmtiles';
  options.log('info', `Deployed successfully: ${deployedUrl}`);
  return deployedUrl;
}
