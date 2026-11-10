#!/usr/bin/env node
/**
 * devops/fetch-user-icons.mjs
 *
 * Downloads a curated set of outdoor navigation, 4x4, hiking, MTB, and tactical
 * SVG icons from the Iconify open-source web icon API into public/assets/user-icons/
 * so they are available both online and 100% offline in the backcountry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'assets', 'user-icons');

fs.mkdirSync(OUT_DIR, { recursive: true });

const WEB_ICON_CATALOG = [
  { id: 'car-4wd', source: 'tabler:car-4wd', labelHe: 'ג׳יפ 4x4', category: 'vehicles', rotateWithHeading: false },
  { id: 'car-suv', source: 'tabler:car-suv', labelHe: 'רכב שטח SUV', category: 'vehicles', rotateWithHeading: false },
  { id: 'truck', source: 'tabler:truck', labelHe: 'טנדר שטח', category: 'vehicles', rotateWithHeading: false },
  { id: 'motorbike', source: 'tabler:motorbike', labelHe: 'אופנוע שטח', category: 'vehicles', rotateWithHeading: false },
  { id: 'atv', source: 'mdi:atv', labelHe: 'טרקטורון / RZR', category: 'vehicles', rotateWithHeading: false },
  { id: 'bike', source: 'tabler:bike', labelHe: 'אופני הרים MTB', category: 'outdoor', rotateWithHeading: false },
  { id: 'walk', source: 'tabler:walk', labelHe: 'מטייל', category: 'outdoor', rotateWithHeading: false },
  { id: 'trekking', source: 'tabler:trekking', labelHe: 'תרמילאי', category: 'outdoor', rotateWithHeading: false },
  { id: 'run', source: 'tabler:run', labelHe: 'ריצת שטח', category: 'outdoor', rotateWithHeading: false },
  { id: 'navigation-arrow', source: 'tabler:navigation', labelHe: 'חץ ניווט', category: 'tactical', rotateWithHeading: true },
  { id: 'compass', source: 'tabler:compass', labelHe: 'מצפן', category: 'tactical', rotateWithHeading: false },
  { id: 'dog', source: 'tabler:dog', labelHe: 'כלב / גשש', category: 'outdoor', rotateWithHeading: false },
  { id: 'horse', source: 'mdi:horse-variant', labelHe: 'סוס', category: 'outdoor', rotateWithHeading: false },
  { id: 'drone', source: 'tabler:drone', labelHe: 'רחפן', category: 'tactical', rotateWithHeading: false },
  { id: 'tent', source: 'tabler:tent', labelHe: 'מחנה / חניון', category: 'outdoor', rotateWithHeading: false },
];

async function fetchSvgFromIconify(source) {
  const [prefix, name] = source.split(':');
  const url = `https://api.iconify.design/${encodeURIComponent(prefix)}/${encodeURIComponent(name)}.svg?width=32&height=32`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const svg = await res.text();
  if (!svg.includes('<svg')) {
    throw new Error(`Invalid SVG payload for ${source}`);
  }
  return svg;
}

async function main() {
  const manifest = [];
  for (const item of WEB_ICON_CATALOG) {
    const svg = await fetchSvgFromIconify(item.source);
    const fileName = `${item.id}.svg`;
    fs.writeFileSync(path.join(OUT_DIR, fileName), svg, 'utf-8');
    manifest.push({
      ...item,
      url: `/assets/user-icons/${fileName}`,
    });
    console.log(`✓ Downloaded ${item.source} -> public/assets/user-icons/${fileName}`);
  }
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), icons: manifest }, null, 2),
    'utf-8'
  );
  console.log(`\nSaved ${manifest.length} web icons to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('Failed to fetch user icons:', err);
  process.exit(1);
});
