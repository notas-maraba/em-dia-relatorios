'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://notas-maraba.github.io/em-dia-relatorios/';
const source = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const VERSION = JSON.parse(source('package.json')).version;

function worker(code = source('sw.js')) {
  const listeners = {}, stores = new Map(), requests = [], deleted = [], fetched = [];
  let failNetwork = false, claims = 0, skipped = 0;
  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return {async addAll(items) { requests.push(...items); items.forEach(request => stores.get(name).set(request.url, new Response('PUBLIC ' + request.url))); },
      async match(request) { return stores.get(name).get(typeof request === 'string' ? request : request.url)?.clone(); }};
  }
  const sandbox = {URL, Request, Response, Set, Promise,
    self: {location: {href: SITE + 'sw.js'}, addEventListener(name, fn) { listeners[name] = fn; }, clients: {async claim() { claims++; }}, skipWaiting() { skipped++; }},
    caches: {async open(name) { return store(name); }, async keys() { return [...stores.keys()]; }, async delete(name) { deleted.push(name); return stores.delete(name); }},
    async fetch(request) { fetched.push(request.url || request); if (failNetwork) throw new Error('offline'); return new Response('CURRENT PUBLIC HTML'); }
  };
  vm.runInNewContext(code, sandbox);
  return {stores, requests, deleted, fetched, get claims() { return claims; }, get skipped() { return skipped; },
    failNetwork() { failNetwork = true; },
    async lifecycle(name) { let pending; listeners[name]({waitUntil(value) { pending = value; }}); await pending; },
    async request(url, method = 'GET', mode = 'cors') {
      let handled = false, pending;
      listeners.fetch({request: {url, method, mode}, respondWith(value) { handled = true; pending = value; }});
      return {handled, response: await pending};
    }
  };
}

function installUI({origin = 'https://notas-maraba.github.io', pathname = '/em-dia-relatorios/', standalone = false, local = false, userAgent = '', platform = '', maxTouchPoints = 0} = {}) {
  const events = {}, documentEvents = {}, classes = new Set(), buttons = [{hidden: false}], registered = [];
  const dialog = {open: false, innerHTML: '', showModal() { this.open = true; }, close() { this.open = false; }};
  const media = {matches: standalone, addEventListener(name, fn) { this.changed = fn; }};
  const document = {readyState: 'complete', documentElement: {classList: {toggle(name, value) { value ? classes.add(name) : classes.delete(name); }}},
    getElementById(id) { return id === 'install-dialog' ? dialog : null; },
    querySelectorAll() { return buttons; }, addEventListener(name, fn) { documentEvents[name] = fn; }};
  const window = {navigator: {standalone: false, userAgent, platform, maxTouchPoints, serviceWorker: {register(url, options) { registered.push({url, options}); return Promise.resolve({}); }}},
    location: {origin, pathname}, matchMedia() { return media; }, addEventListener(name, fn) { events[name] = fn; }};
  if (local) window.EMDIA_LOCAL_CONFIG = {mode: 'isolated'};
  vm.runInNewContext(source('assets/install.js'), {window, document});
  function click(attribute) {
    documentEvents.click({preventDefault() {}, target: {closest(selector) { return selector === '[' + attribute + ']' ? {} : null; }}});
  }
  return {events, documentEvents, classes, buttons, dialog, media, registered, click};
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('new UI requests its matching core release even while an older shell worker is active', async () => {
  const html = source('index.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  const cloudPath = 'assets/cloud.js?v=' + VERSION, offlinePath = 'assets/offline.js?v=' + VERSION, accountPath = 'assets/account.js?v=' + VERSION, appPath = 'assets/app.js?v=' + VERSION;
  assert.ok(scripts.indexOf(cloudPath) >= 0 && scripts.indexOf(cloudPath) < scripts.indexOf(offlinePath) && scripts.indexOf(offlinePath) < scripts.indexOf(accountPath) && scripts.indexOf(accountPath) < scripts.indexOf(appPath),
    'Private data and profile helpers must load before application startup');
  assert.ok(html.indexOf('assets/theme.js?v=' + VERSION) < html.indexOf('<link rel="stylesheet"'), 'Theme preference must be applied before the first stylesheet');
  assert.ok(scripts.indexOf('assets/access.js?v=' + VERSION) >= 0 && scripts.indexOf('assets/access.js?v=' + VERSION) < scripts.indexOf(appPath), 'Session preferences must initialize before application startup');
  const corePath = html.match(/<script src="([^"]*core\.js[^"]*)"/)[1];
  assert.equal(corePath, 'assets/core.js?v=' + VERSION);
  const current = worker(); await current.lifecycle('install');
  const coreUrl = new URL(corePath, SITE).href;
  assert.ok(current.requests.some(request => request.url === coreUrl));
  assert.ok(current.requests.some(request => request.url === new URL(offlinePath, SITE).href));
  const previousShell = source('sw.js').replaceAll(VERSION, 'previous-release')
    .replace('assets/core.js?v=previous-release', 'assets/core.js');
  const previous = worker(previousShell); await previous.lifecycle('install');
  assert.equal((await previous.request(coreUrl)).handled, false,
    'An old unversioned core cache must not intercept the updated core request');
});

test('manifest resolves inside the GitHub Pages folder and uses real install icon dimensions', () => {
  const manifest = JSON.parse(source('manifest.webmanifest'));
  assert.equal(new URL(manifest.id, SITE + 'manifest.webmanifest').href, SITE);
  assert.equal(new URL(manifest.scope, SITE + 'manifest.webmanifest').href, SITE);
  assert.equal(new URL(manifest.start_url, SITE + 'manifest.webmanifest').href, SITE);
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.prefer_related_applications, false);
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(path.join(ROOT, icon.src));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height);
    assert.ok(['any', 'maskable'].includes(icon.purpose));
  }
  const html = source('index.html');
  const applePath = html.match(/<link rel="apple-touch-icon" href="([^"]+)"/)[1];
  const apple = fs.readFileSync(path.join(ROOT, applePath));
  assert.equal(apple.readUInt32BE(16), 180); assert.equal(apple.readUInt32BE(20), 180);
  const faviconPath = html.match(/<link rel="icon" href="([^"]+)" type="image\/png" sizes="32x32"/)[1];
  const favicon = fs.readFileSync(path.join(ROOT, faviconPath));
  assert.equal(favicon.readUInt32BE(16), 32); assert.equal(favicon.readUInt32BE(20), 32);
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
});

