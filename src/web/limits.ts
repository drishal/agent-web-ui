// Subscription limits for the sidebar meter: read on load, every five minutes
// while the page is visible, and after a run in the shown chat settles.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LimitAccount, LimitWindow, UsageLimits } from "../shared/protocol.js";
import { api } from "./api.js";

const REFRESH_MS = 5 * 60_000;

/** `settled` counts finished runs; each one after the first load re-reads the limits. */
export function useLimits(enabled: boolean, settled: number): UsageLimits | null {
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api<UsageLimits>("/api/limits");
      if (mine === seq.current) setLimits(next);
    } catch {
      // the meter just keeps what it had
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (enabled && settled > 0) void refresh();
  }, [enabled, settled, refresh]);

  return limits;
}

const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "ChatGPT",
  openai: "OpenAI",
  "google-gemini-cli": "Gemini",
  "google-antigravity": "Antigravity",
  "github-copilot": "Copilot",
};

export function accountName(a: LimitAccount): string {
  const provider = PROVIDERS[a.provider] ?? a.provider;
  return a.source === "Claude Code" ? "Claude" : provider;
}

/** The fullest window: what the collapsed meter shows. */
export function tightest(accounts: LimitAccount[]): { account: LimitAccount; window: LimitWindow } | null {
  let best: { account: LimitAccount; window: LimitWindow } | null = null;
  for (const account of accounts) {
    for (const window of account.windows) {
      if (window.used === null) continue;
      if (!best || window.used > (best.window.used ?? 0)) best = { account, window };
    }
  }
  return best;
}

export function level(used: number | null, limited = false): "ok" | "warn" | "full" {
  if (limited || (used !== null && used >= 0.9)) return "full";
  if (used !== null && used >= 0.7) return "warn";
  return "ok";
}

/** "in 3h 12m", "in 2d 4h", "in 40m". */
export function resetsIn(at: number | null, now = Date.now()): string | null {
  if (at === null) return null;
  const min = Math.max(0, Math.round((at - now) / 60_000));
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h}h ${min % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

export const percent = (used: number | null): string => (used === null ? "—" : `${Math.round(used * 100)}%`);
