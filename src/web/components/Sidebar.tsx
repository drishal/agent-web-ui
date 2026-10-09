import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus, HarnessStatus, ProjectSession, SessionsOverview, WorkspaceInfo } from "../../shared/protocol.js";
import { useDismiss, useNow } from "../hooks.js";
import { IconArchive, IconCheck, IconChevronDown, IconClock, IconFolder, IconMore, IconPin, IconPlus, IconSearch, IconSettings, IconSidebar, IconWarning } from "../icons.js";
import { dateBucket, groupByProject, isBusy, sidebarSections, snoozeOptions, wakeLabel, type ProjectGroup } from "../session-groups.js";
import { load, save } from "../storage.js";
import { harnessColor } from "../harness-colors.js";
import { HarnessMenu } from "./HarnessMenu.js";
import { WorkingRing } from "./WorkingRing.js";

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


export type MarkChange = { pinned?: boolean; archived?: boolean; settled?: boolean; snoozedUntil?: number | null };

/** Pin and archive, from the row's ⋯ button or a right-click (a long press on phones). */
function RowMenu({ s, anchor, onMark, onClose }: { s: ProjectSession; anchor: DOMRect; onMark: (change: MarkChange) => void; onClose: () => void }) {
  const below = anchor.bottom + 260 < window.innerHeight;
  const style = {
    position: "fixed" as const,
    right: Math.max(8, window.innerWidth - anchor.right),
    ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
  };
  const pick = (change: MarkChange) => {
    onClose();
    onMark(change);
  };
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} aria-hidden="true" />
      <ul className="menu-list row-menu" role="menu" style={style} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <li role="none">
          <button type="button" role="menuitem" autoFocus onClick={() => pick({ pinned: !s.pinned })}>
            <IconPin size={14} /> {s.pinned ? "Unpin" : "Pin"}
          </button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" onClick={() => pick({ settled: !s.settled })}>
            <IconCheck size={14} /> {s.settled ? "Unsettle" : "Settle"}
          </button>
        </li>
        {s.snoozedUntil && s.snoozedUntil > Date.now() ? (
          <li role="none">
            <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: null })}>
              <IconClock size={14} /> Wake now
            </button>
          </li>
        ) : (
          snoozeOptions().map((o) => (
            <li role="none" key={o.label}>
              <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: o.until })}>
                <IconClock size={14} /> Snooze {o.label.toLowerCase()}
              </button>
            </li>
          ))
        )}
        <li role="none">
          <button type="button" role="menuitem" onClick={() => pick({ archived: !s.archived })}>
            <IconArchive size={14} /> {s.archived ? "Unarchive" : "Archive"}
          </button>
        </li>
      </ul>
    </>
  );
}

function SessionRow({
  s,
  active,
  working,
  harnessName,
  project,
  onOpen,
  onMark,
}: {
  s: ProjectSession;
  active: boolean;
  working: boolean;
  harnessName: string;
  /** Shown beside the title where the row is out of its project (the pinned list). */
  project?: string;
  /** `newTab`: Ctrl/⌘-click or middle-click, as in a browser. */
  onOpen: (newTab: boolean) => void;
  onMark: (change: MarkChange) => void;
}) {
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // A session not saved yet has nothing to mark.
  const markable = !s.id.includes(":live-");
  return (
    <li className={`session-item${menuAt ? " is-menu-open" : ""}`}>
      <button
        type="button"
        className={`session${active ? " is-active" : ""}${working ? " is-working" : ""}${s.archived || s.settled || (s.snoozedUntil ?? 0) > Date.now() ? " is-archived" : ""}`}
        onClick={(e) => onOpen(e.ctrlKey || e.metaKey)}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          onOpen(true);
        }}
        onContextMenu={(e) => {
          if (!markable) return;
          e.preventDefault();
          setMenuAt(new DOMRect(e.clientX, e.clientY, 0, 0));
        }}
        aria-current={active ? "true" : undefined}
        title={project ? `${s.title} · ${project}` : undefined}
      >
        {working ? (
          <WorkingRing harnessId={s.harnessId} colored />
        ) : (
          <span className="harness-dot" style={harnessColor(s.harnessId)} role="img" aria-label={harnessName} title={harnessName} />
        )}
        <span className="session-title">{s.title}</span>
        <span className="session-meta">
          {project ? <span className="session-project">{project}</span> : null}
          {s.liveChatId && !working ? <span className="live-dot" title="Open in this server" aria-label="live" /> : null}
          {s.asking ? <span className="session-asking">needs you</span> : null}
          {(s.snoozedUntil ?? 0) > Date.now() ? (
            <span className="session-wake" title="Snoozed until then">
              <IconClock size={11} /> {wakeLabel(s.snoozedUntil as number)}
            </span>
          ) : (
            <span className="session-time">{relativeTime(s.updatedAt)}</span>
          )}
        </span>
      </button>
      {markable ? (
        <button
          ref={moreRef}
          type="button"
          className="icon-btn session-more"
          aria-label={`More for ${s.title}`}
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          onClick={() => setMenuAt(moreRef.current?.getBoundingClientRect() ?? null)}
        >
          <IconMore size={14} />
        </button>
      ) : null}
      {menuAt ? <RowMenu s={s} anchor={menuAt} onMark={onMark} onClose={() => setMenuAt(null)} /> : null}
    </li>
  );
}

