import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { buildTurns, countSummary, formatDuration, modelName, modelSwitches, relativePath, saysSomething } from "../../src/web/turns.js";

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

  it("formats counts, durations, and workspace-relative paths", () => {
    expect(countSummary({ read: 3, edit: 1, command: 2 })).toBe("3 reads, 1 edit, 2 commands");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(relativePath("/w/src/a.ts", "/w")).toBe("src/a.ts");
    expect(relativePath("/other/a.ts", "/w")).toBe("/other/a.ts");
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
    expect([".", "\n\n\n", "", " - ", "…", "ok", "4", "Готово"].map(saysSomething)).toEqual([false, false, false, false, false, true, true, true]);
  });
  it("never picks blank text as the answer", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "q" },
      { kind: "assistant", id: "a1", text: "The fix is in.", thinking: "", streaming: false },
      { kind: "assistant", id: "a2", text: "\n\n\n", thinking: "", streaming: false },
    ];
    expect(buildTurns(items, "idle")[0]?.answer?.id).toBe("a1");
  });
});

