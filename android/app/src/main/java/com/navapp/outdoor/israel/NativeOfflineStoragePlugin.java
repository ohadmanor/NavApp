package com.navapp.outdoor.israel;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Capacitor plugin providing native shared offline storage (`filesDir/maps/`) and
 * Android Auto state synchronization (`filesDir/car_sync/`).
 */
@CapacitorPlugin(name = "NativeOfflineStorage")
public class NativeOfflineStoragePlugin extends Plugin {
    private static final class ChunkedWriteSession {
        final String writeId;
        final String fileName;
        final File targetFile;
        final File tempFile;
        final long expectedSize;
        final OutputStream out;
        long bytesWritten = 0L;

        ChunkedWriteSession(
            String writeId,
            String fileName,
            File targetFile,
            File tempFile,
            long expectedSize,
            OutputStream out
        ) {
            this.writeId = writeId;
            this.fileName = fileName;
            this.targetFile = targetFile;
            this.tempFile = tempFile;
            this.expectedSize = expectedSize;
            this.out = out;
        }
    }

    private final ExecutorService downloadExecutor = Executors.newCachedThreadPool();
    private final Map<String, AtomicBoolean> downloadCancelFlags = new ConcurrentHashMap<>();
    private final Map<String, ChunkedWriteSession> activeWrites = new ConcurrentHashMap<>();

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        for (AtomicBoolean flag : downloadCancelFlags.values()) {
            flag.set(true);
        }
        downloadCancelFlags.clear();
        for (ChunkedWriteSession session : activeWrites.values()) {
            try {
                session.out.close();
            } catch (Exception ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            session.tempFile.delete();
        }
        activeWrites.clear();
        downloadExecutor.shutdownNow();
    }

    @PluginMethod
    public void getArchiveStatus(PluginCall call) {
        NativeMapStore store = NativeMapStore.getInstance(getContext());
        JSObject filesObj = new JSObject();
        filesObj.put(NativeMapStore.FILE_OSM_PMTILES, buildFileStatus(store, NativeMapStore.FILE_OSM_PMTILES));
        filesObj.put(NativeMapStore.FILE_DEM_PMTILES, buildFileStatus(store, NativeMapStore.FILE_DEM_PMTILES));

        JSObject out = new JSObject();
        out.put("supported", true);
        out.put("freeBytes", store.getFreeBytes());
        out.put("totalBytes", store.getTotalBytes());
        out.put("files", filesObj);
        call.resolve(out);
    }

