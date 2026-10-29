// Bump VERSION whenever app files change so phones pick up the new cache.
const VERSION = 'trip-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data/trip.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // Trip data: network first so edits arrive when online, cache when offline.
  if (url.pathname.endsWith('/data/trip.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('./data/trip.json', copy));
          return res;
        })
        .catch(() => caches.match('./data/trip.json')),
    );
    return;
  }

  // App shell: cache first.
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)),
  );
});
