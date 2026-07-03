import LichessPgnViewer from 'https://esm.sh/@lichess-org/pgn-viewer@2.6.0?bundle';
import { marked } from 'https://esm.sh/marked@14';
import { Chess } from 'https://esm.sh/chess.js@1?bundle';
import { Chessground } from 'https://esm.sh/@lichess-org/chessground?bundle';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  studyId:      null,  // currently loaded study
  title:        '',
  cells:        [],
  studiesIndex: [],    // [{ id, title, date, updatedAt }] — metadata only
};

const viewerInstances = new Map();   // cellId → LichessPgnViewer instance
const editInstances   = new Map();   // cellId → { chess, ground } when in edit mode
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

// ── Storage ───────────────────────────────────────────────────────────────────

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

// ── Board viewer management ───────────────────────────────────────────────────

function mountViewer(cellId, pgn, orientation = 'white', showMoves = true) {
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cellEl) return;
  const wrap = cellEl.querySelector('.board-viewer-wrap');
  if (!wrap) return;

  // Destroy existing instance if the library supports it
  const existing = viewerInstances.get(cellId);
  if (existing && typeof existing.destroy === 'function') existing.destroy();

  // Always create a fresh container element — Snabbdom (inside pgn-viewer) patches
  // the element's attributes and removes any `id` we set, so we can't rely on
  // getElementById after the first mount.  Starting fresh avoids stale vdom too.
  wrap.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'board-viewer';
  wrap.appendChild(container);

  const instance = LichessPgnViewer(container, {
    pgn: pgn || '',
    orientation,
    showCoords: true,
    drawArrows: true,
    scrollToMove: false,
    showMoves: showMoves ? 'auto' : false,
    menu: {
      getPgn: { enabled: false }, // we have our own Export button
      // analysisBoard + practiceWithComputer stay enabled (open Lichess)
    },
  });
  viewerInstances.set(cellId, instance);
}

// ── Board edit mode ───────────────────────────────────────────────────────────

function getLegalMoveDests(chess) {
  const dests = new Map();
  chess.moves({ verbose: true }).forEach(m => {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  });
  return dests;
}

function enterEditMode(cellId) {
  const cell = getCell(cellId);
  if (!cell) return;
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cellEl) return;
  const wrap = cellEl.querySelector('.board-viewer-wrap');
  if (!wrap) return;

  // Tear down the pgn-viewer
  const existing = viewerInstances.get(cellId);
  if (existing && typeof existing.destroy === 'function') existing.destroy();
  viewerInstances.delete(cellId);
  wrap.innerHTML = '';

  // Parse PGN — start chessground from the final position of the game
  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }

  // Chessground needs a .cg-wrap element
  const cgWrap = document.createElement('div');
  cgWrap.className = 'cg-wrap cg-edit-board';
  wrap.appendChild(cgWrap);

  const ground = Chessground(cgWrap, {
    fen: chess.fen(),
    orientation: cell.orientation || 'white',
    turnColor: chess.turn() === 'w' ? 'white' : 'black',
    movable: {
      free: false,
      color: 'both',
      dests: getLegalMoveDests(chess),
      events: {
        after(from, to) {
          // Auto-promote to queen (promotion UI is a future enhancement)
          const move = chess.move({ from, to, promotion: 'q' });
          if (!move) return;

          const newPgn = chess.pgn();
          updateCellData(cellId, { pgn: newPgn });

          // Append annotation row for the new move
          const hist = chess.history({ verbose: true });
          const last = hist[hist.length - 1];
          const num  = Math.floor((hist.length - 1) / 2) + 1;
          const lbl  = last.color === 'w' ? `${num}. ${last.san}` : `${num}… ${last.san}`;
          appendAnnotationRow(cellId, lbl, chess.fen());

          // Update board for next move
          ground.set({
            fen: chess.fen(),
            turnColor: chess.turn() === 'w' ? 'white' : 'black',
            movable: { dests: getLegalMoveDests(chess) },
          });
        }
      }
    },
    drawable: { enabled: true, visible: true },
    draggable: { enabled: true },
    selectable: { enabled: true },
  });

  editInstances.set(cellId, { chess, ground });

  // Show annotation panel alongside the board
  cellEl.classList.add('edit-mode');
  refreshAnnotationPanel(cellId);
  cellEl.querySelector('.annotation-panel').classList.add('is-visible');

  const btn = cellEl.querySelector('.edit-moves-btn');
  if (btn) { btn.textContent = '✓ Done'; btn.classList.add('active'); }
}

function exitEditMode(cellId) {
  rebuildPgnWithAnnotations(cellId);  // persist any annotations typed this session

  const inst = editInstances.get(cellId);
  if (inst?.ground?.destroy) inst.ground.destroy();
  editInstances.delete(cellId);

  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (cellEl) {
    cellEl.classList.remove('edit-mode');
    cellEl.querySelector('.annotation-panel').classList.remove('is-visible');
  }

  const cell = getCell(cellId);
  mountViewer(cellId, cell.pgn, cell.orientation, true);

  const btn = cellEl?.querySelector('.edit-moves-btn');
  if (btn) { btn.textContent = '✏ Edit'; btn.classList.remove('active'); }
}

// ── Annotations ───────────────────────────────────────────────────────────────

