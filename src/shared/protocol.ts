// Wire protocol shared by the server and the browser. Nothing in here may
// reference a harness SDK: adapters normalize into these types.
import { z } from "zod";

export type HarnessId = string & { readonly __brand: "HarnessId" };
export const asHarnessId = (id: string): HarnessId => id as HarnessId;

export interface HarnessCapabilities {
  supportsSteer: boolean;
  supportsFollowUp: boolean;
  supportsThinkingLevel: boolean;
  supportsCompact: boolean;
  supportsExtensions: boolean;
  supportsInteractiveRequests: boolean;
  supportsRename: boolean;
  supportsModelSelection: boolean;
  /** The chat can be branched into a new session at a chosen turn. */
  supportsFork: boolean;
  /** A portable transcript seed can start a fresh session here. */
  supportsHandoff: boolean;
}

export interface HarnessStatus {
  id: HarnessId;
  displayName: string;
  available: boolean;
  /** Short and comparable, for the menu: 1.0.2, 18.6.1, 2026.9.24. */
  version?: string;
  /** The CLI's full version line (the tooltip), when it says more than `version`. */
  versionDetail?: string;
  /** Why the harness is unavailable or degraded. Never contains paths or secrets. */
  reason?: string;
  warnings: string[];
  capabilities: HarnessCapabilities;
  /** Config-dir overrides reported as set/unset only. */
  overrides: Record<string, "set" | "unset">;
  /** The theme colour token (`link`, `thinking`, …) its dot, badge, spinner, and chip use. */
  accent: string;
}

/** Theme colour tokens a harness may take, in the order unclaimed harnesses get them. */
export const HARNESS_ACCENTS = ["link", "thinking", "orange", "rare", "info", "ok"] as const;

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
  /** That live chat's status, so lists can show which sessions are working. */
  status?: ChatStatus;
}

/** A session together with the project it belongs to. */
export interface ProjectSession extends SessionSummary {
  workspaceId: string;
}

/** The sidebar's list: recent sessions from every project, plus all of the current one's. */
export interface SessionsOverview {
  /** Every project referenced by `sessions`, and the current project. */
  workspaces: WorkspaceInfo[];
  /** Newest first. */
  sessions: ProjectSession[];
  /** One line per harness that could not list its sessions. */
  errors: string[];
}

export type ChatStatus = "starting" | "idle" | "running" | "stopping" | "compacting" | "error" | "disposed";

export interface ModelInfo {
  /** `provider/id`, the value sent back in config patches. */
  key: string;
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  /** Accepts image input; absent when the harness does not say. */
  vision?: boolean;
  /** Reasoning levels the harness offers for this model, weakest first; "off" is not a level. */
  levels?: string[];
}

export interface ChatConfig {
  model: string | null;
  thinkingLevel: string | null;
  models: ModelInfo[];
  thinkingLevels: string[];
}

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  imageCount?: number;
  /** A "/" command the harness answered itself: no stored turn, so forks do not count it. */
  command?: true;
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
  /** Added/removed lines for an edit or write (from its arguments, refined by its output). */
  diffStat?: { added: number; removed: number };
  at?: number;
  endedAt?: number;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warning" | "error";
  /** The line shown; with a `detail`, a one-line summary of it (the row itself shows only the title). */
  text: string;
  /** A label for an expandable notice (an extension's message: "Memory"). */
  title?: string;
  /** The full text behind the disclosure, when `text` only summarizes it. */
  detail?: string;
  at?: number;
  /** Arrived while the agent was idle (e.g. extension notices on open): not part of any turn's work. */
  ambient?: boolean;
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

/** A "/" command the open chat's harness offers (the composer's menu). */
export interface SlashCommand {
  /** Without the slash, e.g. "compact" or "skill:review". */
  name: string;
  description?: string;
  /** What goes after the name, e.g. "[instructions]". */
  hint?: string;
  /** How the harness labels it: builtin, extension, skill, prompt, plugin, ... */
  source: string;
}

/** One slice of the context window: omp's own `/context` figures, or this server's estimate for Pi. */
export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
}

export interface ContextUsage {
  tokens: number | null;
  window: number;
  percent: number | null;
  /** What fills the window; estimates. */
  categories?: ContextCategory[];
}

