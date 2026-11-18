import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_PATH, WORKSPACE_DIR, ensureWorkspace, resolveCountry } from './paths.js';
import { downloadFirebaseEnrichment } from './steps/firebaseEnricher.js';
import { uploadToFirebaseHosting } from './steps/firebaseUploader.js';
import { downloadCountryPbf, getPbfPaths } from './steps/pbfDownloader.js';
import { generateLuaEnrichmentLookup } from './steps/pbfTagInjector.js';
import { validatePmtilesAndBuildIndex } from './steps/pmtilesValidator.js';
import { runTilemaker } from './steps/tilemakerRunner.js';
import type {
  LogEntry,
  LogLevel,
  PipelineRunRecord,
  PipelineStepId,
  PipelineStepState,
  ResolvedEnrichmentBundle,
  RunOptions,
} from './types.js';

const STEP_DEFS: Array<{ id: PipelineStepId; label: string }> = [
  { id: 'download_pbf', label: 'Download Country PBF' },
  { id: 'download_enrichment', label: 'Download Firebase Enrichment' },
  { id: 'inject_enrichment', label: 'Inject Enrichment Tags' },
  { id: 'convert_pmtiles', label: 'Convert PBF → PMTiles (Tilemaker)' },
  { id: 'validate_pmtiles', label: 'Validate & Build Search Index' },
  { id: 'upload_firebase', label: 'Upload to Firebase Hosting' },
];

export type RunEventListener = (event: {
  type: 'state' | 'log';
  run: PipelineRunRecord;
  log?: LogEntry;
}) => void;

export function readRunHistory(): PipelineRunRecord[] {
  try {
    if (!fs.existsSync(RUNS_PATH)) return [];
    return JSON.parse(fs.readFileSync(RUNS_PATH, 'utf8')) as PipelineRunRecord[];
  } catch {
    return [];
  }
}

export function saveRunRecord(record: PipelineRunRecord): void {
  ensureWorkspace();
  const runs = readRunHistory();
  const idx = runs.findIndex((r) => r.id === record.id);
  if (idx >= 0) runs[idx] = record;
  else runs.unshift(record);
  fs.writeFileSync(RUNS_PATH, JSON.stringify(runs.slice(0, 30), null, 2), 'utf8');
}

export class PipelineRunner {
  private activeRun: PipelineRunRecord | null = null;
  private activeAbort: AbortController | null = null;
  private activeLogs: LogEntry[] = [];
  private listeners = new Map<string, Set<RunEventListener>>();

  getActiveRun(): PipelineRunRecord | null {
    return this.activeRun;
  }

