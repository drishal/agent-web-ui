// The composer's text in awui's Tern client. Tern draws the editor and its
// caret but never changes the text: keys arrive as pty input, and with the
// `edit` feature Tern's own selection, clicks, and soft-wrapped ↑/↓ arrive as
// `edit` events. Both land here as plain edits of {text, cursor, anchor} in
// UTF-16 offsets (Tern's unit), with an undo history of whole steps. Pure, so
// it is tested without a terminal.
import type { Key } from "@stencil-hq/tern";

export interface Draft {
  text: string;
  /** The caret, a UTF-16 offset. */
  cursor: number;
  /** The other end of a selection, or null for none. */
  anchor: number | null;
}

export const EMPTY_DRAFT: Draft = { text: "", cursor: 0, anchor: null };

/** Undo steps kept per draft. */
const HISTORY = 200;

/** A draft with its undo and redo steps. */
export interface DraftState {
  draft: Draft;
  undo: Draft[];
  redo: Draft[];
  /** The kind of the last edit, so a run of typed letters undoes as one step. */
  last: "type" | "delete" | "other" | null;
}

export const draftState = (draft: Draft = EMPTY_DRAFT): DraftState => ({ draft, undo: [], redo: [], last: null });

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

/** The selected range, start first, or null when nothing is selected. */
export function selection(d: Draft): { from: number; to: number } | null {
  if (d.anchor === null || d.anchor === d.cursor) return null;
  return { from: Math.min(d.anchor, d.cursor), to: Math.max(d.anchor, d.cursor) };
}

/** Replace `[from, to)` with `insert`, the caret after it. */
export function replace(d: Draft, from: number, to: number, insert: string): Draft {
  const a = clamp(Math.min(from, to), d.text.length);
  const b = clamp(Math.max(from, to), d.text.length);
  return { text: d.text.slice(0, a) + insert + d.text.slice(b), cursor: a + insert.length, anchor: null };
}

/** Type `s` over the selection, or at the caret. */
export function insert(d: Draft, s: string): Draft {
  const sel = selection(d);
  return sel ? replace(d, sel.from, sel.to, s) : replace(d, d.cursor, d.cursor, s);
}

