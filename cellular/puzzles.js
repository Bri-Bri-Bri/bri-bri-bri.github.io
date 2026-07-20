import { Chess } from 'https://esm.sh/chess.js@1?bundle';
import { Chessground } from 'https://esm.sh/@lichess-org/chessground?bundle';
import { state } from './state.js';
import { getLegalMoveDests, getBoardInstance } from './board.js';
// Circular imports from editor.js — safe: all are export function declarations (hoisted)
import { getCell, uid, escapeHtml, escapeAttr } from './editor.js';

let _puzzleState           = null; // { puzzle, chess, ground, stepIdx, solved }
let _puzzleFolders         = [];   // loaded lazily in openPuzzlesModal
let _expandedPuzzleFolders = new Set();
let _activePuzzleFolderId  = null;
let _puzzleModalWired      = false;

// ── Puzzle storage ────────────────────────────────────────────────────────────

export function loadPuzzles() {
  try { return JSON.parse(localStorage.getItem('cellular-puzzles') || '[]'); }
  catch { return []; }
}

export function savePuzzles(puzzles) {
  try { localStorage.setItem('cellular-puzzles', JSON.stringify(puzzles)); } catch {}
}

// ── Puzzle folder storage ───────────────────────────────────────────────────────────

function loadPuzzleFolders() {
  try { return JSON.parse(localStorage.getItem('cellular-puzzle-folders') || '[]'); }
  catch { return []; }
}
function savePuzzleFolders() {
  try { localStorage.setItem('cellular-puzzle-folders', JSON.stringify(_puzzleFolders)); } catch {}
}

// ── Puzzle folder helpers ──────────────────────────────────────────────────────────

function getPuzzleFolderChildren(parentId) {
  return _puzzleFolders.filter(f => (f.parentId ?? null) === (parentId ?? null));
}

function getPuzzlesInFolder(folderId, allPuzzles) {
  return allPuzzles.filter(p => (p.folderId ?? null) === (folderId ?? null));
}

function isPuzzleFolderDescendantOf(folderId, potentialAncestorId) {
  let current = _puzzleFolders.find(f => f.id === folderId);
  while (current) {
    if ((current.parentId ?? null) === potentialAncestorId) return true;
    if (current.parentId === null || current.parentId === undefined) return false;
    current = _puzzleFolders.find(f => f.id === current.parentId);
  }
  return false;
}

// ── Puzzle folder CRUD ─────────────────────────────────────────────────────────────

function createPuzzleFolder(parentId = null) {
  const name = prompt('Folder name:');
  if (!name || !name.trim()) return;
  const folder = { id: uid(), name: name.trim(), parentId: parentId ?? null, createdAt: new Date().toISOString() };
  _puzzleFolders.push(folder);
  savePuzzleFolders();
  if (parentId) _expandedPuzzleFolders.add(parentId);
  renderPuzzleList();
}

function renamePuzzleFolder(id) {
  const folder = _puzzleFolders.find(f => f.id === id);
  if (!folder) return;
  const name = prompt('Rename folder:', folder.name);
  if (!name || !name.trim()) return;
  folder.name = name.trim();
  savePuzzleFolders();
  renderPuzzleList();
}

function deletePuzzleFolder(id) {
  const allPuzzles = loadPuzzles();
  const hasSubfolders = _puzzleFolders.some(f => (f.parentId ?? null) === id);
  const hasPuzzles    = allPuzzles.some(p => (p.folderId ?? null) === id);
  if (hasSubfolders || hasPuzzles) {
    alert('Folder must be empty before deleting.\nMove or remove its contents first.');
    return;
  }
  if (!confirm('Delete this folder?')) return;
  const idx = _puzzleFolders.findIndex(f => f.id === id);
  if (idx !== -1) _puzzleFolders.splice(idx, 1);
  _expandedPuzzleFolders.delete(id);
  if (_activePuzzleFolderId === id) _activePuzzleFolderId = null;
  savePuzzleFolders();
  renderPuzzleList();
}

function movePuzzleToFolder(puzzleId, targetFolderId) {
  const allPuzzles = loadPuzzles();
  const puzzle = allPuzzles.find(p => p.id === puzzleId);
  if (!puzzle) return;
  puzzle.folderId = targetFolderId ?? null;
  savePuzzles(allPuzzles);
  renderPuzzleList();
}

