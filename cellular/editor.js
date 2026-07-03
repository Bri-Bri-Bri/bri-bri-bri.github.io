import LichessPgnViewer from 'https://esm.sh/@lichess-org/pgn-viewer@2.6.0?bundle';
import { marked } from 'https://esm.sh/marked@14';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  title: 'Untitled Study',
  cells: [],       // [{ id, type, content } | { id, type, pgn, title, orientation }]
};

const viewerInstances = new Map();   // cellId → LichessPgnViewer instance
let autoSaveTimer = null;

// ── IDs ───────────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Cell factories ────────────────────────────────────────────────────────────

function newTextCell(content = '') {
  return { id: uid(), type: 'text', content };
}

function newBoardCell(pgn = '', title = '', orientation = 'white') {
  return { id: uid(), type: 'board', pgn, title, orientation };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getCell(id) {
  return state.cells.find(c => c.id === id);
}

function updateCellData(id, patch) {
  const cell = getCell(id);
  if (cell) Object.assign(cell, patch);
  scheduleAutoSave();
}

// ── Auto-save ─────────────────────────────────────────────────────────────────

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem('cellular-notebook', JSON.stringify({
        title: state.title,
        cells: state.cells,
      }));
    } catch { /* quota exceeded — silently skip */ }
  }, 1500);
}

// ── Board viewer management ───────────────────────────────────────────────────

function mountViewer(cellId, pgn, orientation = 'white') {
  const container = document.getElementById('viewer-' + cellId);
  if (!container) return;

  // Destroy existing instance if the library supports it
  const existing = viewerInstances.get(cellId);
  if (existing && typeof existing.destroy === 'function') existing.destroy();
  container.innerHTML = '';

  const instance = LichessPgnViewer(container, {
    pgn: pgn || '',
    orientation,
    showCoords: true,
    drawArrows: true,
    scrollToMove: false,
  });
  viewerInstances.set(cellId, instance);
}

// ── DOM builders ──────────────────────────────────────────────────────────────

function buildTextCell(cell) {
  const div = document.createElement('div');
  div.className = 'cell cell-text';
  div.dataset.id = cell.id;

  const hasContent = cell.content && cell.content.trim().length > 0;

  div.innerHTML = `
    <div class="cell-toolbar">
      <span class="cell-type-tag">Text</span>
      <div class="spacer"></div>
      <button class="btn-icon preview-toggle${hasContent ? ' active' : ''}" title="Toggle edit/preview">
        ${hasContent ? '👁 Preview' : '✏ Edit'}
      </button>
      <button class="btn-icon move-up" title="Move up">↑</button>
      <button class="btn-icon move-down" title="Move down">↓</button>
      <button class="btn-icon danger delete-cell" title="Delete cell">✕</button>
    </div>
    <div class="cell-body">
      <textarea class="md-editor" placeholder="Write markdown here…" style="${hasContent ? 'display:none' : ''}">${escapeHtml(cell.content)}</textarea>
      <div class="md-preview" style="${hasContent ? '' : 'display:none'}">${hasContent ? renderMarkdown(cell.content) : ''}</div>
    </div>`;

  const ta     = div.querySelector('.md-editor');
  const preview = div.querySelector('.md-preview');
  const toggle  = div.querySelector('.preview-toggle');

  toggle.addEventListener('click', () => {
    const editing = ta.style.display !== 'none';
    if (editing) {
      // → switch to preview
      const content = ta.value;
      updateCellData(cell.id, { content });
      preview.innerHTML = renderMarkdown(content);
      ta.style.display      = 'none';
      preview.style.display = '';
      toggle.textContent    = '👁 Preview';
      toggle.classList.add('active');
    } else {
      // → switch to edit
      ta.style.display      = '';
      preview.style.display = 'none';
      toggle.textContent    = '✏ Edit';
      toggle.classList.remove('active');
      ta.focus();
    }
  });

  ta.addEventListener('input', e => updateCellData(cell.id, { content: e.target.value }));

  return div;
}

