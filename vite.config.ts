import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';

function buildAppVersionString(): string {
  let baseVersion = '1.0.0';
  try {
    const pkgPath = path.resolve(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    if (pkg.version && pkg.version.trim()) {
      baseVersion = pkg.version.trim();
    }
  } catch {
    // Keep default fallback base version
  }
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${baseVersion}.${yyyy}${mm}${dd}-${hh}${min}`;
}

const APP_VERSION = buildAppVersionString();

/**
 * Custom Vite plugin that serves files from C:\dev\NavApp\data\* at /data/*
 * with full HTTP 206 Partial Content (Range: bytes=start-end) support.
 * This allows MapLibre + PMTiles to stream 1.40 GB Israel.dem.pmtiles and
 * 112 MB Israel.osm.pmtiles directly from the local data/ directory with <10 MB RAM.
 */
function pmtilesDataRangePlugin(): Plugin {
  const dataDir = path.resolve(__dirname, 'data');
  const publicDir = path.resolve(__dirname, 'src', 'public');
  const distDir = path.resolve(__dirname, 'dist');

  const serveDataMiddleware = (req: any, res: any, next: () => void) => {
    if (!req.url) {
      return next();
    }

    const urlObj = new URL(req.url, 'http://localhost');
    let filePath: string | null = null;
    let relLabel = urlObj.pathname;

    if (urlObj.pathname.startsWith('/data/')) {
      const relPath = decodeURIComponent(urlObj.pathname.replace(/^\/data\//, ''));
      const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      filePath = path.join(dataDir, safePath);
      relLabel = safePath;
    } else if (
      urlObj.pathname.startsWith('/assets/world-globe/') &&
      urlObj.pathname.endsWith('.pmtiles')
    ) {
      const relPath = decodeURIComponent(urlObj.pathname.replace(/^\/+/, ''));
      const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const distCandidate = path.join(distDir, safePath);
      const publicCandidate = path.join(publicDir, safePath);
      filePath = fs.existsSync(publicCandidate) ? publicCandidate : distCandidate;
      relLabel = safePath;
    } else {
      return next();
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `PMTiles data file not found: ${relLabel}` }));
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
    res.setHeader('Cache-Control', 'no-cache');
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

function cleanStaleBuildAssetsPlugin(): Plugin {
  return {
    name: 'clean-stale-build-assets',
    apply: 'build',
    buildStart() {
      const assetsDir = path.resolve(__dirname, 'dist', 'assets');
      if (!fs.existsSync(assetsDir)) return;
      for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name === 'rtl-text-plugin.js') continue;
        if (entry.name.endsWith('.js') || entry.name.endsWith('.css') || entry.name.endsWith('.map')) {
          try {
            fs.unlinkSync(path.join(assetsDir, entry.name));
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}

function emitDeployVersionPlugin(appVersion: string): Plugin {
  return {
    name: 'emit-deploy-version',
    apply: 'build',
    closeBundle() {
      const distDir = path.resolve(__dirname, 'dist');
      if (!fs.existsSync(distDir)) return;
      fs.writeFileSync(
        path.join(distDir, 'version.json'),
        JSON.stringify({ version: appVersion, builtAt: new Date().toISOString() }, null, 2),
        'utf-8'
      );
      const swPath = path.join(distDir, 'sw.js');
      if (fs.existsSync(swPath)) {
        const swContent = fs.readFileSync(swPath, 'utf-8');
        const stamped = swContent.replace(
          /const CACHE_NAME = ['"][^'"]+['"];/,
          `const CACHE_NAME = 'navapp-offline-${appVersion}';`
        );
        fs.writeFileSync(swPath, stamped, 'utf-8');
      }
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, 'src'),
  publicDir: path.resolve(__dirname, 'src', 'public'),
  envDir: __dirname,
  plugins: [
    react(),
    tailwindcss(),
    pmtilesDataRangePlugin(),
    cleanStaleBuildAssetsPlugin(),
    emitDeployVersionPlugin(APP_VERSION),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      'maplibre-contour': path.resolve(
        __dirname,
        'node_modules/maplibre-contour/dist/index.mjs'
      ),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: false, // Never wipe dist/ so large PMTiles files are preserved across builds
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('maplibre-gl')) return 'maplibre';
          if (id.includes('firebase') || id.includes('@firebase')) return 'firebase';
          if (id.includes('@turf')) return 'turf';
          if (id.includes('lucide-react')) return 'icons';
          if (
            id.includes('/react/') ||
            id.includes('\\react\\') ||
            id.includes('react-dom') ||
            id.includes('dexie') ||
            id.includes('pmtiles') ||
            id.includes('maplibre-contour')
          ) {
            return 'vendor';
          }
        },
      },
    },
  },
});
