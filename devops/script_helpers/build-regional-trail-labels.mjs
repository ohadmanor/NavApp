#!/usr/bin/env node
/**
 * devops/script_helpers/build-regional-trail-labels.mjs
 *
 * Israel.osm.pmtiles carries each long-distance trail's `osmc_symbol` but not its name, and several
 * trails share one symbol (e.g. five purple routes), so names cannot be derived from the tiles.
 * This script pulls the named OSM route relations, merges + simplifies their geometry, and emits
 * src/core/style/regionalTrailLabels.json — the label-placement lines used by the
 * `trail-regional-name` style layer (see src/core/style/regionalTrails.ts).
 *
 * Usage:
 *   node devops/script_helpers/build-regional-trail-labels.mjs            # fetch from Overpass
 *   node devops/script_helpers/build-regional-trail-labels.mjs --input overpass.json
 *
 * Shvil Israel (relation 282071) is intentionally not listed: it has its own always-on highlight.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(ROOT_DIR, 'src', 'core', 'style', 'regionalTrailLabels.json');

/** OSM route relation ids of every trail drawn by the `trail-regional-*` style layers. */
const ROUTE_RELATION_IDS = [
  6148296, // סובב מכתש רמון
  2860967, // מסע מים אל ים
  2193374, // שביל אזורי גליל עליון
  19769351, // שביל בית הכרם
  15787317, // שביל מגידו
  364191, // שביל ישו
  11518999, // שביל השרון
  6359565, // שביל יזרעאל
  7121629, // שביל עמק המעיינות
  5145441, // שביל סובב כנרת
  568661, // שביל הגולן
  14730532, // שביל ירושלים
  11123868, // שביל גולני
  3734116, // שביל ואדיות חיפה
];

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Label lines only need to sit near the drawn trail, so ~12 m of simplification is invisible. */
const SIMPLIFY_TOLERANCE_M = 12;
/** Chains shorter than this cannot fit a name label at any zoom the layer is shown. */
const MIN_CHAIN_LENGTH_M = 250;

async function fetchOverpass() {
  const ids = ROUTE_RELATION_IDS.join(',');
  const query = `[out:json][timeout:170];relation(id:${ids})->.top;(.top;rel(r.top)->.c1;rel(r.c1)->.c2;rel(r.c2););out geom;`;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const url of OVERPASS_ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
        });
        const text = await res.text();
        if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
        lastError = new Error(`${url} -> HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 15000 * (attempt + 1)));
  }
  throw lastError ?? new Error('Overpass request failed');
}

function collectWays(relation, relationsById, ways, seenRelations) {
  if (!relation || seenRelations.has(relation.id)) return;
  seenRelations.add(relation.id);
  for (const member of relation.members || []) {
    if (member.type === 'way' && Array.isArray(member.geometry) && member.geometry.length >= 2) {
      if (!ways.has(member.ref)) {
        ways.set(
          member.ref,
          member.geometry.map((p) => [p.lon, p.lat])
        );
      }
    } else if (member.type === 'relation') {
      collectWays(relationsById.get(member.ref), relationsById, ways, seenRelations);
    }
  }
}

const pointKey = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Joins ways end-to-end into the longest chains a greedy walk can find. */
function mergeWays(ways) {
  const segments = [...ways.values()].map((coords) => ({ coords, used: false }));
  const byEndpoint = new Map();
  const register = (key, seg) => {
    const list = byEndpoint.get(key);
    if (list) list.push(seg);
    else byEndpoint.set(key, [seg]);
  };
  for (const seg of segments) {
    register(pointKey(seg.coords[0]), seg);
    register(pointKey(seg.coords[seg.coords.length - 1]), seg);
  }
  const takeNext = (key) => (byEndpoint.get(key) || []).find((s) => !s.used) || null;

  const chains = [];
  for (const start of segments) {
    if (start.used) continue;
    start.used = true;
    let chain = start.coords.slice();
    for (;;) {
      const next = takeNext(pointKey(chain[chain.length - 1]));
      if (!next) break;
      next.used = true;
      const forward = pointKey(next.coords[0]) === pointKey(chain[chain.length - 1]);
      const add = forward ? next.coords : next.coords.slice().reverse();
      chain = chain.concat(add.slice(1));
    }
    for (;;) {
      const prev = takeNext(pointKey(chain[0]));
      if (!prev) break;
      prev.used = true;
      const forward = pointKey(prev.coords[prev.coords.length - 1]) === pointKey(chain[0]);
      const add = forward ? prev.coords : prev.coords.slice().reverse();
      chain = add.slice(0, -1).concat(chain);
    }
    chains.push(chain);
  }
  return chains;
}

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

function chainLengthM(chain) {
  let total = 0;
  for (let i = 1; i < chain.length; i++) {
    const dx = (chain[i][0] - chain[i - 1][0]) * mPerDegLon(chain[i][1]);
    const dy = (chain[i][1] - chain[i - 1][1]) * M_PER_DEG_LAT;
    total += Math.hypot(dx, dy);
  }
  return total;
}

/** Iterative Douglas-Peucker in local metres. */
function simplify(chain, toleranceM) {
  if (chain.length <= 2) return chain;
  const kx = mPerDegLon(chain[0][1]);
  const pts = chain.map((p) => [p[0] * kx, p[1] * M_PER_DEG_LAT]);
  const keep = new Uint8Array(chain.length);
  keep[0] = 1;
  keep[chain.length - 1] = 1;
  const stack = [[0, chain.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > toleranceM) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  return chain.filter((_, i) => keep[i]);
}

function roundChain(chain) {
  const out = [];
  for (const p of chain) {
    const q = [Number(p[0].toFixed(5)), Number(p[1].toFixed(5))];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}

async function main() {
  const inputIdx = process.argv.indexOf('--input');
  const data =
    inputIdx !== -1
      ? JSON.parse(fs.readFileSync(process.argv[inputIdx + 1], 'utf-8'))
      : await fetchOverpass();

  const relationsById = new Map(
    data.elements.filter((e) => e.type === 'relation').map((e) => [e.id, e])
  );

  const trails = [];
  for (const id of ROUTE_RELATION_IDS) {
    const relation = relationsById.get(id);
    if (!relation) throw new Error(`Route relation ${id} missing from Overpass response`);
    const tags = relation.tags || {};
    const ways = new Map();
    collectWays(relation, relationsById, ways, new Set());
    const lines = mergeWays(ways)
      .filter((chain) => chainLengthM(chain) >= MIN_CHAIN_LENGTH_M)
      .map((chain) => roundChain(simplify(chain, SIMPLIFY_TOLERANCE_M)))
      .filter((chain) => chain.length >= 2)
      .sort((a, b) => chainLengthM(b) - chainLengthM(a));
    const km = lines.reduce((sum, chain) => sum + chainLengthM(chain), 0) / 1000;
    trails.push({
      osmId: id,
      name: tags['name:he'] || tags.name || '',
      nameEn: tags['name:en'] || '',
      symbol: tags['osmc:symbol'] || '',
      lines,
    });
    console.log(
      `[Regional Trails] ${tags['name:he'] || tags.name} — ${ways.size} ways -> ${lines.length} lines, ` +
        `${lines.reduce((n, l) => n + l.length, 0)} points, ${km.toFixed(1)} km`
    );
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(trails), 'utf-8');
  console.log(
    `[Regional Trails] Wrote ${path.relative(ROOT_DIR, OUT_PATH)} (${(fs.statSync(OUT_PATH).size / 1024).toFixed(0)} KB)`
  );
}

main().catch((err) => {
  console.error('[Regional Trails] Failed:', err);
  process.exit(1);
});
