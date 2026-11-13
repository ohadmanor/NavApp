const CACHE_NAME = 'navapp-offline-v12';
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
  "/assets/poi-symbols/poi-water-waterfall.svg"
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept byte-range requests to large .pmtiles files or cross-origin requests (e.g. Google Satellite tiles)
  if (
    url.pathname.endsWith('.pmtiles') ||
    event.request.headers.get('range') ||
    url.origin !== self.location.origin
  ) {
    return;
  }
  // Network-first for updatable lightweight data files (POIs & search index) so updates propagate without losing offline fallback
  if (
    event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    (url.pathname === '/data/Israel.pois.geojson' ||
      url.pathname === '/data/Israel.offroad.pois.geojson' ||
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
