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

function mountViewer(cellId, pgn, orientation = 'white', showMoves = true, initialPly = undefined) {
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
    theme: getBoardTheme(),
    initialPly: initialPly ?? 0,
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

  // Parse PGN — start chessground from the final position
  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }

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
          const move = chess.move({ from, to, promotion: 'q' });
          if (!move) return;
          updateCellData(cellId, { pgn: chess.pgn() });
          const hist = chess.history({ verbose: true });
          const last = hist[hist.length - 1];
          const num  = Math.floor((hist.length - 1) / 2) + 1;
          const lbl  = last.color === 'w' ? `${num}. ${last.san}` : `${num}… ${last.san}`;
          appendAnnotationRow(cellId, lbl, chess.fen());
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
  cellEl.classList.add('edit-mode');
  refreshAnnotationPanel(cellId);
  cellEl.querySelector('.annotation-panel').classList.add('is-visible');
  const btn = cellEl.querySelector('.edit-moves-btn');
  if (btn) { btn.textContent = '✓ Done'; btn.classList.add('active'); }
}

function exitEditMode(cellId) {
  rebuildPgnWithAnnotations(cellId);
  const inst = editInstances.get(cellId);
  if (inst?.ground?.destroy) inst.ground.destroy();
  editInstances.delete(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cellEl) return;
  cellEl.classList.remove('edit-mode');
  cellEl.querySelector('.annotation-panel').classList.remove('is-visible');
  const btn = cellEl.querySelector('.edit-moves-btn');
  if (btn) { btn.textContent = '✏ Edit'; btn.classList.remove('active'); }
  const cell = getCell(cellId);
  mountViewer(cellId, cell.pgn, cell.orientation, true);
}

// ── Annotations ───────────────────────────────────────────────────────────────

// Append one row after a new move is made on the Chessground board
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
    list.innerHTML = '<div class="annotation-panel-empty">No moves yet — use “✎ PGN” to paste a game.</div>';
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
    // Only show user-written text, not machine annotations like [%clk]
    _addRowToList(list, cellId, label, fen, _userText(commentsByFen.get(fen) || ''));
  });
}

// Navigate the Chessground board (in edit mode) to a specific FEN.
// At non-final positions the board is view-only; at the final position moves are re-enabled.
function _navigateBoardToFen(cellId, fen) {
  const inst = editInstances.get(cellId);
  if (!inst) return;
  const { chess, ground } = inst;

  // Highlight the clicked row, clear others
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  cellEl?.querySelectorAll('.annotation-row').forEach(r => r.classList.remove('active'));
  cellEl?.querySelector(`.annotation-row[data-fen="${fen}"]`)?.classList.add('active');

  const isEnd = fen === chess.fen();
  const tempChess = new Chess(fen);
  ground.set({
    fen,
    turnColor: tempChess.turn() === 'w' ? 'white' : 'black',
    lastMove: [],
    movable: isEnd
      ? { color: 'both', dests: getLegalMoveDests(chess) }
      : { color: 'none', dests: new Map() },
    premovable: { enabled: false },
  });
}

// Read the current ply from the pgn-viewer DOM (class 'move current' index + 1)
function getViewerPly(cellId) {
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  const allMoves = [...(cellEl?.querySelectorAll('.move') || [])];
  const idx = allMoves.findIndex(b => b.classList.contains('current'));
  return idx >= 0 ? idx + 1 : 0;
}

// Shared row factory — uses contenteditable for an inline, text-like feel
function _addRowToList(list, cellId, label, fen, comment) {
  const row = document.createElement('div');
  row.className = 'annotation-row';
  row.dataset.fen = fen;
  row.innerHTML = `<span class="annotation-move-label">${escapeHtml(label)}</span>`;
  const note = document.createElement('div');
  note.className = 'annotation-note';
  note.contentEditable = 'plaintext-only';
  note.dataset.placeholder = 'Add a note…';
  note.textContent = comment || '';
  let debounce;
  note.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => rebuildPgnWithAnnotations(cellId), 500);
  });
  // Clicking the move label navigates the Chessground board to that position
  row.querySelector('.annotation-move-label').addEventListener('click', e => {
    e.stopPropagation();
    _navigateBoardToFen(cellId, fen);
  });
  row.appendChild(note);
  list.appendChild(row);
}

// Strip machine-generated PGN annotations ([%clk ...], [%eval ...], etc.) from
// a comment, returning only the human-written text.
function _userText(comment) {
  return (comment || '').replace(/\[%[^\]]*\]/g, '').trim();
}
// Rebuild a full comment from human text + preserved specials from original.
function _mergeComment(userText, originalComment) {
  const specials = (originalComment || '').match(/\[%[^\]]*\]/g) || [];
  return [...specials, ...(userText ? [userText] : [])].join(' ');
}

