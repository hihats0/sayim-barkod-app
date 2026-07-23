const CACHE_NAME = 'sayim-barkod-v3';
const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css?v=3',
  './app.js?v=3',
  './lookup-fix.js?v=3',
  './pwa-install.js?v=3',
  './manifest.webmanifest?v=3',
  './icon.svg',
  './icon-192.svg',
  './icon-512.svg',
  './data/a101-products.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(CORE_ASSETS.map((asset) => cache.add(asset)));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/data/a101-products.json')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
    return response;
  } catch (_) {
    return (await caches.match(request))
      || new Response(JSON.stringify({
        metadata: { status: 'offline', message: 'Çevrimdışı katalog verisi bulunamadı.' },
        products: []
      }), { headers: { 'Content-Type': 'application/json' } });
  }
}
