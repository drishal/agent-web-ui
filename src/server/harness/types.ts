// The server-side harness contract. Routes, the chat manager, and tests talk
// only to these types; SDK- or protocol-specific shapes stay inside adapters.
import type {
  ChatConfig,
  ChatItem,
  ContextUsage,
  HarnessCapabilities,
  HarnessId,
  ImageAttachment,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  QueueState,
  SlashCommand,
  TodoItem,
} from "../../shared/protocol.js";
import type { HandoffSeed } from "./handoff.js";
export interface HarnessDiscovery {
  available: boolean;
  version?: string;
  reason?: string;
  warnings: string[];
  overrides: Record<string, "set" | "unset">;
}

export interface NativeSessionSummary {
  /** Adapter-native, opaque to everything outside the adapter. */
  nativeId: string;
  title: string;
  updatedAt: Date | null;
  messageCount?: number;
}

/** One model call's tokens, as the provider reported them. */
export interface StepUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Session totals the harness keeps (Pi getSessionStats, omp get_session_stats). */
export interface HarnessUsage {
  turns: number;
  steps: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  cost: number | null;
}

export interface RecentNativeSession extends NativeSessionSummary {
  /** The project the session belongs to. */
  cwd: string;
}

export interface OpenChatRequest {
  cwd: string;
  /** Native id from this adapter's own listSessions(). */
  resumeNativeId?: string;
}

/** Normalized events every adapter emits. */
export type HarnessEvent =
  | { type: "user_message"; text: string; imageCount?: number; command?: true }
  | { type: "assistant_start"; model?: string }
  | { type: "assistant_delta"; field: "text" | "thinking"; delta: string }
  | { type: "assistant_end"; text: string; thinking: string; error?: string; usage?: StepUsage }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; output: string; isError: boolean }
  | { type: "busy" }
  | { type: "settled" }
  | { type: "compacting"; active: boolean }
  | { type: "queue"; queue: QueueState }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "config"; config: Partial<ChatConfig> }
  | { type: "title"; title: string }
  | { type: "session"; nativeId: string }
  | { type: "request"; request: InteractionRequest }
  | { type: "request_cancelled"; requestId: string; outcome: string }
  | { type: "extension_status"; key: string; text: string | null }
  | { type: "fatal"; message: string };

export type HarnessEventListener = (event: HarnessEvent) => void;

export interface LiveChat {
  /** Known once the harness has assigned a session; stable afterwards. */
  readonly nativeId: string | null;
  readonly title: string | null;
  subscribe(listener: HarnessEventListener): () => void;
  /** Active branch only, rebuilt through the harness's public API. */
  history(): Promise<ChatItem[]>;
  getConfig(): Promise<ChatConfig>;
  /** Context window occupancy, or null when the harness cannot tell. */
  getContextUsage(): Promise<ContextUsage | null>;
  /** Session token totals, or null when the harness cannot tell. */
  getUsage(): Promise<HarnessUsage | null>;
  /** The harness's own todo list, if it keeps one. */
  getTodos(): Promise<TodoItem[]>;
  /** The "/" commands this session understands; sending "/name args" as a prompt runs one. */
  listCommands(): Promise<SlashCommand[]>;
  /** Resolves once the harness accepted the prompt; the run streams as events. */
  prompt(text: string, images?: ImageAttachment[]): Promise<void>;
  steer(text: string, images?: ImageAttachment[]): Promise<void>;
  followUp(text: string, images?: ImageAttachment[]): Promise<void>;
  /** Aborts the run, clears queues where supported, resolves when idle. */
  abort(): Promise<void>;
  setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void>;
  /** Drop cached models so the next getConfig() sees new ones (local servers, catalogs, config edits). */
  refreshModels(): Promise<void>;
  rename(name: string): Promise<void>;
  compact(instructions?: string): Promise<void>;
  /** Returns false when the request is unknown or already resolved. */
  answer(requestId: string, answer: InteractionAnswer): boolean;
  dispose(): Promise<void>;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities;
  discover(): Promise<HarnessDiscovery>;
  /** Why this harness cannot open the workspace, or null. */
  workspaceProblem(cwd: string): string | null;
  // Server-only path resolution; never serialized to the browser.
  resolveAgentDir(): Promise<string>;
  resolveSessionDir(cwd: string): Promise<string>;
  listModels(cwd: string): Promise<ModelInfo[]>;
  listThinkingLevels(cwd: string): Promise<string[]>;
  listSessions(cwd: string): Promise<NativeSessionSummary[]>;
  /** The newest sessions across every project, newest first. */
  listRecentSessions(limit: number): Promise<RecentNativeSession[]>;
  /**
   * Copy the session's conversation through its Nth user turn (1-based) into a
   * new session of the harness's own store, and return the new native id. The
   * copy is listed and resumable like any other session. Callers gate on
   * capabilities.supportsFork.
   */
  forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }>;
  /**
   * Start a fresh session seeded with a portable transcript (cross-harness
   * handoff). Tool records arrive as plain transcript text, never live tool
   * state; the caller sends any draft as a normal turn afterwards. Returns the live
   * chat directly (unlike forkSession, the session is already open). Callers
   * gate on capabilities.supportsHandoff.
   */
  seedChat(req: { cwd: string; seed: HandoffSeed }): Promise<LiveChat>;
  openChat(req: OpenChatRequest): Promise<LiveChat>;
  /** Kill helper processes; called on server shutdown. */
  shutdown(): Promise<void>;
}