// Append one row (called after each new move in edit mode)
function appendAnnotationRow(cellId, label, fen) {
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  const list   = cellEl?.querySelector('.annotation-list');
  if (!list) return;
  list.querySelector('.annotation-panel-empty')?.remove();
  _addRowToList(list, cellId, label, fen, '');
  list.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Rebuild the full annotation list from the cell's current PGN
function refreshAnnotationPanel(cellId) {
  const cell   = getCell(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  const list   = cellEl?.querySelector('.annotation-list');
  if (!cell || !list) return;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }
  const history = chess.history({ verbose: true });

  if (history.length === 0) {
    list.innerHTML = '<div class="annotation-panel-empty">Make moves on the board to see them here.</div>';
    return;
  }

  const commentsByFen = new Map(
    (chess.getComments?.() || []).map(({ fen, comment }) => [fen, comment])
  );

  const walker = new Chess();
  list.innerHTML = '';
  history.forEach((mv, i) => {
    walker.move(mv.san);
    const num   = Math.floor(i / 2) + 1;
    const label = mv.color === 'w' ? `${num}. ${mv.san}` : `${num}… ${mv.san}`;
    const fen   = walker.fen();
    _addRowToList(list, cellId, label, fen, commentsByFen.get(fen) || '');
  });
}

// Shared row factory
function _addRowToList(list, cellId, label, fen, comment) {
  const row = document.createElement('div');
  row.className = 'annotation-row';
  row.dataset.fen = fen;
  row.innerHTML =
    `<div class="annotation-move-label">${escapeHtml(label)}</div>` +
    `<textarea class="annotation-textarea" placeholder="Note for this move…">${escapeHtml(comment)}</textarea>`;
  let debounce;
  row.querySelector('.annotation-textarea').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => rebuildPgnWithAnnotations(cellId), 400);
  });
  list.appendChild(row);
}

// Collect textarea values and rewrite cell.pgn with embedded PGN comments
function rebuildPgnWithAnnotations(cellId) {
  const cell   = getCell(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cell || !cellEl) return;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }
  const history = chess.history({ verbose: true });

  chess.reset();
  if (chess.deleteComments) chess.deleteComments();

  const fenToComment = new Map();
  cellEl.querySelectorAll('.annotation-row').forEach(row => {
    const comment = row.querySelector('.annotation-textarea')?.value?.trim();
    if (comment) fenToComment.set(row.dataset.fen, comment);
  });

  history.forEach(mv => {
    chess.move(mv.san);
    const comment = fenToComment.get(chess.fen());
    if (comment && chess.setComment) chess.setComment(comment);
  });

  updateCellData(cellId, { pgn: chess.pgn() });
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
        ${hasContent ? 'Preview' : '✏ Edit'}
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
      <button class="btn-icon edit-moves-btn" title="Make moves and annotate">✏ Edit</button>
      <button class="btn-icon flip-board" title="Flip board">⇅ Flip</button>
      <button class="btn-icon export-board" title="Export as PGN">⬇ PGN</button>
      <button class="btn-icon move-up" title="Move up">↑</button>
      <button class="btn-icon move-down" title="Move down">↓</button>
      <button class="btn-icon danger delete-cell" title="Delete cell">✕</button>
    </div>
    <div class="cell-body">
      <div class="board-viewer-wrap"></div>
      <div class="annotation-panel">
        <div class="annotation-list"></div>
      </div>
    </div>`;

  div.querySelector('.board-title-input').addEventListener('input', e => {
    updateCellData(cell.id, { title: e.target.value });
  });

  div.querySelector('.edit-moves-btn').addEventListener('click', () => {
    if (editInstances.has(cell.id)) exitEditMode(cell.id);
    else enterEditMode(cell.id);
  });

  div.querySelector('.flip-board').addEventListener('click', () => {
    if (editInstances.has(cell.id)) exitEditMode(cell.id);
    const c    = getCell(cell.id);
    const next = c.orientation === 'white' ? 'black' : 'white';
    updateCellData(cell.id, { orientation: next });
    mountViewer(cell.id, c.pgn, next, true);
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

  const editInst = editInstances.get(id);
  if (editInst?.ground?.destroy) editInst.ground.destroy();
  editInstances.delete(id);

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

// ── Sidebar + study management ────────────────────────────────────────────

document.getElementById('sidebarToggle').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-open');
});

function handleNewEntry() { saveCurrentStudy(); createNewStudy(); }
document.getElementById('newEntryBtn').addEventListener('click', handleNewEntry);
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
  viewerInstances.forEach(inst => { if (typeof inst?.destroy === 'function') inst.destroy(); });
  viewerInstances.clear();
  editInstances.forEach(inst => { if (inst?.ground?.destroy) inst.ground.destroy(); });
  editInstances.clear();
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
      requestAnimationFrame(() => mountViewer(cell.id, cell.pgn, cell.orientation));
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
  const pgn  = cell.pgn || '';
  const name = (cell.title || 'board').replace(/[^a-z0-9]/gi, '-').toLowerCase() || 'board';
  downloadBlob(pgn, 'application/x-chess-pgn', name + '.pgn');
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
  <link rel="stylesheet" href="https://unpkg.com/@lichess-org/pgn-viewer@2.6.0/dist/lichess-pgn-viewer.css">
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
  <script type="module">
    import LichessPgnViewer from 'https://esm.sh/@lichess-org/pgn-viewer@2.6.0?bundle';
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
