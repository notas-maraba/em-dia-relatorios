/* Em dia 5.1.0: cache only this explicit public application shell. */
'use strict';
const RELEASE = '5.1.0';
const BASE = new URL('./', self.location.href);
const CACHE_PREFIX = 'em-dia-public-shell-' + encodeURIComponent(BASE.pathname) + '-';
const CACHE_NAME = CACHE_PREFIX + RELEASE;
const SHELL = [
  './',
  './index.html',
  './assets/app.css?v=5.1.0',
  './assets/core.js?v=5.1.0',
  './assets/pdf.js',
  './assets/vendor/supabase.js',
  './assets/config.js?v=5.1.0',
  './assets/cloud.js?v=5.1.0',
  './assets/offline.js?v=5.1.0',
  './assets/account.js?v=5.1.0',
  './assets/theme.js?v=5.1.0',
  './assets/app.js?v=5.1.0',
  './assets/install.js?v=5.1.0',
  './manifest.webmanifest',
  './assets/icons/relatorios-32-v311.png',
  './assets/icons/relatorios-192-v311.png',
  './assets/icons/relatorios-512-v311.png',
  './assets/icons/relatorios-maskable-512-v311.png',
  './assets/icons/apple-touch-icon-v311.png'
].map(file => new URL(file, BASE).href);
const ALLOWED = new Set(SHELL);
const NAVIGATION = new Set([BASE.href, new URL('index.html', BASE).href]);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL.map(url => new Request(url, {
    credentials: 'omit', cache: 'reload', mode: 'same-origin', redirect: 'error'
  })))));
  // A new release waits for existing tabs to close; do not interrupt open forms.
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !ALLOWED.has(request.url)) return;
  // Never handle Auth, database, Edge Functions, private JSON, query-bearing
  // login callbacks, or any cross-origin request. There is no runtime caching.
  if (request.mode === 'navigate' && NAVIGATION.has(request.url)) {
    // Prefer the current public HTML online. This also discovers new releases.
    event.respondWith(fetch(request).catch(() => caches.open(CACHE_NAME).then(cache => cache.match(request))));
    return;
  }
  event.respondWith(caches.open(CACHE_NAME).then(cache => cache.match(request)).then(cached => cached || fetch(request)));
});
