import { describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { chatMarkdown, exportFileName } from "../../src/web/export.js";

const chat = {
  chatId: "c1",
  harnessId: asHarnessId("pi"),
  sessionId: "pi:abc",
  workspace: { id: "w", path: "/home/u/proj", name: "proj" },
  title: "Fix the build",
  status: "idle",
  items: [
    { kind: "user", id: "u1", text: "Fix the `build`", imageCount: 1 },
    { kind: "assistant", id: "a0", text: "", thinking: "hmm", streaming: false },
    {
      kind: "tool",
      id: "t1",
      name: "edit",
      args: "",
      status: "done",
      output: "",
      truncated: false,
      category: "edit",
      summary: "/home/u/proj/src/app.ts",
      paths: ["/home/u/proj/src/app.ts"],
      diff: {
        added: 1,
        removed: 1,
        lines: [
          { kind: "del", text: "const a = 1;", line: 3 },
          { kind: "add", text: "const a = 2;", line: 3 },
        ],
      },
    },
    { kind: "assistant", id: "a1", text: "Done: ```ts\nok\n```", thinking: "secret plan", streaming: false },
  ],
  queue: { steering: [], followUp: [] },
  pending: [],
  config: { model: "anthropic/opus", thinkingLevel: null, models: [], thinkingLevels: [] },
  extensionStatus: {},
  context: null,
  usage: null,
  todos: [],
  generation: 1,
  lastEventId: 0,
} as unknown as ChatSnapshot;

describe("chat export", () => {
  it("writes prompts, tools with their diffs, and answers, without thinking", () => {
    const md = chatMarkdown(chat, "Pi", new Date(2026, 9, 7, 12, 0));
    expect(md).toContain("# Fix the build");
    expect(md).toContain("- Harness: Pi · anthropic/opus");
    expect(md).toContain("## You\n\nFix the `build`\n\n_1 image attached_");
    expect(md).toContain("- `edit` src/app.ts");
    expect(md).toContain("  ```diff\n  -const a = 1;\n  +const a = 2;\n  ```");
    expect(md).toContain("## Pi\n\nDone: ```ts\nok\n```");
    expect(md).not.toContain("secret plan");
  });

  it("names the file after the title", () => {
    expect(exportFileName("Fix: the build (again)!")).toBe("fix-the-build-again.md");
    expect(exportFileName("…")).toBe("chat.md");
  });
});
