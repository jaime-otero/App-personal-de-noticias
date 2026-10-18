// App shell: stale-while-revalidate (instant load, updates picked up on the next visit). News data and the
// weekly archive: network-first with the cached copy as offline fallback.
// Pages: network-first, so a logged-out visit reaches the login redirect instead of a cached shell.
const VERSION = 'v12';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'lib/profile.js', 'lib/rank.js', 'lib/tokens.js', 'lib/taxonomy.js', 'lib/spoilers.js', 'lib/corrections.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  // File by file, skipping failures: logged out, the shell answers 401 and must not block the
  // update. Failed bodies are discarded (an unread one can stall the remaining requests).
  const save = (c, u) => fetch(u).then((r) => (r.ok ? c.put(u, r) : r.body?.cancel()), () => {});
  e.waitUntil(caches.open(`shell-${VERSION}`).then((c) => Promise.all(SHELL.map((u) => save(c, u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== `shell-${VERSION}`).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (url.pathname.endsWith('/data/meta.json')) return; // always from the network
  // The edition and the weekly archive (data/weekly/*.json).
  const data = url.pathname.match(/\/(data\/(?:news|weekly\/[\w-]+)\.json)$/)?.[1];
  if (data) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open('data').then((c) => c.put(data, copy));
          }
          return res;
        })
        .catch(() => caches.match(data, { cacheName: 'data' })),
    );
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('index.html', { cacheName: `shell-${VERSION}` })));
    return;
  }
  e.respondWith(
    caches.open(`shell-${VERSION}`).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const update = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => hit);
      if (hit) e.waitUntil(update);
      return hit ?? update;
    }),
  );
});
