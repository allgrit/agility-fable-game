// Ядро Service Worker для игр Fable Arcade. Игра делает свой sw.js в 2 строки:
//   importScripts('./sdk/sw-core.js');  swCore('mygame-v3', [...CORE_URLS]);
// (или ES-import, если sw как module).
//
// Стратегия: свой код (навигация/HTML/.js/manifest) — network-first (апдейт виден сразу
// онлайн, из кэша только офлайн); статика (картинки/vendor) — cache-first; skipWaiting —
// новый SW берёт управление сразу и вытесняет залипший старый. Это лечит «застрявшую
// старую версию» у игроков — главная PWA-боль.

self.swCore = function swCore(VERSION, CORE) {
  self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE || [])).catch(() => {}));
  });

  self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

  const netFirst = (req) => fetch(req).then((res) => {
    if (res && res.ok) { const c = res.clone(); caches.open(VERSION).then((k) => k.put(req, c)).catch(() => {}); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')));

  const cacheFirst = (req) => caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res && res.ok) { const c = res.clone(); caches.open(VERSION).then((k) => k.put(req, c)).catch(() => {}); }
    return res;
  }).catch(() => hit));

  self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // сторонние (API) — мимо SW
    const p = url.pathname;
    const own = req.mode === 'navigate' || p.endsWith('.html') || p.endsWith('/')
      || p.includes('/src/') || p.includes('/js/') || p.endsWith('.webmanifest');
    e.respondWith(own ? netFirst(req) : cacheFirst(req));
  });
};
