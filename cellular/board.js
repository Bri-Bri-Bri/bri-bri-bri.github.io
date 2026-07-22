import { Chess } from 'https://esm.sh/chess.js@1?bundle';
import { Chessground } from 'https://esm.sh/@lichess-org/chessground?bundle';
import { state, boardInstances } from './state.js';
// Circular imports from editor.js — safe: all are export function declarations (hoisted)
import { getCell, updateCellData, escapeHtml, escapeAttr } from './editor.js';
import { ECO_NAMES } from './eco.js';

// ── Chessground helpers ───────────────────────────────────────────────────────

export function getLegalMoveDests(chess) {
  const dests = new Map();
  chess.moves({ verbose: true }).forEach(m => {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  });
  return dests;
}

// ── Board instance helpers ────────────────────────────────────────────────────

export function getBoardInstance(cellId) {
  return boardInstances.get(cellId);
}

export function destroyBoardInstance(cellId) {
  const inst = boardInstances.get(cellId);
  if (inst?.ground?.destroy) inst.ground.destroy();
  boardInstances.delete(cellId);
}

export function clearAllBoardInstances() {
  boardInstances.forEach(inst => { if (inst?.ground?.destroy) inst.ground.destroy(); });
  boardInstances.clear();
}

// ── Board: mount ──────────────────────────────────────────────────────────────

export function mountBoard(cellId) {
  const cell = getCell(cellId);
  if (!cell) return;
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cellEl) return;
  const wrap = cellEl.querySelector('.board-viewer-wrap');
  if (!wrap) return;

  // Destroy existing instance
  const existing = boardInstances.get(cellId);
  if (existing?.ground?.destroy) existing.ground.destroy();
  boardInstances.delete(cellId);

  // Parse PGN; build FEN array: fens[0] = start, fens[i] = after move i
  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }

  const walker = new Chess();
  const fens = [walker.fen()];
  chess.history({ verbose: true }).forEach(mv => { walker.move(mv.san); fens.push(walker.fen()); });

  const plyIdx = fens.length - 1;

  // Last-move highlight for initial display
  let initLastMove = [];
  if (plyIdx > 0) {
    const h = chess.history({ verbose: true });
    const m = h[plyIdx - 1];
    if (m) initLastMove = [m.from, m.to];
  }

  wrap.innerHTML = '';
  const cgWrap = document.createElement('div');
  cgWrap.className = 'cg-wrap cg-board';
  wrap.appendChild(cgWrap);

  let inst; // forward ref — assigned just after Chessground()
  const ground = Chessground(cgWrap, {
    fen:         fens[plyIdx],
    orientation: cell.orientation || 'white',
    turnColor:   chess.turn() === 'w' ? 'white' : 'black',
    lastMove:    initLastMove,
    movable: {
      free:  false,
      color: 'none',
      dests: new Map(),
      events: {
        after(from, to) {
          if (!inst?.isEditing) return;
          const move = inst.chess.move({ from, to, promotion: 'q' });
          if (!move) return;
          inst.fens.push(inst.chess.fen());
          inst.plyIdx = inst.fens.length - 1;
          updateCellData(cellId, { pgn: inst.chess.pgn() });
          const hist = inst.chess.history({ verbose: true });
          const last = hist[hist.length - 1];
          const n    = Math.floor((hist.length - 1) / 2) + 1;
          const lbl  = last.color === 'w' ? `${n}. ${last.san}` : `${n}\u2026 ${last.san}`;
          appendAnnotationRow(cellId, lbl, inst.chess.fen());
          ground.set({
            fen:       inst.chess.fen(),
            lastMove:  [from, to],
            turnColor: inst.chess.turn() === 'w' ? 'white' : 'black',
            movable:   { dests: getLegalMoveDests(inst.chess) },
          });
          cellEl.classList.add('has-moves');
          _updateNavButtons(cellId);
        }
      }
    },
    drawable:  { enabled: true, visible: true },
    draggable: { enabled: false },
    selectable:{ enabled: false },
  });

  inst = { chess, ground, fens, plyIdx, isEditing: false };
  boardInstances.set(cellId, inst);

  _updateGameHeader(cellId);
  cellEl.classList.toggle('has-moves', fens.length > 1);
  refreshAnnotationPanel(cellId);
  _updateNavButtons(cellId);
}

// ── Board: navigate to ply ────────────────────────────────────────────────────

export function navTo(cellId, plyIdx) {
  const inst = boardInstances.get(cellId);
  if (!inst) return;
  const { chess, ground, fens, isEditing } = inst;

  const clamped = Math.max(0, Math.min(plyIdx, fens.length - 1));
  inst.plyIdx = clamped;

  const isEnd = clamped === fens.length - 1;
  const fen   = fens[clamped];
  const tc    = new Chess(fen);

  let lastMove = [];
  if (clamped > 0) {
    const mv = chess.history({ verbose: true })[clamped - 1];
    if (mv) lastMove = [mv.from, mv.to];
  }

  ground.set({
    fen,
    turnColor:  tc.turn() === 'w' ? 'white' : 'black',
    lastMove,
    movable: (isEditing && isEnd)
      ? { free: false, color: 'both', dests: getLegalMoveDests(chess) }
      : { color: 'none', dests: new Map() },
    draggable:  { enabled: isEditing && isEnd },
    selectable: { enabled: isEditing && isEnd },
  });

  _highlightAnnotationRow(cellId, clamped);
  _updateNavButtons(cellId);
}