function movePuzzleFolderTo(folderId, targetParentId) {
  const folder = _puzzleFolders.find(f => f.id === folderId);
  if (!folder) return;
  folder.parentId = targetParentId ?? null;
  savePuzzleFolders();
  renderPuzzleList();
}

// ── Save puzzle dialog ────────────────────────────────────────────────────────

let _saveCustomGround = null;
let _saveCustomChess  = null;
let _saveCustomMoves  = [];

export function openSavePuzzleDialog(cellId) {
  const inst = getBoardInstance(cellId);
  const cell = getCell(cellId);
  if (!inst || !cell) return;

  const gameMoves = inst.chess.history().slice(inst.plyIdx);
  const startFen  = inst.fens[inst.plyIdx];
  const startOrientation = cell.orientation || (new Chess(startFen).turn() === 'w' ? 'white' : 'black');
  const hasGameMoves = gameMoves.length > 0;

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch {}
  const h = chess.header ? chess.header() : {};
  const defaultName = cell.title ||
    ((h.White && h.Black && h.White !== '?' && h.Black !== '?') ? `${h.White} vs ${h.Black}` : '') ||
    'Puzzle';

  const modal    = document.getElementById('savePuzzleModal');
  const input    = document.getElementById('savePuzzleName');
  const tabGame  = document.getElementById('savePuzzleTabGame');
  const tabCustom = document.getElementById('savePuzzleTabCustom');

  input.value       = defaultName;
  modal._pendingFen = startFen;
  modal._gameMoves  = gameMoves;
  modal._fromStudy  = state.title || '';
  modal._startFen   = startFen;
  modal._startOrientation = startOrientation;

  // Populate game moves preview with clickable chips
  _renderGameMovesPanel(modal, gameMoves);

  tabGame.disabled = !hasGameMoves;

  function activateTab(mode) {
    modal._activeMode = mode;
    tabGame.classList.toggle('active', mode === 'game');
    tabCustom.classList.toggle('active', mode === 'custom');
    document.getElementById('savePuzzlePanelGame').hidden   = mode !== 'game';
    document.getElementById('savePuzzlePanelCustom').hidden = mode !== 'custom';
    if (mode === 'custom') _mountSaveBoard(startFen, startOrientation);
  }

  tabGame.onclick   = () => { if (hasGameMoves) activateTab('game'); };
  tabCustom.onclick = () => activateTab('custom');

  activateTab(hasGameMoves ? 'game' : 'custom');
  modal.classList.add('is-open');
  setTimeout(() => { input.select(); input.focus(); }, 50);
}

function _mountSaveBoard(fen, orientation) {
  const wrap = document.getElementById('savePuzzleCustomBoard');
  if (!wrap) return;

  if (_saveCustomGround) { _saveCustomGround.destroy(); _saveCustomGround = null; }
  _saveCustomChess = new Chess(fen);
  _saveCustomMoves = [];

  wrap.innerHTML = '';
  const cgWrap = document.createElement('div');
  cgWrap.className = 'cg-wrap cg-board';
  wrap.appendChild(cgWrap);

  const toMove = _saveCustomChess.turn() === 'w' ? 'white' : 'black';
  _saveCustomGround = Chessground(cgWrap, {
    fen,
    orientation: orientation || toMove,
    turnColor:   toMove,
    movable: {
      free:  false,
      color: 'both',
      dests: getLegalMoveDests(_saveCustomChess),
      events: { after: _onSaveBoardMove },
    },
    draggable:  { enabled: true },
    selectable: { enabled: true },
  });
  _updateSaveCustomDisplay();
}

function _onSaveBoardMove(orig, dest) {
  if (!_saveCustomChess) return;
  const move = _saveCustomChess.move({ from: orig, to: dest, promotion: 'q' });
  if (!move) return;
  _saveCustomMoves.push(move.san);
  const over = _saveCustomChess.isGameOver();
  _saveCustomGround.set({
    fen:       _saveCustomChess.fen(),
    lastMove:  [orig, dest],
    turnColor: _saveCustomChess.turn() === 'w' ? 'white' : 'black',
    movable:   over ? { color: 'none', dests: new Map() } : { color: 'both', dests: getLegalMoveDests(_saveCustomChess) },
    draggable:  { enabled: !over },
    selectable: { enabled: !over },
  });
  _updateSaveCustomDisplay();
}

