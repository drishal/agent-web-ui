import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSnapshot, ImageAttachment, InteractionAnswer, ProjectSession, PushNote, SendMode, ServerSettings, ThemeChoice, WorkspaceInfo } from "../shared/protocol.js";
import { api, ApiError, errorText } from "./api.js";
import { useBanner } from "./banner.js";
import { useBootstrap } from "./bootstrap.js";
import type { ChatState } from "./chat-state.js";
import { chatIdFromHash, CONN_BANNER, setHash, STATUS_LABEL, useChatStream } from "./chat-stream.js";
import { appCommand } from "./commands.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Composer } from "./components/Composer.js";
import { Conversation } from "./components/Conversation.js";
import { LimitsMeter } from "./components/LimitsMeter.js";
import { Loader } from "./components/Loader.js";
import { LoginForm } from "./components/LoginForm.js";
import { Sidebar, type MarkChange } from "./components/Sidebar.js";
import { SidebarResizer } from "./components/SidebarResizer.js";
import { StatusBar } from "./components/StatusBar.js";
import { TabStrip } from "./components/TabStrip.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { PairDialog, RenameDialog } from "./dialogs.js";
import { ReviewPanel } from "./components/ReviewPanel.js";
import { collectChanges } from "./review.js";
import { chatMarkdown, downloadText, exportFileName } from "./export.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { IconEdit, IconMenu, IconMore, IconSearch, IconSidebar } from "./icons.js";
import { applyHarnessAccents, harnessColor } from "./harness-colors.js";
import { closeTab, findTab, loadTabs, markUnread, placeChat, runningChats, saveTabs, syncActive, type Tab, type TabState } from "./tabs.js";
import { useLimits } from "./limits.js";
import { useNotifications } from "./notify.js";
import { isPaletteKey, type PaletteItem } from "./palette.js";
import { isBusy } from "./session-groups.js";
import { useSessions } from "./sessions.js";
import { useSidebarLayout } from "./sidebar-layout.js";
import { forgetWorkspace, load, rememberWorkspace, save } from "./storage.js";
import { themeModeOf, useTheme } from "./theme.js";

