import { describe, expect, it } from "vitest";
import type { UsageReport, UsageTotals } from "../../src/shared/protocol.js";
import { cacheShare, dayBars, dayLabels, dollars, shortTokens } from "../../src/web/usage.js";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0, calls: 0, unpriced: 0, ...over });

describe("usage, drawn", () => {
  it("writes tokens and dollars short", () => {
    expect([shortTokens(950), shortTokens(1240), shortTokens(12_400), shortTokens(3_100_000), shortTokens(2e9)]).toEqual(["950", "1.2k", "12k", "3.1M", "2.0B"]);
    expect([dollars(0.42, true), dollars(0.004, true), dollars(1204.4, true), dollars(0, true), dollars(5, false)]).toEqual(["$0.42", "<$0.01", "$1,204", "$0.00", "—"]);
  });

  it("gives the cache's share of the input", () => {
    expect(cacheShare(totals({ input: 25, cachedInput: 75 }))).toBe(0.75);
    expect(cacheShare(totals())).toBeNull();
  });

  it("labels the last day, each month's first, and every few days, never two close together", () => {
    expect(dayLabels(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"], 3)).toEqual(["Sep 29", null, "Oct 1", null, "Oct 3"]);
    expect(dayLabels(["2026-10-01", "2026-10-02", "2026-10-03"], 1)).toEqual(["Oct 1", "Oct 2", "Oct 3"]);
    // 90 days from Jul 19: the 15-day steps that fall next to a month's first (Aug 3, Sep 2, Oct 2) give way to it.
    const start = Date.UTC(2026, 6, 19);
    const days = Array.from({ length: 89 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
    expect(dayLabels(days, 15).filter(Boolean)).toEqual(["Jul 19", "Aug 1", "Aug 18", "Sep 1", "Sep 17", "Oct 1", "Oct 15"]);
  });

  it("splits each day's bar by harness, scaled to the tallest day", () => {
    const report = {
      byHarness: [{ harnessId: "pi" }, { harnessId: "claude" }],
      byDay: [
        { day: "a", totals: totals({ input: 100 }), tokensByHarness: { pi: 100 } },
        { day: "b", totals: totals({ input: 400 }), tokensByHarness: { claude: 300, pi: 100 } },
        { day: "c", totals: totals(), tokensByHarness: {} },
      ],
    } as unknown as UsageReport;
    expect(dayBars(report)).toEqual([
      { day: "a", total: 100, segments: [{ harnessId: "pi", tokens: 100, share: 0.25 }] },
      {
        day: "b",
        total: 400,
        segments: [
          { harnessId: "pi", tokens: 100, share: 0.25 },
          { harnessId: "claude", tokens: 300, share: 0.75 },
        ],
      },
      { day: "c", total: 0, segments: [] },
    ]);
  });
});
