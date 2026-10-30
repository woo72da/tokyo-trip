// Bump VERSION whenever app files change so phones pick up the new cache.
// Install fetches bypass the HTTP cache, so a new VERSION never stores stale files.
const VERSION = 'trip-v20';
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

// Japanese audio clips are listed in audio/index.json and cached with the app for offline use.
const fresh = (url) => new Request(url, { cache: 'reload' });
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then(async (cache) => {
        await cache.addAll(ASSETS.map(fresh));
        // One missing clip must not block the update, so audio is cached file by file.
        try {
          const index = await (await fetch(fresh('./audio/index.json'))).json();
          await Promise.allSettled(['./audio/index.json', ...Object.values(index).map((f) => './' + f)].map((u) => cache.add(fresh(u))));
        } catch { /* no audio list: the app falls back to the speech engine */ }
      })
      .then(() => self.skipWaiting()),
  );
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
