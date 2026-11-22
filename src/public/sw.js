const CACHE_NAME = 'navapp-offline-v16';
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-512-maskable.png",
  "/assets/rtl-text-plugin.js",
  "/assets/sprites/sprite.json",
  "/assets/sprites/sprite.png",
  "/assets/sprites/sprite@2x.json",
  "/assets/sprites/sprite@2x.png",
  "/assets/user-icons/atv.svg",
  "/assets/user-icons/bike.svg",
  "/assets/user-icons/car-4wd.svg",
  "/assets/user-icons/car-suv.svg",
  "/assets/user-icons/compass.svg",
  "/assets/user-icons/dog.svg",
  "/assets/user-icons/drone.svg",
  "/assets/user-icons/horse.svg",
  "/assets/user-icons/manifest.json",
  "/assets/user-icons/motorbike.svg",
  "/assets/user-icons/navigation-arrow.svg",
  "/assets/user-icons/run.svg",
  "/assets/user-icons/tent.svg",
  "/assets/user-icons/trekking.svg",
  "/assets/user-icons/truck.svg",
  "/assets/user-icons/walk.svg",
  "/assets/poi-symbols/poi-campsite-fire.svg",
  "/assets/poi-symbols/poi-campsite-khan.svg",
  "/assets/poi-symbols/poi-campsite-night.svg",
  "/assets/poi-symbols/poi-campsite-picnic.svg",
  "/assets/poi-symbols/poi-heritage-cave.svg",
  "/assets/poi-symbols/poi-heritage-holy.svg",
  "/assets/poi-symbols/poi-heritage-landmark.svg",
  "/assets/poi-symbols/poi-heritage-monument.svg",
  "/assets/poi-symbols/poi-heritage-nature.svg",
  "/assets/poi-symbols/poi-heritage-ruins.svg",
  "/assets/poi-symbols/poi-heritage-viewpoint.svg",
  "/assets/poi-symbols/poi-offroad-blocked.svg",
  "/assets/poi-symbols/poi-offroad-danger.svg",
  "/assets/poi-symbols/poi-offroad-mud.svg",
  "/assets/poi-symbols/poi-offroad-pass.svg",
  "/assets/poi-symbols/poi-offroad-service.svg",
  "/assets/poi-symbols/poi-offroad-track.svg",
  "/assets/poi-symbols/poi-peak-crater.svg",
  "/assets/poi-symbols/poi-peak-saddle.svg",
  "/assets/poi-symbols/poi-peak-summit.svg",
  "/assets/poi-symbols/poi-peak-tower.svg",
  "/assets/poi-symbols/poi-user-flag.svg",
  "/assets/poi-symbols/poi-user-note.svg",
  "/assets/poi-symbols/poi-user-pin.svg",
  "/assets/poi-symbols/poi-user-service.svg",
  "/assets/poi-symbols/poi-user-star.svg",
  "/assets/poi-symbols/poi-water-cistern.svg",
  "/assets/poi-symbols/poi-water-pool.svg",
  "/assets/poi-symbols/poi-water-spring.svg",
  "/assets/poi-symbols/poi-water-tap.svg",
  "/assets/poi-symbols/poi-water-waterfall.svg",
  "/assets/world-globe/world-basemap.pmtiles"
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function handleBundledWorldPmtilesRequest(event, url) {
  const cache = await caches.open(CACHE_NAME);
  let fullResp = await cache.match(url.pathname);
  if (!fullResp) {
    try {
      const netResp = await fetch(event.request);
      if (netResp.status === 200) {
        await cache.put(url.pathname, netResp.clone());
      }
      return netResp;
    } catch {
      return new Response(null, { status: 503 });
    }
  }
  const rangeHeader = event.request.headers.get('range');
  if (!rangeHeader) {
    return fullResp;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return fullResp;
  }
  const buf = await fullResp.arrayBuffer();
  const total = buf.byteLength;
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
  if (start >= total || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + total },
    });
  }
  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': String(slice.byteLength),
    },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    url.pathname.startsWith('/assets/world-globe/') &&
    url.pathname.endsWith('.pmtiles')
  ) {
    event.respondWith(handleBundledWorldPmtilesRequest(event, url));
    return;
  }
  // Never intercept byte-range requests to large .pmtiles files, Android native/remote map endpoints, OAuth callbacks, or cross-origin requests
  if (
    url.pathname.startsWith('/__native_maps__/') ||
    url.pathname.startsWith('/__remote_proxy__/') ||
    url.pathname.endsWith('.pmtiles') ||
    url.pathname === '/osm-callback' ||
    url.searchParams.has('code') ||
    event.request.headers.get('range') ||
    url.origin !== self.location.origin
  ) {
    return;
  }
  // Network-first for /osm-sync so admin sync view always loads latest app shell when online
  if (
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    url.pathname === '/osm-sync'
  ) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }
  // Network-first for updatable lightweight data files (POIs & search index) so updates propagate without losing offline fallback
  if (
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.pathname === '/data/Israel.pois.geojson' ||
      url.pathname === '/data/Israel.search.idx')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((response) => {
            if (
              event.request.method === 'GET' &&
              response.status === 200 &&
              url.origin === self.location.origin
            ) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match('/index.html'))
      );
    })
  );
});