function _undoSaveMove() {
  if (!_saveCustomChess || _saveCustomMoves.length === 0) return;
  _saveCustomChess.undo();
  _saveCustomMoves.pop();
  const toMove = _saveCustomChess.turn() === 'w' ? 'white' : 'black';
  _saveCustomGround.set({
    fen:       _saveCustomChess.fen(),
    lastMove:  [],
    turnColor: toMove,
    movable:   { color: 'both', dests: getLegalMoveDests(_saveCustomChess) },
    draggable:  { enabled: true },
    selectable: { enabled: true },
  });
  _updateSaveCustomDisplay();
}

function _updateSaveCustomDisplay() {
  const el = document.getElementById('savePuzzleCustomMovesList');
  if (!el) return;
  el.textContent = _saveCustomMoves.length
    ? _formatMoveList(_saveCustomMoves)
    : 'Play moves on the board to record the solution.';
}

function _renderGameMovesPanel(modal, moves) {
  const container = document.getElementById('savePuzzleGameMovesList');
  if (moves.length === 0) {
    container.textContent = 'No continuation in the game from this position.';
    modal._gameMovesCount = 0;
    return;
  }

  function render(count) {
    modal._gameMovesCount = count;
    container.innerHTML = '';
    moves.forEach((san, i) => {
      const ply = i + 1;
      if (i % 2 === 0) {
        const num = document.createElement('span');
        num.className = 'puzzle-move-num';
        num.textContent = `${Math.floor(i / 2) + 1}.`;
        container.appendChild(num);
      }
      const chip = document.createElement('button');
      chip.className = 'puzzle-move-chip' + (ply <= count ? ' is-active' : ' is-dim');
      chip.textContent = san;
      chip.addEventListener('click', () => render(ply));
      container.appendChild(chip);
    });
    const hint = document.createElement('p');
    hint.className = 'puzzle-save-moves-hint';
    hint.textContent = `${count} move${count !== 1 ? 's' : ''} — click to adjust`;
    container.appendChild(hint);
  }

  render(moves.length);
}

function _formatMoveList(moves) {
  const parts = [];
  moves.forEach((san, i) => {
    if (i % 2 === 0) parts.push(`${Math.floor(i / 2) + 1}. ${san}`);
    else parts[parts.length - 1] += ` ${san}`;
  });
  return parts.join('  ');
}

function _closeSavePuzzleDialog() {
  document.getElementById('savePuzzleModal').classList.remove('is-open');
  if (_saveCustomGround) { _saveCustomGround.destroy(); _saveCustomGround = null; }
  _saveCustomChess = null;
  _saveCustomMoves = [];
}

function _confirmSavePuzzle() {
  const modal = document.getElementById('savePuzzleModal');
  const name  = document.getElementById('savePuzzleName').value.trim() || 'Puzzle';

  let solution;
  if (modal._activeMode === 'custom') {
    if (_saveCustomMoves.length === 0) {
      alert('Play at least one move on the board to define the solution.');
      return;
    }
    solution = [..._saveCustomMoves];
  } else {
    const all = modal._gameMoves || [];
    const count = modal._gameMovesCount || all.length;
    solution = all.slice(0, count);
    if (solution.length === 0) {
      alert('No continuation moves. Use Custom moves to record a solution manually.');
      return;
    }
  }

  const puzzle = {
    id: uid(), name,
    fen:       modal._pendingFen,
    solution,
    createdAt: new Date().toISOString(),
    fromStudy: modal._fromStudy || '',
    folderId:  _activePuzzleFolderId ?? null,
  };
  const puzzles = loadPuzzles();
  puzzles.unshift(puzzle);
  savePuzzles(puzzles);
  _closeSavePuzzleDialog();
}

// ── Puzzles list modal ────────────────────────────────────────────────────────

export function openPuzzlesModal() {
  // Lazy-load folders and wire the "New Folder" button on first open
  _puzzleFolders = loadPuzzleFolders();
  if (!_puzzleModalWired) {
    document.getElementById('puzzleNewFolderBtn')
      .addEventListener('click', () => createPuzzleFolder(_activePuzzleFolderId));
    _puzzleModalWired = true;
  }
  document.getElementById('puzzlesModal').classList.add('is-open');
  renderPuzzleList();
}

