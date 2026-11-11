// Service Worker: hält die App-Dateien für den Start ohne Netz bereit.
// Daten kommen immer frisch vom Server (werden hier nicht abgefangen).
const VERSION = 'tsc88-v1';
const DATEIEN = ['./', 'index.html', 'style.css?v=1', 'app.js?v=1', 'config.js?v=1', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(DATEIEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Erst Netz (damit Updates sofort ankommen), ohne Netz aus dem Speicher
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const kopie = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, kopie));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
