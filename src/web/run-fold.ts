// Which rows of a long run of calls the card draws. Past FOLD_AFTER calls it shows
// the first HEAD_CALLS, a "Show N more calls" button, and the last TAIL_CALLS, so a
// long agent run scans at a glance. A running call and a failed call are never
// hidden (the gap closes around them, one button per gap); a thought or notice that
// sits wholly inside a gap goes with it, while a question waiting on you never does.
// Pure: Conversation draws the result, find.ts uses the same limit.
import type { ChatItem } from "../shared/protocol.js";

/** A run of more calls than this is folded. */
export const FOLD_AFTER = 8;
export const HEAD_CALLS = 3;
export const TAIL_CALLS = 2;

export interface RunFold {
  /** Per item: not drawn while the run is folded. */
  hidden: boolean[];
  /** For the first hidden item of each gap: how many calls the gap holds. */
  more: Map<number, number>;
}

/** How many calls a list of items holds. */
export function callCount(items: readonly ChatItem[]): number {
  return items.filter((item) => item.kind === "tool").length;
}

/** The rows to hide in `items`; nothing when the run is short or `expanded`. */
export function foldRun(items: readonly ChatItem[], expanded: boolean): RunFold {
  const hidden = items.map(() => false);
  const more = new Map<number, number>();
  const calls = items.flatMap((item, i) => (item.kind === "tool" ? [i] : []));
  if (expanded || calls.length <= FOLD_AFTER) return { hidden, more };
  calls.slice(HEAD_CALLS, calls.length - TAIL_CALLS).forEach((i) => {
    const item = items[i];
    if (item?.kind === "tool" && item.status === "done") hidden[i] = true;
  });
  // A thought or notice between two hidden calls goes with them.
  for (let n = 1; n < calls.length; n++) {
    const [before, after] = [calls[n - 1] as number, calls[n] as number];
    if (!hidden[before] || !hidden[after]) continue;
    for (let i = before + 1; i < after; i++) if (items[i]?.kind === "assistant" || items[i]?.kind === "notice") hidden[i] = true;
  }
  let gap = -1;
  items.forEach((item, i) => {
    if (!hidden[i]) {
      gap = -1;
      return;
    }
    if (gap < 0) {
      gap = i;
      more.set(i, 0);
    }
    if (item.kind === "tool") more.set(gap, (more.get(gap) ?? 0) + 1);
  });
  return { hidden, more };
}

/** The button's name: "Show 7 more calls". */
export function moreLabel(n: number): string {
  return `Show ${n} more ${n === 1 ? "call" : "calls"}`;
}
