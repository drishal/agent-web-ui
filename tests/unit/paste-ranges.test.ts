// A long paste's place in the draft (paste-ranges.ts), and how undo carries it (draft-history.ts).
import { describe, expect, it } from "vitest";
import { addRange, isLongPaste, pasteLabel, pasteLines, shiftRanges, shiftRangesDiff, usableRanges, type PasteRange } from "../../src/web/paste-ranges.js";
import { chipLabel, draftPieces, withoutPiece } from "../../src/web/draft-chips.js";
import { DraftHistory } from "../../src/web/draft-history.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i + 1}`).join("\n");
const range = (id: number, start: number, length: number): PasteRange => ({ id, start, length });

describe("what counts as a long paste", () => {
  it("is ten lines or a thousand characters", () => {
    expect(isLongPaste(rows(9))).toBe(false);
    expect(isLongPaste(rows(10))).toBe(true);
    expect(isLongPaste("x".repeat(999))).toBe(false);
    expect(isLongPaste("x".repeat(1000))).toBe(true);
  });
  it("does not count a line end at the very end as another line", () => {
    expect(pasteLines(`${rows(9)}\n`)).toBe(9);
    expect(isLongPaste(`${rows(9)}\n`)).toBe(false);
    expect(pasteLines(`${rows(30)}\n`)).toBe(30);
  });
  it("is labelled by its lines, or by its characters when it is few long lines", () => {
    expect(pasteLabel(rows(200))).toBe("Pasted 200 lines");
    expect(pasteLabel(rows(1200))).toBe("Pasted 1,200 lines");
    expect(pasteLabel("x".repeat(1200))).toBe("Pasted 1.2k chars");
    expect(pasteLabel("x".repeat(1000))).toBe("Pasted 1k chars");
    expect(pasteLabel("a".repeat(400) + "\n" + "b".repeat(700))).toBe("Pasted 1.1k chars");
  });
});

describe("paste ranges follow the text", () => {
  it("moves a range when text is inserted or removed before it", () => {
    expect(shiftRanges([range(1, 10, 40)], 3, 3, 5)).toEqual([range(1, 15, 40)]);
    expect(shiftRanges([range(1, 10, 40)], 2, 6, 0)).toEqual([range(1, 6, 40)]);
  });
  it("leaves a range alone when the edit is after it, or right at its end", () => {
    expect(shiftRanges([range(1, 10, 40)], 50, 50, 7)).toEqual([range(1, 10, 40)]);
    expect(shiftRanges([range(1, 10, 40)], 60, 70, 0)).toEqual([range(1, 10, 40)]);
  });
  it("moves a range for text typed right at its start", () => {
    expect(shiftRanges([range(1, 10, 40)], 10, 10, 1)).toEqual([range(1, 11, 40)]);
  });
  it("drops a range edited inside, or deleted across", () => {
    expect(shiftRanges([range(1, 10, 40)], 20, 20, 1)).toEqual([]);
    expect(shiftRanges([range(1, 10, 40)], 25, 26, 0)).toEqual([]);
    expect(shiftRanges([range(1, 10, 40)], 5, 15, 0)).toEqual([]);
    expect(shiftRanges([range(1, 10, 40)], 45, 55, 2)).toEqual([]);
    expect(shiftRanges([range(1, 10, 40)], 0, 100, 3)).toEqual([]);
  });
  it("treats each range on its own", () => {
    expect(shiftRanges([range(1, 0, 10), range(2, 20, 10)], 12, 12, 4)).toEqual([range(1, 0, 10), range(2, 24, 10)]);
    expect(shiftRanges([range(1, 0, 10), range(2, 20, 10)], 5, 6, 0)).toEqual([range(2, 19, 10)]);
  });
  it("keeps ranges in order and in the text", () => {
    expect(addRange([range(2, 30, 5)], range(1, 0, 5)).map((r) => r.id)).toEqual([1, 2]);
    expect(usableRanges("0123456789", [range(2, 5, 10), range(1, 0, 4), range(3, 2, 3), range(4, 6, 0)])).toEqual([range(1, 0, 4)]);
  });
});

