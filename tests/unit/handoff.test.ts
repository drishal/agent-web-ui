// toSeed: portable handoff seeds from normalized chat items.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { isEmptySeed, toSeed } from "../../src/server/harness/handoff.js";

const user = (text: string): ChatItem => ({ kind: "user", id: `u-${text}`, text });
const assistant = (text: string): ChatItem => ({ kind: "assistant", id: `a-${text}`, text, thinking: "", streaming: false });
const tool = (name: string): ChatItem => ({
  kind: "tool",
  id: `t-${name}`,
  name,
  args: "{}",
  status: "done",
  output: "out",
  truncated: false,
  category: "command",
  summary: name,
  paths: [],
});

describe("toSeed", () => {
  it("groups prompts, answers, and tools into turns", () => {
    const seed = toSeed([user("q"), tool("bash"), assistant("a")], { title: "t" });
    expect(seed.title).toBe("t");
    expect(seed.turns).toHaveLength(1);
    expect(seed.turns[0]).toMatchObject({ prompt: { text: "q" }, answer: { text: "a" } });
    expect(seed.turns[0]?.tools).toHaveLength(1);
    expect(seed.summary).toBeNull();
  });

  it("drops notices and requests, keeps preamble-free turns", () => {
    const seed = toSeed([
      { kind: "notice", id: "n", level: "info", text: "hi" },
      user("q"),
      assistant("a"),
    ]);
    expect(seed.turns).toHaveLength(1);
  });

  it("caps at first + recent turns with a summary of the middle", () => {
    const items: ChatItem[] = [];
    for (let i = 0; i < 15; i += 1) {
      items.push(user(`q${i}`), assistant(`a${i}`));
    }
    const seed = toSeed(items);
    expect(seed.turns).toHaveLength(11);
    expect(seed.turns[0]?.prompt.text).toBe("q0");
    expect(seed.turns[10]?.prompt.text).toBe("q14");
    expect(seed.summary).toContain("q1");
    expect(seed.summary).not.toContain("q14");
  });

  it("honors throughTurns and carries the draft prompt", () => {
    const seed = toSeed([user("q1"), assistant("a1"), user("q2"), assistant("a2")], { throughTurns: 1, prompt: "next" });
    expect(seed.turns).toHaveLength(1);
    expect(seed.prompt).toBe("next");
    expect(isEmptySeed(seed)).toBe(false);
  });

  it("blank drafts are null; empty seeds are empty", () => {
    expect(toSeed([user("q")], { prompt: "  " }).prompt).toBeNull();
    expect(isEmptySeed(toSeed([]))).toBe(true);
    expect(isEmptySeed(toSeed([], { prompt: "x" }))).toBe(false);
  });
});