export function App() {
  const { banner, setBanner, fail } = useBanner();
  const { themeInfo, initTheme, setThemeMode } = useTheme();
  const [harnessId, setHarnessId] = useState<string | null>(() => load<string | null>("harness", null));
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => load<string[]>("recentWorkspaces", []));

  // A 401 on the live stream flips useBootstrap's signed-out flag (declared on
  // the next line); this closure only runs on an event, long after this render
  // finished, so the forward reference is safe.
  const { chat, setChat, conn } = useChatStream({ onSignedOut: () => setSignedOut(true) });
  const { boot, setBoot, bootError, signedOut, setSignedOut } = useBootstrap({
    onTheme: initTheme,
    setHarnessId,
    setWorkspace,
    setRecent,
    setChat,
  });
  const { overview, sessionsError, sessionsLoading, refreshSessions, markSession } = useSessions({ boot, workspace, chat });
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteKey(e)) return;
      e.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // ---- shared look: config.yml rules every device; a save applies here at once ----

  const themeMode = themeModeOf(themeInfo, boot?.ui.theme ?? null);
  const textScale = boot?.ui.textScale ?? 1;
  useEffect(() => {
    setThemeMode(themeMode);
  }, [themeMode, setThemeMode]);
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-scale", String(textScale));
  }, [textScale]);

  const available = useMemo(() => boot?.harnesses.filter((h) => h.available) ?? [], [boot]);
  useEffect(() => {
    if (boot) applyHarnessAccents(boot.harnesses);
  }, [boot]);
  const chatId = chat?.chatId ?? null;

  // ---- session tabs ---------------------------------------------------------------------

  const [tabState, setTabState] = useState<TabState>(loadTabs);
  const tabsRef = useRef(tabState);
  tabsRef.current = tabState;
  useEffect(() => saveTabs(tabState), [tabState]);
  /** Each tab's chat as last shown: switching back shows it at once, and the stream replays what it missed. */
  const tabCache = useRef(new Map<string, ChatState>());
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const rememberShown = () => {
    const { tabs, active } = tabsRef.current;
    const shown = chatRef.current;
    const tab = tabs[active];
    if (shown && tab && tab.chatId === shown.chatId) tabCache.current.set(tab.key, shown);
  };

  // Whatever chat is shown lives in a tab: adopt one that arrived another way (the URL hash),
  // and keep the shown tab's title and session in step.
  useEffect(() => {
    if (!chat) return;
    setTabState((st) => {
      const i = findTab(st, chat);
      return i < 0 ? placeChat(st, chat) : i === st.active ? syncActive(st, chat) : st;
    });
  }, [chat?.chatId, chat?.title, chat?.sessionId]);

  // Background tabs: a tab whose run ended while another was shown gets a dot.
  // Only a run counts; a harness starting up (Starting → Idle) is no news.
  const busyBefore = useRef(new Set<string>());
  useEffect(() => {
    const busyNow = runningChats(overview.sessions);
    const finished = new Set([...busyBefore.current].filter((id) => !busyNow.has(id) && id !== chatId));
    busyBefore.current = busyNow;
    setTabState((st) => markUnread(st, finished));
  }, [overview, chatId]);

  const changedFiles = useMemo(() => (chat ? collectChanges(chat.items, chat.workspace.path).length : 0), [chat?.items, chat?.workspace.path]);

  // Runs the shown chat finished: the limits meter re-reads after each.
  const [settledRuns, setSettledRuns] = useState(0);
  const shownStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = chat?.status ?? null;
    if (status === "idle" && shownStatus.current === "running") setSettledRuns((n) => n + 1);
    shownStatus.current = status;
  }, [chat?.status]);
  const limits = useLimits(Boolean(boot), settledRuns);

  const tabStatus = (tab: Tab) =>
    chat && tab.chatId === chat.chatId ? chat.status : (overview.sessions.find((x) => x.liveChatId !== undefined && x.liveChatId === tab.chatId)?.status ?? null);

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

  /** Show a chat: in its own tab when it has one, else in the shown tab, or a new tab with `newTab`. */
  const showChat = (snapshot: ChatSnapshot, { newTab = false }: { newTab?: boolean } = {}) => {
    rememberShown();
    setTabState((st) => placeChat(st, snapshot, { newTab }));
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

  const newChat = async (target: WorkspaceInfo | null = workspace, { newTab = false }: { newTab?: boolean } = {}) => {
    if (!target || !harnessId) return;
    setOpening(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      showChat(await api<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: ws.id } }), { newTab });
      void refreshSessions();
    } catch (e) {
      fail(e);
      setDrawerOpen(false);
    } finally {
      setOpening(false);
    }
  };

  /**
   * Reattach a tab to its chat, or resume its session once the server no longer
   * holds the chat (a restart, or the idle reaper). A tab with neither is dropped.
   */
  const loadTab = async (tab: Tab) => {
    setOpening(true);
    setBanner(null);
    try {
      if (tab.chatId) {
        try {
          const live = await api<ChatSnapshot>(`/api/chats/${tab.chatId}`);
          setWorkspace(live.workspace);
          showChat(live);
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      if (!tab.sessionId) {
        setTabState((st) => {
          const i = st.tabs.findIndex((t) => t.key === tab.key);
          return i < 0 ? st : closeTab(st, i);
        });
        return;
      }
      const ws = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: tab.workspacePath } });
      setWorkspace(ws);
      showChat(await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: tab.harnessId, workspaceId: ws.id, sessionId: tab.sessionId } }));
    } catch (e) {
      fail(e);
    } finally {
      setOpening(false);
    }
  };

  const activateTab = (index: number) => {
    const tab = tabsRef.current.tabs[index];
    if (!tab) return;
    if (index === tabsRef.current.active && chat?.chatId === tab.chatId) return;
    rememberShown();
    setTabState((st) => ({ active: index, tabs: st.tabs.map((t, i) => (i === index && t.unread ? { ...t, unread: undefined } : t)) }));
    const cached = tabCache.current.get(tab.key);
    if (cached && cached.chatId === tab.chatId && cached.status !== "disposed") {
      setWorkspace(cached.workspace);
      setChat(cached);
      setBanner(null);
      return;
    }
    void loadTab(tab);
  };

  const closeTabAt = (index: number) => {
    const before = tabsRef.current;
    const closing = before.tabs[index];
    if (!closing) return;
    tabCache.current.delete(closing.key);
    const after = closeTab(before, index);
    // Updated now, not at the next render: activateTab below reads it.
    tabsRef.current = after;
    setTabState(after);
    if (index !== before.active) return;
    const next = after.tabs[after.active];
    if (next) activateTab(after.active);
    else {
      setChat(null);
      setHash(null);
    }
  };

  // A shown chat the server dropped (restart, idle reaper) comes back through its tab's session.
  const resumedGone = useRef(new Set<string>());
  useEffect(() => {
    if (!chat?.gone) return;
    const tab = tabsRef.current.tabs[tabsRef.current.active];
    if (!tab || tab.chatId !== chat.chatId || !tab.sessionId || resumedGone.current.has(chat.chatId)) return;
    resumedGone.current.add(chat.chatId);
    void loadTab({ ...tab, chatId: null });
  }, [chat?.gone]);

  // On load, the shown tab reattaches unless the URL already names a chat.
  const restored = useRef(false);
  useEffect(() => {
    if (!boot || restored.current) return;
    restored.current = true;
    const tab = tabsRef.current.tabs[tabsRef.current.active];
    if (tab && !chatIdFromHash()) void loadTab(tab);
  }, [boot]);

  const openSession = async (s: ProjectSession, { newTab = false }: { newTab?: boolean } = {}) => {
    const open = findTab(tabsRef.current, { chatId: s.liveChatId ?? null, sessionId: s.id });
    if (open >= 0) {
      activateTab(open);
      setDrawerOpen(false);
      return;
    }
    const target = overview.workspaces.find((w) => w.id === s.workspaceId);
    if (!target) return;
    setOpening(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      if (s.liveChatId) showChat(await api<ChatSnapshot>(`/api/chats/${s.liveChatId}`), { newTab });
      else showChat(await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: s.harnessId, workspaceId: ws.id, sessionId: s.id } }), { newTab });
    } catch (e) {
      fail(e);
      setDrawerOpen(false);
      void refreshSessions();
    } finally {
      setOpening(false);
    }
  };

  /** A notification was clicked: show its chat, or resume its session once the server no longer holds the chat. */
  const openNote = async (note: PushNote) => {
    if (!note.chatId) return;
    const tab = findTab(tabsRef.current, { chatId: note.chatId, sessionId: note.sessionId });
    if (tab >= 0) {
      activateTab(tab);
      return;
    }
    try {
      const live = await api<ChatSnapshot>(`/api/chats/${note.chatId}`);
      setWorkspace(live.workspace);
      showChat(live, { newTab: true });
    } catch (e) {
      const session = note.sessionId ? overview.sessions.find((x) => x.id === note.sessionId) : undefined;
      if (session) void openSession(session, { newTab: true });
      else fail(e);
    }
  };
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;
  const { notify, toggleNotify, testNotify } = useNotifications(Boolean(boot), (note) => void openNoteRef.current(note));

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

  /** Continue this chat in another harness; the draft (if any) seeds its first turn. */
  const handoffChat = async (harnessId: string, draft: string): Promise<void> => {
    if (!chat) return;
    const prompt = draft.trim() ? draft : undefined;
    try {
      const next = await api<ChatSnapshot>(`/api/chats/${chat.chatId}/handoff`, { body: { harness: harnessId, ...(prompt ? { prompt } : {}) } });
      const target = boot?.harnesses.find((h) => h.id === harnessId);
      const turns = chat.items.filter((i) => i.kind === "user" && !i.command).length;
      showChat(next);
      // A harness that keeps past turns got a copy; any other was briefed in its first prompt.
      const how = target?.capabilities.supportsHandoff ? "" : ` from a summary of ${turns} ${turns === 1 ? "turn" : "turns"}`;
      setBanner({ level: "info", text: `Continued in ${target?.displayName ?? harnessId}${how} · model reset to default` });
      void refreshSessions();
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

  const markSessionAs = async (s: ProjectSession, change: MarkChange) => {
    try {
      markSession(s.id, await api<{ pinned?: true; archived?: true }>("/api/sessions/marks", { body: { sessionId: s.id, ...change } }));
    } catch (e) {
      fail(e);
    }
  };

  const exportChat = () => {
    setMenuOpen(false);
    if (!chat) return;
    const name = boot?.harnesses.find((h) => h.id === chat.harnessId)?.displayName ?? chat.harnessId;
    downloadText(exportFileName(chat.title), chatMarkdown(chat, name));
  };

  /** The shared look, as Settings saves it: config.yml's theme, for every device. */
  const chooseTheme = async (theme: ThemeChoice) => {
    try {
      const next = await api<ServerSettings>("/api/settings", { method: "PUT", body: { theme } });
      setBoot((b) => (b ? { ...b, ui: { theme: next.values.theme, textScale: next.values.textScale, autocollapseSidebar: next.values.autocollapseSidebar } } : b));
    } catch (e) {
      fail(e);
    }
  };

  const paletteItems = (): PaletteItem[] => {
    if (!boot) return [];
    const items: PaletteItem[] = [];
    const harnessName = (id: string) => boot.harnesses.find((h) => h.id === id)?.displayName ?? id;
    const busy = chat ? isBusy(chat.status) : false;
    const idle = chat ? chat.status === "idle" || chat.status === "error" : false;
    const waitIdle = idle ? undefined : "Wait until the agent is idle";
    items.push({ id: "new", section: "Actions", label: "New chat", hint: workspace?.name, disabled: newChatDisabled ?? undefined, run: () => void newChat() });
    items.push({
      id: "new-tab",
      section: "Actions",
      label: "New chat in a new tab",
      disabled: newChatDisabled ?? undefined,
      searchOnly: true,
      run: () => void newChat(workspace, { newTab: true }),
    });
    if (chat && chat.status !== "disposed") {
      if (busy) items.push({ id: "stop", section: "Actions", label: "Stop", run: stop });
      if (chat.capabilities.supportsRename) items.push({ id: "rename", section: "Actions", label: "Rename chat", run: () => setRenameOpen(true) });
      if (chat.capabilities.supportsCompact) items.push({ id: "compact", section: "Actions", label: "Compact context", disabled: chat.status === "idle" ? undefined : "Wait until the agent is idle", run: () => void compact() });
      items.push({ id: "review", section: "Actions", label: "Review changes", hint: changedFiles > 0 ? `${changedFiles} ${changedFiles === 1 ? "file" : "files"}` : undefined, disabled: changedFiles > 0 ? undefined : "No files changed yet", run: () => setReviewOpen(true) });
      items.push({ id: "export", section: "Actions", label: "Export as Markdown", disabled: hasPrompt ? undefined : "Nothing to export yet", run: exportChat });
      items.push({ id: "close", section: "Actions", label: "Close chat", run: () => void closeChat() });
    }
    items.push({ id: "folder", section: "Actions", label: "Choose project folder…", run: () => setPickerOpen(true) });
    items.push({ id: "sidebar", section: "Actions", label: collapsed ? "Show sidebar" : "Hide sidebar", searchOnly: true, run: () => collapseSidebar(!collapsed) });
    items.push({ id: "settings", section: "Actions", label: "Settings", run: () => setSettingsOpen(true) });
    items.push({ id: "pair", section: "Actions", label: "Pair a phone", searchOnly: true, run: () => setPairOpen(true) });

    // Pinned first, then newest; the eight at the top show before anything is typed.
    const sessions = [...overview.sessions.filter((x) => x.pinned), ...overview.sessions.filter((x) => !x.pinned)];
    sessions.forEach((x, i) => {
      const project = overview.workspaces.find((w) => w.id === x.workspaceId)?.name ?? "";
      items.push({
        id: `s:${x.id}`,
        section: "Sessions",
        label: x.title,
        hint: project,
        keywords: `${harnessName(x.harnessId)}${x.pinned ? " pinned" : ""}${x.archived ? " archived" : ""}`,
        searchOnly: i >= 8 || x.archived,
        current: (chat?.sessionId !== null && chat?.sessionId === x.id) || (x.liveChatId !== undefined && x.liveChatId === chat?.chatId),
        run: () => void openSession(x),
      });
    });

    if (chat && chat.status !== "disposed" && chat.capabilities.supportsModelSelection) {
      for (const m of chat.config.models) {
        items.push({ id: `m:${m.key}`, section: "Model", label: m.name, hint: m.provider, keywords: m.key, searchOnly: true, current: m.key === chat.config.model, disabled: waitIdle, run: () => void configure({ model: m.key }) });
      }
    }
    if (chat && chat.status !== "disposed" && chat.capabilities.supportsThinkingLevel) {
      for (const level of chat.config.thinkingLevels) {
        items.push({ id: `t:${level}`, section: "Thinking", label: `Thinking: ${level}`, searchOnly: true, current: level === chat.config.thinkingLevel, disabled: waitIdle, run: () => void configure({ thinkingLevel: level }) });
      }
    }
    for (const h of boot.harnesses) {
      items.push({
        id: `h:${h.id}`,
        section: "Harness",
        label: `Harness: ${h.displayName}`,
        hint: "for new chats",
        searchOnly: true,
        current: h.id === harnessId,
        disabled: h.available ? undefined : (h.reason ?? "Not available"),
        run: () => chooseHarness(h.id),
      });
    }
    const themes: Array<[ThemeChoice, string]> = [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
      ...(themeInfo?.source === "file" ? ([["base16", themeInfo.name ?? "Base16 scheme"]] as Array<[ThemeChoice, string]>) : []),
    ];
    for (const [choice, label] of themes) {
      items.push({ id: `theme:${choice}`, section: "Theme", label: `Theme: ${label}`, hint: "every device", searchOnly: true, current: choice === themeMode, run: () => void chooseTheme(choice) });
    }
    return items;
  };

  const closeChat = async () => {
    setMenuOpen(false);
    if (!chat) return;
    // Closed on purpose: the server's "gone" must not bring it back through its tab.
    resumedGone.current.add(chat.chatId);
    const index = tabsRef.current.tabs.findIndex((t) => t.chatId === chat.chatId);
    try {
      await api(`/api/chats/${chat.chatId}/dispose`, { body: {} });
    } catch {
      // already gone
    }
    if (index >= 0) closeTabAt(index);
    else {
      setChat(null);
      setHash(null);
    }
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
        footer={<LimitsMeter limits={limits} />}
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
        onOpenSession={(s, newTab) => void openSession(s, { newTab })}
        onMarkSession={(s, change) => void markSessionAs(s, change)}
        onRefresh={() => void refreshSessions()}
        onSettings={() => {
          setSettingsOpen(true);
          setDrawerOpen(false);
        }}
        onClose={() => setDrawerOpen(false)}
        onCollapse={() => collapseSidebar(true)}
      />
      {settingsOpen ? (
        <SettingsDialog
          scheme={themeInfo?.source === "file" ? { name: themeInfo.name } : null}
          onPair={() => {
            setSettingsOpen(false);
            setPairOpen(true);
          }}
          signedInAs={boot.auth.mode === "password" ? boot.auth.username : null}
          onSignOut={() => {
            void api("/api/logout", { body: {} }).finally(() => window.location.reload());
          }}
          version={boot.version}
          notify={notify}
          onToggleNotify={toggleNotify}
          onTestNotify={testNotify}
          onUiSaved={(ui) => setBoot((b) => (b ? { ...b, ui } : b))}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      <main className="main">
        {tabState.tabs.length >= (narrow ? 2 : 1) ? (
          <TabStrip
            tabs={tabState.tabs}
            active={tabState.active}
            statusOf={tabStatus}
            harnessName={(id) => boot.harnesses.find((h) => h.id === id)?.displayName ?? id}
            onActivate={activateTab}
            onClose={closeTabAt}
            onNew={() => void newChat(workspace, { newTab: true })}
            newDisabled={newChatDisabled !== null}
          />
        ) : null}
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
                <span className="badge badge-harness" style={harnessColor(chat.harnessId)}>
                  {chatHarness?.displayName ?? chat.harnessId}
                </span>
                <span className={`status status-${chat.status}`} data-testid="chat-status">
                  {STATUS_LABEL[chat.status] ?? chat.status}
                </span>
                <span className="chat-path" title={chat.workspace.path}>
                  {chat.workspace.name}
                </span>
              </div>
            ) : null}
          </div>
          {chat && changedFiles > 0 ? (
            <button type="button" className="btn btn-small review-open" title="Review the changes and comment on them" onClick={() => setReviewOpen(true)}>
              <IconEdit size={14} /> <span className="review-label">Review</span> <span className="review-count">{changedFiles}</span>
            </button>
          ) : null}
          <button type="button" className="icon-btn palette-open" aria-label="Commands" title="Commands (Ctrl+K)" onClick={() => setPaletteOpen(true)}>
            <IconSearch size={16} />
          </button>
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
                      <button type="button" role="menuitem" disabled={!hasPrompt} onClick={exportChat}>
                        Export as Markdown
                      </button>
                    </li>
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
                harnesses={boot.harnesses}
                maxChars={boot.limits.maxMessageChars}
                placeholder={`Ask ${chatHarness?.displayName ?? "the agent"} to…`}
                onSend={send}
                onRefreshModels={refreshModels}
                onStop={stop}
                onAnswer={answer}
                onConfig={configure}
                onHandoff={(id, draft) => handoffChat(id, draft)}
              />
            </div>
          </div>
        ) : chat ? (
          <>
            <Conversation chatId={chat.chatId} items={chat.items} status={chat.status} workspace={chat.workspace.path} canFork={chat.capabilities.supportsFork} onFork={forkChat} />
            {chat.gone ? <div className="banner banner-info">{chat.gone}</div> : null}
            <Composer
              key={chat.chatId}
              chat={chat}
              harnesses={boot.harnesses}
              maxChars={boot.limits.maxMessageChars}
              onSend={send}
              onRefreshModels={refreshModels}
              onStop={stop}
              onAnswer={answer}
              onConfig={configure}
              onHandoff={(id, draft) => handoffChat(id, draft)}
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
      {reviewOpen && chat ? (
        <ReviewPanel
          key={chat.chatId}
          chatId={chat.chatId}
          items={chat.items}
          workspace={chat.workspace.path}
          sendLabel={chat.status === "idle" || chat.status === "error" ? "Send to the agent" : "Send as follow-up"}
          sendBlocked={
            chat.status === "disposed"
              ? "This chat is closed"
              : chat.status === "idle" || chat.status === "error" || chat.capabilities.supportsFollowUp
                ? null
                : "Wait until the agent is idle"
          }
          onSend={(prompt) => send(prompt, chat.status === "idle" || chat.status === "error" ? "normal" : "followUp")}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
      {paletteOpen ? <CommandPalette items={paletteItems()} onClose={() => setPaletteOpen(false)} /> : null}
      {pairOpen ? <PairDialog urls={boot.pairing.urls} username={boot.auth.username} onClose={() => setPairOpen(false)} /> : null}
    </div>
  );
}
