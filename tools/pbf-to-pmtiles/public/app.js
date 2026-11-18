const el = (id) => document.getElementById(id);

let configCache = null;
let currentRun = null;
let allLogs = [];
let eventSource = null;

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function updateCacheDisplay() {
  const key = el('countrySelect').value;
  el('customFields').classList.toggle('hidden', key !== 'custom');
  if (!configCache) return;
  const c = configCache.countries.find((x) => x.key === key);
  if (!c) {
    el('cacheStatus').textContent = 'Custom PBF URL will be downloaded fresh.';
    return;
  }
  el('cacheStatus').textContent = c.cache?.exists
    ? `Cached locally: ${c.cache.sizeLabel} (downloaded ${new Date(c.cache.downloadedAt).toLocaleString()})`
    : 'Not cached locally yet — will download from Geofabrik.';
}

async function loadConfig() {
  const res = await fetch('/api/config');
  configCache = await res.json();
  const sel = el('countrySelect');
  sel.innerHTML = '';
  for (const c of configCache.countries) {
    const opt = document.createElement('option');
    opt.value = c.key;
    opt.textContent = `${c.name} (${c.outputPrefix})`;
    sel.appendChild(opt);
  }
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom .osm.pbf URL...';
  sel.appendChild(customOpt);
  updateCacheDisplay();

  const tm = configCache.tilemaker;
  el('tilemakerPill').textContent = tm.native
    ? 'Tilemaker: Native'
    : tm.wsl
      ? 'Tilemaker: WSL'
      : 'Tilemaker: Not Found';
}

function renderRun(run) {
  currentRun = run;
  if (!run) return;
  el('activeRunId').textContent = run.id;
  const pill = el('runStatusPill');
  pill.textContent = run.status.toUpperCase();
  pill.className = `pill ${run.status}`;

  const isRunning = run.status === 'running';
  el('startBtn').disabled = isRunning;
  el('cancelBtn').disabled = !isRunning;

  const stepper = el('stepper');
  stepper.innerHTML = '';
  for (const step of run.steps) {
    const div = document.createElement('div');
    div.className = `step-item ${step.status}`;
    const dur = step.durationMs ? `${(step.durationMs / 1000).toFixed(1)}s` : '';
    div.innerHTML = `
      <div class="step-title">${step.label}</div>
      <div class="step-meta">${step.status.toUpperCase()} ${dur}${step.detail ? ` — ${step.detail}` : ''}</div>
    `;
    stepper.appendChild(div);
  }

  const vCard = el('validationCard');
  if (run.validation) {
    vCard.classList.remove('hidden');
    el('validationGrid').innerHTML = `
      <div><strong>File:</strong> ${formatBytes(run.validation.fileSizeBytes)}</div>
      <div><strong>Zooms:</strong> z${run.validation.minZoom}–z${run.validation.maxZoom}</div>
      <div><strong>Tiles:</strong> ${run.validation.numAddressedTiles.toLocaleString()}</div>
      <div><strong>Layers:</strong> ${run.validation.layersFound.length}</div>
    `;
    const canDeploy = run.status === 'completed' && !run.deployedUrl && run.outputPrefix === 'Israel';
    el('deployBtn').classList.toggle('hidden', !canDeploy);
  } else {
    vCard.classList.add('hidden');
  }
}

function renderLogs() {
  const filter = el('logLevelFilter').value;
  const lines = allLogs
    .filter((l) => filter === 'all' || l.level === filter)
    .map((l) => `[${l.ts.slice(11, 19)}] [${l.level.toUpperCase()}] ${l.step ? `(${l.step}) ` : ''}${l.message}`);
  const box = el('logConsole');
  box.textContent = lines.length ? lines.join('\n') : 'No logs matching filter.';
  box.scrollTop = box.scrollHeight;
}

function subscribeToRun(runId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/api/runs/${runId}/events`);
  eventSource.onmessage = (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'state' && data.run) {
      renderRun(data.run);
      if (data.run.status !== 'running') loadRuns();
    } else if (data.type === 'log' && data.log) {
      allLogs.push(data.log);
      renderLogs();
    }
  };
}

async function loadRuns() {
  const res = await fetch('/api/runs');
  const data = await res.json();
  if (data.activeRun) {
    allLogs = data.activeLogs || [];
    renderRun(data.activeRun);
    renderLogs();
    if (data.activeRun.status === 'running') subscribeToRun(data.activeRun.id);
  }
  const tbody = el('historyBody');
  if (!data.history?.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">No runs recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = data.history
    .map(
      (r) => `<tr>
        <td>${new Date(r.createdAt).toLocaleString()}</td>
        <td>${r.outputPrefix}</td>
        <td>${r.dryRun ? 'Dry-Run' : 'Full Deploy'}</td>
        <td>${r.status}</td>
        <td>${r.validation ? formatBytes(r.validation.fileSizeBytes) : '—'}</td>
        <td>${r.validation ? `z${r.validation.minZoom}–z${r.validation.maxZoom}` : '—'}</td>
        <td>${r.deployedUrl ? `<a href="${r.deployedUrl}" target="_blank">Hosted</a>` : '—'}</td>
      </tr>`
    )
    .join('');
}

el('countrySelect').addEventListener('change', updateCacheDisplay);
el('logLevelFilter').addEventListener('change', renderLogs);

el('copyLogsBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(el('logConsole').textContent || '');
});

el('startBtn').addEventListener('click', async () => {
  allLogs = [];
  renderLogs();
  const body = {
    countryKey: el('countrySelect').value,
    customPbfUrl: el('customPbfUrl').value.trim() || undefined,
    customOutputPrefix: el('customOutputPrefix').value.trim() || undefined,
    forceDownload: el('forceDownload').checked,
    includeFirestore: el('includeFirestore').checked,
    tilemakerMode: el('tilemakerMode').value,
    rebuildSearchIndex: el('rebuildSearchIndex').checked,
    dryRun: el('dryRun').checked,
  };
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to start run');
    return;
  }
  renderRun(data.run);
  subscribeToRun(data.run.id);
});

el('cancelBtn').addEventListener('click', async () => {
  if (!currentRun) return;
  await fetch(`/api/runs/${currentRun.id}/cancel`, { method: 'POST' });
});

el('deployBtn').addEventListener('click', async () => {
  if (!currentRun) return;
  el('deployBtn').disabled = true;
  el('deployBtn').textContent = 'Deploying...';
  const res = await fetch(`/api/runs/${currentRun.id}/deploy`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Deploy failed');
    el('deployBtn').disabled = false;
    el('deployBtn').textContent = '☁ Deploy to Firebase Now';
    return;
  }
  renderRun(data.run);
  loadRuns();
});

loadConfig().then(loadRuns);
