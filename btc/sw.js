// Offline support: always try the network first so a new version shows up
// straight away, and fall back to the cached copy when offline.
const CACHE = 'btc-v8';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'data.js', 'model.js', 'forecast.js', 'live.js', 'worker.js', 'chart.js', 'track.js', 'vendor/lightweight-charts.mjs', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter((k) => k.startsWith('btc-') && k !== CACHE);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
      // Replacing an older version: reload open pages so they run the new code.
      if (old.length) {
        for (const page of await self.clients.matchAll({ type: 'window' })) page.navigate(page.url);
      }
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Navigations can't be re-made as a Request with options, so use the URL.
  const req = e.request.mode === 'navigate' ? e.request.url : e.request;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((cached) => cached || Response.error()))
  );
});
