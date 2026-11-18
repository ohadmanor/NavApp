import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, WORKSPACE_DIR, ensureWorkspace } from '../paths.js';
import type { CountrySpec, EnrichmentRecord, LogLevel, ResolvedEnrichmentBundle } from '../types.js';

type Logger = (level: LogLevel, message: string) => void;

const HOSTING_DATA_ORIGIN = 'https://navapp-israel-topo-data.web.app';

interface RawTrailJsonItem {
  id: number | string;
  name?: string;
  numbers?: string[];
  description?: string;
  lon?: number;
  lat?: number;
}

function parseColorName(hexOrName?: string): string | undefined {
  const v = String(hexOrName || '').trim().toLowerCase();
  const map: Record<string, string> = {
    '#dc2626': 'red',
    '#ea580c': 'orange',
    '#ca8a04': 'yellow',
    '#16a34a': 'green',
    '#2563eb': 'blue',
    '#7c3aed': 'purple',
    '#334155': 'black',
  };
  return map[v] || (['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'black'].includes(v) ? v : undefined);
}

function readFirebaseProjectId(): string | null {
  const envPath = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const m = /^VITE_FIREBASE_PROJECT_ID=(.+)$/m.exec(content);
    if (m?.[1]?.trim()) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  const firebaserc = path.join(REPO_ROOT, '.firebaserc');
  if (fs.existsSync(firebaserc)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(firebaserc, 'utf8')) as { projects?: Record<string, string> };
      const first = parsed.projects?.default || Object.values(parsed.projects || {})[0];
      if (first) return first;
    } catch {
      // ignore
    }
  }
  return null;
}

async function fetchHostingEnrichment(
  country: CountrySpec,
  log: Logger,
  signal?: AbortSignal
): Promise<EnrichmentRecord[]> {
  const candidates = [
    `${HOSTING_DATA_ORIGIN}/data/${country.outputPrefix}.trails.json`,
    `${HOSTING_DATA_ORIGIN}/data/${country.outputPrefix}.trails.enrichment.json`,
    `${HOSTING_DATA_ORIGIN}/data/${country.outputPrefix}Trails.json`,
  ];

  let rawItems: RawTrailJsonItem[] | null = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) {
        rawItems = (await res.json()) as RawTrailJsonItem[];
        log('info', `Downloaded Firebase Hosting enrichment from ${url} (${rawItems.length} records).`);
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!rawItems && country.outputPrefix === 'Israel') {
    const localFallback = path.join(REPO_ROOT, 'src', 'core', 'trails', 'IsraelTrails.json');
    if (fs.existsSync(localFallback)) {
      rawItems = JSON.parse(fs.readFileSync(localFallback, 'utf8')) as RawTrailJsonItem[];
      log('warn', `No remote enrichment JSON on Firebase Hosting; using local repo ${path.basename(localFallback)} (${rawItems.length} records).`);
    }
  }

  if (!rawItems) {
    log('warn', `No enrichment JSON found for ${country.outputPrefix}; continuing with empty Hosting enrichment.`);
    return [];
  }

  return rawItems.map((item) => ({
    source: 'hosting',
    id: String(item.id),
    name: String(item.name || '').trim(),
    numbers: Array.isArray(item.numbers) ? item.numbers.map(String) : [],
    wayIds: [],
    description: item.description ? String(item.description).trim() : undefined,
    lon: typeof item.lon === 'number' ? item.lon : undefined,
    lat: typeof item.lat === 'number' ? item.lat : undefined,
  }));
}

interface FirestoreField {
  stringValue?: string;
  arrayValue?: { values?: Array<{ stringValue?: string }> };
}

async function fetchFirestoreAnnotations(
  log: Logger,
  signal?: AbortSignal
): Promise<EnrichmentRecord[]> {
  const projectId = readFirebaseProjectId();
  if (!projectId) {
    log('warn', 'No Firebase project ID found in .env or .firebaserc; skipping Firestore trailAnnotations.');
    return [];
  }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/trailAnnotations?pageSize=300`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      log('warn', `Firestore trailAnnotations fetch returned HTTP ${res.status}; skipping community annotations.`);
      return [];
    }
    const body = (await res.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FirestoreField> }>;
    };
    const docs = body.documents || [];
    const records: EnrichmentRecord[] = [];
    for (const doc of docs) {
      const f = doc.fields || {};
      if (f.status?.stringValue !== 'active') continue;
      const wayIds = (f.wayIds?.arrayValue?.values || [])
        .map((v) => v.stringValue || '')
        .map((id) => id.replace(/^osm:way:/, '').trim())
        .filter(Boolean);
      const num = f.number?.stringValue?.trim();
      const colour = parseColorName(f.color?.stringValue);
      records.push({
        source: 'firestore',
        id: path.basename(doc.name),
        name: f.name?.stringValue?.trim() || '',
        numbers: num ? [num] : [],
        wayIds,
        colour,
        osmcSymbol: colour ? `${colour}:white:${colour}_stripe` : undefined,
        description: f.description?.stringValue?.trim() || undefined,
      });
    }
    log('info', `Downloaded ${records.length} active community trailAnnotations from Firestore (${projectId}).`);
    return records;
  } catch (err) {
    log('warn', `Firestore fetch failed (${err instanceof Error ? err.message : String(err)}); skipping.`);
    return [];
  }
}

export async function downloadFirebaseEnrichment(
  country: CountrySpec,
  options: { includeFirestore?: boolean; signal?: AbortSignal; log: Logger }
): Promise<{ enrichmentPath: string; bundle: ResolvedEnrichmentBundle }> {
  ensureWorkspace();
  const hosting = await fetchHostingEnrichment(country, options.log, options.signal);
  const firestore = options.includeFirestore
    ? await fetchFirestoreAnnotations(options.log, options.signal)
    : [];

  const all = [...hosting, ...firestore];
  const byWayId: Record<string, EnrichmentRecord> = {};
  const byRef: Record<string, EnrichmentRecord> = {};

  for (const rec of all) {
    for (const wayId of rec.wayIds) {
      byWayId[wayId] = rec;
    }
    for (const num of rec.numbers) {
      if (!byRef[num] || rec.source === 'firestore') {
        byRef[num] = rec;
      }
    }
  }

  const bundle: ResolvedEnrichmentBundle = {
    generatedAt: new Date().toISOString(),
    countryKey: country.key,
    totalRecords: all.length,
    hostingRecords: hosting.length,
    firestoreRecords: firestore.length,
    byWayId,
    byRef,
    records: all,
  };

  const enrichmentPath = path.join(WORKSPACE_DIR, `${country.key}.enrichment.json`);
  fs.writeFileSync(enrichmentPath, JSON.stringify(bundle, null, 2), 'utf8');
  options.log('info', `Wrote enrichment bundle (${bundle.totalRecords} records, ${Object.keys(byRef).length} refs, ${Object.keys(byWayId).length} wayIds).`);

  return { enrichmentPath, bundle };
}
