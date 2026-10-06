import { describe, expect, it } from "vitest";
import { Arrivals } from "../../src/web/arrivals.js";

const items = (...ids: string[]) => ids.map((id) => ({ id }));

describe("arrivals", () => {
  it("animates only what comes in live, never a chat opened or loaded at once", () => {
    const a = new Arrivals();
    a.update("c1", items("u1", "a1", "t1"));
    expect(a.isFresh("u1")).toBe(false);
    const next = items("u1", "a1", "t1", "t2");
    a.update("c1", next);
    expect(a.isFresh("t2")).toBe(true);
    expect(a.isFresh("t1")).toBe(false);
    // A repeat render of the same list (StrictMode) keeps the answer.
    a.update("c1", next);
    expect(a.isFresh("t2")).toBe(true);
    // Many at once is a load (a resume's file), not a run.
    a.update("c1", items("u1", "a1", "t1", "t2", "x1", "x2", "x3", "x4", "x5"));
    expect(a.isFresh("x1")).toBe(false);
    // Switching chats shows the other at once, and back again.
    a.update("c2", items("v1", "v2"));
    expect(a.isFresh("v2")).toBe(false);
    a.update("c2", items("v1", "v2", "v3"));
    expect(a.isFresh("v3")).toBe(true);
  });
});
