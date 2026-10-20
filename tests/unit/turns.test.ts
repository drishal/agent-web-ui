import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { buildTurns, countSummary, formatDuration, modelName, modelSwitches, relativePath, saysSomething, latestThought, readsAsNarration, readsAsReply, workSegments, toolLabel } from "../../src/web/turns.js";

const tool = (id: string, category: "read" | "edit" | "command", extra: Record<string, unknown> = {}): ChatItem => ({
  kind: "tool",
  id,
  name: category,
  args: "",
  status: "done",
  output: "",
  truncated: false,
  category,
  summary: "",
  paths: [],
  ...extra,
});

describe("buildTurns", () => {
  it("numbers stored user turns for forks, skipping preambles and harness-answered commands", () => {
    const answer = (id: string): ChatItem => ({ kind: "assistant", id, text: "ok", thinking: "", streaming: false });
    const turns = buildTurns(
      [
        { kind: "notice", id: "n", level: "info", text: "started" },
        { kind: "user", id: "u1", text: "first" },
        answer("a1"),
        { kind: "user", id: "u2", text: "/context", command: true },
        answer("a2"),
        { kind: "user", id: "u3", text: "second" },
        answer("a3"),
      ],
      "idle",
    );
    expect(turns.map((t) => t.through)).toEqual([0, 1, 0, 2]);
  });

  it("splits on prompts and folds the work before the answer", () => {
    const items: ChatItem[] = [
      { kind: "notice", id: "n0", level: "info", text: "startup" },
      { kind: "user", id: "u1", text: "fix it", at: 1000 },
      { kind: "assistant", id: "a1", text: "", thinking: "plan", streaming: false, at: 1100 },
      tool("t1", "read", { at: 1200, endedAt: 1300 }),
      tool("t2", "edit", { paths: ["/w/src/a.ts"], at: 1400, endedAt: 1500 }),
      { kind: "assistant", id: "a2", text: "done", thinking: "", streaming: false, at: 1600, endedAt: 13600 },
      { kind: "notice", id: "n1", level: "error", text: "boom" },
      { kind: "user", id: "u2", text: "again" },
    ];
    const turns = buildTurns(items, "idle");
    expect(turns.map((t) => t.id)).toEqual(["pre-n0", "u1", "u2"]);
    const t = turns[1]!;
    expect(t.answer?.id).toBe("a2");
    expect(t.process.map((i) => i.id)).toEqual(["a1", "t1", "t2"]);
    expect(t.errors.map((i) => i.id)).toEqual(["n1"]);
    expect(t.counts).toEqual({ read: 1, edit: 1 });
    expect(t.changedFiles).toEqual(["/w/src/a.ts"]);
    expect(formatDuration((t.endedAt ?? 0) - (t.startedAt ?? 0))).toBe("13s");
    expect(t.live).toBe(false);
  });

  it("has no answer while work follows the last text, and marks the last turn live", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", id: "a1", text: "Let me look", thinking: "", streaming: false },
      tool("t1", "command"),
    ];
    const [turn] = buildTurns(items, "running");
    expect(turn?.answer).toBeNull();
    expect(turn?.process.map((i) => i.id)).toEqual(["a1", "t1"]);
    expect(turn?.live).toBe(true);
  });

  it("keeps a reply as the answer when the model calls a tool after writing it", () => {
    const reply = "Here is what I found.\n\nThe config loads twice because both extensions register it.";
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", id: "a1", text: "Let me look", thinking: "", streaming: false },
      tool("t1", "command"),
      { kind: "assistant", id: "a2", text: reply, thinking: "", streaming: false },
      tool("t2", "command"),
    ];
    for (const status of ["running", "idle"] as const) {
      const [turn] = buildTurns(items, status);
      expect(turn?.answer?.id).toBe("a2");
      expect(turn?.process.map((i) => i.id)).toEqual(["a1", "t1", "t2"]);
      expect(turn?.answerAt).toBe(2);
    }
  });

  it("reads the live thought in order when work follows the answer", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "go" },
      { kind: "assistant", id: "a1", text: "Done.\n\nAll set.", thinking: "Wrote the reply.", streaming: false },
      tool("t1", "command"),
      { kind: "assistant", id: "a2", text: "", thinking: "Now tidying up.", streaming: true },
    ];
    const [turn] = buildTurns(items, "running");
    expect(turn?.answer?.id).toBe("a1");
    expect(turn && latestThought(turn)).toBe("Now tidying up.");
  });

  it("tells a reply from a remark before more work", () => {
    expect(readsAsReply("Let me check the config.")).toBe(false);
    expect(readsAsReply("Now I'll run the tests to confirm.")).toBe(false);
    expect(readsAsReply("Done.\n\nThe fix is in app.ts.")).toBe(true);
    expect(readsAsReply("Findings:\n- one\n- two")).toBe(true);
    expect(readsAsReply("## Summary\nAll good")).toBe(true);
    expect(readsAsReply("x".repeat(300))).toBe(true);
  });

  it("formats counts, durations, and workspace-relative paths", () => {
    expect(countSummary({ read: 3, edit: 1, command: 2 })).toBe("3 reads, 1 edit, 2 commands");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(relativePath("/w/src/a.ts", "/w")).toBe("src/a.ts");
    expect(relativePath("/other/a.ts", "/w")).toBe("/other/a.ts");
  });
});