function renderPuzzleList() {
  const body    = document.getElementById('puzzlesModalBody');
  const puzzles = loadPuzzles();

  if (puzzles.length === 0 && _puzzleFolders.length === 0) {
    body.innerHTML = '<p class="modal-empty">No puzzles yet.<br>Navigate to any board position and click <strong>\u{1F9E9}</strong> to save it.</p>';
    return;
  }

  body.innerHTML = '';
  _renderPuzzleFolderLevel(body, null, 0, puzzles);

  // Unfiled section at bottom (root-level puzzles)
  const unfiledPuzzles = getPuzzlesInFolder(null, puzzles);
  const hasUnfiledOrFolders = unfiledPuzzles.length > 0 || _puzzleFolders.length > 0;
  if (hasUnfiledOrFolders && _puzzleFolders.length > 0) {
    // Only show the "Unfiled" header when there are also folders (to differentiate)
    const unfiledHeader = document.createElement('div');
    unfiledHeader.className = 'puzzle-unfiled-header' + (_activePuzzleFolderId === null ? ' active' : '');
    unfiledHeader.textContent = 'Unfiled';
    unfiledHeader.title = 'Drop here to move to unfiled';
    unfiledHeader.addEventListener('click', () => { _activePuzzleFolderId = null; renderPuzzleList(); });
    _attachPuzzleDropTarget(unfiledHeader, null);
    body.appendChild(unfiledHeader);
    unfiledPuzzles.forEach(p => body.appendChild(_buildPuzzleRow(p)));
  } else if (_puzzleFolders.length === 0) {
    // No folders at all — just render puzzles directly
    unfiledPuzzles.forEach(p => body.appendChild(_buildPuzzleRow(p)));
  }
}

function _renderPuzzleFolderLevel(parentEl, parentFolderId, depth, allPuzzles) {
  getPuzzleFolderChildren(parentFolderId).forEach(folder => {
    const isExpanded = _expandedPuzzleFolders.has(folder.id);
    const isActive   = _activePuzzleFolderId === folder.id;
    const directPuzzleCount = getPuzzlesInFolder(folder.id, allPuzzles).length;

    const section = document.createElement('div');
    section.className = 'puzzle-folder-section';
    section.dataset.folderId = folder.id;

    const header = document.createElement('div');
    header.className = 'puzzle-folder-header' + (isActive ? ' active' : '');
    header.style.setProperty('--depth', depth);
    header.draggable = true;
    header.innerHTML = `
      <button class="btn-icon puzzle-folder-toggle" title="${isExpanded ? 'Collapse' : 'Expand'}">${isExpanded ? '▾' : '▸'}</button>
      <span class="puzzle-folder-icon">${isExpanded ? '📂' : '📁'}</span>
      <span class="puzzle-folder-name">${escapeHtml(folder.name)}</span>
      <span class="puzzle-folder-count">${directPuzzleCount}</span>
      <div class="folder-menu-wrap">
        <button class="btn-icon folder-menu-btn" title="Folder options">…</button>
        <div class="folder-menu-dropdown">
          <button class="folder-action folder-add-sub">+ New subfolder</button>
          <button class="folder-action folder-rename">Rename</button>
          <button class="folder-action folder-delete">Delete</button>
        </div>
      </div>`;

    header.querySelector('.puzzle-folder-toggle').addEventListener('click', e => {
      e.stopPropagation();
      if (_expandedPuzzleFolders.has(folder.id)) _expandedPuzzleFolders.delete(folder.id);
      else _expandedPuzzleFolders.add(folder.id);
      renderPuzzleList();
    });

    header.addEventListener('click', e => {
      if (e.target.closest('.folder-menu-wrap') || e.target.closest('.puzzle-folder-toggle')) return;
      _activePuzzleFolderId = (_activePuzzleFolderId === folder.id) ? null : folder.id;
      if (_activePuzzleFolderId === folder.id && !_expandedPuzzleFolders.has(folder.id)) {
        _expandedPuzzleFolders.add(folder.id);
      }
      renderPuzzleList();
    });

    const menuWrap = header.querySelector('.folder-menu-wrap');
    menuWrap.querySelector('.folder-menu-btn').addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = menuWrap.classList.contains('is-open');
      document.querySelectorAll('.folder-menu-wrap.is-open').forEach(w => w.classList.remove('is-open'));
      if (!wasOpen) {
        menuWrap.classList.add('is-open');
        const close = () => { menuWrap.classList.remove('is-open'); document.removeEventListener('click', close); };
        document.addEventListener('click', close);
      }
    });
    header.querySelector('.folder-add-sub').addEventListener('click', e => { e.stopPropagation(); createPuzzleFolder(folder.id); });
    header.querySelector('.folder-rename').addEventListener('click',  e => { e.stopPropagation(); renamePuzzleFolder(folder.id); });
    header.querySelector('.folder-delete').addEventListener('click',  e => { e.stopPropagation(); deletePuzzleFolder(folder.id); });

    header.addEventListener('dragstart', e => {
      e.stopPropagation();
      e.dataTransfer.setData('puzzlefolderid', folder.id);
      e.dataTransfer.effectAllowed = 'move';
    });

    section.appendChild(header);

    const children = document.createElement('div');
    children.className = 'puzzle-folder-children';
    if (isExpanded) {
      _renderPuzzleFolderLevel(children, folder.id, depth + 1, allPuzzles);
      getPuzzlesInFolder(folder.id, allPuzzles).forEach(p => children.appendChild(_buildPuzzleRow(p)));
    } else {
      children.hidden = true;
    }
    section.appendChild(children);

    _attachPuzzleDropTarget(section, folder.id);
    parentEl.appendChild(section);
  });
}

  const _clipboard_toast = (msg, ms=1400) => {
    const t = Object.assign(document.createElement('div'), {
      textContent: msg,
      style: `
        position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
        background:#111;color:#fff;padding:8px 12px;border-radius:999px;
        font:13px/1.2 system-ui;z-index:99999;opacity:.95;
      `
    });
    document.body.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity 200ms ease'; }, ms);
    setTimeout(()=> t.remove(), ms+250);
  };


