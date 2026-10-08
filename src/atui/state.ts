// atui's state and actions: the same things the web App holds and does
// (bootstrap, the session list, the shown chat and its event stream, limits,
// git), as Solid signals, talking to the server through client.ts.
import { batch, createEffect, createMemo, createSignal, on } from "solid-js";
import type {
  Bootstrap,
  ChatEvent,
  ChatSnapshot,
  GitStatus,
  InteractionAnswer,
  ProjectSession,
  SendMode,
  SessionsOverview,
  ThemeInfo,
  UsageLimits,
  WorkspaceInfo,
} from "../shared/protocol.js";
import { applyEvents, type ChatState } from "../web/chat-state.js";
import { appCommand } from "../web/commands.js";
import { isBusy } from "../web/session-groups.js";
import { followChat, Server, ServerError, type Connection } from "./client.js";
import { themeFrom, type Theme } from "./theme.js";

export interface AtuiOptions {
  cwd: string;
  harness?: string;
  /** Attach to a live chat. */
  chatId?: string;
  /** Resume a session: its id, or true for the project's newest one in the harness. */
  resume?: string | true;
}

export type Banner = { level: "info" | "warning" | "error"; text: string } | null;

const SESSIONS_MS = 4000;
const LIMITS_MS = 5 * 60_000;
const GIT_WORKING_MS = 8000;

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAtui(server: Server, opts: AtuiOptions) {
  const [boot, setBoot] = createSignal<Bootstrap | null>(null);
  const [theme, setTheme] = createSignal<Theme>(themeFrom(null));
  const [harnessId, setHarnessId] = createSignal<string | null>(null);
  const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
  const [overview, setOverview] = createSignal<SessionsOverview>({ workspaces: [], sessions: [], errors: [] });
  const [chat, setChat] = createSignal<ChatState | null>(null);
  const [conn, setConn] = createSignal<Connection | "idle">("idle");
  const [limits, setLimits] = createSignal<UsageLimits | null>(null);
  const [git, setGit] = createSignal<GitStatus | null>(null);
  const [banner, setBanner] = createSignal<Banner>(null);
  const [opening, setOpening] = createSignal(false);

  const fail = (error: unknown) => setBanner({ level: "error", text: message(error) });
  const harness = createMemo(() => boot()?.harnesses.find((h) => h.id === (chat()?.harnessId ?? harnessId())) ?? null);
  const busy = createMemo(() => isBusy(chat()?.status));

  // ---- the shown chat's stream: events coalesced into one update per frame --------------

  let stopStream: (() => void) | null = null;
  let queued: ChatEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const show = (snapshot: ChatSnapshot) => {
    stopStream?.();
    queued = [];
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    batch(() => {
      setChat(snapshot);
      setWorkspace(snapshot.workspace);
      setGit(null);
      setBanner(null);
    });
    const chatId = snapshot.chatId;
    stopStream = followChat(server, chatId, snapshot.lastEventId, {
      onEvent: (event) => {
        queued.push(event);
        flushTimer ??= setTimeout(() => {
          flushTimer = null;
          const events = queued;
          queued = [];
          setChat((prev) => (prev && prev.chatId === chatId ? applyEvents(prev, events) : prev));
        }, 16);
      },
      onState: setConn,
      onGone: (status) => {
        setChat((prev) => (prev && prev.chatId === chatId ? { ...prev, status: "disposed", gone: status === 401 ? "Sign-in needed" : "This chat was closed" } : prev));
      },
    });
    void refreshGit();
  };

  // ---- loading --------------------------------------------------------------------------

  const refreshSessions = async () => {
    try {
      const ws = workspace();
      setOverview(await server.call<SessionsOverview>(`/api/sessions${ws ? `?path=${encodeURIComponent(ws.path)}` : ""}`));
    } catch {
      // keep the last list
    }
  };

  const refreshLimits = async () => {
    try {
      setLimits(await server.call<UsageLimits>("/api/limits"));
    } catch {
      // the panel keeps what it had
    }
  };

  const refreshGit = async () => {
    const c = chat();
    if (!c) return setGit(null);
    try {
      const res = await server.call<{ status: GitStatus | null }>(`/api/chats/${c.chatId}/git`);
      if (chat()?.chatId === c.chatId) setGit(res.status);
    } catch {
      // keep what is shown
    }
  };

  const timers: Array<ReturnType<typeof setInterval>> = [];

  const init = async () => {
    const b = await server.call<Bootstrap>("/api/bootstrap");
    const t = await server.call<ThemeInfo>("/api/theme").catch(() => null);
    batch(() => {
      setBoot(b);
      setTheme(themeFrom(t));
    });
    const wanted = opts.harness ? b.harnesses.find((h) => h.id === opts.harness || h.displayName.toLowerCase() === opts.harness?.toLowerCase()) : undefined;
    if (opts.harness && !wanted) throw new Error(`No harness "${opts.harness}"; known: ${b.harnesses.map((h) => h.id).join(", ")}`);
    const pick = wanted ?? b.harnesses.find((h) => h.available);
    if (pick) setHarnessId(pick.id);
    try {
      setWorkspace(await server.call<WorkspaceInfo>("/api/workspaces/open", { body: { path: opts.cwd } }));
    } catch (error) {
      setBanner({ level: "warning", text: `${message(error)}: pick a session from the list, or start atui in a project folder` });
    }
    await refreshSessions();
    if (opts.chatId) show(await server.call<ChatSnapshot>(`/api/chats/${encodeURIComponent(opts.chatId)}`));
    else if (opts.resume) {
      const ws = workspace();
      const target =
        opts.resume === true
          ? overview().sessions.find((s) => s.harnessId === harnessId() && s.workspaceId === ws?.id)
          : overview().sessions.find((s) => s.id === opts.resume || s.id.endsWith(`:${opts.resume}`));
      if (!target) throw new Error(opts.resume === true ? "No session to resume in this project" : `No session "${opts.resume}"`);
      await openSession(target);
    }
    void refreshLimits();
    timers.push(
      setInterval(() => void refreshSessions(), SESSIONS_MS),
      setInterval(() => void refreshLimits(), LIMITS_MS),
      setInterval(() => {
        if (busy()) void refreshGit();
      }, GIT_WORKING_MS),
    );
  };

  // The list follows the shown chat: a run starting or settling, a new title, a session id.
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => {
        const c = chat();
        return c ? `${c.chatId}:${isBusy(c.status)}:${c.title}:${c.sessionId}` : "";
      },
      (key) => {
        if (!key) return;
        clearTimeout(listTimer);
        listTimer = setTimeout(() => void refreshSessions(), 400);
      },
    ),
  );

  // ---- actions ----------------------------------------------------------------------------

  const enterWorkspace = async (ws: WorkspaceInfo): Promise<WorkspaceInfo> => {
    if (ws.id === workspace()?.id) return ws;
    const opened = await server.call<WorkspaceInfo>("/api/workspaces/open", { body: { path: ws.path } });
    setWorkspace(opened);
    return opened;
  };

  const openSession = async (s: ProjectSession) => {
    const target = overview().workspaces.find((w) => w.id === s.workspaceId);
    setOpening(true);
    try {
      if (s.liveChatId) {
        show(await server.call<ChatSnapshot>(`/api/chats/${s.liveChatId}`));
      } else {
        if (!target) throw new Error("That session's project is not open on the server");
        const ws = await enterWorkspace(target);
        show(await server.call<ChatSnapshot>("/api/chats/resume", { body: { harnessId: s.harnessId, workspaceId: ws.id, sessionId: s.id } }));
      }
      void refreshSessions();
    } catch (error) {
      fail(error);
    } finally {
      setOpening(false);
    }
  };

  /** A new chat starts empty on screen; the server's chat is made on the first message. */
  const newChat = () => {
    stopStream?.();
    stopStream = null;
    batch(() => {
      setChat(null);
      setConn("idle");
      setGit(null);
      setBanner(null);
    });
  };

  const createChat = async (): Promise<ChatState> => {
    const ws = workspace();
    const h = harnessId();
    if (!ws) throw new Error("Start atui in a project folder, or open a session from the list");
    if (!h) throw new Error("No harness is available");
    const snapshot = await server.call<ChatSnapshot>("/api/chats", { body: { harnessId: h, workspaceId: ws.id } });
    show(snapshot);
    return snapshot;
  };

  const runAppCommand = async (c: ChatState | null, name: string, arg: string) => {
    if (name === "new") return newChat();
    if (!c) throw new Error(`/${name} needs a chat`);
    if (name === "compact") await server.call(`/api/chats/${c.chatId}/compact`, { body: arg ? { instructions: arg } : {} });
    else if (name === "rename") {
      if (!arg) throw new Error("/rename <title>");
      await server.call(`/api/chats/${c.chatId}/rename`, { body: { name: arg } });
    }
  };

  /** Send what was typed: a normal message when idle, a steer (or follow-up) while the agent works. */
  const send = async (text: string, options: { compactFirst?: boolean } = {}): Promise<boolean> => {
    const value = text.trim();
    if (!value) return false;
    try {
      const command = appCommand(value);
      if (command) {
        await runAppCommand(chat(), command.name, command.arg);
        return true;
      }
      const c = chat() && chat()?.status !== "disposed" ? (chat() as ChatState) : await createChat();
      let mode: SendMode = "normal";
      if (isBusy(c.status)) {
        if (c.status === "running" && c.capabilities.supportsSteer) mode = "steer";
        else if (c.status === "running" && c.capabilities.supportsFollowUp) mode = "followUp";
        else throw new Error("The agent is busy; wait, or stop it with Esc Esc");
      }
      await server.call(`/api/chats/${c.chatId}/messages`, { body: { text: value, mode, ...(mode === "normal" && options.compactFirst ? { compactFirst: true } : {}) } });
      setBanner(null);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const stop = () => {
    const c = chat();
    if (!c || !isBusy(c.status)) return;
    setChat((prev) => (prev && prev.chatId === c.chatId ? { ...prev, status: "stopping" } : prev));
    server.call(`/api/chats/${c.chatId}/abort`, { body: {} }).catch(fail);
  };

  const answer = async (requestId: string, a: InteractionAnswer) => {
    const c = chat();
    if (!c) return;
    try {
      await server.call(`/api/chats/${c.chatId}/requests/${encodeURIComponent(requestId)}`, { body: { answer: a } });
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) {
        setChat((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev));
        setBanner({ level: "info", text: message(error) });
      } else fail(error);
    }
  };

  const configure = async (patch: { model?: string; thinkingLevel?: string }) => {
    const c = chat();
    if (!c) return;
    try {
      await server.call(`/api/chats/${c.chatId}/config`, { method: "PATCH", body: patch });
    } catch (error) {
      fail(error);
    }
  };

  const compact = async () => {
    const c = chat();
    if (!c) return;
    try {
      await server.call(`/api/chats/${c.chatId}/compact`, { body: {} });
    } catch (error) {
      fail(error);
    }
  };

  const chooseHarness = (id: string) => {
    setHarnessId(id);
    if (chat()) newChat();
  };

  /** Move the open chat to another harness: a copy of the conversation, or a summary its first prompt carries. */
  const handoff = async (id: string) => {
    const c = chat();
    if (!c) return chooseHarness(id);
    setOpening(true);
    try {
      const moved = await server.call<ChatSnapshot>(`/api/chats/${c.chatId}/handoff`, { body: { harness: id } });
      setHarnessId(id);
      show(moved);
      void refreshSessions();
    } catch (error) {
      fail(error);
    } finally {
      setOpening(false);
    }
  };

  const dispose = () => {
    stopStream?.();
    for (const timer of timers.splice(0)) clearInterval(timer);
    clearTimeout(listTimer);
    if (flushTimer) clearTimeout(flushTimer);
  };

  return {
    server,
    boot,
    theme,
    harnessId,
    harness,
    workspace,
    overview,
    chat,
    conn,
    limits,
    git,
    banner,
    setBanner,
    opening,
    busy,
    init,
    refreshSessions,
    refreshGit,
    refreshLimits,
    openSession,
    newChat,
    send,
    stop,
    answer,
    configure,
    compact,
    chooseHarness,
    handoff,
    dispose,
  };
}

export type Atui = ReturnType<typeof createAtui>;
