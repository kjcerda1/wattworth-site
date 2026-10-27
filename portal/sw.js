/* WattWorth customer app service worker: installable shell, offline fallback, push notifications.
   Scope is /portal/. API calls are never cached (the app keeps its own last-seen copy). */
const CACHE = 'wattworth-portal-v2';
const SHELL = ['/portal/', '/portal/manifest.webmanifest', '/portal/icon-192.png', '/portal/qrcode.js', '/portal/apple-touch-icon.png', '/assets/ww.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // fresh page when online, cached shell when not
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/portal/', copy)); return r; }).catch(() => caches.match('/portal/')));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'WattWorth', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'WattWorth', {
    body: d.body || '', tag: d.tag || 'wattworth', icon: '/portal/icon-192.png', '/portal/qrcode.js', badge: '/portal/icon-192.png',
    data: { url: d.url || '/portal/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/portal/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes('/portal/') && 'focus' in c) { c.postMessage({ type: 'refresh' }); return c.focus(); }
    return self.clients.openWindow(target);
  }));
});
