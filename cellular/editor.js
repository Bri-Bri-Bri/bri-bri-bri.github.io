import { marked } from 'https://esm.sh/marked@14';
import { state } from './state.js';
import {
  mountBoard, navTo, setEditMode, undoLastMove, rebuildPgnWithAnnotations,
  getBoardInstance, destroyBoardInstance, clearAllBoardInstances,
} from './board.js';
import { openSavePuzzleDialog } from './puzzles.js';

// ── IDs ───────────────────────────────────────────────────────────────────────

export function uid() {
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

export function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function getCell(id) {
  return state.cells.find(c => c.id === id);
}

export function updateCellData(id, patch) {
  const cell = getCell(id);
  if (cell) Object.assign(cell, patch);
  scheduleAutoSave();
}

// ── Storage ───────────────────────────────────────────────────────────────────

let autoSaveTimer = null;

function loadIndex() {
  try { return JSON.parse(localStorage.getItem('cellular-index') || '[]'); }
  catch { return []; }
}
function saveIndex() {
  try { localStorage.setItem('cellular-index', JSON.stringify(state.studiesIndex)); } catch {}
}
function loadStudyData(id) {
  try { return JSON.parse(localStorage.getItem('cellular-study-' + id)); } catch { return null; }
}
function saveStudyData(id, data) {
  try { localStorage.setItem('cellular-study-' + id, JSON.stringify(data)); } catch {}
}

function scheduleAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(saveCurrentStudy, 1500);
}

