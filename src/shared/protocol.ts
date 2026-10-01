// Wire protocol shared by the server and the browser. Nothing in here may
// reference a harness SDK: adapters normalize into these types.
import { z } from "zod";

export type HarnessId = string & { readonly __brand: "HarnessId" };
export const asHarnessId = (id: string): HarnessId => id as HarnessId;

export interface HarnessCapabilities {
  supportsSteer: boolean;
  supportsFollowUp: boolean;
  supportsThinkingLevel: boolean;
  supportsReadOnlyTools: boolean;
  supportsCompact: boolean;
  supportsExtensions: boolean;
  supportsInteractiveRequests: boolean;
  supportsRename: boolean;
  supportsModelSelection: boolean;
}

export interface HarnessStatus {
  id: HarnessId;
  displayName: string;
  available: boolean;
  version?: string;
  /** Why the harness is unavailable or degraded. Never contains paths or secrets. */
  reason?: string;
  warnings: string[];
  capabilities: HarnessCapabilities;
  /** Config-dir overrides reported as set/unset only. */
  overrides: Record<string, "set" | "unset">;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string;
}

export interface DirEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface BrowseResult {
  /** null when listing the configured roots themselves. */
  path: string | null;
  parent: string | null;
  entries: DirEntry[];
}

export interface SessionSummary {
  /** Namespaced and opaque, e.g. `pi:<id>`. */
  id: string;
  harnessId: HarnessId;
  title: string;
  updatedAt: string | null;
  messageCount?: number;
  /** Chat id when this session is already open in this process. */
  liveChatId?: string;
}

export type ToolsMode = "readOnly" | "full";

export type ChatStatus = "starting" | "idle" | "running" | "stopping" | "compacting" | "error" | "disposed";

export interface ModelInfo {
  /** `provider/id`, the value sent back in config patches. */
  key: string;
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
}

export interface ChatConfig {
  model: string | null;
  thinkingLevel: string | null;
  toolsMode: ToolsMode;
  models: ModelInfo[];
  thinkingLevels: string[];
}

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  imageCount?: number;
  /** Epoch ms when the harness recorded it, when known. */
  at?: number;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  thinking: string;
  streaming: boolean;
  error?: string;
  model?: string;
  at?: number;
  endedAt?: number;
}

export type ToolCategory = "read" | "edit" | "write" | "command" | "search" | "web" | "other";

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  output: string;
  truncated: boolean;
  category: ToolCategory;
  /** One-line description: a path, command, or query. */
  summary: string;
  /** Files named in the arguments (absolute or as given). */
  paths: string[];
  at?: number;
  endedAt?: number;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  text: string;
  at?: number;
}

export interface RequestItem {
  kind: "request";
  id: string;
  request: InteractionRequest;
  outcome?: string;
  at?: number;
}

export type ChatItem = UserItem | AssistantItem | ToolItem | NoticeItem | RequestItem;

export type InteractionKind = "select" | "confirm" | "input" | "editor";

export interface InteractionRequest {
  id: string;
  kind: InteractionKind;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** Absolute epoch ms when the harness gives up on its own. */
  expiresAt?: number;
  createdAt: number;
}

export const interactionAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("select"), value: z.string().max(10_000) }),
  z.object({ kind: z.literal("confirm"), confirmed: z.boolean() }),
  z.object({ kind: z.literal("input"), value: z.string().max(100_000) }),
  z.object({ kind: z.literal("editor"), value: z.string().max(1_000_000) }),
  z.object({ kind: z.literal("cancel") }),
]);
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>;

export interface ContextUsage {
  tokens: number | null;
  window: number;
  percent: number | null;
}

export interface TodoItem {
  phase?: string;
  text: string;
  /** Harness status, e.g. pending, in_progress, completed. */
  status: string;
}

export interface QueueState {
  steering: string[];
  followUp: string[];
}

export interface ChatSnapshot {
  chatId: string;
  harnessId: HarnessId;
  /** Namespaced session id once the harness has assigned one. */
  sessionId: string | null;
  workspace: WorkspaceInfo;
  title: string;
  status: ChatStatus;
  items: ChatItem[];
  queue: QueueState;
  pending: InteractionRequest[];
  config: ChatConfig;
  capabilities: HarnessCapabilities;
  extensionStatus: Record<string, string>;
  context: ContextUsage | null;
  todos: TodoItem[];
  generation: number;
  lastEventId: number;
}

export type ChatEvent =
  | { type: "snapshot"; snapshot: ChatSnapshot }
  | { type: "item"; item: ChatItem }
  | { type: "delta"; itemId: string; field: "text" | "thinking" | "output"; append: string }
  | { type: "status"; status: ChatStatus }
  | { type: "queue"; queue: QueueState }
  | { type: "config"; config: ChatConfig }
  | { type: "title"; title: string; sessionId: string | null }
  | { type: "request"; request: InteractionRequest }
  | { type: "request_resolved"; requestId: string; outcome: string }
  | { type: "extension_status"; key: string; text: string | null }
  | { type: "context"; context: ContextUsage | null }
  | { type: "todos"; todos: TodoItem[] }
  | { type: "disposed"; reason: string };

export interface ThemeInfo {
  source: "file" | "none";
  name: string | null;
  polarity: "dark" | "light" | null;
  /** CSS custom properties, already contrast-checked. */
  vars: Record<string, string>;
  themeColor: string | null;
  fonts: { sans?: string; mono?: string };
  /** Why no scheme is active, when a file was configured but unusable. */
  problem?: string;
}

export interface Bootstrap {
  version: string;
  harnesses: HarnessStatus[];
  roots: string[];
  home: string;
  theme: { active: string; problem?: string };
  pairing: { urls: string[] };
  limits: { maxMessageChars: number };
}

export const MAX_MESSAGE_CHARS = 100_000;

export const openWorkspaceSchema = z.object({ path: z.string().min(1).max(4096) });
export const createChatSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  toolsMode: z.enum(["readOnly", "full"]).optional(),
});
export const resumeChatSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(512),
});
export const sendMessageSchema = z.object({
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  mode: z.enum(["normal", "steer", "followUp", "stopAndSend"]).default("normal"),
});
export const patchConfigSchema = z
  .object({
    model: z.string().min(1).max(512).optional(),
    thinkingLevel: z.string().min(1).max(32).optional(),
    toolsMode: z.enum(["readOnly", "full"]).optional(),
  })
  .refine((v) => v.model !== undefined || v.thinkingLevel !== undefined || v.toolsMode !== undefined, {
    message: "empty patch",
  });
export const renameSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const compactSchema = z.object({ instructions: z.string().max(10_000).optional() });
export const answerSchema = z.object({ answer: interactionAnswerSchema });

export type SendMode = z.infer<typeof sendMessageSchema>["mode"];

export interface ApiError {
  error: string;
  code: string;
}
