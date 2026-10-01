import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { buildTurns, countSummary, formatDuration, relativePath } from "../../src/web/turns.js";

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
