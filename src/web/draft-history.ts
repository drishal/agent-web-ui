// Undo and redo for the composer's draft (ChipEditor.tsx). The box redraws
// itself from the plain-text draft, which wipes the browser's own undo stack, so
// the editor keeps this one: bounded snapshots of the draft and its selection,
// pure and clock-free (the caller passes the time) so it can be unit-tested.
// Plain typing (or erasing) one character at a time folds into one entry until a
// pause, a space or line break, or a caret jump; anything else is its own entry.

/** The draft and the selection it had. */
export interface DraftSnap {
  value: string;
  selection: [number, number];
}

type Kind = "type" | "erase" | "edit";

/** How many steps are kept. */
export const HISTORY_LIMIT = 200;
/** A pause this long (ms) ends a typing burst. */
export const BURST_MS = 1000;

/** What one change did, judged from the two strings: a single character typed or erased, or something else. */
function classify(before: string, after: string): { kind: Kind; at: number } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  if (after.length === before.length + 1 && after.slice(p + 1) === before.slice(p) && !/\s/.test(after[p] ?? "")) return { kind: "type", at: p };
  if (after.length === before.length - 1 && before.slice(p + 1) === after.slice(p)) return { kind: "erase", at: p };
  return { kind: "edit", at: p };
}

export class DraftHistory {
  private undos: DraftSnap[] = [];
  private redos: DraftSnap[] = [];
  private last: { kind: Kind; value: string; at: number; time: number } | null = null;

  /** Note a change from `before` to `after` (a snapshot is kept unless the change joins the previous burst). `kind` "edit" forces its own entry. */
  record(before: DraftSnap, after: string, now: number, kind?: "edit"): void {
    if (before.value === after) return;
    const c = classify(before.value, after);
    const k = kind ?? c.kind;
    const last = this.last;
    const joins =
      k !== "edit" &&
      last !== null &&
      last.kind === k &&
      last.value === before.value &&
      now - last.time < BURST_MS &&
      (k === "type" ? c.at === last.at + 1 : c.at === last.at || c.at === last.at - 1);
    if (!joins) {
      this.undos.push({ value: before.value, selection: [...before.selection] });
      if (this.undos.length > HISTORY_LIMIT) this.undos.shift();
    }
    this.redos = [];
    this.last = { kind: k, value: after, at: c.at, time: now };
  }

  /** Forget everything (the draft was sent or cleared). */
  reset(): void {
    this.undos = [];
    this.redos = [];
    this.last = null;
  }

  /** The snapshot to go back to, given the draft now; null when there is nothing (different) to go back to. */
  undo(now: DraftSnap): DraftSnap | null {
    return this.step(this.undos, this.redos, now);
  }

  redo(now: DraftSnap): DraftSnap | null {
    return this.step(this.redos, this.undos, now);
  }

  private step(from: DraftSnap[], to: DraftSnap[], now: DraftSnap): DraftSnap | null {
    this.last = null;
    for (let snap = from.pop(); snap; snap = from.pop()) {
      if (snap.value === now.value) continue;
      to.push({ value: now.value, selection: [...now.selection] });
      if (to.length > HISTORY_LIMIT) to.shift();
      return snap;
    }
    return null;
  }
}