/** Session-wide tokens and model timing (the composer's stats line). */
export interface SessionUsage {
  /** Prompts and model calls across the whole session, from the harness. */
  turns: number;
  steps: number;
  /** Token totals: input sent fresh, input read from the provider's cache, cache writes, output. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  /** USD, when the harness prices the model. */
  cost: number | null;
  /** Measured by this server over the runs it watched; null until one has finished. */
  llmMs: number | null;
  ttftMs: number | null;
  tokensPerSecond: number | null;
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
  usage: SessionUsage | null;
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
  | { type: "usage"; usage: SessionUsage | null }
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

/** config.yml's `theme`: the default look on every device. `custom` is the legacy name for `base16`. */
export const themeChoiceSchema = z.enum(["system", "light", "dark", "base16", "custom"]);
/** A device's theme mode; the file's legacy `custom` maps to `base16`. */
export type ThemeChoice = Exclude<z.infer<typeof themeChoiceSchema>, "custom">;

export interface Bootstrap {
  version: string;
  /** "local": this machine, no sign-in. "password": signed in from another device. */
  auth: { mode: "local" | "password"; username: string | null; remoteEnabled: boolean };
  harnesses: HarnessStatus[];
  roots: string[];
  home: string;
  theme: { active: string; problem?: string };
  /** From config.yml: the shared look (theme null lets theme.yml decide, scale null is 100%). Re-read on every page load. */
  ui: { theme: ThemeChoice | null; textScale: number | null; autocollapseSidebar: boolean };
  pairing: { urls: string[] };
  limits: { maxMessageChars: number };
}

export const MAX_MESSAGE_CHARS = 100_000;

export const openWorkspaceSchema = z.object({ path: z.string().min(1).max(4096) });
export const createChatSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
});
export const resumeChatSchema = z.object({
  harnessId: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(512),
});
/** Branch the chat after its Nth user turn (1-based). */
export const forkChatSchema = z.object({
  through: z.number().int().min(1).max(10_000),
});
/** Continue this chat in another harness: transcript seed plus an optional first prompt. */
export const handoffSchema = z.object({
  harness: z.string().min(1).max(64),
  through: z.number().int().min(1).max(10_000).optional(),
  prompt: z.string().max(MAX_MESSAGE_CHARS).optional(),
});
/** Image types both harnesses and the major providers accept. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
export const MAX_IMAGES = 8;
/** Per image, after the browser's downscaling; Anthropic's API refuses anything larger. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** A pasted, dropped, or picked image, base64-encoded. The harness resizes it further for the model. */
export interface ImageAttachment {
  mimeType: ImageMimeType;
  data: string;
}

export const imageAttachmentSchema = z.object({
  mimeType: z.enum(IMAGE_MIME_TYPES),
  data: z
    .string()
    .min(8)
    .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64"),
});

export const sendMessageSchema = z.object({
  // Text stays required with images: some providers reject an empty text block.
  text: z.string().min(1).max(MAX_MESSAGE_CHARS),
  images: z.array(imageAttachmentSchema).max(MAX_IMAGES).default([]),
  mode: z.enum(["normal", "steer", "followUp", "stopAndSend"]).default("normal"),
});
export const patchConfigSchema = z
  .object({
    model: z.string().min(1).max(512).optional(),
    thinkingLevel: z.string().min(1).max(32).optional(),
  })
  .refine((v) => v.model !== undefined || v.thinkingLevel !== undefined, {
    message: "empty patch",
  });
export const renameSchema = z.object({ name: z.string().trim().min(1).max(200) });
export const compactSchema = z.object({ instructions: z.string().max(10_000).optional() });
export const answerSchema = z.object({ answer: interactionAnswerSchema });

export type SendMode = z.infer<typeof sendMessageSchema>["mode"];

/** config.yml's settings as the Settings dialog shows them; the password itself never leaves the server. */
export interface ServerSettingsValues {
  port: number;
  host: "127.0.0.1" | "0.0.0.0";
  /** Sign-in name for other devices ("" when none is set). */
  username: string;
  /** A sign-in password is set (in config.yml, or by `npm run set-password`). */
  hasPassword: boolean;
  workspaceRoots: string[];
  allowedHosts: string[];
  allowedTailscaleUsers: string[];
  /** Shared look for every device; null theme lets a theme.yml decide, null scale is 100%. */
  theme: ThemeChoice | null;
  textScale: number | null;
  autocollapseSidebar: boolean;
}

/** Settings that take effect only when the server restarts. */
export type RestartSetting = "port" | "host" | "username" | "password" | "workspaceRoots" | "allowedHosts" | "allowedTailscaleUsers";

export interface ServerSettings {
  /** This browser is on the machine running the server: it may change them (other devices only read). */
  editable: boolean;
  /** There is a settings folder to write config.yml to (none when AWUI_CONFIG_DIR is ""). */
  writable: boolean;
  /** As config.yml says now. */
  values: ServerSettingsValues;
  /** Saved but not yet in effect: they wait for a restart. */
  restartPending: RestartSetting[];
  /** Settings an environment variable overrides, so config.yml's value has no effect. */
  envOverrides: Array<keyof ServerSettingsValues>;
  /** A supervisor (systemd) brings the server back after it exits, so it can restart itself. */
  canRestart: boolean;
}

/** A change from the Settings dialog; omitted fields stay as they are. `password: null` removes it. */
export const settingsPatchSchema = z
  .object({
    port: z.number().int().min(1).max(65_535).optional(),
    host: z.enum(["127.0.0.1", "0.0.0.0"]).optional(),
    username: z.string().trim().max(64).optional(),
    password: z.string().max(1024).nullable().optional(),
    workspaceRoots: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
    allowedHosts: z.array(z.string().trim().min(1).max(255)).max(64).optional(),
    allowedTailscaleUsers: z.array(z.string().trim().min(1).max(255)).max(64).optional(),
    theme: themeChoiceSchema.nullable().optional(),
    textScale: z.number().min(0.5).max(2).nullable().optional(),
    autocollapseSidebar: z.boolean().optional(),
  })
  .strict();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
