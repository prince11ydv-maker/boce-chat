import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
function worker({online = true} = {}) {
  const handlers = new Map(), stores = new Map(), requested = [];
  const key = request => new URL(typeof request === 'string' ? request : request.url, 'https://pusoe.vercel.app').href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(requests) {
          for (const request of requests) { requested.push(request); entries.set(key(request), new Response(key(request).endsWith('/offline.html') ? 'PUBLIC OFFLINE SCREEN' : 'PUBLIC ASSET')); }
        },
        async match(request) { return entries.get(key(request))?.clone(); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  vm.runInNewContext(source, {
    self: {location: {origin: 'https://pusoe.vercel.app'}, addEventListener: (name, handler) => handlers.set(name, handler)},
    caches, URL, Request, Response, fetch: async request => { if (!online) throw new Error('Offline'); return new Response('NETWORK ' + request.url); }
  });
  async function lifecycle(name) { let job; handlers.get(name)({waitUntil(promise) { job = promise; }}); await job; }
  function request(url, {method = 'GET', mode = 'cors'} = {}) {
    let promise;
    handlers.get('fetch')({request: {url: new URL(url, 'https://pusoe.vercel.app').href, method, mode}, respondWith(value) { promise = value; }});
    return promise;
  }
  return {lifecycle, request, stores, requested};
}

test('offline install caches only the fixed public screen/assets without credentials', async () => {
  const app = worker(); await app.lifecycle('install');
  assert.equal(app.stores.size, 1);
  assert.equal(app.requested.length, 6);
  for (const request of app.requested) {
    assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'reload');
    assert.match(new URL(request.url).pathname, /^\/(offline\.(html|css)|app-icons\/(icon-(192|512)|maskable-512|apple-touch-icon)\.png)$/);
  }
});

test('all APIs, downloads, account actions, signed storage URLs and mutations bypass the worker cache', async () => {
  const app = worker({online: false}); await app.lifecycle('install');
  for (const path of ['/api/state', '/api/backup', '/api/notifications', '/api/notes/123/download', '/api/notices/123/preview', '/app.js', '/?private=1', '/offline.css?token=example', 'https://bsuspunntvruyrtfaycu.supabase.co/storage/v1/object/sign/notes/file?token=example']) {
    assert.equal(app.request(path), undefined, path);
    if (path.startsWith('/api/')) assert.equal(app.request(path, {mode: 'navigate'}), undefined, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(app.request('/offline.html', {method}), undefined);
  assert.equal(app.stores.values().next().value.size, 6);
});

test('failed app navigation shows a public offline screen while online navigation remains fresh', async () => {
  const offline = worker({online: false}); await offline.lifecycle('install');
  for (const path of ['/', '/index.html', '/?source=app']) assert.equal(await (await offline.request(path, {mode: 'navigate'})).text(), 'PUBLIC OFFLINE SCREEN');
  assert.equal(await (await offline.request('/offline.css')).text(), 'PUBLIC ASSET');
  const online = worker(); await online.lifecycle('install');
  assert.match(await (await online.request('/?source=app', {mode: 'navigate'})).text(), /^NETWORK /);
  assert.equal(online.stores.values().next().value.size, 6);
});

test('activation removes only old Classnest offline caches without forcing page activation/reload', async () => {
  const app = worker(); await app.lifecycle('install');
  app.stores.set('classnest-public-offline-old', new Map()); app.stores.set('another-app-cache', new Map());
  await app.lifecycle('activate');
  assert.equal(app.stores.has('classnest-public-offline-old'), false); assert.equal(app.stores.has('another-app-cache'), true);
  assert.equal(app.stores.size, 2);
});

test('mobile manifest and icon files provide a scoped installable app on Android and iPhone', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.id, '/'); assert.equal(manifest.scope, '/'); assert.equal(manifest.display, 'standalone');
  assert.match(manifest.start_url, /^\/\?source=app#home$/);
  for (const size of [192, 512]) assert.ok(manifest.icons.some(icon => icon.sizes === `${size}x${size}` && icon.type === 'image/png'));
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /rel="manifest"/); assert.match(html, /rel="apple-touch-icon"/); assert.match(html, /viewport-fit=cover/);
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const bytes = await readFile(new URL('../public/app-icons/' + name, import.meta.url));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(bytes.readUInt32BE(16), size); assert.equal(bytes.readUInt32BE(20), size);
  }
});
