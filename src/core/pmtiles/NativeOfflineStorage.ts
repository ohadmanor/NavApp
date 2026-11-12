import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeArchiveFileStatus {
  exists: boolean;
  valid: boolean;
  sizeBytes: number;
  lastModifiedMs: number;
  nativeUrl: string;
  localPath: string;
  downloading?: boolean;
}

export interface NativeArchiveStatusResult {
  supported: boolean;
  freeBytes: number;
  totalBytes: number;
  files: Record<string, NativeArchiveFileStatus>;
}

export interface NativeDownloadProgressEvent {
  fileName: string;
  loaded: number;
  total: number;
}

export interface NativeOfflineStoragePluginInterface {
  getArchiveStatus(): Promise<NativeArchiveStatusResult>;
  downloadArchive(options: {
    fileName: string;
    url: string;
    expectedSize?: number;
  }): Promise<NativeArchiveFileStatus>;
  cancelDownload(options: { fileName: string }): Promise<void>;
  beginChunkedWrite(options: {
    fileName: string;
    expectedSize?: number;
  }): Promise<{ writeId: string }>;
  appendChunkBase64(options: {
    writeId: string;
    dataBase64: string;
  }): Promise<{ bytesWritten: number }>;
  finishChunkedWrite(options: { writeId: string }): Promise<NativeArchiveFileStatus>;
  abortChunkedWrite(options: { writeId: string }): Promise<void>;
  removeArchive(options: { fileName: string }): Promise<void>;
  syncCarData(options: {
    activeRouteJson?: string | null;
    savedRoutesJson?: string | null;
    userPoisJson?: string | null;
    deletedPoiIdsJson?: string | null;
    carStateJson?: string | null;
  }): Promise<void>;
  getCarSyncState(): Promise<{
    hasActiveRoute: boolean;
    savedRoutesCount: number;
    userPoisCount: number;
    hasCarState: boolean;
  }>;
  addListener(
    eventName: 'downloadProgress',
    listenerFunc: (event: NativeDownloadProgressEvent) => void
  ): Promise<PluginListenerHandle>;
}

const NativeOfflineStoragePlugin =
  registerPlugin<NativeOfflineStoragePluginInterface>('NativeOfflineStorage');

const CHUNK_SIZE_BYTES = 1024 * 1024; // 1 MiB binary chunk -> ~1.33 MiB Base64 across bridge

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const blockSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += blockSize) {
    const slice = bytes.subarray(i, Math.min(i + blockSize, bytes.length));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

export class NativeOfflineStorage {
  static isAndroidNative(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
    } catch {
      return !!(window as any).Capacitor?.isNativePlatform?.();
    }
  }

  static getPlugin(): NativeOfflineStoragePluginInterface {
    return NativeOfflineStoragePlugin;
  }

  static nativeArchiveUrl(fileName: string): string {
    return `https://localhost/__native_maps__/${encodeURIComponent(fileName)}`;
  }

  static async getArchiveStatus(): Promise<NativeArchiveStatusResult | null> {
    if (!this.isAndroidNative()) return null;
    try {
      return await this.getPlugin().getArchiveStatus();
    } catch (err) {
      console.warn('[NativeOfflineStorage] getArchiveStatus failed:', err);
      return null;
    }
  }

  static async downloadArchive(
    fileName: string,
    url: string,
    expectedSize: number,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<NativeArchiveFileStatus> {
    if (!this.isAndroidNative()) {
      throw new Error('NativeOfflineStorage is only available on native Android');
    }
    if (signal?.aborted) {
      const abortErr = new Error('Download aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    const plugin = this.getPlugin();
    let listenerHandle: PluginListenerHandle | null = null;
    let cancelledBySignal = false;

    const onAbort = () => {
      cancelledBySignal = true;
      void plugin.cancelDownload({ fileName }).catch(() => {});
    };

    if (onProgress) {
      listenerHandle = await plugin.addListener(
        'downloadProgress',
        (ev) => {
          if (ev.fileName === fileName) {
            onProgress(ev.loaded, ev.total || expectedSize);
          }
        }
      );
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await plugin.downloadArchive({
        fileName,
        url,
        expectedSize,
      });
      if (cancelledBySignal) {
        const abortErr = new Error('Download aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      return result;
    } catch (err: any) {
      if (cancelledBySignal || signal?.aborted) {
        const abortErr = new Error('Download aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await listenerHandle?.remove().catch(() => {});
    }
  }

  /**
   * Streams a Web File/Blob (e.g. from OPFS or <input type="file">) into native
   * `filesDir/maps/{fileName}` in 1 MiB chunks without loading multi-GB files in RAM.
   */
  static async saveBlobChunked(
    fileName: string,
    blob: Blob,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<NativeArchiveFileStatus> {
    if (!this.isAndroidNative()) {
      throw new Error('NativeOfflineStorage is only available on native Android');
    }

    const plugin = this.getPlugin();
    const total = blob.size;
    const { writeId } = await plugin.beginChunkedWrite({
      fileName,
      expectedSize: total,
    });

    try {
      let offset = 0;
      while (offset < total) {
        if (signal?.aborted) {
          const abortErr = new Error('Chunked write aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        const nextEnd = Math.min(offset + CHUNK_SIZE_BYTES, total);
        const sliceBuf = await blob.slice(offset, nextEnd).arrayBuffer();
        const dataBase64 = arrayBufferToBase64(sliceBuf);
        await plugin.appendChunkBase64({
          writeId,
          dataBase64,
        });
        offset = nextEnd;
        onProgress?.(offset, total);
      }
      return await plugin.finishChunkedWrite({ writeId });
    } catch (err) {
      await plugin.abortChunkedWrite({ writeId }).catch(() => {});
      throw err;
    }
  }

  static async removeArchive(fileName: string): Promise<void> {
    if (!this.isAndroidNative()) return;
    await this.getPlugin().removeArchive({ fileName });
  }

  static async syncCarData(payload: {
    activeRouteJson?: string | null;
    savedRoutesJson?: string | null;
    userPoisJson?: string | null;
    deletedPoiIdsJson?: string | null;
    carStateJson?: string | null;
  }): Promise<void> {
    if (!this.isAndroidNative()) return;
    await this.getPlugin().syncCarData(payload);
  }
}
