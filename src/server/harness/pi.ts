// Pi adapter: child-process through `pi --mode rpc` (line-delimited JSON on
// stdio). Pi stays the source of truth for models, auth, settings, resources,
// trust decisions, and session files; this module only translates. Driving the
// CLI instead of the pinned SDK means the user's `pi update` flows through and
// no lockfile pin can skew the session format.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
  type QueueState,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { historyToItems, isObj, normalizeAgentEvent, type Obj } from "./agent-events.js";
import { PendingRequests, terminateChild } from "./child-process.js";
import { seedTranscript, toolRecordText, type HandoffSeed } from "./handoff.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEventListener,
  HarnessUsage,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
} from "./types.js";

const run = promisify(execFile);
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** How long the RPC ready handshake may take. */
const READY_TIMEOUT_MS = 30_000;

/** Mirrors pi's getDefaultAgentDir: env override, else ~/.pi/agent. */
function defaultAgentDir(home = process.env.HOME ?? ""): string {
  const env = process.env[AGENT_DIR_ENV];
  if (env) return env;
  return path.join(home, ".pi", "agent");
}

/** Mirrors pi's getDefaultSessionDirPath: `--<cwd with /:\ replaced>--` under the agent dir. */
function defaultSessionDir(cwd: string, agentDir: string): string {
  const safe = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(agentDir, "sessions", safe);
}

/** Session header + per-line entries of one Pi .jsonl file (torn last lines skipped). */
async function readSessionFile(file: string): Promise<{ header: Obj | null; entries: Obj[] }> {
  const text = await fs.readFile(file, "utf8");
  const entries: Obj[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isObj(entry)) entries.push(entry);
    } catch {
      // A torn last line from a crashed write; the rest still parses.
    }
  }
  const header = entries.length > 0 && entries[0]?.type === "session" ? (entries[0] as Obj) : null;
  return { header, entries };
}

interface SessionMeta {
  id: string;
  path: string;
  cwd: string;
  name: string;
  firstMessage: string;
  messageCount: number;
  modified: Date;
}

