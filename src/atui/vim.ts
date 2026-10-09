// atui's vim mode: Esc leaves the composer for NORMAL, where keys move around
// the conversation instead of typing; i, a, o, or Enter go back to INSERT.
// Only navigation: the composer itself stays a plain editor.
//
//   j k / ↓ ↑     a line (with a count: 5j)      Ctrl+E Ctrl+Y  a line
//   Ctrl+D Ctrl+U half a page                    Ctrl+F Ctrl+B  a page
//   gg G          top, bottom                    { }  [ ]       previous, next turn
//   zR zM         open, fold every turn's work   h              the session list
//   :             the command palette            /              the history
//
// Worked out apart from the drawing (a key and what came before it in, an
// action and the new prefix out), so it can be tested.

export type VimAction =
  | { kind: "scroll"; lines: number }
  | { kind: "half"; dir: 1 | -1 }
  | { kind: "page"; dir: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "turn"; count: number }
  | { kind: "folds"; open: boolean }
  | { kind: "insert" }
  | { kind: "sidebar" }
  | { kind: "palette" }
  | { kind: "history" };

export interface VimKey {
  name: string;
  sequence: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/** What NORMAL mode does with `key`, given the keys before it (a count, a `g` or `z`): the action, or none yet, and what is now pending. */
export function vimKey(key: VimKey, pending: string): { action: VimAction | null; pending: string } {
  const none = { action: null, pending: "" };
  if (key.meta) return none;
  const count = Number(/^\d+/.exec(pending)?.[0] ?? "1") || 1;
  const prefix = pending.replace(/^\d+/, "");
  const ch = key.sequence.length === 1 ? key.sequence : "";

  if (key.ctrl) {
    const ctrl: Record<string, VimAction> = {
      d: { kind: "half", dir: 1 },
      u: { kind: "half", dir: -1 },
      f: { kind: "page", dir: 1 },
      b: { kind: "page", dir: -1 },
      e: { kind: "scroll", lines: count },
      y: { kind: "scroll", lines: -count },
    };
    const action = ctrl[key.name];
    return action ? { action, pending: "" } : none;
  }

  if (prefix === "g") return ch === "g" ? { action: { kind: "top" }, pending: "" } : none;
  if (prefix === "z") {
    if (ch === "R" || ch === "o") return { action: { kind: "folds", open: true }, pending: "" };
    if (ch === "M" || ch === "c") return { action: { kind: "folds", open: false }, pending: "" };
    return none;
  }

  // A count: 1-9 starts one, 0 continues it.
  if (/^[1-9]$/.test(ch) || (ch === "0" && /^\d+$/.test(pending))) return { action: null, pending: `${pending}${ch}` };

  switch (ch || key.name) {
    case "j":
    case "down":
      return { action: { kind: "scroll", lines: count }, pending: "" };
    case "k":
    case "up":
      return { action: { kind: "scroll", lines: -count }, pending: "" };
    case "g":
      return { action: null, pending: `${pending}g` };
    case "z":
      return { action: null, pending: `${pending}z` };
    case "G":
      return { action: { kind: "bottom" }, pending: "" };
    case "}":
    case "]":
      return { action: { kind: "turn", count }, pending: "" };
    case "{":
    case "[":
      return { action: { kind: "turn", count: -count }, pending: "" };
    case "i":
    case "a":
    case "o":
    case "I":
    case "A":
    case "return":
      return { action: { kind: "insert" }, pending: "" };
    case "h":
      return { action: { kind: "sidebar" }, pending: "" };
    case ":":
      return { action: { kind: "palette" }, pending: "" };
    case "/":
      return { action: { kind: "history" }, pending: "" };
    default:
      return none;
  }
}

/** How far to scroll to bring the next (or previous) turn's top to the top of the view. */
export function turnOffset(tops: number[], viewTop: number, count: number): number | null {
  const sorted = [...tops].sort((a, b) => a - b);
  if (count > 0) {
    const below = sorted.filter((y) => y > viewTop);
    const target = below[Math.min(count, below.length) - 1];
    return target === undefined ? null : target - viewTop;
  }
  const above = sorted.filter((y) => y < viewTop);
  const target = above[Math.max(0, above.length + count)];
  return target === undefined ? null : target - viewTop;
}
