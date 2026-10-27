// Where a long paste sits in the composer's draft. A pasted block is plain text
// in the draft (the agent gets all of it, inline), so nothing in the text says
// it was a paste: the editor remembers each one as a range (id, start, length)
// and draws it as one chip (draft-chips.ts). This keeps those ranges true as the
// text changes: an edit before a range moves it, an edit inside or across it
// drops it (the text stays, it is just no longer one chip), and an edit after it
// leaves it. Pure and DOM-free, so it can be unit-tested; draft-history.ts keeps
// the ranges in its snapshots so undo and redo bring them back with the text.

/** One pasted block: `length` characters of the draft from `start`. */
export interface PasteRange {
  id: number;
  start: number;
  length: number;
}

/** A paste of at least this many lines becomes a chip... */
export const PASTE_MIN_LINES = 10;
/** ...and so does one of at least this many characters (a single long line). */
export const PASTE_MIN_CHARS = 1000;

/** The lines in a block of text; a line end at the very end does not start another. */
export function pasteLines(text: string): number {
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** Whether a paste is long enough to show as a chip. */
export function isLongPaste(text: string): boolean {
  return text.length >= PASTE_MIN_CHARS || pasteLines(text) >= PASTE_MIN_LINES;
}

/** "Pasted 200 lines", or "Pasted 1.2k chars" for a block of few, long lines. */
export function pasteLabel(text: string): string {
  const lines = pasteLines(text);
  if (lines >= PASTE_MIN_LINES) return `Pasted ${lines.toLocaleString("en-US")} lines`;
  const n = text.length;
  return `Pasted ${n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : n} chars`;
}

/** The ranges that still fit `text`: in order, inside it, not empty, not overlapping. */
export function usableRanges(text: string, ranges: readonly PasteRange[]): PasteRange[] {
  const out: PasteRange[] = [];
  let end = 0;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.length <= 0 || r.start < end || r.start + r.length > text.length) continue;
    out.push({ ...r });
    end = r.start + r.length;
  }
  return out;
}

/** `ranges` with one more, kept in order. */
export function addRange(ranges: readonly PasteRange[], range: PasteRange): PasteRange[] {
  return [...ranges, range].sort((a, b) => a.start - b.start);
}

/**
 * The ranges after the text from `start` to `end` is replaced by `inserted`
 * characters. A range wholly before the edit stays (text added right after it is
 * not part of it), one wholly after moves by the change in length, and one the
 * edit touches (inside it, or across its start or end) is dropped.
 */
export function shiftRanges(ranges: readonly PasteRange[], start: number, end: number, inserted: number): PasteRange[] {
  const delta = inserted - (end - start);
  const out: PasteRange[] = [];
  for (const r of ranges) {
    if (r.start + r.length <= start) out.push({ ...r });
    else if (r.start >= end) out.push({ ...r, start: r.start + delta });
  }
  return out;
}

/**
 * The same, for a change known only as the text before and after (the browser's
 * own edit, or the composer setting the draft). The edit is worked out from the
 * two strings, which is ambiguous when the text it adds or removes repeats the
 * text beside it (typing "a" after a paste that ends in "a"); the two extreme
 * readings are tried and a range they disagree about is dropped, which only
 * costs a chip, never text.
 */
export function shiftRangesDiff(ranges: readonly PasteRange[], before: string, after: string): PasteRange[] {
  if (before === after) return ranges.map((r) => ({ ...r }));
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const first = shiftRanges(ranges, prefix, before.length - suffix, after.length - prefix - suffix);
  let tail = 0;
  while (tail < max && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  let head = 0;
  while (head < max - tail && before[head] === after[head]) head++;
  const second = shiftRanges(ranges, head, before.length - tail, after.length - head - tail);
  return first.filter((r) => second.some((o) => o.id === r.id && o.start === r.start));
}