function textContent(message: Obj): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isObj(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** Mirrors pi's buildSessionInfo: header, latest session_info name, user/assistant text scan. */
async function sessionMeta(file: string): Promise<SessionMeta | null> {
  let parsed: { header: Obj | null; entries: Obj[] };
  try {
    parsed = await readSessionFile(file);
  } catch {
    return null;
  }
  const { header, entries } = parsed;
  if (!header || typeof header.id !== "string") return null;
  let name = "";
  let firstMessage = "";
  let messageCount = 0;
  let lastActivity = 0;
  for (const entry of entries) {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) name = entry.name.trim();
    if (entry.type !== "message" || !isObj(entry.message)) continue;
    messageCount += 1;
    const rawTs = entry.timestamp;
    const ts = typeof rawTs === "number" ? rawTs : Date.parse(String(rawTs ?? ""));
    if (Number.isFinite(ts)) lastActivity = Math.max(lastActivity, ts as number);
    const role = entry.message.role;
    if ((role === "user" || role === "assistant") && !firstMessage) {
      const text = textContent(entry.message);
      if (text) firstMessage = text;
    }
  }
  let statMtime: number;
  try {
    statMtime = (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
  return {
    id: header.id,
    path: file,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name,
    firstMessage,
    messageCount,
    modified: new Date(lastActivity || statMtime),
  };
}

async function listSessionFiles(dir: string): Promise<SessionMeta[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const meta = await sessionMeta(path.join(dir, name));
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function summarize(meta: SessionMeta): NativeSessionSummary {
  return {
    nativeId: meta.id,
    // "(no messages)" is Pi's label for a session whose first user message has no text.
    title: meta.name || (meta.firstMessage === "(no messages)" ? "" : meta.firstMessage.slice(0, 80)) || "Untitled",
    updatedAt: meta.modified,
    messageCount: meta.messageCount,
  };
}

/** Pi's thinking ladder, weakest first; "off" is not a level the picker shows. */
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface PiModelShape {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

/** Mirrors pi-ai's getSupportedThinkingLevels (that module is not re-exported here). */
function supportedLevels(m: PiModelShape): string[] {
  if (!m.reasoning) return [];
  return THINKING_LEVELS.filter((level) => {
    const mapped = m.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

function toModelInfo(m: unknown): ModelInfo | null {
  if (!isObj(m) || typeof m.provider !== "string" || typeof m.id !== "string") return null;
  const levels = supportedLevels(m as PiModelShape);
  return {
    key: `${m.provider}/${m.id}`,
    provider: m.provider,
    id: m.id,
    name: typeof m.name === "string" && m.name ? m.name : String(m.id),
    ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
    ...(Array.isArray(m.input) ? { vision: (m.input as unknown[]).includes("image") } : {}),
    ...(levels.length > 0 ? { levels } : {}),
  };
}

/** One `pi --mode rpc` child: JSON-lines commands on stdin, responses + session events on stdout. */
class PiRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private stderrTail = "";
  exited = false;
  private exitListeners = new Set<(message: string) => void>();
  private readonly calls = new PendingRequests<string>(
    {
      formatId: (n) => String(n),
      encode: (id, payload) => ({ id, ...payload }),
      answeredId: (frame) => (frame.type === "response" && typeof frame.id === "string" ? frame.id : null),
      outcome: (frame) =>
        frame.success === true
          ? { value: frame.data }
          : { error: new Error(typeof frame.error === "string" ? frame.error : "pi command failed") },
    },
    (frame) => this.write(frame),
  );
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onEvent: (frame: Obj) => void) {
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    this.readyResolve = resolveReady;
    this.readyReject = rejectReady;
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    let up = false;
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(frame)) return;
      // rpc mode emits no ready frame; the first response or session event proves the child is up.
      if (!up) {
        up = true;
        this.readyResolve();
      }
      if (this.calls.accept(frame)) return;
      onEvent(frame);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    this.child.stdin.on("error", () => undefined);
    const onExit = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      const last = this.stderrTail.trim().split("\n").pop()?.slice(0, 300);
      const message = last ? `${detail}: ${last}` : detail;
      this.readyReject(new Error(message));
      this.calls.failAll(message);
      for (const l of this.exitListeners) l(message);
    };
    this.child.once("error", (error) => onExit(`could not start pi (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`pi exited (${signal ?? `code ${code}`})`));
    const timer = setTimeout(() => {
      if (!up) onExit("pi did not become ready");
    }, READY_TIMEOUT_MS);
    void this.ready.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  write(frame: Obj): void {
    if (this.exited) throw new Error("pi is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  command<T = unknown>(type: string, fields: Obj = {}, timeoutMs?: number | null): Promise<T> {
    return this.calls.send<T>({ type, ...fields }, `pi did not answer ${type}`, timeoutMs);
  }

  /** Fire-and-forget frame (UI answers); a dead child means the dialog died with it. */
  send(frame: Obj): void {
    try {
      this.write(frame);
    } catch {
      // The child is gone; its dialogs died with it.
    }
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}

/** Session entries of the active branch, oldest first (leaf walk like pi's getBranch). */
function activeBranch(entries: Obj[]): Obj[] {
  const byId = new Map<string, Obj>();
  for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
  let leaf: Obj | undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry && typeof entry.id === "string") {
      leaf = entry;
      break;
    }
  }
  const chain: Obj[] = [];
  const seen = new Set<string>();
  let current = leaf;
  while (current && typeof current.id === "string" && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    const parent = current.parentId;
    current = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  return chain;
}

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
    supportsFork: true,
    supportsHandoff: true,
  };
  private modelCache = new Map<string, { at: number; models: ModelInfo[] }>();

  async discover(): Promise<HarnessDiscovery> {
    const overrides = {
      PI_CODING_AGENT_DIR: process.env[AGENT_DIR_ENV] ? "set" : "unset",
      [SESSION_DIR_ENV]: process.env[SESSION_DIR_ENV] ? "set" : "unset",
    } as const;
    const warnings: string[] = [];
    let version: string;
    try {
      const { stdout } = await run(this.cliCommand, ["--version"], { timeout: 15_000 });
      version = stdout.trim().replace(/^v/, "");
    } catch {
      return {
        available: false,
        reason: "The pi CLI is not installed. Install pi, run it once, and log in.",
        warnings,
        overrides,
      };
    }
    // No SDK pin: the RPC child IS the installed CLI, so reader and writer are
    // the same binary by construction — the version-skew warning is obsolete.
    return { available: true, version, warnings, overrides };
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return process.env[AGENT_DIR_ENV] ?? defaultAgentDir();
  }

  private sessionDirFor(cwd: string, agentDir: string): string {
    const env = process.env[SESSION_DIR_ENV];
    if (env) return env === "~" || env.startsWith("~/") ? path.join(process.env.HOME ?? "", env.slice(1)) : env;
    return defaultSessionDir(cwd, agentDir);
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return this.sessionDirFor(cwd, await this.resolveAgentDir());
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const dir = this.sessionDirFor(cwd, await this.resolveAgentDir());
    const resolved = path.resolve(cwd);
    return (await listSessionFiles(dir))
      .filter((meta) => !meta.cwd || path.resolve(meta.cwd) === resolved)
      .map(summarize);
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const agentDir = await this.resolveAgentDir();
    let roots: string[];
    try {
      const entries = await fs.readdir(path.join(agentDir, "sessions"), { withFileTypes: true });
      roots = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(agentDir, "sessions", e.name));
    } catch {
      return [];
    }
    const all: SessionMeta[] = [];
    for (const root of roots) all.push(...(await listSessionFiles(root)));
    return all
      .filter((meta) => meta.cwd)
      .sort((a, b) => b.modified.getTime() - a.modified.getTime())
      .slice(0, limit)
      .map((meta) => ({ ...summarize(meta), cwd: meta.cwd }));
  }

  /**
   * Branch through the cut entry into a new file: ancestor chain through the
   * entry just before turn N+1's prompt, fresh header id, entry ids remapped so
   * the copy stands alone. Compaction references past the cut are dropped, like
   * forkSessionText does for the omp file shape.
   */
  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const dir = this.sessionDirFor(req.cwd, await this.resolveAgentDir());
    const meta = (await listSessionFiles(dir)).find((m) => m.id === req.nativeId);
    if (!meta) throw new Error("Session not found in Pi's session list");
    const { header, entries } = await readSessionFile(meta.path);
    if (!header) throw new Error("Session file has no header");
    const branch = activeBranch(entries);
    let target: Obj | undefined = branch[branch.length - 1];
    let turn = 0;
    for (let i = 0; i < branch.length; i += 1) {
      const entry = branch[i];
      if (!entry || entry.type !== "message" || !isObj(entry.message) || entry.message.role !== "user") continue;
      turn += 1;
      if (turn > req.throughTurns) {
        target = i > 0 ? branch[i - 1] : undefined;
        break;
      }
    }
    if (!target || typeof target.id !== "string") throw new Error("There is nothing before that turn to fork");
    const id = randomUUID();
    const kept: Obj[] = [];
    for (const entry of branch) {
      kept.push(entry);
      if (entry.id === target.id) break;
    }
    const remap = new Map<string, string>();
    for (const entry of kept) if (typeof entry.id === "string") remap.set(entry.id, randomUUID());
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const lines: string[] = [JSON.stringify({ ...header, id, parentSession: req.nativeId, timestamp: Date.now() })];
    for (const entry of kept) {
      const copy: Obj = { ...entry, id: remap.get(entry.id as string) };
      if (typeof entry.parentId === "string" && remap.has(entry.parentId)) copy.parentId = remap.get(entry.parentId);
      if (typeof copy.firstKeptEntryId === "string" && !remap.has(copy.firstKeptEntryId)) delete copy.firstKeptEntryId;
      lines.push(JSON.stringify(copy));
    }
    const targetPath = path.join(dir, `${stamp}_${id}.jsonl`);
    const tmp = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
    await fs.rename(tmp, targetPath);
    return { nativeId: id };
  }

  /**
   * Fresh session file with the seed's transcript recorded as entries, then
   * opened like any resumed session. Tool records arrive as plain transcript
   * text (a "Handed off" assistant message), never live tool state.
   */
  async seedChat(req: { cwd: string; seed: HandoffSeed }): Promise<LiveChat> {
    const dir = this.sessionDirFor(req.cwd, await this.resolveAgentDir());
    await fs.mkdir(dir, { recursive: true });
    const id = randomUUID();
    const now = Date.now();
    const lines: string[] = [JSON.stringify({ type: "session", id, cwd: path.resolve(req.cwd), timestamp: now })];
    let parent: string | null = null;
    const append = (message: Obj): void => {
      const entryId = randomUUID();
      lines.push(JSON.stringify({ type: "message", id: entryId, parentId: parent, message, timestamp: Date.now() }));
      parent = entryId;
    };
    if (req.seed.title) lines.push(JSON.stringify({ type: "session_info", id: randomUUID(), parentId: parent, name: req.seed.title, timestamp: Date.now() }));
    for (const entry of seedTranscript(req.seed)) {
      if (entry.role === "user") append({ role: "user", content: entry.text });
      else if (entry.role === "tool") append({ role: "assistant", content: [{ type: "text", text: toolRecordText(entry) }], stopReason: "stop" });
      else {
        const content: Obj[] = [];
        if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking });
        if (entry.text) content.push({ type: "text", text: entry.text });
        append({ role: "assistant", content, stopReason: "stop" });
      }
    }
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const targetPath = path.join(dir, `${stamp}_${id}.jsonl`);
    const tmp = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
    await fs.rename(tmp, targetPath);
    return this.openChat({ cwd: req.cwd, resumeNativeId: id });
  }

  private spawnEnv(cwd: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env[SESSION_DIR_ENV] ??= defaultSessionDir(cwd, process.env[AGENT_DIR_ENV] ?? defaultAgentDir());
    return env;
  }

  /** One throwaway `--no-session` child per workspace (cached) for models. */
  private async probeModels(cwd: string): Promise<ModelInfo[]> {
    const cached = this.modelCache.get(cwd);
    if (cached && Date.now() - cached.at < 60_000) return cached.models;
    const rpc = new PiRpc(
      this.cliCommand,
      ["--mode", "rpc", "--no-session", "--session-dir", this.sessionDirFor(cwd, await this.resolveAgentDir())],
      this.spawnEnv(cwd),
      cwd,
      () => undefined,
    );
    try {
      await rpc.ready;
      const data = await rpc.command<Obj>("get_available_models");
      const models = (Array.isArray(data?.models) ? data.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null);
      this.modelCache.set(cwd, { at: Date.now(), models });
      return models;
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    return this.probeModels(cwd);
  }

  /** Pi resolves thinking levels per model; LiveChat.getConfig() reports them. */
  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    if (req.resumeNativeId) {
      const dir = this.sessionDirFor(req.cwd, await this.resolveAgentDir());
      const found = (await listSessionFiles(dir)).some((m) => m.id === req.resumeNativeId);
      if (!found) throw new Error("Session not found in Pi's session list");
    }
    const args = ["--mode", "rpc", "--session-dir", this.sessionDirFor(req.cwd, await this.resolveAgentDir())];
    if (req.resumeNativeId) args.push("--session", req.resumeNativeId);
    const chat = new PiLiveChat(this.cliCommand, args, this.spawnEnv(req.cwd), req.cwd);
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {}
}

class PiLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private rpc: PiRpc | null = null;
  private queue: QueueState = { steering: [], followUp: [] };
  private models: ModelInfo[] | null = null;
  private sessionId: string | null = null;
  private sessionName: string | null = null;
  private disposed = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
  ) {}

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return this.sessionName;
  }

  private get live(): PiRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("pi is not running for this chat");
    return this.rpc;
  }

  /** Spawn `pi --mode rpc`; the session file is created on first prompt per pi's own flow. */
  async start(): Promise<void> {
    const rpc = new PiRpc(this.command, this.args, this.env, this.cwd, (frame) => this.onFrame(frame));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (this.disposed) return;
      this.dialogs.cancelAll();
      this.hub.emit({ type: "fatal", message: `pi stopped unexpectedly (${message})` });
    });
    try {
      await rpc.ready;
      const state = await rpc.command<Obj>("get_state");
      const sessionId = typeof state?.sessionId === "string" ? state.sessionId : null;
      this.sessionId = sessionId;
      this.sessionName = typeof state?.sessionName === "string" && state.sessionName ? state.sessionName : null;
      if (sessionId) this.hub.emit({ type: "session", nativeId: sessionId });
    } catch (error) {
      await rpc.kill().catch(() => undefined);
      throw error;
    }
  }

  private onFrame(frame: Obj): void {
    if (frame.type === "extension_ui_request") {
      this.onUiRequest(frame);
      return;
    }
    if (frame.type === "queue_update" && isObj(frame)) {
      const steering = Array.isArray(frame.steering) ? frame.steering.map(String) : undefined;
      const followUp = Array.isArray(frame.followUp) ? frame.followUp.map(String) : undefined;
      if (steering !== undefined || followUp !== undefined) {
        this.queue = { steering: steering ?? this.queue.steering, followUp: followUp ?? this.queue.followUp };
      }
    }
    if (typeof frame.sessionName === "string") this.sessionName = frame.sessionName;
    for (const event of normalizeAgentEvent(frame, "agent_settled")) {
      if (event.type === "queue") this.queue = event.queue;
      this.hub.emit(event);
    }
  }

  private onUiRequest(frame: Obj): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (!id) return;
    const method = frame.method;
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
      const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
      // The RPC frame id IS the hub request id, so answers route straight back.
      void this.dialogs.open(
        {
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
        undefined,
        timeout,
      );
      return;
    }
    switch (method) {
      case "cancel": {
        const target = String(frame.targetId ?? "");
        // The child cancelled its side already; settle ours as cancelled.
        if (this.dialogs.answer(target, { kind: "cancel" })) {
          this.hub.emit({ type: "request_cancelled", requestId: target, outcome: "cancelled" });
        }
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
      default:
        return;
    }
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    const data = await this.live.command<Obj>("get_messages");
    return historyToItems(Array.isArray(data?.messages) ? data.messages : []);
  }

  private async availableModels(): Promise<ModelInfo[]> {
    if (!this.models) {
      const data = await this.live.command<Obj>("get_available_models");
      this.models = (Array.isArray(data?.models) ? data.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null);
    }
    return this.models;
  }

  async refreshModels(): Promise<void> {
    // No refresh command on the wire; dropping the cache forces a re-read on next getConfig().
    this.models = null;
  }

  async getConfig(): Promise<ChatConfig> {
    const rpc = this.live;
    const state = await rpc.command<Obj>("get_state");
    const model = isObj(state?.model) ? state.model : null;
    const modelKey = model && typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : null;
    const levels = await rpc.command<Obj>("get_available_thinking_levels").catch(() => null);
    return {
      model: modelKey,
      thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
      models: await this.availableModels(),
      thinkingLevels: levels && Array.isArray(levels.levels) ? levels.levels.map(String) : [],
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const stats = await this.live.command<Obj>("get_session_stats").catch(() => null);
    const tokens = stats && isObj(stats.tokens) ? stats.tokens : null;
    if (!tokens) return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const used = n(tokens.input) + n(tokens.output) + n(tokens.cacheRead);
    const window = typeof tokens.contextWindow === "number" ? tokens.contextWindow : 0;
    if (!window) return { tokens: used || null, window: 0, percent: null };
    return { tokens: used || null, window, percent: (used / window) * 100 };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const stats = await this.live.command<Obj>("get_session_stats").catch(() => null);
    if (!stats) return null;
    const tokens = isObj(stats.tokens) ? stats.tokens : null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cost = n(stats.cost);
    return {
      turns: n(stats.userMessages),
      steps: n(stats.assistantMessages),
      input: tokens ? n(tokens.input) : 0,
      cachedInput: tokens ? n(tokens.cacheRead) : 0,
      cacheWrite: tokens ? n(tokens.cacheWrite) : 0,
      output: tokens ? n(tokens.output) : 0,
      cost: cost > 0 ? cost : null,
    };
  }

  /** Pi's RPC command list: extension commands, prompt templates, skills (all run through prompt). */
  async listCommands(): Promise<SlashCommand[]> {
    const data = await this.live.command<Obj>("get_commands").catch(() => null);
    const commands = data && Array.isArray(data.commands) ? data.commands : [];
    return commands.flatMap((c): SlashCommand[] => {
      if (!isObj(c) || typeof c.name !== "string") return [];
      return [
        {
          name: c.name,
          ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
          source: typeof c.source === "string" ? c.source : "extension",
        },
      ];
    });
  }

  /** Pi has no built-in todo list. */
  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    // The response resolves on preflight (acceptance); the run streams as events.
    // A "handled" disposition (slash command ran locally) still resolves: settle here.
    const data = await this.live.command<Obj>("prompt", {
      message: text,
      ...(images?.length ? { images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
    });
    if (isObj(data) && String(data.disposition ?? "") === "handled") this.hub.emit({ type: "settled" });
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.live.command("steer", {
      message: text,
      ...(images?.length ? { images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
    });
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.live.command("follow_up", {
      message: text,
      ...(images?.length ? { images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : {}),
    });
  }

  async abort(): Promise<void> {
    this.dialogs.cancelAll();
    const rpc = this.live;
    await rpc.command("clear_queue").catch(() => undefined);
    await rpc.command("abort").catch(() => undefined);
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    if (patch.model !== undefined) {
      const slash = patch.model.indexOf("/");
      if (slash <= 0) throw new Error("Model must be provider/id");
      await this.live.command("set_model", { provider: patch.model.slice(0, slash), modelId: patch.model.slice(slash + 1) });
      this.models = null;
    }
    if (patch.thinkingLevel !== undefined) {
      await this.live.command("set_thinking_level", { level: patch.thinkingLevel });
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
    if (!this.rpc || this.rpc.exited) return false;
    if (!this.dialogs.answer(requestId, answer)) return false;
    // DialogTracker already settled the hub promise; route the verdict to the child.
    const rpc = this.rpc;
    switch (answer.kind) {
      case "cancel":
        rpc.send({ type: "extension_ui_response", id: requestId, cancelled: true });
        break;
      case "confirm":
        rpc.send({ type: "extension_ui_response", id: requestId, confirmed: answer.confirmed });
        break;
      default:
        rpc.send({ type: "extension_ui_response", id: requestId, value: answer.value });
        break;
    }
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dialogs.cancelAll();
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill().catch(() => undefined);
  }
}
