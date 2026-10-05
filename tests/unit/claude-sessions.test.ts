// Claude Code session files: entry shapes as Claude Code 2.1.289 writes them.
import { describe, expect, it } from "vitest";
import { historyToItems } from "../../src/server/harness/agent-events.js";
import {
  forkSessionText,
  parseEntries,
  projectDirName,
  sessionMeta,
  transcriptMessages,
  usageBaseline,
} from "../../src/server/harness/claude-sessions.js";

let n = 0;
let parent: string | null = null;
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
function entry(fields: Record<string, unknown>, chain = true): Record<string, unknown> {
  if (!chain) return { sessionId: "s1", ...fields };
  const uuid = `u${++n}`;
  const out = { uuid, parentUuid: parent, sessionId: "s1", cwd: "/work/proj", isSidechain: false, timestamp: at(n), ...fields };
  parent = uuid;
  return out;
}
const user = (content: unknown, extra: Record<string, unknown> = {}) => entry({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (id: string, block: Record<string, unknown>, usage = { input_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 7, output_tokens: 9 }) =>
  entry({ type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [block], usage } });

function session(): Array<Record<string, unknown>> {
  n = 0;
  parent = null;
  return [
    entry({ type: "queue-operation", operation: "enqueue", content: "hello" }, false),
    user("hello"),
    entry({ type: "attachment", attachment: { type: "skill_listing" } }),
    user("<system-reminder>be nice</system-reminder>", { isMeta: true }),
    assistant("m1", { type: "thinking", thinking: "let me look" }),
    assistant("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "README.md" } }),
    user([{ type: "tool_result", tool_use_id: "t1", content: "readme text", is_error: false }]),
    entry({ type: "attachment", attachment: { type: "queued_command", prompt: "also check the tests", source_uuid: "q1" } }),
    assistant("m2", { type: "text", text: "Done." }, { input_tokens: 6, cache_read_input_tokens: 60, cache_creation_input_tokens: 0, output_tokens: 3 }),
    // A subagent's entry (sidechain, off the main chain) and the interrupted marker never show.
    { type: "user", uuid: "side1", parentUuid: parent, sessionId: "s1", isSidechain: true, message: { role: "user", content: "subagent prompt" } },
    user("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>auth module</command-args>"),
    user("<local-command-stdout>Reviewed 3 files</local-command-stdout>"),
    user([{ type: "text", text: "[Request interrupted by user]" }]),
    entry({ type: "ai-title", aiTitle: "Reading the readme" }, false),
    entry({ type: "custom-title", customTitle: "My title" }, false),
    entry({ type: "cost-state", totalCostUSD: 0.42, modelUsage: {} }, false),
  ];
}

describe("claude session files", () => {
  it("names project folders the way Claude Code does", () => {
    expect(projectDirName("/home/me/.config/my_app")).toBe("-home-me--config-my-app");
  });

  it("reads the active branch as a transcript, one message per assistant id", () => {
    const items = historyToItems(transcriptMessages(session()));
    expect(items.map((i) => [i.kind, i.kind === "user" || i.kind === "assistant" ? i.text || (i.kind === "assistant" ? i.thinking : "") : i.kind === "tool" ? i.output : ""])).toEqual([
      ["user", "hello"],
      ["assistant", "let me look"],
      ["tool", "readme text"],
      ["user", "also check the tests"],
      ["assistant", "Done."],
      ["user", "/review auth module"],
      ["assistant", "```text\nReviewed 3 files\n```"],
    ]);
  });

  it("titles a session by its custom title, then Claude's, then the first prompt", () => {
    const meta = sessionMeta(session(), "fallback");
    expect(meta).toMatchObject({ sessionId: "s1", cwd: "/work/proj", title: "My title", firstPrompt: "hello", prompts: 3 });
    const untitled = session().filter((e) => e.type !== "custom-title" && e.type !== "ai-title");
    expect(sessionMeta(untitled, "fallback")?.title).toBe("hello");
    expect(sessionMeta([entry({ type: "attachment", attachment: {} })], "x")).toBeNull();
  });

  it("totals usage per model call and takes the cost from the CLI's snapshot", () => {
    expect(usageBaseline(session())).toEqual({ turns: 3, steps: 2, input: 11, cachedInput: 110, cacheWrite: 7, output: 12, cost: 0.42 });
  });

  it("forks through the Nth prompt, with the new session id and nothing past the cut", () => {
    const text = forkSessionText(session(), 1, "s2");
    const entries = parseEntries(text);
    expect(entries.every((e) => e.sessionId === "s2")).toBe(true);
    const items = historyToItems(transcriptMessages(entries));
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool"]);
    expect(() => forkSessionText([], 1, "s3")).toThrow(/nothing/);
  });

  it("starts a compacted session's history at the compaction", () => {
    n = 0;
    parent = null;
    const before = [user("old prompt"), assistant("m0", { type: "text", text: "old answer" })];
    parent = null;
    const after = [entry({ type: "system", subtype: "compact_boundary" }), user("summary text", { isCompactSummary: true }), user("new prompt")];
    const items = historyToItems(transcriptMessages([...before, ...after]));
    expect(items.map((i) => (i.kind === "notice" ? "notice" : i.kind === "user" ? i.text : i.kind))).toEqual(["notice", "new prompt"]);
  });

  it("cuts at the last compaction when print mode keeps appending to the old leaf", () => {
    n = 0;
    parent = null;
    const old = [user("old prompt"), assistant("m0", { type: "text", text: "old answer" })];
    const oldLeaf = parent;
    parent = null;
    const boundary = entry({ type: "system", subtype: "compact_boundary" });
    const summary = user("summary text", { isCompactSummary: true });
    parent = oldLeaf; // print mode: the next entries hang off the pre-compaction leaf
    const after = [user("<command-name>/compact</command-name>"), user("<local-command-stdout>Compacted </local-command-stdout>"), user("new prompt"), assistant("m1", { type: "text", text: "new answer" })];
    const entries = [...old, boundary, summary, ...after];
    const items = historyToItems(transcriptMessages(entries));
    expect(items.map((i) => (i.kind === "notice" ? "notice" : i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual([
      "notice",
      "/compact",
      "```text\nCompacted\n```",
      "new prompt",
      "new answer",
    ]);
    // A fork keeps the boundary and summary, re-linked into one chain, so the copy has the same context.
    const fork = parseEntries(forkSessionText(entries, 2, "s9"));
    expect(fork.map((e) => e.uuid)).toEqual([boundary.uuid, summary.uuid, after[0]?.uuid, after[1]?.uuid, after[2]?.uuid, after[3]?.uuid]);
    expect(fork[2]?.parentUuid).toBe(summary.uuid);
    expect(historyToItems(transcriptMessages(fork)).map((i) => i.kind)).toEqual(["notice", "user", "assistant", "user", "assistant"]);
  });
});
