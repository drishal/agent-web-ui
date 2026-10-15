import { describe, expect, it } from "vitest";
import type { SavedPrompt } from "../../src/shared/protocol.js";
import { blanks, matchPrompts, nextBlank, promptGist } from "../../src/web/prompt-blanks.js";

const prompt = (name: string, text: string): SavedPrompt => ({ id: name, name, text, updatedAt: 0 });

describe("saved prompts' blanks", () => {
  it("finds each {{blank}}, with its label, and leaves code braces alone", () => {
    const text = "Review {{file}} for {{ what }}; keep `if (x) { y }` and {{}} too";
    expect(blanks(text)).toEqual([
      { start: 7, end: 15, label: "file" },
      { start: 20, end: 30, label: "what" },
      { start: 56, end: 60, label: "" },
    ]);
  });

  it("goes to the next blank, round to the first, and back to the last before the caret", () => {
    const text = "a {{one}} b {{two}} c";
    expect(nextBlank(text, 0)).toMatchObject({ label: "one" });
    expect(nextBlank(text, 9)).toMatchObject({ label: "two" });
    expect(nextBlank(text, 20)).toMatchObject({ label: "one" });
    expect(nextBlank(text, 12, true)).toMatchObject({ label: "one" });
    expect(nextBlank(text, 2, true)).toMatchObject({ label: "two" });
    expect(nextBlank("no blanks", 0)).toBeNull();
  });

  it("matches # by a name's start, then inside a name, then the text, and shows a gist", () => {
    const list = [prompt("changelog", "Write it"), prompt("review", "Review {{file}}\nthen more"), prompt("tests", "Run the review checks")];
    expect(matchPrompts(list, "re").map((p) => p.name)).toEqual(["review", "tests"]);
    expect(matchPrompts(list, "log").map((p) => p.name)).toEqual(["changelog"]);
    expect(matchPrompts(list, "")).toHaveLength(3);
    expect(promptGist(list[1] as SavedPrompt)).toBe("Review ‹file›");
  });
});
