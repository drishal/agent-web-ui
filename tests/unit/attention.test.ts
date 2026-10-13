// What needs you (attention.ts): the count and the title.
import { describe, expect, it } from "vitest";
import { attentionCount, titleWith } from "../../src/web/attention.js";

describe("what needs you", () => {
  it("counts each chat once and puts the count before the title", () => {
    expect(attentionCount(["a", "b"], ["b", "c"])).toBe(3);
    expect(titleWith(0, "awui")).toBe("awui");
    expect(titleWith(2, "Chat · awui")).toBe("(2) Chat · awui");
    expect(titleWith(150, "awui")).toBe("(99+) awui");
  });
});