// ── Board: toggle edit mode ───────────────────────────────────────────────────

export function setEditMode(cellId, editing) {
  const inst   = boardInstances.get(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!inst || !cellEl) return;

  inst.isEditing = editing;
  cellEl.classList.toggle('edit-mode', editing);

  const btn = cellEl.querySelector('.edit-moves-btn');
  if (btn) { btn.textContent = editing ? '\u2713 Done' : '\u270f Edit'; btn.classList.toggle('active', editing); }
  cellEl.querySelector('.undo-btn')?.classList.toggle('is-visible', editing);

  // Toggle annotation note editability
  const editable = editing ? 'plaintext-only' : 'false';
  cellEl.querySelectorAll('.annotation-note').forEach(n => { n.contentEditable = editable; });

  navTo(cellId, inst.plyIdx);
}

// ── Board: undo last move ─────────────────────────────────────────────────────

export function undoLastMove(cellId) {
  const inst   = boardInstances.get(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!inst || !cellEl) return;
  if (inst.chess.history().length === 0) return;

  inst.chess.undo();
  inst.fens.pop();
  updateCellData(cellId, { pgn: inst.chess.pgn() });

  const list = cellEl.querySelector('.annotation-list');
  if (list?.lastElementChild && !list.lastElementChild.classList.contains('annotation-panel-empty')) {
    list.lastElementChild.remove();
  }
  if (inst.fens.length <= 1) {
    if (list) list.innerHTML = '<div class="annotation-panel-empty">No moves yet \u2014 use "\u270e PGN" to paste a game.</div>';
    cellEl.classList.remove('has-moves');
  }

  navTo(cellId, inst.fens.length - 1);
}

// ── Board: game info header ───────────────────────────────────────────────────

function _updateGameHeader(cellId) {
  const cell   = getCell(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cell || !cellEl) return;
  const header = cellEl.querySelector('.board-game-header');
  if (!header) return;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch {}
  const h = chess.header ? chess.header() : {};

  if ((!h.White || h.White === '?') && (!h.Black || h.Black === '?')) { header.hidden = true; return; }
  header.hidden = false;
  header.querySelector('.gh-white').textContent   = h.White   || '?';
  header.querySelector('.gh-black').textContent   = h.Black   || '?';
  header.querySelector('.gh-result').textContent  = h.Result  || '';
  header.querySelector('.gh-date').textContent    =
    (h.Date || '').replace(/\.\?\?/g, '').replace(/^(\d{4})\.(\d{2})\.(\d{2})$/, '$2/$3/$1');
  const openingEl = header.querySelector('.gh-opening');
  const eco  = h.ECO || '';
  const name = h.Opening || (eco ? ECO_NAMES[eco] : '') || eco;
  openingEl.textContent = name;
  if (eco) {
    openingEl.href = `https://www.chess365.com/ECO/${eco}`;
    openingEl.removeAttribute('hidden');
  } else {
    openingEl.removeAttribute('href');
  }
}

// ── Board: nav button state ───────────────────────────────────────────────────

function _updateNavButtons(cellId) {
  const inst   = boardInstances.get(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!inst || !cellEl) return;
  const { plyIdx, fens } = inst;
  const max = fens.length - 1;
  cellEl.querySelector('.nav-first')?.toggleAttribute('disabled', plyIdx === 0);
  cellEl.querySelector('.nav-prev')?.toggleAttribute('disabled',  plyIdx === 0);
  cellEl.querySelector('.nav-next')?.toggleAttribute('disabled',  plyIdx === max);
  cellEl.querySelector('.nav-last')?.toggleAttribute('disabled',  plyIdx === max);
  const counter = cellEl.querySelector('.nav-ply-counter');
  if (counter) counter.textContent = max > 0 ? `${plyIdx} / ${max}` : '';
  const link = cellEl.querySelector('.nav-game-link');
  if (link) {
    const url = _getGameLink(getCell(cellId)?.pgn || '');
    if (url) { link.href = url; link.removeAttribute('hidden'); }
    else      { link.removeAttribute('href'); link.setAttribute('hidden', ''); }
  }
}

// ── Board: highlight annotation row ──────────────────────────────────────────

function _highlightAnnotationRow(cellId, plyIdx) {
  const inst   = boardInstances.get(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cellEl) return;
  const targetFen = inst?.fens[plyIdx];
  cellEl.querySelectorAll('.annotation-row').forEach(r => {
    r.classList.toggle('active', !!targetFen && r.dataset.fen === targetFen);
  });
}

