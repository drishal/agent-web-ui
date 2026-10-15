// Review in a terminal, apart from the drawing: every changed file's edits
// as rows (a file's heading, each edit's heading, its diff lines), where the
// line cursor may stand (a line that takes a comment), moving it a line or a
// file at a time, and which rows fit on screen around it. The model is the
// web UI's (web/review.ts): the same comments, the same prompt.
import type { DiffLine } from "../shared/protocol.js";
import { commentable, commentKey, type FileChanges } from "../web/review.js";

export type ReviewRow =
  | { kind: "file"; file: number; path: string; added: number; removed: number }
  | { kind: "edit"; file: number; label: string }
  | { kind: "line"; file: number; path: string; key: string; line: DiffLine };

export function reviewRows(files: FileChanges[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  files.forEach((f, file) => {
    rows.push({ kind: "file", file, path: f.path, added: f.added, removed: f.removed });
    for (const { tool, turn } of f.edits) {
      if (!tool.diff) continue;
      rows.push({ kind: "edit", file, label: `${turn > 0 ? `turn ${turn} · ` : ""}${tool.name}` });
      tool.diff.lines.forEach((line, i) => rows.push({ kind: "line", file, path: f.path, key: commentKey(tool.id, i), line }));
    }
  });
  return rows;
}

const stop = (row: ReviewRow | undefined): boolean => row?.kind === "line" && commentable(row.line);

/** The first row the cursor may stand on, or -1. */
export const firstStop = (rows: ReviewRow[]): number => rows.findIndex(stop);

/** The cursor `by` stops on (lines that take a comment), held at the ends. */
export function moveCursor(rows: ReviewRow[], at: number, by: number): number {
  let i = at;
  for (let n = 0; n < Math.abs(by); n++) {
    let next = i + Math.sign(by);
    while (next >= 0 && next < rows.length && !stop(rows[next])) next += Math.sign(by);
    if (next < 0 || next >= rows.length) break;
    i = next;
  }
  return i;
}

/** The cursor on the next (or previous) file's first line, held at the ends. */
export function moveFile(rows: ReviewRow[], at: number, by: 1 | -1): number {
  const file = (rows[at] as Extract<ReviewRow, { kind: "line" }> | undefined)?.file ?? 0;
  const target = rows.findIndex((r) => stop(r) && r.file === file + by);
  return target < 0 ? at : target;
}

/** The first row to draw so that `at` sits a third of the way down `height` rows (or the top or the end is reached). */
export function windowStart(total: number, at: number, height: number): number {
  return Math.max(0, Math.min(at - Math.floor(height / 3), total - height));
}
