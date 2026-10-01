// omp adapter. omp's SDK package requires Bun and ships raw .ts, so it cannot
// be imported into this Node server. Instead each live chat drives the
// installed `omp` binary in `--mode rpc-ui` (the mode with tool-approval and
// extension UI over the protocol) as one child process. omp's RPC mode has no
// session listing, so listing uses a short-lived `omp acp` process and ACP's
// `session/list`. Protocol types below are hand-written from omp 18.4.5's
// src/modes/rpc/rpc-types.ts and kept deliberately loose.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type HarnessCapabilities,
  type InteractionAnswer,
  type InteractionKind,
  type ModelInfo,
  type QueueState,
  type ToolsMode,
} from "../../shared/protocol.js";
import { historyToItems, normalizeAgentEvent } from "./agent-events.js";
import { EventHub } from "./event-hub.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEvent,
  HarnessEventListener,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
} from "./types.js";

const run = promisify(execFile);
export const OMP_PROTOCOL_VERSION_WRITTEN_FOR = "18.4.5";
/** Candidate read-only tools; intersected with the tools omp reports for the workspace. */
export const OMP_READ_ONLY_TOOLS = ["read", "grep", "find", "glob", "ast_grep", "ask", "think"];
/** Used only if omp does not report its tool list (dumpTools). */
const OMP_READ_ONLY_FALLBACK = ["read", "grep", "glob"];
const READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;
const LISTER_IDLE_MS = 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export interface OmpOptions {
  command?: string;
  agentDir: string | null;
  sessionDir: string | null;
  home: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * omp reads the same PI_* names as Pi. Values in the server's environment
 * belong to Pi and are stripped; omp overrides come from OMP_AGENT_DIR /
 * OMP_SESSION_DIR and are mapped onto omp's names for the child only.
 */
export function buildOmpEnv(base: NodeJS.ProcessEnv, agentDir: string | null, sessionDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.OMP_AGENT_DIR;
  delete env.OMP_SESSION_DIR;
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (sessionDir) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  return env;
}

// Every omp child this process spawned; killed on shutdown and on exit.
const children = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;
function track(child: ChildProcessWithoutNullStreams): void {
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const c of children) c.kill("SIGKILL");
    });
  }
}

export function liveOmpChildren(): number {
  return children.size;
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin.end();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}

/** JSON-lines RPC over a child's stdio, used for both rpc-ui and acp. */
class LineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = "";
  exited = false;
  private exitListeners = new Set<(message: string) => void>();

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onLine: (frame: Obj) => void) {
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    track(this.child);
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (isObj(frame)) onLine(frame);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    this.child.stdin.on("error", () => undefined);
    const onExit = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      const last = this.stderrTail.trim().split("\n").pop()?.slice(0, 300);
      for (const l of this.exitListeners) l(last ? `${detail}: ${last}` : detail);
    };
    this.child.once("error", (error) => onExit(`could not start omp (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`omp exited (${signal ?? `code ${code}`})`));
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  write(frame: Obj): void {
    if (this.exited) throw new Error("omp is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): Promise<void> {
    return terminate(this.child);
  }
}

/** One omp `--mode rpc-ui` process bound to one session. */
class OmpRpc {
  private proc: LineProcess;
  private nextId = 1;
  private pending = new Map<string, { resolve: (data: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onEvent: (frame: Obj) => void, onExit: (m: string) => void) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.proc = new LineProcess(command, args, env, cwd, (frame) => {
      if (frame.type === "ready") return this.readyResolve();
      if (frame.type === "response" && typeof frame.id === "string" && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        if (entry?.timer) clearTimeout(entry.timer);
        if (frame.success === true) entry?.resolve(frame.data);
        else entry?.reject(new Error(typeof frame.error === "string" ? frame.error : "omp command failed"));
        return;
      }
      onEvent(frame);
    });
    const timer = setTimeout(() => this.readyReject(new Error("omp did not become ready")), READY_TIMEOUT_MS);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.proc.onExit((message) => {
      this.readyReject(new Error(message));
      for (const entry of this.pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error(message));
      }
      this.pending.clear();
      onExit(message);
    });
  }

  get exited(): boolean {
    return this.proc.exited;
  }

  command<T = unknown>(type: string, fields: Obj = {}, timeoutMs: number | null = COMMAND_TIMEOUT_MS): Promise<T> {
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve: (d: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = {
        resolve: resolve as (d: unknown) => void,
        reject,
      };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`omp did not answer ${type}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        this.proc.write({ id, type, ...fields });
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error as Error);
      }
    });
  }

  send(frame: Obj): void {
    this.proc.write(frame);
  }

  kill(): Promise<void> {
    return this.proc.kill();
  }
}

