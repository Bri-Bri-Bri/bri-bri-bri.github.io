// Hands-Free Games — combined COI + app-shell service worker
//
// Two jobs:
//  1. Inject COOP/COEP headers so SharedArrayBuffer (multithreaded Whisper
//     WASM) works when the app is installed as a PWA.
//  2. Cache the app shell so the games work offline / on slow connections.
//     The Whisper model weights are already cached by @xenova/transformers
//     in a separate Cache Storage bucket — no need to handle them here.
//
// Bump CACHE_VERSION on every deploy to purge stale assets.

const CACHE_VERSION = 'v20260707023315';

const APP_SHELL = [
  './',
  './index.html',
  './binary.html',
  './doomsday.html',
  './game24.html',
  './pao.html',
  './css/style.css',
  './js/speech.js',
  './manifest.json',
  './icon.svg',
  '../shared/navbar.js',
];

// ── Install: pre-cache app shell ───────────────────────────────────────────
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (c) { return c.addAll(APP_SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

// ── Activate: purge old caches ─────────────────────────────────────────────
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) { return k !== CACHE_VERSION; })
            .map(function (k)   { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

// ── Fetch: COI headers + cache-first for shell, network-first for nav ──────
self.addEventListener('fetch', function (e) {
  var req = e.request;

  // Skip opaque cross-origin requests that can't be augmented
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  // Network-first for HTML navigations so deploys propagate quickly
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(function (resp) {
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, resp.clone()); });
          return addCoiHeaders(resp);
        })
        .catch(function () {
          return caches.match(req).then(function (cached) {
            return cached ? addCoiHeaders(cached) : caches.match('./index.html');
          });
        })
    );
    return;
  }

  // Cache-first for everything else
  e.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return addCoiHeaders(cached);
      return fetch(req).then(function (resp) {
        if (resp.ok) caches.open(CACHE_VERSION).then(function (c) { c.put(req, resp.clone()); });
        return addCoiHeaders(resp);
      });
    })
  );
});

// ── Helper: inject COOP/COEP headers ──────────────────────────────────────
function addCoiHeaders(response) {
  if (!response || response.status === 0) return response;
  var headers = new Headers(response.headers);
  // "credentialless" allows CDN resources (jsDelivr, HuggingFace) without CORP headers
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers:    headers,
  });
}
