import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Custom Vite plugin that serves files from C:\dev\NavApp\data\* at /data/*
 * with full HTTP 206 Partial Content (Range: bytes=start-end) support.
 * This allows MapLibre + PMTiles to stream 1.40 GB Israel.dem.pmtiles and
 * 112 MB Israel.osm.pmtiles directly from the local data/ directory with <10 MB RAM.
 */
function pmtilesDataRangePlugin(): Plugin {
  const dataDir = path.resolve(__dirname, 'data');

  const serveDataMiddleware = (req: any, res: any, next: () => void) => {
    if (!req.url || !req.url.startsWith('/data/')) {
      return next();
    }

    const urlObj = new URL(req.url, 'http://localhost');
    const relPath = decodeURIComponent(urlObj.pathname.replace(/^\/data\//, ''));
    const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(dataDir, safePath);

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `File not found in data/: ${safePath}` }));
      return;
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === '.geojson' || ext === '.json'
        ? 'application/json; charset=utf-8'
        : 'application/octet-stream';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, If-Match, Content-Type');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified'
    );
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', `"${stat.size}-${stat.mtimeMs}"`);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', totalSize);
      res.end();
      return;
    }

    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.end();
        return;
      }

      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? Math.min(parseInt(match[2], 10), totalSize - 1) : totalSize - 1;

      if (start >= totalSize || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        res.end();
        return;
      }

      const chunkLength = end - start + 1;
      res.statusCode = 206;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', chunkLength);

      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => res.end());
      stream.pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', totalSize);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.end());
    stream.pipe(res);
  };

  return {
    name: 'vite-plugin-pmtiles-data-range',
    configureServer(server) {
      server.middlewares.use(serveDataMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveDataMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), pmtilesDataRangePlugin()],
  resolve: {
    alias: {
      'maplibre-contour': path.resolve(
        __dirname,
        'node_modules/maplibre-contour/dist/index.mjs'
      ),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
});
