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
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Custom Capacitor BridgeWebViewClient that intercepts 64-bit HTTP Byte-Range requests to
 * `https://localhost/__native_maps__/{fileName}` directly over RandomAccessFile in
 * `filesDir/maps/` and same-origin `/__remote_proxy__/{fileName}` streams for Firebase Storage
 * ranges (bypassing WebView CORS restrictions on `https://localhost`).
 */
public class NavAppWebViewClient extends BridgeWebViewClient {
    private static final String TAG = "NavAppWebViewClient";
    private static final String NATIVE_MAPS_PREFIX = "/__native_maps__/";
    private static final String REMOTE_PROXY_PREFIX = "/__remote_proxy__/";

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
        if (path.startsWith(REMOTE_PROXY_PREFIX)) {
            return handleRemoteProxyRequest(uri, request);
        }
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

        String xRangeHeader = findHeaderIgnoreCase(request.getRequestHeaders(), "X-NavApp-Range");
        boolean useXRange = xRangeHeader != null && !xRangeHeader.trim().isEmpty();
        String rangeHeader = useXRange
            ? xRangeHeader.trim()
            : findHeaderIgnoreCase(request.getRequestHeaders(), "Range");

        if (rangeHeader != null && rangeHeader.toLowerCase(Locale.ROOT).startsWith("bytes=")) {
            long[] parsedRange = parseByteRange(rangeHeader, totalSize);
            if (parsedRange == null) {
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
            long start = parsedRange[0];
            long end = parsedRange[1];
            long len = end - start + 1L;
            baseHeaders.put("Content-Range", "bytes " + start + "-" + end + "/" + totalSize);
            if (useXRange) {
                baseHeaders.put("Vary", "X-NavApp-Range");
                baseHeaders.put(
                    "Access-Control-Allow-Headers",
                    "Range, X-NavApp-Range, If-Match, If-None-Match, Content-Type"
                );
            }

            try {
                // When incoming request carried HTTP Range directly, Chromium's AndroidStreamReaderURLLoader
                // calls skip(start) on our already-seeked InputStream; absorb that duplicate skip cleanly.
                long chromiumPreSkip = (!useXRange && start > 0L) ? start : 0L;
                InputStream sliceStream =
                    new BoundedRandomAccessInputStream(file, start, len, chromiumPreSkip);
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

        String mimeType =
            safeFileName.toLowerCase(Locale.ROOT).endsWith(".geojson")
                ? "application/json; charset=utf-8"
                : "application/octet-stream";
        try {
            InputStream fullStream = new BoundedRandomAccessInputStream(file, 0L, totalSize, 0L);
            return new WebResourceResponse(
                mimeType,
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

    /** Parses `bytes=start-end` against known `totalSize`, returning `[start, end]` or `null` if 416. */
    static long[] parseByteRange(String rangeHeader, long totalSize) {
        if (rangeHeader == null || totalSize <= 0L) return null;
        if (!rangeHeader.toLowerCase(Locale.ROOT).startsWith("bytes=")) return null;
        String spec = rangeHeader.substring(6).trim();
        int commaIdx = spec.indexOf(',');
        if (commaIdx > 0) {
            spec = spec.substring(0, commaIdx).trim();
        }
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
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
            return null;
        }
        if (start < 0L || start >= totalSize || start > end) return null;
        return new long[] { start, end };
    }

    /** Extracts the numeric start byte offset from an explicit `bytes=start-...` header, or 0. */
    static long parseRangeStartOffset(String rangeHeader) {
        if (rangeHeader == null) return 0L;
        if (!rangeHeader.toLowerCase(Locale.ROOT).startsWith("bytes=")) return 0L;
        String spec = rangeHeader.substring(6).trim();
        int commaIdx = spec.indexOf(',');
        if (commaIdx > 0) {
            spec = spec.substring(0, commaIdx).trim();
        }
        int dash = spec.indexOf('-');
        if (dash <= 0) return 0L;
        try {
            long start = Long.parseLong(spec.substring(0, dash).trim());
            return Math.max(0L, start);
        } catch (NumberFormatException ex) {
            return 0L;
        }
    }

    private static WebResourceResponse handleRemoteProxyRequest(
        Uri uri,
        WebResourceRequest request
    ) {
        String rawFileName = uri.getPath().substring(REMOTE_PROXY_PREFIX.length());
        String safeFileName = NativeMapStore.sanitizeFileName(rawFileName);
        String targetUrl = NativeMapStore.resolveAllowedRemoteProxyUrl(
            safeFileName,
            uri.getQueryParameter("url")
        );
        if (targetUrl == null) {
            return emptyErrorResponse(403, "Forbidden");
        }

        Map<String, String> corsHeaders = new HashMap<>();
        corsHeaders.put("Access-Control-Allow-Origin", "*");
        corsHeaders.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        corsHeaders.put(
            "Access-Control-Allow-Headers",
            "Range, X-NavApp-Range, If-Match, If-None-Match, Content-Type"
        );
        corsHeaders.put(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Range, Content-Length, ETag, Content-Type, Last-Modified"
        );

        String method =
            request.getMethod() != null ? request.getMethod().toUpperCase(Locale.ROOT) : "GET";
        if ("OPTIONS".equals(method)) {
            return new WebResourceResponse(
                "application/octet-stream",
                null,
                204,
                "No Content",
                corsHeaders,
                new ByteArrayInputStream(new byte[0])
            );
        }
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            return emptyErrorResponse(405, "Method Not Allowed");
        }

        HttpURLConnection conn = null;
        boolean streamOwned = false;
        try {
            URL url = new URL(targetUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept-Encoding", "identity");

            String xRangeHeader = findHeaderIgnoreCase(request.getRequestHeaders(), "X-NavApp-Range");
            boolean useXRange = xRangeHeader != null && !xRangeHeader.trim().isEmpty();
            String rangeHeader = useXRange
                ? xRangeHeader.trim()
                : findHeaderIgnoreCase(request.getRequestHeaders(), "Range");
            if (rangeHeader != null && !rangeHeader.isEmpty()) {
                conn.setRequestProperty("Range", rangeHeader);
            }
            String ifMatch = findHeaderIgnoreCase(request.getRequestHeaders(), "If-Match");
            if (ifMatch != null && !ifMatch.isEmpty()) {
                conn.setRequestProperty("If-Match", ifMatch);
            }

            conn.connect();
            int status = conn.getResponseCode();
            String reason = conn.getResponseMessage();
            if (reason == null || reason.trim().isEmpty()) {
                reason = status == 206 ? "Partial Content" : "OK";
            }

            Map<String, String> respHeaders = new HashMap<>(corsHeaders);
            copyHeaderIfPresent(conn, respHeaders, "Content-Range");
            copyHeaderIfPresent(conn, respHeaders, "Content-Length");
            copyHeaderIfPresent(conn, respHeaders, "ETag");
            copyHeaderIfPresent(conn, respHeaders, "Last-Modified");
            copyHeaderIfPresent(conn, respHeaders, "Cache-Control");
            if (useXRange) {
                // X-NavApp-Range varies the payload without appearing in HTTP Range, so disable WebView HTTP caching for it
                respHeaders.put("Cache-Control", "no-store");
                respHeaders.put("Vary", "X-NavApp-Range");
            }
            respHeaders.put("Accept-Ranges", "bytes");

            String rawCt = conn.getContentType();
            String mimeType = "application/octet-stream";
            String encoding = null;
            if (rawCt != null && !rawCt.trim().isEmpty()) {
                String[] parts = rawCt.split(";");
                if (parts[0] != null && !parts[0].trim().isEmpty()) {
                    mimeType = parts[0].trim();
                }
                for (int i = 1; i < parts.length; i++) {
                    String p = parts[i].trim();
                    if (p.toLowerCase(Locale.ROOT).startsWith("charset=")) {
                        String enc = p.substring(8).trim();
                        if (!enc.isEmpty()) {
                            encoding = enc;
                        }
                    }
                }
            }

            if ("HEAD".equals(method) || status == 204 || status == 304 || status >= 400) {
                conn.disconnect();
                return new WebResourceResponse(
                    mimeType,
                    encoding,
                    status,
                    reason,
                    respHeaders,
                    new ByteArrayInputStream(new byte[0])
                );
            }

            long requestedStart =
                (!useXRange && status == 206) ? parseRangeStartOffset(rangeHeader) : 0L;
            InputStream bodyStream =
                new ProxiedHttpInputStream(conn, conn.getInputStream(), requestedStart);
            streamOwned = true;
            return new WebResourceResponse(
                mimeType,
                encoding,
                status,
                reason,
                respHeaders,
                bodyStream
            );
        } catch (IOException ex) {
            Log.w(TAG, "Remote proxy failed for " + targetUrl, ex);
            return emptyErrorResponse(502, "Bad Gateway");
        } finally {
            if (!streamOwned && conn != null) {
                conn.disconnect();
            }
        }
    }

    private static void copyHeaderIfPresent(
        HttpURLConnection conn,
        Map<String, String> dst,
        String headerName
    ) {
        String value = conn.getHeaderField(headerName);
        if (value != null && !value.trim().isEmpty()) {
            dst.put(headerName, value.trim());
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
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse(
            "application/octet-stream",
            null,
            code,
            reason,
            headers,
            new ByteArrayInputStream(new byte[0])
        );
    }

    private static final class ProxiedHttpInputStream extends InputStream {
        private final HttpURLConnection conn;
        private final InputStream delegate;
        private long pendingChromiumSkip;

        ProxiedHttpInputStream(
            HttpURLConnection conn,
            InputStream delegate,
            long pendingChromiumSkip
        ) {
            this.conn = conn;
            this.delegate = delegate;
            this.pendingChromiumSkip = Math.max(0L, pendingChromiumSkip);
        }

        @Override
        public int available() throws IOException {
            return delegate.available();
        }

        @Override
        public long skip(long n) throws IOException {
            if (n <= 0L) return 0L;
            if (pendingChromiumSkip > 0L) {
                long absorbed = Math.min(n, pendingChromiumSkip);
                pendingChromiumSkip -= absorbed;
                long rem = n - absorbed;
                if (rem <= 0L) return absorbed;
                return absorbed + delegate.skip(rem);
            }
            return delegate.skip(n);
        }

        @Override
        public int read() throws IOException {
            return delegate.read();
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            return delegate.read(b, off, len);
        }

        @Override
        public void close() throws IOException {
            try {
                delegate.close();
            } finally {
                conn.disconnect();
            }
        }
    }

    private static final class BoundedRandomAccessInputStream extends InputStream {
        private final RandomAccessFile raf;
        private long remaining;
        private long pendingChromiumSkip;

        BoundedRandomAccessInputStream(
            File file,
            long startOffset,
            long length,
            long pendingChromiumSkip
        ) throws IOException {
            this.raf = new RandomAccessFile(file, "r");
            try {
                this.raf.seek(startOffset);
                this.remaining = length;
                this.pendingChromiumSkip = Math.max(0L, pendingChromiumSkip);
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
        public long skip(long n) throws IOException {
            if (n <= 0L) return 0L;
            if (pendingChromiumSkip > 0L) {
                long absorbed = Math.min(n, pendingChromiumSkip);
                pendingChromiumSkip -= absorbed;
                long rem = n - absorbed;
                if (rem <= 0L) return absorbed;
                long extra = Math.min(rem, remaining);
                raf.seek(raf.getFilePointer() + extra);
                remaining -= extra;
                return absorbed + extra;
            }
            long count = Math.min(n, remaining);
            raf.seek(raf.getFilePointer() + count);
            remaining -= count;
            return count;
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
