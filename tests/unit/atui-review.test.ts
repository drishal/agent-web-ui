import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { firstStop, moveCursor, moveFile, reviewRows, windowStart } from "../../src/atui/review.js";
import type { FileChanges } from "../../src/web/review.js";

const edit = (id: string, lines: Array<[string, string, number?]>): ToolItem =>
  ({ kind: "tool", id, name: "edit", category: "edit", status: "done", diff: { lines: lines.map(([kind, text, line]) => ({ kind, text, line })), added: 1, removed: 1 } }) as unknown as ToolItem;

const files: FileChanges[] = [
  { path: "a.ts", added: 1, removed: 1, edits: [{ turn: 2, tool: edit("t1", [["hunk", "@@"], ["del", "old", 3], ["add", "new", 3], ["ctx", "same", 4]]) }] },
  { path: "b.ts", added: 1, removed: 0, edits: [{ turn: 3, tool: edit("t2", [["add", "only", 1]]) }] },
];

describe("review in atui", () => {
  it("lays every file's edits out as rows: the file, the edit, its lines", () => {
    const rows = reviewRows(files);
    expect(rows.map((r) => (r.kind === "line" ? `${r.line.kind}:${r.key}` : r.kind === "edit" ? `edit:${r.label}` : `file:${r.path}`))).toEqual([
      "file:a.ts",
      "edit:turn 2 · edit",
      "hunk:t1:0",
      "del:t1:1",
      "add:t1:2",
      "ctx:t1:3",
      "file:b.ts",
      "edit:turn 3 · edit",
      "add:t2:0",
    ]);
  });

  it("moves the cursor over lines that take a comment, and a file at a time", () => {
    const rows = reviewRows(files);
    const first = firstStop(rows);
    expect(first).toBe(3);
    expect(moveCursor(rows, first, 1)).toBe(4);
    expect(moveCursor(rows, 5, 1)).toBe(8);
    expect(moveCursor(rows, 8, 5)).toBe(8);
    expect(moveCursor(rows, first, -1)).toBe(first);
    expect(moveFile(rows, first, 1)).toBe(8);
    expect(moveFile(rows, 8, -1)).toBe(3);
    expect(moveFile(rows, 8, 1)).toBe(8);
    expect(firstStop([])).toBe(-1);
  });

  it("keeps the cursor a third of the way down, without running past either end", () => {
    expect(windowStart(100, 50, 30)).toBe(40);
    expect(windowStart(100, 2, 30)).toBe(0);
    expect(windowStart(100, 99, 30)).toBe(70);
    expect(windowStart(10, 5, 30)).toBe(0);
  });
});