function buildBoardCell(cell) {
  const div = document.createElement('div');
  div.className = 'cell cell-board';
  div.dataset.id = cell.id;

  div.innerHTML = `
    <div class="cell-toolbar">
      <span class="cell-type-tag">Board</span>
      <input class="board-title-input" type="text" placeholder="Position title…" value="${escapeAttr(cell.title || '')}">
      <div class="spacer"></div>
      <button class="btn-icon flip-board" title="Flip board">⇅ Flip</button>
      <button class="btn-icon export-board" title="Export this board as HTML">⬇ Export</button>
      <button class="btn-icon move-up" title="Move up">↑</button>
      <button class="btn-icon move-down" title="Move down">↓</button>
      <button class="btn-icon danger delete-cell" title="Delete cell">✕</button>
    </div>
    <div class="cell-body">
      <div class="board-viewer-wrap">
        <div class="board-viewer" id="viewer-${cell.id}"></div>
      </div>
      <div class="pgn-edit-wrap">
        <textarea class="pgn-editor" placeholder="Paste or type PGN here…

Tips:
  Draw arrows  →  [%cal Ge2e4,Re7e5]
  Color squares →  [%csl Gd4,Re5]
  Colors: G=green  R=red  Y=yellow  B=blue

Example:
  1. e4 { [%csl Ge4][%cal Gd1h5,Gf1c4] } e5 2. Nf3">${escapeHtml(cell.pgn || '')}</textarea>
        <div class="pgn-hints">
          Arrows: <code>[%cal Ge2e4]</code> &nbsp;·&nbsp;
          Squares: <code>[%csl Ge4]</code> &nbsp;·&nbsp;
          Colors: <strong>G</strong>reen <strong>R</strong>ed <strong>Y</strong>ellow <strong>B</strong>lue
        </div>
      </div>
    </div>`;

  div.querySelector('.board-title-input').addEventListener('input', e => {
    updateCellData(cell.id, { title: e.target.value });
  });

  let pgnDebounce;
  div.querySelector('.pgn-editor').addEventListener('input', e => {
    updateCellData(cell.id, { pgn: e.target.value });
    clearTimeout(pgnDebounce);
    pgnDebounce = setTimeout(() => {
      mountViewer(cell.id, e.target.value, getCell(cell.id).orientation);
    }, 600);
  });

  div.querySelector('.flip-board').addEventListener('click', () => {
    const c = getCell(cell.id);
    const next = c.orientation === 'white' ? 'black' : 'white';
    updateCellData(cell.id, { orientation: next });
    mountViewer(cell.id, c.pgn, next);
  });

  div.querySelector('.export-board').addEventListener('click', () => exportBoard(cell.id));

  return div;
}

function renderMarkdown(content) {
  if (!content) return '';
  return marked.parse(content);
}

// ── Notebook mutations ────────────────────────────────────────────────────────

function addCell(type) {
  const cell = type === 'text' ? newTextCell() : newBoardCell();
  state.cells.push(cell);

  const el = type === 'text' ? buildTextCell(cell) : buildBoardCell(cell);
  document.getElementById('notebook').appendChild(el);
  updateEmptyState();

  if (type === 'board') {
    requestAnimationFrame(() => mountViewer(cell.id, cell.pgn, cell.orientation));
  }

  // Focus the relevant input in the new cell
  requestAnimationFrame(() => {
    const focus = el.querySelector(type === 'text' ? '.md-editor' : '.board-title-input');
    if (focus) focus.focus();
  });

  scheduleAutoSave();
}

function deleteCell(id) {
  const idx = state.cells.findIndex(c => c.id === id);
  if (idx === -1) return;

  const existing = viewerInstances.get(id);
  if (existing && typeof existing.destroy === 'function') existing.destroy();
  viewerInstances.delete(id);

  state.cells.splice(idx, 1);
  document.querySelector(`.cell[data-id="${CSS.escape(id)}"]`)?.remove();
  updateEmptyState();
  scheduleAutoSave();
}

