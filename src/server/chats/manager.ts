// Owns every live chat in this process and guarantees one live writer per
// native session: `harnessId + nativeId -> chatId`. Another terminal or
// process running the same harness is NOT locked out (documented in README).
import { randomUUID } from "node:crypto";
import type { WorkspaceInfo } from "../../shared/protocol.js";
import type { HarnessAdapter, LiveChat } from "../harness/types.js";
import { Chat, ChatError, errorMessage } from "./chat.js";

const IDLE_DISPOSE_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 60_000;

function key(harnessId: string, nativeId: string): string {
  return `${harnessId}\u0000${nativeId}`;
}

export class ChatManager {
  private chats = new Map<string, Chat>();
  private bySession = new Map<string, string>();
  private opening = new Map<string, Promise<Chat>>();
  private reaper: NodeJS.Timeout;

  constructor(private readonly idleDisposeMs = IDLE_DISPOSE_MS) {
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  get(chatId: string): Chat {
    const chat = this.chats.get(chatId);
    if (!chat) throw new ChatError(404, "chat_not_found", "No such chat; it may have been closed");
    return chat;
  }

  list(): Chat[] {
    return [...this.chats.values()];
  }

  liveChatFor(harnessId: string, nativeId: string): Chat | undefined {
    const chatId = this.bySession.get(key(harnessId, nativeId));
    return chatId ? this.chats.get(chatId) : undefined;
  }

  private register(chat: Chat): void {
    this.chats.set(chat.chatId, chat);
    chat.onSession = (c) => this.claimSession(c);
    chat.onDisposed = (c) => this.forget(c);
    if (chat.nativeId) this.claimSession(chat);
  }

  private claimSession(chat: Chat): void {
    if (!chat.nativeId) return;
    const k = key(chat.harnessId, chat.nativeId);
    const owner = this.bySession.get(k);
    if (owner && owner !== chat.chatId) {
      // Two live instances must never write one session file; close the newcomer.
      void chat.dispose("Session already open in another chat").catch(() => undefined);
      return;
    }
    this.bySession.set(k, chat.chatId);
  }

  private forget(chat: Chat): void {
    this.chats.delete(chat.chatId);
    for (const [k, id] of this.bySession) if (id === chat.chatId) this.bySession.delete(k);
  }

  async create(adapter: HarnessAdapter, workspace: WorkspaceInfo): Promise<Chat> {
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    let live;
    try {
      live = await adapter.openChat({ cwd: workspace.path });
    } catch (error) {
      throw new ChatError(502, "harness_init_failed", `${adapter.displayName} failed to start: ${errorMessage(error)}`);
    }
    const chat = await this.load(adapter, workspace, live);
    this.register(chat);
    return chat;
  }

  /**
   * Build the chat from a started harness session. If that fails (a history too
   * big for the transport, say), the session is closed again rather than left
   * running with nothing attached to it.
   */
  private async load(adapter: HarnessAdapter, workspace: WorkspaceInfo, live: LiveChat): Promise<Chat> {
    try {
      return await Chat.open(randomUUID(), adapter, workspace, live);
    } catch (error) {
      await live.dispose().catch(() => undefined);
      throw new ChatError(502, "harness_load_failed", `${adapter.displayName} could not load this session: ${errorMessage(error)}`);
    }
  }

  /** Attach to the live chat for this session if one exists; otherwise open it. */
  async resume(adapter: HarnessAdapter, workspace: WorkspaceInfo, nativeId: string): Promise<Chat> {
    const k = key(adapter.id, nativeId);
    const existing = this.liveChatFor(adapter.id, nativeId);
    if (existing) return existing;
    const inFlight = this.opening.get(k);
    if (inFlight) return inFlight;
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const open = (async () => {
      const known = await adapter.listSessions(workspace.path);
      if (!known.some((s) => s.nativeId === nativeId)) {
        throw new ChatError(404, "session_not_found", "That session is not in this workspace's session list");
      }
      let live;
      try {
        live = await adapter.openChat({ cwd: workspace.path, resumeNativeId: nativeId });
      } catch (error) {
        throw new ChatError(502, "harness_init_failed", `${adapter.displayName} failed to resume: ${errorMessage(error)}`);
      }
      const chat = await this.load(adapter, workspace, live);
      this.register(chat);
      return chat;
    })();
    this.opening.set(k, open);
    try {
      return await open;
    } finally {
      this.opening.delete(k);
    }
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const chat of this.chats.values()) {
      const idle = chat.status === "idle" || chat.status === "error";
      if (idle && chat.subscriberCount === 0 && now - chat.lastActivity > this.idleDisposeMs) {
        await chat.dispose("Closed after being idle with no viewers").catch(() => undefined);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.allSettled([...this.chats.values()].map((c) => c.dispose("Server shutting down")));
  }
}
