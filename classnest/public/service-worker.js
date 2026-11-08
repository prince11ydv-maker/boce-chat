'use strict';
// Only this fixed, public connection screen is available offline.
// Change the version when these offline assets change. Never add API/user files.
const CACHE_PREFIX = 'classnest-public-offline-';
const CACHE_NAME = CACHE_PREFIX + '2026-11-08-v2';
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

// Payloads carry only an opaque notification ID. Class content is fetched after sign-in.
self.addEventListener('push', event => {
  let id;
  try{id=event.data?.json()?.notificationId;}catch{return;}
  if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return;
  event.waitUntil(self.registration.showNotification('Classnest',{
    body:'New class update. Sign in to view it.',icon:'/app-icons/icon-192.png',badge:'/app-icons/icon-192.png',
    tag:'classnest-'+id,data:{notificationId:id}
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id=event.notification.data?.notificationId;
  const destination=new URL('/#notifications'+(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?'/'+id:''),self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){let origin;try{origin=new URL(client.url).origin;}catch{continue;}if(origin!==self.location.origin)continue;
      try{if('navigate' in client)await client.navigate(destination);return await client.focus();}catch{ /* The window may have closed between lookup and focus. */ }
    }
    return self.clients.openWindow(destination);
  })());
});
