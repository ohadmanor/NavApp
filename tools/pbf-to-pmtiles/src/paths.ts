import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CountrySpec } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TOOL_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(TOOL_DIR, '..', '..');
export const CONFIG_DIR = path.join(TOOL_DIR, 'config');
export const WORKSPACE_DIR = path.join(TOOL_DIR, 'workspace');
export const PUBLIC_DIR = path.join(TOOL_DIR, 'public');
export const RUNS_PATH = path.join(WORKSPACE_DIR, 'runs.json');

export function ensureWorkspace(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

export function loadCountries(): CountrySpec[] {
  const raw = fs.readFileSync(path.join(CONFIG_DIR, 'countries.json'), 'utf8');
  const parsed = JSON.parse(raw) as { countries: CountrySpec[] };
  return parsed.countries || [];
}

export function resolveCountry(key: string, customUrl?: string, customPrefix?: string): CountrySpec {
  const countries = loadCountries();
  if (key === 'custom' && customUrl) {
    const cleanPrefix = (customPrefix || 'Custom').replace(/[^a-zA-Z0-9_-]/g, '');
    return {
      key: 'custom',
      name: `Custom (${cleanPrefix})`,
      outputPrefix: cleanPrefix || 'Custom',
      pbfUrl: customUrl,
    };
  }
  const found = countries.find((c) => c.key === key);
  if (!found) {
    throw new Error(`Unknown country key "${key}". Available: ${countries.map((c) => c.key).join(', ')}`);
  }
  return found;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
