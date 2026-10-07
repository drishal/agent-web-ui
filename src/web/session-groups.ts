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
  /** Archived sessions stay in their projects instead of being left out. */
  showArchived?: boolean;
}

/** The selected harness's sessions that match the search. */
function visible(overview: SessionsOverview, opts: GroupOptions): ProjectSession[] {
  const q = opts.query.trim().toLowerCase();
  // The harness switch scopes the list: only sessions that actually ran in it.
  return overview.sessions.filter((s) => s.harnessId === opts.harnessId && (!q || s.title.toLowerCase().includes(q)));
}

/**
 * Sessions by project. Pinned ones sit in their own list above (see
 * pinnedSessions) and archived ones are left out, except while searching:
 * a search finds every session where it lives.
 */
export function groupByProject(overview: SessionsOverview, opts: GroupOptions): ProjectGroup[] {
  const searching = opts.query.trim() !== "";
  const groups = new Map<string, ProjectGroup>();
  for (const ws of overview.workspaces) groups.set(ws.id, { workspace: ws, sessions: [], current: ws.id === opts.currentId });
  for (const s of visible(overview, opts)) {
    if (!searching && (s.pinned || (s.archived && !opts.showArchived))) continue;
    groups.get(s.workspaceId)?.sessions.push(s);
  }
  const newest = (g: ProjectGroup) => g.sessions[0]?.updatedAt ?? "";
  return [...groups.values()]
    .filter((g) => g.sessions.length > 0 || (g.current && !searching))
    .sort((a, b) => Number(b.current) - Number(a.current) || newest(b).localeCompare(newest(a)));
}

/** The pinned list above the projects, newest first; empty while searching. */
export function pinnedSessions(overview: SessionsOverview, opts: GroupOptions): ProjectSession[] {
  if (opts.query.trim()) return [];
  return visible(overview, opts).filter((s) => s.pinned);
}

export function archivedCount(overview: SessionsOverview, harnessId: string | null): number {
  return overview.sessions.filter((s) => s.harnessId === harnessId && s.archived).length;
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