describe("replies between tool calls", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "u1", text: "reply, run something, then say done" },
    { kind: "assistant", id: "a1", text: "this is reply block 1", thinking: "They want a reply first.", streaming: false },
    tool("t1", "command"),
    { kind: "assistant", id: "a2", text: "done with tool call", thinking: "The command ran.", streaming: false },
  ];

  it("show in order as replies, with only the work between them folded", () => {
    const [turn] = buildTurns(items, "idle");
    expect(turn?.answer?.id).toBe("a2");
    const segments = turn ? workSegments(turn) : [];
    // The first reply's thought, the reply; then the command and the answer's thought.
    expect(segments.map((s) => [s.items.map((i) => i.id), s.reply?.id ?? null, s.answerAt])).toEqual([
      [["a1"], "a1", -1],
      [["t1"], null, 1],
    ]);
    expect(segments[1]?.counts).toEqual({ command: 1 });
  });

  it("are the same while the run is live, and a turn with no reply between work keeps one fold", () => {
    const [live] = buildTurns(items.slice(0, 3), "running");
    expect(live?.answer).toBeNull();
    expect(live ? workSegments(live).map((s) => s.reply?.id ?? null) : []).toEqual(["a1", null]);
    const [plain] = buildTurns([items[0] as ChatItem, tool("t1", "read"), { kind: "assistant", id: "a9", text: "Done.", thinking: "", streaming: false }], "idle");
    expect(plain ? workSegments(plain).map((s) => [s.items.map((i) => i.id), s.reply]) : []).toEqual([[["t1"], null]]);
  });
});

describe("notices that arrive while idle", () => {
  it("sit after the turn and never stretch its duration", () => {
    const day = 86_400_000;
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "old question", at: 1_000 },
      { kind: "assistant", id: "a1", text: "", thinking: "hm", streaming: false, at: 2_000 },
      { kind: "tool", id: "t1", name: "bash", args: "", status: "done", output: "", truncated: false, category: "command", summary: "", paths: [], at: 3_000, endedAt: 9_000 },
      { kind: "assistant", id: "a2", text: "answer", thinking: "", streaming: false, at: 10_000 },
      // Re-opened four days later: extension notices arrive while idle.
      { kind: "notice", id: "n1", level: "info", text: "compaction-control: capped", at: 4 * day, ambient: true },
      { kind: "notice", id: "n2", level: "warning", text: "trust skipped", at: 4 * day, ambient: true },
    ];
    const [turn] = buildTurns(items, "idle");
    expect(turn?.after.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(turn?.process.map((i) => i.id)).toEqual(["a1", "t1"]);
    expect(formatDuration((turn?.endedAt ?? 0) - (turn?.startedAt ?? 0))).toBe("9s");
  });
});

