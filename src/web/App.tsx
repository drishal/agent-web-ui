import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bootstrap,
  ChatEvent,
  ChatSnapshot,
  ImageAttachment,
  InteractionAnswer,
  ProjectSession,
  SendMode,
  SessionsOverview,
  ThemeInfo,
  WorkspaceInfo,
} from "../shared/protocol.js";
import { api, ApiError, errorText, onUnauthorized } from "./api.js";
import { applyEvents, type ChatState } from "./chat-state.js";
import { Composer } from "./components/Composer.js";
import { Conversation } from "./components/Conversation.js";
import { Dialog } from "./components/Dialog.js";
import { Loader } from "./components/Loader.js";
import { LoginForm } from "./components/LoginForm.js";
import { Sidebar } from "./components/Sidebar.js";
import { clampSidebar, SIDEBAR_DEFAULT, SidebarResizer } from "./components/SidebarResizer.js";
import { StatusBar } from "./components/StatusBar.js";
import { IconMenu, IconMore, IconSidebar } from "./icons.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { appCommand } from "./commands.js";
import { isBusy } from "./session-groups.js";
import { forgetWorkspace, load, rememberWorkspace, save } from "./storage.js";
import { ChatStream, type ConnectionState } from "./stream.js";
import { applyTheme, fetchTheme, storedThemeMode, storeThemeMode, type ThemeMode } from "./theme.js";

type Banner = { level: "info" | "warning" | "error"; text: string } | null;

/** Below this width (and above the phone drawer's 820 px) the sidebar folds away by itself. */
const AUTO_COLLAPSE_BELOW = 1200;
const NARROW_QUERY = `(min-width: 820px) and (max-width: ${AUTO_COLLAPSE_BELOW - 1}px)`;

/** How often the session list refreshes while a chat other than the open one is working. */
const BACKGROUND_POLL_MS = 3000;

const STATUS_LABEL: Record<string, string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Working",
  stopping: "Stopping",
  compacting: "Compacting",
  error: "Error",
  disposed: "Closed",
};

const CONN_BANNER: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Offline — waiting for the connection",
};

function chatIdFromHash(): string | null {
  const m = /^#chat=([\w-]{1,64})$/.exec(window.location.hash);
  return m?.[1] ?? null;
}