/** The offset one code point before or after `at` (a surrogate pair is one step). */
function step(text: string, at: number, by: 1 | -1): number {
  if (by < 0) {
    if (at <= 0) return 0;
    const low = text.charCodeAt(at - 1);
    return at >= 2 && low >= 0xdc00 && low <= 0xdfff ? at - 2 : at - 1;
  }
  if (at >= text.length) return text.length;
  const high = text.charCodeAt(at);
  return at + 1 < text.length && high >= 0xd800 && high <= 0xdbff ? at + 2 : at + 1;
}

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Where a word jump from `at` lands: past the spaces, then past the word (Emacs's M-b and M-f). */
export function wordStep(text: string, at: number, by: 1 | -1): number {
  let i = at;
  if (by < 0) {
    while (i > 0 && !isWord(text[i - 1])) i--;
    while (i > 0 && isWord(text[i - 1])) i--;
  } else {
    while (i < text.length && !isWord(text[i])) i++;
    while (i < text.length && isWord(text[i])) i++;
  }
  return i;
}

const lineStart = (text: string, at: number) => text.lastIndexOf("\n", at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const n = text.indexOf("\n", at);
  return n < 0 ? text.length : n;
};

/**
 * The caret one line up or down, keeping its column; null at the first or
 * last line (where ↑ and ↓ recall sent prompts instead).
 */
export function lineStep(d: Draft, by: 1 | -1): number | null {
  const start = lineStart(d.text, d.cursor);
  const column = d.cursor - start;
  if (by < 0) {
    if (start === 0) return null;
    const prev = lineStart(d.text, start - 1);
    return Math.min(prev + column, start - 1);
  }
  const end = lineEnd(d.text, d.cursor);
  if (end >= d.text.length) return null;
  const next = end + 1;
  return Math.min(next + column, lineEnd(d.text, next));
}

/** Move the caret to `to`; with `extend`, the selection grows from where it was. */
export function moveTo(d: Draft, to: number, extend = false): Draft {
  const cursor = clamp(to, d.text.length);
  return { text: d.text, cursor, anchor: extend ? (d.anchor ?? d.cursor) : null };
}

/** Delete the selection, else from the caret to `to` (either side). */
export function deleteTo(d: Draft, to: number): Draft {
  const sel = selection(d);
  if (sel) return replace(d, sel.from, sel.to, "");
  return replace(d, Math.min(d.cursor, to), Math.max(d.cursor, to), "");
}

/** Record `next` as an edit of `state`: a new undo step unless it continues the same kind of edit. */
export function commit(state: DraftState, next: Draft, kind: "type" | "delete" | "other"): DraftState {
  if (next.text === state.draft.text) return { ...state, draft: next };
  // A run of typing (or of deleting) is one step; a space or new line ends a typed word's step.
  const joins = kind !== "other" && state.last === kind && !/\s$/.test(state.draft.text.slice(0, state.draft.cursor));
  const undo = joins ? state.undo : [...state.undo, state.draft].slice(-HISTORY);
  return { draft: next, undo, redo: [], last: kind };
}

export function undo(state: DraftState): DraftState {
  const prev = state.undo[state.undo.length - 1];
  if (!prev) return state;
  return { draft: prev, undo: state.undo.slice(0, -1), redo: [...state.redo, state.draft], last: null };
}

export function redo(state: DraftState): DraftState {
  const next = state.redo[state.redo.length - 1];
  if (!next) return state;
  return { draft: next, undo: [...state.undo, state.draft], redo: state.redo.slice(0, -1), last: null };
}

/** Replace the whole text (a recalled prompt, a saved prompt), the caret at `cursor` (its end by default). */
export function setText(state: DraftState, text: string, cursor = text.length, anchor: number | null = null): DraftState {
  return commit(state, { text, cursor: clamp(cursor, text.length), anchor }, "other");
}

/** Tern's `edit` event: replace `[from, to)` with `text`, caret at `cursor`; ignored when the text changed since (its `len`). */
export function applyEdit(state: DraftState, e: { from: number; to: number; text: string; cursor: number; len: number }): DraftState {
  if (e.len !== state.draft.text.length) return state;
  const d = state.draft;
  if (e.from === e.to && e.text === "") return { ...state, draft: { text: d.text, cursor: clamp(e.cursor, d.text.length), anchor: null }, last: null };
  const replaced = replace(d, e.from, e.to, e.text);
  return commit(state, { ...replaced, cursor: clamp(e.cursor, replaced.text.length) }, e.text ? "type" : "delete");
}

/** What a key did to the draft: the new state, or null when the key is not an editing key (the app's to handle). */
export type KeyResult = DraftState | null;

/**
 * Edit the draft for one key, Emacs-style (the shell's keys, as atui's
 * composer): letters and paste type, ←/→ and C-b/C-f move, M-b/M-f by word,
 * C-a/C-e and Home/End to the line's ends, Backspace/C-h, Delete/C-d, C-w and
 * M-Backspace a word back, M-d a word on, C-u to the line's start, C-z/C-_
 * undo. Enter, Esc, ↑/↓ at the edges, Tab, and the app's own chords are not
 * editing keys.
 */
export function editKey(state: DraftState, key: Key): KeyResult {
  const d = state.draft;
  const { ctrl, alt, shift, meta } = key;
  const plain = !ctrl && !alt && !meta;
  const name = key.name;

  if (name === "paste") return commit(state, insert(d, (key.text ?? "").replace(/\r\n?/g, "\n")), "other");
  // A typed character: its text, without Ctrl or Alt (Shift is already in the text).
  if (plain && key.text !== undefined && key.text !== "" && !/[\u0000-\u001f\u007f]/.test(key.text)) return commit(state, insert(d, key.text), "type");
  if (plain && name === "space") return commit(state, insert(d, " "), "type");

  const at = d.cursor;
  const move = (to: number) => ({ ...state, draft: moveTo(d, to, shift), last: null });
  if ((plain && name === "left") || (ctrl && !alt && name === "b")) return move(selection(d) && !shift ? selection(d)!.from : step(d.text, at, -1));
  if ((plain && name === "right") || (ctrl && !alt && name === "f")) return move(selection(d) && !shift ? selection(d)!.to : step(d.text, at, 1));
  if ((alt && !ctrl && (name === "b" || name === "left")) || (ctrl && name === "left")) return move(wordStep(d.text, at, -1));
  if ((alt && !ctrl && (name === "f" || name === "right")) || (ctrl && name === "right")) return move(wordStep(d.text, at, 1));
  if ((plain && name === "home") || (ctrl && !alt && name === "a")) return move(lineStart(d.text, at));
  if ((plain && name === "end") || (ctrl && !alt && name === "e")) return move(lineEnd(d.text, at));
  if (ctrl && name === "home") return move(0);
  if (ctrl && name === "end") return move(d.text.length);

  if ((name === "backspace" && !alt && !ctrl) || (ctrl && !alt && name === "h")) return commit(state, deleteTo(d, step(d.text, at, -1)), "delete");
  if ((plain && name === "delete") || (ctrl && !alt && name === "d" && d.text !== "")) return commit(state, deleteTo(d, step(d.text, at, 1)), "delete");
  if ((alt && name === "backspace") || (ctrl && !alt && name === "w") || (ctrl && name === "backspace")) return commit(state, deleteTo(d, wordStep(d.text, at, -1)), "other");
  if ((alt && !ctrl && name === "d") || (ctrl && name === "delete")) return commit(state, deleteTo(d, wordStep(d.text, at, 1)), "other");
  if (ctrl && !alt && name === "u") return commit(state, deleteTo(d, lineStart(d.text, at)), "other");

  if ((ctrl && !alt && (name === "z" || name === "_") && !shift) || (meta && name === "z" && !shift)) return undo(state);
  if ((ctrl && shift && name === "z") || (meta && shift && name === "z")) return redo(state);
  return null;
}
