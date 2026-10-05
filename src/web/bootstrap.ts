// Session bootstrap: the bootstrap payload, the signed-out flag behind the
// login form, and the one-time side effects that ride along with the fetch
// (theme, default harness, last project, chat named in the URL hash).
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { Bootstrap, ChatSnapshot, ThemeChoice, ThemeInfo, WorkspaceInfo } from "../shared/protocol.js";
import { api, ApiError, errorText, onUnauthorized } from "./api.js";
import type { ChatState } from "./chat-state.js";
import { chatIdFromHash, setHash } from "./chat-stream.js";
import { forgetWorkspace, load } from "./storage.js";
import { fetchTheme } from "./theme.js";

export interface BootstrapTargets {
  /** The theme delivered with the bootstrap payload (null when /api/theme failed). */
  onTheme: (info: ThemeInfo | null, choice: ThemeChoice | null) => void;
  setHarnessId: Dispatch<SetStateAction<string | null>>;
  setWorkspace: Dispatch<SetStateAction<WorkspaceInfo | null>>;
  setRecent: Dispatch<SetStateAction<string[]>>;
  setChat: Dispatch<SetStateAction<ChatState | null>>;
}

export function useBootstrap(targets: BootstrapTargets) {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => onUnauthorized(() => setSignedOut(true)), []);

  useEffect(() => {
    // Runs once with the first render's targets: the setters are stable and
    // onTheme only ever calls setters itself, so nothing can go stale.
    const { onTheme, setHarnessId, setWorkspace, setRecent, setChat } = targets;
    let cancelled = false;
    (async () => {
      try {
        const [b, t] = await Promise.all([api<Bootstrap>("/api/bootstrap"), fetchTheme()]);
        if (cancelled) return;
        setBoot(b);
        onTheme(t, b.ui.theme);
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

  return { boot, bootError, signedOut, setSignedOut };
}