function saveCurrentStudy() {
  if (!state.studyId) return;
  saveStudyData(state.studyId, { id: state.studyId, title: state.title, cells: state.cells });
  const idx = state.studiesIndex.findIndex(s => s.id === state.studyId);
  if (idx !== -1) {
    state.studiesIndex[idx].title     = state.title;
    state.studiesIndex[idx].updatedAt = new Date().toISOString();
    saveIndex();
    renderSidebar();
  }
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
      <button class="btn-icon preview-toggle" title="Toggle edit/preview">
        ${hasContent ? '✏ Edit' : 'Preview'}
      </button>
      <button class="btn-icon move-up" title="Move up">↑</button>
      <button class="btn-icon move-down" title="Move down">↓</button>
      <div class="cell-insert-wrap">
        <button class="btn-icon cell-insert-btn" title="Insert cell after">⊕</button>
        <div class="cell-insert-dropdown">
          <button class="insert-text-btn">+ Text</button>
          <button class="insert-board-btn">+ Board</button>
        </div>
      </div>
      <button class="btn-icon danger delete-cell" title="Delete cell">✕</button>
    </div>
    <div class="cell-body">
      <textarea class="md-editor" placeholder="Write markdown here…" style="${hasContent ? 'display:none' : ''}">${escapeHtml(cell.content)}</textarea>
      <div class="md-preview" style="${hasContent ? '' : 'display:none'}">${hasContent ? renderMarkdown(cell.content) : ''}</div>
    </div>`;

  const ta      = div.querySelector('.md-editor');
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
      toggle.textContent    = '✏ Edit';
      toggle.classList.remove('active');
    } else {
      // → switch to edit
      ta.style.display      = '';
      preview.style.display = 'none';
      toggle.textContent    = 'Preview';
      toggle.classList.add('active');
      ta.focus();
    }
  });

  ta.addEventListener('input', e => updateCellData(cell.id, { content: e.target.value }));

  _bindInsertBtn(div, cell.id);

  return div;
}

function buildBoardCell(cell) {
  const div = document.createElement('div');
  div.className = 'cell cell-board';
  div.dataset.id = cell.id;

  div.innerHTML = `
    <div class="cell-toolbar">
      <span class="cell-type-tag">Board</span>
      <input class="board-title-input" type="text" placeholder="Position title\u2026" value="${escapeAttr(cell.title || '')}">
      <div class="spacer"></div>
      <button class="btn-icon edit-moves-btn" title="Annotate moves">\u270f Edit</button>
      <button class="btn-icon undo-btn" title="Undo last move">\u21a9 Undo</button>
      <button class="btn-icon pgn-editor-btn" title="Edit / paste PGN">\u270e PGN</button>
      <button class="btn-icon flip-board" title="Flip board">\u21c5 Flip</button>
      <button class="btn-icon save-puzzle-btn" title="Save position as puzzle">\u{1F9E9}</button>
      <button class="btn-icon move-up" title="Move up">\u2191</button>
      <button class="btn-icon move-down" title="Move down">\u2193</button>
      <div class="cell-insert-wrap">
        <button class="btn-icon cell-insert-btn" title="Insert cell after">\u2295</button>
        <div class="cell-insert-dropdown">
          <button class="insert-text-btn">+ Text</button>
          <button class="insert-board-btn">+ Board</button>
        </div>
      </div>
      <button class="btn-icon danger delete-cell" title="Delete cell">\u2715</button>
    </div>
    <div class="board-game-header" hidden>
      <div class="gh-players">
        <span class="gh-white"></span>
        <span class="gh-vs"> vs </span>
        <span class="gh-black"></span>
        <span class="gh-result"></span>
      </div>
      <div class="gh-meta">
        <span class="gh-date"></span>
        <span class="gh-opening"></span>
      </div>
    </div>
    <div class="cell-body">
      <div class="board-viewer-wrap"></div>
      <div class="annotation-panel">
        <div class="annotation-nav">
          <button class="btn-icon nav-first" title="First move">\u23ee</button>
          <button class="btn-icon nav-prev"  title="Previous move">\u25c4</button>
          <span class="nav-ply-counter"></span>
          <button class="btn-icon nav-next"  title="Next move">\u25ba</button>
          <button class="btn-icon nav-last"  title="Last move">\u23ed</button>
          <a class="nav-game-link" target="_blank" rel="noopener noreferrer" title="Open game" hidden>\u2197</a>
        </div>
        <div class="annotation-list"></div>
      </div>
    </div>`;

  div.querySelector('.board-title-input').addEventListener('input', e => {
    updateCellData(cell.id, { title: e.target.value });
  });

  div.querySelector('.edit-moves-btn').addEventListener('click', () => {
    const inst    = getBoardInstance(cell.id);
    const editing = inst ? !inst.isEditing : true;
    if (!editing) rebuildPgnWithAnnotations(cell.id);
    setEditMode(cell.id, editing);
  });

  div.querySelector('.undo-btn').addEventListener('click', () => undoLastMove(cell.id));

  div.querySelector('.flip-board').addEventListener('click', () => {
    const c          = getCell(cell.id);
    const inst       = getBoardInstance(cell.id);
    const savedPly   = inst?.plyIdx ?? 0;
    const wasEditing = inst?.isEditing ?? false;
    if (wasEditing) rebuildPgnWithAnnotations(cell.id);
    updateCellData(cell.id, { orientation: c.orientation === 'white' ? 'black' : 'white' });
    mountBoard(cell.id);
    if (savedPly > 0) {
      const ni = getBoardInstance(cell.id);
      if (ni) navTo(cell.id, Math.min(savedPly, ni.fens.length - 1));
    }
    if (wasEditing) setEditMode(cell.id, true);
  });

  //div.querySelector('.export-board').addEventListener('click', () => exportBoard(cell.id));
  div.querySelector('.pgn-editor-btn').addEventListener('click', () => openPgnEditor(cell.id));
  div.querySelector('.save-puzzle-btn').addEventListener('click', () => openSavePuzzleDialog(cell.id));

  // Move navigation
  div.querySelector('.nav-first').addEventListener('click', () => navTo(cell.id, 0));
  div.querySelector('.nav-prev').addEventListener('click', () => {
    const inst = getBoardInstance(cell.id); if (inst) navTo(cell.id, inst.plyIdx - 1);
  });
  div.querySelector('.nav-next').addEventListener('click', () => {
    const inst = getBoardInstance(cell.id); if (inst) navTo(cell.id, inst.plyIdx + 1);
  });
  div.querySelector('.nav-last').addEventListener('click', () => {
    const inst = getBoardInstance(cell.id); if (inst) navTo(cell.id, inst.fens.length - 1);
  });

  _bindInsertBtn(div, cell.id);

  return div;
}

function renderMarkdown(content) {
  if (!content) return '';
  return marked.parse(content);
}

// Shared: wire up the ⊕ insert-after dropdown on any cell element
function _bindInsertBtn(cellEl, cellId) {
  const wrap = cellEl.querySelector('.cell-insert-wrap');
  const btn  = wrap.querySelector('.cell-insert-btn');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains('is-open');
    // Close any other open insert dropdowns
    document.querySelectorAll('.cell-insert-wrap.is-open').forEach(w => w.classList.remove('is-open'));
    if (!wasOpen) {
      wrap.classList.add('is-open');
      const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('click', close); };
      document.addEventListener('click', close);
    }
  });
  wrap.querySelector('.insert-text-btn').addEventListener('click',  () => insertCellAfter(cellId, 'text'));
  wrap.querySelector('.insert-board-btn').addEventListener('click', () => insertCellAfter(cellId, 'board'));
}

function insertCellAfter(afterId, type) {
  const idx = state.cells.findIndex(c => c.id === afterId);
  if (idx === -1) return;
  const cell  = type === 'text' ? newTextCell() : newBoardCell();
  state.cells.splice(idx + 1, 0, cell);
  const el    = type === 'text' ? buildTextCell(cell) : buildBoardCell(cell);
  const afterEl = document.querySelector(`.cell[data-id="${CSS.escape(afterId)}"]`);
  afterEl ? afterEl.insertAdjacentElement('afterend', el) : document.getElementById('notebook').appendChild(el);
  updateEmptyState();
  if (type === 'board') requestAnimationFrame(() => mountBoard(cell.id));
  requestAnimationFrame(() => {
    const focus = el.querySelector(type === 'text' ? '.md-editor' : '.board-title-input');
    if (focus) focus.focus();
  });
  scheduleAutoSave();
}

// ── Notebook mutations ────────────────────────────────────────────────────────

function addCell(type) {
  const cell = type === 'text' ? newTextCell() : newBoardCell();
  state.cells.push(cell);

  const el = type === 'text' ? buildTextCell(cell) : buildBoardCell(cell);
  document.getElementById('notebook').appendChild(el);
  updateEmptyState();

  if (type === 'board') {
    requestAnimationFrame(() => mountBoard(cell.id));
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

  destroyBoardInstance(id);
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

// ── Sidebar + study management ────────────────────────────────────────────────

document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});

function handleNewEntry() { saveCurrentStudy(); createNewStudy(); }
document.getElementById('sidebarNewBtn').addEventListener('click', handleNewEntry);

function todayTitle() {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function createNewStudy() {
  let title = todayTitle();
  const dupes = state.studiesIndex.filter(s => s.title === title || s.title.startsWith(title + ' ('));
  if (dupes.length > 0) title = `${title} (${dupes.length + 1})`;

  const id  = uid();
  const now = new Date().toISOString();
  state.studiesIndex.unshift({ id, title, date: now, updatedAt: now });
  saveIndex();
  loadStudyIntoEditor({ id, title, cells: [] });
}

function openStudy(id) {
  saveCurrentStudy();
  const data = loadStudyData(id);
  if (data) loadStudyIntoEditor(data);
}

function loadStudyIntoEditor(data) {
  clearAllBoardInstances();
  state.cells = [];
  document.getElementById('notebook').innerHTML = '';

  state.studyId = data.id;
  state.title   = data.title || todayTitle();
  document.getElementById('notebookTitle').value = state.title;

  (data.cells || []).forEach(cell => {
    state.cells.push(cell);
    const el = cell.type === 'text' ? buildTextCell(cell) : buildBoardCell(cell);
    document.getElementById('notebook').appendChild(el);
    if (cell.type === 'board') {
      requestAnimationFrame(() => mountBoard(cell.id));
    }
  });

  updateEmptyState();
  saveStudyData(data.id, { id: data.id, title: state.title, cells: state.cells });
  renderSidebar();
}

function renderSidebar() {
  const container = document.getElementById('sidebar-entries');
  if (!container) return;
  container.innerHTML = '';
  state.studiesIndex.forEach(entry => {
    const div  = document.createElement('div');
    div.className = 'sidebar-entry' + (entry.id === state.studyId ? ' active' : '');
    const d    = new Date(entry.date);
    const meta = isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    div.innerHTML = `
      <div class="entry-info">
        <div class="entry-title">${escapeHtml(entry.title)}</div>
        <div class="entry-meta">${escapeHtml(meta)}</div>
      </div>
      <button class="sidebar-delete-btn" title="Delete entry" aria-label="Delete entry">✕</button>`;
    div.addEventListener('click', () => { if (entry.id !== state.studyId) openStudy(entry.id); });
    div.querySelector('.sidebar-delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteStudy(entry.id);
    });
    container.appendChild(div);
  });
}

function deleteStudy(id) {
  if (!confirm('Delete this diary entry? This cannot be undone.')) return;
  const idx = state.studiesIndex.findIndex(s => s.id === id);
  if (idx === -1) return;
  state.studiesIndex.splice(idx, 1);
  try { localStorage.removeItem('cellular-study-' + id); } catch {}
  saveIndex();
  if (state.studyId === id) {
    // Currently open — switch to nearest entry or create a new one
    if (state.studiesIndex.length > 0) {
      const data = loadStudyData(state.studiesIndex[0].id);
      if (data) { loadStudyIntoEditor(data); return; }
    }
    createNewStudy();
  } else {
    renderSidebar();
  }
}

// ── Export / Import all data ──────────────────────────────────────────────────

document.getElementById('exportAllBtn').addEventListener('click', () => {
  saveCurrentStudy();
  const studies = state.studiesIndex.map(entry => {
    const data = loadStudyData(entry.id) || { id: entry.id, title: entry.title, cells: [] };
    return { ...entry, cells: data.cells || [] };
  });
  const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), studies }, null, 2);
  const filename = 'chess-diary-' + new Date().toISOString().slice(0, 10) + '.json';
  downloadBlob(payload, 'application/json', filename);
});

document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';   // reset so same file can be re-imported
  const reader = new FileReader();
  reader.onload = ev => {
    let imported;
    try { imported = JSON.parse(ev.target.result); } catch {
      alert('Could not parse the file — is it valid JSON?'); return;
    }
    const studies = imported.studies ?? imported;   // accept bare array too
    if (!Array.isArray(studies) || studies.length === 0) {
      alert('No diary entries found in the file.'); return;
    }
    const newCount = studies.filter(s => !state.studiesIndex.find(e => e.id === s.id)).length;
    const updCount = studies.filter(s =>  state.studiesIndex.find(e => e.id === s.id)).length;
    const msg = [
      `Import ${studies.length} entr${studies.length === 1 ? 'y' : 'ies'}?`,
      newCount  ? `  • ${newCount} new`     : '',
      updCount  ? `  • ${updCount} updated` : '',
    ].filter(Boolean).join('\n');
    if (!confirm(msg)) return;

    studies.forEach(s => {
      const { cells, date, updatedAt, title, id } = s;
      if (!id) return;
      saveStudyData(id, { id, title: title || 'Imported', cells: cells || [] });
      const existing = state.studiesIndex.findIndex(e => e.id === id);
      if (existing !== -1) {
        state.studiesIndex[existing] = { ...state.studiesIndex[existing], title: title || 'Imported', updatedAt: updatedAt || new Date().toISOString() };
      } else {
        state.studiesIndex.push({ id, title: title || 'Imported', date: date || new Date().toISOString(), updatedAt: updatedAt || new Date().toISOString() });
      }
    });
    // Sort newest-first by date
    state.studiesIndex.sort((a, b) => new Date(b.date) - new Date(a.date));
    saveIndex();
    renderSidebar();
  };
  reader.readAsText(file);
});

// ── Export ────────────────────────────────────────────────────────────────────

document.getElementById('exportDiaryBtn').addEventListener('click', exportDiaryAsHtml);

function exportDiaryAsHtml() {
  saveCurrentStudy();
  const studies = state.studiesIndex.map(entry => {
    const data = loadStudyData(entry.id) || { id: entry.id, title: entry.title, cells: [] };
    return { id: entry.id, title: entry.title, date: entry.date, cells: data.cells || [] };
  });
  const filename = 'chess-diary-' + new Date().toISOString().slice(0, 10) + '.html';
  downloadBlob(buildDiaryExportPage(studies), 'text/html', filename);
}

function exportBoard(id) {
  const cell = getCell(id);
  if (!cell) return;
  const pgn  = cell.pgn || '';
  const name = (cell.title || 'board').replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'board';
  downloadBlob(pgn, 'application/x-chess-pgn', name + '.pgn');
}

function buildDiaryExportPage(studies) {
  // Safely embed JSON — escape any </script> sequences inside string values
  const safeStudies = JSON.stringify(studies).replace(/<\/script>/gi, '<\\/script>');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chess Diary</title>
  <link rel="stylesheet" href="https://unpkg.com/@lichess-org/pgn-viewer@2.6.0/dist/lichess-pgn-viewer.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --sb-w: 240px;
      --bg: #f7f6f3; --surface: #fff; --border: #e2dfd7;
      --text: #1a1a1a; --muted: #6b7280; --faint: #a0a09a;
      --accent: #2563eb;
      --font: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      --mono: ui-monospace, Menlo, monospace;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #111110; --surface: #1c1c1b; --border: #333330; --text: #f0ede8; --muted: #9ca3af; --faint: #55554e; }
    }
    html, body { height: 100%; overflow: hidden; }
    body { display: flex; font-family: var(--font); background: var(--bg); color: var(--text); }

    /* Sidebar */
    #diary-sidebar {
      width: var(--sb-w); flex-shrink: 0;
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      height: 100vh; overflow: hidden;
      background: var(--surface);
    }
    .sb-header {
      padding: 0.9rem 1rem 0.75rem;
      font-size: 1rem; font-weight: 700;
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 0.45rem;
      flex-shrink: 0;
    }
    #entry-list { flex: 1; overflow-y: auto; padding: 0.35rem 0; }
    .entry-item {
      padding: 0.55rem 0.85rem;
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background 0.1s, border-color 0.1s;
    }
    .entry-item:hover { background: color-mix(in srgb, var(--accent) 6%, var(--bg)); }
    .entry-item.active {
      background: color-mix(in srgb, var(--accent) 9%, transparent);
      border-left-color: var(--accent);
    }
    .entry-title { font-size: 0.84rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .entry-date  { font-size: 0.71rem; color: var(--faint); margin-top: 0.1rem; }
    .sb-empty    { padding: 1rem; font-size: 0.82rem; color: var(--faint); }

    /* Main content */
    #diary-content { flex: 1; min-width: 0; height: 100vh; overflow-y: auto; padding: 2rem 1.5rem; }
    #entry-view { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.1rem; }
    .entry-heading { font-size: 1.75rem; font-weight: 700; padding-bottom: 0.6rem; border-bottom: 1px solid var(--border); }
    .view-empty { color: var(--faint); font-size: 0.9rem; padding: 2rem 0; }

    /* Cells */
    .cell { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .cell-text { padding: 1.1rem 1.25rem; line-height: 1.75; }
    .cell-text h1 { font-size: 1.45rem; font-weight: 700; margin-bottom: .5rem; }
    .cell-text h2 { font-size: 1.2rem;  font-weight: 700; margin: 1rem 0 .4rem; }
    .cell-text h3 { font-size: 1.0rem;  font-weight: 600; margin: .9rem 0 .3rem; }
    .cell-text p  { margin-bottom: .75rem; }
    .cell-text p:last-child { margin-bottom: 0; }
    .cell-text ul, .cell-text ol { padding-left: 1.4rem; margin-bottom: .75rem; }
    .cell-text code { background: color-mix(in srgb, var(--border) 60%, transparent); padding: .1em .35em; border-radius: 3px; font-family: var(--mono); font-size: .86em; }
    .cell-text pre { background: color-mix(in srgb, var(--border) 40%, transparent); border: 1px solid var(--border); padding: .75rem; border-radius: 6px; overflow-x: auto; margin-bottom: .75rem; }
    .cell-text pre code { background: none; padding: 0; }
    .cell-text blockquote { border-left: 3px solid var(--border); padding-left: .8rem; color: var(--muted); margin-bottom: .75rem; }
    .cell-text a { color: var(--accent); }
    .cell-text strong { font-weight: 600; }
    .cell-text em { font-style: italic; }
    .cell-board { padding: 1rem; }
    .board-label { font-weight: 600; margin-bottom: .6rem; }
    .lpv--overlay { display: none !important; }

    @media (max-width: 600px) {
      :root { --sb-w: 180px; }
      #diary-content { padding: 1.25rem 1rem; }
    }
  </style>
</head>
<body>
  <nav id="diary-sidebar">
    <div class="sb-header">&#x265f; Chess Diary</div>
    <div id="entry-list"></div>
  </nav>
  <div id="diary-content">
    <div id="entry-view"></div>
  </div>
  <script type="module">
    import { marked } from 'https://esm.sh/marked@14';
    import LichessPgnViewer from 'https://esm.sh/@lichess-org/pgn-viewer@2.6.0?bundle';

    const STUDIES = ${safeStudies};

    function esc(s)     { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
    function escAttr(s) { return s ? s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : ''; }
    function fmtDate(d) {
      const dt = new Date(d);
      return isNaN(dt) ? '' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    const view    = document.getElementById('entry-view');
    const content = document.getElementById('diary-content');
    const list    = document.getElementById('entry-list');
    let activeItem = null;

    function showEntry(study) {
      view.innerHTML = '';
      const heading = Object.assign(document.createElement('h2'), { className: 'entry-heading', textContent: study.title || 'Untitled' });
      view.appendChild(heading);

      if (!study.cells || study.cells.length === 0) {
        view.appendChild(Object.assign(document.createElement('p'), { className: 'view-empty', textContent: 'No content in this entry.' }));
        return;
      }

      study.cells.forEach(cell => {
        const el = document.createElement('div');
        if (cell.type === 'text') {
          el.className = 'cell cell-text';
          el.innerHTML = marked.parse(cell.content || '');
        } else {
          el.className = 'cell cell-board';
          const label = cell.title ? \`<p class="board-label">\${esc(cell.title)}</p>\` : '';
          el.innerHTML = label + \`<div class="board-viewer" data-pgn="\${escAttr(cell.pgn||'')}" data-orientation="\${escAttr(cell.orientation||'white')}"></div>\`;
        }
        view.appendChild(el);
      });

      view.querySelectorAll('.board-viewer').forEach(el => {
        LichessPgnViewer(el, { pgn: el.dataset.pgn || '', orientation: el.dataset.orientation || 'white', showCoords: true });
      });

      content.scrollTop = 0;
    }

    if (STUDIES.length === 0) {
      list.innerHTML = '<p class="sb-empty">No entries.</p>';
    } else {
      STUDIES.forEach(study => {
        const item = document.createElement('div');
        item.className = 'entry-item';
        item.innerHTML = \`<div class="entry-title">\${esc(study.title)}</div><div class="entry-date">\${fmtDate(study.date)}</div>\`;
        item.addEventListener('click', () => {
          activeItem?.classList.remove('active');
          item.classList.add('active');
          activeItem = item;
          showEntry(study);
        });
        list.appendChild(item);
      });
      list.firstElementChild.classList.add('active');
      activeItem = list.firstElementChild;
      showEntry(STUDIES[0]);
    }
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

// ── Settings ──────────────────────────────────────────────────────────────────

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('cellular-settings') || '{}'); } catch { return {}; }
}
function saveSettings(data) {
  try { localStorage.setItem('cellular-settings', JSON.stringify(data)); } catch {}
}

const settingsModal = document.getElementById('settingsModal');

function openSettingsModal() {
  const s = loadSettings();
  document.getElementById('settingsLichess').value     = s.lichessUser  || '';
  document.getElementById('settingsChesscom').value    = s.chesscomUser || '';
  document.getElementById('settingsMaxGames').value    = s.maxGames     || 30;
  document.getElementById('settingsBoardTheme').value  = s.boardTheme   || 'auto';
  settingsModal.classList.add('is-open');
}
function closeSettingsModal() { settingsModal.classList.remove('is-open'); }

document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('settingsClose').addEventListener('click', closeSettingsModal);
settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettingsModal(); });
settingsModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettingsModal(); });

document.getElementById('settingsSave').addEventListener('click', () => {
  saveSettings({
    lichessUser:  document.getElementById('settingsLichess').value.trim(),
    chesscomUser: document.getElementById('settingsChesscom').value.trim(),
    maxGames:     parseInt(document.getElementById('settingsMaxGames').value, 10) || 30,
    boardTheme:   document.getElementById('settingsBoardTheme').value,
  });
  closeSettingsModal();
});

// ── Game APIs ─────────────────────────────────────────────────────────────────

async function fetchLichessGames(username, max) {
  const res = await fetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${max}&pgnInJson=true&opening=true&tags=true`,
    { headers: { Accept: 'application/x-ndjson' } }
  );
  if (!res.ok) throw new Error(`Lichess ${res.status}: could not load games`);
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map(line => {
    const g = JSON.parse(line);
    const isWhite = g.players?.white?.user?.name?.toLowerCase() === username.toLowerCase();
    const opponent = (isWhite ? g.players?.black?.user?.name : g.players?.white?.user?.name) || '?';
    const myColor  = isWhite ? 'white' : 'black';
    const result   = !g.winner ? '½–½' : g.winner === myColor ? '1–0' : '0–1';
    return {
      platform: 'lichess',
      pgn:      g.pgn,
      opponent,
      result,
      myColor,
      speed:    g.speed || g.perf,
      opening:  g.opening?.name,
      date:     new Date(g.createdAt),
    };
  });
}

