import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../../src/shared/protocol.js";
import { buildTurns } from "../../src/web/turns.js";
import { toolLine, turnMarkdown, TURN_MARKDOWN_MAX } from "../../src/web/turn-markdown.js";

const tool = (over: Partial<ToolItem>): ToolItem => ({ kind: "tool", id: "t", name: "bash", args: "", status: "done", output: "SECRET OUTPUT", truncated: false, category: "other", summary: "", paths: [], ...over });
const say = (id: string, text: string, thinking = ""): ChatItem => ({ kind: "assistant", id, text, thinking, streaming: false });
const turnOf = (items: ChatItem[]) => buildTurns(items, "idle")[0]!;
const user: ChatItem = { kind: "user", id: "u1", text: "Fix the `build`, see @src/app.ts" };

describe("turn as Markdown", () => {
  it("writes the prompt, one line per call, replies in order, and the answer", () => {
    const md = turnMarkdown(
      turnOf([
        user,
        say("a0", "Let me look at it first.", "private plan"),
        tool({ id: "t1", name: "read", category: "read", summary: "/home/u/proj/src/app.ts" }),
        tool({ id: "t2", name: "edit", category: "edit", summary: "/home/u/proj/src/app.ts", diffStat: { added: 12, removed: 3 } }),
        say("a1", "Now the tests.\n\n- one\n- two"),
        tool({ id: "t3", name: "bash", category: "command", summary: "npm test" }),
        say("a2", "Done: **fixed**\n\n```ts\nok\n```"),
      ]),
      "/home/u/proj",
    );
    expect(md).toBe(
      [
        "## Prompt",
        "",
        "Fix the `build`, see @src/app.ts",
        "",
        "## Work",
        "",
        "Let me look at it first.",
        "",
        "- **Read** `src/app.ts`\n- **Edit** `src/app.ts` (+12 −3)",
        "",
        "Now the tests.\n\n- one\n- two",
        "",
        "- **Run** `npm test`",
        "",
        "## Answer",
        "",
        "Done: **fixed**\n\n```ts\nok\n```",
        "",
      ].join("\n"),
    );
    expect(md).not.toContain("private plan");
    expect(md).not.toContain("SECRET OUTPUT");
  });

  it("marks a failed call, counts a write from its diff, and notes images and errors", () => {
    const diff = { added: 4, removed: 0, lines: [] };
    const md = turnMarkdown(
      turnOf([
        { kind: "user", id: "u", text: "go", imageCount: 2 },
        tool({ id: "t1", category: "command", summary: "make", status: "error" }),
        tool({ id: "t2", name: "write", category: "write", summary: "/p/new.ts", diff }),
        { kind: "notice", id: "n", level: "error", text: "rate limited" },
        say("a", "Could not finish."),
      ]),
      "/p",
    );
    expect(md).toContain("_2 images attached_");
    expect(md).toContain("- **Run** `make` (failed)");
    expect(md).toContain("- **Write** `new.ts` (+4 −0)");
    expect(md).toContain("> **Error:** rate limited");
  });

  it("skips the work section when there was none, and keeps work after the answer after it", () => {
    expect(turnMarkdown(turnOf([user, say("a", "Just words that are enough to be the whole reply here.")]), "/p")).not.toContain("## Work");
    const md = turnMarkdown(turnOf([user, say("a", "Here is the full answer.\n\nIt has two paragraphs."), tool({ id: "t", name: "todo", summary: "update" })]), "/p");
    expect(md.indexOf("## Answer")).toBeLessThan(md.indexOf("## Work after the answer"));
    expect(md).toContain("- **todo** `update`");
  });

  it("keeps a command's backticks and newlines from breaking its line", () => {
    expect(toolLine(tool({ category: "command", summary: "echo `date`\nls" }), "/p")).toBe("- **Run** ``echo `date` ls``");
    expect(toolLine(tool({ category: "command", summary: "`x`" }), "/p")).toBe("- **Run** `` `x` ``");
    expect(toolLine(tool({ name: "mcp__db__query", summary: "" }), "/p")).toBe("- **query · db**");
    expect(toolLine(tool({ category: "command", summary: "x".repeat(500) }), "/p").length).toBeLessThan(230);
  });

  it("cuts a turn past the cap and says so", () => {
    const md = turnMarkdown(turnOf([user, say("a", "word ".repeat(100_000))]), "/p");
    expect(md.length).toBeLessThan(TURN_MARKDOWN_MAX + 100);
    expect(md).toMatch(/_\(cut: this turn is longer than 200 KB\)_\n$/);
    expect(md.startsWith("## Prompt")).toBe(true);
  });
});
