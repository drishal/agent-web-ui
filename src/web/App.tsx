import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionMarkState,
  ChatSnapshot,
  CheckpointPreview,
  CheckpointRestored,
  ImageAttachment,
  InteractionAnswer,
  ProjectSession,
  PushNote,
  SendMode,
  ServerSettings,
  ThemeChoice,
  UserItem,
  WorkspaceInfo,
} from "../shared/protocol.js";
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
import { SwitchSplash, type SplashTarget } from "./components/SwitchSplash.js";
import { ProjectSearch } from "./components/ProjectSearch.js";
import { useEdgeSwipe } from "./gestures.js";
import { useLaunchActions } from "./launch.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { PairDialog, RenameDialog } from "./dialogs.js";
import { ReviewPanel } from "./components/ReviewPanel.js";
import { RestoreDialog } from "./components/RestoreDialog.js";
import { collectChanges } from "./review.js";
import { chatMarkdown, downloadText, exportFileName } from "./export.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { IconEdit, IconMenu, IconMore, IconSearch, IconSidebar } from "./icons.js";
import { applyHarnessAccents, harnessColor } from "./harness-colors.js";
import { closeTab, findTab, loadTabs, markUnread, placeChat, placeTab, runningChats, saveTabs, syncActive, type Tab, type TabState } from "./tabs.js";
import { useLimits } from "./limits.js";
import { useNotifications } from "./notify.js";
import { isPaletteKey, type PaletteItem } from "./palette.js";
import { isBusy, wakeLabel } from "./session-groups.js";
import { sentAttachments } from "./images.js";
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
  /** What the window-wide shortcuts call, kept current (the listener is added once). */
  const keysRef = useRef<{ step: (step: -1 | 1) => void; reopen: () => void; undo: (() => void) | null; search: () => void }>({ step: () => {}, reopen: () => {}, undo: null, search: () => {} });
  const [searchOpen, setSearchOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** The turn whose checkpoint the restore dialog shows. */
  const [restoreTurn, setRestoreTurn] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteKey(e)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (mod && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        keysRef.current.step(e.code === "BracketLeft" ? -1 : 1);
      } else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
        e.preventDefault();
        keysRef.current.reopen();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyF") {
        e.preventDefault();
        keysRef.current.search();
      } else if (mod && e.code === "KeyZ" && keysRef.current.undo) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
        keysRef.current.undo();
      }
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

  // ---- opening a chat at once -----------------------------------------------------------

  // A click on a session answers in the same frame: its tab, title, and a loading
  // screen show while the snapshot comes, and the screen fades once the chat has drawn.
  // Each open takes a number, so a slow earlier one landing after a later click is dropped.
  const nav = useRef(0);
  const [splash, setSplash] = useState<{ target: SplashTarget; leaving: boolean } | null>(null);
  const splashFor = (tab: Pick<Tab, "title" | "harnessId" | "workspacePath">): SplashTarget => ({
    title: tab.title || "Chat",
    harnessId: tab.harnessId,
    harnessName: boot?.harnesses.find((h) => h.id === tab.harnessId)?.displayName ?? tab.harnessId,
    project: tab.harnessId === "awui" ? null : (tab.workspacePath.split("/").filter(Boolean).pop() ?? null),
  });
  /** Start an open: later ones win. With a target, its loading screen shows until showChat. */
  const beginOpen = (target: SplashTarget | null): number => {
    nav.current += 1;
    setSplash(target ? { target, leaving: false } : null);
    return nav.current;
  };
  useEffect(() => {
    if (!splash?.leaving) return;
    const t = window.setTimeout(() => setSplash(null), 260);
    return () => window.clearTimeout(t);
  }, [splash]);

  /** What opening a session needs: its project (registered with the server again if need be) and its chat, live or resumed from the file. */
  const fetchSession = async (s: ProjectSession, target: WorkspaceInfo): Promise<{ ws: WorkspaceInfo; snapshot: ChatSnapshot }> => {
    const ws = target.id === workspace?.id ? Promise.resolve(target) : api<WorkspaceInfo>("/api/workspaces/open", { body: { path: target.path } });
    if (s.liveChatId) {
      const [opened, snapshot] = await Promise.all([ws, api<ChatSnapshot>(`/api/chats/${s.liveChatId}`)]);
      return { ws: opened, snapshot };
    }
    const opened = await ws;
    return { ws: opened, snapshot: await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: s.harnessId, workspaceId: opened.id, sessionId: s.id } }) };
  };

  /**
   * Opens started before the click: on a mouse press (the click lands ~100 ms
   * later), and on hover for a live chat, whose read has no side effects. A
   * resume starts the harness, so it waits for a press. Used once, or dropped.
   */
  const early = useRef(new Map<string, { at: number; result: ReturnType<typeof fetchSession> }>());
  const EARLY_MS = 10_000;
  const warmSession = (s: ProjectSession, why: "hover" | "press") => {
    if (why === "hover" && !s.liveChatId) return;
    if (findTab(tabsRef.current, { chatId: s.liveChatId ?? null, sessionId: s.id }) >= 0) return;
    const known = early.current.get(s.id);
    if (known && Date.now() - known.at < EARLY_MS) return;
    const target = overview.workspaces.find((w) => w.id === s.workspaceId);
    if (!target) return;
    const result = fetchSession(s, target);
    // The click reports a failure; one nobody clicks is dropped quietly.
    result.catch(() => undefined);
    early.current.set(s.id, { at: Date.now(), result });
  };
  const takeEarly = (s: ProjectSession) => {
    const known = early.current.get(s.id);
    early.current.delete(s.id);
    return known && Date.now() - known.at < EARLY_MS ? known.result : null;
  };

  // ---- actions -------------------------------------------------------------------------

  const chooseHarness = (id: string) => {
    setHarnessId(id);
    save("harness", id);
    // The Awui harness has no projects; putting it on the home workspace keeps its
    // flat history from filtering to nothing under whatever coding workspace was last.
    if (id === "awui" && workspace?.path !== boot?.home) {
      void api<WorkspaceInfo>("/api/workspaces/open", { body: { path: boot?.home ?? "/" } }).then(setWorkspace).catch(() => undefined);
    }
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
  /** `keepDrawer`: a tab reattaching (on load, or switched to) leaves the drawer as it is; picking a chat closes it. */
  const showChat = (snapshot: ChatSnapshot, { newTab = false, keepDrawer = false }: { newTab?: boolean; keepDrawer?: boolean } = {}) => {
    rememberShown();
    setTabState((st) => placeChat(st, snapshot, { newTab }));
    setChat(snapshot);
    setBanner(null);
    setSplash((sp) => (sp ? { ...sp, leaving: true } : sp));
    if (!keepDrawer) setDrawerOpen(false);
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
    // The Awui harness's history is global; a new chat belongs on the home workspace, not wherever a coding chat left the picker.
    if (harnessId === "awui" && boot && target?.path !== boot.home) {
      target = boot.home ? ({ id: "__home", path: boot.home, name: "home" } as WorkspaceInfo) : target;
    }
    if (!target || !harnessId) return;
    const token = beginOpen(null);
    setOpening(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      const snapshot = await api<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: ws.id } });
      if (token !== nav.current) return;
      showChat(snapshot, { newTab });
      void refreshSessions();
    } catch (e) {
      if (token !== nav.current) return;
      fail(e);
      setDrawerOpen(false);
    } finally {
      setOpening(false);
    }
  };

  // The installed app's shortcuts and shares (?new, ?sessions, ?share), and phones' swipe for the drawer.
  useLaunchActions({ booted: Boolean(boot), ready: Boolean(boot && workspace && harnessId), newChat: () => newChat(), openSessions: () => setDrawerOpen(true) });
  useEdgeSwipe(drawerOpen, setDrawerOpen);

  /**
   * Reattach a tab to its chat, or resume its session once the server no longer
   * holds the chat (a restart, or the idle reaper). A tab with neither is dropped.
   */
  const loadTab = async (tab: Tab) => {
    const token = beginOpen(splashFor(tab));
    setOpening(true);
    setBanner(null);
    try {
      if (tab.chatId) {
        try {
          const live = await api<ChatSnapshot>(`/api/chats/${tab.chatId}`);
          if (token !== nav.current) return;
          setWorkspace(live.workspace);
          showChat(live, { keepDrawer: true });
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      if (token !== nav.current) return;
      if (!tab.sessionId) {
        setSplash(null);
        setTabState((st) => {
          const i = st.tabs.findIndex((t) => t.key === tab.key);
          return i < 0 ? st : closeTab(st, i);
        });
        return;
      }
      const ws = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: tab.workspacePath } });
      const snapshot = await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: tab.harnessId, workspaceId: ws.id, sessionId: tab.sessionId } });
      if (token !== nav.current) return;
      setWorkspace(ws);
      showChat(snapshot, { keepDrawer: true });
    } catch (e) {
      if (token !== nav.current) return;
      setSplash(null);
      fail(e);
    } finally {
      if (token === nav.current) setOpening(false);
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
      beginOpen(null);
      setOpening(false);
      setWorkspace(cached.workspace);
      setChat(cached);
      setBanner(null);
      return;
    }
    void loadTab(tab);
  };

  /** Closed tabs, newest last, for Alt+Shift+T (the browser keeps Ctrl+Shift+T). */
  const closedTabs = useRef<Tab[]>([]);
  const reopenClosedTab = () => {
    const tab = closedTabs.current.pop();
    if (!tab) return;
    const open = findTab(tabsRef.current, tab);
    if (open >= 0) {
      activateTab(open);
      return;
    }
    rememberShown();
    const at = tabsRef.current.active + 1;
    const next = { tabs: [...tabsRef.current.tabs.slice(0, at), tab, ...tabsRef.current.tabs.slice(at)], active: at };
    tabsRef.current = next;
    setTabState(next);
    void loadTab(tab);
  };

  const closeTabAt = (index: number) => {
    const before = tabsRef.current;
    const closing = before.tabs[index];
    if (!closing) return;
    if (closing.chatId || closing.sessionId) closedTabs.current = [...closedTabs.current.filter((t) => t.key !== closing.key), closing].slice(-10);
    tabCache.current.delete(closing.key);
    const after = closeTab(before, index);
    // Updated now, not at the next render: activateTab below reads it.
    tabsRef.current = after;
    setTabState(after);
    if (index !== before.active) return;
    const next = after.tabs[after.active];
    if (next) activateTab(after.active);
    else {
      beginOpen(null);
      setChat(null);
      setHash(null);
    }
  };

  // Back and forward through the chats shown (Ctrl+[ and Ctrl+], as in an editor).
  const visits = useRef<{ list: Tab[]; at: number; moving: boolean }>({ list: [], at: -1, moving: false });
  useEffect(() => {
    if (!chat) return;
    const v = visits.current;
    const here = v.list[v.at];
    if (here && (here.chatId === chat.chatId || (chat.sessionId !== null && here.sessionId === chat.sessionId))) return;
    if (v.moving) {
      v.moving = false;
      return;
    }
    const tab = tabsRef.current.tabs[tabsRef.current.active];
    const entry: Tab = tab && tab.chatId === chat.chatId ? tab : { key: `v${Date.now()}`, chatId: chat.chatId, sessionId: chat.sessionId, harnessId: chat.harnessId, workspacePath: chat.workspace.path, title: chat.title };
    v.list = [...v.list.slice(0, v.at + 1), entry].slice(-50);
    v.at = v.list.length - 1;
  }, [chat?.chatId]);
  const stepVisits = (step: -1 | 1) => {
    const v = visits.current;
    const target = v.list[v.at + step];
    if (!target) return;
    v.at += step;
    v.moving = true;
    const open = findTab(tabsRef.current, target);
    if (open >= 0) activateTab(open);
    else {
      const shown = tabsRef.current.tabs[tabsRef.current.active];
      void loadTab({ ...target, key: shown?.key ?? target.key });
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
    // Its tab and loading screen first; the snapshot fills the same tab in.
    const tab = { chatId: s.liveChatId ?? null, sessionId: s.id, harnessId: s.harnessId, workspacePath: target.path, title: s.title };
    const token = beginOpen(splashFor(tab));
    rememberShown();
    const before = tabsRef.current;
    const placed = placeTab(before, tab, { newTab });
    tabsRef.current = placed;
    setTabState(placed);
    setDrawerOpen(false);
    setOpening(true);
    setBanner(null);
    try {
      const { ws, snapshot } = await (takeEarly(s) ?? fetchSession(s, target));
      if (token !== nav.current) return;
      if (ws.id !== workspace?.id) {
        setWorkspace(ws);
        setRecent(rememberWorkspace(ws.path));
      }
      showChat(snapshot);
    } catch (e) {
      if (token !== nav.current) return;
      setSplash(null);
      // The tab goes back to what it showed.
      if (tabsRef.current === placed) {
        tabsRef.current = before;
        setTabState(before);
      }
      fail(e);
      void refreshSessions();
    } finally {
      if (token === nav.current) setOpening(false);
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
    const token = beginOpen(null);
    try {
      const live = await api<ChatSnapshot>(`/api/chats/${note.chatId}`);
      if (token !== nav.current) return;
      setWorkspace(live.workspace);
      showChat(live, { newTab: true });
    } catch (e) {
      if (token !== nav.current) return;
      const session = note.sessionId ? overview.sessions.find((x) => x.id === note.sessionId) : undefined;
      if (session) void openSession(session, { newTab: true });
      else fail(e);
    }
  };
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;
  const { notify, toggleNotify, testNotify } = useNotifications(Boolean(boot), (note) => void openNoteRef.current(note));

  const send = async (text: string, mode: SendMode, images: ImageAttachment[] = [], options: { compactFirst?: boolean; attachments?: string[] } = {}): Promise<boolean> => {
    if (!chat) return false;
    const command = mode === "normal" && images.length === 0 && (options.attachments?.length ?? 0) === 0 ? appCommand(text) : null;
    if (command) return runAppCommand(command.name, command.arg);
    try {
      await api(`/api/chats/${chat.chatId}/messages`, {
        body: {
          text,
          mode,
          ...(images.length > 0 ? { images } : {}),
          ...(options.attachments && options.attachments.length > 0 ? { attachments: options.attachments.map((id) => ({ id })) } : {}),
          ...(options.compactFirst ? { compactFirst: true } : {}),
        },
      });
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

  /** Put files back as they were before turn `through`; the banner offers to put them back again. */
  const restoreFiles = async (through: number, paths: string[], alsoFork: boolean): Promise<void> => {
    if (!chat) return;
    const chatId = chat.chatId;
    try {
      const done = await api<CheckpointRestored>(`/api/chats/${chatId}/checkpoints/${through}/restore`, { body: { paths } });
      setRestoreTurn(null);
      const n = done.files.length;
      const putBack = async () => {
        try {
          await api<CheckpointRestored>(`/api/chats/${chatId}/checkpoints/put-back`, { body: { tree: done.undo, paths: done.files.map((f) => f.path) } });
          setBanner({ level: "info", text: `Put ${n} ${n === 1 ? "file" : "files"} back as they were` });
        } catch (e) {
          fail(e);
        }
      };
      if (alsoFork) await forkChat(through - 1);
      setBanner({
        level: "info",
        text: `Undid changes to ${n} ${n === 1 ? "file" : "files"} from turn ${through} on${alsoFork ? ", and forked the chat before it" : ". The agent was not told"}`,
        action: { label: "Put back", run: () => void putBack() },
      });
    } catch (e) {
      setRestoreTurn(null);
      fail(e);
    }
  };

  /**
   * Retry or edit prompt `through`: replaced in place where the harness can
   * (Hermes), else run in a branch from before it (a fork; a fresh chat for
   * the first prompt), keeping the model. `undoFiles` first puts the files
   * back as they were before that prompt.
   */
  const rerun = async (through: number, item: UserItem, text: string, undoFiles: boolean): Promise<boolean> => {
    if (!chat) return false;
    const from = chat;
    try {
      if (undoFiles && from.checkpoints.includes(through)) {
        const preview = await api<CheckpointPreview>(`/api/chats/${from.chatId}/checkpoints/${through}`);
        if (preview.files.length > 0) await api(`/api/chats/${from.chatId}/checkpoints/${through}/restore`, { body: { paths: preview.files.map((f) => f.path) } });
      }
      const images = item.images?.length ? await sentAttachments(item.images) : [];
      const withImages = images.length > 0 ? { images } : {};
      if (from.capabilities.supportsRewind) {
        await api(`/api/chats/${from.chatId}/rewind`, { body: { turn: through, text, ...withImages } });
        setBanner(undoFiles ? { level: "info", text: `Undid the file changes from message ${through} on` } : null);
        return true;
      }
      const next =
        through > 1
          ? await api<ChatSnapshot>(`/api/chats/${from.chatId}/fork`, { body: { through: through - 1 } })
          : await api<ChatSnapshot>("/api/chats", { body: { harnessId: from.harnessId, workspaceId: from.workspace.id } });
      const patch: { model?: string; thinkingLevel?: string } = {};
      if (from.capabilities.supportsModelSelection && from.config.model && next.config.model !== from.config.model && next.config.models.some((m) => m.key === from.config.model)) {
        patch.model = from.config.model;
      }
      if (from.capabilities.supportsThinkingLevel && from.config.thinkingLevel && next.config.thinkingLevel !== from.config.thinkingLevel) {
        patch.thinkingLevel = from.config.thinkingLevel;
      }
      if (patch.model || patch.thinkingLevel) await api(`/api/chats/${next.chatId}/config`, { method: "PATCH", body: patch }).catch(() => undefined);
      showChat(next);
      await api(`/api/chats/${next.chatId}/messages`, { body: { text, mode: "normal", ...withImages } });
      setBanner({
        level: "info",
        text: `Branched from before message ${through}${undoFiles ? ", with its file changes undone" : ""}; the original chat is still in the sidebar`,
      });
      void refreshSessions();
      return true;
    } catch (e) {
      fail(e);
      return false;
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

  /** The last mark change, for its toast's Undo (and Ctrl+Z) while the toast shows. */
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  const toastTimer = useRef(0);
  const showToast = (text: string, undo: () => void) => {
    window.clearTimeout(toastTimer.current);
    setToast({ text, undo });
    toastTimer.current = window.setTimeout(() => setToast(null), 8000);
  };

  const searchWorkspace = chat?.workspace ?? workspace;
  keysRef.current = { step: (step) => stepVisits(step), reopen: () => reopenClosedTab(), undo: toast ? toast.undo : null, search: () => searchWorkspace && setSearchOpen(true) };

  const markSessionAs = async (s: ProjectSession, change: MarkChange) => {
    const before: SessionMarkState = {
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.archived ? { archived: true } : {}),
      ...(s.settled ? { settled: true } : {}),
      ...(s.snoozedUntil ? { snoozedUntil: s.snoozedUntil } : {}),
    };
    try {
      markSession(s.id, await api<SessionMarkState>("/api/sessions/marks", { body: { sessionId: s.id, ...change } }));
      showToast(markToast(change, s.title), () => {
        setToast(null);
        void api<SessionMarkState>("/api/sessions/marks", { body: { sessionId: s.id, ...before, replace: true } }).then(
          (mark) => markSession(s.id, mark),
          (e: unknown) => fail(e),
        );
      });
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
    items.push({
      id: "search",
      section: "Actions",
      label: "Search in project",
      hint: "Ctrl+Shift+F",
      disabled: searchWorkspace ? undefined : "Choose a project first",
      run: () => setSearchOpen(true),
    });
    items.push({ id: "folder", section: "Actions", label: "Choose project folder…", run: () => setPickerOpen(true) });
    items.push({ id: "reopen", section: "Actions", label: "Reopen closed tab", hint: "Alt+Shift+T", disabled: closedTabs.current.length ? undefined : "No tab closed yet", searchOnly: true, run: reopenClosedTab });
    items.push({ id: "back", section: "Actions", label: "Back to the previous chat", hint: "Ctrl+[", searchOnly: true, disabled: visits.current.at > 0 ? undefined : "Nothing before this", run: () => stepVisits(-1) });
    items.push({ id: "forward", section: "Actions", label: "Forward to the next chat", hint: "Ctrl+]", searchOnly: true, disabled: visits.current.at < visits.current.list.length - 1 ? undefined : "Nothing after this", run: () => stepVisits(1) });
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
  /** The chat being opened names the header until it is shown. */
  const heading = splash && !splash.leaving ? splash.target : null;

  return (
    <div
      className={`app${collapsed ? " is-collapsed" : ""}${sidebarToggling ? " is-toggling" : ""}`}
      style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
    >
      <Sidebar
        resizer={<SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} onCommit={commitSidebarWidth} />}
        footer={<LimitsMeter limits={limits} />}
        tabs={
          tabState.tabs.length >= 2 ? (
            <nav className="drawer-tabs" aria-label="Open tabs">
              <p className="drawer-tabs-head">Open tabs</p>
              <ul>
                {tabState.tabs.map((tab, i) => (
                  <li key={tab.key} className={i === tabState.active ? "is-active" : undefined}>
                    <button
                      type="button"
                      className="drawer-tab"
                      aria-current={i === tabState.active ? "page" : undefined}
                      onClick={() => {
                        activateTab(i);
                        setDrawerOpen(false);
                      }}
                    >
                      <span className="drawer-tab-title">{tab.title || "New chat"}</span>
                      <span className="drawer-tab-harness">{boot.harnesses.find((h) => h.id === tab.harnessId)?.displayName ?? tab.harnessId}</span>
                    </button>
                    <button type="button" className="icon-btn drawer-tab-close" aria-label={`Close tab ${tab.title || "New chat"}`} onClick={() => closeTabAt(i)}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null
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
        // While a chat opens, its row is the current one already (its tab is in place).
        activeSessionId={heading ? (tabState.tabs[tabState.active]?.sessionId ?? null) : (chat?.sessionId ?? null)}
        activeChatId={heading ? (tabState.tabs[tabState.active]?.chatId ?? null) : chatId}
        activeStatus={heading ? null : (chat?.status ?? null)}
        onOpenSession={(s, newTab) => void openSession(s, { newTab })}
        onWarmSession={warmSession}
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
            {heading ? (
              <>
                <h1>{heading.title}</h1>
                <div className="chat-sub">
                  <span className="badge badge-harness" style={harnessColor(heading.harnessId)}>
                    {heading.harnessName}
                  </span>
                  <span className="status status-starting">Opening</span>
                  {heading.project ? <span className="chat-path">{heading.project}</span> : null}
                </div>
              </>
            ) : (
              <>
                <h1>{chat ? chat.title || "New chat" : harnessId === "awui" ? "awui" : workspace ? workspace.name : "awui"}</h1>
                {chat ? (
                  <div className="chat-sub">
                    <span className="badge badge-harness" style={harnessColor(chat.harnessId)}>
                      {chatHarness?.displayName ?? chat.harnessId}
                    </span>
                    <span className={`status status-${chat.status}`} data-testid="chat-status">
                      {STATUS_LABEL[chat.status] ?? chat.status}
                    </span>
                    {chat.harnessId !== "awui" ? (
                      <span className="chat-path" title={chat.workspace.path}>
                        {chat.workspace.name}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
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
                    <li role="none" className="menu-phone-only">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setPaletteOpen(true);
                        }}
                      >
                        Search and commands
                      </button>
                    </li>
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
            {banner.action ? (
              <button type="button" className="btn btn-small banner-action" onClick={banner.action.run}>
                {banner.action.label}
              </button>
            ) : null}
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setBanner(null)}>
              ✕
            </button>
          </div>
        ) : null}

        <div className="chat-body">
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
                  {chat.harnessId === "awui" ? (
                    <>Ask anything</>
                  ) : (
                    <>
                      What should {chatHarness?.displayName ?? "the agent"} do in <span className="hero-project">{chat.workspace.name}</span>?
                    </>
                  )}
                </h2>
                <p className="hero-sub muted">{chat.harnessId === "awui" ? "It reads, searches, and computes — it never edits your files." : "It runs with its normal tools, as you, in this folder."}</p>
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
                  onNewChat={() => void newChat(chat.workspace, { newTab: true })}
                />
              </div>
            </div>
          ) : chat ? (
            <>
              <Conversation
                chatId={chat.chatId}
                items={chat.items}
                status={chat.status}
                workspace={chat.workspace.path}
                canFork={chat.capabilities.supportsFork}
                onFork={forkChat}
                models={chat.config.models}
                checkpoints={chat.checkpoints ?? []}
                onRestore={setRestoreTurn}
                onSend={(text) => void send(text, "normal")}
                asking={chat.pending.length > 0}
                promptActions={{
                  inPlace: chat.capabilities.supportsRewind,
                  retry: (through, item) => void rerun(through, item, item.text, false),
                  edit: (through, item, text, undoFiles) => rerun(through, item, text, undoFiles),
                }}
              />
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
                onNewChat={() => void newChat(chat.workspace, { newTab: true })}
              />
            </>
          ) : (
            <div className="empty empty-main">
              {!workspace && harnessId !== "awui" ? (
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
                  <h2>{harnessId === "awui" ? "Awui" : workspace?.name}</h2>
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
          {splash ? <SwitchSplash target={splash.target} leaving={splash.leaving} /> : null}
        </div>
      </main>
      {toast ? (
        <div className="toast" role="status" data-testid="toast">
          <span>{toast.text}</span>
          <button type="button" className="btn btn-small btn-ghost" onClick={toast.undo}>
            Undo <kbd>Ctrl+Z</kbd>
          </button>
        </div>
      ) : null}
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
      {restoreTurn !== null && chat ? (
        <RestoreDialog
          chatId={chat.chatId}
          through={restoreTurn}
          canFork={chat.capabilities.supportsFork}
          onRestore={(paths, alsoFork) => restoreFiles(restoreTurn, paths, alsoFork)}
          onClose={() => setRestoreTurn(null)}
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
      {searchOpen && searchWorkspace ? <ProjectSearch workspace={searchWorkspace} onClose={() => setSearchOpen(false)} /> : null}
      {pairOpen ? <PairDialog urls={boot.pairing.urls} username={boot.auth.username} onClose={() => setPairOpen(false)} /> : null}
    </div>
  );
}

/** What a mark change did, for its toast. */
function markToast(change: MarkChange, title: string): string {
  const name = `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`;
  if (change.pinned !== undefined) return `${change.pinned ? "Pinned" : "Unpinned"} ${name}`;
  if (change.archived !== undefined) return `${change.archived ? "Archived" : "Unarchived"} ${name}`;
  if (change.settled !== undefined) return `${change.settled ? "Settled" : "Unsettled"} ${name}`;
  if (change.snoozedUntil) return `Snoozed ${name} until ${wakeLabel(change.snoozedUntil)}`;
  return `Woke ${name}`;
}

