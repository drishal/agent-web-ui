// The composer's draft as the editor draws it: runs of text, and the references
// and quotes in it as chips (a file, a line range, a quoted passage). It is a
// view of the text the composer sends, never a second copy of it: every piece
// keeps its raw text, and joining the pieces gives the draft back exactly, so
// the wire text is what draft-segments.ts writes and nothing changes there.
// A quote's chip takes the blank lines around its block with it, so it sits in
// the sentence where it was put; removing the chip removes them too. A long
// paste is a chip too, but the text alone cannot say where one was: the editor
// passes the ranges it remembers (paste-ranges.ts), the text inside one is never
// read for quotes or references, and the rest is split as usual around it.
import { pasteLabel, usableRanges, type PasteRange } from "./paste-ranges.js";

export type DraftPiece =
  | { kind: "text"; start: number; raw: string }
  | { kind: "file"; start: number; raw: string; path: string; line?: number; end?: number }
  | { kind: "quote"; start: number; raw: string; text: string }
  | { kind: "paste"; start: number; raw: string; id: number };

/** One quoted line: `>` at the start of the line, its text after an optional space. */
const QUOTE_LINE = /^>[ \t]?(.*)$/;

/**
 * `@path`, `@path:12`, `@path:44-58` after a space or the start: a path has a
 * slash or a dot (so "@someone" stays a word), and a closing comma or stop
 * stays text.
 */
const FILE_REF = /(^|[\s(])@([^\s@:]+?)(?::(\d+)(?:[-–](\d+))?)?(?=$|[\s,;!?)\]]|\.(?:\s|$))/g;

function filePieces(text: string, at: number, out: DraftPiece[]) {
  let last = 0;
  for (const m of text.matchAll(FILE_REF)) {
    const path = m[2] as string;
    if (!/[/.]/.test(path.slice(0, -1))) continue;
    const from = (m.index ?? 0) + (m[1] as string).length;
    const raw = m[0].slice((m[1] as string).length);
    if (from > last) out.push({ kind: "text", start: at + last, raw: text.slice(last, from) });
    const line = m[3] !== undefined ? Number(m[3]) : undefined;
    const end = m[4] !== undefined ? Number(m[4]) : undefined;
    out.push({ kind: "file", start: at + from, raw, path, ...(line !== undefined ? { line } : {}), ...(end !== undefined && end !== line ? { end } : {}) });
    last = from + raw.length;
  }
  if (last < text.length) out.push({ kind: "text", start: at + last, raw: text.slice(last) });
}

/**
 * The draft's pieces, in order. `typing` is where the caret is while the user
 * types: a reference ending there is still being written, so it stays text
 * until something follows it. `pastes` are the long pastes the editor knows of.
 */
export function draftPieces(text: string, typing?: number, pastes?: readonly PasteRange[]): DraftPiece[] {
  const ranges = pastes && pastes.length > 0 ? usableRanges(text, pastes) : [];
  if (ranges.length === 0) return textPieces(text, typing);
  const out: DraftPiece[] = [];
  const gap = (from: number, to: number) => {
    if (to <= from) return;
    for (const p of textPieces(text.slice(from, to), typing !== undefined && typing >= from && typing <= to ? typing - from : undefined)) out.push({ ...p, start: p.start + from });
  };
  let at = 0;
  for (const r of ranges) {
    gap(at, r.start);
    out.push({ kind: "paste", start: r.start, raw: text.slice(r.start, r.start + r.length), id: r.id });
    at = r.start + r.length;
  }
  gap(at, text.length);
  return out;
}

/** The pieces of a run of text with no pastes in it. */
function textPieces(text: string, typing?: number): DraftPiece[] {
  const out: DraftPiece[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let plainFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (!QUOTE_LINE.test(lines[i] as string)) {
      offset += (lines[i] as string).length + 1;
      i++;
      continue;
    }
    // A block of quoted lines, with up to two line ends before it (when text precedes) and two after.
    const blockStart = offset;
    const quoted: string[] = [];
    while (i < lines.length && QUOTE_LINE.test(lines[i] as string)) {
      quoted.push((QUOTE_LINE.exec(lines[i] as string) as RegExpExecArray)[1] as string);
      offset += (lines[i] as string).length + 1;
      i++;
    }
    let from = blockStart;
    for (let k = 0; k < 2 && from > plainFrom && text[from - 1] === "\n"; k++) from--;
    let to = Math.min(offset, text.length);
    // The block's own line end is in `offset` already; one blank line after it goes with it too.
    if (to < text.length && text[to] === "\n" && i < lines.length && (lines[i] as string) === "" && i + 1 < lines.length) {
      to++;
      offset++;
      i++;
    }
    if (from > plainFrom) filePieces(text.slice(plainFrom, from), plainFrom, out);
    out.push({ kind: "quote", start: from, raw: text.slice(from, to), text: quoted.join("\n") });
    plainFrom = to;
  }
  if (plainFrom < text.length) filePieces(text.slice(plainFrom), plainFrom, out);
  if (typing === undefined) return out;
  // A reference the caret is still at the end of is being typed: text, merged with its neighbours.
  const merged: DraftPiece[] = [];
  for (const p of out) {
    const open = p.kind === "file" && p.start + p.raw.length === typing;
    const prev = merged[merged.length - 1];
    if ((open || p.kind === "text") && prev?.kind === "text") merged[merged.length - 1] = { ...prev, raw: prev.raw + p.raw };
    else merged.push(open ? { kind: "text", start: p.start, raw: p.raw } : p);
  }
  return merged;
}

/** "44–58", "12", or nothing: a reference's lines as the chip shows them. */
export function linesLabel(p: { line?: number; end?: number }): string {
  if (p.line === undefined) return "";
  return p.end !== undefined ? `${p.line}–${p.end}` : String(p.line);
}

/**
 * What a chip says. A file chip names its path; a line range of a file that an
 * earlier chip already names says only its lines ("at 44–58"), as one would in
 * a sentence. A quote shows its text, the start of it if it is long.
 */
export function chipLabel(piece: DraftPiece, before: readonly DraftPiece[]): { label: string; lines: string; title: string; linesOnly: boolean } {
  if (piece.kind === "quote") {
    const flat = piece.text.replace(/\s+/g, " ").trim();
    return { label: flat.length > 72 ? `${flat.slice(0, 70)}…` : flat, lines: "", title: piece.text, linesOnly: false };
  }
  if (piece.kind === "text") return { label: piece.raw, lines: "", title: "", linesOnly: false };
  if (piece.kind === "paste") return { label: pasteLabel(piece.raw), lines: "", title: piece.raw.length > 300 ? `${piece.raw.slice(0, 300)}…` : piece.raw, linesOnly: false };
  const lines = linesLabel(piece);
  const named = before.some((p) => p.kind === "file" && p.path === piece.path && p.line === undefined);
  return { label: piece.path, lines, title: piece.raw, linesOnly: lines !== "" && named };
}

/** The draft without one piece: removing a chip takes its raw text out, and nothing else. */
export function withoutPiece(text: string, piece: DraftPiece): string {
  if (text.slice(piece.start, piece.start + piece.raw.length) !== piece.raw) return text;
  const before = text.slice(0, piece.start);
  const after = text.slice(piece.start + piece.raw.length);
  // A reference in a sentence leaves one space, not two.
  if (piece.kind === "file" && / $/.test(before) && /^ /.test(after)) return before + after.slice(1);
  // A quote between two words took their blank lines with it: one space keeps them apart.
  if (piece.kind === "quote" && /\S$/.test(before) && /^\S/.test(after)) return `${before} ${after}`;
  return before + after;
}
