// Pi adapter: in-process through the pinned @earendil-works/pi-coding-agent
// SDK. Pi stays the source of truth for models, auth, settings, resources,
// trust decisions, and session files; this module only translates.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as pi from "@earendil-works/pi-coding-agent";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ContextCategory,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type InteractionKind,
  type SlashCommand,
  type ModelInfo,
  type TodoItem,
} from "../../shared/protocol.js";
import { historyToItems, normalizeAgentEvent } from "./agent-events.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEvent,
  HarnessEventListener,
  HarnessUsage,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
} from "./types.js";

const run = promisify(execFile);
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/** How long closing a chat waits for extensions' session_shutdown handlers. */
const EXTENSION_SHUTDOWN_MS = 5_000;
/** How long a model-list refresh waits for remote catalogs. */
const MODEL_REFRESH_MS = 15_000;

type AgentSession = pi.AgentSession;
type Services = Awaited<ReturnType<typeof pi.createAgentSessionServices>>;
type PiModel = { provider: string; id: string; name?: string; reasoning?: boolean; input?: string[]; thinkingLevelMap?: Record<string, string | null> };

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(1)) : p;
}

const estimateText = (text: string) => Math.ceil(text.length / 4);

function summarize(info: pi.SessionInfo): NativeSessionSummary {
  return {
    nativeId: info.id,
    // "(no messages)" is Pi's label for a session whose first user message has no text.
    title: info.name || (info.firstMessage === "(no messages)" ? "" : info.firstMessage.slice(0, 80)) || "Untitled",
    updatedAt: info.modified,
    messageCount: info.messageCount,
  };
}

/** Pi's thinking ladder, weakest first; "off" is not a level the picker shows. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Mirrors pi-ai's getSupportedThinkingLevels (that module is not re-exported here). */
function supportedLevels(m: PiModel): string[] {
  if (!m.reasoning) return [];
  return THINKING_LEVELS.filter((level) => {
    const mapped = m.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

function toModelInfo(m: PiModel): ModelInfo {
  const levels = supportedLevels(m);
  return {
    key: `${m.provider}/${m.id}`,
    provider: m.provider,
    id: m.id,
    name: m.name ?? m.id,
    ...(m.reasoning !== undefined ? { reasoning: Boolean(m.reasoning) } : {}),
    ...(Array.isArray(m.input) ? { vision: m.input.includes("image") } : {}),
    ...(levels.length > 0 ? { levels } : {}),
  };
}

function toPiImages(images: ImageAttachment[] | undefined) {
  return images?.length ? images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })) : undefined;
}

/** Theme stand-in for extensions that style text: every styling call returns its text. */
const plainTheme = new Proxy(
  {},
  {
    get: (_target, prop) => (prop === "then" ? undefined : (...args: unknown[]) => args[args.length - 1]),
  },
);