  getActiveLogs(): LogEntry[] {
    return this.activeLogs;
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(run: PipelineRunRecord, type: 'state' | 'log', log?: LogEntry): void {
    const set = this.listeners.get(run.id);
    if (!set) return;
    for (const fn of set) fn({ type, run, log });
  }

  cancelActiveRun(): boolean {
    if (!this.activeAbort || !this.activeRun) return false;
    this.activeAbort.abort();
    return true;
  }

  async startRun(options: RunOptions): Promise<PipelineRunRecord> {
    if (this.activeRun && this.activeRun.status === 'running') {
      throw new Error(`Run ${this.activeRun.id} is already in progress.`);
    }

    const country = resolveCountry(options.countryKey, options.customPbfUrl, options.customOutputPrefix);
    const id = `run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const dryRun = Boolean(options.dryRun);
    const steps: PipelineStepState[] = STEP_DEFS.map((s) => ({
      id: s.id,
      label: s.label,
      status: s.id === 'upload_firebase' && dryRun ? 'skipped' : 'pending',
    }));

    const run: PipelineRunRecord = {
      id,
      createdAt: new Date().toISOString(),
      status: 'running',
      countryKey: country.key,
      outputPrefix: country.outputPrefix,
      dryRun,
      options,
      steps,
    };

    this.activeRun = run;
    this.activeLogs = [];
    this.activeAbort = new AbortController();
    saveRunRecord(run);
    this.emit(run, 'state');

    const log = (level: LogLevel, message: string, step?: PipelineStepId) => {
      const entry: LogEntry = { ts: new Date().toISOString(), level, step, message };
      this.activeLogs.push(entry);
      if (this.activeLogs.length > 1000) this.activeLogs.shift();
      this.emit(run, 'log', entry);
    };

    const runStep = async <T>(stepId: PipelineStepId, fn: () => Promise<T>): Promise<T> => {
      const step = run.steps.find((s) => s.id === stepId)!;
      step.status = 'running';
      step.startedAt = new Date().toISOString();
      saveRunRecord(run);
      this.emit(run, 'state');
      const t0 = Date.now();
      try {
        const result = await fn();
        step.status = 'completed';
        step.finishedAt = new Date().toISOString();
        step.durationMs = Date.now() - t0;
        saveRunRecord(run);
        this.emit(run, 'state');
        return result;
      } catch (err) {
        step.status = 'failed';
        step.finishedAt = new Date().toISOString();
        step.durationMs = Date.now() - t0;
        step.detail = err instanceof Error ? err.message : String(err);
        saveRunRecord(run);
        this.emit(run, 'state');
        throw err;
      }
    };

    const signal = this.activeAbort.signal;
    const fromIdx = options.fromStep ? STEP_DEFS.findIndex((s) => s.id === options.fromStep) : 0;

    try {
      let pbfPath = getPbfPaths(country).pbfPath;
      if (fromIdx <= 0) {
        const res = await runStep('download_pbf', () =>
          downloadCountryPbf(country, {
            forceDownload: options.forceDownload,
            signal,
            log: (lvl, msg) => log(lvl, msg, 'download_pbf'),
          })
        );
        pbfPath = res.pbfPath;
      } else {
        run.steps[0].status = 'skipped';
      }

      let bundle: ResolvedEnrichmentBundle | null = null;
      const enrichmentPath = path.join(WORKSPACE_DIR, `${country.key}.enrichment.json`);
      if (fromIdx <= 1) {
        const res = await runStep('download_enrichment', () =>
          downloadFirebaseEnrichment(country, {
            includeFirestore: options.includeFirestore !== false,
            signal,
            log: (lvl, msg) => log(lvl, msg, 'download_enrichment'),
          })
        );
        bundle = res.bundle;
      } else {
        run.steps[1].status = 'skipped';
        if (fs.existsSync(enrichmentPath)) {
          bundle = JSON.parse(fs.readFileSync(enrichmentPath, 'utf8')) as ResolvedEnrichmentBundle;
        }
      }

      if (fromIdx <= 2 && bundle) {
        await runStep('inject_enrichment', async () =>
          generateLuaEnrichmentLookup(bundle!, (lvl, msg) => log(lvl, msg, 'inject_enrichment'))
        );
      } else {
        run.steps[2].status = 'skipped';
      }

      let pmtilesPath = path.join(WORKSPACE_DIR, `${country.outputPrefix}.osm.pmtiles`);
      if (fromIdx <= 3) {
        pmtilesPath = await runStep('convert_pmtiles', () =>
          runTilemaker(country, pbfPath, {
            mode: options.tilemakerMode || 'auto',
            signal,
            log: (lvl, msg) => log(lvl, msg, 'convert_pmtiles'),
          })
        );
      } else {
        run.steps[3].status = 'skipped';
      }

      if (fromIdx <= 4) {
        run.validation = await runStep('validate_pmtiles', () =>
          validatePmtilesAndBuildIndex(country, pmtilesPath, {
            rebuildSearchIndex: options.rebuildSearchIndex !== false,
            signal,
            log: (lvl, msg) => log(lvl, msg, 'validate_pmtiles'),
          })
        );
      } else {
        run.steps[4].status = 'skipped';
      }

      if (!dryRun) {
        run.deployedUrl = await runStep('upload_firebase', () =>
          uploadToFirebaseHosting(country, pmtilesPath, {
            searchIndexPath: run.validation?.searchIndexPath,
            signal,
            log: (lvl, msg) => log(lvl, msg, 'upload_firebase'),
          })
        );
      }

      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      saveRunRecord(run);
      this.emit(run, 'state');
      return run;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      run.status = signal.aborted ? 'cancelled' : 'failed';
      run.error = msg;
      run.finishedAt = new Date().toISOString();
      log('error', msg);
      saveRunRecord(run);
      this.emit(run, 'state');
      return run;
    } finally {
      this.activeAbort = null;
    }
  }

  async deployCompletedRun(runId: string): Promise<PipelineRunRecord> {
    const runs = readRunHistory();
    const target = runs.find((r) => r.id === runId);
    if (!target) throw new Error(`Run ${runId} not found.`);
    if (!target.validation?.pmtilesPath || !fs.existsSync(target.validation.pmtilesPath)) {
      throw new Error(`No validated PMTiles output found for run ${runId}.`);
    }
    const country = resolveCountry(target.countryKey, target.options.customPbfUrl, target.options.customOutputPrefix);
    const uploadStep = target.steps.find((s) => s.id === 'upload_firebase')!;
    uploadStep.status = 'running';
    uploadStep.startedAt = new Date().toISOString();
    saveRunRecord(target);

    try {
      const t0 = Date.now();
      target.deployedUrl = await uploadToFirebaseHosting(country, target.validation.pmtilesPath, {
        searchIndexPath: target.validation.searchIndexPath,
        log: () => {},
      });
      uploadStep.status = 'completed';
      uploadStep.finishedAt = new Date().toISOString();
      uploadStep.durationMs = Date.now() - t0;
      target.dryRun = false;
      saveRunRecord(target);
      return target;
    } catch (err) {
      uploadStep.status = 'failed';
      uploadStep.detail = err instanceof Error ? err.message : String(err);
      saveRunRecord(target);
      throw err;
    }
  }
}
