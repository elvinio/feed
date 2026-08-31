/* Service worker for the Reader PWA.
   IMPORTANT: bump CACHE whenever any file in ASSETS changes, or installed
   clients keep being served the previous version. */
const CACHE = 'reader-v1';

const ASSETS = [
  './',
  './index.html',
  './reader.css',
  './reader-store.js',
  './reader-tts.js',
  './reader-app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // never cache /tts posts
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // Kokoro calls go straight to the network

  // Network-first for the app shell so a deploy lands without waiting for the
  // next activation; cache is the offline fallback.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
