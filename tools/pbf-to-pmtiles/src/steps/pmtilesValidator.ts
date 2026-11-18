import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import * as PbfModule from 'pbf';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import { REPO_ROOT, formatBytes } from '../paths.js';
import type { CountrySpec, LogLevel, ValidationSummary } from '../types.js';

type Logger = (level: LogLevel, message: string) => void;

class NodeFileSource implements Source {
  private readonly fd: number;
  private readonly key: string;

  constructor(filePath: string) {
    this.fd = fs.openSync(filePath, 'r');
    this.key = filePath;
  }

  getKey(): string {
    return this.key;
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(this.fd, buf, 0, length, offset);
    const slice = buf.subarray(0, bytesRead);
    return { data: slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

export async function validatePmtilesAndBuildIndex(
  country: CountrySpec,
  pmtilesPath: string,
  options: { rebuildSearchIndex?: boolean; signal?: AbortSignal; log: Logger }
): Promise<ValidationSummary> {
  if (!fs.existsSync(pmtilesPath)) {
    throw new Error(`PMTiles file not found: ${pmtilesPath}`);
  }
  const fileSizeBytes = fs.statSync(pmtilesPath).size;
  const source = new NodeFileSource(pmtilesPath);
  const layersSet = new Set<string>();
  let parkFeatureCount = 0;
  let transportationFeatureCount = 0;
  let minZoom = 0;
  let maxZoom = 0;
  let numAddressedTiles = 0;
  let numTileEntries = 0;

  try {
    const archive = new PMTiles(source);
    const header = await archive.getHeader();
    minZoom = header.minZoom;
    maxZoom = header.maxZoom;
    numAddressedTiles = header.numAddressedTiles;
    numTileEntries = header.numTileEntries;

    if (numAddressedTiles === 0) {
      throw new Error('Generated PMTiles archive has 0 addressed tiles.');
    }

    const centerLon = (header.minLon + header.maxLon) / 2;
    const centerLat = (header.minLat + header.maxLat) / 2;
    const sampleZ = Math.min(14, maxZoom);
    const centerTile = lonLatToTile(centerLon, centerLat, sampleZ);

    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        const res = await archive.getZxy(sampleZ, centerTile.x + dx, centerTile.y + dy);
        if (!res?.data) continue;
        let bytes = Buffer.from(res.data);
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
          bytes = zlib.gunzipSync(bytes);
        }
        const PbfCtor = (PbfModule as unknown as { default: new (buf: Uint8Array) => unknown }).default || (PbfModule as unknown as new (buf: Uint8Array) => unknown);
        const vt = new VectorTile(new PbfCtor(bytes) as ConstructorParameters<typeof VectorTile>[0]);
        for (const [name, layer] of Object.entries(vt.layers)) {
          layersSet.add(name);
          if (name === 'park') parkFeatureCount += layer.length;
          if (name === 'transportation') transportationFeatureCount += layer.length;
        }
      }
    }

    options.log(
      'info',
      `Validated ${path.basename(pmtilesPath)}: z${minZoom}–z${maxZoom}, ${numAddressedTiles} tiles, layers=[${Array.from(layersSet).join(', ')}].`
    );
  } finally {
    source.close();
  }

  let searchIndexPath: string | undefined;
  let searchIndexBytes: number | undefined;
  if (options.rebuildSearchIndex && country.outputPrefix === 'Israel') {
    const dataPmtiles = path.join(REPO_ROOT, 'data', 'Israel.osm.pmtiles');
    fs.mkdirSync(path.dirname(dataPmtiles), { recursive: true });
    fs.copyFileSync(pmtilesPath, dataPmtiles);
    const idxScript = path.join(REPO_ROOT, 'devops', 'script_helpers', 'build-pmtiles-search-index.mjs');
    if (fs.existsSync(idxScript)) {
      options.log('info', 'Rebuilding Israel.search.idx from new PMTiles...');
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [idxScript], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d: Buffer) => options.log('info', `[SearchIndex] ${d.toString('utf8').trim()}`));
        child.stderr.on('data', (d: Buffer) => options.log('warn', `[SearchIndex] ${d.toString('utf8').trim()}`));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Search index script exited ${code}`))));
      });
      const candidateIdx = path.join(REPO_ROOT, 'data', 'Israel.search.idx');
      if (fs.existsSync(candidateIdx)) {
        searchIndexPath = candidateIdx;
        searchIndexBytes = fs.statSync(candidateIdx).size;
        options.log('info', `Built Israel.search.idx (${formatBytes(searchIndexBytes)}).`);
      }
    }
  }

  return {
    pmtilesPath,
    fileSizeBytes,
    minZoom,
    maxZoom,
    numAddressedTiles,
    numTileEntries,
    layersFound: Array.from(layersSet).sort(),
    parkFeatureCount,
    transportationFeatureCount,
    searchIndexPath,
    searchIndexBytes,
  };
}
