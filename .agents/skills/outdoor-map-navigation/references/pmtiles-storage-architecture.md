# PMTiles Storage & Cross-Platform Architecture Reference

## 1. How PMTiles Works Under the Hood
A **PMTiles v3** archive is a single read-only binary file containing a pyramid of map tiles (Vector MVT, Raster PNG/WebP/JPEG, or Terrain DEM) organized along a **Hilbert curve** so spatially adjacent tiles are physically adjacent on disk:
1. **Header (First 127 bytes)**: Magic number (`PMTiles\x03`), root directory offset/length, metadata offset/length, leaf directories offset/length, tile data offset/length, tile type, compression (`gzip`, `brotli`, `zstd`, `none`), zoom bounds (`minZoom`, `maxZoom`), and geographic bounds.
2. **Root Directory (fit within initial 16 KB read)**: Maps `tile_id` (Hilbert index of `z/x/y`) to byte offsets or leaf directory offsets.
3. **Metadata (JSON)**: Contains `vector_layers`, attribution, name, description, and center.
4. **Leaf Directories & Tile Data**: Compressed individual tiles read on demand via byte-offset and byte-length (`offset`, `length`).

Because `pmtiles` only ever asks for `(offset: number, length: number)` via the `Source` interface:
```ts
export interface RangeResponse {
  data: ArrayBuffer;
  etag?: string;
  expires?: string;
  cacheControl?: string;
}

export interface Source {
  getBytes: (offset: number, length: number, signal?: AbortSignal, etag?: string) => Promise<RangeResponse>;
  getKey: () => string;
}
```
We can load arbitrarily large (e.g. 500 MB – 20 GB) regional or country-wide map files with **< 5 MB of RAM** on both Web and Mobile, provided our `Source` performs true byte-range slicing rather than reading the entire file into memory.

---

## 2. Web Storage Strategies

### A. Remote HTTP Range Requests (`FetchSource`)
- Hosted on static object storage (Cloudflare R2, AWS S3, GCS, Nginx, Caddy).
- **Required CORS Headers on Bucket/Server**:
  - `Access-Control-Allow-Origin: *` (or app origin)
  - `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
  - `Access-Control-Allow-Headers: Range, If-Match`
  - `Access-Control-Expose-Headers: ETag, Content-Length, Content-Range, Accept-Ranges`

### B. Origin Private File System (OPFS) for Persistent Downloaded Maps
- Modern browsers (Chrome, Edge, Safari 15.2+, Firefox 111+) support **OPFS** (`navigator.storage.getDirectory()`), which stores multi-gigabyte binary files directly on disk with near-native I/O performance.
- Unlike IndexedDB (which can bloat memory when storing huge blobs), an OPFS `FileSystemFileHandle` returns a `File` object via `await fileHandle.getFile()`.
- Passing that `File` object into `new FileSource(file)` allows `file.slice(offset, offset + length).arrayBuffer()` to seek directly to the disk offset without reading the rest of the file.

### C. Local User File Picker (`<input type="file">` / `showOpenFilePicker`)
- Users on desktop or mobile browsers can pick an existing `.pmtiles` file from their device storage or SD card.
- Wrap the returned `File` directly in `new FileSource(file)`.

---

## 3. Mobile (Android & iOS via Capacitor) Storage Strategies

### Why Naive `fetch()` Fails on Capacitor Local Files
By default, Capacitor serves the web app over `https://localhost` (Android) or `capacitor://localhost` (iOS) and proxies `/_capacitor_file_/...` requests through native asset handlers.
- Standard WebView asset handlers often ignore the `Range: bytes=X-Y` header on local file paths and return `200 OK` with the entire file stream, causing Out-Of-Memory (OOM) crashes on large `.pmtiles` archives.

### Recommended Mobile Solutions

#### Strategy 1: Custom `Source` with Random-Access Byte Slice (Zero-Server Approach)
Implement `CapacitorFileSource` that reads only the requested `[offset, length]` slice from the native filesystem, or uses a File/Blob reference obtained from an OPFS/native file handle.
- For high-frequency tile loads (50+ tiles per pan/zoom), avoid base64 JSON bridge serialization overhead by returning raw binary (`ArrayBuffer`) over Capacitor's native HTTP/custom scheme responder or a tiny native random-access plugin that intercepts `https://localhost/_pmtiles_/<filename>?offset=X&length=Y` and returns an `application/octet-stream` response directly from a `RandomAccessFile` (Android) / `NSFileHandle` (iOS).

#### Strategy 2: Native `WebViewAssetLoader` / Custom Scheme Range Responder
In `MainActivity.java` / `BridgeActivity` (Android) and `CAPBridgeViewController` (iOS):
- Intercept requests matching `/_pmtiles_/*`.
- Parse the `Range: bytes=start-end` request header (or `?offset=&length=` query params).
- Open `java.io.RandomAccessFile` (Android) or `FileHandle` (iOS), call `seek(start)`, read `end - start + 1` bytes into a buffer, and return `HTTP 206 Partial Content` with `Content-Range: bytes start-end/totalLength`.
- This gives **native C++/Java file seek speeds** directly to MapLibre's Web Workers with zero base64 encoding overhead!

---

## 4. Multi-Archive Composition (IsraelHikingMap Pattern)
Instead of baking base vector data, contours, and hillshade DEM into a single monolithic file, split offline files into modular `.pmtiles` layers:
1. `region-base.pmtiles` (Vector MVT: roads, trails, POIs, landcover, water — updated weekly/monthly from OSM).
2. `region-contours.pmtiles` (Vector MVT: elevation contour lines — rarely changes, downloaded once).
3. `region-terrain-dem.pmtiles` (Raster Terrarium/Mapbox DEM PNG/WebP — used for both `hillshade` layer, 3D terrain extrusion, and client-side elevation lookup — rarely changes).

