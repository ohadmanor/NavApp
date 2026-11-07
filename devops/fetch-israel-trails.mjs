#!/usr/bin/env node
/**
 * devops/fetch-israel-trails.mjs
 *
 * Harvests official Israeli marked hiking & 4x4 trails (סימון שבילים: Red, Blue, Black, Green,
 * Purple, Orange, and שביל ישראל Israel National Trail) from OpenStreetMap API v0.6
 * into data/Israel.trails.geojson and public/data/Israel.trails.geojson for 100% offline rendering.
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

dns.setDefaultResultOrder('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_OUT = path.resolve(__dirname, '..', 'data', 'Israel.trails.geojson');
const PUBLIC_OUT = path.resolve(__dirname, '..', 'public', 'data', 'Israel.trails.geojson');

// Major national trail relation IDs fetched in full across all of Israel:
// 282071 = שביל ישראל (Israel National Trail)
// 1311342 = שביל הגולן (Golan Trail)
// 3790672 = שביל ירושלים (Jerusalem Trail)
const FULL_RELATIONS = [282071, 1311342, 3790672];

// Outdoor navigation regions across Israel
const BBOXES = [
  { name: 'Makhtesh Gadol / Nahal Hatira / HaSnapir / Ein Yorkeam / Mamshit', bbox: '34.93,30.89,35.10,31.04' },
  { name: 'Makhtesh Katan / Maale Akrabim / Nahal Peres / Tamar', bbox: '35.10,30.89,35.32,31.04' },
  { name: 'Sde Boker / Ein Aqev / Hod Aqev / Nahal Zin (West)', bbox: '34.73,30.78,34.83,30.89' },
  { name: 'Ein Aqev / Hod Aqev / Maale Ziq / Nahal Zin (East)', bbox: '34.82,30.78,34.95,30.89' },
  { name: 'Nahal Havarim / Avdat / Ein Avdat / Nafha', bbox: '34.72,30.69,34.88,30.79' },
  { name: 'Makhtesh Ramon West (Har Ramon / Loz Cisterns)', bbox: '34.60,30.50,34.80,30.65' },
  { name: 'Makhtesh Ramon Central & East (Shen Ramon / Ardon / Nekarot)', bbox: '34.80,30.55,35.02,30.70' },
  { name: 'Eilat Mountains / Red Canyon / Timna', bbox: '34.86,29.53,35.01,29.80' },
  { name: 'Dead Sea South / Mount Sodom / Nahal Pratzim / Ashalim', bbox: '35.28,31.05,35.42,31.22' },
  { name: 'Masada / Nahal Tzeelim / Nahal Mishmar', bbox: '35.24,31.22,35.41,31.36' },
  { name: 'Ein Gedi / Nahal David / Nahal Arugot / Nahal Dragot', bbox: '35.32,31.36,35.44,31.62' },
  { name: 'Judean Desert North / Nahal Og / Wadi Qelt', bbox: '35.32,31.74,35.48,31.87' },
  { name: 'Jerusalem Mountains / Sataf / Nahal Sorek / Nes Harim', bbox: '35.01,31.71,35.17,31.81' },
  { name: 'Mount Carmel / Little Switzerland / Nahal Oren', bbox: '34.96,32.67,35.07,32.78' },
  { name: 'Mount Gilboa / Beit Shean', bbox: '35.36,32.46,35.47,32.55' },
  { name: 'Mount Arbel / Nahal Amud / Sea of Galilee', bbox: '35.44,32.79,35.55,32.91' },
  { name: 'Mount Meron / Nahal Kziv / Upper Galilee', bbox: '35.25,32.95,35.46,33.06' },
  { name: 'Golan Heights Central (Gamla / Yehudiya / Zavitan)', bbox: '35.62,32.86,35.76,33.04' },
  { name: 'Golan Heights North (Banias / Nimrod / Hermon)', bbox: '35.64,33.20,35.79,33.31' },
];

function extractColorFromOsmc(osmc = '', rawColour = '', nameHe = '') {
  const s = String(osmc || '').toLowerCase();
  if (
    s.includes('orange:orange:white_right:blue_stripe') ||
    s.includes('blue_stripe') && s.includes('orange') ||
    nameHe.includes('שביל ישראל')
  ) {
    return 'int'; // Israel National Trail
  }
  const c = String(rawColour || '').toLowerCase().trim();
  if (['red', 'blue', 'green', 'black', 'purple', 'orange', 'yellow'].includes(c)) {
    return c;
  }
  if (s.startsWith('red:') || s.includes('red_stripe')) return 'red';
  if (s.startsWith('blue:') || s.includes('blue_stripe')) return 'blue';
  if (s.startsWith('green:') || s.includes('green_stripe')) return 'green';
  if (s.startsWith('black:') || s.includes('black_stripe')) return 'black';
  if (s.startsWith('purple:') || s.includes('purple_stripe')) return 'purple';
  if (s.startsWith('orange:') || s.includes('orange_stripe')) return 'orange';
  return '';
}

const waysById = new Map();
const wayColors = new Map(); // wayId -> { colours: string[], isInt: boolean, nameHe: string, network: string, osmc: string }

function ingestElements(elements) {
  const nodes = new Map();
  for (const el of elements || []) {
    if (el.type === 'node') {
      nodes.set(el.id, [Number(el.lon.toFixed(6)), Number(el.lat.toFixed(6))]);
    }
  }

  for (const el of elements || []) {
    if (el.type === 'way') {
      if (!waysById.has(el.id)) {
        const coords = (el.nodes || []).map((nid) => nodes.get(nid)).filter(Boolean);
        if (coords.length >= 2) {
          waysById.set(el.id, {
            id: el.id,
            tags: el.tags || {},
            coords,
          });
        }
      }
    }
  }

  for (const el of elements || []) {
    if (el.type !== 'relation') continue;
    const tags = el.tags || {};
    if (tags.type !== 'route' && tags.type !== 'superroute') continue;

    const nameHe = tags['name:he'] || tags.name || '';
    const color = extractColorFromOsmc(tags['osmc:symbol'], tags.colour, nameHe);
    if (!color) continue;

    const network = tags.network || 'lwn';
    const osmc = tags['osmc:symbol'] || '';

    for (const member of el.members || []) {
      if (member.type !== 'way') continue;
      let info = wayColors.get(member.ref);
      if (!info) {
        info = {
          colours: [],
          isInt: false,
          nameHe: '',
          network: 'lwn',
          osmc: '',
        };
        wayColors.set(member.ref, info);
      }
      if (color === 'int') {
        info.isInt = true;
        info.network = 'nwn';
      } else if (!info.colours.includes(color)) {
        info.colours.push(color);
      }
      // Prefer local trail name (e.g. "הסנפיר הקטן") over generic "שביל ישראל" for trail text labels
      if (nameHe && nameHe !== 'שביל ישראל' && (!info.nameHe || info.nameHe === 'שביל ישראל')) {
        info.nameHe = nameHe;
      } else if (nameHe && !info.nameHe) {
        info.nameHe = nameHe;
      }
      if (osmc && !info.osmc) info.osmc = osmc;
      if (network === 'rwn' && info.network !== 'nwn') info.network = 'rwn';
    }
  }
}

for (const relId of FULL_RELATIONS) {
  const url = `https://api.openstreetmap.org/api/0.6/relation/${relId}/full.json`;
  console.log(`[fetch-israel-trails] Fetching full national trail relation ${relId}...`);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NavApp-Israel-Topographic-Offline/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data = await res.json();
      ingestElements(data.elements);
    }
  } catch (err) {
    console.warn(`  -> Failed relation ${relId}:`, err.message);
  }
}

for (const region of BBOXES) {
  const url = `https://api.openstreetmap.org/api/0.6/map.json?bbox=${region.bbox}`;
  console.log(`[fetch-israel-trails] Fetching ${region.name} (${region.bbox})...`);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'NavApp-Israel-Topographic-Offline/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      console.warn(`  -> HTTP ${res.status} for ${region.name}`);
      continue;
    }
    const data = await res.json();
    ingestElements(data.elements);
  } catch (err) {
    console.warn(`  -> Failed ${region.name}:`, err.message);
  }
}

const features = [];
for (const [wayId, info] of wayColors.entries()) {
  const way = waysById.get(wayId);
  if (!way || way.coords.length < 2) continue;

  const hw = way.tags.highway || 'path';
  const isTrack = hw === 'track';
  const isRoad = [
    'motorway',
    'trunk',
    'primary',
    'secondary',
    'tertiary',
    'unclassified',
    'residential',
    'service',
  ].includes(hw);
  const kind = isRoad ? 'road' : isTrack ? 'track' : 'path';

  const colour1 = info.colours[0] || '';
  const colour2 = info.colours[1] || colour1;

  features.push({
    type: 'Feature',
    properties: {
      id: wayId,
      kind,
      highway: hw,
      tracktype: way.tags.tracktype || '',
      colour: colour1,
      colour2: colour2,
      isInt: info.isInt ? 1 : 0,
      network: info.network,
      nameHe: info.nameHe || way.tags['name:he'] || way.tags.name || '',
    },
    geometry: {
      type: 'LineString',
      coordinates: way.coords,
    },
  });
}

const geojson = {
  type: 'FeatureCollection',
  features,
};

fs.mkdirSync(path.dirname(DATA_OUT), { recursive: true });
fs.mkdirSync(path.dirname(PUBLIC_OUT), { recursive: true });
fs.writeFileSync(DATA_OUT, JSON.stringify(geojson), 'utf8');
fs.writeFileSync(PUBLIC_OUT, JSON.stringify(geojson), 'utf8');

console.log(`[fetch-israel-trails] Saved ${features.length} marked trail segments to ${DATA_OUT}`);