// Collect contenteditable values and rewrite cell.pgn with embedded PGN comments
function rebuildPgnWithAnnotations(cellId) {
  const cell   = getCell(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cell || !cellEl) return;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }
  const history = chess.history({ verbose: true });

  // Capture original comments (including machine specials like [%clk])
  const originalComments = new Map(
    (chess.getComments?.() || []).map(({ fen, comment }) => [fen, comment])
  );

  chess.reset();
  if (chess.deleteComments) chess.deleteComments();

  const fenToUserText = new Map();
  cellEl.querySelectorAll('.annotation-row').forEach(row => {
    const text = row.querySelector('.annotation-note')?.textContent?.trim();
    if (text !== undefined) fenToUserText.set(row.dataset.fen, text);
  });

  history.forEach(mv => {
    chess.move(mv.san);
    const fen     = chess.fen();
    const userTxt = fenToUserText.get(fen) ?? '';
    const merged  = _mergeComment(userTxt, originalComments.get(fen) || '');
    if (merged && chess.setComment) chess.setComment(merged);
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
      <input class="board-title-input" type="text" placeholder="Position title…" value="${escapeAttr(cell.title || '')}">
      <div class="spacer"></div>
      <button class="btn-icon edit-moves-btn" title="Annotate moves">✏ Edit</button>
      <button class="btn-icon pgn-editor-btn" title="Edit / paste PGN">✎ PGN</button>
      <button class="btn-icon flip-board" title="Flip board">⇅ Flip</button>
      <button class="btn-icon export-board" title="Export as PGN">⬇︎ PGN</button>
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
      <div class="board-viewer-wrap"></div>
      <div class="annotation-panel">
        <div class="annotation-list"></div>
      </div>
    </div>`;

  div.querySelector('.board-title-input').addEventListener('input', e => {
    updateCellData(cell.id, { title: e.target.value });
  });

  div.querySelector('.edit-moves-btn').addEventListener('click', () => {
    if (editInstances.has(cell.id)) exitEditMode(cell.id); else enterEditMode(cell.id);
  });

  div.querySelector('.flip-board').addEventListener('click', () => {
    if (editInstances.has(cell.id)) exitEditMode(cell.id);
    const c    = getCell(cell.id);
    const next = c.orientation === 'white' ? 'black' : 'white';
    updateCellData(cell.id, { orientation: next });
    const ply  = getViewerPly(cell.id);
    mountViewer(cell.id, c.pgn, next, true, ply || undefined);
  });

  div.querySelector('.export-board').addEventListener('click', () => exportBoard(cell.id));
  div.querySelector('.pgn-editor-btn').addEventListener('click', () => openPgnEditor(cell.id));

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
  if (type === 'board') requestAnimationFrame(() => mountViewer(cell.id, cell.pgn, cell.orientation));
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

// ── Settings ──────────────────────────────────────────────────────────────────

function getBoardTheme() {
  const t = loadSettings().boardTheme || 'auto';
  if (t !== 'auto') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'blue' : 'brown';
}

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
    boardTheme:   document.getElementById('settingsBoardTheme').value,
  });
  closeSettingsModal();
  // Re-apply theme to all mounted viewers
  state.cells.filter(c => c.type === 'board').forEach(c => {
    const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(c.id)}"]`);
    const inEdit = cellEl?.classList.contains('edit-mode');
    const inst   = viewerInstances.get(c.id);
    const ply    = inst?.vm?.ply ?? undefined;
    mountViewer(c.id, c.pgn, c.orientation, true, ply);
    if (inEdit) {
      cellEl.classList.add('edit-mode');
      cellEl.querySelector('.annotation-panel').classList.add('is-visible');
    }
  });
});

// ── Game APIs ─────────────────────────────────────────────────────────────────

async function fetchLichessGames(username) {
  const res = await fetch(
    `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=30&pgnInJson=true&opening=true&tags=true`,
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

async function fetchChesscomGames(username) {
  // fetch current month; if early in month (<= 5 days in), also fetch previous
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
  return games.slice(0, 30).map(g => {
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

  const fetches = [];
  if (settings.lichessUser)  fetches.push(fetchLichessGames(settings.lichessUser));
  if (settings.chesscomUser) fetches.push(fetchChesscomGames(settings.chesscomUser));

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
  const checked = [...document.querySelectorAll('#gamesModalBody .game-check:checked')];
  checked.forEach(cb => {
    const g = _pendingGames[parseInt(cb.dataset.idx, 10)];
    if (!g) return;
    const title = `vs. ${g.opponent} (${g.result})`;
    const cell  = newBoardCell(g.pgn || '', title, g.myColor);
    state.cells.push(cell);
    const el = buildBoardCell(cell);
    document.getElementById('notebook').appendChild(el);
    requestAnimationFrame(() => mountViewer(cell.id, cell.pgn, cell.orientation));
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
    const pgn = document.getElementById('pgnEditorTextarea').value.trim();
    updateCellData(cellId, { pgn });
    mountViewer(cellId, pgn, cell.orientation, true);
    // If annotation panel was open, refresh it
    const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
    if (cellEl?.classList.contains('edit-mode')) refreshAnnotationPanel(cellId);
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

document.getElementById('pgnEditorClose').addEventListener('click', () =>
  document.getElementById('pgnEditorModal').classList.remove('is-open')
);
document.getElementById('pgnEditorModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('is-open');
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
