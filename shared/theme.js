// ── Shared theme — load in <head> to prevent flash ────────────────────────
// Reads localStorage immediately so the correct data-theme is set before
// the page renders. The toggle button is wired up on DOMContentLoaded.
(function () {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
})();

function applyTheme(theme) {
  if (theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('theme');
  }
  _syncThemeButton();
}

function _syncThemeButton() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark =
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  btn.textContent = isDark ? '☀️' : '🌙';
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

document.addEventListener('DOMContentLoaded', function () {
  _syncThemeButton();
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  btn.addEventListener('click', function () {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
  // Keep icon in sync if system preference changes while page is open
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', _syncThemeButton);
});
