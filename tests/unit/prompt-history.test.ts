// ↑/↓ prompt recall in the composer (prompt-history.ts).
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { recallStep, sentPrompts } from "../../src/web/prompt-history.js";

const user = (id: string, text: string): ChatItem => ({ kind: "user", id, text });
const reply = (id: string, text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ kind: "assistant", id, text, thinking: "", streaming: false, ...extra }) as ChatItem;
describe("prompt recall", () => {
  const items = [user("u1", "first"), reply("a1", "ok"), user("u2", "second"), user("u3", "second"), user("u4", "two\nlines")];
  const prompts = sentPrompts(items);

  it("lists the chat's prompts newest first, a repeat once", () => {
    expect(prompts).toEqual(["two\nlines", "second", "first"]);
  });

  it("walks back from an empty composer and forward to an empty one again", () => {
    let step = recallStep(prompts, null, "up", "", 0);
    expect(step?.text).toBe("two\nlines");
    // On the first line of a two-line prompt, ↑ walks on.
    step = recallStep(prompts, step?.recall ?? null, "up", "two\nlines", 0);
    expect(step?.text).toBe("second");
    step = recallStep(prompts, step?.recall ?? null, "up", "second", 6);
    expect(step?.text).toBe("first");
    expect(recallStep(prompts, step?.recall ?? null, "up", "first", 5)).toBeNull();
    step = recallStep(prompts, step?.recall ?? null, "down", "first", 5);
    expect(step?.text).toBe("second");
    step = recallStep(prompts, step?.recall ?? null, "down", "second", 6);
    step = recallStep(prompts, step?.recall ?? null, "down", "two\nlines", 9);
    expect(step).toEqual({ recall: null, text: "" });
  });

  it("leaves the keys alone in a draft, an edited recall, or inside a prompt of several lines", () => {
    expect(recallStep(prompts, null, "up", "typing", 6)).toBeNull();
    expect(recallStep(prompts, { index: 1, text: "second" }, "up", "second!", 7)).toBeNull();
    expect(recallStep(prompts, { index: 0, text: "two\nlines" }, "up", "two\nlines", 9)).toBeNull();
    expect(recallStep(prompts, null, "down", "", 0)).toBeNull();
  });
});
