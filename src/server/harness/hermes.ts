// Hermes adapter: newline-delimited JSON-RPC over stdio to a `hermes` gateway
// child (`<HERMES_PYTHON> -m tui_gateway.entry`), the same transport the Hermes
// TUI and its dashboard chat tab use. One child serves one live chat; probes
// for models and session rows use a short-lived child of their own.
//
// On the wire: client→server requests with an id, `event` notifications from
// the gateway, and server→client requests for human decisions (approval,
// clarify) that arrive as ordinary JSON-RPC requests with `srq-…` ids and are
// answered with ordinary JSON-RPC responses.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type ModelInfo,
  type TodoItem,
} from "../../shared/protocol.js";
import { boundText, stringifyArgs, toolCategory, toolPaths, toolSummary } from "./agent-events.js";
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
  StepUsage,
} from "./types.js";

const run = promisify(execFile);
const READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PROBE_TTL_MS = 60_000;
/** Hermes's effort ladder (agent/reasoning_effort.py); the route clamps to what it accepts. */
const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Epoch seconds (gateway) to epoch ms. */
const atMs = (v: unknown): number | undefined => {
  const seconds = num(v);
  return seconds === null ? undefined : Math.round(seconds * 1000);
};

interface GatewayRuntime {
  /** The interpreter that can import tui_gateway. */
  python: string;
  /** The environment the gateway runs in. */
  env: NodeJS.ProcessEnv;
  /** How it was found, for discovery warnings. */
  source: "HERMES_PYTHON" | "launcher" | "PATH";
}

/**
 * The Hermes TUI starts its gateway with `{ ...process.env }`, and it runs
 * under the `hermes` launcher, so the gateway inherits what that launcher sets
 * up: on Nix, HERMES_PYTHON, HERMES_BUNDLED_PLUGINS/SKILLS/LOCALES,
 * HERMES_INSTALL_ROOT, and a PYTHONPATH carrying plugin deps (mnemosyne). This
 * server is not started by the launcher, so it replays the launcher's setup
 * (everything before its final `exec`) once and captures the environment, the
 * way the dotfiles' hermes-python wrapper does at build time. An explicit
 * HERMES_PYTHON wins; anything that is not a shell wrapper falls back to python3.
 */
const runtimeCache = new Map<string, Promise<GatewayRuntime>>();
function gatewayRuntime(cliCommand: string): Promise<GatewayRuntime> {
  const explicit = process.env.HERMES_PYTHON?.trim();
  if (explicit) return Promise.resolve({ python: explicit, env: { ...process.env }, source: "HERMES_PYTHON" });
  let cached = runtimeCache.get(cliCommand);
  if (!cached) {
    cached = launcherRuntime(cliCommand);
    runtimeCache.set(cliCommand, cached);
  }
  return cached;
}

