// Session tabs (Hermes Desktop's): the chats open in this browser, one of them
// shown. Pure list logic here; App wires it to chat loading. A tab remembers
// its live chat and its session, so it can reattach to the chat while the
// server holds it and resume the session from the harness once it does not.
import type { ChatSnapshot, ChatStatus } from "../shared/protocol.js";
import { load, save } from "./storage.js";

export interface Tab {
  /** Stable identity for React and storage (a chat's id can change on resume). */
  key: string;
  /** The live chat on the server, while there is one. */
  chatId: string | null;
  /** `harness:nativeId`, to resume once the chat is gone; null until the harness names it. */
  sessionId: string | null;
  harnessId: string;
  workspacePath: string;
  title: string;
  /** A run finished while another tab was shown. */
  unread?: boolean;
}

export interface TabState {
  tabs: Tab[];
  /** Index of the shown tab, or -1 when none is open. */
  active: number;
}

export const NO_TABS: TabState = { tabs: [], active: -1 };

let counter = 0;
const newKey = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

function fromSnapshot(snapshot: ChatSnapshot, key: string): Tab {
  return {
    key,
    chatId: snapshot.chatId,
    sessionId: snapshot.sessionId,
    harnessId: snapshot.harnessId,
    workspacePath: snapshot.workspace.path,
    title: snapshot.title || "New chat",
  };
}

/** The tab already holding this chat or session, if any. */
export function findTab(state: TabState, chat: { chatId: string | null; sessionId: string | null }): number {
  return state.tabs.findIndex((t) => (chat.chatId !== null && t.chatId === chat.chatId) || (chat.sessionId !== null && t.sessionId === chat.sessionId));
}

/**
 * Put a chat on screen. A chat that is already open in a tab is switched to;
 * otherwise it takes over the shown tab (Hermes's main view), or a new one
 * after it with `newTab` (or when nothing is open yet).
 */
export function placeChat(state: TabState, snapshot: ChatSnapshot, { newTab = false }: { newTab?: boolean } = {}): TabState {
  const existing = findTab(state, snapshot);
  if (existing >= 0) {
    const tabs = state.tabs.slice();
    tabs[existing] = { ...fromSnapshot(snapshot, (tabs[existing] as Tab).key) };
    return { tabs, active: existing };
  }
  if (newTab || state.active < 0) {
    const at = state.active + 1;
    const tabs = [...state.tabs.slice(0, at), fromSnapshot(snapshot, newKey()), ...state.tabs.slice(at)];
    return { tabs, active: at };
  }
  const tabs = state.tabs.slice();
  tabs[state.active] = fromSnapshot(snapshot, (tabs[state.active] as Tab).key);
  return { tabs, active: state.active };
}

/** Close a tab; the shown one hands over to its right neighbour, else its left. */
export function closeTab(state: TabState, index: number): TabState {
  if (index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  let active = state.active;
  if (tabs.length === 0) active = -1;
  else if (index < state.active) active -= 1;
  else if (index === state.active) active = Math.min(index, tabs.length - 1);
  return { tabs, active };
}

/** Keep the shown tab in step with its chat (title, session id once named, chat id after a resume). */
export function syncActive(state: TabState, chat: ChatSnapshot | null): TabState {
  const tab = state.tabs[state.active];
  if (!tab || !chat) return state;
  if (tab.chatId !== chat.chatId && !(chat.sessionId !== null && tab.sessionId === chat.sessionId)) return state;
  const next = { ...fromSnapshot(chat, tab.key) };
  if (next.chatId === tab.chatId && next.sessionId === tab.sessionId && next.title === tab.title && !tab.unread) return state;
  const tabs = state.tabs.slice();
  tabs[state.active] = next;
  return { tabs, active: state.active };
}

/** Mark background tabs whose run just finished; `finished` holds their chat ids. */
export function markUnread(state: TabState, finished: ReadonlySet<string>): TabState {
  if (finished.size === 0) return state;
  let changed = false;
  const tabs = state.tabs.map((t, i) => {
    if (i === state.active || t.unread || t.chatId === null || !finished.has(t.chatId)) return t;
    changed = true;
    return { ...t, unread: true };
  });
  return changed ? { tabs, active: state.active } : state;
}

/**
 * Live chats with a run in progress (running, stopping, compacting). A chat
 * whose harness is starting is not running: its Starting → Idle is no news.
 */
export function runningChats(sessions: ReadonlyArray<{ liveChatId?: string; status?: ChatStatus }>): Set<string> {
  const running: ReadonlySet<ChatStatus> = new Set(["running", "stopping", "compacting"]);
  return new Set(sessions.flatMap((x) => (x.liveChatId && x.status && running.has(x.status) ? [x.liveChatId] : [])));
}

const STORAGE_KEY = "tabs.v1";

/** This device's tabs, as last left. Unread marks are not kept. */
export function loadTabs(): TabState {
  const raw = load<TabState | null>(STORAGE_KEY, null);
  if (!raw || !Array.isArray(raw.tabs)) return NO_TABS;
  const tabs = raw.tabs.filter((t): t is Tab => typeof t?.key === "string" && typeof t.harnessId === "string" && typeof t.workspacePath === "string");
  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < tabs.length ? raw.active : tabs.length > 0 ? 0 : -1;
  return { tabs: tabs.map(({ unread: _unread, ...t }) => ({ ...t, title: typeof t.title === "string" ? t.title : "Chat" })), active };
}

/** A tab without a session (a new chat nobody wrote in) cannot come back once its chat is gone. */
export function saveTabs(state: TabState): void {
  save(STORAGE_KEY, { tabs: state.tabs.map(({ unread: _unread, ...t }) => t), active: state.active });
}
