import { useEffect, useMemo, useState } from "react";
import type { ChatSnapshot, ImageAttachment, InteractionAnswer, ProjectSession, SendMode, WorkspaceInfo } from "../shared/protocol.js";
import { api, ApiError, errorText } from "./api.js";
import { useBanner } from "./banner.js";
import { useBootstrap } from "./bootstrap.js";
import { CONN_BANNER, setHash, STATUS_LABEL, useChatStream } from "./chat-stream.js";
import { appCommand } from "./commands.js";
import { Composer } from "./components/Composer.js";
import { Conversation } from "./components/Conversation.js";
import { Loader } from "./components/Loader.js";
import { LoginForm } from "./components/LoginForm.js";
import { Sidebar } from "./components/Sidebar.js";
import { SidebarResizer } from "./components/SidebarResizer.js";
import { StatusBar } from "./components/StatusBar.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { PairDialog, RenameDialog } from "./dialogs.js";
import { IconMenu, IconMore, IconSidebar } from "./icons.js";
import { useSessions } from "./sessions.js";
import { useSidebarLayout } from "./sidebar-layout.js";
import { forgetWorkspace, load, rememberWorkspace, save } from "./storage.js";
import { useTheme } from "./theme.js";

export function App() {
  const { banner, setBanner, fail } = useBanner();
  const { themeMode, themeInfo, initTheme, applyMode } = useTheme();
  const [harnessId, setHarnessId] = useState<string | null>(() => load<string | null>("harness", null));
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => load<string[]>("recentWorkspaces", []));

  // A 401 on the live stream flips useBootstrap's signed-out flag (declared on
  // the next line); this closure only runs on an event, long after this render
  // finished, so the forward reference is safe.
  const { chat, setChat, conn } = useChatStream({ onSignedOut: () => setSignedOut(true) });
  const { boot, bootError, signedOut, setSignedOut } = useBootstrap({ onTheme: initTheme, setHarnessId, setWorkspace, setRecent, setChat });
  const { overview, sessionsError, sessionsLoading, refreshSessions } = useSessions({ boot, workspace, chat });
  const {
    sidebarWidth,
    setSidebarWidth,
    commitSidebarWidth,
    sidebarCollapsed,
    sidebarToggling,
    collapseSidebar,
    drawerOpen,
    setDrawerOpen,
    narrow,
    openedWhileNarrow,
  } = useSidebarLayout();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [textScale, setTextScale] = useState<number>(() => load<number>("chatScale", 1));

  // ---- chat text size (separate from page zoom, per device) -------------------

  useEffect(() => {
    document.documentElement.style.setProperty("--chat-scale", String(textScale));
  }, [textScale]);

  const available = useMemo(() => boot?.harnesses.filter((h) => h.available) ?? [], [boot]);
  const chatId = chat?.chatId ?? null;

  // ---- actions -------------------------------------------------------------------------

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
      fail(e);
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
      fail(e);
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
      fail(e);
      return false;
    }
  };

  const refreshModels = async (): Promise<void> => {
    if (!chat) return;
    try {
      // The new list arrives as a config event.
      await api(`/api/chats/${chat.chatId}/models/refresh`, { body: {} });
    } catch (e) {
      fail(e);
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
      fail(e);
      return false;
    }
  };

  const stop = () => {
    if (!chat) return;
    setChat((prev) => (prev && prev.status !== "idle" ? { ...prev, status: "stopping" } : prev));
    api(`/api/chats/${chat.chatId}/abort`, { body: {} }).catch((e: unknown) => fail(e));
  };

  /** Branch the chat after its Nth turn into a new session, and open the copy. */
  const forkChat = async (through: number): Promise<void> => {
    if (!chat) return;
    try {
      showChat(await api<ChatSnapshot>(`/api/chats/${chat.chatId}/fork`, { body: { through } }));
    } catch (e) {
      fail(e);
    }
  };

  const answer = async (requestId: string, a: InteractionAnswer) => {
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/requests/${encodeURIComponent(requestId)}`, { body: { answer: a } });
    } catch (e) {
      // 409 = already resolved (another client answered): drop the card and say
      // so quietly. Any other failure may still be pending: keep the card.
      const resolved = e instanceof ApiError && e.status === 409;
      fail(e, resolved ? "info" : "error");
      if (resolved) setChat((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev));
    }
  };

  const configure = async (patch: { model?: string; thinkingLevel?: string }) => {
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/config`, { method: "PATCH", body: patch });
    } catch (e) {
      fail(e);
    }
  };

  const compact = async () => {
    setMenuOpen(false);
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/compact`, { body: {} });
    } catch (e) {
      fail(e);
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
        resizer={<SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} onCommit={commitSidebarWidth} />}
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
        onThemeMode={applyMode}
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
              fail(e);
              setRenameOpen(false);
            }
          }}
        />
      ) : null}
      {pairOpen ? <PairDialog urls={boot.pairing.urls} username={boot.auth.username} onClose={() => setPairOpen(false)} /> : null}
    </div>
  );
}
