#!/usr/bin/env node
/**
 * devops/script_helpers/sync-osm-roads.mjs
 *
 * External PC CLI tool to sync pending NavApp community_roads (and their
 * trail_annotations colour if defined) to OpenStreetMap via OSM API v0.6.
 *
 * Usage:
 *   node devops/script_helpers/sync-osm-roads.mjs --dry-run --sandbox
 *   node devops/script_helpers/sync-osm-roads.mjs --id <roadId>
 *   node devops/script_helpers/sync-osm-roads.mjs --yes
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  getDocs,
  doc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  mapTrailColorToOsmName,
  xmlEscape,
  parseOsmWayFullXml,
  buildChangesetXml,
  buildOsmChangeXml,
  osmFetch,
  prepareRoadOsmContext,
  pushRoadToOsmApi,
} from '../../src/core/trails/osmSyncCore.js';

export {
  mapTrailColorToOsmName,
  xmlEscape,
  parseOsmWayFullXml,
  buildChangesetXml,
  buildOsmChangeXml,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const LOCAL_SYNC_STATE_PATH = path.join(ROOT_DIR, 'data', '.osm-synced.json');

function readLocalSyncState() {
  try {
    if (!fs.existsSync(LOCAL_SYNC_STATE_PATH)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_SYNC_STATE_PATH, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function writeLocalSyncState(roadId, entry) {
  try {
    fs.mkdirSync(path.dirname(LOCAL_SYNC_STATE_PATH), { recursive: true });
    const state = readLocalSyncState();
    state[roadId] = entry;
    fs.writeFileSync(LOCAL_SYNC_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Ignore local state write errors
  }
}

function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

async function askConfirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

async function fetchRoadsAndTrails(db) {
  const roadsSnap = await getDocs(collection(db, 'community_roads'));
  const trailsSnap = await getDocs(collection(db, 'trail_annotations'));

  const trailByWayId = new Map();
  for (const tDoc of trailsSnap.docs) {
    const data = tDoc.data();
    if (data.status !== 'active' || !Array.isArray(data.wayIds)) continue;
    for (const wayId of data.wayIds) {
      trailByWayId.set(wayId, { color: data.color, number: data.number });
    }
  }

  const localSyncState = readLocalSyncState();
  const roads = [];
  for (const rDoc of roadsSnap.docs) {
    const data = rDoc.data();
    if (data.status !== 'active') continue;
    // Removed-road tombstones are app-only: never delete or modify the way in OpenStreetMap
    if (data.removed === true) continue;
    const coordinates = (data.coordinates || []).map((pt) =>
      Array.isArray(pt) ? pt : [Number(pt.lon), Number(pt.lat)]
    );
    const effectiveOsmSync = data.osmSync || localSyncState[rDoc.id] || null;
    const synced = Boolean(
      effectiveOsmSync && Number(effectiveOsmSync.syncedRevision) >= Number(data.revision)
    );
    const wayKey =
      data.kind === 'osm-override' ? data.sourceOsmWayId : `community:road:${rDoc.id}`;
    const directTrail = data.trailColor
      ? { color: data.trailColor, number: data.trailNumber || '' }
      : null;
    roads.push({
      id: rDoc.id,
      ...data,
      osmSync: effectiveOsmSync,
      coordinates,
      synced,
      trailAnnotation: directTrail || trailByWayId.get(wayKey) || null,
    });
  }
  return { roads, trailByWayId };
}

function extractRoadSnapshot(raw) {
  return {
    kind: raw.kind === 'osm-override' ? 'osm-override' : 'new',
    ...(raw.sourceOsmWayId ? { sourceOsmWayId: raw.sourceOsmWayId } : {}),
    coordinates: raw.coordinates || [],
    bounds: raw.bounds || [],
    highwayClass: raw.highwayClass,
    tracktype: raw.tracktype || '',
    surface: raw.surface || '',
    name: raw.name || '',
    description: raw.description || '',
    oneway: raw.oneway ?? 0,
    allow4x4: Boolean(raw.allow4x4),
    allowFoot: Boolean(raw.allowFoot),
    allowBicycle: Boolean(raw.allowBicycle),
    anchors: raw.anchors || [],
    trailColor: raw.trailColor || '',
    trailNumber: raw.trailNumber || '',
    trailName: raw.trailName || '',
    status: raw.status === 'deleted' ? 'deleted' : 'active',
  };
}

async function uploadRoadToOsm({ db, auth, road, osmApiBase, osmToken, osmUsername = '' }) {
  if (!osmToken) {
    throw new Error('OSM_ACCESS_TOKEN is missing in .env (write_api scope required).');
  }
  const actorUid = road.updatedByUid || road.createdByUid || 'navapp-community';
  const { changesetId, osmWayId, osmVersion } = await pushRoadToOsmApi({
    road,
    osmApiBase,
    osmToken,
    actorUid,
    actorName: actorUid,
  });

  let recordedRevision = road.revision;
  if (auth.currentUser) {
    try {
      const roadRef = doc(db, 'community_roads', road.id);
      recordedRevision = await runTransaction(db, async (tx) => {
        const snap = await tx.get(roadRef);
        if (!snap.exists()) return road.revision;
        const prev = snap.data();
        const nextRevision = Number(prev.revision || 1) + 1;
        const historyId = `${nextRevision}-${crypto.randomUUID()}`;
        const historyRef = doc(db, 'community_roads', road.id, 'history', historyId);
        const snapshot = extractRoadSnapshot(prev);
        tx.set(historyRef, {
          revision: nextRevision,
          operation: 'osm-sync',
          actorUid: auth.currentUser.uid,
          occurredAt: serverTimestamp(),
          previous: snapshot,
          next: snapshot,
          reason: `סנכרון ל-OSM (changeset #${changesetId}, way #${osmWayId})`,
        });
        tx.update(roadRef, {
          revision: nextRevision,
          lastHistoryId: historyId,
          updatedByUid: auth.currentUser.uid,
          updatedAt: serverTimestamp(),
          osmSync: {
            changesetId,
            osmWayId,
            osmVersion,
            syncedRevision: nextRevision,
            syncedAt: serverTimestamp(),
            syncedByUid: auth.currentUser.uid,
            syncedByName:
              auth.currentUser.displayName || auth.currentUser.email || auth.currentUser.uid,
            ...(osmUsername ? { osmUsername } : {}),
          },
        });
        return nextRevision;
      });
    } catch {
      // Local sync state is still recorded below
    }
  }

  writeLocalSyncState(road.id, {
    changesetId,
    osmWayId,
    osmVersion,
    syncedRevision: recordedRevision,
    syncedAt: new Date().toISOString(),
    syncedByUid: auth.currentUser?.uid || actorUid,
    syncedByName:
      auth.currentUser?.displayName || auth.currentUser?.email || actorUid,
    ...(osmUsername ? { osmUsername } : {}),
  });

  return { changesetId, osmWayId, osmVersion };
}

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function upsertDotEnvKey(key, value) {
  const envPath = path.join(ROOT_DIR, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.trimEnd() + (content.trim() ? '\n' : '') + line + '\n';
  }
  fs.writeFileSync(envPath, content, 'utf8');
  process.env[key] = value;
}

function renderSyncUiHtml(defaultSandbox, initialAuthState) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>NavApp — סנכרון דרכים ל-OpenStreetMap</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:24px}
    .wrap{max-width:980px;margin:0 auto}
    h1{font-size:20px;margin:0 0 6px}
    .muted{color:#94a3b8;font-size:13px}
    .toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:12px 16px;margin:16px 0}
    .authBox{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:12px 16px;margin:12px 0;font-size:13px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
    input[type=password],input[type=text]{background:#0f172a;color:#f8fafc;border:1px solid #475569;border-radius:8px;padding:6px 10px;font-size:13px;min-width:260px}
    button,a.btn{cursor:pointer;border:1px solid #475569;background:#334155;color:#f8fafc;border-radius:8px;padding:7px 12px;font-size:13px;font-weight:600;text-decoration:none;display:inline-block}
    button.primary,a.btn.primary{background:#059669;border-color:#10b981}
    button.osm{background:#2563eb;border-color:#3b82f6}
    button:disabled{opacity:.45;cursor:not-allowed}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:12px 14px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;background:#334155}
    .badge.new{background:#065f46;color:#a7f3d0}
    .badge.mod{background:#92400e;color:#fde68a}
    .badge.synced{background:#1e3a8a;color:#bfdbfe}
    .swatch{display:inline-block;width:11px;height:11px;border-radius:999px;vertical-align:middle;margin-left:4px;border:1px solid #fff}
    pre{background:#020617;border:1px solid #334155;border-radius:8px;padding:10px;font-size:11px;overflow:auto;direction:ltr;text-align:left;max-height:260px}
    .status{margin-top:6px;font-size:12px}
    .ok{color:#34d399}.err{color:#fb7185}
    code{background:#0f172a;padding:2px 6px;border-radius:4px;direction:ltr;display:inline-block}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>NavApp — כלי סנכרון דרכים ל-OpenStreetMap</h1>
    <div class="muted">התחבר עם משתמש ה-OpenStreetMap שלך, בחר מהרשימה אילו דרכים לסנכרן, ובדוק את ה-OsmChange XML לפני השליחה.</div>

    <div class="authBox" id="authBox">
      <div id="authStatusText">
        ${
          initialAuthState.loggedIn
            ? `<span class="ok">מחובר ל-OSM${initialAuthState.osmUser ? `: <strong>${initialAuthState.osmUser}</strong>` : ''}</span>`
            : `<span style="color:#fbbf24">לא מחובר ל-OpenStreetMap</span>`
        }
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span id="clientIdSetup" style="display:${!initialAuthState.loggedIn && !initialAuthState.hasClientId ? 'flex' : 'none'};gap:8px;align-items:center;flex-wrap:wrap">
          <span class="muted">הגדרה חד-פעמית — רשום OAuth2 App ב-OSM עם Redirect URI: <code>${initialAuthState.redirectUri}</code> (ללא Confidential):</span>
          <a class="btn" href="https://www.openstreetmap.org/oauth2/applications/new" target="_blank">צור App ב-OSM</a>
          <input type="text" id="clientIdInput" placeholder="הדבק Client ID כאן..." dir="ltr"/>
          <button id="saveClientIdBtn">שמור Client ID</button>
        </span>
        <button id="osmLoginBtn" class="osm" style="display:${!initialAuthState.loggedIn && initialAuthState.hasClientId ? 'inline-block' : 'none'}">התחבר עם משתמש OSM</button>
        <button id="osmLogoutBtn" style="display:${initialAuthState.loggedIn ? 'inline-block' : 'none'}">התנתק מ-OSM</button>
      </div>
    </div>

    <div class="toolbar">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="selectAllBtn">בחר הכל</button>
        <button id="deselectAllBtn">בטל בחירה</button>
        <button id="refreshBtn">רענן רשימה</button>
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="showSyncedChk"/>
          הצג גם דרכים שכבר סונכרנו
        </label>
        <label style="font-size:13px;display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="sandboxChk" ${defaultSandbox ? 'checked' : ''}/>
          מצב Sandbox (master.apis.dev.openstreetmap.org)
        </label>
      </div>
      <button id="syncBtn" class="primary">סנכרן נבחרים ל-OSM (<span id="selCount">0</span>)</button>
    </div>
    <div id="list">טוען...</div>
  </div>
  <script>
    let roads = [];
    const selected = new Set();
    const results = new Map();
    const previews = new Map();

    async function load() {
      const res = await fetch('/api/roads');
      const data = await res.json();
      roads = data.roads || [];
      selected.clear();
      for (const r of roads) {
        if (!r.synced) selected.add(r.id);
      }
      render();
    }

    function updateCount() {
      document.getElementById('selCount').textContent = String(selected.size);
      document.getElementById('syncBtn').disabled = selected.size === 0;
    }

    async function previewXml(id) {
      const sandbox = document.getElementById('sandboxChk').checked;
      previews.set(id, 'טוען OsmChange XML...');
      render();
      const res = await fetch('/api/preview?id=' + encodeURIComponent(id) + '&sandbox=' + (sandbox ? '1' : '0'));
      const data = await res.json();
      previews.set(id, data.error ? ('ERROR: ' + data.error) : data.xml);
      render();
    }

    function render() {
      const el = document.getElementById('list');
      const showSynced = document.getElementById('showSyncedChk').checked;
      const visibleRoads = showSynced ? roads : roads.filter((r) => !r.synced);
      if (visibleRoads.length === 0) {
        el.innerHTML = '<div class="card">אין דרכים ממתינות לסנכרון.</div>';
        updateCount();
        return;
      }
      el.innerHTML = visibleRoads.map((r) => {
        const checked = selected.has(r.id) ? 'checked' : '';
        const disabled = '';
        const kindBadge = r.kind === 'osm-override'
          ? '<span class="badge mod">עריכת OSM ' + (r.sourceOsmWayId || '') + '</span>'
          : '<span class="badge new">דרך חדשה</span>';
        const syncBadge = r.synced
          ? '<span class="badge synced">סונכרן #' + (r.osmSync?.changesetId || '') + '</span>'
          : '';
        const trailHtml = r.trailAnnotation
          ? ' · <span class="swatch" style="background:' + r.trailAnnotation.color + '"></span>שביל ' + (r.trailAnnotation.number || '')
          : '';
        const res = results.get(r.id);
        const resHtml = res
          ? '<div class="status ' + (res.ok ? 'ok' : 'err') + '">' + res.message + '</div>'
          : '';
        const xmlHtml = previews.has(r.id)
          ? '<pre>' + previews.get(r.id).replace(/</g, '&lt;') + '</pre>'
          : '';
        return '<div class="card">' +
          '<input type="checkbox" data-id="' + r.id + '" ' + checked + ' ' + disabled + ' style="margin-top:4px"/>' +
          '<div style="flex:1">' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
              kindBadge + syncBadge +
              '<strong>' + (r.name || '(ללא שם)') + '</strong>' +
              '<span class="muted">highway=' + r.highwayClass + ' · ' + r.coordinates.length + ' נק׳' + trailHtml + '</span>' +
            '</div>' +
            '<div class="muted" style="margin-top:4px">משתמש NavApp: ' + (r.updatedByUid || r.createdByUid || 'קהילה') + ' · גרסה ' + r.revision + '</div>' +
            resHtml +
            '<div style="margin-top:8px"><button data-preview="' + r.id + '">תצוגה מקדימה XML</button></div>' +
            xmlHtml +
          '</div>' +
        '</div>';
      }).join('');

      el.querySelectorAll('input[type=checkbox][data-id]').forEach((cb) => {
        cb.addEventListener('change', (e) => {
          const id = e.target.getAttribute('data-id');
          if (e.target.checked) selected.add(id);
          else selected.delete(id);
          updateCount();
        });
      });
      el.querySelectorAll('button[data-preview]').forEach((btn) => {
        btn.addEventListener('click', () => previewXml(btn.getAttribute('data-preview')));
      });
      updateCount();
    }

    document.getElementById('selectAllBtn').onclick = () => {
      for (const r of roads) selected.add(r.id);
      render();
    };
    document.getElementById('deselectAllBtn').onclick = () => {
      selected.clear();
      render();
    };
    document.getElementById('refreshBtn').onclick = () => load();
    document.getElementById('showSyncedChk').onchange = () => render();
    document.getElementById('saveClientIdBtn').onclick = async () => {
      const clientId = document.getElementById('clientIdInput').value.trim();
      if (!clientId) return;
      const res = await fetch('/api/save-client-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      if (res.ok) {
        document.getElementById('clientIdSetup').style.display = 'none';
        document.getElementById('osmLoginBtn').style.display = 'inline-block';
      }
    };
    document.getElementById('osmLoginBtn').onclick = () => {
      const sandbox = document.getElementById('sandboxChk').checked;
      window.location.href = '/osm-login?sandbox=' + (sandbox ? '1' : '0');
    };
    document.getElementById('osmLogoutBtn').onclick = async () => {
      await fetch('/api/osm-logout', { method: 'POST' });
      window.location.reload();
    };
    document.getElementById('syncBtn').onclick = async () => {
      const ids = Array.from(selected);
      if (ids.length === 0) return;
      const sandbox = document.getElementById('sandboxChk').checked;
      document.getElementById('syncBtn').disabled = true;
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, sandbox }),
      });
      const data = await res.json();
      for (const item of (data.results || [])) {
        results.set(item.id, item);
      }
      await load();
    };
    load();
  </script>
</body>
</html>`;
}

function openBrowserUrl(url) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function startSelectionUi({ db, auth, defaultSandbox, osmToken: initialOsmToken }) {
  let activeOsmToken = initialOsmToken;
  let activeOsmUser = '';
  let pendingPkce = null;
  const port = Number(process.env.OSM_SYNC_UI_PORT || 4199);
  const redirectUri = `http://127.0.0.1:${port}/osm-callback`;

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && reqUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          renderSyncUiHtml(defaultSandbox, {
            loggedIn: Boolean(activeOsmToken),
            osmUser: activeOsmUser,
            hasClientId: Boolean(process.env.OSM_CLIENT_ID),
            redirectUri,
          })
        );
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/save-client-id') {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const cid = typeof body.clientId === 'string' ? body.clientId.trim() : '';
        if (!cid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing clientId' }));
          return;
        }
        upsertDotEnvKey('OSM_CLIENT_ID', cid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/osm-login') {
        const clientId = process.env.OSM_CLIENT_ID || '';
        if (!clientId) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('OSM_CLIENT_ID is not configured.');
          return;
        }
        const sandbox = reqUrl.searchParams.get('sandbox') === '1';
        const osmWebBase = sandbox
          ? 'https://master.apis.dev.openstreetmap.org'
          : 'https://www.openstreetmap.org';
        const codeVerifier = base64Url(crypto.randomBytes(32));
        const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
        const state = base64Url(crypto.randomBytes(16));
        pendingPkce = { codeVerifier, state, sandbox, osmWebBase, clientId };

        const authUrl = new URL(`${osmWebBase}/oauth2/authorize`);
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', 'write_api');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        res.writeHead(302, { Location: authUrl.toString() });
        res.end();
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/osm-callback') {
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        if (!code || !pendingPkce || state !== pendingPkce.state) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Invalid OAuth callback state or missing authorization code.');
          return;
        }
        const { codeVerifier, osmWebBase, clientId, sandbox } = pendingPkce;
        pendingPkce = null;

        const tokenRes = await fetch(`${osmWebBase}/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: codeVerifier,
          }),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok || !tokenJson.access_token) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`OSM OAuth token exchange failed: ${JSON.stringify(tokenJson)}`);
          return;
        }
        activeOsmToken = tokenJson.access_token;
        try {
          const apiBase = sandbox
            ? 'https://master.apis.dev.openstreetmap.org'
            : 'https://api.openstreetmap.org';
          const userXml = await osmFetch(`${apiBase}/api/0.6/user/details`, {}, activeOsmToken);
          const m = /display_name="([^"]+)"/.exec(userXml);
          activeOsmUser = m ? m[1] : '';
        } catch {
          activeOsmUser = '';
        }
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/osm-logout') {
        activeOsmToken = '';
        activeOsmUser = '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/api/roads') {
        const { roads } = await fetchRoadsAndTrails(db);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ roads }));
        return;
      }
      if (req.method === 'GET' && reqUrl.pathname === '/api/preview') {
        const id = reqUrl.searchParams.get('id');
        const sandbox = reqUrl.searchParams.get('sandbox') === '1';
        const osmApiBase = sandbox
          ? 'https://master.apis.dev.openstreetmap.org'
          : process.env.OSM_API_BASE || 'https://api.openstreetmap.org';
        const { roads } = await fetchRoadsAndTrails(db);
        const road = roads.find((r) => r.id === id);
        if (!road) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Road not found' }));
          return;
        }
        const existingTargetWays = await prepareRoadOsmContext(road, osmApiBase);
        const xml = buildOsmChangeXml({
          changesetId: 0,
          road,
          trailAnnotation: road.trailAnnotation || null,
          existingTargetWays,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ xml }));
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/sync') {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const osmApiBase = body.sandbox
          ? 'https://master.apis.dev.openstreetmap.org'
          : process.env.OSM_API_BASE || 'https://api.openstreetmap.org';
        const { roads } = await fetchRoadsAndTrails(db);
        const out = [];
        for (const id of ids) {
          const road = roads.find((r) => r.id === id);
          if (!road) {
            out.push({ id, ok: false, message: 'לא נמצא ב-Firestore' });
            continue;
          }
          try {
            const uploaded = await uploadRoadToOsm({
              db,
              auth,
              road,
              osmApiBase,
              osmToken: activeOsmToken,
              osmUsername: activeOsmUser,
            });
            out.push({
              id,
              ok: true,
              message: `סונכרן בהצלחה: changeset #${uploaded.changesetId} (way #${uploaded.osmWayId} v${uploaded.osmVersion})`,
            });
          } catch (err) {
            out.push({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ results: out }));
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`[OSM-Sync] Selection UI running at ${url} (Ctrl+C to stop)`);
    openBrowserUrl(url);
  });
}

async function main() {
  loadDotEnv();
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sandbox = args.includes('--sandbox');
  const autoYes = args.includes('--yes');
  const idIdx = args.indexOf('--id');
  const filterId = idIdx >= 0 ? args[idIdx + 1] : null;
  const uiMode = args.includes('--ui') || (!dryRun && !autoYes && !filterId);

  const osmApiBase = sandbox
    ? 'https://master.apis.dev.openstreetmap.org'
    : process.env.OSM_API_BASE || 'https://api.openstreetmap.org';
  const osmToken = process.env.OSM_ACCESS_TOKEN || '';

  if (!dryRun && !uiMode && !osmToken) {
    throw new Error('OSM_ACCESS_TOKEN is required in .env (with write_api scope) unless running with --dry-run or --ui.');
  }

  const firebaseConfig = {
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
    appId: process.env.VITE_FIREBASE_APP_ID,
  };
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    throw new Error('Missing VITE_FIREBASE_API_KEY / VITE_FIREBASE_PROJECT_ID in .env.');
  }

  const app = initializeApp(firebaseConfig);
  const db = getFirestore(app);
  const auth = getAuth(app);

  if (!dryRun && process.env.FIREBASE_SYNC_EMAIL && process.env.FIREBASE_SYNC_PASSWORD) {
    await signInWithEmailAndPassword(
      auth,
      process.env.FIREBASE_SYNC_EMAIL,
      process.env.FIREBASE_SYNC_PASSWORD
    );
  }

  if (uiMode) {
    await startSelectionUi({ db, auth, defaultSandbox: sandbox, osmToken });
    return;
  }

  const { roads } = await fetchRoadsAndTrails(db);
  const pendingRoads = roads.filter((r) => {
    if (filterId && r.id !== filterId) return false;
    if (r.synced) return false;
    return true;
  });

  console.log(`[OSM-Sync] Found ${pendingRoads.length} pending community road(s) (${osmApiBase}).`);
  if (pendingRoads.length === 0) return;

  for (const road of pendingRoads) {
    const existingTargetWays = await prepareRoadOsmContext(road, osmApiBase);
    const previewXml = buildOsmChangeXml({
      changesetId: 0,
      road,
      trailAnnotation: road.trailAnnotation || null,
      existingTargetWays,
    });
    console.log(`\n--- Road ${road.id} (${road.kind}, highway=${road.highwayClass}) ---`);
    console.log(previewXml);

    if (dryRun) continue;
    if (!autoYes) {
      const ok = await askConfirm(`Upload road ${road.id} to ${osmApiBase}? (y/N) `);
      if (!ok) continue;
    }

    const uploaded = await uploadRoadToOsm({ db, auth, road, osmApiBase, osmToken });
    console.log(
      `[OSM-Sync] Uploaded changeset #${uploaded.changesetId} (way #${uploaded.osmWayId} v${uploaded.osmVersion}).`
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[OSM-Sync] Error:', err.message || err);
    process.exit(1);
  });
}
