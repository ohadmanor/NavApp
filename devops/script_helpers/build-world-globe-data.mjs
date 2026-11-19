#!/usr/bin/env node
/**
 * devops/script_helpers/build-world-globe-data.mjs
 *
 * Generates the compact, 100% offline world globe vector PMTiles asset at:
 *   src/public/assets/world-globe/world-basemap.pmtiles
 *
 * Combines public-domain Natural Earth vector datasets sliced cleanly into z0-z6 MVT tiles:
 *  - Global ocean polygons (10m precision in the Levant coast, simplified globally)
 *  - Global coastlines & international country borders
 *  - Hebrew + English continent, ocean/sea, and country label points
 *  - 15°/30° cartographic graticule lines for 3D globe orientation
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { Compression, PMTiles, TileType, zxyToTileId } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT_DIR, 'src', 'public', 'assets', 'world-globe');
const OUT_PATH = path.join(OUT_DIR, 'world-basemap.pmtiles');
const LEGACY_GEOJSON_PATH = path.join(OUT_DIR, 'world-basemap.geojson');
const WORLD_MAX_ZOOM = 6;
const TILE_EXTENT = 4096;
const TILE_BUFFER = 64;
const SOURCE_LAYER = 'world';

const NE_BASE_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

function inLevant(lon, lat) {
  return lon >= 29.0 && lon <= 38.0 && lat >= 27.0 && lat <= 36.5;
}

function sqDistToSeg(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplifyAdaptive(pts, sqTolGlobal, sqTolLevant, closed) {
  if (pts.length <= (closed ? 4 : 2)) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    let maxSqDist = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = sqDistToSeg(pts[i], pts[first], pts[last]);
      const tol = inLevant(pts[i][0], pts[i][1]) ? sqTolLevant : sqTolGlobal;
      if (sq > tol && sq > maxSqDist) {
        index = i;
        maxSqDist = sq;
      }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i] || inLevant(pts[i][0], pts[i][1])) {
      const decimals = inLevant(pts[i][0], pts[i][1]) ? 4 : 2;
      const factor = Math.pow(10, decimals);
      const lon = Math.round(pts[i][0] * factor) / factor;
      const lat = Math.round(pts[i][1] * factor) / factor;
      const prev = out[out.length - 1];
      if (!prev || prev[0] !== lon || prev[1] !== lat) {
        out.push([lon, lat]);
      }
    }
  }

  if (closed) {
    if (out.length < 3) return null;
    const first = out[0];
    const last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      out.push([first[0], first[1]]);
    }
    if (out.length < 4) return null;
  } else if (out.length < 2) {
    return null;
  }
  return out;
}

function ringBBoxArea(ring) {
  let minX = 180;
  let maxX = -180;
  let minY = 90;
  let maxY = -90;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return (maxX - minX) * (maxY - minY);
}

async function fetchJson(fileName) {
  const res = await fetch(`${NE_BASE_URL}${fileName}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${fileName}: HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  console.log('[World Globe] Fetching Natural Earth datasets...');
  const [ocean10, coast50, borders50, countries110] = await Promise.all([
    fetchJson('ne_10m_ocean.geojson'),
    fetchJson('ne_50m_coastline.geojson'),
    fetchJson('ne_50m_admin_0_boundary_lines_land.geojson'),
    fetchJson('ne_110m_admin_0_countries.geojson'),
  ]);

  const features = [];

  // 1. Global Oceans (10m precision in Levant, simplified globally)
  const sqTolOceanGlobal = 0.11 * 0.11;
  const sqTolLevant = 0.0005 * 0.0005;
  const minIslandArea = 0.12;
  const oceanPolys = [];

  for (const f of ocean10.features) {
    const polys =
      f.geometry?.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry?.coordinates || [];
    for (const poly of polys) {
      const outer = simplifyAdaptive(poly[0], sqTolOceanGlobal, sqTolLevant, true);
      if (!outer) continue;
      const rings = [outer];
      for (let r = 1; r < poly.length; r++) {
        if (ringBBoxArea(poly[r]) < minIslandArea && !poly[r].some(([x, y]) => inLevant(x, y))) {
          continue;
        }
        const hole = simplifyAdaptive(poly[r], sqTolOceanGlobal, sqTolLevant, true);
        if (hole) rings.push(hole);
      }
      oceanPolys.push(rings);
    }
  }
  features.push({
    type: 'Feature',
    properties: { kind: 'ocean' },
    geometry: { type: 'MultiPolygon', coordinates: oceanPolys },
  });

  // 2. Global Coastlines (used for crisp z0-z7 continental silhouette)
  const coastLines = [];
  for (const f of coast50.features) {
    const lines =
      f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.coordinates || [];
    for (const line of lines) {
      if (ringBBoxArea(line) < minIslandArea && !line.some(([x, y]) => inLevant(x, y))) continue;
      const simplified = simplifyAdaptive(line, 0.11 * 0.11, 0.03 * 0.03, false);
      if (simplified) coastLines.push(simplified);
    }
  }
  features.push({
    type: 'Feature',
    properties: { kind: 'coastline' },
    geometry: { type: 'MultiLineString', coordinates: coastLines },
  });

  // 3. International Borders (fades out before Israel.osm high-res boundaries take over)
  const borderLines = [];
  for (const f of borders50.features) {
    const lines =
      f.geometry?.type === 'LineString' ? [f.geometry.coordinates] : f.geometry?.coordinates || [];
    for (const line of lines) {
      const simplified = simplifyAdaptive(line, 0.07 * 0.07, 0.015 * 0.015, false);
      if (simplified) borderLines.push(simplified);
    }
  }
  features.push({
    type: 'Feature',
    properties: { kind: 'border' },
    geometry: { type: 'MultiLineString', coordinates: borderLines },
  });

  // 4. Country Name Labels (Hebrew with English fallback)
  for (const f of countries110.features) {
    const p = f.properties || {};
    const lon = Number(p.LABEL_X);
    const lat = Number(p.LABEL_Y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const name = String(p.NAME || '').trim();
    const rawHe = String(p.NAME_HE || '').trim();
    const nameHe = rawHe || name;
    if (!name && !nameHe) continue;
    features.push({
      type: 'Feature',
      properties: {
        kind: 'country',
        name,
        nameHe,
        rank: Number(p.LABELRANK ?? 4),
      },
      geometry: {
        type: 'Point',
        coordinates: [Math.round(lon * 100) / 100, Math.round(lat * 100) / 100],
      },
    });
  }

  // 5. Continents & Major Oceans / Seas
  const continents = [
    { name: 'Africa', nameHe: 'אפריקה', coords: [20, 4] },
    { name: 'Europe', nameHe: 'אירופה', coords: [15, 51] },
    { name: 'Asia', nameHe: 'אסיה', coords: [92, 42] },
    { name: 'North America', nameHe: 'אמריקה הצפונית', coords: [-100, 44] },
    { name: 'South America', nameHe: 'אמריקה הדרומית', coords: [-60, -14] },
    { name: 'Oceania', nameHe: 'אוקיאניה', coords: [134, -24] },
    { name: 'Antarctica', nameHe: 'אנטארקטיקה', coords: [20, -78] },
  ];
  for (const c of continents) {
    features.push({
      type: 'Feature',
      properties: { kind: 'continent', name: c.name, nameHe: c.nameHe },
      geometry: { type: 'Point', coordinates: c.coords },
    });
  }

  const majorSeas = [
    { name: 'Atlantic Ocean', nameHe: 'האוקיינוס האטלנטי', coords: [-34, 15] },
    { name: 'Pacific Ocean', nameHe: 'האוקיינוס השקט', coords: [-140, 0] },
    { name: 'Indian Ocean', nameHe: 'האוקיינוס ההודי', coords: [76, -15] },
    { name: 'Arctic Ocean', nameHe: 'האוקיינוס הארקטי', coords: [0, 82] },
    { name: 'Southern Ocean', nameHe: 'האוקיינוס הדרומי', coords: [0, -62] },
    { name: 'Mediterranean Sea', nameHe: 'הים התיכון', coords: [18, 35.5] },
    { name: 'Red Sea', nameHe: 'ים סוף', coords: [38.5, 20.5] },
  ];
  for (const s of majorSeas) {
    features.push({
      type: 'Feature',
      properties: { kind: 'sea', name: s.name, nameHe: s.nameHe },
      geometry: { type: 'Point', coordinates: s.coords },
    });
  }

  // 6. 15° / 30° Cartographic Graticule
  const majorGrat = [];
  const minorGrat = [];
  for (let lon = -165; lon <= 180; lon += 15) {
    const coords = [];
    for (let lat = -80; lat <= 80; lat += 5) coords.push([lon, lat]);
    (lon % 30 === 0 ? majorGrat : minorGrat).push(coords);
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const coords = [];
    for (let lon = -180; lon <= 180; lon += 5) coords.push([lon, lat]);
    (lat % 30 === 0 ? majorGrat : minorGrat).push(coords);
  }
  features.push({
    type: 'Feature',
    properties: { kind: 'graticule', major: true },
    geometry: { type: 'MultiLineString', coordinates: majorGrat },
  });
  features.push({
    type: 'Feature',
    properties: { kind: 'graticule', major: false },
    geometry: { type: 'MultiLineString', coordinates: minorGrat },
  });

  const collection = { type: 'FeatureCollection', features };
  const pmtilesBytes = buildVectorPMTiles(collection);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, pmtilesBytes);
  if (fs.existsSync(LEGACY_GEOJSON_PATH)) {
    fs.unlinkSync(LEGACY_GEOJSON_PATH);
  }

  await verifyGeneratedPmtiles(OUT_PATH);
}

function pushVarint(out, val) {
  let n = val;
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
}

function serializeDirectory(entries) {
  const bytes = [];
  pushVarint(bytes, entries.length);

  let lastId = 0;
  for (const e of entries) {
    pushVarint(bytes, e.tileId - lastId);
    lastId = e.tileId;
  }
  for (const e of entries) {
    pushVarint(bytes, e.runLength);
  }
  for (const e of entries) {
    pushVarint(bytes, e.length);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length) {
      pushVarint(bytes, 0);
    } else {
      pushVarint(bytes, e.offset + 1);
    }
  }
  return Buffer.from(bytes);
}

function buildDirectorySections(tileEntries, maxRootCompressedBytes) {
  const fullRoot = zlib.gzipSync(serializeDirectory(tileEntries), { level: 9 });
  if (fullRoot.length <= maxRootCompressedBytes) {
    return { rootDirGz: fullRoot, leafDirsBuf: Buffer.alloc(0) };
  }

  let leafSize = Math.max(256, Math.ceil(tileEntries.length / 8));
  while (true) {
    const rootEntries = [];
    const leafChunks = [];
    let leafOffset = 0;
    for (let i = 0; i < tileEntries.length; i += leafSize) {
      const slice = tileEntries.slice(i, i + leafSize);
      const leafGz = zlib.gzipSync(serializeDirectory(slice), { level: 9 });
      rootEntries.push({
        tileId: slice[0].tileId,
        offset: leafOffset,
        length: leafGz.length,
        runLength: 0,
      });
      leafChunks.push(leafGz);
      leafOffset += leafGz.length;
    }
    const rootDirGz = zlib.gzipSync(serializeDirectory(rootEntries), { level: 9 });
    if (rootDirGz.length <= maxRootCompressedBytes || leafSize >= tileEntries.length) {
      return { rootDirGz, leafDirsBuf: Buffer.concat(leafChunks) };
    }
    leafSize *= 2;
  }
}

function writePmtilesHeader(meta) {
  const buf = Buffer.alloc(127);
  buf.write('PMTiles', 0, 'ascii');
  buf.writeUInt8(3, 7);
  buf.writeBigUInt64LE(BigInt(meta.rootDirectoryOffset), 8);
  buf.writeBigUInt64LE(BigInt(meta.rootDirectoryLength), 16);
  buf.writeBigUInt64LE(BigInt(meta.jsonMetadataOffset), 24);
  buf.writeBigUInt64LE(BigInt(meta.jsonMetadataLength), 32);
  buf.writeBigUInt64LE(BigInt(meta.leafDirectoryOffset), 40);
  buf.writeBigUInt64LE(BigInt(meta.leafDirectoryLength), 48);
  buf.writeBigUInt64LE(BigInt(meta.tileDataOffset), 56);
  buf.writeBigUInt64LE(BigInt(meta.tileDataLength), 64);
  buf.writeBigUInt64LE(BigInt(meta.numAddressedTiles), 72);
  buf.writeBigUInt64LE(BigInt(meta.numTileEntries), 80);
  buf.writeBigUInt64LE(BigInt(meta.numTileContents), 88);
  buf.writeUInt8(1, 96); // clustered
  buf.writeUInt8(Compression.Gzip, 97); // internal compression
  buf.writeUInt8(Compression.Gzip, 98); // tile compression
  buf.writeUInt8(TileType.Mvt, 99);
  buf.writeUInt8(0, 100); // minZoom
  buf.writeUInt8(WORLD_MAX_ZOOM, 101); // maxZoom
  buf.writeInt32LE(Math.round(-180 * 1e7), 102);
  buf.writeInt32LE(Math.round(-85.051129 * 1e7), 106);
  buf.writeInt32LE(Math.round(180 * 1e7), 110);
  buf.writeInt32LE(Math.round(85.051129 * 1e7), 114);
  buf.writeUInt8(2, 118); // centerZoom
  buf.writeInt32LE(Math.round(35.0 * 1e7), 119);
  buf.writeInt32LE(Math.round(31.8 * 1e7), 123);
  return buf;
}

function buildVectorPMTiles(collection) {
  console.log(`[World Globe] Slicing vector tiles z0-z${WORLD_MAX_ZOOM}...`);
  const index = new geojsonvt(collection, {
    maxZoom: WORLD_MAX_ZOOM,
    indexMaxZoom: WORLD_MAX_ZOOM,
    indexMaxPoints: 0,
    tolerance: 1.5,
    extent: TILE_EXTENT,
    buffer: TILE_BUFFER,
  });

  const blobOffsets = new Map();
  const uniqueBlobs = [];
  let tileDataCursor = 0;
  const rawEntries = [];

  for (let z = 0; z <= WORLD_MAX_ZOOM; z++) {
    const dim = 1 << z;
    for (let x = 0; x < dim; x++) {
      for (let y = 0; y < dim; y++) {
        const tile = index.getTile(z, x, y);
        if (!tile || !tile.features || tile.features.length === 0) continue;
        const pbf = Buffer.from(
          vtpbf.fromGeojsonVt({ [SOURCE_LAYER]: tile }, { version: 2, extent: TILE_EXTENT })
        );
        const gz = zlib.gzipSync(pbf, { level: 9 });
        const hash = crypto.createHash('sha256').update(gz).digest('hex');
        let placement = blobOffsets.get(hash);
        if (!placement) {
          placement = { offset: tileDataCursor, length: gz.length };
          blobOffsets.set(hash, placement);
          uniqueBlobs.push(gz);
          tileDataCursor += gz.length;
        }
        rawEntries.push({
          tileId: zxyToTileId(z, x, y),
          offset: placement.offset,
          length: placement.length,
          runLength: 1,
        });
      }
    }
  }

  // PMTiles v3 directories must be strictly sorted by Hilbert tileId and RLE-merged
  rawEntries.sort((a, b) => a.tileId - b.tileId);
  const mergedEntries = [];
  for (const e of rawEntries) {
    const prev = mergedEntries[mergedEntries.length - 1];
    if (
      prev &&
      e.tileId === prev.tileId + prev.runLength &&
      e.offset === prev.offset &&
      e.length === prev.length
    ) {
      prev.runLength += 1;
    } else {
      mergedEntries.push({ ...e });
    }
  }

  const metadataJson = JSON.stringify({
    name: 'NavApp Offline World Basemap',
    description: 'Natural Earth z0-z6 world ocean, coastlines, borders, and Hebrew/English globe labels',
    version: '1.0.0',
    format: 'pbf',
    attribution: 'Natural Earth',
    minzoom: '0',
    maxzoom: String(WORLD_MAX_ZOOM),
    vector_layers: [
      {
        id: SOURCE_LAYER,
        minzoom: 0,
        maxzoom: WORLD_MAX_ZOOM,
        fields: {
          kind: 'String',
          name: 'String',
          nameHe: 'String',
          rank: 'Number',
          major: 'Boolean',
        },
      },
    ],
  });
  const metadataGz = zlib.gzipSync(metadataJson, { level: 9 });
  const maxRootBytes = Math.max(4096, 16384 - 127 - metadataGz.length);
  const { rootDirGz, leafDirsBuf } = buildDirectorySections(mergedEntries, maxRootBytes);

  const rootDirectoryOffset = 127;
  const rootDirectoryLength = rootDirGz.length;
  const jsonMetadataOffset = rootDirectoryOffset + rootDirectoryLength;
  const jsonMetadataLength = metadataGz.length;
  const leafDirectoryOffset = jsonMetadataOffset + jsonMetadataLength;
  const leafDirectoryLength = leafDirsBuf.length;
  const tileDataOffset = leafDirectoryOffset + leafDirectoryLength;
  const tileDataLength = tileDataCursor;

  const headerBuf = writePmtilesHeader({
    rootDirectoryOffset,
    rootDirectoryLength,
    jsonMetadataOffset,
    jsonMetadataLength,
    leafDirectoryOffset,
    leafDirectoryLength,
    tileDataOffset,
    tileDataLength,
    numAddressedTiles: rawEntries.length,
    numTileEntries: mergedEntries.length,
    numTileContents: uniqueBlobs.length,
  });

  console.log(
    `[World Globe] PMTiles stats: ${rawEntries.length} tiles -> ${mergedEntries.length} dir entries (${rootDirectoryLength}B root, ${leafDirectoryLength}B leaves), ${uniqueBlobs.length} unique blobs (${(
      tileDataLength / 1024
    ).toFixed(1)} KB)`
  );

  return Buffer.concat([headerBuf, rootDirGz, metadataGz, leafDirsBuf, ...uniqueBlobs]);
}

async function verifyGeneratedPmtiles(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const pm = new PMTiles({
      getKey: () => filePath,
      async getBytes(offset, length) {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, offset);
        return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      },
    });
    const header = await pm.getHeader();
    const meta = await pm.getMetadata();
    for (const [z, x, y] of [
      [0, 0, 0],
      [2, 2, 1],
      [6, 38, 26],
    ]) {
      const tileResp = await pm.getZxy(z, x, y);
      if (!tileResp) throw new Error(`Expected non-empty tile at ${z}/${x}/${y}`);
      const vt = new VectorTile(new PbfReader(new Uint8Array(tileResp.data)));
      const layer = vt.layers[SOURCE_LAYER];
      if (!layer || layer.length === 0) {
        throw new Error(`Missing "${SOURCE_LAYER}" features at ${z}/${x}/${y}`);
      }
    }
    const size = fs.statSync(filePath).size;
    console.log(
      `[World Globe] Verified ${path.relative(ROOT_DIR, filePath)} (${(size / 1024).toFixed(1)} KB, z${header.minZoom}-z${header.maxZoom}, layers=${meta.vector_layers?.map((v) => v.id).join(',')})`
    );
  } finally {
    fs.closeSync(fd);
  }
}

main().catch((err) => {
  console.error('[World Globe] Failed:', err);
  process.exit(1);
});
