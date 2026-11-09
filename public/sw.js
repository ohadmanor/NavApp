const CACHE_NAME = 'navapp-offline-v4';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/assets/icon.svg',
  '/assets/rtl-text-plugin.js',
  '/assets/sprites/sprite.json',
  '/assets/sprites/sprite.png',
  '/assets/sprites/sprite@2x.json',
  '/assets/sprites/sprite@2x.png'
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
  // Never intercept byte-range requests to large .pmtiles files
  if (url.pathname.endsWith('.pmtiles') || event.request.headers.get('range')) {
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