describe("model switches", () => {
  const turn = (n: number, model?: string): ChatItem[] => [
    { kind: "user", id: `u${n}`, text: `q${n}` },
    { kind: "assistant", id: `a${n}`, text: `a${n}`, thinking: "", streaming: false, ...(model ? { model } : {}) },
  ];
  it("marks the turns whose model differs from the last turn that named one", () => {
    const turns = buildTurns([...turn(1, "opus"), ...turn(2, "opus"), ...turn(3), ...turn(4, "haiku"), ...turn(5, "opus")], "idle");
    expect(turns.map((t) => t.model)).toEqual(["opus", "opus", undefined, "haiku", "opus"]);
    expect([...modelSwitches(turns)]).toEqual([
      ["u4", "haiku"],
      ["u5", "opus"],
    ]);
  });
  it("names a model by key or id, else as the harness wrote it", () => {
    const models = [{ key: "anthropic/claude-opus-5-5", id: "claude-opus-5-5", name: "Opus 5.5" }];
    expect(modelName("claude-opus-5-5", models)).toBe("Opus 5.5");
    expect(modelName("anthropic/claude-opus-5-5", models)).toBe("Opus 5.5");
    expect(modelName("gpt-x", models)).toBe("gpt-x");
  });
});

describe("stray text between tool calls", () => {
  it("counts only text with a letter or digit as something said", () => {
    expect([".", "\n\n\n", "", " - ", "…", "ok", "4", "Готово"].map(saysSomething)).toEqual([false, false, false, false, false, true, true, true]);  });
  it("never picks blank text as the answer", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "q" },
      { kind: "assistant", id: "a1", text: "The fix is in.", thinking: "", streaming: false },
      { kind: "assistant", id: "a2", text: "\n\n\n", thinking: "", streaming: false },
    ];
    expect(buildTurns(items, "idle")[0]?.answer?.id).toBe("a1");
  });
});

describe("narration-looking thinking", () => {
  it("flags prose with headings, numbered findings, or links", () => {
    expect(readsAsNarration("Three confirmed findings, all match earlier predictions\n\n1. **SERVER_MARKER is embedded** in the decoy page\n2. POST to /p_2x.png returns 404\n\nGET https://workers.dev/x returned empty")).toBe(true);
    expect(readsAsNarration("## Summary\nI checked the call sites; see src/server/app.ts.")).toBe(true);
  });
  it("leaves plain chain-of-thought alone", () => {
    expect(readsAsNarration("The user asks whether the marker check is enough. The request is risky.")).toBe(false);
    expect(readsAsNarration("hmm, maybe the constraint is upstream")).toBe(false);
    // A slash between words is no path, and a long thought that names a file is still a thought.
    expect(readsAsNarration("The user has a gaming mouse/keyboard and a NixOS desktop.\nIdea: ask about rebuilds.\nBetter: a which-would-you-rather.\nLet me craft it.")).toBe(false);
    expect(readsAsNarration("The handler lives in src/server/app.ts.\nIt reads the config first.\nSo the bug is upstream of the parse.")).toBe(false);
  });
});

describe("the live turn's latest thought", () => {
  const think = (id: string, thinking: string): ChatItem => ({ kind: "assistant", id, text: "", thinking, streaming: true });
  it("is the first sentence of the newest thinking, on one line", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "fix it" },
      think("a1", "Old idea. Not this."),
      { kind: "tool", id: "t", name: "read", args: "", status: "done", output: "", truncated: false, category: "read", summary: "a.ts", paths: [] },
      think("a2", "Found the cause:\nthe retry   path never resets. Then I will patch it."),
      think("a3", "   "),
    ];
    const [turn] = buildTurns(items, "running");
    expect(turn && latestThought(turn)).toBe("Found the cause: the retry path never resets.");
  });
  it("is nothing before any thinking", () => {
    const [turn] = buildTurns([{ kind: "user", id: "u", text: "q" }], "running");
    expect(turn && latestThought(turn)).toBeNull();
  });
});


describe("tool labels", () => {
  it("writes an MCP tool as its name and server, and leaves any other alone", () => {
    expect(toolLabel("mcp__awui__render_html")).toBe("render_html · awui");
    expect(toolLabel("mcp__github__create_issue")).toBe("create_issue · github");
    expect(toolLabel("Bash")).toBe("Bash");
  });
});
