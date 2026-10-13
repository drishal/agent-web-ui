// Markdown lists in the composer (list-continue.ts).
import { describe, expect, it } from "vitest";
import { continueList, indentList } from "../../src/web/list-continue.js";

describe("lists in the composer", () => {
  it("continues bullets, numbers, and task boxes, and ends the list on an empty item", () => {
    expect(continueList("- one", 5)).toEqual({ text: "- one\n- ", caret: 8 });
    expect(continueList("  9. nine", 9)).toEqual({ text: "  9. nine\n  10. ", caret: 16 });
    expect(continueList("- [x] done", 10)).toEqual({ text: "- [x] done\n- [ ] ", caret: 17 });
    expect(continueList("- one\n- ", 8)).toEqual({ text: "- one\n", caret: 6 });
    expect(continueList("not a list", 10)).toBeNull();
    // A caret inside the marker is not the item's text.
    expect(continueList("- one", 1)).toBeNull();
  });

  it("indents and outdents the list items a selection touches, and leaves other text to Tab", () => {
    expect(indentList("- a\n- b", 0, 7, false)).toEqual({ text: "  - a\n  - b", from: 2, to: 11 });
    expect(indentList("  - a", 5, 5, true)).toEqual({ text: "- a", from: 3, to: 3 });
    expect(indentList("plain", 0, 5, false)).toBeNull();
  });
});
