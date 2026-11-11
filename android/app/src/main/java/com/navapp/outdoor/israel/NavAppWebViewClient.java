package com.navapp.outdoor.israel;

import android.content.Context;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Custom Capacitor BridgeWebViewClient that intercepts 64-bit HTTP Byte-Range requests to
 * `https://localhost/__native_maps__/{fileName}` directly over RandomAccessFile in
 * `filesDir/maps/`, allowing multi-GB PMTiles archives (like the 1.40 GB DEM) to stream
 * inside Android WebView while sharing the exact single file copy with Android Auto.
 */
public class NavAppWebViewClient extends BridgeWebViewClient {
    private static final String TAG = "NavAppWebViewClient";
    private static final String NATIVE_MAPS_PREFIX = "/__native_maps__/";

    private final Context appContext;

    public NavAppWebViewClient(Bridge bridge, Context context) {
        super(bridge);
        this.appContext = context.getApplicationContext();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse intercepted = maybeInterceptNativeMapRequest(appContext, request);
        if (intercepted != null) {
            return intercepted;
        }
        return super.shouldInterceptRequest(view, request);
    }

    public static WebResourceResponse maybeInterceptNativeMapRequest(
        Context context,
        WebResourceRequest request
    ) {
        if (request == null || request.getUrl() == null) return null;
        Uri uri = request.getUrl();
        String host = uri.getHost();
        String path = uri.getPath();
        if (host == null || path == null) return null;
        if (!"localhost".equalsIgnoreCase(host) && !"127.0.0.1".equals(host)) return null;
        if (!path.startsWith(NATIVE_MAPS_PREFIX)) return null;

        String rawFileName = path.substring(NATIVE_MAPS_PREFIX.length());
        String safeFileName = NativeMapStore.sanitizeFileName(rawFileName);
        if (safeFileName == null) {
            return emptyErrorResponse(404, "Not Found");
        }

        NativeMapStore store = NativeMapStore.getInstance(context);
        File file = store.getValidMapFile(safeFileName);
        if (file == null) {
            return emptyErrorResponse(404, "Not Found");
        }

        long totalSize = file.length();
        String etag = "\"" + totalSize + "-" + file.lastModified() + "\"";
        Map<String, String> baseHeaders = new HashMap<>();
        baseHeaders.put("Accept-Ranges", "bytes");
        baseHeaders.put("Cache-Control", "no-store");
        baseHeaders.put("ETag", etag);
        baseHeaders.put("Access-Control-Allow-Origin", "*");
        baseHeaders.put("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, ETag");

        String method = request.getMethod() != null ? request.getMethod().toUpperCase(Locale.ROOT) : "GET";
        if ("OPTIONS".equals(method)) {
            return new WebResourceResponse(
                "application/octet-stream",
                null,
                204,
                "No Content",
                baseHeaders,
                new ByteArrayInputStream(new byte[0])
            );
        }

        if ("HEAD".equals(method)) {
            baseHeaders.put("Content-Length", Long.toString(totalSize));
            return new WebResourceResponse(
                "application/octet-stream",
                null,
                200,
                "OK",
                baseHeaders,
                new ByteArrayInputStream(new byte[0])
            );
        }

        String rangeHeader = findHeaderIgnoreCase(request.getRequestHeaders(), "Range");
        if (rangeHeader != null && rangeHeader.toLowerCase(Locale.ROOT).startsWith("bytes=")) {
            String spec = rangeHeader.substring(6).trim();
            int commaIdx = spec.indexOf(',');
            if (commaIdx > 0) {
                spec = spec.substring(0, commaIdx).trim();
            }
            int dash = spec.indexOf('-');
            if (dash < 0) {
                baseHeaders.put("Content-Range", "bytes */" + totalSize);
                return new WebResourceResponse(
                    "application/octet-stream",
                    null,
                    416,
                    "Range Not Satisfiable",
                    baseHeaders,
                    new ByteArrayInputStream(new byte[0])
                );
            }

            long start;
            long end;
            try {
                String sPart = spec.substring(0, dash).trim();
                String ePart = spec.substring(dash + 1).trim();
                if (sPart.isEmpty()) {
                    long suffix = Long.parseLong(ePart);
                    start = Math.max(0L, totalSize - suffix);
                    end = totalSize - 1L;
                } else {
                    start = Long.parseLong(sPart);
                    end = ePart.isEmpty() ? (totalSize - 1L) : Math.min(Long.parseLong(ePart), totalSize - 1L);
                }
            } catch (NumberFormatException ex) {
                baseHeaders.put("Content-Range", "bytes */" + totalSize);
                return new WebResourceResponse(
                    "application/octet-stream",
                    null,
                    416,
                    "Range Not Satisfiable",
                    baseHeaders,
                    new ByteArrayInputStream(new byte[0])
                );
            }

            if (start < 0L || start >= totalSize || start > end) {
                baseHeaders.put("Content-Range", "bytes */" + totalSize);
                return new WebResourceResponse(
                    "application/octet-stream",
                    null,
                    416,
                    "Range Not Satisfiable",
                    baseHeaders,
                    new ByteArrayInputStream(new byte[0])
                );
            }

            long len = end - start + 1L;
            baseHeaders.put("Content-Range", "bytes " + start + "-" + end + "/" + totalSize);
            baseHeaders.put("Content-Length", Long.toString(len));

            try {
                InputStream sliceStream = new BoundedRandomAccessInputStream(file, start, len);
                return new WebResourceResponse(
                    "application/octet-stream",
                    null,
                    206,
                    "Partial Content",
                    baseHeaders,
                    sliceStream
                );
            } catch (IOException ex) {
                Log.w(TAG, "Failed opening range stream for " + safeFileName, ex);
                return emptyErrorResponse(500, "Internal Server Error");
            }
        }

        baseHeaders.put("Content-Length", Long.toString(totalSize));
        try {
            InputStream fullStream = new BoundedRandomAccessInputStream(file, 0L, totalSize);
            return new WebResourceResponse(
                "application/octet-stream",
                null,
                200,
                "OK",
                baseHeaders,
                fullStream
            );
        } catch (IOException ex) {
            Log.w(TAG, "Failed opening full stream for " + safeFileName, ex);
            return emptyErrorResponse(500, "Internal Server Error");
        }
    }

    private static String findHeaderIgnoreCase(Map<String, String> headers, String target) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (target.equalsIgnoreCase(entry.getKey())) {
                return entry.getValue();
            }
        }
        return null;
    }

    private static WebResourceResponse emptyErrorResponse(int code, String reason) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(
            "application/octet-stream",
            null,
            code,
            reason,
            headers,
            new ByteArrayInputStream(new byte[0])
        );
    }

    private static final class BoundedRandomAccessInputStream extends InputStream {
        private final RandomAccessFile raf;
        private long remaining;

        BoundedRandomAccessInputStream(File file, long startOffset, long length) throws IOException {
            this.raf = new RandomAccessFile(file, "r");
            try {
                this.raf.seek(startOffset);
                this.remaining = length;
            } catch (IOException ex) {
                this.raf.close();
                throw ex;
            }
        }

        @Override
        public int available() {
            return (int) Math.min(Integer.MAX_VALUE, Math.max(0L, remaining));
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0L) return -1;
            int b = raf.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            if (remaining <= 0L) return -1;
            int toRead = (int) Math.min(len, remaining);
            int n = raf.read(b, off, toRead);
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public void close() throws IOException {
            raf.close();
        }
    }
}
