// Subscription limits from the harnesses' own reports, in one shape: Claude
// Code's rate_limit_event (per run) and omp's `usage --json` (every signed-in
// account). Account names and emails are dropped here.
import type { LimitAccount, LimitWindow } from "../../shared/protocol.js";
import { isObj, type Obj } from "./agent-events.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5 hours",
  seven_day: "7 days",
  seven_day_opus: "7 days · Opus",
  seven_day_sonnet: "7 days · Sonnet",
};

/** Seconds or milliseconds since the epoch, as milliseconds. */
const epochMs = (v: unknown): number | null => {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

const share = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.min(1, Math.max(0, n));
};

/** Claude Code's `rate_limit_info`: every window it lists, else the one it is about. */
export function claudeLimits(info: Obj, at = Date.now()): LimitAccount {
  const windows: LimitWindow[] = [];
  const unified = isObj(info.unifiedWindows) ? info.unifiedWindows : null;
  if (unified) {
    for (const [key, w] of Object.entries(unified)) {
      if (!isObj(w)) continue;
      windows.push({ label: CLAUDE_WINDOWS[key] ?? key.replaceAll("_", " "), used: share(w.utilization), resetsAt: epochMs(w.resetsAt) });
    }
  }
  if (windows.length === 0 && str(info.rateLimitType)) {
    const key = str(info.rateLimitType);
    windows.push({ label: CLAUDE_WINDOWS[key] ?? key.replaceAll("_", " "), used: share(info.utilization), resetsAt: epochMs(info.resetsAt) });
  }
  return {
    id: "claude",
    source: "Claude Code",
    provider: "Anthropic",
    windows,
    limited: info.status === "rejected",
    at,
  };
}

/** `omp usage --json`: one account per report, its windows in the order omp gives them. */
export function ompLimits(json: unknown, at = Date.now()): LimitAccount[] {
  if (!isObj(json) || !Array.isArray(json.reports)) return [];
  const seen = new Map<string, number>();
  const accounts: LimitAccount[] = [];
  for (const report of json.reports) {
    if (!isObj(report)) continue;
    const provider = str(report.provider) || "unknown";
    const n = seen.get(provider) ?? 0;
    seen.set(provider, n + 1);
    const meta = isObj(report.metadata) ? report.metadata : {};
    const windows: LimitWindow[] = [];
    let limited = meta.limitReached === true || meta.allowed === false;
    for (const limit of Array.isArray(report.limits) ? report.limits : []) {
      if (!isObj(limit)) continue;
      const window = isObj(limit.window) ? limit.window : {};
      const amount = isObj(limit.amount) ? limit.amount : {};
      windows.push({
        label: str(window.label) || str(limit.label) || "limit",
        used: share(amount.usedFraction),
        resetsAt: epochMs(window.resetsAt),
      });
      if (["exhausted", "exceeded", "limit_reached", "blocked"].includes(str(limit.status))) limited = true;
    }
    accounts.push({
      id: `omp:${provider}:${n}`,
      source: "omp",
      provider,
      ...(str(meta.planType) ? { plan: str(meta.planType) } : {}),
      windows,
      limited,
      at: epochMs(report.fetchedAt) ?? at,
    });
  }
  return accounts;
}
