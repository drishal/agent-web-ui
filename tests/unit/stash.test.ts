// The prompt stash (stash.ts): what an entry keeps, and taking one back.
import { describe, expect, it } from "vitest";
import { IMAGE_BUDGET, MAX_STASH, stashDraft, takeFromStash } from "../../src/web/stash.js";

describe("the stash", () => {
  const image = (n: number) => ({ mimeType: "image/png" as const, data: "x".repeat(n), width: 1, height: 1 });

  it("keeps the newest drafts, images while they fit, and gives an entry back once", () => {
    expect(stashDraft([], { text: "  ", images: [], from: "c" })).toBeNull();
    let entries = stashDraft([], { text: "later", images: [image(10), image(IMAGE_BUDGET)], from: "chat" }, 1) ?? [];
    expect(entries[0]).toMatchObject({ text: "later", from: "chat", dropped: 1 });
    expect(entries[0]?.images).toHaveLength(1);
    for (let i = 0; i < MAX_STASH + 3; i++) entries = stashDraft(entries, { text: `d${i}`, images: [], from: "c" }, i) ?? entries;
    expect(entries).toHaveLength(MAX_STASH);
    const id = entries[0]?.id as string;
    const taken = takeFromStash(entries, id);
    expect(taken.entry?.text).toBe(`d${MAX_STASH + 2}`);
    expect(takeFromStash(taken.entries, id).entry).toBeNull();
  });
});
