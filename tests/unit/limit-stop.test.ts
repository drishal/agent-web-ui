// A run stopped on a usage limit (limit-stop.ts), and when the limit resets.
import { describe, expect, it } from "vitest";
import type { ChatItem, UsageLimits } from "../../src/shared/protocol.js";
import { limitResetAt, limitStop, resetFromText } from "../../src/shared/limit-stop.js";

const user = (id: string, text: string): ChatItem => ({ kind: "user", id, text });
const reply = (id: string, text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ kind: "assistant", id, text, thinking: "", streaming: false, ...extra }) as ChatItem;
describe("a stop on a usage limit", () => {
  const now = new Date(2026, 9, 13, 14, 0).getTime();

  it("reads the reset from Claude's epoch, a time of day, or the account's full window", () => {
    expect(resetFromText("Claude AI usage limit reached|1791900000", now)).toBe(1_791_900_000_000);
    expect(resetFromText("You've hit your limit · resets 5pm", now)).toBe(new Date(2026, 9, 13, 17, 0).getTime());
    expect(resetFromText("resets 9:30 am", now)).toBe(new Date(2026, 9, 14, 9, 30).getTime());
    expect(resetFromText("resets soon", now)).toBeNull();
    const limits: UsageLimits = {
      accounts: [{ id: "claude", source: "Claude Code", provider: "anthropic", windows: [{ label: "5 hours", used: 1, resetsAt: now + 3_600_000 }], limited: true, at: now }],
      errors: [],
    };
    const items = [user("u1", "go"), reply("a1", "", { error: "Rate limit exceeded (429)" })];
    expect(limitStop(items, "idle", limits, "Claude Code", now)).toEqual({ id: "a1", resetsAt: now + 3_600_000 });
    expect(limitStop(items, "running", limits, "Claude Code", now)).toBeNull();
    expect(limitStop([user("u1", "go"), reply("a1", "Fine.")], "idle", limits, "Claude Code", now)).toBeNull();
    // Only the last turn counts.
    expect(limitStop([...items, user("u2", "next"), reply("a2", "ok")], "idle", limits, "Claude Code", now)).toBeNull();
  });
  it("finds the latest reset among the full windows, for one source or for all", () => {
    const at = Date.UTC(2026, 9, 13, 14, 0);
    const limits: UsageLimits = {
      accounts: [
        {
          id: "claude",
          source: "Claude Code",
          provider: "anthropic",
          limited: true,
          at,
          windows: [
            { label: "5 hours", used: 1, resetsAt: at + 3_600_000 },
            { label: "7 days", used: 1, resetsAt: at + 72 * 3_600_000 },
            { label: "old", used: 1, resetsAt: at - 1 },
          ],
        },
        {
          id: "omp",
          source: "omp",
          provider: "openai",
          limited: false,
          at,
          windows: [
            { label: "month", used: 0.5, resetsAt: at + 999 * 3_600_000 },
            { label: "full", used: 1, resetsAt: at + 5 * 3_600_000 },
          ],
        },
      ],
      errors: [],
    };
    expect(limitResetAt(limits, at)).toBe(at + 72 * 3_600_000);
    expect(limitResetAt(limits, at, "omp")).toBe(at + 5 * 3_600_000);
    expect(limitResetAt(null, at)).toBeNull();
  });
});