test('service worker installation fetches only exact static public assets without credentials', async () => {
  const w = worker(); await w.lifecycle('install');
  assert.equal(w.requests.length, 20); assert.equal(new Set(w.requests.map(r => r.url)).size, 20);
  assert.ok([...w.stores.keys()][0].endsWith(VERSION), 'The shell cache must use the package release');
  const manifest = JSON.parse(source('manifest.webmanifest')), html = source('index.html');
  const iconPaths = manifest.icons.map(icon => new URL(icon.src, SITE).href);
  for (const rel of ['icon', 'apple-touch-icon']) iconPaths.push(new URL(html.match(new RegExp('<link rel="' + rel + '" href="([^"]+)"'))[1], SITE).href);
  assert.deepEqual(w.requests.map(request => request.url).filter(url => url.includes('/assets/icons/')).sort(), iconPaths.sort(), 'Precache must use only the current manifest and head icons');
  for (const request of w.requests) {
    assert.equal(new URL(request.url).origin, new URL(SITE).origin);
    assert.ok(request.url.startsWith(SITE)); assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'reload'); assert.equal(request.mode, 'same-origin'); assert.equal(request.redirect, 'error');
    assert.doesNotMatch(request.url, /auth\/|rest\/|functions\/|backup|session|access_token|refresh_token|private/i);
    const relative = new URL(request.url).pathname.slice(new URL(SITE).pathname.length) || 'index.html';
    assert.ok(fs.existsSync(path.join(ROOT, relative)), relative);
  }
  assert.equal(w.skipped, 0, 'A new worker must not replace one while a form is open');
});

test('activation removes only obsolete public caches for this application scope', async () => {
  const w = worker(); await w.lifecycle('install');
  const current = [...w.stores.keys()][0], prefix = current.slice(0, -VERSION.length);
  w.stores.set(prefix + '3.0.0', new Map()); w.stores.set('another-app', new Map()); w.stores.set('em-dia-public-shell-%2Fother-app%2F-3.0.0', new Map());
  await w.lifecycle('activate');
  assert.deepEqual(w.deleted, [prefix + '3.0.0']); assert.ok(w.stores.has(current)); assert.ok(w.stores.has('another-app')); assert.equal(w.claims, 1);
});

test('Auth, cloud data, unknown JSON, callback queries and mutations are never intercepted', async () => {
  const w = worker(); await w.lifecycle('install');
  for (const [url, method] of [
    ['https://database.example.invalid/rest/v1/em_dia_states', 'GET'],
    ['https://database.example.invalid/auth/v1/token', 'POST'],
    ['https://database.example.invalid/functions/v1/em-dia-users', 'POST'],
    [SITE + 'private.json', 'GET'], [SITE + 'backup.json', 'GET'], [SITE + '?code=private-code', 'GET'],
    [SITE + 'assets/app.js?v=' + VERSION + '&access_token=private-token', 'GET'], [SITE + 'assets/app.js?v=' + VERSION, 'POST'],
    [SITE + '../other-app/index.html', 'GET']
  ]) assert.equal((await w.request(url, method)).handled, false, url);
  assert.equal(w.fetched.length, 0);
});

