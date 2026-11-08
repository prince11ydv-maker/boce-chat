'use strict';
// Only this fixed, public connection screen is available offline.
// Change the version when these offline assets change. Never add API/user files.
const CACHE_PREFIX = 'classnest-public-offline-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-08-v1';
const OFFLINE_PAGE = '/offline.html';
const PUBLIC_ASSETS = Object.freeze([
  OFFLINE_PAGE, '/offline.css', '/app-icons/icon-192.png',
  '/app-icons/icon-512.png', '/app-icons/maskable-512.png',
  '/app-icons/apple-touch-icon.png'
]);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(
    PUBLIC_ASSETS.map(path => new Request(new URL(path, self.location.origin), {
      cache: 'reload', credentials: 'omit'
    }))
  )));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names => Promise.all(
    names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name))
  )));
  // Let existing pages finish uploads and drafts before the normal update cycle.
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.search && PUBLIC_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE_NAME).then(cache => cache.match(url.pathname))
      .then(cached => cached || fetch(request)));
    return;
  }
  if (request.mode !== 'navigate' || !['/', '/index.html'].includes(url.pathname)) return;
  event.respondWith(fetch(request).catch(async () => {
    const cached = await (await caches.open(CACHE_NAME)).match(OFFLINE_PAGE);
    return cached || new Response('Classnest needs an internet connection. Reconnect and try again.', {
      status: 503, headers: {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}
    });
  }));
});
