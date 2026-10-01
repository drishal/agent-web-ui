import { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessStatus, SessionSummary, WorkspaceInfo } from "../../shared/protocol.js";
import { IconChevronDown, IconFolder, IconPlus, IconSearch } from "../icons.js";
import type { ThemeMode } from "../theme.js";

export type SessionScope = "harness" | "all";

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

function dateBucket(iso: string | null): string {
  if (!iso) return "Older";
  const then = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const t = then.getTime();
  if (t >= today.getTime()) return "Today";
  if (t >= today.getTime() - day) return "Yesterday";
  if (t >= today.getTime() - 7 * day) return "Previous 7 days";
  if (t >= today.getTime() - 30 * day) return "Previous 30 days";
  return "Older";
}

function SessionRow({
  s,
  active,
  harnessName,
  showBadge,
  onOpen,
}: {
  s: SessionSummary;
  active: boolean;
  harnessName: string;
  showBadge: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" className={`session${active ? " is-active" : ""}`} onClick={onOpen} aria-current={active ? "true" : undefined}>
        <span className="session-title">{s.title}</span>
        <span className="session-meta">
          {s.liveChatId ? <span className="live-dot" title="Open in this server" aria-label="live" /> : null}
          {showBadge ? <span className={`badge badge-${s.harnessId}`}>{harnessName}</span> : null}
          <span className="session-time">{relativeTime(s.updatedAt)}</span>
        </span>
      </button>
    </li>
  );
}

function HarnessGroup({ name, count, children }: { name: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <li className={`session-group${open ? " is-open" : ""}`}>
      <button type="button" className="group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconChevronDown size={12} className="group-chevron" />
        <span>{name}</span>
        <span className="group-count">{count}</span>
      </button>
      {open ? <ul className="session-sublist">{children}</ul> : null}
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
  sessions: SessionSummary[];
  sessionsError: string | null;
  sessionsLoading: boolean;
  scope: SessionScope;
  onScope: (scope: SessionScope) => void;
  query: string;
  onQuery: (q: string) => void;
  activeSessionId: string | null;
  activeChatId: string | null;
  onOpenSession: (s: SessionSummary) => void;
  onRefresh: () => void;
  themeMode: ThemeMode;
  schemeName: string | null;
  onThemeMode: (mode: ThemeMode) => void;
  textScale: number;
  onTextScale: (scale: number) => void;
  onPair: () => void;
  onClose: () => void;
  version: string;
}) {
  const current = props.harnesses.find((h) => h.id === props.harnessId);
  const names = useMemo(() => new Map(props.harnesses.map((h) => [h.id as string, h.displayName])), [props.harnesses]);
  const filtered = props.sessions.filter((s) => !props.query || s.title.toLowerCase().includes(props.query.toLowerCase()));
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

  const isActive = (s: SessionSummary) =>
    (props.activeSessionId !== null && s.id === props.activeSessionId) || (s.liveChatId !== undefined && s.liveChatId === props.activeChatId);

  let list: React.ReactNode;
  if (props.scope === "all") {
    const byHarness = new Map<string, SessionSummary[]>();
    for (const s of filtered) byHarness.set(s.harnessId, [...(byHarness.get(s.harnessId) ?? []), s]);
    list = [...byHarness.entries()].map(([id, group]) => (
      <HarnessGroup key={id} name={names.get(id) ?? id} count={group.length}>
        {group.map((s) => (
          <SessionRow key={s.id} s={s} active={isActive(s)} harnessName={names.get(s.harnessId) ?? s.harnessId} showBadge={false} onOpen={() => props.onOpenSession(s)} />
        ))}
      </HarnessGroup>
    ));
  } else {
    const nodes: React.ReactNode[] = [];
    let bucket = "";
    for (const s of filtered) {
      const b = s.liveChatId && !s.updatedAt ? "Open" : dateBucket(s.updatedAt);
      if (b !== bucket) {
        bucket = b;
        nodes.push(
          <li key={`d-${b}`} className="date-divider" role="presentation">
            {b}
          </li>,
        );
      }
      nodes.push(
        <SessionRow key={s.id} s={s} active={isActive(s)} harnessName={names.get(s.harnessId) ?? s.harnessId} showBadge={false} onOpen={() => props.onOpenSession(s)} />,
      );
    }
    list = nodes;
  }

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
          <label className="search-field">
            <IconSearch size={14} />
            <input type="search" placeholder="Search sessions" value={props.query} onChange={(e) => props.onQuery(e.target.value)} aria-label="Search sessions" />
          </label>
          <div className="sessions-head">
            <div className="segmented segmented-small" role="radiogroup" aria-label="Which sessions">
              <button type="button" role="radio" aria-checked={props.scope === "harness"} className={props.scope === "harness" ? "is-active" : ""} onClick={() => props.onScope("harness")}>
                {current?.displayName ?? "This"}
              </button>
              <button type="button" role="radio" aria-checked={props.scope === "all"} className={props.scope === "all" ? "is-active" : ""} onClick={() => props.onScope("all")}>
                All
              </button>
            </div>
            <button type="button" className="icon-btn" aria-label="Refresh sessions" onClick={props.onRefresh}>
              ↻
            </button>
          </div>
          {props.sessionsError ? <p className="sidebar-note is-warning">{props.sessionsError}</p> : null}
          <ul className="session-list" aria-busy={props.sessionsLoading}>
            {list}
            {!props.sessionsLoading && props.workspace && filtered.length === 0 && !props.sessionsError ? (
              <li className="sidebar-note">{props.query ? "No matching sessions" : "No sessions in this folder yet"}</li>
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
          <span className="version foot-version">v{props.version}</span>
        </footer>
      </aside>
    </>
  );
}
