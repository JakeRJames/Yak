// YAK offline support. The page is fetched fresh whenever there is a connection,
// and the last copy is used when there is not. Saved data lives in the browser, not here.
const CACHE = 'yak-v4.0.0';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  // "Check for updates" asks for a fresh copy: always go to the network for it.
  if (r.cache === 'reload' || r.cache === 'no-store') return;
  if (r.mode === 'navigate') {
    const net = fetch(r).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); }
      return res;
    });
    const fromCache = () => caches.match('./').then(m => m || caches.match('index.html'));
    // Use the network, but fall back to the saved copy if it is slow (weak signal) or offline.
    e.respondWith(
      Promise.race([net.catch(() => null), new Promise(ok => setTimeout(() => ok(null), 3500))])
        .then(res => res || fromCache().then(m => m || net))
        .catch(fromCache)
    );
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r)));
});
