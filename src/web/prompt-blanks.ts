// Saved prompts' pure parts, shared by the web composer and atui's: the
// `{{blanks}}` a prompt leaves to fill in, which one Tab goes to next, and
// which prompts match what follows `#`.
import type { SavedPrompt } from "../shared/protocol.js";

/** A `{{label}}` to fill in, as offsets into the text. */
export interface Blank {
  start: number;
  end: number;
  label: string;
}

const BLANK = /\{\{([^{}\n]{0,60})\}\}/g;

export function blanks(text: string): Blank[] {
  return [...text.matchAll(BLANK)].map((m) => ({ start: m.index, end: m.index + m[0].length, label: (m[1] ?? "").trim() }));
}

/**
 * The blank to go to from the caret: the next one at or after `from` (round
 * to the first), or with `back` the last one before `from` (round to the
 * last). Null when the text has none.
 */
export function nextBlank(text: string, from: number, back = false): Blank | null {
  const all = blanks(text);
  if (all.length === 0) return null;
  if (back) return [...all].reverse().find((b) => b.end < from) ?? (all[all.length - 1] as Blank);
  return all.find((b) => b.start >= from) ?? (all[0] as Blank);
}

/** Saved prompts for what follows `#`: a name's start, then inside a name, then the text; all, by name, for nothing typed. */
export function matchPrompts(list: SavedPrompt[], query: string): SavedPrompt[] {
  const q = query.toLowerCase();
  if (!q) return list;
  const rank = (p: SavedPrompt) => {
    const name = p.name.toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : p.text.toLowerCase().includes(q) ? 2 : -1;
  };
  return list
    .map((p, i) => ({ p, i, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

/** A prompt's first line, for a menu. */
export const promptGist = (p: SavedPrompt): string => p.text.trim().split("\n")[0]?.replace(BLANK, (_, label: string) => `‹${label.trim() || "…"}›`) ?? "";
