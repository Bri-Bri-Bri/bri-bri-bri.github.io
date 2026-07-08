import { Chess } from 'https://esm.sh/chess.js@1?bundle';
import { Chessground } from 'https://esm.sh/@lichess-org/chessground?bundle';
import { state } from './state.js';
import { getLegalMoveDests, getBoardInstance } from './board.js';
// Circular imports from editor.js — safe: all are export function declarations (hoisted)
import { getCell, uid, escapeHtml, escapeAttr } from './editor.js';

let _puzzleState = null; // { puzzle, chess, ground, stepIdx, solved }

// ── Puzzle storage ────────────────────────────────────────────────────────────

export function loadPuzzles() {
  try { return JSON.parse(localStorage.getItem('cellular-puzzles') || '[]'); }
  catch { return []; }
}

export function savePuzzles(puzzles) {
  try { localStorage.setItem('cellular-puzzles', JSON.stringify(puzzles)); } catch {}
}

// ── Save puzzle dialog ────────────────────────────────────────────────────────

export function openSavePuzzleDialog(cellId) {
  const inst = getBoardInstance(cellId);
  const cell = getCell(cellId);
  if (!inst || !cell) return;

  const solution = inst.chess.history().slice(inst.plyIdx);
  if (solution.length === 0) {
    alert('No moves after this position. Navigate to an earlier ply first.');
    return;
  }

  const chess = new Chess();
  try { chess.loadPgn(cell.pgn || ''); } catch {}
  const h = chess.header ? chess.header() : {};
  const defaultName = cell.title ||
    ((h.White && h.Black && h.White !== '?' && h.Black !== '?') ? `${h.White} vs ${h.Black}` : '') ||
    'Puzzle';

  const modal = document.getElementById('savePuzzleModal');
  const input = document.getElementById('savePuzzleName');
  input.value            = defaultName;
  modal._pendingFen      = inst.fens[inst.plyIdx];
  modal._pendingSolution = solution;
  modal._fromStudy       = state.title || '';
  modal.classList.add('is-open');
  setTimeout(() => { input.select(); input.focus(); }, 50);
}

function _confirmSavePuzzle() {
  const modal  = document.getElementById('savePuzzleModal');
  const name   = document.getElementById('savePuzzleName').value.trim() || 'Puzzle';
  const puzzle = {
    id: uid(), name,
    fen:       modal._pendingFen,
    solution:  modal._pendingSolution || [],
    createdAt: new Date().toISOString(),
    fromStudy: modal._fromStudy || '',
  };
  const puzzles = loadPuzzles();
  puzzles.unshift(puzzle);
  savePuzzles(puzzles);
  modal.classList.remove('is-open');
}

// ── Puzzles list modal ────────────────────────────────────────────────────────

export function openPuzzlesModal() {
  document.getElementById('puzzlesModal').classList.add('is-open');
  renderPuzzleList();
}

function renderPuzzleList() {
  const body    = document.getElementById('puzzlesModalBody');
  const puzzles = loadPuzzles();

  if (puzzles.length === 0) {
    body.innerHTML = '<p class="modal-empty">No puzzles yet.<br>Navigate to any board position and click <strong>\u{1F9E9}</strong> to save it.</p>';
    return;
  }

  body.innerHTML = '';
  puzzles.forEach(puzzle => {
    const row  = document.createElement('div');
    row.className = 'puzzle-list-row';
    const date = new Date(puzzle.createdAt).toLocaleDateString();
    const mc   = puzzle.solution.length;
    row.innerHTML = `
      <div class="puzzle-list-info">
        <span class="puzzle-list-name">${escapeHtml(puzzle.name)}</span>
        <span class="puzzle-list-meta">${mc} move${mc !== 1 ? 's' : ''}${puzzle.fromStudy ? ' \u00b7 ' + escapeHtml(puzzle.fromStudy) : ''} \u00b7 ${date}</span>
      </div>
      <div class="puzzle-list-actions">
        <button class="btn btn-primary puzzle-practice-btn" data-id="${escapeAttr(puzzle.id)}">\u25ba Practice</button>
        <button class="btn-icon danger puzzle-delete-btn" data-id="${escapeAttr(puzzle.id)}" title="Delete">\u2715</button>
      </div>`;
    row.querySelector('.puzzle-practice-btn').addEventListener('click', () => {
      document.getElementById('puzzlesModal').classList.remove('is-open');
      openPuzzlePractice(puzzle.id);
    });
    row.querySelector('.puzzle-delete-btn').addEventListener('click', () => {
      const updated = loadPuzzles().filter(p => p.id !== puzzle.id);
      savePuzzles(updated);
      renderPuzzleList();
    });
    body.appendChild(row);
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

document.getElementById('savePuzzleClose').addEventListener('click', () => document.getElementById('savePuzzleModal').classList.remove('is-open'));
document.getElementById('savePuzzleCancel').addEventListener('click', () => document.getElementById('savePuzzleModal').classList.remove('is-open'));
document.getElementById('savePuzzleConfirm').addEventListener('click', _confirmSavePuzzle);
document.getElementById('savePuzzleName').addEventListener('keydown', e => { if (e.key === 'Enter') _confirmSavePuzzle(); });
document.getElementById('savePuzzleModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('is-open'); });

document.getElementById('puzzlePracticeClose').addEventListener('click', () => document.getElementById('puzzlePracticeModal').classList.remove('is-open'));
document.getElementById('puzzlePracticeModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.classList.remove('is-open'); });
document.getElementById('puzzleShowSolution').addEventListener('click', showPuzzleSolution);
document.getElementById('puzzleReset').addEventListener('click', resetPuzzle);