function _buildPGN(puzzle_data) {
  var pgn_template = `
  [Event "?"]
  [Site "?"]
  [Date "????.??.??"]
  [Round "?"]
  [White "?"]
  [Black "?"]
  [Result "*"]
  [SetUp "1"]
  [FEN "${puzzle_data['fen']}"]

`+
  Array.from({ length:  puzzle_data['solution'].length/2}, (_, i) => String(`${i}. ${puzzle_data['solution'][i]} ${puzzle_data['solution'][i+1]}`)).join("\n");
  return pgn_template;
}

function _buildPuzzleRow(puzzle) {
  const row  = document.createElement('div');
  row.className = 'puzzle-list-row';
  row.draggable = true;
  const date = new Date(puzzle.createdAt).toLocaleDateString();
  const mc   = puzzle.solution.length;
  row.innerHTML = `
    <div class="puzzle-list-info">
      <span class="puzzle-list-name">${escapeHtml(puzzle.name)}</span>
      <span class="puzzle-list-meta">${mc} move${mc !== 1 ? 's' : ''}${puzzle.fromStudy ? ' \u00b7 ' + escapeHtml(puzzle.fromStudy) : ''} \u00b7 ${date}</span>
    </div>
    <div class="puzzle-list-actions">
      <button data-id="mrtnopxjwr2bp" class="btn btn-secondary puzzle-copy-btn" data-id="${escapeAttr(puzzle.id)}">⿻ Copy PGN</button>
      <button class="btn btn-primary puzzle-practice-btn" data-id="${escapeAttr(puzzle.id)}">\u25ba Practice</button>
      <button class="btn-icon danger puzzle-delete-btn" data-id="${escapeAttr(puzzle.id)}" title="Delete">\u2715</button>
    </div>`;
  row.querySelector('.puzzle-copy-btn').addEventListener('click', () => {
    // Build and dump PGN to clipboard, and show small alert to user
    const pgn = _buildPGN(puzzle);
    navigator.clipboard.writeText(pgn);
    _clipboard_toast('PGN copied to clipboard');
  });
  row.querySelector('.puzzle-practice-btn').addEventListener('click', () => {
    document.getElementById('puzzlesModal').classList.remove('is-open');
    openPuzzlePractice(puzzle.id);
  });
  row.querySelector('.puzzle-delete-btn').addEventListener('click', () => {
    const updated = loadPuzzles().filter(p => p.id !== puzzle.id);
    savePuzzles(updated);
    renderPuzzleList();
  });
  row.addEventListener('dragstart', e => {
    e.stopPropagation();
    e.dataTransfer.setData('puzzleid', puzzle.id);
    e.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('is-dragging');
    document.addEventListener('dragend', () => document.body.classList.remove('is-dragging'), { once: true });
  });
  return row;
}

