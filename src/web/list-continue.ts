// Markdown lists in the composer (T3 Code's): Shift+Enter on a list item
// starts the next one (a number counts up, a task box comes back empty),
// Shift+Enter on an empty item ends the list, and Tab / Shift+Tab indent and
// outdent the items the selection touches. Plain text in, plain text out.

const ITEM = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

function lineBounds(text: string, at: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const nl = text.indexOf("\n", at);
  return { start, end: nl < 0 ? text.length : nl };
}

/** The text and caret after Shift+Enter at `caret`, or null when the caret is not in a list item. */
export function continueList(text: string, caret: number): { text: string; caret: number } | null {
  const { start, end } = lineBounds(text, caret);
  const line = text.slice(start, end);
  const m = ITEM.exec(line);
  if (!m || caret < start + m[0].length) return null;
  const [marker, indent = "", bullet = "", num, delim = "", , box] = m;
  // An empty item: the list ends, and the line is left blank.
  if (!line.slice(marker.length).trim()) {
    return { text: text.slice(0, start) + text.slice(end), caret: start };
  }
  const nextBullet = num !== undefined ? `${Number(num) + 1}${delim}` : bullet;
  const insert = `\n${indent}${nextBullet} ${box ? "[ ] " : ""}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), caret: caret + insert.length };
}

/**
 * Indent (or outdent) the list items in the selection by two spaces. Null when
 * no line there is a list item, so Tab keeps its usual job.
 */
export function indentList(text: string, from: number, to: number, outdent: boolean): { text: string; from: number; to: number } | null {
  const first = lineBounds(text, from).start;
  const last = lineBounds(text, to).end;
  const lines = text.slice(first, last).split("\n");
  if (!lines.some((l) => ITEM.test(l))) return null;
  let shiftFrom = 0;
  let shiftTo = 0;
  const out = lines.map((line, i) => {
    if (!ITEM.test(line)) return line;
    const delta = outdent ? -Math.min(2, line.length - line.trimStart().length) : 2;
    if (i === 0) shiftFrom = delta;
    shiftTo += delta;
    return delta >= 0 ? `${"  ".slice(0, delta)}${line}` : line.slice(-delta);
  });
  const next = text.slice(0, first) + out.join("\n") + text.slice(last);
  return { text: next, from: Math.max(first, from + shiftFrom), to: Math.max(first, to + shiftTo) };
}
