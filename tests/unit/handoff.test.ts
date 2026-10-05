// toSeed: portable handoff seeds from normalized chat items.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { isEmptySeed, seedTranscript, toSeed } from "../../src/server/harness/handoff.js";

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
    // The summary of the dropped middle reads after the first turn, not before it.
    const order = seedTranscript(seed).map((e) => (e.role === "tool" ? "tool" : e.text));
    expect(order.slice(0, 4)).toEqual(["q0", "a0", seed.summary, "q5"]);
  });

  it("lays turns out as prompt, tool records, answer", () => {
    const seed = toSeed([user("q"), tool("bash"), assistant("a")]);
    expect(seedTranscript(seed).map((e) => e.role)).toEqual(["user", "tool", "assistant"]);
  });

  it("honors throughTurns; an empty seed is empty", () => {
    const seed = toSeed([user("q1"), assistant("a1"), user("q2"), assistant("a2")], { throughTurns: 1 });
    expect(seed.turns).toHaveLength(1);
    expect(isEmptySeed(seed)).toBe(false);
    expect(isEmptySeed(toSeed([]))).toBe(true);
  });

  it("notes images it cannot carry", () => {
    const seed = toSeed([{ kind: "user", id: "u", text: "look", imageCount: 2 }]);
    expect(seed.turns[0]?.prompt.text).toBe("look\n[2 images not carried over]");
  });
});