async function launcherRuntime(cliCommand: string): Promise<GatewayRuntime> {
  const fallback: GatewayRuntime = { python: process.platform === "win32" ? "python" : "python3", env: { ...process.env }, source: "PATH" };
  try {
    const { stdout } = await run("sh", ["-c", `command -v -- "$1"`, "sh", cliCommand], { timeout: 5_000 });
    const bin = stdout.trim().split("\n")[0];
    if (!bin) return fallback;
    const lines = (await fs.readFile(bin, "utf8")).trimEnd().split("\n");
    const shell = /^#!\s*(\S+)/.exec(lines[0] ?? "")?.[1];
    const last = lines[lines.length - 1] ?? "";
    if (!shell || !/^exec\s/.test(last.trim())) return fallback;
    const prelude = lines.slice(1, -1).join("\n");
    const { stdout: dump } = await run(shell, ["-c", `${prelude}\nenv -0`], { env: process.env, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    const env: NodeJS.ProcessEnv = {};
    for (const entry of dump.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const python = env.HERMES_PYTHON?.trim();
    return python ? { python, env, source: "launcher" } : fallback;
  } catch {
    return fallback;
  }
}

/** Every gateway child this process spawned; killed on shutdown and dropped on exit. */
const liveChildren = new Set<HermesRpc>();
function track(child: HermesRpc): HermesRpc {
  liveChildren.add(child);
  child.onExit(() => liveChildren.delete(child));
  return child;
}
/** Test seam: how many gateway children are alive. */
export function liveHermesChildren(): number {
  return liveChildren.size;
}

interface Frame {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Obj;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** JSON-RPC over one child's stdio: requests we send, events and server requests we receive. */
class HermesRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;
  exited = false;
  private exitListeners = new Set<(message: string) => void>();

  constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    private readonly onEvent: (params: Obj) => void,
    private readonly onRequest: (frame: Frame) => void,
  ) {
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const readyTimer = setTimeout(() => this.readyReject(new Error("hermes gateway did not become ready")), READY_TIMEOUT_MS);
    void this.ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        return;
      }
      if (frame.method === "event") {
        if (isObj(frame.params) && frame.params.type === "gateway.ready") {
          this.readyResolve();
          return;
        }
        if (isObj(frame.params)) this.onEvent(frame.params);
        return;
      }
      if (frame.id !== undefined && this.pending.has(String(frame.id))) {
        const entry = this.pending.get(String(frame.id));
        this.pending.delete(String(frame.id));
        if (entry) {
          clearTimeout(entry.timer);
          if (frame.error) entry.reject(new Error(frame.error.message ?? `hermes error ${frame.error.code ?? ""}`.trim()));
          else entry.resolve(frame.result);
        }
        return;
      }
      // No pending request matches: a server→client request (approval, clarify, …).
      if (frame.method && frame.id !== undefined) this.onRequest(frame);
    });
    this.child.stderr.on("data", () => undefined);
    this.child.stdin.on("error", () => undefined);
    const failed = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      this.readyReject(new Error(detail));
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(detail));
      }
      this.pending.clear();
      for (const listener of this.exitListeners) listener(detail);
    };
    this.child.once("error", (error) => failed(`could not start hermes (${error.message})`));
    this.child.once("exit", (code, signal) => failed(`hermes exited (${signal ?? `code ${code}`})`));
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  request<T = unknown>(method: string, params: Obj = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error("hermes is not running"));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hermes did not answer ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  /** Answer a server→client request (its id is the `srq-…` frame id). */
  respond(id: string | number, result: unknown): void {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(timer);
  }
}

/** One stored session row, as `projects.tree` reports it. */
interface StoredRow {
  id: string;
  title: string;
  cwd: string;
  lastActive: number | null;
  messageCount: number | null;
}

function toSummary(row: StoredRow): NativeSessionSummary {
  return {
    nativeId: row.id,
    title: row.title || "Untitled",
    updatedAt: row.lastActive === null ? null : new Date(row.lastActive * 1000),
    ...(row.messageCount !== null ? { messageCount: row.messageCount } : {}),
  };
}

function usageOf(raw: unknown): StepUsage | null {
  if (!isObj(raw)) return null;
  return {
    input: num(raw.input) ?? 0,
    output: num(raw.output) ?? 0,
    cacheRead: num(raw.cache_read) ?? 0,
    cacheWrite: num(raw.cache_write) ?? 0,
  };
}

/** Tool output as hermes stores it: a string, a `{content: […]}` block list, or JSON. */
function toolOutput(result: unknown): { text: string; truncated: boolean } {
  let text = "";
  if (typeof result === "string") text = result;
  else if (Array.isArray(result)) text = result.map((part) => (isObj(part) ? str(part.text) : String(part))).join("\n");
  else if (isObj(result)) {
    const content = result.content;
    if (Array.isArray(content)) text = content.map((part) => (isObj(part) ? str(part.text) : String(part))).join("\n");
    else if (typeof content === "string") text = content;
    else text = JSON.stringify(result, null, 2);
  } else if (result !== undefined && result !== null) text = String(result);
  return boundText(text);
}

