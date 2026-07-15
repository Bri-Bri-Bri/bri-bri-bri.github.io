// Shared mutable state — no imports from other app modules
// Evaluated first; board.js, puzzles.js, and editor.js all import from here.

// Study state
export const state = {
  studyId:        null,  // currently loaded study
  title:          '',
  cells:          [],
  studiesIndex:   [],    // [{ id, title, date, updatedAt, folderId }]
  folders:        [],    // [{ id, name, parentId, createdAt }]
  activeFolderId: null,  // newly created studies land here (null = root)
};

// cellId → { chess, ground, fens, plyIdx, isEditing }
export const boardInstances = new Map();