function _attachPuzzleDropTarget(el, targetFolderId) {
  el.addEventListener('dragenter', e => {
    if (![...e.dataTransfer.types].includes('puzzleid') && ![...e.dataTransfer.types].includes('puzzlefolderid')) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drag-over');
  });
  el.addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('puzzleid') && ![...e.dataTransfer.types].includes('puzzlefolderid')) return;
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('dragleave', e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over');
    const puzzleId         = e.dataTransfer.getData('puzzleid');
    const draggedFolderId  = e.dataTransfer.getData('puzzlefolderid');
    if (puzzleId) {
      movePuzzleToFolder(puzzleId, targetFolderId);
    } else if (draggedFolderId && draggedFolderId !== targetFolderId) {
      if (targetFolderId === null || !isPuzzleFolderDescendantOf(targetFolderId, draggedFolderId)) {
        movePuzzleFolderTo(draggedFolderId, targetFolderId);
      }
    }
  });
}

// ── Puzzle practice ───────────────────────────────────────────────────────────

export function openPuzzlePractice(puzzleId) {
  const puzzle = loadPuzzles().find(p => p.id === puzzleId);
  if (!puzzle) return;

  const modal = document.getElementById('puzzlePracticeModal');
  modal.classList.add('is-open');
  document.getElementById('puzzlePracticeName').textContent = puzzle.name;

  if (_puzzleState?.ground?.destroy) _puzzleState.ground.destroy();
  _puzzleState = null;

  const chess  = new Chess(puzzle.fen);
  const toMove = chess.turn() === 'w' ? 'white' : 'black';

  const container = document.getElementById('puzzlePracticeBoard');
  container.innerHTML = '';
  const cgWrap = document.createElement('div');
  cgWrap.className = 'cg-wrap cg-board';
  container.appendChild(cgWrap);

  const ground = Chessground(cgWrap, {
    fen:         puzzle.fen,
    orientation: toMove,
    turnColor:   toMove,
    movable: {
      free:  false,
      color: toMove,
      dests: getLegalMoveDests(chess),
      events: { after(orig, dest) { _puzzleMove(orig, dest); } },
    },
    drawable:  { enabled: false },
    draggable: { enabled: true },
    selectable:{ enabled: true },
  });

  _puzzleState = { puzzle, chess, ground, stepIdx: 0, solved: false };
  _showPuzzleFeedback(toMove === 'white' ? 'White to move' : 'Black to move', '');
}

function _puzzleMove(orig, dest) {
  if (!_puzzleState || _puzzleState.solved) return;
  const { puzzle, chess, ground } = _puzzleState;
  const expected        = puzzle.solution[_puzzleState.stepIdx];
  const expectedVerbose = chess.moves({ verbose: true }).find(m => m.san === expected);
  const correct         = expectedVerbose && expectedVerbose.from === orig && expectedVerbose.to === dest;

  if (!correct) {
    ground.set({ fen: chess.fen(), movable: { color: chess.turn() === 'w' ? 'white' : 'black', dests: getLegalMoveDests(chess) } });
    _showPuzzleFeedback('\u2717 Try again', 'wrong');
    return;
  }

  chess.move(expected);
  _puzzleState.stepIdx++;
  ground.set({ fen: chess.fen(), lastMove: [orig, dest], turnColor: chess.turn() === 'w' ? 'white' : 'black' });

  if (_puzzleState.stepIdx >= puzzle.solution.length) {
    ground.set({ movable: { color: 'none', dests: new Map() }, draggable: { enabled: false } });
    _puzzleState.solved = true;
    _showPuzzleFeedback('\u2713 Solved!', 'correct');
    return;
  }

  _showPuzzleFeedback('\u2713 Correct!', 'correct');
  ground.set({ movable: { color: 'none', dests: new Map() } });

  setTimeout(() => {
    if (!_puzzleState) return;
    const respSan = puzzle.solution[_puzzleState.stepIdx];
    const respMv  = chess.move(respSan);
    if (!respMv) return;
    _puzzleState.stepIdx++;
    ground.set({ fen: chess.fen(), lastMove: [respMv.from, respMv.to], turnColor: chess.turn() === 'w' ? 'white' : 'black' });

    if (_puzzleState.stepIdx >= puzzle.solution.length) {
      ground.set({ movable: { color: 'none', dests: new Map() }, draggable: { enabled: false } });
      _puzzleState.solved = true;
      _showPuzzleFeedback('\u2713 Solved!', 'correct');
      return;
    }

    ground.set({
      movable: { free: false, color: chess.turn() === 'w' ? 'white' : 'black', dests: getLegalMoveDests(chess) },
      draggable: { enabled: true },
    });
    _showPuzzleFeedback('Your turn', '');
  }, 600);
}

