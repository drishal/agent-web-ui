// Sidebar grouping (Hermes Desktop style): sessions by project, the current
// project first, then projects by their newest session.
import type { ChatStatus, ProjectSession, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";

const BUSY: ReadonlySet<ChatStatus> = new Set(["starting", "running", "stopping", "compacting"]);

/** A live chat that is doing something (the sidebar's working spinner). */
export function isBusy(status: ChatStatus | null | undefined): boolean {
  return status !== null && status !== undefined && BUSY.has(status);
}

export interface ProjectGroup {
  workspace: WorkspaceInfo;
  /** Newest first. */
  sessions: ProjectSession[];
  current: boolean;
}

export interface GroupOptions {
  currentId: string | null;
  query: string;
  harnessId: string | null;
  /** Archived, settled, and snoozed sessions stay in their projects instead of being left out. */
  showArchived?: boolean;
  showSettled?: boolean;
  showSnoozed?: boolean;
  /** The session on screen: it stays in its project whatever it is doing. */
  isActive?: (s: ProjectSession) => boolean;
  now?: number;
}

/** Where a session goes in the list (T3 Code's inbox): what needs you and what works first, then pins and projects. */
export type Place = "needs" | "working" | "pinned" | "project" | "snoozed" | "settled" | "archived";

export function placeOf(s: ProjectSession, opts: GroupOptions): Place {
  if (s.archived) return "archived";
  const onScreen = opts.isActive?.(s) ?? false;
  if (!onScreen && s.asking) return "needs";
  if (!onScreen && isBusy(s.status)) return "working";
  if (s.snoozedUntil && s.snoozedUntil > (opts.now ?? Date.now())) return "snoozed";
  if (s.settled) return "settled";
  if (s.pinned) return "pinned";
  return "project";
}

/** The selected harness's sessions that match the search. */
function visible(overview: SessionsOverview, opts: GroupOptions): ProjectSession[] {
  const q = opts.query.trim().toLowerCase();
  // The harness switch scopes the list: only sessions that actually ran in it.
  return overview.sessions.filter((s) => s.harnessId === opts.harnessId && (!q || s.title.toLowerCase().includes(q)));
}

/**
 * Sessions by project. What needs you, what is working, and pinned sessions
 * sit in their own lists above (see sidebarSections); archived, settled, and
 * snoozed ones are left out unless shown. A search finds every session where
 * it lives.
 */
export function groupByProject(overview: SessionsOverview, opts: GroupOptions): ProjectGroup[] {
  const searching = opts.query.trim() !== "";
  const groups = new Map<string, ProjectGroup>();
  for (const ws of overview.workspaces) groups.set(ws.id, { workspace: ws, sessions: [], current: ws.id === opts.currentId });
  for (const s of visible(overview, opts)) {
    const place = placeOf(s, opts);
    const shown =
      searching ||
      place === "project" ||
      (place === "archived" && opts.showArchived) ||
      (place === "settled" && opts.showSettled) ||
      (place === "snoozed" && opts.showSnoozed);
    if (shown) groups.get(s.workspaceId)?.sessions.push(s);
  }
  const newest = (g: ProjectGroup) => g.sessions[0]?.updatedAt ?? "";
  return [...groups.values()]
    .filter((g) => g.sessions.length > 0 || (g.current && !searching))
    .sort((a, b) => Number(b.current) - Number(a.current) || newest(b).localeCompare(newest(a)));
}

export interface SidebarSections {
  needs: ProjectSession[];
  working: ProjectSession[];
  pinned: ProjectSession[];
  counts: { snoozed: number; settled: number; archived: number };
}

/** The lists above the projects, and how many sessions each toggle below them would bring back; empty while searching. */
export function sidebarSections(overview: SessionsOverview, opts: GroupOptions): SidebarSections {
  const out: SidebarSections = { needs: [], working: [], pinned: [], counts: { snoozed: 0, settled: 0, archived: 0 } };
  if (opts.query.trim()) return out;
  for (const s of visible(overview, opts)) {
    const place = placeOf(s, opts);
    if (place === "needs" || place === "working" || place === "pinned") out[place].push(s);
    else if (place !== "project") out.counts[place] += 1;
  }
  return out;
}

/** The pinned list above the projects, newest first; empty while searching. */
export function pinnedSessions(overview: SessionsOverview, opts: GroupOptions): ProjectSession[] {
  return sidebarSections(overview, opts).pinned;
}

export function archivedCount(overview: SessionsOverview, harnessId: string | null): number {
  return overview.sessions.filter((s) => s.harnessId === harnessId && s.archived).length;
}

/** When a snooze ends, said briefly: "4:30 PM", "Tomorrow 9:00 AM", "Mon 9:00 AM". */
export function wakeLabel(at: number, now = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  if (at < day.getTime() + dayMs) return time;
  if (at < day.getTime() + 2 * dayMs) return `Tomorrow ${time}`;
  return `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Snooze presets: an hour from now, tomorrow at 9:00, next Monday at 9:00. */
export function snoozeOptions(now = Date.now()): Array<{ label: string; until: number }> {
  const at9 = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const today = new Date(now).getDay();
  const toMonday = ((8 - today) % 7) || 7;
  return [
    { label: "For an hour", until: now + 3_600_000 },
    { label: "Until tomorrow", until: at9(1) },
    { label: "Until next week", until: at9(toMonday) },
  ];
}

/** Claude.ai's sidebar bucket: Today, Yesterday, this week, then a short date, then Older. */
export function conversationBucket(iso: string | null, now = new Date()): string {
  if (!iso) return "Older";
  const then = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const t = then.getTime();
  if (t >= today.getTime()) return "Today";
  if (t >= today.getTime() - day) return "Yesterday";
  if (t >= today.getTime() - 6 * day) {
    const label = then.toLocaleDateString([], { month: "short", day: "numeric" });
    return then.getFullYear() === now.getFullYear() ? label : then.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  return "Older";
}

/** One labelled rung of the history list, in display order. */
export interface HistorySection {
  label: string;
  sessions: ProjectSession[];
}

/**
 * The awui harness's history: a flat, newest-first list grouped into dated
 * rungs — no projects. Pinned first, then Today, Yesterday, this week (each
 * its own short date), Older. Search flattens to one matching list.
 */
export function historySections(overview: SessionsOverview, opts: GroupOptions): HistorySection[] {
  const sessions = visible(overview, opts).filter((s) => !s.archived);
  const pinned = sessions.filter((s) => s.pinned);
  const rest = sessions.filter((s) => !s.pinned);
  const byBucket = new Map<string, ProjectSession[]>();
  const now = opts.now !== undefined ? new Date(opts.now) : new Date();
  for (const s of rest) {
    const label = conversationBucket(s.updatedAt, now);
    const list = byBucket.get(label);
    if (list) list.push(s);
    else byBucket.set(label, [s]);
  }
  const out: HistorySection[] = [];
  if (pinned.length > 0) out.push({ label: "Pinned", sessions: pinned });
  // Buckets in the order Claude.ai shows them: Today, Yesterday, this week's dates newest first, Older last.
  const keys = [...byBucket.keys()].sort((a, b) => {
    const rank = (k: string) => (k === "Today" ? 0 : k === "Yesterday" ? 1 : k === "Older" ? 3 : 2);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra !== 2) return 0;
    // Both are short dates in this week: "Oct 6" vs "Oct 3" — newest first.
    return b.localeCompare(a);
  });
  for (const label of keys) out.push({ label, sessions: byBucket.get(label) ?? [] });
  return out;
}

/** Hermes-style divider: Today, Yesterday, Earlier this week, then the month. */
export function dateBucket(iso: string | null, now = new Date()): string {
  if (!iso) return "Older";
  const then = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const t = then.getTime();
  if (t >= today.getTime()) return "Today";
  if (t >= today.getTime() - day) return "Yesterday";
  if (t >= today.getTime() - 6 * day) return "Earlier this week";
  const month = then.toLocaleDateString("en-US", { month: "long" });
  return then.getFullYear() === now.getFullYear() ? month : `${month} ${then.getFullYear()}`;
}
