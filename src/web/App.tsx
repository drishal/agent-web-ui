import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bootstrap,
  ChatEvent,
  ChatSnapshot,
  InteractionAnswer,
  SendMode,
  SessionSummary,
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
import { type SessionScope, Sidebar } from "./components/Sidebar.js";
import { StatusBar } from "./components/StatusBar.js";
import { IconMenu, IconMore } from "./icons.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { forgetWorkspace, load, rememberWorkspace, save } from "./storage.js";
import { ChatStream, type ConnectionState } from "./stream.js";
import { applyTheme, fetchTheme, storedThemeMode, storeThemeMode, type ThemeMode } from "./theme.js";

type Banner = { level: "info" | "warning" | "error"; text: string } | null;

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
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [scope, setScope] = useState<SessionScope>(() => load<SessionScope>("sessionScope", "harness"));
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
        setThemeMode(storedThemeMode(t));
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

  const refreshSessions = useCallback(async () => {
    if (!workspace || !harnessId) {
      setSessions([]);
      return;
    }
    setSessionsLoading(true);
    const ids = scope === "all" ? available.map((h) => h.id as string) : [harnessId];
    const errors: string[] = [];
    const lists = await Promise.all(
      ids.map(async (id) => {
        try {
          return (await api<{ sessions: SessionSummary[] }>(`/api/harnesses/${id}/sessions?workspaceId=${workspace.id}`)).sessions;
        } catch (e) {
          if (e instanceof ApiError && e.code === "unknown_workspace") {
            try {
              setWorkspace(await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: workspace.path } }));
            } catch {
              // handled by the next refresh
            }
          }
          errors.push(scope === "all" ? `${id}: ${errorText(e)}` : errorText(e));
          return [];
        }
      }),
    );
    setSessions(lists.flat().sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")));
    setSessionsError(errors.length > 0 ? errors.join(" · ") : null);
    setSessionsLoading(false);
  }, [workspace, harnessId, scope, available]);

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

  // ---- actions -------------------------------------------------------------------------

  const chooseHarness = (id: string) => {
    setHarnessId(id);
    save("harness", id);
  };

  const chooseScope = (s: SessionScope) => {
    setScope(s);
    save("sessionScope", s);
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

  const newChat = async () => {
    if (!workspace || !harnessId) return;
    setOpening(true);
    setBanner(null);
    try {
      showChat(await api<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: workspace.id } }));
      void refreshSessions();
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
      setDrawerOpen(false);
    } finally {
      setOpening(false);
    }
  };

  const openSession = async (s: SessionSummary) => {
    if (!workspace) return;
    setOpening(true);
    setBanner(null);
    try {
      if (s.liveChatId) showChat(await api<ChatSnapshot>(`/api/chats/${s.liveChatId}`));
      else showChat(await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: s.harnessId, workspaceId: workspace.id, sessionId: s.id } }));
    } catch (e) {
      setBanner({ level: "error", text: errorText(e) });
      setDrawerOpen(false);
      void refreshSessions();
    } finally {
      setOpening(false);
    }
  };

  const send = async (text: string, mode: SendMode): Promise<boolean> => {
    if (!chat) return false;
    try {
      await api(`/api/chats/${chat.chatId}/messages`, { body: { text, mode } });
      setBanner(null);
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
    <div className="app">
      <Sidebar
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
        sessions={sessions}
        sessionsError={sessionsError}
        sessionsLoading={sessionsLoading}
        scope={scope}
        onScope={chooseScope}
        query={query}
        onQuery={setQuery}
        activeSessionId={chat?.sessionId ?? null}
        activeChatId={chatId}
        onOpenSession={(s) => void openSession(s)}
        onRefresh={() => void refreshSessions()}
        themeMode={themeMode}
        schemeName={themeInfo?.source === "file" ? themeInfo.name : null}
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
        version={boot.version}
      />

      <main className="main">
        <header className="chat-header">
          <button type="button" className="icon-btn drawer-open" aria-label="Open menu" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            <IconMenu size={18} />
          </button>
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
                onStop={stop}
                onAnswer={answer}
                onConfig={configure}
              />
            </div>
          </div>
        ) : chat ? (
          <>
            <Conversation items={chat.items} status={chat.status} workspace={chat.workspace.path} />
            {chat.gone ? <div className="banner banner-info">{chat.gone}</div> : null}
            <Composer
              key={chat.chatId}
              chat={chat}
              maxChars={boot.limits.maxMessageChars}
              onSend={send}
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
                <p className="muted">Pick a folder inside your workspace roots to list and start sessions.</p>
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
