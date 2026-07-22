// CACHE_VERSION is bumped automatically on every commit by the pre-commit hook.
// The 'pomodoro-' prefix scopes purges to this project only — Cache Storage
// is origin-wide, so other sub-projects on the same origin are left untouched.
const CACHE_VERSION = 'pomodoro-v20260722144434';

const PRECACHE = [
  './',
  './pomodoro.css',
  './pomodoro.js',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js',
];

// ── Install: pre-cache all app shell assets ────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('pomodoro-') && k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch strategy ─────────────────────────────────────────────
self.addEventListener('fetch', e => {
  // Network-first for HTML navigation — ensures a reload gets fresh content
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          caches.open(CACHE_VERSION).then(c => c.put(e.request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match('./'))
    );
    return;
  }

  // Cache-first for all other assets (CSS, JS, images, CDN scripts)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) caches.open(CACHE_VERSION).then(c => c.put(e.request, resp.clone()));
        return resp;
      });
    })
  );
});
