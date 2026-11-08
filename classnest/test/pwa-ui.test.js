import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/pwa.js', import.meta.url), 'utf8');

// Exercise installation choices without pretending that a VM installs a phone app.
function browser({ua = 'Mozilla Android Chrome', standalone = false, secure = true, online = true, platform = '', touches = 0} = {}) {
  class Element {
    constructor() { this.hidden = true; this.open = false; this.listeners = {}; this.textContent = ''; this.children = []; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    replaceChildren(...items) { this.children = items; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    setAttribute(name) { if (name === 'open') this.open = true; }
    removeAttribute(name) { if (name === 'open') this.open = false; }
    getBoundingClientRect() { return {left: 10, right: 300, top: 10, bottom: 400}; }
  }
  const elements = {};
  for (const id of ['install-app-dialog', 'install-app-now', 'install-app-status', 'app-network-status', 'install-device-name', 'install-app-steps', 'close-install-app', 'install-app-done']) elements[id] = new Element();
  const controls = [new Element(), new Element()], handlers = {}, registrations = [], timers = new Map();
  let timerId = 0;
  const media = {matches: standalone, addEventListener(type, listener) { this.listener = listener; }};
  const navigator = {
    userAgent: ua, platform, maxTouchPoints: touches, onLine: online,
    serviceWorker: {register(...args) { registrations.push(args); return Promise.resolve({}); }}
  };
  const window = {
    isSecureContext: secure,
    matchMedia() { return media; },
    addEventListener(type, listener) { handlers[type] = listener; },
    location: {reload() { assert.fail('Connection changes must not reload an open form.'); }}
  };
  const document = {
    readyState: 'complete', visibilityState: 'visible',
    querySelectorAll() { return controls; },
    getElementById(id) { return elements[id]; },
    createElement() { return new Element(); },
    addEventListener(type, listener) { handlers['document:' + type] = listener; }
  };
  vm.runInNewContext(source, {
    window, document, navigator,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch() { assert.fail('The installation UI must not fetch or queue class content.'); }
  });
  return {elements, controls, handlers, registrations, timers, media, navigator};
}

test('PWA Android installation help is user initiated and registers only the same-origin worker', async () => {
  const app = browser();
  assert.ok(app.controls.every(control => !control.hidden));
  assert.equal(app.elements['install-app-dialog'].open, false);
  assert.equal(app.registrations.length, 1);
  assert.equal(app.registrations[0][0], '/service-worker.js');
  assert.equal(app.registrations[0][1].scope, '/');
  assert.equal(app.registrations[0][1].updateViaCache, 'none');
  await app.controls[0].listeners.click();
  assert.equal(app.elements['install-app-dialog'].open, true);
  assert.match(app.elements['install-app-steps'].children.map(item => item.textContent).join(' '), /Chrome.*Install app.*Add to Home screen/);
});

test('PWA iPhone help explains Safari and Open as Web App without a fake install prompt', async () => {
  const app = browser({ua: 'Mozilla iPhone Safari'});
  await app.controls[0].listeners.click();
  assert.match(app.elements['install-app-steps'].children.map(item => item.textContent).join(' '), /Safari.*Share.*Add to Home Screen.*Open as Web App/);
  assert.equal(app.elements['install-app-now'].hidden, true);
});

test('PWA iPad desktop user agents retain the iPhone and iPad installation guide', async () => {
  const app = browser({ua: 'Mozilla Macintosh Safari', platform: 'MacIntel', touches: 5});
  await app.controls[0].listeners.click();
  assert.match(app.elements['install-device-name'].textContent, /iPhone or iPad/);
});

test('PWA standalone, native APK, and insecure browsing never offer redundant installation', () => {
  for (const options of [{standalone: true}, {ua: 'Android ClassnestAndroid/1.0'}, {secure: false}]) {
    const app = browser(options);
    assert.ok(app.controls.every(control => control.hidden));
    if (options.ua || options.secure === false) assert.equal(app.registrations.length, 0);
  }
});

test('PWA browser installation prompts wait for a click and accepted installs hide controls', async () => {
  const app = browser();
  let prompts = 0, prevented = 0;
  app.handlers.beforeinstallprompt({
    preventDefault() { prevented++; },
    async prompt() { prompts++; },
    userChoice: Promise.resolve({outcome: 'accepted'})
  });
  assert.equal(prevented, 1);
  assert.equal(prompts, 0);
  await app.controls[0].listeners.click();
  assert.equal(prompts, 1);
  assert.ok(app.controls.every(control => control.hidden));
});

test('PWA dismissed prompts retain manual installation help for another attempt', async () => {
  const app = browser();
  app.handlers.beforeinstallprompt({preventDefault() {}, async prompt() {}, userChoice: Promise.resolve({outcome: 'dismissed'})});
  await app.controls[0].listeners.click();
  assert.ok(app.controls.every(control => !control.hidden));
  await app.controls[0].listeners.click();
  assert.equal(app.elements['install-app-dialog'].open, true);
});

test('PWA connection changes show status without reloading forms or fetching class content', () => {
  const app = browser({online: false});
  assert.equal(app.elements['app-network-status'].hidden, false);
  assert.match(app.elements['app-network-status'].textContent, /offline/);
  app.navigator.onLine = true;
  app.handlers.online();
  assert.match(app.elements['app-network-status'].textContent, /Back online/);
  assert.equal(app.timers.size, 1);
  [...app.timers.values()][0]();
  assert.equal(app.elements['app-network-status'].hidden, true);
});

test('PWA appinstalled events remove browser installation controls and close the guide', async () => {
  const app = browser();
  await app.controls[0].listeners.click();
  assert.equal(app.elements['install-app-dialog'].open, true);
  app.handlers.appinstalled();
  assert.ok(app.controls.every(control => control.hidden));
  assert.equal(app.elements['install-app-dialog'].open, false);
});