function moveCellUp(id) {
  const idx = state.cells.findIndex(c => c.id === id);
  if (idx <= 0) return;
  [state.cells[idx - 1], state.cells[idx]] = [state.cells[idx], state.cells[idx - 1]];
  const nb  = document.getElementById('notebook');
  const els = Array.from(nb.children);
  nb.insertBefore(els[idx], els[idx - 1]);
  scheduleAutoSave();
}

function moveCellDown(id) {
  const idx = state.cells.findIndex(c => c.id === id);
  if (idx >= state.cells.length - 1) return;
  [state.cells[idx], state.cells[idx + 1]] = [state.cells[idx + 1], state.cells[idx]];
  const nb  = document.getElementById('notebook');
  const els = Array.from(nb.children);
  nb.insertBefore(els[idx + 1], els[idx]);
  scheduleAutoSave();
}

function updateEmptyState() {
  document.getElementById('empty-state').style.display =
    state.cells.length === 0 ? 'block' : 'none';
}

// ── Event delegation (delete / move-up / move-down) ───────────────────────────
// (per-cell buttons like flip / export-board / preview-toggle bind locally in builders)

document.getElementById('notebook').addEventListener('click', e => {
  const btn  = e.target.closest('.btn-icon');
  if (!btn) return;
  const cell = btn.closest('.cell');
  if (!cell) return;
  const id = cell.dataset.id;

  if (btn.classList.contains('delete-cell'))  deleteCell(id);
  else if (btn.classList.contains('move-up'))   moveCellUp(id);
  else if (btn.classList.contains('move-down')) moveCellDown(id);
});

// ── Toolbar buttons ───────────────────────────────────────────────────────────

document.getElementById('addTextBtn').addEventListener('click', () => addCell('text'));
document.getElementById('addBoardBtn').addEventListener('click', () => addCell('board'));

document.getElementById('notebookTitle').addEventListener('input', e => {
  state.title = e.target.value;
  scheduleAutoSave();
});

// ── Save / Load ───────────────────────────────────────────────────────────────

document.getElementById('saveBtn').addEventListener('click', () => {
  const data = { title: state.title, cells: state.cells };
  const filename = (state.title.replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'notebook') + '.json';
  downloadBlob(JSON.stringify(data, null, 2), 'application/json', filename);
});

document.getElementById('loadFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      loadNotebook(JSON.parse(ev.target.result));
    } catch {
      alert('Could not parse the notebook file — is it valid JSON?');
    }
  };
  reader.readAsText(file);
  e.target.value = '';   // reset so the same file can be reloaded
});

function loadNotebook(data) {
  // Tear down
  viewerInstances.forEach((inst) => {
    if (typeof inst.destroy === 'function') inst.destroy();
  });
  viewerInstances.clear();
  state.cells = [];

  document.getElementById('notebook').innerHTML = '';
  const titleEl = document.getElementById('notebookTitle');
  titleEl.value = data.title || 'Untitled Study';
  state.title   = titleEl.value;

  (data.cells || []).forEach(cell => {
    state.cells.push(cell);
    const el = cell.type === 'text' ? buildTextCell(cell) : buildBoardCell(cell);
    document.getElementById('notebook').appendChild(el);
    if (cell.type === 'board') {
      requestAnimationFrame(() => mountViewer(cell.id, cell.pgn, cell.orientation));
    }
  });

  updateEmptyState();
}

// ── Export ────────────────────────────────────────────────────────────────────

document.getElementById('exportBtn').addEventListener('click', exportFullBook);

function exportFullBook() {
  const title    = state.title || 'Untitled Study';
  const bodyHtml = state.cells.map(cellToExportHtml).join('\n');
  const filename = (title.replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'chess-notebook') + '.html';
  downloadBlob(buildExportPage(title, bodyHtml), 'text/html', filename);
}

