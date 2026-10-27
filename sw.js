// Retired: Dots used to live at the site root with this service worker.
// It moved to dots/ (with its own worker), and the root is now a start page.
// This version clears the old Dots cache, unregisters itself and reloads
// open pages so they show the current files.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      await self.clients.claim(); // take over open pages so they can be reloaded
      const keys = await caches.keys();
      // Only the old root caches; dots/ and years/ use their own newer versions.
      await Promise.all(keys.filter((k) => /^dots-v[1-6]$/.test(k)).map((k) => caches.delete(k)));
      await self.registration.unregister();
      // Reload open pages once. The browser may still serve the old page from
      // its HTTP cache for a few minutes (it would register this worker again),
      // so a marker stops that from turning into a reload loop.
      if (await caches.has('root-retired')) return;
      await caches.open('root-retired');
      const pages = await self.clients.matchAll({ type: 'window' });
      for (const page of pages) page.navigate(page.url);
    })()
  );
});
