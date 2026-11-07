import type { Source, RangeResponse } from 'pmtiles';

/**
 * Custom PMTiles Source for Capacitor (Android / iOS) or custom byte-range endpoints.
 * Reads exact byte slices [offset, offset + length - 1] without loading multi-GB archives into memory.
 */
export class NativeSliceSource implements Source {
  private readonly key: string;
  private readonly sliceFetcher: (
    offset: number,
    length: number,
    signal?: AbortSignal
  ) => Promise<ArrayBuffer>;

  constructor(
    key: string,
    sliceFetcher: (offset: number, length: number, signal?: AbortSignal) => Promise<ArrayBuffer>
  ) {
    this.key = key;
    this.sliceFetcher = sliceFetcher;
  }

  getKey(): string {
    return this.key;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    _etag?: string
  ): Promise<RangeResponse> {
    const data = await this.sliceFetcher(offset, length, signal);
    return { data };
  }
}

