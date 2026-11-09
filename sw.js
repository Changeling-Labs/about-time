// About Time — service worker.
//
// Two jobs: keep the shell available on bad venue wifi, and receive the Web
// Push that says someone is ready to go.

const CACHE = 'about-time-v11';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/lib.js',
  './js/store.js',
  './js/demo.js',
  './js/push.js',
  './js/vendor/supabase.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache:'reload' bypasses the browser's HTTP cache. GitHub Pages serves
      // assets with max-age=600, so a plain addAll can precache the previous
      // deploy's JS and keep it alive until the next cache bump.
      await Promise.all(
        ASSETS.map(async (asset) => {
          const response = await fetch(asset, { cache: 'reload' });
          if (response.ok) await cache.put(asset, response);
        }),
      );
    })(),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: fresh when possible, cached shell when not.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy)).catch(() => {});
          return response;
        })
        .catch(async () => (await caches.match('./index.html')) ?? (await caches.match('./'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
            }
            return response;
          })
          .catch(() => hit),
    ),
  );
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() ?? '' };
  }

  const scope = self.registration.scope;
  const title = payload.title || 'About Time';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'about-time',
    renotify: true,
    data: payload,
    icon: new URL('./icons/icon-192.png', scope).href,
    badge: new URL('./icons/icon-192.png', scope).href,
    vibrate: [90, 40, 90],
    timestamp: Date.now(),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const code = event.notification.data?.code;
  const target = new URL(code ? `./?code=${encodeURIComponent(code)}` : './', self.registration.scope).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

      for (const client of windows) {
        if (new URL(client.url).origin !== new URL(target).origin) continue;
        await client.focus();
        if ('navigate' in client) {
          try {
            await client.navigate(target);
          } catch {
            /* some browsers refuse navigate; focus alone is fine */
          }
        }
        return;
      }

      await self.clients.openWindow(target);
    })(),
  );
});