    @PluginMethod
    public void downloadArchive(PluginCall call) {
        String rawFileName = call.getString("fileName");
        String fileName = NativeMapStore.sanitizeFileName(rawFileName);
        String urlStr = call.getString("url");
        Long expectedSizeObj = call.getLong("expectedSize");
        long expectedSize = expectedSizeObj != null ? expectedSizeObj : 0L;

        if (fileName == null || urlStr == null || !urlStr.startsWith("https://")) {
            call.reject("Valid fileName and https:// url are required");
            return;
        }

        NativeMapStore store = NativeMapStore.getInstance(getContext());
        if (store.isDownloadActive(fileName)) {
            call.reject("Download already in progress for " + fileName);
            return;
        }

        AtomicBoolean cancelled = new AtomicBoolean(false);
        downloadCancelFlags.put(fileName, cancelled);
        store.markDownloadActive(fileName, true);

        downloadExecutor.execute(() -> {
            File target = store.getMapFile(fileName);
            File temp = new File(store.getMapsDir(), fileName + ".tmp");
            HttpURLConnection conn = null;
            try {
                if (temp.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    temp.delete();
                }

                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept-Encoding", "identity");
                conn.connect();

                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    throw new IOException("HTTP " + code + " downloading " + fileName);
                }

                long contentLength = conn.getContentLengthLong();
                long total = expectedSize > 0L ? expectedSize : Math.max(0L, contentLength);
                long freeBytes = store.getFreeBytes();
                if (total > 0L && freeBytes > 0L && freeBytes < (long) (total * 1.05)) {
                    throw new IOException("Insufficient device storage");
                }

                long loaded = 0L;
                long lastProgressTs = 0L;
                try (InputStream in = conn.getInputStream();
                     FileOutputStream fos = new FileOutputStream(temp, false);
                     BufferedOutputStream bos = new BufferedOutputStream(fos, 65536)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancelled.get()) {
                            throw new IOException("Download aborted");
                        }
                        bos.write(buf, 0, n);
                        loaded += n;

                        long now = System.currentTimeMillis();
                        if (now - lastProgressTs >= 250L) {
                            lastProgressTs = now;
                            emitDownloadProgress(fileName, loaded, total);
                        }
                    }
                    bos.flush();
                    fos.getFD().sync();
                }

                if (cancelled.get()) {
                    throw new IOException("Download aborted");
                }
                if (total > 0L && loaded != total) {
                    throw new IOException("Incomplete download: " + loaded + " of " + total + " bytes");
                }
                if (!NativeMapStore.isValidPmTiles(temp)) {
                    throw new IOException("Downloaded file is not a valid PMTiles archive");
                }

                replaceFileAtomic(temp, target);
                emitDownloadProgress(fileName, loaded, total > 0L ? total : loaded);
                store.notifyArchiveUpdated(fileName);
                call.resolve(buildFileStatus(store, fileName));
            } catch (Exception ex) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
                call.reject(ex.getMessage() != null ? ex.getMessage() : "Download failed");
            } finally {
                if (conn != null) conn.disconnect();
                downloadCancelFlags.remove(fileName);
                store.markDownloadActive(fileName, false);
            }
        });
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String fileName = NativeMapStore.sanitizeFileName(call.getString("fileName"));
        if (fileName != null) {
            AtomicBoolean flag = downloadCancelFlags.get(fileName);
            if (flag != null) flag.set(true);
        }
        call.resolve();
    }

    @PluginMethod
    public void beginChunkedWrite(PluginCall call) {
        String fileName = NativeMapStore.sanitizeFileName(call.getString("fileName"));
        if (fileName == null) {
            call.reject("Invalid fileName");
            return;
        }
        Long expectedSizeObj = call.getLong("expectedSize");
        long expectedSize = expectedSizeObj != null ? expectedSizeObj : 0L;

        NativeMapStore store = NativeMapStore.getInstance(getContext());
        if (expectedSize > 0L) {
            long freeBytes = store.getFreeBytes();
            if (freeBytes > 0L && freeBytes < (long) (expectedSize * 1.05)) {
                call.reject("Insufficient device storage");
                return;
            }
        }

        File target = store.getMapFile(fileName);
        File temp = new File(store.getMapsDir(), fileName + ".write.tmp");
        try {
            if (temp.exists()) {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
            OutputStream out = new BufferedOutputStream(new FileOutputStream(temp, false), 65536);
            String writeId = UUID.randomUUID().toString();
            activeWrites.put(
                writeId,
                new ChunkedWriteSession(writeId, fileName, target, temp, expectedSize, out)
            );
            JSObject res = new JSObject();
            res.put("writeId", writeId);
            call.resolve(res);
        } catch (IOException ex) {
            call.reject("Unable to open temp file: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void appendChunkBase64(PluginCall call) {
        String writeId = call.getString("writeId");
        String dataBase64 = call.getString("dataBase64");
        ChunkedWriteSession session = writeId != null ? activeWrites.get(writeId) : null;
        if (session == null || dataBase64 == null) {
            call.reject("Invalid write session or chunk data");
            return;
        }
        try {
            byte[] bytes = Base64.decode(dataBase64, Base64.DEFAULT);
            synchronized (session) {
                session.out.write(bytes);
                session.bytesWritten += bytes.length;
            }
            JSObject res = new JSObject();
            res.put("bytesWritten", session.bytesWritten);
            call.resolve(res);
        } catch (Exception ex) {
            call.reject("Chunk write failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void finishChunkedWrite(PluginCall call) {
        String writeId = call.getString("writeId");
        ChunkedWriteSession session = writeId != null ? activeWrites.remove(writeId) : null;
        if (session == null) {
            call.reject("Unknown writeId");
            return;
        }
        NativeMapStore store = NativeMapStore.getInstance(getContext());
        try {
            synchronized (session) {
                session.out.flush();
                session.out.close();
            }
            if (session.expectedSize > 0L && session.bytesWritten != session.expectedSize) {
                throw new IOException(
                    "Incomplete file write: " + session.bytesWritten + " of " + session.expectedSize
                );
            }
            if (!NativeMapStore.isValidPmTiles(session.tempFile)) {
                throw new IOException("Invalid PMTiles file header");
            }
            replaceFileAtomic(session.tempFile, session.targetFile);
            store.notifyArchiveUpdated(session.fileName);
            call.resolve(buildFileStatus(store, session.fileName));
        } catch (Exception ex) {
            //noinspection ResultOfMethodCallIgnored
            session.tempFile.delete();
            call.reject(ex.getMessage() != null ? ex.getMessage() : "Finish write failed");
        }
    }

    @PluginMethod
    public void abortChunkedWrite(PluginCall call) {
        String writeId = call.getString("writeId");
        ChunkedWriteSession session = writeId != null ? activeWrites.remove(writeId) : null;
        if (session != null) {
            try {
                session.out.close();
            } catch (Exception ignored) {
            }
            //noinspection ResultOfMethodCallIgnored
            session.tempFile.delete();
        }
        call.resolve();
    }

    @PluginMethod
    public void removeArchive(PluginCall call) {
        String fileName = NativeMapStore.sanitizeFileName(call.getString("fileName"));
        if (fileName == null) {
            call.reject("Invalid fileName");
            return;
        }
        AtomicBoolean flag = downloadCancelFlags.get(fileName);
        if (flag != null) flag.set(true);

        NativeMapStore store = NativeMapStore.getInstance(getContext());
        File target = store.getMapFile(fileName);
        File tmp = new File(store.getMapsDir(), fileName + ".tmp");
        File writeTmp = new File(store.getMapsDir(), fileName + ".write.tmp");
        if (target != null && target.exists()) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
        }
        if (tmp.exists()) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
        }
        if (writeTmp.exists()) {
            //noinspection ResultOfMethodCallIgnored
            writeTmp.delete();
        }
        store.notifyArchiveUpdated(fileName);
        call.resolve();
    }

    @PluginMethod
    public void syncCarData(PluginCall call) {
        String activeRouteJson = call.getString("activeRouteJson");
        String savedRoutesJson = call.getString("savedRoutesJson");
        String userPoisJson = call.getString("userPoisJson");
        String carStateJson = call.getString("carStateJson");

        NativeMapStore store = NativeMapStore.getInstance(getContext());
        try {
            store.syncCarData(activeRouteJson, savedRoutesJson, userPoisJson, carStateJson);
            call.resolve();
        } catch (Exception ex) {
            call.reject("Car sync failed: " + ex.getMessage());
        }
    }

    @PluginMethod
    public void getCarSyncState(PluginCall call) {
        NativeMapStore store = NativeMapStore.getInstance(getContext());
        JSObject out = new JSObject();
        out.put("hasActiveRoute", store.loadActiveRoute() != null);
        out.put("savedRoutesCount", store.loadSavedRoutes().size());
        out.put("userPoisCount", store.countUserPois());
        out.put("hasCarState", true);
        call.resolve(out);
    }

    private void emitDownloadProgress(String fileName, long loaded, long total) {
        JSObject data = new JSObject();
        data.put("fileName", fileName);
        data.put("loaded", loaded);
        data.put("total", total);
        notifyListeners("downloadProgress", data);
    }

    private static JSObject buildFileStatus(NativeMapStore store, String fileName) {
        File file = store.getMapFile(fileName);
        boolean exists = file != null && file.exists() && file.isFile();
        boolean valid = NativeMapStore.isValidPmTiles(file);
        JSObject item = new JSObject();
        item.put("exists", exists);
        item.put("valid", valid);
        item.put("sizeBytes", exists ? file.length() : 0L);
        item.put("lastModifiedMs", exists ? file.lastModified() : 0L);
        item.put("nativeUrl", NativeMapStore.nativeUrlFor(fileName));
        item.put("localPath", file != null ? file.getAbsolutePath() : "");
        item.put("downloading", store.isDownloadActive(fileName));
        return item;
    }

    private static void replaceFileAtomic(File src, File dst) throws IOException {
        if (dst.exists() && !dst.delete()) {
            throw new IOException("Failed deleting old file " + dst.getName());
        }
        if (!src.renameTo(dst)) {
            throw new IOException("Failed moving file to " + dst.getAbsolutePath());
        }
    }
}
