import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus, HarnessStatus, ProjectSession, SessionsOverview, WorkspaceInfo } from "../../shared/protocol.js";
import { IconChevronDown, IconFolder, IconMore, IconPlus, IconSearch } from "../icons.js";
import { dateBucket, groupByProject, isBusy, type ProjectGroup } from "../session-groups.js";
import type { ThemeMode } from "../theme.js";

/** Sessions shown per project before "Show N more". */
const VISIBLE_CURRENT = 8;
const VISIBLE_OTHER = 4;

export const TEXT_SCALES: Array<[string, number]> = [
  ["Small", 0.92],
  ["Default", 1],
  ["Large", 1.1],
  ["Larger", 1.22],
];

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

/** Hermes-style spinning ring for a session whose run is in progress; harness-coloured in the All view. */
function WorkingRing({ harnessId, colored }: { harnessId?: string | undefined; colored: boolean }) {
  return <span className="working-ring" data-harness={colored ? harnessId : undefined} role="img" aria-label="Working" title="Working" />;
}

function SessionRow({
  s,
  active,
  working,
  harnessName,
  onOpen,
}: {
  s: ProjectSession;
  active: boolean;
  working: boolean;
  harnessName: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`session${active ? " is-active" : ""}${working ? " is-working" : ""}`}
        onClick={onOpen}
        aria-current={active ? "true" : undefined}
      >
        {working ? (
          <WorkingRing harnessId={s.harnessId} colored />
        ) : (
          <span className={`harness-dot harness-${s.harnessId}`} role="img" aria-label={harnessName} title={harnessName} />
        )}
        <span className="session-title">{s.title}</span>
        <span className="session-meta">
          {s.liveChatId && !working ? <span className="live-dot" title="Open in this server" aria-label="live" /> : null}
          <span className="session-time">{relativeTime(s.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

/** One project: header (collapse, new chat here), date-divided sessions, "Show N more". */
function ProjectGroupView({
  group,
  searching,
  isActive,
  isWorking,
  harnessName,
  canStartChat,
  onOpen,
  onNewChat,
}: {
  group: ProjectGroup;
  searching: boolean;
  isActive: (s: ProjectSession) => boolean;
  isWorking: (s: ProjectSession) => boolean;
  harnessName: (id: string) => string;
  canStartChat: boolean;
  onOpen: (s: ProjectSession) => void;
  onNewChat: (ws: WorkspaceInfo) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const { workspace, sessions, current } = group;
  const limit = current ? VISIBLE_CURRENT : VISIBLE_OTHER;
  const shown = searching || showAll ? sessions : sessions.slice(0, limit);
  const hidden = sessions.length - shown.length;

  const rows: React.ReactNode[] = [];
  let bucket = "";
  for (const s of shown) {
    const b = s.liveChatId && !s.updatedAt ? "Open" : dateBucket(s.updatedAt);
    if (b !== bucket) {
      bucket = b;
      rows.push(
        <li key={`d-${b}`} className="date-divider" role="presentation">
          {b}
        </li>,
      );
    }
    rows.push(
      <SessionRow
        key={s.id}
        s={s}
        active={isActive(s)}
        working={isWorking(s)}
        harnessName={harnessName(s.harnessId)}
        onOpen={() => onOpen(s)}
      />,
    );
  }

  return (
    <li className={`project-group${open ? " is-open" : ""}${current ? " is-current" : ""}`} data-testid="project-group">
      <div className="project-head">
        <button type="button" className="project-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={workspace.path}>
          <IconChevronDown size={12} className="group-chevron" />
          <IconFolder size={14} />
          <span className="project-name">{workspace.name}</span>
          {!open && sessions.some(isWorking) ? <WorkingRing colored={false} /> : null}
          <span className="group-count">{sessions.length}</span>
        </button>
        <button
          type="button"
          className="icon-btn project-new"
          aria-label={`New chat in ${workspace.name}`}
          title={`New chat in ${workspace.name}`}
          disabled={!canStartChat}
          onClick={() => onNewChat(workspace)}
        >
          <IconPlus size={13} />
        </button>
      </div>
      {open ? (
        <ul className="session-sublist">
          {rows}
          {sessions.length === 0 ? <li className="sidebar-note">No sessions here yet</li> : null}
          {hidden > 0 ? (
            <li>
              <button type="button" className="show-more" onClick={() => setShowAll(true)}>
                <IconMore size={13} /> Show {hidden} more in {workspace.name}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function Sidebar(props: {
  open: boolean;
  harnesses: HarnessStatus[];
  harnessId: string | null;
  onHarness: (id: string) => void;
  workspace: WorkspaceInfo | null;
  onPickWorkspace: () => void;
  onNewChat: () => void;
  newChatDisabled: string | null;
  /** A chat can start in some project (harness available, nothing opening). */
  canStartChat: boolean;
  onNewChatIn: (ws: WorkspaceInfo) => void;
  overview: SessionsOverview;
  sessionsError: string | null;
  sessionsLoading: boolean;
  query: string;
  onQuery: (q: string) => void;
  activeSessionId: string | null;
  activeChatId: string | null;
  /** The open chat's status (live over SSE), which beats the listing's. */
  activeStatus: ChatStatus | null;
  onOpenSession: (s: ProjectSession) => void;
  onRefresh: () => void;
  themeMode: ThemeMode;
  schemeName: string | null;
  onThemeMode: (mode: ThemeMode) => void;
  textScale: number;
  onTextScale: (scale: number) => void;
  onPair: () => void;
  signedInAs: string | null;
  onSignOut: () => void;
  /** Drag handle on the right edge (wide screens). */
  resizer?: React.ReactNode;
  onClose: () => void;
  version: string;
}) {
  const current = props.harnesses.find((h) => h.id === props.harnessId);
  const names = useMemo(() => new Map(props.harnesses.map((h) => [h.id as string, h.displayName])), [props.harnesses]);
  const groups = useMemo(
    () =>
      groupByProject(props.overview, {
        currentId: props.workspace?.id ?? null,
        query: props.query,
      }),
    [props.overview, props.workspace, props.query],
  );
  const asideRef = useRef<HTMLElement>(null);
  const { open } = props;
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  // Drawer mode: Escape closes from anywhere; focus moves in once on open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    asideRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const isActive = (s: ProjectSession) =>
    (props.activeSessionId !== null && s.id === props.activeSessionId) || (s.liveChatId !== undefined && s.liveChatId === props.activeChatId);
  const isWorking = (s: ProjectSession) => (isActive(s) ? isBusy(props.activeStatus) : isBusy(s.status));
  const searching = props.query.trim() !== "";

  return (
    <>
      <div className={`backdrop${props.open ? " is-open" : ""}`} onClick={props.onClose} aria-hidden="true" />
      <aside ref={asideRef} className={`sidebar${props.open ? " is-open" : ""}`} aria-label="Sessions" {...(props.open ? { role: "dialog", "aria-modal": true } : {})}>
        <div className="sidebar-head">
          <span className="brand">Agent Web UI</span>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={props.onClose}>
            <IconChevronDown size={16} className="rotate-90" />
          </button>
        </div>

        <button type="button" className="new-chat" onClick={props.onNewChat} disabled={props.newChatDisabled !== null}>
          <IconPlus size={15} /> New chat
        </button>
        {props.newChatDisabled ? <p className="sidebar-note">{props.newChatDisabled}</p> : null}

        <div className="segmented segmented-block" role="radiogroup" aria-label="Harness">
          {props.harnesses.map((h) => (
            <button
              key={h.id}
              type="button"
              role="radio"
              aria-checked={h.id === props.harnessId}
              className={h.id === props.harnessId ? "is-active" : ""}
              disabled={!h.available}
              onClick={() => props.onHarness(h.id)}
            >
              <span className={`harness-dot harness-${h.id}`} aria-hidden="true" />
              {h.displayName}
            </button>
          ))}
        </div>
        {props.harnesses
          .filter((h) => !h.available)
          .map((h) => (
            <p key={h.id} className="sidebar-note">
              {h.displayName}: {h.reason}
            </p>
          ))}
        {current?.warnings.map((w) => (
          <p key={w} className="sidebar-note is-warning">
            {w}
          </p>
        ))}

        <button type="button" className="workspace-btn" onClick={props.onPickWorkspace} title={props.workspace?.path}>
          <IconFolder size={15} />
          <span className="workspace-text">
            <span className="workspace-name">{props.workspace?.name ?? "Choose a folder…"}</span>
            {props.workspace ? <span className="workspace-path">{`‎${props.workspace.path}‎`}</span> : null}
          </span>
        </button>

        <div className="sessions">
          <div className="sessions-head">
            <label className="search-field">
              <IconSearch size={14} />
              <input type="search" placeholder="Search sessions" value={props.query} onChange={(e) => props.onQuery(e.target.value)} aria-label="Search sessions" />
            </label>
            <button type="button" className="icon-btn" aria-label="Refresh sessions" onClick={props.onRefresh}>
              ↻
            </button>
          </div>
          {props.sessionsError ? <p className="sidebar-note is-warning">{props.sessionsError}</p> : null}
          <ul className="session-list" aria-busy={props.sessionsLoading} aria-label="Sessions by project">
            {groups.map((g) => (
              <ProjectGroupView
                key={g.workspace.id}
                group={g}
                searching={searching}
                isActive={isActive}
                isWorking={isWorking}
                harnessName={(id) => names.get(id) ?? id}
                canStartChat={props.canStartChat}
                onOpen={props.onOpenSession}
                onNewChat={props.onNewChatIn}
              />
            ))}
            {!props.sessionsLoading && groups.length === 0 && !props.sessionsError ? (
              <li className="sidebar-note">{searching ? "No matching sessions" : "No sessions yet. Choose a folder and start a chat."}</li>
            ) : null}
          </ul>
        </div>

        <footer className="sidebar-foot">
          <label className="foot-control">
            <span>Theme</span>
            <select className="select select-small" value={props.themeMode} onChange={(e) => props.onThemeMode(e.target.value as ThemeMode)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              {props.schemeName ? <option value="scheme">{props.schemeName}</option> : null}
            </select>
          </label>
          <label className="foot-control">
            <span>Text</span>
            <select className="select select-small" value={String(props.textScale)} onChange={(e) => props.onTextScale(Number(e.target.value))} aria-label="Chat text size">
              {TEXT_SCALES.map(([label, value]) => (
                <option key={label} value={String(value)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-small btn-ghost" onClick={props.onPair}>
            Pair phone
          </button>
          {props.signedInAs ? (
            <button type="button" className="btn btn-small btn-ghost" onClick={props.onSignOut} title={`Signed in as ${props.signedInAs}`}>
              Sign out
            </button>
          ) : null}
          <span className="version foot-version">v{props.version}</span>
        </footer>
        {props.resizer}
      </aside>
    </>
  );
}
