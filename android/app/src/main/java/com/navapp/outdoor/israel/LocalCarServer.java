package com.navapp.outdoor.israel;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * In-process 127.0.0.1 HTTP loopback server powering 100% offline SDF PBF glyph rendering
 * for MapLibre Native on Android Auto (Hebrew, English, digits, elevation contour labels,
 * mountain peak triangles) and Range-enabled local map serving.
 */
public final class LocalCarServer {
    private static final String TAG = "LocalCarServer";
    private static final Pattern GLYPH_PATH_PATTERN =
        Pattern.compile("^/glyphs/([^/]+)/(\\d+)-(\\d+)\\.pbf$");
    private static final Pattern MAP_PATH_PATTERN =
        Pattern.compile("^/maps/([A-Za-z0-9._-]+)$");

    private static volatile LocalCarServer instance;

    private final NativeMapStore store;
    private final Map<String, byte[]> glyphRangeCache = new ConcurrentHashMap<>();
    private final ExecutorService clientExecutor = Executors.newCachedThreadPool();

    private volatile ServerSocket serverSocket;
    private volatile int port = -1;
    private volatile boolean started = false;

    private LocalCarServer(Context context) {
        this.store = NativeMapStore.getInstance(context);
    }

    public static LocalCarServer getInstance(Context context) {
        if (instance == null) {
            synchronized (LocalCarServer.class) {
                if (instance == null) {
                    instance = new LocalCarServer(context);
                }
            }
        }
        return instance;
    }

    public synchronized int ensureStarted() {
        if (started && serverSocket != null && !serverSocket.isClosed() && port > 0) {
            return port;
        }
        try {
            ServerSocket sock = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
            this.serverSocket = sock;
            this.port = sock.getLocalPort();
            this.started = true;

            Thread acceptThread = new Thread(
                () -> acceptLoop(sock),
                "NavApp-LocalCarServer"
            );
            acceptThread.setDaemon(true);
            acceptThread.start();
            Log.i(TAG, "LocalCarServer listening on http://127.0.0.1:" + this.port);
        } catch (IOException ex) {
            Log.e(TAG, "Failed starting LocalCarServer", ex);
        }
        return this.port;
    }

    public String getGlyphsTemplateUrl() {
        int activePort = ensureStarted();
        return "http://127.0.0.1:" + activePort + "/glyphs/{fontstack}/{range}.pbf";
    }

    private void acceptLoop(ServerSocket sock) {
        while (started && !sock.isClosed()) {
            try {
                Socket client = sock.accept();
                clientExecutor.execute(() -> handleClient(client));
            } catch (IOException ex) {
                if (started && !sock.isClosed()) {
                    Log.w(TAG, "Accept warning: " + ex.getMessage());
                }
                break;
            }
        }
    }

