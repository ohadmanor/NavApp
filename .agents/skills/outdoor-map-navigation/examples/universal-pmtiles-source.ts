import maplibregl from 'maplibre-gl';
import { PMTiles, Protocol, FetchSource, FileSource, type Source, type RangeResponse } from 'pmtiles';

/**
 * Custom PMTiles Source for Capacitor (Android / iOS) or custom byte-range endpoints.
 * Reads byte slices via a local native HTTP range responder or custom byte-slice reader,
 * avoiding full-file memory loads in mobile WebViews.
 */
export class NativeSliceSource implements Source {
  private readonly key: string;
  private readonly sliceFetcher: (offset: number, length: number, signal?: AbortSignal) => Promise<ArrayBuffer>;

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

export type MapSourceDescriptor =
  | { id: string; kind: 'remote-url'; url: string }
  | { id: string; kind: 'web-file'; file: File }
  | {
      id: string;
      kind: 'native-local';
      filePath: string;
      readSlice: (offset: number, length: number, signal?: AbortSignal) => Promise<ArrayBuffer>;
    };

/**
 * Manages PMTiles protocol registration and dynamic switching between
 * Remote Web URLs, Web Local Files (OPFS / File Input), and Mobile Local Storage.
 */
export class PMTilesRegistry {
  private protocol: Protocol;
  private archives = new Map<string, PMTiles>();
  private isProtocolRegistered = false;

  constructor() {
    this.protocol = new Protocol({ metadata: true });
  }

  /**
   * Registers the `pmtiles://` protocol with MapLibre GL JS once.
   */
  initMapLibreProtocol(): void {
    if (this.isProtocolRegistered) return;
    maplibregl.addProtocol('pmtiles', this.protocol.tile);
    this.isProtocolRegistered = true;
  }

  /**
   * Registers a remote URL, Web File/OPFS handle, or Mobile native file archive
   * and returns the `pmtiles://...` URL to use in a MapLibre style source.
   */
  async registerSource(descriptor: MapSourceDescriptor): Promise<{
    protocolUrl: string;
    pmtiles: PMTiles;
    header: Awaited<ReturnType<PMTiles['getHeader']>>;
  }> {
    this.initMapLibreProtocol();

    let source: Source;
    switch (descriptor.kind) {
      case 'remote-url':
        source = new FetchSource(descriptor.url);
        break;
      case 'web-file':
        // Ensure unique key per archive id so multiple local files can coexist
        const fileSource = new FileSource(descriptor.file);
        source = {
          getKey: () => descriptor.id,
          getBytes: (offset, length, signal, etag) =>
            fileSource.getBytes(offset, length, signal, etag),
        };
        break;
      case 'native-local':
        source = new NativeSliceSource(descriptor.id, descriptor.readSlice);
        break;
    }

    const pmtiles = new PMTiles(source);
    const header = await pmtiles.getHeader();

    this.protocol.add(pmtiles);
    this.archives.set(descriptor.id, pmtiles);

    return {
      protocolUrl: `pmtiles://${source.getKey()}`,
      pmtiles,
      header,
    };
  }

  getArchive(id: string): PMTiles | undefined {
    return this.archives.get(id);
  }
}

