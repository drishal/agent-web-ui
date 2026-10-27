// The sidebar's quick filters (chips under the search box): Running, Needs you,
// Today. At most one is on, and it narrows the list together with the text
// search. Pure: the Sidebar passes the clock and what it knows of the chat on
// screen (whose live status beats the listing's), and gets a narrowed overview
// back that every existing grouping already understands.
import type { ProjectSession, SessionsOverview } from "../shared/protocol.js";
import { isBusy, placeOf, recency, type GroupOptions } from "./session-groups.js";

export type QuickFilter = "running" | "needs" | "today";

/** The chips, left to right. */
export const QUICK_FILTERS: readonly QuickFilter[] = ["running", "needs", "today"];

export const QUICK_LABELS: Record<QuickFilter, string> = { running: "Running", needs: "Needs you", today: "Today" };

/** A stored value, when it names a chip (browser storage may hold anything). */
export const asQuickFilter = (v: unknown): QuickFilter | null => (QUICK_FILTERS as readonly unknown[]).includes(v) ? (v as QuickFilter) : null;

/** Is this session doing something right now. The Sidebar's `working` knows the open chat's live status. */
export type Working = (s: ProjectSession) => boolean;

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Whether a session passes a filter. "Needs you" is attention.ts's definition
 * of a chat asking for an answer (asking, and live); "Today" is last activity
 * since local midnight, a session with no known activity never.
 */
export function matchesQuick(s: ProjectSession, filter: QuickFilter, now: number, working: Working = (x) => isBusy(x.status)): boolean {
  if (filter === "running") return working(s);
  if (filter === "needs") return s.asking === true && s.liveChatId !== undefined;
  return recency(s) >= startOfDay(now);
}

/**
 * What each chip would show: the selected harness's sessions that the list shows
 * by default (not archived, settled, or snoozed), whatever the text search says,
 * so a chip's number does not jump while you type.
 */
export function quickCounts(overview: SessionsOverview, opts: GroupOptions, working?: Working): Record<QuickFilter, number> {
  const now = opts.now ?? Date.now();
  const counts: Record<QuickFilter, number> = { running: 0, needs: 0, today: 0 };
  for (const s of overview.sessions) {
    if (s.harnessId !== opts.harnessId) continue;
    const place = placeOf(s, opts);
    if (place === "archived" || place === "settled" || place === "snoozed") continue;
    for (const f of QUICK_FILTERS) if (matchesQuick(s, f, now, working)) counts[f] += 1;
  }
  return counts;
}

/**
 * The chips to draw: Running and Needs you only while something would match
 * (the one that is on stays, so it can always be switched off); Today always.
 */
export function chipsShown(counts: Record<QuickFilter, number>, active: QuickFilter | null): QuickFilter[] {
  return QUICK_FILTERS.filter((f) => f === "today" || f === active || counts[f] > 0);
}

/** The overview with only the sessions that pass the filter; the same overview when none is on. */
export function applyQuick(overview: SessionsOverview, filter: QuickFilter | null, now: number, working?: Working): SessionsOverview {
  if (!filter) return overview;
  return { ...overview, sessions: overview.sessions.filter((s) => matchesQuick(s, filter, now, working)) };
}

/** Escape in the search box: the text goes first, then the filter. Null when there is nothing to clear. */
export function escapeClears(query: string, filter: QuickFilter | null): "query" | "filter" | null {
  if (query !== "") return "query";
  return filter ? "filter" : null;
}
