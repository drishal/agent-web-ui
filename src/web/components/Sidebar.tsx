import { useEffect, useMemo, useRef } from "react";
import type { HarnessStatus, SessionSummary, WorkspaceInfo } from "../../shared/protocol.js";
import type { ThemeMode } from "../theme.js";

export type SessionScope = "harness" | "all";

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
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
  onPair: () => void;
  onClose: () => void;
  version: string;
}) {
  const current = props.harnesses.find((h) => h.id === props.harnessId);
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
  const names = useMemo(() => new Map(props.harnesses.map((h) => [h.id as string, h.displayName])), [props.harnesses]);
  const filtered = props.sessions.filter((s) => !props.query || s.title.toLowerCase().includes(props.query.toLowerCase()));

  return (
    <>
      <div className={`backdrop${props.open ? " is-open" : ""}`} onClick={props.onClose} aria-hidden="true" />
      <aside
        ref={asideRef}
        className={`sidebar${props.open ? " is-open" : ""}`}
        aria-label="Sessions"
        {...(props.open ? { role: "dialog", "aria-modal": true } : {})}
      >
        <div className="sidebar-head">
          <span className="brand">Agent Web UI</span>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <button type="button" className="btn btn-primary btn-block" onClick={props.onNewChat} disabled={props.newChatDisabled !== null}>
          + New chat
        </button>
        {props.newChatDisabled ? <p className="sidebar-note">{props.newChatDisabled}</p> : null}

        <div className="sidebar-section">
          <div className="section-label" id="harness-label">
            Harness
          </div>
          <div className="segmented segmented-block" role="radiogroup" aria-labelledby="harness-label">
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
        </div>

        <div className="sidebar-section">
          <div className="section-label">Project</div>
          <button type="button" className="workspace-btn" onClick={props.onPickWorkspace} title={props.workspace?.path}>
            <span className="workspace-name">{props.workspace?.name ?? "Choose a folder…"}</span>
            {props.workspace ? (
              // LRM keeps the leading "/" in place while the rtl box elides from the left.
              <span className="workspace-path">{`\u200e${props.workspace.path}\u200e`}</span>
            ) : null}
          </button>
        </div>

        <div className="sidebar-section sessions">
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
          <input className="input input-small" type="search" placeholder="Search sessions" value={props.query} onChange={(e) => props.onQuery(e.target.value)} aria-label="Search sessions" />
          {props.sessionsError ? <p className="sidebar-note is-warning">{props.sessionsError}</p> : null}
          <ul className="session-list" aria-busy={props.sessionsLoading}>
            {filtered.map((s) => {
              const active = (props.activeSessionId !== null && s.id === props.activeSessionId) || (s.liveChatId !== undefined && s.liveChatId === props.activeChatId);
              return (
                <li key={s.id}>
                  <button type="button" className={`session${active ? " is-active" : ""}`} onClick={() => props.onOpenSession(s)} aria-current={active ? "true" : undefined}>
                    <span className="session-title">{s.title}</span>
                    <span className="session-meta">
                      <span className={`badge badge-${s.harnessId}`}>{names.get(s.harnessId) ?? s.harnessId}</span>
                      {s.liveChatId ? <span className="live-dot" title="Open in this server" aria-label="live" /> : null}
                      <span>{relativeTime(s.updatedAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
            {!props.sessionsLoading && props.workspace && filtered.length === 0 && !props.sessionsError ? (
              <li className="sidebar-note">{props.query ? "No matching sessions" : "No sessions in this folder yet"}</li>
            ) : null}
          </ul>
        </div>

        <footer className="sidebar-foot">
          <label className="control control-inline">
            <span className="control-label">Theme</span>
            <select className="select select-small" value={props.themeMode} onChange={(e) => props.onThemeMode(e.target.value as ThemeMode)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              {props.schemeName ? <option value="scheme">{props.schemeName}</option> : null}
            </select>
          </label>
          <button type="button" className="btn btn-small btn-ghost" onClick={props.onPair}>
            Pair phone
          </button>
          <span className="version">v{props.version}</span>
        </footer>
      </aside>
    </>
  );
}