    private void handleClient(Socket socket) {
        try (Socket sock = socket) {
            sock.setSoTimeout(15000);
            BufferedInputStream in = new BufferedInputStream(sock.getInputStream(), 4096);
            OutputStream out = sock.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] reqParts = requestLine.split(" ");
            if (reqParts.length < 2) {
                writeSimpleResponse(out, 400, "Bad Request", "text/plain", new byte[0]);
                return;
            }
            String method = reqParts[0].toUpperCase(Locale.ROOT);
            String rawTarget = reqParts[1];
            int qIdx = rawTarget.indexOf('?');
            String path = qIdx >= 0 ? rawTarget.substring(0, qIdx) : rawTarget;

            String rangeHeader = null;
            String headerLine;
            while ((headerLine = readLine(in)) != null && !headerLine.isEmpty()) {
                int colon = headerLine.indexOf(':');
                if (colon > 0) {
                    String name = headerLine.substring(0, colon).trim();
                    if ("Range".equalsIgnoreCase(name)) {
                        rangeHeader = headerLine.substring(colon + 1).trim();
                    }
                }
            }

            if ("OPTIONS".equals(method)) {
                String headers =
                    "HTTP/1.1 204 No Content\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
                    "Access-Control-Allow-Headers: Range\r\n" +
                    "Connection: close\r\n\r\n";
                out.write(headers.getBytes(StandardCharsets.US_ASCII));
                out.flush();
                return;
            }

            Matcher glyphMatcher = GLYPH_PATH_PATTERN.matcher(path);
            if (glyphMatcher.matches()) {
                String fontstack = URLDecoder.decode(glyphMatcher.group(1), StandardCharsets.UTF_8.name());
                int start = Integer.parseInt(glyphMatcher.group(2));
                int end = Integer.parseInt(glyphMatcher.group(3));
                byte[] pbf = buildGlyphRangePbf(fontstack, start, end);
                if ("HEAD".equals(method)) {
                    writeHeadResponse(out, 200, "OK", "application/x-protobuf", pbf.length);
                } else {
                    writeSimpleResponse(out, 200, "OK", "application/x-protobuf", pbf);
                }
                return;
            }

            Matcher mapMatcher = MAP_PATH_PATTERN.matcher(path);
            if (mapMatcher.matches()) {
                String fileName = mapMatcher.group(1);
                java.io.File file = store.getValidMapFile(fileName);
                if (file == null) {
                    writeSimpleResponse(out, 404, "Not Found", "text/plain", new byte[0]);
                    return;
                }
                serveMapFile(out, method, file, rangeHeader);
                return;
            }

            writeSimpleResponse(out, 404, "Not Found", "text/plain", new byte[0]);
        } catch (Exception ex) {
            Log.d(TAG, "Client handler note: " + ex.getMessage());
        }
    }

    private static void serveMapFile(
        OutputStream out,
        String method,
        java.io.File file,
        String rangeHeader
    ) throws IOException {
        long total = file.length();
        String etag = "\"" + total + "-" + file.lastModified() + "\"";

        if ("HEAD".equals(method)) {
            String resp =
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: application/octet-stream\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Content-Length: " + total + "\r\n" +
                "ETag: " + etag + "\r\n" +
                "Connection: close\r\n\r\n";
            out.write(resp.getBytes(StandardCharsets.US_ASCII));
            out.flush();
            return;
        }

        if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
            String spec = rangeHeader.substring(6).trim();
            int dash = spec.indexOf('-');
            if (dash < 0) {
                writeRangeNotSatisfiable(out, total);
                return;
            }
            String sPart = spec.substring(0, dash).trim();
            String ePart = spec.substring(dash + 1).trim();
            long start = sPart.isEmpty() ? 0L : Long.parseLong(sPart);
            long end = ePart.isEmpty() ? (total - 1L) : Math.min(Long.parseLong(ePart), total - 1L);
            if (start < 0 || start >= total || start > end) {
                writeRangeNotSatisfiable(out, total);
                return;
            }
            long len = end - start + 1L;
            String resp =
                "HTTP/1.1 206 Partial Content\r\n" +
                "Content-Type: application/octet-stream\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Content-Range: bytes " + start + "-" + end + "/" + total + "\r\n" +
                "Content-Length: " + len + "\r\n" +
                "ETag: " + etag + "\r\n" +
                "Connection: close\r\n\r\n";
            out.write(resp.getBytes(StandardCharsets.US_ASCII));

            try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
                raf.seek(start);
                byte[] buf = new byte[32768];
                long remaining = len;
                while (remaining > 0) {
                    int toRead = (int) Math.min(buf.length, remaining);
                    int n = raf.read(buf, 0, toRead);
                    if (n <= 0) break;
                    out.write(buf, 0, n);
                    remaining -= n;
                }
            }
            out.flush();
            return;
        }

        String resp =
            "HTTP/1.1 200 OK\r\n" +
            "Content-Type: application/octet-stream\r\n" +
            "Accept-Ranges: bytes\r\n" +
            "Content-Length: " + total + "\r\n" +
            "ETag: " + etag + "\r\n" +
            "Connection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
            byte[] buf = new byte[32768];
            int n;
            while ((n = fis.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
        out.flush();
    }

    private static void writeRangeNotSatisfiable(OutputStream out, long total) throws IOException {
        String resp =
            "HTTP/1.1 416 Range Not Satisfiable\r\n" +
            "Content-Range: bytes */" + total + "\r\n" +
            "Content-Length: 0\r\n" +
            "Connection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private static void writeHeadResponse(
        OutputStream out,
        int code,
        String reason,
        String contentType,
        int contentLength
    ) throws IOException {
        String resp =
            "HTTP/1.1 " + code + " " + reason + "\r\n" +
            "Content-Type: " + contentType + "\r\n" +
            "Content-Length: " + contentLength + "\r\n" +
            "Cache-Control: public, max-age=86400\r\n" +
            "Connection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private static void writeSimpleResponse(
        OutputStream out,
        int code,
        String reason,
        String contentType,
        byte[] body
    ) throws IOException {
        String resp =
            "HTTP/1.1 " + code + " " + reason + "\r\n" +
            "Content-Type: " + contentType + "\r\n" +
            "Content-Length: " + body.length + "\r\n" +
            "Cache-Control: public, max-age=86400\r\n" +
            "Connection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        if (body.length > 0) {
            out.write(body);
        }
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(128);
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') bos.write(b);
            if (bos.size() > 8192) break;
        }
        if (b == -1 && bos.size() == 0) return null;
        return bos.toString(StandardCharsets.US_ASCII.name());
    }

    // ---- Offline SDF Glyph PBF Generator (Mapbox/MapLibre glyphs v1 protobuf) ----

    public byte[] buildGlyphRangePbf(String fontstack, int startCode, int endCode) {
        boolean isBold = fontstack != null && fontstack.toLowerCase(Locale.ROOT).contains("bold");
        String cacheKey = (isBold ? "B:" : "R:") + startCode + "-" + endCode;
        byte[] cached = glyphRangeCache.get(cacheKey);
        if (cached != null) return cached;

        ByteArrayOutputStream stackMsg = new ByteArrayOutputStream(8192);
        writeStringField(stackMsg, 1, fontstack != null ? fontstack : "Arial,Tahoma,sans-serif");
        writeStringField(stackMsg, 2, startCode + "-" + endCode);

        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setTextSize(24f);
        paint.setColor(Color.WHITE);
        paint.setTypeface(
            isBold ? Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) : Typeface.SANS_SERIF
        );

        Bitmap bitmap = Bitmap.createBitmap(44, 44, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        int[] pixels = new int[44 * 44];

        for (int code = startCode; code <= endCode; code++) {
            byte[] glyphMsg = renderCharToSdfGlyph(code, paint, bitmap, canvas, pixels);
            if (glyphMsg != null) {
                writeBytesField(stackMsg, 3, glyphMsg);
            }
        }
        bitmap.recycle();

        ByteArrayOutputStream rootMsg = new ByteArrayOutputStream(stackMsg.size() + 16);
        writeBytesField(rootMsg, 1, stackMsg.toByteArray());
        byte[] out = rootMsg.toByteArray();
        glyphRangeCache.put(cacheKey, out);
        return out;
    }

    private static boolean isSupportedCodePoint(int c) {
        return (c >= 32 && c <= 126) ||      // Basic ASCII
            (c >= 160 && c <= 255) ||        // Latin-1 symbols & degree/nbps
            (c >= 1425 && c <= 1524) ||      // Hebrew letters + Gershayim/Geresh/Maqaf
            (c >= 8208 && c <= 8230) ||      // En-dash, Em-dash, quotes, bullet, ellipsis
            c == 9650;                       // ▲ peak marker
    }

    private static byte[] renderCharToSdfGlyph(
        int charCode,
        Paint paint,
        Bitmap bitmap,
        Canvas canvas,
        int[] pixels
    ) {
        if (!isSupportedCodePoint(charCode)) return null;

        String ch = new String(Character.toChars(charCode));
        float measured = paint.measureText(ch);
        int advance = Math.max(6, (int) Math.ceil(measured) + 1);

        if (charCode == 32) {
            ByteArrayOutputStream msg = new ByteArrayOutputStream(24);
            writeTag(msg, 1, 0);
            writeVarint(msg, charCode);
            writeTag(msg, 3, 0);
            writeVarint(msg, 0);
            writeTag(msg, 4, 0);
            writeVarint(msg, 0);
            writeTag(msg, 5, 0);
            writeSVarint(msg, 0);
            writeTag(msg, 6, 0);
            writeSVarint(msg, 0);
            writeTag(msg, 7, 0);
            writeVarint(msg, advance);
            return msg.toByteArray();
        }

        final int border = 3;
        final int glyphW = Math.min(34, Math.max(8, (int) Math.ceil(measured) + 2));
        final int glyphH = 26;
        final int outW = glyphW + border * 2;
        final int outH = glyphH + border * 2;

        bitmap.eraseColor(Color.TRANSPARENT);
        canvas.drawText(ch, border + 1f, border + 20f, paint);
        bitmap.getPixels(pixels, 0, outW, 0, 0, outW, outH);

        byte[] inside = new byte[outW * outH];
        for (int i = 0; i < outW * outH; i++) {
            int alpha = (pixels[i] >>> 24) & 0xFF;
            inside[i] = alpha > 96 ? (byte) 1 : (byte) 0;
        }

        byte[] sdf = new byte[outW * outH];
        final int maxRadius = 4;
        for (int y = 0; y < outH; y++) {
            for (int x = 0; x < outW; x++) {
                int idx = y * outW + x;
                byte isIn = inside[idx];
                int minDistSq = maxRadius * maxRadius;

                for (int dy = -maxRadius; dy <= maxRadius; dy++) {
                    int ny = y + dy;
                    if (ny < 0 || ny >= outH) continue;
                    int rowOffset = ny * outW;
                    for (int dx = -maxRadius; dx <= maxRadius; dx++) {
                        int nx = x + dx;
                        if (nx < 0 || nx >= outW) continue;
                        if (inside[rowOffset + nx] != isIn) {
                            int dSq = dx * dx + dy * dy;
                            if (dSq < minDistSq) minDistSq = dSq;
                        }
                    }
                }

                double dist = Math.sqrt(minDistSq);
                double signed = isIn != 0 ? dist : -dist;
                int val = (int) Math.round(192.0 + (signed / maxRadius) * 63.0);
                if (val < 0) val = 0;
                if (val > 255) val = 255;
                sdf[idx] = (byte) val;
            }
        }

        ByteArrayOutputStream glyphMsg = new ByteArrayOutputStream(sdf.length + 32);
        writeTag(glyphMsg, 1, 0);
        writeVarint(glyphMsg, charCode);
        writeBytesField(glyphMsg, 2, sdf);
        writeTag(glyphMsg, 3, 0);
        writeVarint(glyphMsg, glyphW);
        writeTag(glyphMsg, 4, 0);
        writeVarint(glyphMsg, glyphH);
        writeTag(glyphMsg, 5, 0);
        writeSVarint(glyphMsg, 0);
        writeTag(glyphMsg, 6, 0);
        writeSVarint(glyphMsg, 10);
        writeTag(glyphMsg, 7, 0);
        writeVarint(glyphMsg, advance);
        return glyphMsg.toByteArray();
    }

    private static void writeVarint(ByteArrayOutputStream out, long value) {
        long v = value & 0xFFFFFFFFL;
        while (v >= 0x80L) {
            out.write((int) ((v & 0x7FL) | 0x80L));
            v >>>= 7;
        }
        out.write((int) v);
    }

    private static void writeSVarint(ByteArrayOutputStream out, int value) {
        int zigzag = (value << 1) ^ (value >> 31);
        writeVarint(out, zigzag);
    }

    private static void writeTag(ByteArrayOutputStream out, int fieldNumber, int wireType) {
        writeVarint(out, ((long) fieldNumber << 3) | wireType);
    }

    private static void writeBytesField(ByteArrayOutputStream out, int fieldNumber, byte[] payload) {
        writeTag(out, fieldNumber, 2);
        writeVarint(out, payload.length);
        out.write(payload, 0, payload.length);
    }

    private static void writeStringField(ByteArrayOutputStream out, int fieldNumber, String str) {
        byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
        writeBytesField(out, fieldNumber, bytes);
    }
}
