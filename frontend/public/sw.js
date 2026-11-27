// SPDX-License-Identifier: AGPL-3.0-only
/*
 * DOMINUS app-shell service worker (ADR-0114).
 *
 * Rules that matter:
 *   - navigation is network-first. A cached page is used ONLY when the network
 *     is unavailable, so a deploy is never hidden behind a stale HTML shell;
 *   - /api/ is never cached. Scores, portfolios and billing always come from
 *     the server; an offline read is served from the app's own last render,
 *     not from a frozen HTTP response;
 *   - static assets (hashed JS/CSS, icons, manifest) are stale-while-revalidate.
 *
 * Version bumps require changing CACHE_NAME.
 */
const CACHE_NAME = 'dominus-shell-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/*
 * Web push (ADR-0116). The payload is sent by WebPushNotifier and always
 * carries a decision route: a tap opens that screen, never the app root.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'DOMINUS — a decision needs you';
  const url = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : '/alerts';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || 'Open DOMINUS to review it.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `dominus-${payload.domain || 'alert'}`,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/alerts';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          return client.focus().then(() => client.navigate(url));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
