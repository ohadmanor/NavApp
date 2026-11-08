/**
 * Browser Origin Private File System (OPFS) Storage Adapter.
 * Enables storing multi-gigabyte .pmtiles archives persistently on the user's disk
 * and reading random-access byte slices via FileSource (`file.slice(offset, offset + length)`).
 */
export class OpfsStorageAdapter {
  private static readonly MAPS_DIR = 'maps';

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage;
  }

  private static async getMapsDirHandle(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(this.MAPS_DIR, { create: true });
  }

  /**
   * Checks if a file exists in OPFS and returns its File handle for random-access slicing.
   */
  static async getStoredFile(fileName: string): Promise<File | null> {
    if (!this.isSupported()) return null;
    try {
      const dir = await this.getMapsDirHandle();
      const fileHandle = await dir.getFileHandle(fileName, { create: false });
      return await fileHandle.getFile();
    } catch {
      return null;
    }
  }

  /**
   * Atomically saves or replaces a .pmtiles archive in OPFS (e.g., when updating Israel.osm.pmtiles)
   * with streaming progress reporting.
   */
  static async saveOrReplaceFromStream(
    fileName: string,
    sourceUrlOrBlob: string | Blob,
    onProgress?: (loadedBytes: number, totalBytes: number) => void,
    signal?: AbortSignal,
    expectedSize?: number
  ): Promise<File> {
    const dir = await this.getMapsDirHandle();
    const tempFileName = `${fileName}.tmp`;
    const tempHandle = await dir.getFileHandle(tempFileName, { create: true });
    const writable = await tempHandle.createWritable();

    try {
      if (typeof sourceUrlOrBlob === 'string') {
        const response = await fetch(sourceUrlOrBlob, { signal });
        if (!response.ok || !response.body) {
          throw new Error(`Failed to fetch ${sourceUrlOrBlob}: HTTP ${response.status}`);
        }
        // Content-Length is the *compressed* size when the CDN applies Content-Encoding, while the
        // stream yields decoded bytes. Trust only the real (probed) size, never a compressed header.
        const encoded = !!response.headers.get('content-encoding');
        const total = expectedSize || (encoded ? 0 : Number(response.headers.get('content-length') || 0));
        const reader = response.body.getReader();
        let loaded = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            await writable.write(value);
            loaded += value.byteLength;
            onProgress?.(loaded, total);
          }
        }
        if (total > 0 && loaded !== total) {
          throw new Error(`Incomplete download: ${loaded} of ${total} bytes`);
        }
      } else {
        const total = sourceUrlOrBlob.size;
        const chunkSize = 4 * 1024 * 1024; // 4 MB chunks
        let offset = 0;
        while (offset < total) {
          const slice = sourceUrlOrBlob.slice(offset, Math.min(offset + chunkSize, total));
          const buf = await slice.arrayBuffer();
          await writable.write(buf);
          offset += buf.byteLength;
          onProgress?.(offset, total);
        }
      }
      await writable.close();

      // Prefer an atomic rename (no second multi-GB copy). Fall back to copy on older engines.
      const movable = tempHandle as FileSystemFileHandle & {
        move?: (name: string) => Promise<void>;
      };
      if (typeof movable.move === 'function') {
        await dir.removeEntry(fileName).catch(() => {});
        await movable.move(fileName);
        const movedHandle = await dir.getFileHandle(fileName, { create: false });
        return await movedHandle.getFile();
      }

      const tempFile = await tempHandle.getFile();
      const finalHandle = await dir.getFileHandle(fileName, { create: true });
      const finalWritable = await finalHandle.createWritable();
      await tempFile.stream().pipeTo(finalWritable);

      await dir.removeEntry(tempFileName).catch(() => {});
      return await finalHandle.getFile();
    } catch (err) {
      await writable.abort().catch(() => {});
      await dir.removeEntry(tempFileName).catch(() => {});
      throw err;
    }
  }

  /** Deletes a stored archive (and any leftover temp file) from OPFS. */
  static async removeFile(fileName: string): Promise<void> {
    if (!this.isSupported()) return;
    const dir = await this.getMapsDirHandle();
    await dir.removeEntry(fileName).catch(() => {});
    await dir.removeEntry(`${fileName}.tmp`).catch(() => {});
  }

  /** Returns browser storage quota/usage and requests persistent storage so files aren't evicted. */
  static async getStorageEstimate(): Promise<{ quota: number; usage: number; persisted: boolean }> {
    let persisted = false;
    try {
      persisted = (await navigator.storage.persist?.()) ?? false;
    } catch {
      /* ignore */
    }
    try {
      const est = await navigator.storage.estimate();
      return { quota: est.quota ?? 0, usage: est.usage ?? 0, persisted };
    } catch {
      return { quota: 0, usage: 0, persisted };
    }
  }

  static async listStoredFiles(): Promise<Array<{ name: string; size: number }>> {
    if (!this.isSupported()) return [];
    const results: Array<{ name: string; size: number }> = [];
    try {
      const dir = await this.getMapsDirHandle();
      // @ts-expect-error AsyncIterator on FileSystemDirectoryHandle
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file' && !name.endsWith('.tmp')) {
          const f = await (handle as FileSystemFileHandle).getFile();
          results.push({ name, size: f.size });
        }
      }
    } catch {
      // Ignore if OPFS not initialized
    }
    return results;
  }
}

