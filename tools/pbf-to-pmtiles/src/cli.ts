import { PipelineRunner } from './pipeline.js';
import type { PipelineStepId, RunOptions } from './types.js';

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    countryKey: 'israel-and-palestine',
    includeFirestore: true,
    rebuildSearchIndex: true,
    tilemakerMode: 'auto',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--country' && argv[i + 1]) opts.countryKey = argv[++i];
    else if (arg === '--url' && argv[i + 1]) opts.customPbfUrl = argv[++i];
    else if (arg === '--prefix' && argv[i + 1]) opts.customOutputPrefix = argv[++i];
    else if (arg === '--force') opts.forceDownload = true;
    else if (arg === '--no-firestore') opts.includeFirestore = false;
    else if (arg === '--no-search-index') opts.rebuildSearchIndex = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--tilemaker' && argv[i + 1]) {
      opts.tilemakerMode = argv[++i] as 'auto' | 'native' | 'wsl';
    } else if (arg === '--from-step' && argv[i + 1]) {
      opts.fromStep = argv[++i] as PipelineStepId;
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: npm run cli -- [--country israel-and-palestine] [--dry-run] [--force] [--no-firestore] [--tilemaker auto|native|wsl] [--from-step download_pbf|download_enrichment|inject_enrichment|convert_pmtiles|validate_pmtiles|upload_firebase]'
      );
      process.exit(0);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const runner = new PipelineRunner();
  const runPromise = runner.startRun(opts);
  const active = runner.getActiveRun();
  if (active) {
    runner.subscribe(active.id, (ev) => {
      if (ev.type === 'log' && ev.log) {
        const tag = ev.log.step ? `[${ev.log.step}]` : '';
        console.log(`${ev.log.ts} ${ev.log.level.toUpperCase()} ${tag} ${ev.log.message}`);
      }
    });
  }
  const result = await runPromise;
  if (result.status !== 'completed') {
    console.error(`Pipeline ${result.status}: ${result.error || 'Unknown error'}`);
    process.exit(1);
  }
  console.log(`Pipeline completed. Output: ${result.validation?.pmtilesPath || 'N/A'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
