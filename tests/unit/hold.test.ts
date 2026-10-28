// The hold-to-confirm clock (hold.ts): when a press fires, how an early
// let-go cancels, and how a done press can't fire twice.
import { describe, expect, it } from "vitest";
import { makeHold } from "../../src/web/hold.js";

describe("makeHold", () => {
  const setup = () => {
    let fired = 0;
    const h = makeHold(600, () => fired++);
    return { h, fired: () => fired };
  };

  it("idles until a press, then fills and fires once past holdMs", () => {
    const { h, fired } = setup();
    expect(h.holding).toBe(false);
    expect(h.tick(0)).toBe(0);
    h.down(1000);
    expect(h.holding).toBe(true);
    expect(h.tick(1000)).toBe(0);
    expect(h.tick(1300)).toBeCloseTo(0.5);
    expect(fired()).toBe(0);
    expect(h.tick(1599)).toBeLessThan(1);
    h.tick(1600);
    expect(fired()).toBe(1);
    // Past the threshold it keeps reporting full, and won't fire again.
    expect(h.tick(1700)).toBe(1);
    expect(fired()).toBe(1);
  });

  it("an early let-go cancels and the next press starts over", () => {
    const { h, fired } = setup();
    h.down(0);
    h.tick(300);
    h.up();
    expect(h.holding).toBe(false);
    expect(h.tick(400)).toBe(0);
    expect(fired()).toBe(0);
    h.down(500);
    h.tick(500 + 550);
    h.up();
    expect(fired()).toBe(0);
  });

  it("cancel resets mid-press without firing", () => {
    const { h, fired } = setup();
    h.down(0);
    h.tick(300);
    h.cancel();
    expect(h.holding).toBe(false);
    expect(fired()).toBe(0);
  });

  it("fires only once even if the press is held past the threshold", () => {
    const { h, fired } = setup();
    h.down(0);
    for (const t of [100, 300, 600, 900, 1200]) h.tick(t);
    expect(fired()).toBe(1);
  });

  it("a second press is a new hold and can fire again", () => {
    const { h, fired } = setup();
    h.down(0);
    h.tick(700);
    h.up();
    expect(fired()).toBe(1);
    h.down(2000);
    h.tick(2000 + 599);
    h.up();
    expect(fired()).toBe(1);
    h.down(3000);
    h.tick(3000 + 600);
    h.up();
    expect(fired()).toBe(2);
  });

  it("fires on the very tick the threshold is reached", () => {
    const { h, fired } = setup();
    h.down(100);
    h.tick(700);
    expect(fired()).toBe(1);
  });
});