test('offline fallback supplies only the public shell and never creates runtime cache entries', async () => {
  const w = worker(); await w.lifecycle('install');
  const store = [...w.stores.values()][0], originalKeys = [...store.keys()];
  const fresh = await w.request(SITE, 'GET', 'navigate'); assert.equal(await fresh.response.text(), 'CURRENT PUBLIC HTML');
  w.failNetwork(); const offline = await w.request(SITE, 'GET', 'navigate'); assert.match(await offline.response.text(), /^PUBLIC /);
  const script = await w.request(SITE + 'assets/app.js?v=' + VERSION); assert.match(await script.response.text(), /^PUBLIC /);
  assert.deepEqual([...store.keys()], originalKeys);
});

test('install controller registers a worker only on the canonical public site', async () => {
  const ui = installUI(); await turn(); assert.equal(ui.registered.length, 1);
  assert.equal(ui.registered[0].url, '/em-dia-relatorios/sw.js'); assert.equal(ui.registered[0].options.scope, '/em-dia-relatorios/'); assert.equal(ui.registered[0].options.updateViaCache, 'none');
  for (const options of [{origin: 'http://127.0.0.1:4173', pathname: '/'}, {origin: 'http://localhost:4173'}, {origin: 'https://other.example.invalid'}, {pathname: '/other-app/'}, {local: true}]) {
    const preview = installUI(options); await turn(); assert.equal(preview.registered.length, 0);
  }
});

test('native install never prompts on page load and prompts only once from a click', async () => {
  const ui = installUI(); let prompted = 0, prevented = false, choose;
  const choice = new Promise(resolve => { choose = resolve; });
  ui.events.beforeinstallprompt({preventDefault() { prevented = true; }, prompt() { prompted++; return Promise.resolve(); }, userChoice: choice});
  assert.equal(prevented, true); assert.equal(prompted, 0);
  ui.click('data-install-app'); assert.equal(prompted, 1);
  ui.click('data-install-app'); assert.equal(prompted, 1);
  choose({outcome: 'dismissed'}); await turn();
  assert.equal(ui.dialog.open, false, 'Do not nag after the user dismisses native installation');
  ui.click('data-install-app'); assert.equal(prompted, 1); assert.equal(ui.dialog.open, true);
});

test('manual iPhone and Android help stays independent from the data-entry modal', () => {
  const ios = installUI({userAgent: 'iPhone Safari'}); ios.click('data-install-app');
  assert.equal(ios.dialog.open, true); assert.match(ios.dialog.innerHTML, /Safari/); assert.match(ios.dialog.innerHTML, /Compartilhar/); assert.match(ios.dialog.innerHTML, /Adicionar à Tela de Início/);
  assert.match(ios.dialog.innerHTML, /internet/); assert.doesNotMatch(ios.dialog.innerHTML, /data-action=|id="modal"/);
  ios.click('data-install-close'); assert.equal(ios.dialog.open, false);
  const android = installUI({userAgent: 'Android Chrome'}); android.click('data-install-app'); assert.match(android.dialog.innerHTML, /Instalar aplicativo/); assert.match(android.dialog.innerHTML, /Chrome/);
});

test('standalone and installed modes hide installation options including future rendered buttons', () => {
  const ui = installUI({standalone: true}); assert.equal(ui.buttons[0].hidden, true); assert.ok(ui.classes.has('pwa-installed'));
  ui.click('data-install-app'); assert.equal(ui.dialog.open, false);
  const browser = installUI(); browser.click('data-install-app'); assert.equal(browser.dialog.open, true);
  browser.events.appinstalled(); assert.equal(browser.buttons[0].hidden, true); assert.equal(browser.dialog.open, false); assert.ok(browser.classes.has('pwa-installed'));
});

test('a failed native prompt falls back to instructions without reading user data or storage', async () => {
  const ui = installUI(); ui.events.beforeinstallprompt({preventDefault() {}, prompt() { return Promise.reject(new Error('unavailable')); }});
  ui.click('data-install-app'); await turn(); assert.equal(ui.dialog.open, true); assert.match(ui.dialog.innerHTML, /Chrome/);
  assert.doesNotMatch(source('assets/install.js'), /localStorage|sessionStorage|\.from\(|\.rpc\(|access_token|refresh_token/);
});
