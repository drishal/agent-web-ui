import { describe, expect, it } from "vitest";
import { claudeLimits, ompLimits } from "../../src/server/harness/limits.js";
import { level, resetsIn, tightest } from "../../src/web/limits.js";

// As Claude Code 2.x prints it on a run (stream-json).
const claudeInfo = {
  status: "allowed_warning",
  resetsAt: 1791828000,
  rateLimitType: "seven_day",
  utilization: 0.55,
  isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1791407400 }, seven_day: { utilization: 0.55, resetsAt: 1791828000 } },
};

// As `omp usage --json --redact` prints it (trimmed).
const ompJson = {
  generatedAt: 1791392119244,
  reports: [
    {
      provider: "openai-codex",
      fetchedAt: 1791392116560,
      limits: [
        {
          id: "openai-codex:primary",
          label: "30 days",
          window: { id: "30d", label: "30 days", durationMs: 2592000000, resetsAt: 1791746762000 },
          amount: { used: 2, limit: 100, remaining: 98, usedFraction: 0.02, remainingFraction: 0.98, unit: "percent" },
          status: "ok",
        },
      ],
      metadata: { planType: "free", allowed: true, limitReached: false, email: "someone@example.com", accountId: "b418" },
    },
  ],
};

describe("subscription limits", () => {
  it("reads Claude Code's five-hour and weekly windows", () => {
    expect(claudeLimits(claudeInfo, 5)).toEqual({
      id: "claude",
      source: "Claude Code",
      provider: "Anthropic",
      windows: [
        { label: "5 hours", used: 0.15, resetsAt: 1791407400000 },
        { label: "7 days", used: 0.55, resetsAt: 1791828000000 },
      ],
      limited: false,
      at: 5,
    });
    expect(claudeLimits({ status: "rejected", rateLimitType: "five_hour", resetsAt: 100 }).limited).toBe(true);
    expect(claudeLimits({ status: "rejected", rateLimitType: "five_hour", resetsAt: 100 }).windows).toEqual([{ label: "5 hours", used: null, resetsAt: 100_000 }]);
  });

  it("reads omp's accounts without their emails or ids", () => {
    const accounts = ompLimits(ompJson);
    expect(accounts).toEqual([
      {
        id: "omp:openai-codex:0",
        source: "omp",
        provider: "openai-codex",
        plan: "free",
        windows: [{ label: "30 days", used: 0.02, resetsAt: 1791746762000 }],
        limited: false,
        at: 1791392116560,
      },
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(/example\.com|b418/);
    expect(ompLimits({ nope: true })).toEqual([]);
  });

  it("picks the fullest window, grades it, and says when it resets", () => {
    const top = tightest([...ompLimits(ompJson), claudeLimits(claudeInfo)]);
    expect([top?.account.id, top?.window.label]).toEqual(["claude", "7 days"]);
    expect([level(0.5), level(0.75), level(0.95), level(0.1, true)]).toEqual(["ok", "warn", "full", "full"]);
    const now = Date.UTC(2026, 9, 7, 12);
    expect(resetsIn(now + 40 * 60_000, now)).toBe("in 40m");
    expect(resetsIn(now + 192 * 60_000, now)).toBe("in 3h 12m");
    expect(resetsIn(now + 52 * 3600_000, now)).toBe("in 2d 4h");
  });
});
