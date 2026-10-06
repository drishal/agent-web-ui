// toSeed: portable handoff seeds from normalized chat items.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { BRIEF_MAX_CHARS, briefPrompt, isEmptySeed, seedTranscript, toSeed } from "../../src/server/harness/handoff.js";

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

  it("briefs as context, not requests, and ends on the draft or a short status", () => {
    const seed = toSeed([user("fix the build"), tool("bash"), assistant("fixed it")], { title: "t" });
    const waiting = briefPrompt(seed, { from: "Pi", project: "webui", draft: null });
    expect(waiting.split("\n")[0]).toBe("This conversation is continuing here from Pi (project: webui).");
    expect(waiting).toContain("none of it should be run again");
    expect(waiting).toContain("<transcript>\nUser: fix the build\n  · bash bash\n    out\nPi: fixed it\n</transcript>");
    expect(waiting.endsWith("without running anything, reply in two or three lines with where things stand, and wait for the next request.")).toBe(true);
    expect(briefPrompt(seed, { from: "Pi", project: "webui", draft: "now ship it" }).endsWith("continue with this request:\n\nnow ship it")).toBe(true);
  });

  it("cuts tool output, then folds the oldest turns, to stay inside the budget", () => {
    const big = (id: string): ChatItem => ({ ...(tool("bash") as Extract<ChatItem, { kind: "tool" }>), id, output: "x".repeat(5000) });
    const small = briefPrompt(toSeed([user("q"), big("t1"), assistant("a")]), { from: "omp", project: "p", draft: null });
    expect(small).toContain("[… 3000 more characters]");
    const items: ChatItem[] = [];
    for (let i = 0; i < 12; i += 1) items.push(user(`question ${i} ${"q".repeat(3000)}`), big(`t${i}`), assistant(`answer ${i} ${"a".repeat(3000)}`));
    const brief = briefPrompt(toSeed(items), { from: "omp", project: "p", draft: "go on" });
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    // The first turn stays verbatim, the newest too; tool output went first; older turns became one-liners.
    expect(brief).toContain(`User: question 0 ${"q".repeat(3000)}`);
    expect(brief).toContain(`User: question 11 ${"q".repeat(3000)}`);
    expect(brief).not.toContain("xxxxxxxxxx");
    expect(brief).toContain("[Earlier turns, one line each]");
    expect(brief.endsWith("continue with this request:\n\ngo on")).toBe(true);
  });
});