async function fetchChesscomGames(username, max) {
  const now   = new Date();
  const yyyy  = now.getFullYear();
  const mm    = String(now.getMonth() + 1).padStart(2, '0');
  const urls  = [`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/${yyyy}/${mm}`];
  if (now.getDate() <= 5) {
    const prev  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const py    = prev.getFullYear();
    const pm    = String(prev.getMonth() + 1).padStart(2, '0');
    urls.push(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/${py}/${pm}`);
  }
  const results = await Promise.all(urls.map(u => fetch(u).then(r => r.ok ? r.json() : { games: [] })));
  const games   = results.flatMap(d => d.games || []);
  games.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
  return games.slice(0, max).map(g => {
    const isWhite  = g.white?.username?.toLowerCase() === username.toLowerCase();
    const opponent = (isWhite ? g.black?.username : g.white?.username) || '?';
    const myColor  = isWhite ? 'white' : 'black';
    const myResult = isWhite ? g.white?.result : g.black?.result;
    let result;
    if (myResult === 'win')                                                        result = '1–0';
    else if (['resigned','checkmated','timeout','abandoned','lose'].includes(myResult)) result = '0–1';
    else                                                                           result = '½–½';
    if (myColor === 'black' && result !== '½–½') result = result === '1–0' ? '0–1' : '1–0';
    const openingMatch = g.pgn?.match(/\[Opening "([^"]+)"\]/);
    return {
      platform: 'chesscom',
      pgn:      g.pgn,
      opponent,
      result,
      myColor,
      speed:    g.time_class,
      opening:  openingMatch?.[1],
      date:     new Date((g.end_time || 0) * 1000),
    };
  });
}

// ── Game picker modal ─────────────────────────────────────────────────────────

const gamesModal = document.getElementById('gamesModal');
let _pendingGames = [];

async function openGamesModal() {
  const settings = loadSettings();
  if (!settings.lichessUser && !settings.chesscomUser) {
    openSettingsModal();
    return;
  }

  gamesModal.classList.add('is-open');
  const body = document.getElementById('gamesModalBody');
  body.innerHTML = '<p class="modal-loading">Loading games…</p>';
  document.getElementById('gamesAddBtn').disabled = true;

  const max     = settings.maxGames || 30;
  const fetches = [];
  if (settings.lichessUser)  fetches.push(fetchLichessGames(settings.lichessUser, max));
  if (settings.chesscomUser) fetches.push(fetchChesscomGames(settings.chesscomUser, max));

  const settled = await Promise.allSettled(fetches);
  const games   = settled.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  const errors  = settled.filter(r => r.status === 'rejected').map(r => r.reason?.message || 'Unknown error');
  games.sort((a, b) => b.date - a.date);
  _pendingGames = games;
  _renderGameList(body, games, errors);
}

function closeGamesModal() {
  gamesModal.classList.remove('is-open');
  _pendingGames = [];
}

function _renderGameList(body, games, errors) {
  let html = '';
  if (errors.length) {
    html += `<div class="modal-error">${errors.map(escapeHtml).join('<br>')}</div>`;
  }
  if (games.length === 0) {
    body.innerHTML = html + '<p class="modal-empty">No games found for this period.</p>';
    return;
  }

  html += '<div class="game-select-all"><label><input type="checkbox" id="selectAllGames"> Select all</label></div>';
  html += '<ul class="game-list">';
  games.forEach((g, i) => {
    const badge   = g.platform === 'lichess'
      ? '<span class="platform-badge platform-lichess">L</span>'
      : '<span class="platform-badge platform-chesscom">C</span>';
    const dateStr = g.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  + '\u2009'
                  + g.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    const rClass  = g.result === '1–0' ? (g.myColor === 'white' ? 'result-win' : 'result-loss')
                  : g.result === '0–1' ? (g.myColor === 'black' ? 'result-win' : 'result-loss')
                  : 'result-draw';
    const opening = g.opening ? `<span class="game-opening">${escapeHtml(g.opening)}</span>` : '';
    const speed   = g.speed   ? `<span class="game-speed">${escapeHtml(g.speed)}</span>` : '';
    html += `<li class="game-row">
      <label>
        <input type="checkbox" class="game-check" data-idx="${i}">
        ${badge}
        <span class="game-date">${escapeHtml(dateStr)}</span>
        <span class="game-vs">vs. <strong>${escapeHtml(g.opponent)}</strong></span>
        <span class="game-result ${rClass}">${escapeHtml(g.result)}</span>
        ${speed}${opening}
      </label>
    </li>`;
  });
  html += '</ul>';
  body.innerHTML = html;

  document.getElementById('selectAllGames').addEventListener('change', e => {
    body.querySelectorAll('.game-check').forEach(cb => { cb.checked = e.target.checked; });
    _updateAddBtn();
  });
  body.querySelectorAll('.game-check').forEach(cb => cb.addEventListener('change', _updateAddBtn));
}

function _updateAddBtn() {
  const n   = document.querySelectorAll('#gamesModalBody .game-check:checked').length;
  const btn = document.getElementById('gamesAddBtn');
  btn.disabled    = n === 0;
  btn.textContent = n > 0 ? `Add ${n} game${n > 1 ? 's' : ''} to diary` : 'Add to diary';
}

document.getElementById('gamesBtn').addEventListener('click', openGamesModal);
document.getElementById('gamesClose').addEventListener('click', closeGamesModal);
gamesModal.addEventListener('click', e => { if (e.target === gamesModal) closeGamesModal(); });
gamesModal.addEventListener('keydown', e => { if (e.key === 'Escape') closeGamesModal(); });

document.getElementById('gamesAddBtn').addEventListener('click', () => {
  const checked     = [...document.querySelectorAll('#gamesModalBody .game-check:checked')];
  const newestFirst = document.getElementById('gamesNewestFirst').checked;
  const selected    = checked.map(cb => _pendingGames[parseInt(cb.dataset.idx, 10)]).filter(Boolean);
  selected.sort((a, b) => newestFirst ? b.date - a.date : a.date - b.date);
  selected.forEach(g => {
    const title = `vs. ${g.opponent} (${g.result})`;
    const cell  = newBoardCell(g.pgn || '', title, g.myColor);
    state.cells.push(cell);
    const el = buildBoardCell(cell);
    document.getElementById('notebook').appendChild(el);
    requestAnimationFrame(() => mountBoard(cell.id));
  });
  updateEmptyState();
  scheduleAutoSave();
  closeGamesModal();
});

// ── PGN editor dialog ─────────────────────────────────────────────────────────

function openPgnEditor(cellId) {
  const cell = getCell(cellId);
  if (!cell) return;
  const modal = document.getElementById('pgnEditorModal');
  document.getElementById('pgnEditorTextarea').value = cell.pgn || '';
  modal.classList.add('is-open');
  document.getElementById('pgnEditorTextarea').focus();

  const apply = () => {
    const pgn        = document.getElementById('pgnEditorTextarea').value.trim();
    const inst       = getBoardInstance(cellId);
    const wasEditing = inst?.isEditing ?? false;
    updateCellData(cellId, { pgn });
    mountBoard(cellId);
    if (wasEditing) setEditMode(cellId, true);
    modal.classList.remove('is-open');
  };

  // Replace listener each open to target the right cell
  const applyBtn = document.getElementById('pgnEditorApply');
  const newBtn   = applyBtn.cloneNode(true);
  applyBtn.parentNode.replaceChild(newBtn, applyBtn);
  newBtn.addEventListener('click', apply);
  modal.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') { modal.classList.remove('is-open'); modal.removeEventListener('keydown', handler); }
  }, { once: false });
}

const _closePgnEditor = () => document.getElementById('pgnEditorModal').classList.remove('is-open');
document.getElementById('pgnEditorClose').addEventListener('click', _closePgnEditor);
document.getElementById('pgnEditorClose2').addEventListener('click', _closePgnEditor);
document.getElementById('pgnEditorModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) _closePgnEditor();
});

// ── Boot ───────────────────────────────────────────────────────────────────────

(function init() {
  state.studiesIndex = loadIndex();

  // Migrate from the original single-notebook localStorage key
  const legacy = localStorage.getItem('cellular-notebook');
  if (legacy && state.studiesIndex.length === 0) {
    try {
      const old = JSON.parse(legacy);
      const id  = uid();
      const now = new Date().toISOString();
      state.studiesIndex.push({ id, title: old.title || 'Migrated Study', date: now, updatedAt: now });
      saveStudyData(id, { id, title: old.title || 'Migrated Study', cells: old.cells || [] });
      saveIndex();
      localStorage.removeItem('cellular-notebook');
    } catch {}
  }

  if (state.studiesIndex.length > 0) {
    const data = loadStudyData(state.studiesIndex[0].id);
    if (data) { loadStudyIntoEditor(data); return; }
  }

  createNewStudy();
}());
