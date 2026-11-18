import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, TOOL_DIR, WORKSPACE_DIR, formatBytes } from '../paths.js';
import type { CountrySpec, LogLevel } from '../types.js';

type Logger = (level: LogLevel, message: string) => void;

export function findNativeTilemakerBinary(): string | null {
  const envPath = process.env.TILEMAKER_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;

  const localBin = path.join(TOOL_DIR, 'bin', process.platform === 'win32' ? 'tilemaker.exe' : 'tilemaker');
  if (fs.existsSync(localBin)) return localBin;

  if (spawnSync('tilemaker', ['--help'], { stdio: 'ignore' }).status === 0) {
    return 'tilemaker';
  }
  return null;
}

export function toWslPath(winPath: string): string {
  const normalized = path.resolve(winPath).replace(/\\/g, '/');
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export function detectTilemakerAvailability(): { native: boolean; nativePath: string | null; wsl: boolean } {
  const nativePath = findNativeTilemakerBinary();
  const wsl =
    process.platform === 'win32' &&
    spawnSync('wsl', ['tilemaker', '--help'], { stdio: 'ignore' }).status === 0;
  return { native: Boolean(nativePath), nativePath, wsl };
}

export async function runTilemaker(
  country: CountrySpec,
  pbfPath: string,
  options: { mode?: 'auto' | 'native' | 'wsl'; signal?: AbortSignal; log: Logger }
): Promise<string> {
  const outputFileName = `${country.outputPrefix}.osm.pmtiles`;
  const outputPath = path.join(WORKSPACE_DIR, outputFileName);
  const tmpOutputPath = `${outputPath}.tmp.pmtiles`;
  if (fs.existsSync(tmpOutputPath)) fs.unlinkSync(tmpOutputPath);

  const avail = detectTilemakerAvailability();
  let engine: 'native' | 'wsl';
  if (options.mode === 'native') {
    if (!avail.native) {
      throw new Error(
        `Native tilemaker.exe not found on PATH or in ${path.join(TOOL_DIR, 'bin')}. Place tilemaker.exe there, set TILEMAKER_PATH, or use WSL.`
      );
    }
    engine = 'native';
  } else if (options.mode === 'wsl') {
    if (!avail.wsl) {
      throw new Error(
        'WSL tilemaker not available (ensure WSL Ubuntu is healthy and run: sudo apt update && sudo apt install -y tilemaker).'
      );
    }
    engine = 'wsl';
  } else {
    if (avail.native) engine = 'native';
    else if (avail.wsl) engine = 'wsl';
    else {
      throw new Error(
        `No Tilemaker binary found. Either:\n1) Place Windows tilemaker.exe in ${path.join(TOOL_DIR, 'bin', 'tilemaker.exe')} (or on PATH), OR\n2) Install Tilemaker in WSL: wsl --install -d Ubuntu && wsl sudo apt update && wsl sudo apt install -y tilemaker`
      );
    }
  }

  const cmd = engine === 'wsl' ? 'wsl' : (avail.nativePath || 'tilemaker');
  const args =
    engine === 'wsl'
      ? [
          'tilemaker',
          '--input',
          toWslPath(pbfPath),
          '--output',
          toWslPath(tmpOutputPath),
          '--config',
          toWslPath(path.join(CONFIG_DIR, 'tilemaker-config.json')),
          '--process',
          toWslPath(path.join(CONFIG_DIR, 'tilemaker-process.lua')),
        ]
      : [
          '--input',
          pbfPath,
          '--output',
          tmpOutputPath,
          '--config',
          path.join(CONFIG_DIR, 'tilemaker-config.json'),
          '--process',
          path.join(CONFIG_DIR, 'tilemaker-process.lua'),
        ];

  options.log('info', `Starting Tilemaker (${engine.toUpperCase()}) -> ${outputFileName}...`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: WORKSPACE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

    const onAbort = () => {
      child.kill('SIGTERM');
      reject(new Error('Tilemaker cancelled by user.'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const forwardLines = (chunk: Buffer, level: LogLevel) => {
      const lines = chunk.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) options.log(level, `[Tilemaker] ${line}`);
    };

    child.stdout.on('data', (c: Buffer) => forwardLines(c, 'info'));
    child.stderr.on('data', (c: Buffer) => forwardLines(c, 'info'));

    child.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`Tilemaker exited with code ${code}`));
    });
  });

  if (!fs.existsSync(tmpOutputPath)) {
    throw new Error(`Tilemaker completed but output file was not created: ${tmpOutputPath}`);
  }
  fs.renameSync(tmpOutputPath, outputPath);
  options.log('info', `PMTiles generated: ${outputFileName} (${formatBytes(fs.statSync(outputPath).size)}).`);
  return outputPath;
}
