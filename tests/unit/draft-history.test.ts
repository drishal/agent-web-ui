import { describe, expect, it } from "vitest";
import { DraftHistory, HISTORY_LIMIT } from "../../src/web/draft-history.js";

const snap = (value: string, at = value.length): { value: string; selection: [number, number] } => ({ value, selection: [at, at] });

/** Type `text` a character at a time, 50 ms apart from `t0`; returns the draft and the time after. */
function type(h: DraftHistory, from: string, text: string, t0 = 0): { value: string; t: number } {
  let value = from;
  let t = t0;
  for (const ch of text) {
    h.record(snap(value), value + ch, t);
    value += ch;
    t += 50;
  }
  return { value, t };
}

describe("draft history", () => {
  it("undoes a burst of typing as one step and redoes it", () => {
    const h = new DraftHistory();
    const { value } = type(h, "", "hello");
    expect(h.undo(snap(value))).toEqual(snap(""));
    expect(h.redo(snap(""))).toEqual(snap("hello"));
  });
  it("starts a new step at a space, after a pause, and at a caret jump", () => {
    const h = new DraftHistory();
    const a = type(h, "", "ab cd");
    // "ab", " ", "cd" is three steps: the space is its own.
    expect(h.undo(snap(a.value))?.value).toBe("ab ");
    const h2 = new DraftHistory();
    const b = type(h2, "", "ab");
    const c = type(h2, b.value, "cd", b.t + 5000);
    expect(h2.undo(snap(c.value))?.value).toBe("ab");
    const h3 = new DraftHistory();
    const d = type(h3, "", "ab");
    h3.record(snap(d.value, 0), "xab", d.t);
    expect(h3.undo(snap("xab"))?.value).toBe("ab");
  });
  it("keeps an edit as its own step, and a new change drops the redo", () => {
    const h = new DraftHistory();
    h.record(snap("a"), "a\n", 0, "edit");
    h.record(snap("a\n"), "a\nb", 10);
    expect(h.undo(snap("a\nb"))?.value).toBe("a\n");
    expect(h.undo(snap("a\n"))?.value).toBe("a");
    expect(h.undo(snap("a"))).toBeNull();
    h.redo(snap("a"));
    h.record(snap("a\n"), "a\nz", 20);
    expect(h.redo(snap("a\nz"))).toBeNull();
  });
  it("is bounded and can be reset", () => {
    const h = new DraftHistory();
    for (let i = 0; i < HISTORY_LIMIT + 50; i++) h.record(snap(`v${i}`), `v${i + 1}`, 0, "edit");
    let n = 0;
    let now = `v${HISTORY_LIMIT + 50}`;
    for (let s = h.undo(snap(now)); s; s = h.undo(snap(now))) {
      now = s.value;
      n++;
    }
    expect(n).toBe(HISTORY_LIMIT);
    h.reset();
    expect(h.undo(snap("x"))).toBeNull();
  });
});