function setHash(chatId: string | null): void {
  const next = chatId ? `#chat=${chatId}` : "";
  if (window.location.hash !== next) history.replaceState(null, "", `${window.location.pathname}${next}`);
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [themeInfo, setThemeInfo] = useState<ThemeInfo | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  const [harnessId, setHarnessId] = useState<string | null>(() => load<string | null>("harness", null));
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => load<string[]>("recentWorkspaces", []));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [overview, setOverview] = useState<SessionsOverview>({ workspaces: [], sessions: [], errors: [] });
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [chat, setChat] = useState<ChatState | null>(null);
  const [conn, setConn] = useState<ConnectionState>("disconnected");
  const [banner, setBanner] = useState<Banner>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [textScale, setTextScale] = useState<number>(() => load<number>("chatScale", 1));
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => clampSidebar(load<number>("sidebarWidth", SIDEBAR_DEFAULT)));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => load<boolean>("sidebarCollapsed", false));
  // Animate only the toggle; resizing by drag must follow the pointer exactly.
  const [sidebarToggling, setSidebarToggling] = useState(false);
  const toggleTimer = useRef<number | null>(null);
  // Narrow windows (a vertical monitor, a tiled half screen) fold the sidebar away by
  // themselves, unless the user reopens it; crossing the threshold again resets that.
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [openedWhileNarrow, setOpenedWhileNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY);
    const onChange = () => {
      setNarrow(query.matches);
      setOpenedWhileNarrow(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const chatId = chat?.chatId ?? null;

  // ---- bootstrap -----------------------------------------------------------

  useEffect(() => onUnauthorized(() => setSignedOut(true)), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, t] = await Promise.all([api<Bootstrap>("/api/bootstrap"), fetchTheme()]);
        if (cancelled) return;
        setBoot(b);
        setThemeInfo(t);
        setThemeMode(storedThemeMode(t, b.ui.theme));
        setHarnessId((prev) => {
          const available = b.harnesses.filter((h) => h.available);
          if (prev && available.some((h) => h.id === prev)) return prev;
          return available[0]?.id ?? b.harnesses[0]?.id ?? null;
        });
        const last = load<string[]>("recentWorkspaces", [])[0];
        if (last) {
          try {
            setWorkspace(await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: last } }));
          } catch {
            setRecent(forgetWorkspace(last));
          }
        }
        const fromHash = chatIdFromHash();
        if (fromHash) {
          try {
            setChat(await api<ChatSnapshot>(`/api/chats/${fromHash}`));
          } catch {
            setHash(null);
          }
        }
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) setBootError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the sidebar inside its bounds when the window shrinks.
  useEffect(() => {
    const onResize = () => setSidebarWidth((w) => clampSidebar(w));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---- chat text size (separate from page zoom, per device) -------------------

  useEffect(() => {
    document.documentElement.style.setProperty("--chat-scale", String(textScale));
  }, [textScale]);

  // ---- theme ------------------------------------------------------------------

  useEffect(() => {
    applyTheme(themeMode, themeInfo);
  }, [themeMode, themeInfo]);

  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      const t = await fetchTheme();
      if (t) setThemeInfo((prev) => (JSON.stringify(prev) === JSON.stringify(t) ? prev : t));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // ---- live chat stream -----------------------------------------------------------

  useEffect(() => {
    if (!chatId) {
      setConn("disconnected");
      return;
    }
    setHash(chatId);
    let queue: ChatEvent[] = [];
    let frame: number | null = null;
    const flush = () => {
      frame = null;
      const events = queue;
      queue = [];
      setChat((prev) => (prev && prev.chatId === chatId ? applyEvents(prev, events) : prev));
    };
    const stream = new ChatStream(chatId, {
      onEvent: (event) => {
        queue.push(event);
        if (frame === null) frame = window.requestAnimationFrame(flush);
      },
      onState: setConn,
      onGone: (status) => {
        if (status === 401) setSignedOut(true);
        else {
          setChat((prev) => (prev && prev.chatId === chatId ? { ...prev, status: "disposed", gone: "This chat was closed" } : prev));
        }
      },
    });
    stream.start();
    return () => {
      stream.stop();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [chatId]);

  // ---- sessions ---------------------------------------------------------------------

  const available = useMemo(() => boot?.harnesses.filter((h) => h.available) ?? [], [boot]);

  // Every harness, every project; the sidebar filters by harness and groups by project.
  const sessionsRequest = useRef(0);
  const refreshSessions = useCallback(async () => {
    if (!boot) return;
    const seq = ++sessionsRequest.current;
    setSessionsLoading(true);
    try {
      // Passing the current project also re-registers it after a server restart.
      const next = await api<SessionsOverview>(`/api/sessions${workspace ? `?path=${encodeURIComponent(workspace.path)}` : ""}`);
      if (seq !== sessionsRequest.current) return;
      setOverview(next);
      setSessionsError(next.errors.length > 0 ? next.errors.join(" · ") : null);
    } catch (e) {
      if (seq === sessionsRequest.current) setSessionsError(errorText(e));
    } finally {
      if (seq === sessionsRequest.current) setSessionsLoading(false);
    }
  }, [boot, workspace]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Refresh the list when a run settles or the title changes.
  const settleKey = chat ? `${chat.chatId}:${chat.status === "idle" ? "idle" : "busy"}:${chat.title}:${chat.sessionId}` : "";
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!settleKey) return;
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refreshSessions(), 600);
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [settleKey, refreshSessions]);

  // Runs in other chats have no stream here: poll while any is working so its spinner stops on time.
  const backgroundBusy = overview.sessions.some((s) => isBusy(s.status) && s.liveChatId !== chatId);
  useEffect(() => {
    if (!backgroundBusy) return;
    const timer = window.setInterval(() => void refreshSessions(), BACKGROUND_POLL_MS);
    return () => window.clearInterval(timer);
  }, [backgroundBusy, refreshSessions]);

  // ---- actions -------------------------------------------------------------------------

  /** Fold the sidebar away or back (wide screens); focus follows to the other toggle. */
  const collapseSidebar = (collapsed: boolean) => {
    setSidebarToggling(true);
    if (toggleTimer.current !== null) window.clearTimeout(toggleTimer.current);
    toggleTimer.current = window.setTimeout(() => setSidebarToggling(false), 250);
    // A collapse by hand sticks at every width; reopening in a narrow window lasts until it widens.
    setSidebarCollapsed(collapsed);
    save("sidebarCollapsed", collapsed || null);
    if (!collapsed && narrow) setOpenedWhileNarrow(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(collapsed ? ".sidebar-expand" : ".sidebar-collapse")?.focus());
  };

  const chooseHarness = (id: string) => {
    setHarnessId(id);
    save("harness", id);
  };

  const openWorkspace = async (path: string) => {
    setPickerError(null);
    try {
      const ws = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path } });
      setWorkspace(ws);
      setRecent(rememberWorkspace(ws.path));
      setPickerOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "missing_project") setRecent(forgetWorkspace(path));
      setPickerError(errorText(e));
    }
  };

  const showChat = (snapshot: ChatSnapshot) => {
    setChat(snapshot);
    setBanner(null);
    setDrawerOpen(false);
  };

  /** Make `ws` the current project, registering it with the server again if needed. */
  const enterWorkspace = async (ws: WorkspaceInfo): Promise<WorkspaceInfo> => {
    if (ws.id === workspace?.id) return ws;
    const opened = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: ws.path } });
    setWorkspace(opened);
    setRecent(rememberWorkspace(opened.path));
    return opened;
  };

  const newChat = async (target: WorkspaceInfo | null = workspace) => {
    if (!target || !harnessId) return;
    setOpening(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      showChat(await api<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: ws.id } }));
      void refreshSessions();
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
      setDrawerOpen(false);
    } finally {
      setOpening(false);
    }
  };

  const openSession = async (s: ProjectSession) => {
    const target = overview.workspaces.find((w) => w.id === s.workspaceId);
    if (!target) return;
    setOpening(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      if (s.liveChatId) showChat(await api<ChatSnapshot>(`/api/chats/${s.liveChatId}`));
      else showChat(await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: s.harnessId, workspaceId: ws.id, sessionId: s.id } }));
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
      setDrawerOpen(false);
      void refreshSessions();
    } finally {
      setOpening(false);
    }
  };

  const send = async (text: string, mode: SendMode, images: ImageAttachment[] = []): Promise<boolean> => {
    if (!chat) return false;
    const command = mode === "normal" && images.length === 0 ? appCommand(text) : null;
    if (command) return runAppCommand(command.name, command.arg);
    try {
      await api(`/api/chats/${chat.chatId}/messages`, { body: { text, mode, ...(images.length > 0 ? { images } : {}) } });
      setBanner(null);
      return true;
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
      return false;
    }
  };

  const refreshModels = async (): Promise<void> => {
    if (!chat) return;
    try {
      // The new list arrives as a config event.
      await api(`/api/chats/${chat.chatId}/models/refresh`, { body: {} });
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
    }
  };

  /** /new, /compact [focus], /rename <title>: the app's own commands, for every harness. */
  const runAppCommand = async (name: string, arg: string): Promise<boolean> => {
    if (!chat) return false;
    try {
      if (name === "new") await newChat();
      else if (name === "compact") await api(`/api/chats/${chat.chatId}/compact`, { body: arg ? { instructions: arg } : {} });
      else if (name === "rename") {
        if (arg) await api(`/api/chats/${chat.chatId}/rename`, { body: { name: arg } });
        else setRenameOpen(true);
      }
      return true;
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
      return false;
    }
  };

  const stop = () => {
    if (!chat) return;
    setChat((prev) => (prev && prev.status !== "idle" ? { ...prev, status: "stopping" } : prev));
    api(`/api/chats/${chat.chatId}/abort`, { body: {} }).catch((e: unknown) => setBanner({ level: "error", text: errorText(e) }));
  };

  /** Branch the chat after its Nth turn into a new session, and open the copy. */
  const forkChat = async (through: number): Promise<void> => {
    if (!chat) return;
    try {
      showChat(await api<ChatSnapshot>(`/api/chats/${chat.chatId}/fork`, { body: { through } }));
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
    }
  };

  const answer = async (requestId: string, a: InteractionAnswer) => {
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/requests/${encodeURIComponent(requestId)}`, { body: { answer: a } });
    } catch (e) {
      setBanner({ level: e instanceof ApiError && e.status === 409 ? "info" : "error", text: errorText(e) });
      setChat((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev));
    }
  };

  const configure = async (patch: { model?: string; thinkingLevel?: string }) => {
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/config`, { method: "PATCH", body: patch });
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
    }
  };

  const compact = async () => {
    setMenuOpen(false);
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/compact`, { body: {} });
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
    }
  };

  const closeChat = async () => {
    setMenuOpen(false);
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/dispose`, { body: {} });
    } catch {
      // already gone
    }
    setChat(null);
    setHash(null);
    void refreshSessions();
  };

  // ---- render ---------------------------------------------------------------------------

  const collapsed = sidebarCollapsed || (narrow && !openedWhileNarrow && (boot?.ui.autocollapseSidebar ?? true));

  if (signedOut) {
    return <LoginForm />;
  }
  if (bootError) {
    return (
      <div className="fullscreen-message">
        <h1>Cannot reach the server</h1>
        <p>{bootError}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (!boot) {
    return (
      <div className="fullscreen-message">
        <Loader label="Connecting to the server" />
      </div>
    );
  }

  const currentHarness = boot.harnesses.find((h) => h.id === harnessId);
  const newChatDisabled = !currentHarness
    ? "No harness is available."
    : !currentHarness.available
      ? `${currentHarness.displayName} is not installed.`
      : !workspace
        ? "Choose a project folder first."
        : opening
          ? "Opening…"
          : null;
  const chatHarness = chat ? boot.harnesses.find((h) => h.id === chat.harnessId) : undefined;
  const hasPrompt = chat ? chat.items.some((i) => i.kind === "user") : false;

  return (
    <div
      className={`app${collapsed ? " is-collapsed" : ""}${sidebarToggling ? " is-toggling" : ""}`}
      style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
    >
      <Sidebar
        resizer={
          <SidebarResizer
            width={sidebarWidth}
            onResize={setSidebarWidth}
            onCommit={(w) => save("sidebarWidth", w === SIDEBAR_DEFAULT ? null : w)}
          />
        }
        open={drawerOpen}
        harnesses={boot.harnesses}
        harnessId={harnessId}
        onHarness={chooseHarness}
        workspace={workspace}
        onPickWorkspace={() => {
          setPickerError(null);
          setPickerOpen(true);
        }}
        onNewChat={() => void newChat()}
        newChatDisabled={newChatDisabled}
        canStartChat={Boolean(currentHarness?.available) && !opening}
        onNewChatIn={(ws) => void newChat(ws)}
        overview={overview}
        sessionsError={sessionsError}
        sessionsLoading={sessionsLoading}
        query={query}
        onQuery={setQuery}
        activeSessionId={chat?.sessionId ?? null}
        activeChatId={chatId}
        activeStatus={chat?.status ?? null}
        onOpenSession={(s) => void openSession(s)}
        onRefresh={() => void refreshSessions()}
        themeMode={themeMode}
        scheme={themeInfo?.source === "file" ? { name: themeInfo.name } : null}
        onThemeMode={(m) => {
          setThemeMode(m);
          storeThemeMode(m);
        }}
        textScale={textScale}
        onTextScale={(v) => {
          setTextScale(v);
          save("chatScale", v);
        }}
        onPair={() => setPairOpen(true)}
        signedInAs={boot.auth.mode === "password" ? boot.auth.username : null}
        onSignOut={() => {
          void api("/api/logout", { body: {} }).finally(() => window.location.reload());
        }}
        onClose={() => setDrawerOpen(false)}
        onCollapse={() => collapseSidebar(true)}
        version={boot.version}
      />

      <main className="main">
        <header className="chat-header">
          <button type="button" className="icon-btn drawer-open" aria-label="Open menu" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            <IconMenu size={18} />
          </button>
          {collapsed ? (
            <button type="button" className="icon-btn sidebar-expand" aria-label="Expand sidebar" title="Expand sidebar" onClick={() => collapseSidebar(false)}>
              <IconSidebar size={16} />
            </button>
          ) : null}
          <div className="chat-title">
            <h1>{chat ? chat.title || "New chat" : workspace ? workspace.name : "Agent Web UI"}</h1>
            {chat ? (
              <div className="chat-sub">
                <span className={`badge badge-${chat.harnessId}`}>{chatHarness?.displayName ?? chat.harnessId}</span>
                <span className={`status status-${chat.status}`} data-testid="chat-status">
                  {STATUS_LABEL[chat.status] ?? chat.status}
                </span>
                <span className="chat-path" title={chat.workspace.path}>
                  {chat.workspace.name}
                </span>
              </div>
            ) : null}
          </div>
          {chat && chat.status !== "disposed" ? (
            <div className="menu">
              <button type="button" className="icon-btn" aria-label="Chat actions" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((v) => !v)}>
                <IconMore size={18} />
              </button>
              {menuOpen ? (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                  <ul className="menu-list" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenuOpen(false)}>
                    {chat.capabilities.supportsRename ? (
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            setRenameOpen(true);
                          }}
                        >
                          Rename
                        </button>
                      </li>
                    ) : null}
                    {chat.capabilities.supportsCompact ? (
                      <li role="none">
                        <button type="button" role="menuitem" disabled={chat.status !== "idle"} onClick={() => void compact()}>
                          Compact context
                        </button>
                      </li>
                    ) : null}
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void closeChat()}>
                        Close chat
                      </button>
                    </li>
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </header>

        {chat && conn !== "connected" && conn !== "connecting" ? (
          <div className={`conn-banner conn-${conn}`} role="status">
            {CONN_BANNER[conn]}…
          </div>
        ) : null}
        {chat && chat.config.models.length === 0 && chat.capabilities.supportsModelSelection ? (
          <div className="banner banner-warning">
            No models are available. Run <code>{chatHarness?.id === "omp" ? "omp" : "pi"}</code> in a terminal and log in to a provider.
          </div>
        ) : null}
        {banner ? (
          <div className={`banner banner-${banner.level}`} role={banner.level === "error" ? "alert" : "status"}>
            <span>{banner.text}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setBanner(null)}>
              ✕
            </button>
          </div>
        ) : null}

        {chat && !hasPrompt ? (
          <div className="hero">
            <div className="hero-inner">
              {chat.items.length > 0 ? (
                <div className="hero-notices">
                  {chat.items.map((item) =>
                    item.kind === "notice" ? (
                      <div key={item.id} className={`notice-row notice-${item.level}`}>
                        <span className="notice-text">{item.text}</span>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : null}
              <h2 className="hero-title">
                What should {chatHarness?.displayName ?? "the agent"} do in <span className="hero-project">{chat.workspace.name}</span>?
              </h2>
              <p className="hero-sub muted">It runs with its normal tools, as you, in this folder.</p>
              {chat.gone ? <div className="banner banner-info">{chat.gone}</div> : null}
              <Composer
                key={chat.chatId}
                hero
                chat={chat}
                maxChars={boot.limits.maxMessageChars}
                placeholder={`Ask ${chatHarness?.displayName ?? "the agent"} to…`}
                onSend={send}
                onRefreshModels={refreshModels}
                onStop={stop}
                onAnswer={answer}
                onConfig={configure}
              />
            </div>
          </div>
        ) : chat ? (
          <>
            <Conversation items={chat.items} status={chat.status} workspace={chat.workspace.path} canFork={chat.capabilities.supportsFork} onFork={forkChat} />
            {chat.gone ? <div className="banner banner-info">{chat.gone}</div> : null}
            <Composer
              key={chat.chatId}
              chat={chat}
              maxChars={boot.limits.maxMessageChars}
              onSend={send}
              onRefreshModels={refreshModels}
              onStop={stop}
              onAnswer={answer}
              onConfig={configure}
            />
          </>
        ) : (
          <div className="empty empty-main">
            {!workspace ? (
              <>
                <h2>Choose a project</h2>
                <p className="muted">Pick a folder to start a chat, or resume a recent session from the sidebar.</p>
                <button type="button" className="btn btn-primary" onClick={() => setPickerOpen(true)}>
                  Choose folder
                </button>
              </>
            ) : available.length === 0 ? (
              <>
                <h2>No harness installed</h2>
                <p className="muted">Install Pi or omp, run it once in a terminal, and log in.</p>
              </>
            ) : (
              <>
                <h2>{workspace.name}</h2>
                <p className="muted">Start a new chat or resume one from the list.</p>
                <button type="button" className="btn btn-primary" onClick={() => void newChat()} disabled={newChatDisabled !== null}>
                  New {currentHarness?.displayName ?? ""} chat
                </button>
                {newChatDisabled && newChatDisabled !== "Opening…" ? <p className="muted">{newChatDisabled}</p> : null}
                <button type="button" className="btn btn-ghost drawer-open-inline" onClick={() => setDrawerOpen(true)}>
                  Show sessions
                </button>
              </>
            )}
          </div>
        )}
      </main>
      <StatusBar conn={conn} chat={chat} harnessName={chatHarness?.displayName ?? null} version={boot.version} />

      {pickerOpen ? <WorkspacePicker recent={recent} onOpen={(p) => void openWorkspace(p)} onClose={() => setPickerOpen(false)} error={pickerError} /> : null}
      {renameOpen && chat ? (
        <RenameDialog
          initial={chat.title}
          onClose={() => setRenameOpen(false)}
          onSave={async (name) => {
            try {
              await api(`/api/chats/${chat.chatId}/rename`, { body: { name } });
              setRenameOpen(false);
            } catch (e) {
              setBanner({ level: "error", text: errorText(e) });
              setRenameOpen(false);
            }
          }}
        />
      ) : null}
      {pairOpen ? (
        <Dialog title="Pair a phone" onClose={() => setPairOpen(false)}>
          {boot.pairing.urls.length > 0 ? (
            <>
              <p>
                Open one of these on your phone and sign in{boot.auth.username ? ` as “${boot.auth.username}”` : ""}. The session lasts 30
                days; changing the password with <code>npm run set-password</code> signs every device out.
              </p>
              {boot.pairing.urls.map((u) => (
                <div key={u} className="pair-url">
                  <code>{u}</code>
                  <button type="button" className="btn btn-small" onClick={() => void navigator.clipboard?.writeText(u)}>
                    Copy
                  </button>
                </div>
              ))}
              <p className="muted">LAN addresses are plain HTTP: prefer Tailscale when you are away from home.</p>
            </>
          ) : (
            <p>
              Other devices are off. Set a login with <code>npm run set-password</code>, then restart with <code>HOST=0.0.0.0</code> for your
              LAN, or with <code>ALLOWED_HOSTS=&lt;machine&gt;.&lt;tailnet&gt;.ts.net</code> plus{" "}
              <code>tailscale serve --bg http://127.0.0.1:4783</code> for Tailscale.
            </p>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}

function RenameDialog({ initial, onSave, onClose }: { initial: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Dialog title="Rename chat" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void onSave(name.trim());
        }}
      >
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Chat name" autoFocus maxLength={200} />
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}
