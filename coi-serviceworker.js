/**
 * coi-serviceworker — injects Cross-Origin-Embedder-Policy and
 * Cross-Origin-Opener-Policy headers so SharedArrayBuffer (and
 * therefore multithreaded WASM) is available on GitHub Pages.
 *
 * Registers at the root so its scope covers the whole site.
 * On first install it reloads each controlled client once so the
 * new headers take effect immediately (one-time reload per device).
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      clients.forEach(client => {
        if ('navigate' in client) client.navigate(client.url);
      });
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  // Skip opaque requests that cannot be augmented
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

  event.respondWith(
    fetch(req).then(response => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      // credentialless is more permissive than require-corp and
      // allows CDN resources (HuggingFace, jsdelivr) without CORP headers
      headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      return new Response(response.body, {
        status:     response.status,
        statusText: response.statusText,
        headers,
      });
    }).catch(() => fetch(req))
  );
});
