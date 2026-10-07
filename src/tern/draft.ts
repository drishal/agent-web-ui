// The composer's text and caret. Tern leaves typing to the program (native
// editing only takes selections and drawn-line moves), so keys edit it here.
import type { Key } from "@stencil-hq/tern";

export interface Draft {
  text: string;
  /** UTF-16 offset. */
  cursor: number;
}

/** One code point left or right, never splitting a surrogate pair. */
function step(text: string, cursor: number, direction: -1 | 1): number {
  if (direction === 1) return Math.min(text.length, cursor + ((text.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1));
  const low = text.charCodeAt(cursor - 1);
  const high = text.charCodeAt(cursor - 2);
  return Math.max(0, cursor - (low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1));
}

/** The start of the word left of the caret, skipping spaces first. */
function wordLeft(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1] as string)) i--;
  while (i > 0 && !/\s/.test(text[i - 1] as string)) i--;
  return i;
}

function wordRight(text: string, cursor: number): number {
  let i = cursor;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  while (i < text.length && !/\s/.test(text[i] as string)) i++;
  return i;
}

function lineStart(text: string, cursor: number): number {
  return text.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
  const nl = text.indexOf("\n", cursor);
  return nl === -1 ? text.length : nl;
}

function replace(draft: Draft, from: number, to: number, inserted: string): void {
  draft.text = draft.text.slice(0, from) + inserted + draft.text.slice(to);
  draft.cursor = from + inserted.length;
}

/** Ctrl, or Meta: Tern can report a PC keyboard's Ctrl as Meta (it stands for ⌘ there). */
export const chord = (key: Key, name: string): boolean => (key.ctrl || key.meta) && !key.alt && key.name === name;

export function insert(draft: Draft, text: string): void {
  replace(draft, draft.cursor, draft.cursor, text);
}

/** Applies an editing key; false when the key is not an edit (Enter, Escape and chords are the caller's). */
export function editDraft(draft: Draft, key: Key): boolean {
  const { text, cursor } = draft;
  const word = key.alt || key.ctrl || key.meta;
  switch (key.name) {
    case "backspace":
      replace(draft, word ? wordLeft(text, cursor) : step(text, cursor, -1), cursor, "");
      return true;
    case "delete":
      replace(draft, cursor, word ? wordRight(text, cursor) : step(text, cursor, 1), "");
      return true;
    case "left":
      draft.cursor = word ? wordLeft(text, cursor) : step(text, cursor, -1);
      return true;
    case "right":
      draft.cursor = word ? wordRight(text, cursor) : step(text, cursor, 1);
      return true;
    case "home":
      draft.cursor = lineStart(text, cursor);
      return true;
    case "end":
      draft.cursor = lineEnd(text, cursor);
      return true;
    case "paste":
      insert(draft, (key.text ?? "").replace(/\r\n?/g, "\n"));
      return true;
  }
  if ((key.ctrl || key.meta) && !key.alt) {
    switch (key.name) {
      case "a":
        draft.cursor = lineStart(text, cursor);
        return true;
      case "e":
        draft.cursor = lineEnd(text, cursor);
        return true;
      case "w":
        replace(draft, wordLeft(text, cursor), cursor, "");
        return true;
      case "u":
        replace(draft, lineStart(text, cursor), cursor, "");
        return true;
      case "k":
        replace(draft, cursor, lineEnd(text, cursor), "");
        return true;
    }
    return false;
  }
  if (key.meta || key.ctrl || key.alt || key.text === undefined) return false;
  insert(draft, key.text);
  return true;
}
