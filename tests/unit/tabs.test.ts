import { describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { closeTab, findTab, markUnread, NO_TABS, placeChat, runningChats, syncActive, type TabState } from "../../src/web/tabs.js";

const snap = (chatId: string, sessionId: string | null = `fake:${chatId}`, title = chatId) =>
  ({ chatId, sessionId, harnessId: "fake", workspace: { id: "w", path: "/p", name: "p" }, title }) as unknown as ChatSnapshot;
const ids = (s: TabState) => s.tabs.map((t) => t.chatId);

describe("session tabs", () => {
  it("opens the first chat as a tab, then shows others in the current tab unless asked for a new one", () => {
    let s = placeChat(NO_TABS, snap("a"));
    expect([ids(s), s.active]).toEqual([["a"], 0]);
    s = placeChat(s, snap("b"));
    expect([ids(s), s.active]).toEqual([["b"], 0]);
    s = placeChat(s, snap("c"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["b", "c"], 1]);
    // A new tab goes right after the shown one.
    s = placeChat({ ...s, active: 0 }, snap("d"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["b", "d", "c"], 1]);
  });

  it("switches to the tab that already holds the chat or its session instead of opening it twice", () => {
    let s = placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true });
    s = placeChat(s, snap("a"), { newTab: true });
    expect([ids(s), s.active]).toEqual([["a", "b"], 0]);
    // The same session resumed as a new chat (after a server restart) lands in its old tab.
    const key = s.tabs[1]?.key;
    s = placeChat(s, snap("b2", "fake:b"));
    expect([ids(s), s.active, s.tabs[1]?.key]).toEqual([["a", "b2"], 1, key]);
    expect(findTab(s, { chatId: null, sessionId: "fake:a" })).toBe(0);
  });

  it("closes a tab and hands the view to its right neighbour, else its left", () => {
    const three = placeChat(placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true }), snap("c"), { newTab: true });
    expect(ids(closeTab({ ...three, active: 1 }, 1))).toEqual(["a", "c"]);
    expect(closeTab({ ...three, active: 1 }, 1).active).toBe(1);
    expect(closeTab({ ...three, active: 2 }, 2).active).toBe(1);
    expect(closeTab({ ...three, active: 2 }, 0).active).toBe(1);
    expect(closeTab({ ...three, active: 0 }, 2).active).toBe(0);
    expect(closeTab(placeChat(NO_TABS, snap("a")), 0)).toEqual(NO_TABS);
  });

  it("keeps the shown tab's title and session in step with its chat", () => {
    const s = placeChat(NO_TABS, snap("a", null, "New chat"));
    const named = syncActive(s, snap("a", "fake:a1", "Fix the build"));
    expect(named.tabs[0]).toMatchObject({ chatId: "a", sessionId: "fake:a1", title: "Fix the build", key: s.tabs[0]?.key });
    expect(syncActive(named, snap("a", "fake:a1", "Fix the build"))).toBe(named);
    // Another chat (being swapped in) does not overwrite the tab.
    expect(syncActive(named, snap("zzz"))).toBe(named);
  });

  it("marks a background tab whose run finished, never the shown one", () => {
    const s = placeChat(placeChat(NO_TABS, snap("a")), snap("b"), { newTab: true });
    const marked = markUnread(s, new Set(["a", "b"]));
    expect(marked.tabs.map((t) => Boolean(t.unread))).toEqual([true, false]);
    expect(markUnread(marked, new Set())).toBe(marked);
    // Showing it again clears the mark.
    expect(placeChat({ ...marked, active: 1 }, snap("a")).tabs[0]?.unread).toBeUndefined();
  });

  it("counts runs as running, not a harness that is starting", () => {
    expect([...runningChats([{ liveChatId: "a", status: "running" }, { liveChatId: "b", status: "starting" }, { liveChatId: "c", status: "compacting" }, { status: "running" }, { liveChatId: "d", status: "idle" }])]).toEqual(["a", "c"]);
  });
});