export function showPuzzleSolution() {
  if (!_puzzleState) return;
  const { puzzle, chess, ground } = _puzzleState;
  _puzzleState.solved = true;
  ground.set({ movable: { color: 'none', dests: new Map() }, draggable: { enabled: false } });
  const remaining = puzzle.solution.slice(_puzzleState.stepIdx);
  if (remaining.length === 0) return;
  let i = 0;
  function playNext() {
    if (!_puzzleState || i >= remaining.length) {
      if (_puzzleState) _showPuzzleFeedback('Solution shown', '');
      return;
    }
    const mv = chess.move(remaining[i++]);
    if (!mv) { playNext(); return; }
    ground.set({ fen: chess.fen(), lastMove: [mv.from, mv.to], turnColor: chess.turn() === 'w' ? 'white' : 'black' });
    setTimeout(playNext, 700);
  }
  playNext();
}

export function resetPuzzle() {
  if (!_puzzleState) return;
  const { puzzle, ground } = _puzzleState;
  const chess  = new Chess(puzzle.fen);
  const toMove = chess.turn() === 'w' ? 'white' : 'black';
  _puzzleState.chess   = chess;
  _puzzleState.stepIdx = 0;
  _puzzleState.solved  = false;
  ground.set({
    fen: puzzle.fen, turnColor: toMove, lastMove: [],
    movable: { free: false, color: toMove, dests: getLegalMoveDests(chess) },
    draggable: { enabled: true },
  });
  _showPuzzleFeedback(toMove === 'white' ? 'White to move' : 'Black to move', '');
}

function _showPuzzleFeedback(text, type) {
  const el = document.getElementById('puzzleFeedback');
  if (!el) return;
  el.textContent = text;
  el.className   = 'puzzle-feedback' + (type ? ' ' + type : '');
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('puzzlesBtn').addEventListener('click', openPuzzlesModal);
document.getElementById('puzzlesClose').addEventListener('click', () => document.getElementById('puzzlesModal').classList.remove('is-open'));
document.getElementById('puzzlesModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('is-open'); });

document.getElementById('savePuzzleClose').addEventListener('click', _closeSavePuzzleDialog);
document.getElementById('savePuzzleCancel').addEventListener('click', _closeSavePuzzleDialog);
document.getElementById('savePuzzleConfirm').addEventListener('click', _confirmSavePuzzle);
document.getElementById('savePuzzleName').addEventListener('keydown', e => { if (e.key === 'Enter') _confirmSavePuzzle(); });
document.getElementById('savePuzzleModal').addEventListener('click', e => { if (e.target === e.currentTarget) _closeSavePuzzleDialog(); });
document.getElementById('savePuzzleUndoMove').addEventListener('click', _undoSaveMove);

document.getElementById('puzzlePracticeClose').addEventListener('click', () => document.getElementById('puzzlePracticeModal').classList.remove('is-open'));
document.getElementById('puzzlePracticeModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('is-open'); });
document.getElementById('puzzleShowSolution').addEventListener('click', showPuzzleSolution);
document.getElementById('puzzleReset').addEventListener('click', resetPuzzle);
