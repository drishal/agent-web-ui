// Usage across sessions, for drawing: tokens and dollars written short, the
// cache's share of the input, the day labels under the chart, and each day's
// bar split by harness. Pure; the numbers come from the server's report.
import type { UsageReport, UsageTotals } from "../shared/protocol.js";

/** Every token a call moved, in and out. */
export const tokensOf = (t: Pick<UsageTotals, "input" | "cachedInput" | "cacheWrite" | "output">): number => t.input + t.cachedInput + t.cacheWrite + t.output;

/** 950, 12.4k, 3.1M, 2.0B. */
export function shortTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** $0.42, $12.30, $1,204; under a cent, "<$0.01"; nothing priced, "—". */
export function dollars(cost: number, priced: boolean): string {
  if (!priced) return "—";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost >= 1000 ? Math.round(cost).toLocaleString("en-US") : cost.toFixed(2)}`;
}

/** How much of the input the provider served from its cache, 0 to 1 (null with no input). */
export function cacheShare(t: UsageTotals): number | null {
  const all = t.input + t.cachedInput;
  return all > 0 ? t.cachedInput / all : null;
}

/** A day's label under the chart: "Oct 14"; the first of a month, and every `every`th day, get one. */
export function dayLabels(days: string[], every: number): Array<string | null> {
  return days.map((d, i) => {
    const date = new Date(`${d}T12:00:00Z`);
    const first = date.getUTCDate() === 1;
    return i === days.length - 1 || i % every === 0 || first ? date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  });
}

/** Each day's bar as segments by harness (in the report's harness order), heights as shares of the tallest day. */
export function dayBars(report: UsageReport): Array<{ day: string; total: number; segments: Array<{ harnessId: string; share: number; tokens: number }> }> {
  const order = report.byHarness.map((h) => h.harnessId);
  const tallest = Math.max(0, ...report.byDay.map((d) => tokensOf(d.totals)));
  return report.byDay.map((d) => {
    const total = tokensOf(d.totals);
    const segments = order.filter((h) => (d.tokensByHarness[h] ?? 0) > 0).map((h) => ({ harnessId: h, tokens: d.tokensByHarness[h] ?? 0, share: tallest > 0 ? (d.tokensByHarness[h] ?? 0) / tallest : 0 }));
    return { day: d.day, total, segments };
  });
}
