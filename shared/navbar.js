// ── Service worker — enables SharedArrayBuffer on GitHub Pages ────────────
// Injects COOP/COEP headers via SW so multithreaded WASM (Whisper) works.
// The SW only needs to be registered once; subsequent page loads get the
// headers automatically. On first install the SW reloads the page once.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/coi-serviceworker.js', { scope: '/' })
    .catch(function () { /* non-fatal — Whisper falls back to single-threaded WASM */ });
}

// ── Prevent theme flash (runs immediately, before paint) ──────────────────
(function () {
  var t = localStorage.getItem('theme');
  if (t) document.documentElement.setAttribute('data-theme', t);
}());

// ── Inject site navbar + theme toggle on DOM ready ────────────────────────
document.addEventListener('DOMContentLoaded', function () {

  // ── Styles ──────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = '\
:root { --nav-h: 44px; }\
#__sitenav {\
  position: fixed; top: 0; left: 0; right: 0; height: var(--nav-h);\
  background: var(--surface, var(--bg-raised, #ffffff));\
  border-bottom: 1px solid var(--border, #e2e8f0);\
  display: flex; align-items: center; padding: 0 1rem; gap: 0.75rem;\
  z-index: 9999;\
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\
  font-size: 0.9rem;\
}\
body { padding-top: var(--nav-h) !important; }\
#__sitenav a { text-decoration: none; }\
#__sitenav .sn-home {\
  font-weight: 700; font-size: 1rem;\
  color: var(--text, #0f172a);\
  flex-shrink: 0;\
}\
#__sitenav .sn-links { display: flex; gap: 1rem; }\
#__sitenav .sn-links a {\
  color: var(--muted, #64748b); font-weight: 500;\
  transition: color 0.15s;\
}\
#__sitenav .sn-links a:hover { color: var(--primary, #3b82f6); }\
#__sitenav .sn-spacer { flex: 1; }\
#__sitenav #themeToggle {\
  display: inline-flex; align-items: center; justify-content: center;\
  width: 34px; height: 34px; padding: 0;\
  background: none; border: none; border-radius: 6px;\
  cursor: pointer; font-size: 1rem; line-height: 1;\
  color: var(--muted, #64748b); flex-shrink: 0;\
  transition: background 0.15s;\
}\
#__sitenav #themeToggle:hover {\
  background: var(--border, #e2e8f0);\
  color: var(--text, #0f172a);\
}';
  document.head.appendChild(style);

  // ── Markup ───────────────────────────────────────────────────────────────
  var nav = document.createElement('div');
  nav.id = '__sitenav';
  nav.innerHTML =
    '<a class="sn-home" href="/">Bri</a>' +
    '<nav class="sn-links">' +
      '<a href="/">About</a>' +
      '<a href="/projects.html">Projects</a>' +
    '</nav>' +
    '<div class="sn-spacer"></div>' +
    '<button id="themeToggle" title="Toggle dark mode">\ud83c\udf19</button>';
  document.body.insertBefore(nav, document.body.firstChild);

  // ── Theme logic ──────────────────────────────────────────────────────────
  function syncToggle() {
    var btn = document.getElementById('themeToggle');
    if (!btn) return;
    var dark =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    btn.textContent = dark ? '\u2600\ufe0f' : '\ud83c\udf19';
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function applyTheme(theme) {
    if (theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('theme');
    }
    syncToggle();
  }

  document.getElementById('themeToggle').addEventListener('click', function () {
    applyTheme(
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
    );
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncToggle);
  syncToggle();
});
