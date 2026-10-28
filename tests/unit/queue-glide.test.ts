import { describe, expect, it } from "vitest";
import { announceLanding, claimLanding, glideOffset, ranFromQueue } from "../../src/web/queue-glide.js";

describe("queue glide", () => {
  it("hands a prompt the spot of the queue row that ran, whichever came first", () => {
    const got: unknown[] = [];
    announceLanding("first", { left: 10, top: 20 }, 1000);
    claimLanding("first", (s) => got.push(s), 1100);
    claimLanding("second", (s) => got.push(s), 1200);
    announceLanding(" second ", { left: 1, top: 2 }, 1300);
    expect(got).toEqual([{ left: 10, top: 20 }, { left: 1, top: 2 }]);
  });
  it("lets a stale landing go, and a cancelled wait does nothing", () => {
    const got: unknown[] = [];
    announceLanding("old", { left: 1, top: 1 }, 0);
    claimLanding("old", (s) => got.push(s), 10_000);
    const cancel = claimLanding("later", (s) => got.push(s), 10_000);
    cancel();
    announceLanding("later", { left: 5, top: 5 }, 10_100);
    expect(got).toEqual([]);
  });
  it("offsets from the prompt to the row, and not at all when they coincide", () => {
    expect(glideOffset({ left: 10, top: 300 }, { left: 40, top: 100 })).toEqual({ dx: -30, dy: 200 });
    expect(glideOffset({ left: 4, top: 4 }, { left: 4, top: 4 })).toBeNull();
  });
  it("finds which queued texts ran, not the ones the user removed or edited", () => {
    expect(ranFromQueue(["a", "b", "c"], ["c"], new Set(["b"]))).toEqual(["a"]);
    expect(ranFromQueue(["a", "a"], ["a"], new Set())).toEqual(["a"]);
  });
});
