import type { PMTiles, Header } from 'pmtiles';
import type { VectorTile } from '@mapbox/vector-tile';

export const SEARCH_INDEX_VERSION: 1;
export const SEARCH_LAYERS: string[];

/**
 * Compact tuple row:
 * [layerIdx, classIdx, subclassIdx, localityIdx, name, altName, refOrCode, latE5, lonE5, eleOrNull, rank, tier]
 */
export type SearchIndexTupleRow = [
  number,
  number,
  number,
  number,
  string,
  string,
  string,
  number,
  number,
  number | null,
  number,
  number,
];

export interface SearchIndexPayload {
  v: 1;
  createdUtc: string;
  fingerprint: string;
  bounds: [number, number, number, number];
  minZoom: number;
  maxZoom: number;
  totalFeatures: number;
  layers: string[];
  classes: string[];
  subclasses: string[];
  localities: string[];
  rows: SearchIndexTupleRow[];
}

export interface RawExtractedRecord {
  layer: string;
  sourceLayer: string;
  cls: string;
  subclass: string;
  name: string;
  altName: string;
  refOrCode: string;
  normName: string;
  lon: number;
  lat: number;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  buffered: boolean;
  ele: number | null;
  rank: number;
  z: number;
}

export function normalizeSearchText(text?: string | null): string;
export function cleanDisplayName(text?: string | null): string;
export function tilePixelToLonLat(
  z: number,
  x: number,
  y: number,
  px: number,
  py: number,
  extent?: number
): [number, number];
export function haversineKmFast(lon1: number, lat1: number, lon2: number, lat2: number): number;
export function getPmtilesArchiveFingerprint(header?: Header | null): string;
export function isGzipBytes(bytes?: Uint8Array | null): boolean;
export function gzipUint8Array(inputBytes: Uint8Array): Promise<Uint8Array>;
export function gunzipUint8Array(inputBytes: Uint8Array): Promise<Uint8Array>;
export function computeRecordTier(
  layer: string,
  cls: string,
  subclass: string,
  rank: number,
  ele: number | null
): number;

export function readPmtilesTileDirectoryEntries(
  pmtiles: PMTiles,
  options?: { gunzip?: (bytes: Uint8Array) => Promise<Uint8Array> }
): Promise<{
  header: Header;
  byZoom: Map<number, Array<{ z: number; x: number; y: number; offset: number; length: number }>>;
}>;

export function extractRawRecordsFromVectorTile(
  vt: VectorTile,
  z: number,
  x: number,
  y: number
): RawExtractedRecord[];

export class SearchIndexBuilder {
  constructor(meta?: Partial<SearchIndexPayload>);
  ingestRecords(records: RawExtractedRecord[]): void;
  buildPayload(): SearchIndexPayload;
}

export function extractSearchIndexFromPmtiles(
  pmtiles: PMTiles,
  options?: {
    gunzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
    onProgress?: (done: number, total: number) => void;
    yieldEvery?: number;
    signal?: AbortSignal;
  }
): Promise<SearchIndexPayload>;

export function serializeSearchIndexPayload(
  payload: SearchIndexPayload,
  options?: {
    gzip?: boolean;
    gzipFn?: (bytes: Uint8Array) => Promise<Uint8Array>;
  }
): Promise<Uint8Array>;

export function parseSearchIndexBytes(
  bytes: Uint8Array | ArrayBuffer,
  options?: {
    gunzip?: (bytes: Uint8Array) => Promise<Uint8Array>;
  }
): Promise<SearchIndexPayload>;
