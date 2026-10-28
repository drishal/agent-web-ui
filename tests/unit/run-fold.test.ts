// The long-run fold (run-fold.ts): which rows stay drawn.
import { describe, expect, it } from "vitest";
import type { ChatItem, ToolItem } from "../../src/shared/protocol.js";
import { foldRun, moreLabel } from "../../src/web/run-fold.js";

const call = (n: number, status: ToolItem["status"] = "done"): ChatItem => ({ kind: "tool", id: `t${n}`, name: "read", args: "{}", status, output: "", truncated: false, category: "read", summary: "", paths: [] });
const calls = (n: number) => Array.from({ length: n }, (_, i) => call(i));
const shown = (items: ChatItem[], expanded = false) => foldRun(items, expanded).hidden.map((h) => (h ? "." : "x")).join("");

describe("foldRun", () => {
  it("leaves a run of eight or fewer alone", () => {
    expect(shown(calls(8))).toBe("xxxxxxxx");
  });
  it("shows the first three and the last two of a longer run, with one count", () => {
    const fold = foldRun(calls(12), false);
    expect(shown(calls(12))).toBe("xxx.......xx");
    expect([...fold.more]).toEqual([[3, 7]]);
  });
  it("shows everything once expanded", () => {
    expect(shown(calls(12), true)).toBe("xxxxxxxxxxxx");
  });
  it("never hides a running or a failed call, and folds around it", () => {
    const items = calls(12);
    items[5] = call(5, "error");
    items[9] = call(9, "running");
    const fold = foldRun(items, false);
    expect(shown(items)).toBe("xxx..x...xxx");
    expect([...fold.more]).toEqual([[3, 2], [6, 3]]);
  });
  it("hides a thought inside a gap, not one beside a shown call or a waiting question", () => {
    const items = calls(10);
    const thought: ChatItem = { kind: "assistant", id: "a", text: "", thinking: "hmm", streaming: false };
    const ask = { kind: "request", id: "r", request: { id: "r", kind: "confirm", title: "ok?" } } as unknown as ChatItem;
    items.splice(5, 0, thought);
    items.splice(7, 0, ask);
    items.splice(1, 0, { ...thought, id: "b" });
    const fold = foldRun(items, false);
    expect(fold.hidden[1]).toBe(false);
    expect(fold.hidden[6]).toBe(true);
    expect(fold.hidden[8]).toBe(false);
  });
  it("words the button", () => {
    expect(moreLabel(7)).toBe("Show 7 more calls");
    expect(moreLabel(1)).toBe("Show 1 more call");
  });
});
