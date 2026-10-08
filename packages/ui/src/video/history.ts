/**
 * The Studio's undo and redo: each write it made, with the file's text before and after. Undoing writes `before` back
 * only while the file still holds `after`, so an edit someone else made since is never overwritten.
 */

export type Edit = { readonly label: string; readonly path: string; readonly before: string; readonly after: string };
export type History = { readonly undo: readonly Edit[]; readonly redo: readonly Edit[] };

export const emptyHistory: History = { undo: [], redo: [] };
const limit = 100;

/** A new edit: it can be undone, and what was undone before it can no longer be redone. */
export const record = (h: History, edit: Edit): History => ({ undo: [...h.undo, edit].slice(-limit), redo: [] });

/** The edit to undo (its text to write back is `before`), and the history once it is undone. */
export const undoStep = (h: History) => {
  const edit = h.undo.at(-1);
  return edit && { edit, next: { undo: h.undo.slice(0, -1), redo: [...h.redo, edit] } };
};

/** The edit to redo (its text to write again is `after`), and the history once it is redone. */
export const redoStep = (h: History) => {
  const edit = h.redo.at(-1);
  return edit && { edit, next: { undo: [...h.undo, edit], redo: h.redo.slice(0, -1) } };
};