// ── Board: extract game link ──────────────────────────────────────────────────

function _getGameLink(pgn) {
  const chess = new Chess();
  try { chess.loadPgn(pgn || ''); } catch { return null; }
  const h = chess.header ? chess.header() : {};
  if (h.Site?.includes('lichess.org/'))  return h.Site;
  if (h.Link?.includes('chess.com/'))    return h.Link;
  if (h.Site?.includes('chess.com/'))    return h.Site;
  return null;
}

// ── Annotations ───────────────────────────────────────────────────────────────

// Append one row after a new move is played (always editable — only called in edit mode)
function appendAnnotationRow(cellId, label, fen) {
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  const list   = cellEl?.querySelector('.annotation-list');
  if (!list) return;
  list.querySelector('.annotation-panel-empty')?.remove();
  _addRowToList(list, cellId, label, fen, '', true);
  list.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Rebuild annotation list from the cell's current PGN
function refreshAnnotationPanel(cellId) {
  const cell   = getCell(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  const list   = cellEl?.querySelector('.annotation-list');
  if (!cell || !list) return;

  const inst     = boardInstances.get(cellId);
  const editable = inst?.isEditing ?? false;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }
  const history = chess.history({ verbose: true });

  if (history.length === 0) {
    list.innerHTML = '<div class="annotation-panel-empty">No moves yet \u2014 use "\u270e PGN" to paste a game.</div>';
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
    const label = mv.color === 'w' ? `${num}. ${mv.san}` : `${num}\u2026 ${mv.san}`;
    const fen   = walker.fen();
    _addRowToList(list, cellId, label, fen, _userText(commentsByFen.get(fen) || ''), editable);
  });

  if (inst) _highlightAnnotationRow(cellId, inst.plyIdx);
}

// Shared row factory — editable only in edit mode; click label to navigate
function _addRowToList(list, cellId, label, fen, comment, editable = false) {
  let debounce;
  const row = document.createElement('div');
  row.className   = 'annotation-row';
  row.dataset.fen = fen;

  const labelSpan = document.createElement('span');
  labelSpan.className   = 'annotation-move-label';
  labelSpan.textContent = label;
  labelSpan.addEventListener('click', e => {
    e.stopPropagation();
    const inst = boardInstances.get(cellId);
    if (!inst) return;
    const plyTarget = inst.fens.indexOf(fen);
    if (plyTarget >= 0) navTo(cellId, plyTarget);
  });

  const note = document.createElement('div');
  note.className           = 'annotation-note';
  note.contentEditable     = editable ? 'plaintext-only' : 'false';
  note.dataset.placeholder = 'Add a note\u2026';
  note.textContent         = comment || '';

  note.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => rebuildPgnWithAnnotations(cellId), 500);
  });

  row.appendChild(labelSpan);
  row.appendChild(note);
  list.appendChild(row);
}

// Strip machine-generated PGN annotations ([%clk ...], [%eval ...], etc.)
function _userText(comment) {
  return (comment || '').replace(/\[%[^\]]*\]/g, '').trim();
}

// Rebuild a full comment from human text + preserved specials from original
function _mergeComment(userText, originalComment) {
  const specials = (originalComment || '').match(/\[%[^\]]*\]/g) || [];
  return [...specials, ...(userText ? [userText] : [])].join(' ');
}

// Collect contenteditable values and rewrite cell.pgn — preserves PGN headers
export function rebuildPgnWithAnnotations(cellId) {
  const cell   = getCell(cellId);
  const cellEl = document.querySelector(`.cell[data-id="${CSS.escape(cellId)}"]`);
  if (!cell || !cellEl) return;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch { chess.reset(); }
  const history = chess.history({ verbose: true });

  // Preserve PGN headers (White, Black, Date, Event, etc.) before reset
  const headers = chess.header ? chess.header() : {};

  const originalComments = new Map(
    (chess.getComments?.() || []).map(({ fen, comment }) => [fen, comment])
  );

  const fenToUserText = new Map();
  cellEl.querySelectorAll('.annotation-row').forEach(row => {
    const text = row.querySelector('.annotation-note')?.textContent?.trim();
    if (text !== undefined) fenToUserText.set(row.dataset.fen, text);
  });

  chess.reset();
  if (chess.deleteComments) chess.deleteComments();

  // Re-apply original headers so they survive the rebuild
  const headerEntries = Object.entries(headers).flat();
  if (headerEntries.length > 0 && chess.header) chess.header(...headerEntries);

  history.forEach(mv => {
    chess.move(mv.san);
    const fen     = chess.fen();
    const userTxt = fenToUserText.get(fen) ?? '';
    const merged  = _mergeComment(userTxt, originalComments.get(fen) || '');
    if (merged && chess.setComment) chess.setComment(merged);
  });

  updateCellData(cellId, { pgn: chess.pgn() });
}