/** Stored transcript rows (role/text/reasoning/tool) as display items. */
function transcriptItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    const at = atMs(raw.timestamp);
    switch (str(raw.role)) {
      case "user": {
        const text = str(raw.text);
        if (text) items.push({ kind: "user", id: randomUUID(), text, ...(at ? { at } : {}) });
        break;
      }
      case "assistant": {
        const text = str(raw.text);
        const thinking = str(raw.reasoning);
        if (text || thinking) items.push({ kind: "assistant", id: randomUUID(), text, thinking, streaming: false, ...(at ? { at, endedAt: at } : {}) });
        break;
      }
      case "tool": {
        const name = str(raw.name) || "tool";
        const { text, truncated } = toolOutput(raw.content ?? raw.result);
        items.push({
          kind: "tool",
          id: str(raw.tool_call_id) || randomUUID(),
          name,
          args: stringifyArgs(raw.args),
          status: "done",
          output: text,
          truncated,
          category: toolCategory(name),
          summary: toolSummary(raw.args) || str(raw.context) || "",
          paths: toolPaths(raw.args),
          ...(at ? { at, endedAt: at } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return items;
}

/** A dangerous-command approval the gateway is waiting on. */
interface PendingApproval {
  kind: "approval";
  requestId: string | number;
  choices: string[];
}
/** A clarify question set; answered once every question is resolved. */
interface PendingClarify {
  kind: "clarify";
  requestId: string | number;
  answers: Map<string, string | null>;
  open: Set<string>;
}
type PendingRequest = PendingApproval | PendingClarify;

class HermesLiveChat implements LiveChat {
  private listeners = new Set<HarnessEventListener>();
  private rpc: HermesRpc | null = null;
  private runtimeId: string | null = null;
  private storedId: string | null = null;
  private sessionTitle: string | null = null;
  private info: Obj = {};
  private usage: Obj = {};
  private todos: TodoItem[] = [];
  private models: ModelInfo[] | null = null;
  private turns = 0;
  private running = false;
  private disposed = false;
  private pending = new Map<string, PendingRequest>();

  constructor(
    private readonly adapter: HermesAdapter,
    private readonly cwd: string,
  ) {}

  get nativeId(): string | null {
    return this.storedId;
  }

  get title(): string | null {
    return this.sessionTitle;
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HarnessEvent): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener(event);
  }

  private get live(): HermesRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("hermes is not running for this chat");
    return this.rpc;
  }

  async start(resumeNativeId: string | null): Promise<void> {
    const { command, args, env } = await this.adapter.spawnSpec();
    const rpc = track(new HermesRpc(command, args, env, this.cwd, (params) => this.onEvent(params), (frame) => this.onRequest(frame)));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (!this.disposed) this.emit({ type: "fatal", message });
    });
    await rpc.ready;
    await rpc.request("client.capabilities", { server_requests: true });
    const result = resumeNativeId
      ? await rpc.request<Obj>("session.resume", { session_id: resumeNativeId, source: "webui" })
      : await rpc.request<Obj>("session.create", { cwd: this.cwd, source: "webui" });
    this.applySnapshot(result);
  }

  private applySnapshot(result: Obj): void {
    this.runtimeId = str(result.session_id) || this.runtimeId;
    this.storedId = str(result.stored_session_id) || str(isObj(result.info) ? result.info.stored_session_id : "") || this.storedId;
    this.applyInfo(isObj(result.info) ? result.info : {});
    if (isObj(result.todo_state)) this.todos = toTodos(result.todo_state.todos);
    if (this.storedId) this.emit({ type: "session", nativeId: this.storedId });
  }

  private applyInfo(info: Obj): void {
    this.info = { ...this.info, ...info };
    const title = str(info.title);
    if (title && title !== this.sessionTitle) {
      this.sessionTitle = title;
      this.emit({ type: "title", title });
    }
    if (isObj(info.usage)) this.usage = info.usage;
    const model = str(info.model);
    const provider = str(info.provider);
    if (model || provider) {
      this.emit({
        type: "config",
        config: {
          ...(model ? { model: provider ? `${provider}/${model}` : model } : {}),
          ...(str(info.reasoning_effort) ? { thinkingLevel: str(info.reasoning_effort) } : {}),
        },
      });
    }
    const wasRunning = this.running;
    this.running = info.running === true;
    if (this.running && !wasRunning) this.emit({ type: "busy" });
    // A turn that ends without `message.complete` (reclaimed session, crash) still settles the UI.
    if (!this.running && wasRunning) this.emit({ type: "settled" });
  }

  // ---- gateway events ---------------------------------------------------------

  private onEvent(params: Obj): void {
    const type = str(params.type);
    const p = isObj(params.payload) ? params.payload : {};
    switch (type) {
      case "message.start":
        this.emit({ type: "busy" });
        this.emit({ type: "assistant_start", ...(str(this.info.model) ? { model: str(this.info.model) } : {}) });
        break;
      case "message.delta": {
        const text = str(p.text);
        if (text) this.emit({ type: "assistant_delta", field: "text", delta: text });
        break;
      }
      case "reasoning.delta":
      case "thinking.delta": {
        const text = str(p.text);
        if (text) this.emit({ type: "assistant_delta", field: "thinking", delta: text });
        break;
      }
      case "message.interim": {
        const text = str(p.text);
        if (text && p.already_streamed !== true) this.emit({ type: "assistant_delta", field: "text", delta: text });
        break;
      }
      case "message.complete": {
        this.turns += 1;
        const status = str(p.status);
        const error = status === "error" ? str(p.error) || str(p.failure_reason) || "The run failed" : undefined;
        this.emit({
          type: "assistant_end",
          text: str(p.text),
          thinking: str(p.reasoning),
          ...(error ? { error } : {}),
          ...(usageOf(p.usage) ? { usage: usageOf(p.usage) as StepUsage } : {}),
        });
        this.emit({ type: "settled" });
        break;
      }
      case "tool.start": {
        const args = p.args ?? p.args_text ?? {};
        this.emit({ type: "tool_start", toolCallId: str(p.tool_id) || randomUUID(), name: str(p.name) || "tool", args });
        break;
      }
      case "tool.complete": {
        const output = toolOutput(p.result_text ?? p.result ?? p.summary);
        this.emit({
          type: "tool_end",
          toolCallId: str(p.tool_id) || randomUUID(),
          output: output.text,
          isError: p.is_error === true || (isObj(p.result) && p.result.is_error === true),
        });
        break;
      }
      case "todo.updated":
        this.todos = toTodos(p.todos);
        break;
      case "session.info":
        this.applyInfo(p);
        break;
      case "session.usage":
        if (isObj(p.usage)) this.usage = p.usage;
        break;
      case "session.title": {
        const title = str(p.title);
        if (title && title !== this.sessionTitle) {
          this.sessionTitle = title;
          this.emit({ type: "title", title });
        }
        break;
      }
      case "status.update": {
        const kind = str(p.kind);
        if (kind === "compacting" || kind === "compressing") this.emit({ type: "compacting", active: true });
        else if (kind === "compacted" || kind === "ready") this.emit({ type: "compacting", active: false });
        else if (kind === "status" && str(p.text)) this.emit({ type: "notice", level: "info", text: str(p.text) });
        break;
      }
      case "error":
        if (str(p.message)) this.emit({ type: "notice", level: "error", text: str(p.message) });
        break;
      case "notice":
        if (str(p.message)) this.emit({ type: "notice", level: "info", text: str(p.message) });
        break;
      case "notification.show":
        if (str(p.text)) this.emit({ type: "notice", level: p.level === "error" ? "error" : p.level === "warn" ? "warning" : "info", text: str(p.text) });
        break;
      case "approval.cancelled": {
        for (const id of Array.isArray(p.request_ids) ? p.request_ids.map(String) : []) {
          const request = this.pending.get(id);
          if (request) {
            this.pending.delete(id);
            this.emit({ type: "request_cancelled", requestId: id, outcome: str(p.reason) || "cancelled" });
          }
        }
        break;
      }
      case "request.cancel": {
        const id = str(p.id);
        if (this.pending.delete(id)) this.emit({ type: "request_cancelled", requestId: id, outcome: str(p.reason) || "cancelled" });
        break;
      }
      case "session.reclaimed":
        this.emit({ type: "notice", level: "warning", text: `Hermes reclaimed this session (${str(p.reason) || "idle"})` });
        break;
      default:
        break;
    }
  }

  // ---- server→client requests -------------------------------------------------

  private onRequest(frame: Frame): void {
    const id = frame.id as string | number;
    const params = isObj(frame.params) ? frame.params : {};
    switch (frame.method) {
      case "approval": {
        const requestId = str(params.request_id) || String(id);
        const choices = (Array.isArray(params.choices) ? params.choices : ["once", "deny"]).map(String);
        this.pending.set(requestId, { kind: "approval", requestId: id, choices });
        const command = str(params.command);
        const description = str(params.description);
        this.emit({
          type: "request",
          request: {
            id: requestId,
            kind: "select",
            title: `Approve ${str(params.tool_name) || "a command"}?`,
            ...(description || command ? { message: [description, command].filter(Boolean).join("\n\n") } : {}),
            options: choices,
            createdAt: Date.now(),
          },
        });
        break;
      }
      case "clarify": {
        const questions = Array.isArray(params.questions) ? params.questions.filter(isObj) : [];
        const group: PendingClarify = { kind: "clarify", requestId: id, answers: new Map(), open: new Set() };
        for (const question of questions) {
          const qid = str(question.qid);
          if (!qid) continue;
          group.open.add(qid);
          const choices = Array.isArray(question.choices) ? question.choices.map(String) : [];
          this.emit({
            type: "request",
            request: {
              id: `${String(id)}:${qid}`,
              kind: choices.length > 0 ? "select" : "input",
              title: str(question.question) || "Hermes needs an answer",
              ...(choices.length > 0 ? { options: choices } : {}),
              createdAt: Date.now(),
            },
          });
        }
        this.pending.set(String(id), group);
        break;
      }
      default: {
        // sudo, secret, vault prompts, previews, … — this client declines.
        this.live.respond(id, { value: "" });
        this.emit({ type: "notice", level: "warning", text: `Hermes asked for ${frame.method}; the web UI declined` });
        break;
      }
    }
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const direct = this.pending.get(requestId);
    if (direct?.kind === "approval") {
      this.pending.delete(requestId);
      this.live.respond(direct.requestId, { choice: approvalChoice(answer, direct.choices) });
      return true;
    }
    const [frameId, qid] = requestId.split(":");
    const group = frameId ? this.pending.get(frameId) : undefined;
    if (group?.kind === "clarify" && qid) {
      group.answers.set(qid, answer.kind === "select" || answer.kind === "input" || answer.kind === "editor" ? answer.value : null);
      group.open.delete(qid);
      if (group.open.size === 0) {
        this.pending.delete(frameId as string);
        this.live.respond(group.requestId, { answers: Object.fromEntries(group.answers) });
      }
      return true;
    }
    return false;
  }

  // ---- LiveChat ---------------------------------------------------------------

  async history(): Promise<ChatItem[]> {
    const id = this.runtimeId;
    if (!id) return [];
    const result = await this.live.request<Obj>("session.history", { session_id: id });
    return transcriptItems(Array.isArray(result?.messages) ? result.messages : []);
  }

  async getConfig(): Promise<ChatConfig> {
    const model = str(this.info.model);
    const provider = str(this.info.provider);
    return {
      model: model ? (provider ? `${provider}/${model}` : model) : null,
      thinkingLevel: str(this.info.reasoning_effort) || null,
      models: await this.modelList(),
      thinkingLevels: REASONING_LEVELS,
    };
  }

  private async modelList(): Promise<ModelInfo[]> {
    this.models ??= await this.adapter.listModels(this.cwd);
    return this.models;
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const used = num(this.usage.context_used);
    const max = num(this.usage.context_max);
    if (used === null || max === null || max <= 0) return null;
    return { tokens: used, window: max, percent: num(this.usage.context_percent) ?? Math.min(100, (used / max) * 100) };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const calls = num(this.usage.calls);
    if (calls === null && num(this.usage.input) === null) return null;
    return {
      turns: this.turns,
      steps: calls ?? 0,
      input: num(this.usage.input) ?? 0,
      cachedInput: num(this.usage.cache_read) ?? 0,
      cacheWrite: num(this.usage.cache_write) ?? 0,
      output: num(this.usage.output) ?? 0,
      cost: null,
    };
  }

  async getTodos(): Promise<TodoItem[]> {
    return this.todos;
  }

  async prompt(text: string, images: ImageAttachment[] = []): Promise<void> {
    const id = this.requireSession();
    for (const image of images) {
      await this.live.request("image.attach_bytes", { session_id: id, content_base64: image.data, filename: `pasted.${image.mimeType.split("/")[1] ?? "png"}` });
    }
    await this.live.request("prompt.submit", { session_id: id, text });
    // The gateway never echoes the user row, so the manager learns about it here.
    this.emit({ type: "user_message", text, ...(images.length > 0 ? { imageCount: images.length } : {}) });
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.prompt(text, images ?? []);
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.prompt(text, images ?? []);
  }

  async abort(): Promise<void> {
    const id = this.runtimeId;
    if (!id) return;
    await this.live.request("session.interrupt", { session_id: id });
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    const id = this.requireSession();
    if (patch.model !== undefined) {
      const result = await this.live.request<Obj>("config.set", { session_id: id, key: "model", value: patch.model, confirm_expensive_model: false });
      if (result?.confirm_required === true) throw new Error(str(result.confirm_message) || "That model needs confirmation");
      this.models = null;
    }
    if (patch.thinkingLevel !== undefined) {
      await this.live.request("config.set", { session_id: id, key: "reasoning", value: patch.thinkingLevel });
    }
  }

  async refreshModels(): Promise<void> {
    this.models = await this.adapter.listModels(this.cwd, true);
  }

  async rename(name: string): Promise<void> {
    const id = this.requireSession();
    await this.live.request("session.title", { session_id: id, title: name });
    this.sessionTitle = name;
  }

  async compact(instructions?: string): Promise<void> {
    const id = this.requireSession();
    await this.live.request("session.compress", { session_id: id, ...(instructions ? { focus_topic: instructions } : {}) });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const rpc = this.rpc;
    this.rpc = null;
    if (!rpc) return;
    if (this.runtimeId) await rpc.request("session.close", { session_id: this.runtimeId }).catch(() => undefined);
    await rpc.kill().catch(() => undefined);
  }

  private requireSession(): string {
    if (!this.runtimeId) throw new Error("This chat has no hermes session yet");
    return this.runtimeId;
  }
}

