// Service worker: network-first — каждый заход тянет свежие файлы с сервера
// (обходя HTTP-кеш браузера), офлайн-фолбэк из кеша. Любой деплой виден
// клиентам при следующей загрузке страницы без ручной очистки кеша.
const BUILD = 'build-2026-07-14-1-sdk-analytics';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== BUILD).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req, { cache: 'no-store' });
      const cache = await caches.open(BUILD);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      return new Response('offline', { status: 503 });
    }
  })());
});
