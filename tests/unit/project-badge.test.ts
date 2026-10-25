// A project's monogram (project-badge.ts): a letter, and a hue that does not move.
import { describe, expect, it } from "vitest";
import { projectMonogram } from "../../src/web/project-badge.js";

describe("a project's monogram", () => {
  it("takes the first letter, in a hue inside the circle", () => {
    const badge = projectMonogram("alpha");
    expect(badge.letter).toBe("A");
    expect(badge.hue).toBeGreaterThanOrEqual(0);
    expect(badge.hue).toBeLessThan(360);
    expect(projectMonogram("alpha")).toEqual(badge);
  });

  it("skips leading punctuation, keeps a digit, and has an answer for a nameless folder", () => {
    expect(projectMonogram("  _wild-project").letter).toBe("W");
    expect(projectMonogram("42-answers").letter).toBe("4");
    expect(projectMonogram("émile").letter).toBe("É");
    expect(projectMonogram("   ").letter).toBe("?");
  });

  it("gives different names different hues, mostly", () => {
    const hues = new Set(["alpha", "beta", "gamma", "webui", "dotfiles"].map((n) => projectMonogram(n).hue));
    expect(hues.size).toBeGreaterThan(1);
  });
});
