import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { harnessGlyph, neatRow, shortPath, splitComments, thoughtTitle, thoughtTokens } from "../../src/atui/neat.js";

const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: "tool",
  id: "t:1",
  name: "read",
  args: "{}",
  status: "done",
  output: "",
  truncated: false,
  category: "read",
  summary: "",
  paths: [],
  ...over,
});

describe("atui rows, neat-render's way", () => {
  it("words reads, commands, searches, and fetches with their outcome", () => {
    expect(neatRow(tool({ args: JSON.stringify({ path: "/w/src/a.ts", offset: 1, limit: 20 }), paths: ["/w/src/a.ts"], output: "a\nb\n" }), "/w")).toEqual({ label: "Read", glue: " ", detail: "src/a.ts:1-20", facts: ["2 lines"] });
    const bash = neatRow(tool({ name: "bash", category: "command", args: JSON.stringify({ command: "# check the tests\nnpm test" }), status: "error", output: "1 failed\nCommand exited with code 2" }), "/w");
    expect(bash).toEqual({ label: "Bash", glue: " ", detail: "$ npm test", note: "check the tests", facts: ["exit 2", "2 lines"] });
    expect(neatRow(tool({ name: "bash", category: "command", args: JSON.stringify({ command: "ls" }), output: "x" }), "/w").facts).toEqual(["1 line"]);
    expect(neatRow(tool({ name: "grep", category: "search", args: JSON.stringify({ pattern: "listen", path: "/w/src" }), paths: ["/w/src"], output: "a\nb" }), "/w")).toMatchObject({ detail: "listen in src", facts: ["2 results"] });
    expect(neatRow(tool({ name: "web_fetch", category: "web", args: JSON.stringify({ urls: ["https://example.com/a/", "https://b.dev"] }) }), "/w").detail).toBe("example.com/a +1 more");
  });

  it("names an edit Update(path), says its scale, and previews its changed lines", () => {
    const lines = [
      { kind: "ctx" as const, text: "far" },
      { kind: "ctx" as const, text: "near" },
      { kind: "del" as const, text: "a" },
      { kind: "add" as const, text: "b" },
      { kind: "ctx" as const, text: "after" },
      { kind: "ctx" as const, text: "far again" },
      { kind: "add" as const, text: "c" },
      { kind: "gap" as const, text: "" },
      { kind: "ctx" as const, text: "past the gap" },
    ];
    const row = neatRow(tool({ name: "edit", category: "edit", paths: ["/w/src/app.ts"], diffStat: { added: 2, removed: 1 }, diff: { lines, added: 2, removed: 1 } }), "/w");
    expect(row).toMatchObject({ label: "Update", glue: "", detail: "(src/app.ts)", facts: ["Added 2 lines, removed 1 line"] });
    expect(row.diff).toEqual([
      { marker: " ", text: "near" },
      { marker: "-", text: "a" },
      { marker: "+", text: "b" },
      { marker: " ", text: "after" },
      { marker: " ", text: "far again" },
      { marker: "+", text: "c" },
    ]);
    expect(neatRow(tool({ name: "write", category: "write", paths: ["/w/n.md"], diffStat: { added: 4, removed: 0 }, diff: { lines: [], added: 4, removed: 0 } }), "/w")).toMatchObject({ label: "Write", facts: ["Added 4 lines"] });
    expect(neatRow(tool({ name: "edit", category: "edit", paths: ["/w/a.ts"], status: "error" }), "/w").facts).toEqual(["failed"]);
  });

  it("splits a command's leading comments, but not a shebang or a command of only comments", () => {
    expect(splitComments("# look first\n# then list\nls -la")).toEqual({ note: "look first then list", command: "ls -la" });
    expect(splitComments("#!/bin/sh\necho hi")).toEqual({ command: "#!/bin/sh\necho hi" });
    expect(splitComments("# only a note")).toEqual({ command: "# only a note" });
    expect(splitComments("// js note\nconsole.log(1)", "//")).toEqual({ note: "js note", command: "console.log(1)" });
  });

  it("titles a thought by its bold heading or first sentence, and sizes it", () => {
    expect(thoughtTitle("**Inspecting the workflow**\n\nThe PR job runs…")).toBe("Inspecting the workflow");
    expect(thoughtTitle("```ts\ncode\n```\nThe server starts here. Then more.")).toBe("The server starts here.");
    expect(thoughtTokens("x".repeat(1360))).toBe("340");
    expect(thoughtTokens("x".repeat(6000))).toBe("1.5k");
  });

  it("shortens paths and marks the card with the harness", () => {
    expect(shortPath("/w/a/b/c/d/e.ts", "/w")).toBe("…/c/d/e.ts");
    expect(shortPath("/home/me/notes.md", "/w", "/home/me")).toBe("~/notes.md");
    expect(harnessGlyph("pi")).toBe("π");
    expect(harnessGlyph("fake")).toBe("F");
  });
});
