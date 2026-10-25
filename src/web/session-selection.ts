// Which sessions the sidebar has selected for a bulk action. Pure, so the click
// rules — a toggle, and a shift-run inside the order the list is showing — can be
// tested without rendering it.
export type Selection = ReadonlySet<string>;

/** Ctrl/⌘-click: one more or one fewer, leaving the rest as they were. */
export function toggled(selection: Selection, id: string): Set<string> {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Shift-click: every id from the anchor to `id` in the order shown, inclusive,
 * in either direction. No anchor, or one the list no longer holds, selects just
 * `id` — the run follows what is on screen, not what was selected before.
 */
export function ranged(ordered: readonly string[], anchor: string | null, id: string): Set<string> {
  const to = ordered.indexOf(id);
  if (to < 0) return new Set([id]);
  const from = anchor === null ? -1 : ordered.indexOf(anchor);
  if (from < 0) return new Set([id]);
  const [start, end] = from <= to ? [from, to] : [to, from];
  return new Set(ordered.slice(start, end + 1));
}

/** What is left after a refresh: a selection cannot outlive the rows it names. */
export function retained(selection: Selection, ordered: readonly string[]): Set<string> {
  const present = new Set(ordered);
  return new Set([...selection].filter((id) => present.has(id)));
}