describe("paste ranges from the text before and after", () => {
  const paste = rows(12);
  const before = `see ${paste} now`;
  const at = [range(1, 4, paste.length)];
  it("moves, keeps, and drops as the exact edits do", () => {
    expect(shiftRangesDiff(at, before, `ok ${before}`)).toEqual([range(1, 7, paste.length)]);
    expect(shiftRangesDiff(at, before, `${before}!`)).toEqual(at);
    expect(shiftRangesDiff(at, before, before.replace("row 5", "row X"))).toEqual([]);
    expect(shiftRangesDiff(at, before, "see now")).toEqual([]);
    expect(shiftRangesDiff(at, before, "")).toEqual([]);
    expect(shiftRangesDiff(at, before, before)).toEqual(at);
  });
  it("drops a range rather than guess when the edit repeats the text beside it", () => {
    // "x" typed before a paste that starts with "x": it could be inside the paste or before it.
    const xs = "x".repeat(20);
    expect(shiftRangesDiff([range(1, 0, 20)], xs, `x${xs}`)).toEqual([]);
  });
});

describe("a paste as a chip", () => {
  const paste = rows(12);
  const text = `look at\n${paste}\nand then @src/a.ts now`;
  const ranges = [range(7, 8, paste.length)];
  it("draws the range as one piece and the rest as usual, giving the draft back exactly", () => {
    const pieces = draftPieces(text, undefined, ranges);
    expect(pieces.map((p) => p.kind)).toEqual(["text", "paste", "text", "file", "text"]);
    expect(pieces.map((p) => p.raw).join("")).toBe(text);
    expect(pieces[1]).toMatchObject({ kind: "paste", id: 7, start: 8, raw: paste });
    expect(chipLabel(pieces[1] as never, pieces.slice(0, 1))).toMatchObject({ label: "Pasted 12 lines" });
  });
  it("does not read quotes or references inside a paste", () => {
    const inner = `> quoted\n${rows(10)} @src/b.ts `;
    const t = `a ${inner} b`;
    const pieces = draftPieces(t, undefined, [range(1, 2, inner.length + 1)]);
    expect(pieces.map((p) => p.kind)).toEqual(["text", "paste", "text"]);
    expect(draftPieces(t).some((p) => p.kind === "quote" || p.kind === "file")).toBe(true);
  });
  it("shows the text as text once the range is gone", () => {
    expect(draftPieces(text, undefined, []).some((p) => p.kind === "paste")).toBe(false);
  });
  it("ignores a range that no longer fits the text", () => {
    expect(draftPieces("short", undefined, [range(1, 2, 40)]).map((p) => p.kind)).toEqual(["text"]);
  });
  it("removes the whole paste and nothing else", () => {
    const pieces = draftPieces("ab" + paste + "cd", undefined, [range(1, 2, paste.length)]);
    expect(withoutPiece("ab" + paste + "cd", pieces[1] as never)).toBe("abcd");
  });
});

describe("undo brings a paste back as a chip", () => {
  const paste = rows(12);
  const snap = (value: string, pastes: PasteRange[]) => ({ value, selection: [value.length, value.length] as [number, number], pastes });
  it("restores the ranges with the text, both ways", () => {
    const h = new DraftHistory();
    const pasted = "x " + paste;
    h.record(snap("x ", []), pasted, 0, "edit");
    const withChip = snap(pasted, [range(1, 2, paste.length)]);
    const gone = h.undo(withChip);
    expect(gone).toEqual(snap("x ", []));
    expect(h.redo(snap("x ", []))).toEqual(withChip);
  });
  it("brings back a chip that Backspace removed", () => {
    const h = new DraftHistory();
    const chip = snap("a" + paste, [range(1, 1, paste.length)]);
    h.record(chip, "a", 0, "edit");
    expect(h.undo(snap("a", []))).toEqual(chip);
  });
  it("keeps its own copy, so changing the ranges afterwards does not change the past", () => {
    const h = new DraftHistory();
    const ranges = [range(1, 2, paste.length)];
    h.record(snap("x" + paste, ranges), "y", 0, "edit");
    ranges[0] = range(9, 9, 9);
    expect(h.undo(snap("y", []))?.pastes).toEqual([range(1, 2, paste.length)]);
  });
});
