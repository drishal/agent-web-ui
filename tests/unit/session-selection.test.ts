// The sidebar's selection rules (session-selection.ts): toggle, a shift-run, and
// what a refresh leaves.
import { describe, expect, it } from "vitest";
import { ranged, retained, toggled } from "../../src/web/session-selection.js";

describe("selecting sessions for a bulk action", () => {
  it("toggles one id without touching the rest, and without changing the input", () => {
    const before = new Set(["a", "c"]);
    expect([...toggled(before, "b")].sort()).toEqual(["a", "b", "c"]);
    expect([...toggled(before, "a")].sort()).toEqual(["c"]);
    expect([...before].sort()).toEqual(["a", "c"]);
  });

  it("runs from the anchor to the clicked row, in either direction", () => {
    const order = ["a", "b", "c", "d"];
    expect([...ranged(order, "a", "c")]).toEqual(["a", "b", "c"]);
    expect([...ranged(order, "d", "b")]).toEqual(["b", "c", "d"]);
    expect([...ranged(order, "b", "b")]).toEqual(["b"]);
  });

  it("falls back to the clicked row when the anchor is gone or there is none", () => {
    const order = ["a", "b"];
    expect([...ranged(order, null, "b")]).toEqual(["b"]);
    expect([...ranged(order, "gone", "b")]).toEqual(["b"]);
    expect([...ranged(["a"], "a", "gone")]).toEqual(["gone"]);
  });

  it("keeps only what the list still shows after a refresh", () => {
    expect([...retained(new Set(["a", "b", "c"]), ["b", "c", "d"])].sort()).toEqual(["b", "c"]);
    expect([...retained(new Set(["a"]), [])]).toEqual([]);
  });
});
