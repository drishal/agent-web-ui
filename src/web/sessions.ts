// The sidebar's session list: refreshes that can never apply out of order (a
// sequence ref drops stale replies), a debounce when the open chat settles,
// and a poll while some *other* chat is working off-screen.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, SessionMarkState, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";
import { api, errorText } from "./api.js";
import type { ChatState } from "./chat-state.js";
import { isBusy } from "./session-groups.js";

/** How often the session list refreshes while a chat other than the open one is working. */
const BACKGROUND_POLL_MS = 3000;

export function useSessions({ boot, workspace, chat }: { boot: Bootstrap | null; workspace: WorkspaceInfo | null; chat: ChatState | null }) {
  const [overview, setOverview] = useState<SessionsOverview>({ workspaces: [], sessions: [], errors: [] });
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

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
  const chatId = chat?.chatId ?? null;
  const backgroundBusy = overview.sessions.some((s) => isBusy(s.status) && s.liveChatId !== chatId);
  useEffect(() => {
    if (!backgroundBusy) return;
    const timer = window.setInterval(() => void refreshSessions(), BACKGROUND_POLL_MS);
    return () => window.clearInterval(timer);
  }, [backgroundBusy, refreshSessions]);

  /** Show a pin or archive at once; the server's answer replaces it (a later refresh agrees). */
  const markSession = useCallback((sessionId: string, mark: SessionMarkState) => {
    setOverview((o) => ({
      ...o,
      sessions: o.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const { pinned: _p, archived: _a, settled: _s, snoozedUntil: _z, ...rest } = s;
        return { ...rest, ...mark };
      }),
    }));
  }, []);

  return { overview, sessionsError, sessionsLoading, refreshSessions, markSession };
}