function approvalChoice(answer: InteractionAnswer, choices: string[]): string {
  if (answer.kind === "select") {
    const picked = choices.find((choice) => choice.toLowerCase() === answer.value.trim().toLowerCase());
    if (picked) return picked;
    if (choices.includes("once")) return "once";
    return "deny";
  }
  if (answer.kind === "confirm") return answer.confirmed ? (choices.includes("once") ? "once" : choices[0] ?? "once") : "deny";
  return "deny";
}

function toTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const text = str(entry.text) || str(entry.content) || str(entry.task);
    if (!text) continue;
    const status = str(entry.status);
    items.push({
      text,
      status: status === "completed" || status === "done" ? "completed" : status === "in_progress" || status === "running" ? "in_progress" : "pending",
    });
  }
  return items;
}

export class HermesAdapter implements HarnessAdapter {
  readonly id = asHarnessId("hermes");
  readonly displayName = "Hermes";
  readonly cliCommand = process.env.HERMES_BIN?.trim() || "hermes";
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    supportsExtensions: false,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
  };
  private probes = new Map<string, { at: number; models: ModelInfo[] }>();
  private rowCache: { at: number; rows: StoredRow[] } | null = null;

  constructor(private readonly options: { command?: string; args?: string[] } = {}) {}

  /** The interpreter, argv, and environment that run the gateway (tests point this at a script). */
  async spawnSpec(): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    if (this.options.command) return { command: this.options.command, args: this.options.args ?? [], env: { ...process.env } };
    const runtime = await gatewayRuntime(this.cliCommand);
    return { command: runtime.python, args: ["-m", "tui_gateway.entry"], env: runtime.env };
  }

  async discover(): Promise<HarnessDiscovery> {
    const warnings: string[] = [];
    try {
      const { stdout } = await run(this.cliCommand, ["--version"], { timeout: 15_000 });
      const version = stdout.trim().split("\n")[0]?.replace(/^Hermes Agent\s*/i, "") || "unknown";
      const runtime = await gatewayRuntime(this.cliCommand);
      if (runtime.source === "PATH") warnings.push("HERMES_PYTHON is not set and the hermes launcher does not export it; using python3 on PATH");
      return { available: true, version, warnings, overrides: { HERMES_HOME: process.env.HERMES_HOME ? "set" : "unset" } };
    } catch (error) {
      return {
        available: false,
        reason: `Cannot run ${this.cliCommand}: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
        overrides: {},
      };
    }
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
  }

  async resolveSessionDir(): Promise<string> {
    return path.join(await this.resolveAgentDir(), "sessions");
  }

  /** A throwaway gateway child: probes never touch a chat's session. */
  private async withProbe<T>(cwd: string, fn: (rpc: HermesRpc) => Promise<T>): Promise<T> {
    const { command, args, env } = await this.spawnSpec();
    const rpc = track(new HermesRpc(command, args, env, cwd, () => undefined, (frame) => rpc.respond(frame.id as string | number, { value: "" })));
    try {
      await rpc.ready;
      await rpc.request("client.capabilities", { server_requests: true });
      return await fn(rpc);
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  async listModels(cwd: string, refresh = false): Promise<ModelInfo[]> {
    const cached = this.probes.get(cwd);
    if (!refresh && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.models;
    const result = await this.withProbe(cwd, (rpc) => rpc.request<Obj>("model.options", refresh ? { refresh: true } : {}));
    const models: ModelInfo[] = [];
    for (const provider of Array.isArray(result?.providers) ? result.providers : []) {
      if (!isObj(provider)) continue;
      const slug = str(provider.slug);
      const capabilities = isObj(provider.capabilities) ? provider.capabilities : {};
      for (const model of Array.isArray(provider.models) ? provider.models : []) {
        const id = String(model);
        const capability = capabilities[id];
        models.push({ key: `${slug}/${id}`, provider: slug, id, name: id, ...(isObj(capability) && capability.reasoning === true ? { reasoning: true } : {}) });
      }
    }
    this.probes.set(cwd, { at: Date.now(), models });
    return models;
  }

  async listThinkingLevels(): Promise<string[]> {
    return REASONING_LEVELS;
  }

  /** Stored session rows across every project (one probe, cached briefly). */
  private async rows(cwd: string): Promise<StoredRow[]> {
    if (this.rowCache && Date.now() - this.rowCache.at < PROBE_TTL_MS) return this.rowCache.rows;
    const tree = await this.withProbe(cwd, (rpc) => rpc.request<Obj>("projects.tree", { preview_limit: 200 }));
    const rows: StoredRow[] = [];
    for (const project of Array.isArray(tree?.projects) ? tree.projects : []) {
      if (!isObj(project)) continue;
      for (const row of Array.isArray(project.previewSessions) ? project.previewSessions : []) {
        if (!isObj(row) || !str(row.id)) continue;
        const lastActive = num(row.last_active) ?? num(row.started_at);
        rows.push({
          id: str(row.id),
          title: str(row.title),
          cwd: str(row.cwd),
          lastActive,
          messageCount: num(row.message_count),
        });
      }
    }
    this.rowCache = { at: Date.now(), rows };
    return rows;
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const rows = await this.rows(cwd);
    return rows
      .filter((row) => row.cwd === cwd)
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .map(toSummary);
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const rows = await this.rows(homedir());
    return rows
      .filter((row) => row.cwd)
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, limit)
      .map((row) => ({ ...toSummary(row), cwd: row.cwd }));
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new HermesLiveChat(this, req.cwd);
    try {
      await chat.start(req.resumeNativeId ?? null);
    } catch (error) {
      await chat.dispose().catch(() => undefined);
      throw error;
    }
    return chat;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...liveChildren].map((child) => child.kill()));
  }
}