/** Lazily started `omp acp` used only for ACP `session/list`. */
class AcpLister {
  private proc: LineProcess | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly command: string, private readonly env: () => NodeJS.ProcessEnv, private readonly cwd: string) {}

  private call(method: string, params: Obj): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("omp acp is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp acp did not answer ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      proc.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private start(): Promise<void> {
    if (this.proc && !this.proc.exited && this.initialized) return this.initialized;
    this.proc = new LineProcess(this.command, ["acp"], this.env(), this.cwd, (frame) => {
      if (typeof frame.id !== "number") return;
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (isObj(frame.error)) entry.reject(new Error(String(frame.error.message ?? "ACP error")));
      else entry.resolve(frame.result);
    });
    this.proc.onExit((message) => {
      for (const entry of this.pending.values()) entry.reject(new Error(message));
      this.pending.clear();
      this.proc = null;
      this.initialized = null;
    });
    this.initialized = this.call("initialize", { protocolVersion: 1, clientCapabilities: {} }).then(() => undefined);
    return this.initialized;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), LISTER_IDLE_MS);
    this.idleTimer.unref();
  }

  list(cwd: string): Promise<NativeSessionSummary[]> {
    const job = this.chain.then(async () => {
      await this.start();
      this.touch();
      const out: NativeSessionSummary[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = (await this.call("session/list", { cwd, ...(cursor ? { cursor } : {}) })) as Obj;
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        for (const s of sessions) {
          if (!isObj(s) || typeof s.sessionId !== "string") continue;
          if (typeof s.cwd === "string" && s.cwd !== cwd) continue;
          const meta = isObj(s._meta) ? s._meta : {};
          out.push({
            nativeId: s.sessionId,
            title: typeof s.title === "string" && s.title ? s.title : "Untitled",
            updatedAt: typeof s.updatedAt === "string" ? new Date(s.updatedAt) : null,
            ...(typeof meta.messageCount === "number" ? { messageCount: meta.messageCount } : {}),
          });
        }
        cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      this.touch();
      return out;
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const proc = this.proc;
    this.proc = null;
    this.initialized = null;
    await proc?.kill();
  }
}

function toModelInfo(m: unknown): ModelInfo | null {
  if (!isObj(m) || typeof m.provider !== "string" || typeof m.id !== "string") return null;
  return {
    key: `${m.provider}/${m.id}`,
    provider: m.provider,
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
  };
}

export class OmpAdapter implements HarnessAdapter {
  readonly id = asHarnessId("omp");
  readonly displayName = "omp";
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsReadOnlyTools: true,
    supportsCompact: true,
    supportsExtensions: true,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
  };
  private lister: AcpLister;
  private probeCache = new Map<string, { at: number; models: ModelInfo[]; levels: string[]; tools: string[] }>();

  constructor(private readonly options: OmpOptions) {
    this.cliCommand = options.command ?? "omp";
    this.lister = new AcpLister(this.cliCommand, () => this.env(), options.home);
  }

  env(): NodeJS.ProcessEnv {
    return buildOmpEnv(this.options.env ?? process.env, this.options.agentDir, this.options.sessionDir);
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = {
      OMP_AGENT_DIR: this.options.agentDir ? "set" : "unset",
      OMP_SESSION_DIR: this.options.sessionDir ? "set" : "unset",
    } as const;
    const warnings: string[] = [];
    try {
      const { stdout } = await run(this.cliCommand, ["--version"], { timeout: 15_000, env: this.env() });
      const version = stdout.trim().replace(/^omp\//, "").replace(/^v/, "");
      if (version !== OMP_PROTOCOL_VERSION_WRITTEN_FOR) {
        warnings.push(`omp ${version} is installed; this adapter's protocol types were written for ${OMP_PROTOCOL_VERSION_WRITTEN_FOR}`);
      }
      return { available: true, version, warnings, overrides };
    } catch {
      return {
        available: false,
        reason: "The omp CLI is not installed. Install omp, run it once, and log in.",
        warnings,
        overrides,
      };
    }
  }

  workspaceProblem(cwd: string): string | null {
    if (path.resolve(cwd) === path.resolve(this.options.home)) {
      return "omp refuses to work in the home directory itself (it would switch to a temp dir). Pick a project folder.";
    }
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return this.options.agentDir ?? path.join(this.options.home, ".omp", "agent");
  }

  async resolveSessionDir(): Promise<string> {
    return this.options.sessionDir ?? path.join(await this.resolveAgentDir(), "sessions");
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    return this.lister.list(cwd);
  }

  /**
   * One throwaway `--no-session` child per workspace (cached): models, thinking
   * levels, and the tool names omp actually offers there. omp rejects unknown
   * names in --tools, so read-only mode must only list tools that exist.
   */
  private async probe(cwd: string): Promise<{ models: ModelInfo[]; levels: string[]; tools: string[] }> {
    const cached = this.probeCache.get(cwd);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
    const rpc = new OmpRpc(this.cliCommand, ["--mode", "rpc-ui", "--no-session", "--cwd", cwd], this.env(), cwd, () => undefined, () => undefined);
    try {
      await rpc.ready;
      const models = await rpc.command<Obj>("get_available_models");
      const levels = await rpc.command<Obj>("get_available_thinking_levels");
      const state = await rpc.command<Obj>("get_state");
      const tools = Array.isArray(state?.dumpTools)
        ? state.dumpTools.map((t) => (isObj(t) && typeof t.name === "string" ? t.name : "")).filter(Boolean)
        : [];
      const result = {
        at: Date.now(),
        tools,
        models: (Array.isArray(models?.models) ? models.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null),
        levels: Array.isArray(levels?.levels) ? levels.levels.map(String) : [],
      };
      this.probeCache.set(cwd, result);
      return result;
    } finally {
      await rpc.kill();
    }
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    return (await this.probe(cwd)).models;
  }

  async listThinkingLevels(cwd: string): Promise<string[]> {
    return (await this.probe(cwd)).levels;
  }

  async readOnlyTools(cwd: string): Promise<string[]> {
    const { tools } = await this.probe(cwd);
    if (tools.length === 0) return OMP_READ_ONLY_FALLBACK;
    return OMP_READ_ONLY_TOOLS.filter((t) => tools.includes(t));
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const problem = this.workspaceProblem(req.cwd);
    if (problem) throw new Error(problem);
    const chat = new OmpLiveChat(this.cliCommand, () => this.env(), req.cwd, req.toolsMode, () => this.readOnlyTools(req.cwd));
    await chat.start(req.resumeNativeId ?? null);
    return chat;
  }

  async shutdown(): Promise<void> {
    await this.lister.stop();
  }
}

interface OpenDialog {
  kind: InteractionKind;
}

class OmpLiveChat implements LiveChat {
  private hub = new EventHub();
  private rpc: OmpRpc | null = null;
  private generation = 0;
  private dialogs = new Map<string, OpenDialog>();
  private queue: QueueState = { steering: [], followUp: [] };
  private models: ModelInfo[] | null = null;
  private sessionId: string | null = null;
  private sessionName: string | null = null;
  private hasMessages = false;
  private disposed = false;

  constructor(
    private readonly command: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly cwd: string,
    private toolsMode: ToolsMode,
    private readonly readOnlyTools: () => Promise<string[]>,
  ) {}

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return this.sessionName;
  }

  private get live(): OmpRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("omp is not running for this chat");
    return this.rpc;
  }

  /** Spawn (or respawn) the omp child; events from older children are ignored. */
  async start(resumeId: string | null): Promise<void> {
    const generation = ++this.generation;
    const args = ["--mode", "rpc-ui", "--cwd", this.cwd];
    if (resumeId) args.push("--resume", resumeId);
    if (this.toolsMode === "readOnly") args.push("--tools", (await this.readOnlyTools()).join(","));
    const rpc = new OmpRpc(
      this.command,
      args,
      this.env(),
      this.cwd,
      (frame) => {
        if (generation === this.generation) this.onFrame(frame);
      },
      (message) => {
        if (generation !== this.generation || this.disposed) return;
        this.cancelDialogs();
        this.hub.emit({ type: "fatal", message: `omp stopped unexpectedly (${message})` });
      },
    );
    this.rpc = rpc;
    try {
      await rpc.ready;
      const state = await rpc.command<Obj>("get_state");
      const sessionId = typeof state?.sessionId === "string" ? state.sessionId : null;
      if (resumeId && sessionId !== resumeId) throw new Error("omp opened a different session than requested");
      this.sessionId = sessionId;
      this.sessionName = typeof state?.sessionName === "string" && state.sessionName ? state.sessionName : null;
      this.hasMessages = typeof state?.messageCount === "number" && state.messageCount > 0;
      if (sessionId) this.hub.emit({ type: "session", nativeId: sessionId });
    } catch (error) {
      await rpc.kill();
      throw error;
    }
  }

  private onFrame(frame: Obj): void {
    switch (frame.type) {
      case "extension_ui_request":
        this.onUiRequest(frame);
        return;
      case "prompt_result": {
        if (frame.status === "error" && isObj(frame.error) && typeof frame.error.message === "string") {
          this.hub.emit({ type: "notice", level: "error", text: frame.error.message });
        }
        if (frame.sessionSettled === true) this.hub.emit({ type: "settled" });
        return;
      }
      case "extension_error":
        this.hub.emit({ type: "notice", level: "error", text: `Extension error: ${String(frame.error ?? "unknown")}` });
        return;
      case "queue_update":
        this.queue = {
          steering: Array.isArray(frame.steering) ? frame.steering.map(String) : [],
          followUp: Array.isArray(frame.followUp) ? frame.followUp.map(String) : [],
        };
        break;
      case "message_start":
        this.hasMessages = true;
        break;
      case "session_info_changed":
        if (typeof frame.name === "string") this.sessionName = frame.name;
        break;
      default:
        break;
    }
    for (const event of normalizeAgentEvent(frame, "session_settled")) this.hub.emit(event);
  }

  private onUiRequest(frame: Obj): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (!id) return;
    const method = frame.method;
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
      const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
      this.dialogs.set(id, { kind: method });
      this.hub.emit({
        type: "request",
        request: {
          id,
          kind: method,
          title: String(frame.title ?? ""),
          createdAt: Date.now(),
          ...(typeof frame.message === "string" ? { message: frame.message } : {}),
          ...(Array.isArray(frame.options) ? { options: frame.options.map(String) } : {}),
          ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
          ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
          ...(timeout ? { expiresAt: Date.now() + timeout } : {}),
        },
      });
      return;
    }
    switch (method) {
      case "cancel": {
        const target = String(frame.targetId ?? "");
        if (this.dialogs.delete(target)) this.hub.emit({ type: "request_cancelled", requestId: target, outcome: "cancelled" });
        return;
      }
      case "notify": {
        const level = frame.notifyType === "error" || frame.notifyType === "warning" ? frame.notifyType : "info";
        this.hub.emit({ type: "notice", level, text: String(frame.message ?? "") });
        return;
      }
      case "setStatus":
        this.hub.emit({
          type: "extension_status",
          key: String(frame.statusKey ?? "status"),
          text: typeof frame.statusText === "string" ? frame.statusText : null,
        });
        return;
      case "setWidget":
        this.hub.emit({
          type: "extension_status",
          key: `widget:${String(frame.widgetKey ?? "widget")}`,
          text: Array.isArray(frame.widgetLines) ? frame.widgetLines.map(String).join("\n") : null,
        });
        return;
      case "open_url":
        this.hub.emit({
          type: "notice",
          level: "info",
          text: `omp asks to open ${String(frame.url ?? "a URL")}${frame.instructions ? ` — ${String(frame.instructions)}` : ""}`,
        });
        return;
      default:
        return;
    }
  }

  private respond(id: string, fields: Obj): void {
    try {
      this.rpc?.send({ type: "extension_ui_response", id, ...fields });
    } catch {
      // The child is gone; its dialogs died with it.
    }
  }

  private cancelDialogs(): void {
    for (const id of [...this.dialogs.keys()]) {
      this.dialogs.delete(id);
      this.respond(id, { cancelled: true });
      this.hub.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
    }
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    const data = await this.live.command<Obj>("get_messages");
    return historyToItems(Array.isArray(data?.messages) ? data.messages : []);
  }

  async getConfig(): Promise<ChatConfig> {
    const rpc = this.live;
    const state = await rpc.command<Obj>("get_state");
    if (!this.models) {
      const data = await rpc.command<Obj>("get_available_models");
      this.models = (Array.isArray(data?.models) ? data.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null);
    }
    const levels = await rpc.command<Obj>("get_available_thinking_levels");
    const model = toModelInfo(state?.model);
    return {
      model: model?.key ?? null,
      thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
      toolsMode: this.toolsMode,
      models: this.models,
      thinkingLevels: Array.isArray(levels?.levels) ? levels.levels.map(String) : [],
    };
  }

  async prompt(text: string): Promise<void> {
    await this.live.command("prompt", { message: text });
  }

  async steer(text: string): Promise<void> {
    await this.live.command("steer", { message: text });
  }

  async followUp(text: string): Promise<void> {
    await this.live.command("follow_up", { message: text });
  }

  async abort(): Promise<void> {
    this.cancelDialogs();
    const rpc = this.live;
    for (const message of this.queue.steering) await rpc.command("remove_queued_message", { message, queue: "steering" }).catch(() => undefined);
    for (const message of this.queue.followUp) await rpc.command("remove_queued_message", { message, queue: "followUp" }).catch(() => undefined);
    await rpc.command("abort");
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string; toolsMode?: ToolsMode }): Promise<void> {
    if (patch.model !== undefined) {
      const slash = patch.model.indexOf("/");
      if (slash <= 0) throw new Error("Model must be provider/id");
      await this.live.command("set_model", { provider: patch.model.slice(0, slash), modelId: patch.model.slice(slash + 1) });
    }
    if (patch.thinkingLevel !== undefined) {
      await this.live.command("set_thinking_level", { level: patch.thinkingLevel });
    }
    if (patch.toolsMode !== undefined && patch.toolsMode !== this.toolsMode) {
      // omp's RPC has no tool-set command; restart the child on the same session
      // with the new --tools list. Only valid while idle (enforced by Chat).
      this.toolsMode = patch.toolsMode;
      const resumeId = this.hasMessages ? this.sessionId : null;
      const old = this.rpc;
      this.rpc = null;
      await old?.kill();
      await this.start(resumeId);
    }
  }

  async rename(name: string): Promise<void> {
    await this.live.command("set_session_name", { name });
    this.sessionName = name;
  }

  async compact(instructions?: string): Promise<void> {
    await this.live.command("compact", instructions ? { customInstructions: instructions } : {}, null);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const dialog = this.dialogs.get(requestId);
    if (!dialog || !this.rpc || this.rpc.exited) return false;
    this.dialogs.delete(requestId);
    switch (answer.kind) {
      case "cancel":
        this.respond(requestId, { cancelled: true });
        break;
      case "confirm":
        this.respond(requestId, { confirmed: answer.confirmed });
        break;
      default:
        this.respond(requestId, { value: answer.value });
        break;
    }
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelDialogs();
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill();
  }
}

export type { HarnessEvent };
