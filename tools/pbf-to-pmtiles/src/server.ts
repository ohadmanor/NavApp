import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { PUBLIC_DIR, formatBytes, loadCountries } from './paths.js';
import { PipelineRunner, readRunHistory } from './pipeline.js';
import { getPbfPaths, readPbfCacheMeta } from './steps/pbfDownloader.js';
import { detectTilemakerAvailability } from './steps/tilemakerRunner.js';
import type { RunOptions } from './types.js';

const PORT = Number(process.env.PORT || 4322);
const app = express();
const runner = new PipelineRunner();

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/config', (_req, res) => {
  const countries = loadCountries().map((c) => {
    const { pbfPath, metaPath } = getPbfPaths(c);
    const cached = fs.existsSync(pbfPath);
    const meta = readPbfCacheMeta(metaPath);
    return {
      ...c,
      cache: cached
        ? {
            exists: true,
            sizeBytes: fs.statSync(pbfPath).size,
            sizeLabel: formatBytes(fs.statSync(pbfPath).size),
            downloadedAt: meta?.downloadedAt,
            etag: meta?.etag,
          }
        : { exists: false },
    };
  });
  const tilemaker = detectTilemakerAvailability();
  res.json({ countries, tilemaker });
});

app.get('/api/runs', (_req, res) => {
  res.json({
    activeRun: runner.getActiveRun(),
    activeLogs: runner.getActiveLogs(),
    history: readRunHistory(),
  });
});

app.post('/api/runs', (req, res) => {
  const options = req.body as RunOptions;
  if (!options?.countryKey) {
    res.status(400).json({ error: 'countryKey is required' });
    return;
  }
  try {
    const runPromise = runner.startRun(options);
    const active = runner.getActiveRun();
    runPromise.catch(() => {});
    res.status(202).json({ run: active });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/runs/:id/cancel', (req, res) => {
  const active = runner.getActiveRun();
  if (!active || active.id !== req.params.id) {
    res.status(404).json({ error: 'Active run not found' });
    return;
  }
  const cancelled = runner.cancelActiveRun();
  res.json({ cancelled });
});

app.post('/api/runs/:id/deploy', async (req, res) => {
  try {
    const updated = await runner.deployCompletedRun(req.params.id);
    res.json({ run: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/runs/:id/events', (req, res) => {
  const runId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const active = runner.getActiveRun();
  if (active && active.id === runId) {
    send({ type: 'state', run: active });
    for (const log of runner.getActiveLogs()) {
      send({ type: 'log', run: active, log });
    }
  }

  const unsubscribe = runner.subscribe(runId, (ev) => {
    send(ev);
  });

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[PBF-to-PMTiles] Local service running at http://127.0.0.1:${PORT}`);
});
