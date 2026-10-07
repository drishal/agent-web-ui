import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../../src/shared/protocol.js";
import { collectChanges, commentKey, reviewPrompt, type ReviewComment } from "../../src/web/review.js";

const edit = (id: string, path: string, added: number, status: ToolItem["status"] = "done"): ToolItem => ({
  kind: "tool",
  id,
  name: "edit",
  args: "",
  status,
  output: "",
  truncated: false,
  category: "edit",
  summary: path,
  paths: [path],
  diff: { added, removed: 1, lines: [{ kind: "del", text: "old", line: 4 }, { kind: "add", text: "  new();", line: 4 }] },
});

const items: ChatItem[] = [
  { kind: "user", id: "u1", text: "first" },
  edit("e1", "/p/src/a.ts", 2),
  edit("e2", "/p/src/b.ts", 1),
  { kind: "user", id: "u2", text: "second" },
  edit("e3", "/p/src/a.ts", 3),
  edit("e4", "/p/src/c.ts", 1, "error"),
];

describe("review", () => {
  it("groups the chat's finished edits by file, in the order files were first touched", () => {
    const files = collectChanges(items, "/p");
    expect(files.map((f) => [f.path, f.edits.map((e) => [e.tool.id, e.turn]), f.added, f.removed])).toEqual([
      ["src/a.ts", [["e1", 1], ["e3", 2]], 5, 2],
      ["src/b.ts", [["e2", 1]], 1, 1],
    ]);
  });

  it("turns comments into one prompt naming each line", () => {
    const files = collectChanges(items, "/p");
    const lines = files[0]?.edits[0]?.tool.diff?.lines ?? [];
    const comments: ReviewComment[] = [
      { key: commentKey("e1", 1), path: "src/a.ts", line: lines[1] as never, text: "Call it with the config. " },
      { key: commentKey("e1", 0), path: "src/a.ts", line: lines[0] as never, text: "Keep this one" },
    ];
    expect(reviewPrompt(comments)).toBe(
      "Review comments on your changes:\n\nsrc/a.ts:4\n    + new();\nCall it with the config.\n\nsrc/a.ts (removed line 4)\n    - old\nKeep this one",
    );
  });
});