/** A list above the projects (Needs you, Working, Pinned): a header, and its rows unless folded. */
function SectionList({
  className,
  testId,
  icon,
  title,
  sessions,
  open = true,
  onToggle,
  row,
}: {
  className: string;
  testId: string;
  icon: React.ReactNode;
  title: string;
  sessions: ProjectSession[];
  open?: boolean;
  /** Foldable when given. */
  onToggle?: () => void;
  row: (s: ProjectSession) => React.ReactNode;
}) {
  return (
    <li className={`project-group section-group ${className}${open ? " is-open" : ""}`} data-testid={testId}>
      <div className="project-head">
        {onToggle ? (
          <button type="button" className="project-toggle" aria-expanded={open} onClick={onToggle}>
            <IconChevronDown size={12} className="group-chevron" />
            {icon}
            <span className="project-name">{title}</span>
            <span className="group-count">{sessions.length}</span>
          </button>
        ) : (
          <span className="project-toggle is-static">
            {icon}
            <span className="project-name">{title}</span>
            <span className="group-count">{sessions.length}</span>
          </span>
        )}
      </div>
      {open ? <ul className="session-sublist">{sessions.map(row)}</ul> : null}
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
  onMark,
  onNewChat,
}: {
  group: ProjectGroup;
  searching: boolean;
  isActive: (s: ProjectSession) => boolean;
  isWorking: (s: ProjectSession) => boolean;
  harnessName: (id: string) => string;
  canStartChat: boolean;
  onOpen: (s: ProjectSession, newTab: boolean) => void;
  onMark: (s: ProjectSession, change: MarkChange) => void;
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
        onOpen={(newTab) => onOpen(s, newTab)}
        onMark={(change) => onMark(s, change)}
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
  /** `newTab`: open it in a new tab rather than the shown one. */
  onOpenSession: (s: ProjectSession, newTab: boolean) => void;
  /** Pin or archive a session. */
  onMarkSession: (s: ProjectSession, change: MarkChange) => void;
  onRefresh: () => void;
  /** Open Settings (theme, text size, pairing, sign-out, and the server's config.yml). */
  onSettings: () => void;
  /** Drag handle on the right edge (wide screens). */
  resizer?: React.ReactNode;
  /** Under the session list: the usage limits meter. */
  footer?: React.ReactNode;
  onClose: () => void;
  /** Wide screens: fold the sidebar away (the chat header gets the expand button). */
  onCollapse: () => void;
}) {
  const current = props.harnesses.find((h) => h.id === props.harnessId);
  const names = useMemo(() => new Map(props.harnesses.map((h) => [h.id as string, h.displayName])), [props.harnesses]);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [workingOpen, setWorkingOpen] = useState(() => load<boolean>("workingOpen", false));
  // Snoozes end on the minute.
  const now = useNow(true, 60_000);
  const isActiveSession = (s: ProjectSession) =>
    (props.activeSessionId !== null && s.id === props.activeSessionId) || (s.liveChatId !== undefined && s.liveChatId === props.activeChatId);
  const groupOptions = {
    currentId: props.workspace?.id ?? null,
    query: props.query,
    harnessId: props.harnessId,
    showArchived,
    showSettled,
    showSnoozed,
    isActive: isActiveSession,
    now,
  };
  const groups = useMemo(
    () => groupByProject(props.overview, groupOptions),
    [props.overview, props.workspace, props.query, props.harnessId, showArchived, showSettled, showSnoozed, props.activeSessionId, props.activeChatId, now],
  );
  const sections = useMemo(
    () => sidebarSections(props.overview, groupOptions),
    [props.overview, props.query, props.harnessId, props.activeSessionId, props.activeChatId, now],
  );
  const { pinned, needs, working } = sections;
  const projectName = (s: ProjectSession) => props.overview.workspaces.find((w) => w.id === s.workspaceId)?.name ?? "";
  const asideRef = useRef<HTMLElement>(null);
  const { open } = props;

  // Drawer mode: Escape closes from anywhere; the backdrop owns outside clicks.
  useDismiss(asideRef, open, props.onClose, { escape: true, outside: false });
  // Focus moves in once on open.
  useEffect(() => {
    if (!open) return;
    asideRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);

  const isActive = isActiveSession;
  const isWorking = (s: ProjectSession) => (isActive(s) ? isBusy(props.activeStatus) : isBusy(s.status));
  const searching = props.query.trim() !== "";
  const sectionRow = (s: ProjectSession) => (
    <SessionRow
      key={s.id}
      s={s}
      active={isActive(s)}
      working={isWorking(s)}
      harnessName={names.get(s.harnessId) ?? s.harnessId}
      project={projectName(s)}
      onOpen={(newTab) => props.onOpenSession(s, newTab)}
      onMark={(change) => props.onMarkSession(s, change)}
    />
  );

  return (
    <>
      <div className={`backdrop${props.open ? " is-open" : ""}`} onClick={props.onClose} aria-hidden="true" />
      <aside ref={asideRef} className={`sidebar${props.open ? " is-open" : ""}`} aria-label="Sessions" {...(props.open ? { role: "dialog", "aria-modal": true } : {})}>
        <div className="sidebar-head">
          <span className="brand">awui</span>
          <button type="button" className="icon-btn sidebar-settings" aria-label="Settings" title="Settings" onClick={props.onSettings}>
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            className="icon-btn sidebar-collapse"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            onClick={props.onCollapse}
          >
            <IconSidebar size={16} />
          </button>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={props.onClose}>
            <IconChevronDown size={16} className="rotate-90" />
          </button>
        </div>

        <button type="button" className="new-chat" onClick={props.onNewChat} disabled={props.newChatDisabled !== null}>
          <IconPlus size={15} /> New chat
        </button>
        {props.newChatDisabled ? <p className="sidebar-note">{props.newChatDisabled}</p> : null}

        <HarnessMenu
          variant="row"
          label="Harness"
          menuLabel="Harness"
          currentId={props.harnessId}
          choices={props.harnesses.map((h) => ({ harness: h, blocked: h.available ? null : (h.reason ?? "Not available") }))}
          onPick={props.onHarness}
        />
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
            {props.sessionsLoading && groups.length === 0 ? (
              <li className="skeleton-list" aria-hidden="true">
                <span className="skeleton-row" />
                <span className="skeleton-row" />
                <span className="skeleton-row" />
              </li>
            ) : null}
            {needs.length > 0 ? (
              <SectionList
                className="needs-group"
                testId="needs-group"
                icon={<IconWarning size={14} />}
                title="Needs you"
                sessions={needs}
                row={(s) => sectionRow(s)}
              />
            ) : null}
            {working.length > 0 ? (
              <SectionList
                className="working-group"
                testId="working-group"
                icon={<WorkingRing colored={false} />}
                title="Working"
                sessions={working}
                open={workingOpen}
                onToggle={() => {
                  setWorkingOpen(!workingOpen);
                  save("workingOpen", !workingOpen);
                }}
                row={(s) => sectionRow(s)}
              />
            ) : null}
            {pinned.length > 0 ? (
              <SectionList className="pinned-group" testId="pinned-group" icon={<IconPin size={14} />} title="Pinned" sessions={pinned} row={(s) => sectionRow(s)} />
            ) : null}
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
                onMark={props.onMarkSession}
                onNewChat={props.onNewChatIn}
              />
            ))}
            {!searching && (sections.counts.snoozed > 0 || sections.counts.settled > 0 || sections.counts.archived > 0) ? (
              <li className="list-toggles">
                {sections.counts.snoozed > 0 ? (
                  <button type="button" className="show-more" aria-pressed={showSnoozed} onClick={() => setShowSnoozed((v) => !v)}>
                    <IconClock size={13} /> {showSnoozed ? "Hide snoozed" : `${sections.counts.snoozed} snoozed`}
                  </button>
                ) : null}
                {sections.counts.settled > 0 ? (
                  <button type="button" className="show-more" aria-pressed={showSettled} onClick={() => setShowSettled((v) => !v)}>
                    <IconCheck size={13} /> {showSettled ? "Hide settled" : `${sections.counts.settled} settled`}
                  </button>
                ) : null}
                {sections.counts.archived > 0 ? (
                  <button type="button" className="show-more archived-toggle" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                    <IconArchive size={13} /> {showArchived ? "Hide archived" : `${sections.counts.archived} archived`}
                  </button>
                ) : null}
              </li>
            ) : null}
            {!props.sessionsLoading && groups.length === 0 && pinned.length === 0 && needs.length === 0 && working.length === 0 && !props.sessionsError ? (
              <li className="sidebar-note">{searching ? "No matching sessions" : "No sessions yet. Choose a folder and start a chat."}</li>
            ) : null}
          </ul>
        </div>

        {props.footer}
        {props.resizer}
      </aside>
    </>
  );
}