function exportBoard(id) {
  const cell = getCell(id);
  if (!cell) return;
  const title    = cell.title || 'Board Position';
  const bodyHtml = cellToExportHtml(cell);
  const filename = (title.replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'board') + '.html';
  downloadBlob(buildExportPage(title, bodyHtml, true), 'text/html', filename);
}

function cellToExportHtml(cell) {
  if (cell.type === 'text') {
    return `<div class="cell cell-text">${renderMarkdown(cell.content)}</div>`;
  }
  const heading = cell.title
    ? `<p class="board-label">${escapeHtml(cell.title)}</p>`
    : '';
  return `<div class="cell cell-board">
  ${heading}
  <div class="board-viewer"
       data-pgn="${escapeAttr(cell.pgn || '')}"
       data-orientation="${escapeAttr(cell.orientation || 'white')}"></div>
</div>`;
}

function buildExportPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@lichess-org/pgn-viewer@1/dist/pgn-viewer.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f7f6f3; --surface: #fff; --border: #e2dfd7;
      --text: #1a1a1a; --muted: #6b7280;
      --font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: ui-monospace, Menlo, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #111110; --surface: #1c1c1b; --border: #333330; --text: #f0ede8; --muted: #9ca3af; }
    }
    body { font-family: var(--font); background: var(--bg); color: var(--text); padding: 2rem 1rem; }
    .notebook { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.25rem; }
    h1.nb-title { font-size: 1.9rem; font-weight: 700; margin-bottom: 0.25rem; }
    .cell { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .cell-text { padding: 1.1rem 1.25rem; line-height: 1.75; }
    .cell-text h1 { font-size: 1.55rem; font-weight: 700; margin-bottom: .5rem; }
    .cell-text h2 { font-size: 1.25rem; font-weight: 700; margin: 1rem 0 .4rem; }
    .cell-text h3 { font-size: 1.05rem; font-weight: 600; margin: .9rem 0 .3rem; }
    .cell-text p  { margin-bottom: .75rem; }
    .cell-text p:last-child { margin-bottom: 0; }
    .cell-text ul, .cell-text ol { padding-left: 1.4rem; margin-bottom: .75rem; }
    .cell-text code { background: #f3f2ef; padding: .1em .35em; border-radius: 3px; font-family: var(--mono); font-size: .86em; }
    .cell-text pre  { background: #f3f2ef; border: 1px solid var(--border); padding: .75rem; border-radius: 6px; overflow-x: auto; margin-bottom: .75rem; }
    .cell-text pre code { background: none; padding: 0; }
    .cell-text blockquote { border-left: 3px solid var(--border); padding-left: .8rem; color: var(--muted); margin-bottom: .75rem; }
    .cell-text a { color: #2563eb; }
    .cell-text strong { font-weight: 600; }
    .cell-board { padding: 1rem; }
    .board-label { font-weight: 600; margin-bottom: .6rem; }
    .lpv--overlay { display: none !important; }
  </style>
</head>
<body>
  <div class="notebook">
    <h1 class="nb-title">${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
  <script src="https://cdn.jsdelivr.net/npm/@lichess-org/pgn-viewer@1/dist/pgn-viewer.umd.js"><\/script>
  <script>
    document.querySelectorAll('.board-viewer').forEach(function (el) {
      LichessPgnViewer(el, {
        pgn:         el.dataset.pgn || '',
        orientation: el.dataset.orientation || 'white',
        showCoords:  true,
      });
    });
  <\/script>
</body>
</html>`;
}

// ── File download ─────────────────────────────────────────────────────────────

function downloadBlob(content, type, filename) {
  const blob = new Blob([content], { type });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

(function init() {
  // Restore auto-saved session if present
  try {
    const saved = localStorage.getItem('cellular-notebook');
    if (saved) {
      loadNotebook(JSON.parse(saved));
      return;
    }
  } catch { /* corrupted — start fresh */ }

  updateEmptyState();
}());
