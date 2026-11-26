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
