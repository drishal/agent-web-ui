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

/**
 * The days labelled under the chart ("Oct 14"): the last, each month's first,
 * then every `every`th, each kept only where it is far enough from the ones
 * before it (most of `every` days), so two labels never run into each other.
 */
export function dayLabels(days: string[], every: number): Array<string | null> {
  const gap = Math.max(1, Math.round(every * 0.7));
  const out: Array<string | null> = days.map(() => null);
  const taken: number[] = [];
  const put = (i: number) => {
    if (out[i] !== null || taken.some((j) => Math.abs(i - j) < gap)) return;
    taken.push(i);
    out[i] = new Date(`${days[i]}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  if (days.length > 0) put(days.length - 1);
  days.forEach((d, i) => {
    if (d.endsWith("-01")) put(i);
  });
  for (let i = 0; i < days.length; i += every) put(i);
  return out;
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