export class PiAdapter implements HarnessAdapter {
  readonly id = asHarnessId("pi");
  readonly displayName = "Pi";
  readonly cliCommand = "pi";
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    supportsExtensions: true,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
  };
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();

  async sdkVersion(): Promise<string> {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(entry), "..", "package.json"), "utf8")) as {
      version: string;
    };
    return pkg.version;
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = {
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ? "set" : "unset",
      [SESSION_DIR_ENV]: process.env[SESSION_DIR_ENV] ? "set" : "unset",
    } as const;
    const warnings: string[] = [];
    let sdk: string;
    try {
      sdk = await this.sdkVersion();
    } catch {
      return { available: false, reason: "The bundled Pi SDK failed to load", warnings, overrides };
    }
    let cli: string;
    try {
      const { stdout } = await run(this.cliCommand, ["--version"], { timeout: 15_000 });
      cli = stdout.trim().replace(/^v/, "");
    } catch {
      return {
        available: false,
        version: sdk,
        reason: "The pi CLI is not installed. Install pi, run it once, and log in.",
        warnings,
        overrides,
      };
    }
    if (cli !== sdk) warnings.push(`pi CLI is ${cli} but this app pins SDK ${sdk}; session formats may differ`);
    return { available: true, version: sdk, warnings, overrides };
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return pi.getAgentDir();
  }

  /** Mirrors the CLI: stored decision, then defaultProjectTrust; never prompts. */
  private trust(cwd: string, agentDir: string): { trusted: boolean; notice?: string } {
    if (!pi.hasTrustRequiringProjectResources(cwd)) return { trusted: true };
    const decision = new pi.ProjectTrustStore(agentDir).get(cwd);
    if (decision !== null) {
      return decision
        ? { trusted: true }
        : { trusted: false, notice: "Project resources are not loaded: this folder is marked untrusted in Pi." };
    }
    const global = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust();
    if (global === "always") return { trusted: true };
    return {
      trusted: false,
      notice:
        "Project settings, extensions, and skills in this folder were skipped because Pi has not trusted it yet. Run `pi` here once to decide.",
    };
  }

  private sessionDirFor(cwd: string, agentDir: string, trusted: boolean): string | undefined {
    const env = process.env[SESSION_DIR_ENV];
    if (env) return expandTilde(env);
    return pi.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted }).getSessionDir() || undefined;
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    const agentDir = pi.getAgentDir();
    const explicit = this.sessionDirFor(cwd, agentDir, this.trust(cwd, agentDir).trusted);
    return explicit ?? pi.SessionManager.inMemory(cwd).getSessionDir();
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const agentDir = pi.getAgentDir();
    const sessionDir = this.sessionDirFor(cwd, agentDir, this.trust(cwd, agentDir).trusted);
    const infos = await pi.SessionManager.list(cwd, sessionDir);
    return infos
      .filter((info) => !info.cwd || info.cwd === cwd)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .map(summarize);
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const agentDir = pi.getAgentDir();
    // Global settings only; a project's own sessionDir is covered by listSessions(cwd).
    const infos = await pi.SessionManager.listAll(this.sessionDirFor(agentDir, agentDir, false));
    return infos
      .filter((info) => info.cwd)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, limit)
      .map((info) => ({ ...summarize(info), cwd: info.cwd }));
  }

  private async services(cwd: string): Promise<{ services: Services; notices: HarnessEvent[]; trusted: boolean }> {
    const agentDir = pi.getAgentDir();
    const { trusted, notice } = this.trust(cwd, agentDir);
    const settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
    });
    const notices: HarnessEvent[] = [];
    if (notice) notices.push({ type: "notice", level: "warning", text: notice });
    for (const d of services.diagnostics) {
      notices.push({ type: "notice", level: d.type === "error" ? "error" : d.type === "warning" ? "warning" : "info", text: d.message });
    }
    for (const { path: extPath, error } of services.resourceLoader.getExtensions().errors) {
      notices.push({ type: "notice", level: "error", text: `Extension ${path.basename(extPath)} failed to load: ${error}` });
    }
    return { services, notices, trusted };
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(cwd);
    if (cached && Date.now() - cached.at < 60_000) return cached.models;
    const { services } = await this.services(cwd);
    const models = (await services.modelRuntime.getAvailable()).map((m) => toModelInfo(m as PiModel));
    this.modelCache.set(cwd, { at: Date.now(), models });
    return models;
  }

  /** Pi resolves thinking levels per model; LiveChat.getConfig() reports them. */
  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const { services, notices, trusted } = await this.services(req.cwd);
    const sessionDir = this.sessionDirFor(req.cwd, services.agentDir, trusted);
    let sessionManager: pi.SessionManager;
    if (req.resumeNativeId) {
      // Resume only an exact path returned by Pi's own listing.
      const info = (await pi.SessionManager.list(req.cwd, sessionDir)).find((s) => s.id === req.resumeNativeId);
      if (!info) throw new Error("Session not found in Pi's session list");
      sessionManager = pi.SessionManager.open(info.path, sessionDir);
    } else {
      sessionManager = pi.SessionManager.create(req.cwd, sessionDir);
    }
    const { session, modelFallbackMessage } = await pi.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: req.resumeNativeId ? "resume" : "startup" },
    });
    if (modelFallbackMessage) notices.push({ type: "notice", level: "warning", text: modelFallbackMessage });
    const chat = new PiLiveChat(session, services);
    for (const n of notices) chat.emitNow(n);
    await chat.init();
    return chat;
  }

  async shutdown(): Promise<void> {}
}

class PiLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private unsubscribe: () => void;
  private models: ModelInfo[] | null = null;

  constructor(
    private readonly session: AgentSession,
    private readonly services: Services,
  ) {
    this.unsubscribe = session.subscribe((event) => {
      for (const normalized of normalizeAgentEvent(event, "agent_settled")) this.hub.emit(normalized);
    });
  }

  emitNow(event: HarnessEvent): void {
    this.hub.emit(event);
  }

  /** Pi keeps its normal tool set (defaultTools plus extension tools); this host never narrows it. */
  async init(): Promise<void> {
    await this.session.bindExtensions({
      uiContext: this.uiContext(),
      mode: "rpc",
      onError: (err) =>
        this.hub.emit({ type: "notice", level: "error", text: `Extension error (${err.event}): ${err.error}` }),
    });
  }

  private dialog(kind: InteractionKind, fields: Partial<pi.ExtensionUIContext> & Record<string, unknown>, opts?: {
    signal?: AbortSignal;
    timeout?: number;
  }) {
    return this.dialogs.open(
      {
        id: randomUUID(),
        kind,
        title: String(fields.title ?? ""),
        createdAt: Date.now(),
        ...(typeof fields.message === "string" ? { message: fields.message } : {}),
        ...(Array.isArray(fields.options) ? { options: fields.options.map(String) } : {}),
        ...(typeof fields.placeholder === "string" ? { placeholder: fields.placeholder } : {}),
        ...(typeof fields.prefill === "string" ? { prefill: fields.prefill } : {}),
        ...(opts?.timeout ? { expiresAt: Date.now() + opts.timeout } : {}),
      },
      opts?.signal,
      opts?.timeout,
    );
  }

  /** The ExtensionUIContext Pi extensions see in this web host. */
  private uiContext(): pi.ExtensionUIContext {
    const hub = this.hub;
    let editorText = "";
    const ui = {
      select: async (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => {
        const a = await this.dialog("select", { title, options }, opts);
        return a?.kind === "select" ? a.value : undefined;
      },
      confirm: async (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
        const a = await this.dialog("confirm", { title, message }, opts);
        return a?.kind === "confirm" ? a.confirmed : false;
      },
      input: async (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) => {
        const a = await this.dialog("input", { title, ...(placeholder ? { placeholder } : {}) }, opts);
        return a?.kind === "input" ? a.value : undefined;
      },
      editor: async (title: string, prefill?: string) => {
        const a = await this.dialog("editor", { title, ...(prefill ? { prefill } : {}) });
        return a?.kind === "editor" ? a.value : undefined;
      },
      notify: (message: string, type?: "info" | "warning" | "error") =>
        hub.emit({ type: "notice", level: type ?? "info", text: message }),
      onTerminalInput: () => () => undefined,
      setStatus: (key: string, text: string | undefined) =>
        hub.emit({ type: "extension_status", key, text: text ?? null }),
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (key: string, content: unknown) => {
        if (content === undefined) hub.emit({ type: "extension_status", key: `widget:${key}`, text: null });
        else if (Array.isArray(content)) hub.emit({ type: "extension_status", key: `widget:${key}`, text: content.join("\n") });
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined,
      pasteToEditor: (text: string) => {
        editorText = text;
      },
      setEditorText: (text: string) => {
        editorText = text;
      },
      getEditorText: () => editorText,
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      get theme() {
        return plainTheme;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Themes are controlled by the web UI" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
    return ui as unknown as pi.ExtensionUIContext;
  }

  get nativeId(): string {
    return this.session.sessionId;
  }

  get title(): string | null {
    return this.session.sessionName ?? null;
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    return historyToItems(this.session.messages as unknown[]);
  }

  private async availableModels(): Promise<ModelInfo[]> {
    if (!this.models) {
      this.models = (await this.session.modelRuntime.getAvailable()).map((m) => toModelInfo(m as PiModel));
    }
    return this.models;
  }

  async refreshModels(): Promise<void> {
    // Catalogs and provider availability, network allowed; bounded so the button never hangs.
    const refresh = this.session.modelRuntime.refresh({ allowNetwork: true, force: true }).catch(() => undefined);
    await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, MODEL_REFRESH_MS).unref())]);
    this.models = null;
  }

  async getConfig(): Promise<ChatConfig> {
    const model = this.session.model as PiModel | undefined;
    return {
      model: model ? `${model.provider}/${model.id}` : null,
      thinkingLevel: this.session.supportsThinking() ? this.session.thinkingLevel : null,
      models: await this.availableModels(),
      thinkingLevels: this.session.supportsThinking() ? this.session.getAvailableThinkingLevels() : [],
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const usage = this.session.getContextUsage();
    if (!usage) return null;
    const categories = this.contextCategories();
    // Pi knows the real total only after a response (before that it says 0 or null,
    // though the prompt and tools are already there), so the estimate stands in.
    const known = usage.tokens !== null && usage.tokens > 0;
    const tokens = known ? (usage.tokens as number) : categories.reduce((sum, c) => sum + c.tokens, 0);
    const percent = known ? usage.percent : usage.contextWindow > 0 ? (tokens / usage.contextWindow) * 100 : null;
    return { tokens, window: usage.contextWindow, percent, categories };
  }

  /**
   * What fills the window, estimated: Pi has no breakdown of its own (`/context`
   * comes from an extension that draws in the terminal). The prompt and the
   * declared tools at ~4 chars a token; messages by Pi's own estimateTokens,
   * skipping the system messages that carry the prompt and tool declarations.
   */
  private contextCategories(): ContextCategory[] {
    const active = new Set(this.session.getActiveToolNames());
    const tools = this.session.agent.state.tools
      .filter((t) => active.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    let messages = 0;
    for (const m of this.session.messages) if ((m as { role?: string }).role !== "system") messages += pi.estimateTokens(m);
    return [
      { id: "system", label: "System prompt", tokens: estimateText(this.session.systemPrompt) },
      { id: "tools", label: "Tool definitions", tokens: estimateText(JSON.stringify(tools)) },
      { id: "messages", label: "Messages", tokens: messages },
    ];
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const s = this.session.getSessionStats();
    return {
      turns: s.userMessages,
      steps: s.assistantMessages,
      input: s.tokens.input,
      cachedInput: s.tokens.cacheRead,
      cacheWrite: s.tokens.cacheWrite,
      output: s.tokens.output,
      cost: s.cost > 0 ? s.cost : null,
    };
  }

  /** What Pi's own autocomplete offers: extension commands, prompt templates, skills (all run through prompt). */
  async listCommands(): Promise<SlashCommand[]> {
    const extensions = this.session.extensionRunner.getRegisteredCommands().map((c) => ({
      name: c.invocationName,
      ...(c.description ? { description: c.description } : {}),
      source: "extension",
    }));
    const prompts = this.session.promptTemplates.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.argumentHint ? { hint: t.argumentHint } : {}),
      source: "prompt",
    }));
    const skills = this.session.resourceLoader.getSkills().skills.map((s) => ({
      name: `skill:${s.name}`,
      ...(s.description ? { description: s.description } : {}),
      source: "skill",
    }));
    return [...extensions, ...prompts, ...skills];
  }

  /** Pi has no built-in todo list. */
  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.session.isIdle) throw new Error("Pi is busy");
    const piImages = toPiImages(images);
    await new Promise<void>((resolve, reject) => {
      let decided = false;
      const runPromise = this.session.prompt(text, {
        source: "rpc",
        ...(piImages ? { images: piImages } : {}),
        preflightResult: (ok) => {
          decided = true;
          if (ok) resolve();
          else reject(new Error("Pi did not accept the prompt"));
        },
      });
      runPromise.then(
        () => {
          if (!decided) resolve();
          // Extension commands can finish without an agent run; report idle anyway.
          if (this.session.isIdle) this.hub.emit({ type: "settled" });
        },
        (error: unknown) => {
          if (!decided) return reject(error instanceof Error ? error : new Error(String(error)));
          this.hub.emit({ type: "notice", level: "error", text: error instanceof Error ? error.message : String(error) });
          if (this.session.isIdle) this.hub.emit({ type: "settled" });
        },
      );
    });
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.session.steer(text, toPiImages(images), { source: "rpc" });
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.session.followUp(text, toPiImages(images), { source: "rpc" });
  }

  async abort(): Promise<void> {
    this.dialogs.cancelAll();
    this.session.clearQueue();
    await this.session.abort();
    if (this.session.isIdle) this.hub.emit({ type: "settled" });
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    if (patch.model !== undefined) {
      const models = await this.session.modelRuntime.getAvailable();
      const model = models.find((m) => `${(m as PiModel).provider}/${(m as PiModel).id}` === patch.model);
      if (!model) throw new Error("That model is not available in Pi");
      await this.session.setModel(model, { persist: false });
    }
    if (patch.thinkingLevel !== undefined) {
      const levels = this.session.getAvailableThinkingLevels() as string[];
      if (!levels.includes(patch.thinkingLevel)) throw new Error("That thinking level is not available for this model");
      this.session.setThinkingLevel(patch.thinkingLevel as Parameters<AgentSession["setThinkingLevel"]>[0], {
        persist: false,
      });
    }
  }

  async rename(name: string): Promise<void> {
    this.session.setSessionName(name);
  }

  async compact(instructions?: string): Promise<void> {
    await this.session.compact(instructions);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    return this.dialogs.answer(requestId, answer);
  }

  async dispose(): Promise<void> {
    this.dialogs.cancelAll();
    this.unsubscribe();
    this.hub.clear();
    // As Pi's own runtime does on quit: extensions stop what they started
    // (language servers, MCP servers, background tasks); session.dispose() alone does not tell them.
    const runner = this.session.extensionRunner;
    if (runner.hasHandlers("session_shutdown")) {
      const shutdown = runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
      await Promise.race([shutdown, new Promise((resolve) => setTimeout(resolve, EXTENSION_SHUTDOWN_MS).unref())]);
    }
    this.session.dispose();
    void this.services;
  }
}
