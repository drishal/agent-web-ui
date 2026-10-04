// omp adapter. omp's SDK package requires Bun and ships raw .ts, so it cannot
// be imported into this Node server. Instead each live chat drives the
// installed `omp` binary in `--mode rpc-ui` (the mode with tool-approval and
// extension UI over the protocol) as one child process. omp's RPC mode has no
// session listing, so listing uses a short-lived `omp acp` process and ACP's
// `session/list`. Protocol types below are hand-written from omp 18.4.5's
// src/modes/rpc/rpc-types.ts and kept deliberately loose; 18.4.10 only adds
// commands and an opt-in `ask` dialog, so nothing used here changed.
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
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
  type ModelInfo,
  type QueueState,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { commandOutputEvents, historyToItems, normalizeAgentEvent } from "./agent-events.js";
import { forkSessionText, sessionFileTimestamp, uuidv7 } from "./session-files.js";
import { EventHub } from "./event-hub.js";
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
export const OMP_PROTOCOL_VERSION_WRITTEN_FOR = "18.4.10";
const READY_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;
const LISTER_IDLE_MS = 60_000;
const CONTEXT_REPORT_TIMEOUT_MS = 5_000;
/** omp's protocol v2 ceiling for one reassembled frame. */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const FIRST_PROMPT_BYTES = 64 * 1024;
/** omp's ACP `session/list` page size. */
const ACP_SESSION_PAGE = 50;

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

/**
 * omp's protocol v1 caps every stdout frame at 1 MiB: a bigger response fails
 * ("RPC response exceeded the transport limit"), so a long session's history
 * would not load, and a bigger event is trimmed. Protocol v2 sends such frames
 * as ordered `rpc_chunk` slices (base64, up to 64 MiB in all); this joins them.
 */
class ChunkJoiner {
  private pending: { id: string; count: number; byteLength: number; next: number; parts: Buffer[]; size: number } | null = null;

  /** The frame to handle, or null while a chunked one is incomplete (or turned out malformed). */
  push(frame: Obj): Obj | null {
    if (frame.type !== "rpc_chunk") {
      this.pending = null; // omp never interleaves; a broken sequence is dropped
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    const valid =
      typeof chunkId === "string" &&
      typeof data === "string" &&
      Number.isSafeInteger(index) &&
      Number.isSafeInteger(count) &&
      Number.isSafeInteger(byteLength) &&
      (byteLength as number) <= MAX_REASSEMBLED_BYTES;
    if (valid && index === 0) this.pending = { id: chunkId, count: count as number, byteLength: byteLength as number, next: 0, parts: [], size: 0 };
    const p = this.pending;
    if (!valid || !p || p.id !== chunkId || p.next !== index) {
      this.pending = null;
      return null;
    }
    const bytes = Buffer.from(data as string, "base64");
    p.parts.push(bytes);
    p.size += bytes.length;
    p.next += 1;
    if (p.next < p.count && p.size <= p.byteLength) return null;
    this.pending = null;
    if (p.next < p.count || p.size !== p.byteLength) return null;
    try {
      const whole: unknown = JSON.parse(Buffer.concat(p.parts).toString("utf8"));
      return isObj(whole) ? whole : null;
    } catch {
      return null;
    }
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
  private chunks = new ChunkJoiner();

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onEvent: (frame: Obj) => void, onExit: (m: string) => void) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.proc = new LineProcess(command, args, env, cwd, (line) => {
      const frame = this.chunks.push(line);
      if (!frame) return;
      if (frame.type === "ready") {
        const v2 = Array.isArray(frame.supportedProtocolVersions) && frame.supportedProtocolVersions.includes(2);
        if (!v2) return this.readyResolve();
        // Before anything else, so big responses and events arrive whole.
        void this.command("negotiate_protocol", { protocolVersion: 2 }, READY_TIMEOUT_MS).then(
          () => this.readyResolve(),
          () => this.readyResolve(),
        );
        return;
      }
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

  /** Sessions in `cwd`, or across every project (newest first) when it is omitted. */
  list(cwd?: string, maxPages = 20): Promise<RecentNativeSession[]> {
    const job = this.chain.then(async () => {
      await this.start();
      this.touch();
      const out: RecentNativeSession[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const result = (await this.call("session/list", { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) })) as Obj;
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        for (const s of sessions) {
          if (!isObj(s) || typeof s.sessionId !== "string") continue;
          if (cwd && typeof s.cwd === "string" && s.cwd !== cwd) continue;
          const sessionCwd = typeof s.cwd === "string" ? s.cwd : "";
          const meta = isObj(s._meta) ? s._meta : {};
          out.push({
            nativeId: s.sessionId,
            cwd: sessionCwd,
            title: typeof s.title === "string" ? s.title.trim() : "",
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
  const efforts = isObj(m.thinking) && Array.isArray(m.thinking.efforts) ? m.thinking.efforts.filter((l): l is string => typeof l === "string") : [];
  return {
    key: `${m.provider}/${m.id}`,
    provider: m.provider,
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
    ...(Array.isArray(m.input) ? { vision: m.input.includes("image") } : {}),
    ...(efforts.length > 0 ? { levels: efforts } : {}),
  };
}

/**
 * Categories from omp's own `/context` text (slash-commands/helpers/context-report.ts):
 * `  <label> [<bar>] <pct>%  <n> tokens`, the bar ANSI-coloured. Free space and the
 * auto-compact buffer are not usage.
 */
export function parseContextReport(text: string): ContextCategory[] | null {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (!/^Context window: \d+ tokens/m.test(plain)) return null;
  const categories: ContextCategory[] = [];
  for (const line of plain.split("\n")) {
    const m = /^ {2}(\S[^[]*?)\s+\[.*?\].*?\s(\d+) tokens$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const label = m[1].trim();
    if (label === "Free" || label.startsWith("Auto-compact")) continue;
    categories.push({ id: label.toLowerCase().replace(/[^a-z]+/g, "-"), label, tokens: Number(m[2]) });
  }
  return categories.length > 0 ? categories : null;
}

/** omp's RPC takes pi-ai ImageContent on prompt, steer, and follow_up. */
function withImages(message: string, images: ImageAttachment[] | undefined): Obj {
  return images?.length ? { message, images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : { message };
}

/** The first user prompt in an omp session file (JSONL), on one line, or null. */
export function firstPrompt(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"user"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the read window can cut the last line short
    }
    if (!isObj(entry) || entry.type !== "message" || !isObj(entry.message) || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join(" ")
          : "";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
  }
  return null;
}

/**
 * ACP `session/list` gives only omp's stored title, which stays empty when its
 * title generation never ran (a run that ended on tool calls, say). omp's own
 * picker then shows the first prompt; this does the same. Read-only: the first
 * 64 kB of `<sessionDir>/<cwd>/<time>_<id>.jsonl`, cached by file size.
 */
class FirstPrompts {
  private cache = new Map<string, { size: number; title: string | null }>();

  constructor(private readonly root: () => Promise<string>) {}

  async fill<T extends NativeSessionSummary>(sessions: T[]): Promise<T[]> {
    const untitled = sessions.filter((s) => !s.title);
    if (untitled.length > 0) {
      const files = await this.locate(new Set(untitled.map((s) => s.nativeId)));
      await Promise.all(
        untitled.map(async (s) => {
          const file = files.get(s.nativeId);
          s.title = (file ? await this.read(s.nativeId, file) : null) ?? "Untitled";
        }),
      );
    }
    return sessions;
  }

  private async locate(ids: Set<string>): Promise<Map<string, string>> {
    const root = await this.root();
    const found = new Map<string, string>();
    const dirs = await fs.readdir(root).catch(() => [] as string[]);
    await Promise.all(
      dirs.map(async (dir) => {
        for (const name of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
          const id = name.endsWith(".jsonl") ? name.slice(name.lastIndexOf("_") + 1, -".jsonl".length) : "";
          if (ids.has(id)) found.set(id, path.join(root, dir, name));
        }
      }),
    );
    return found;
  }

  private async read(id: string, file: string): Promise<string | null> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, "r");
      const { size } = await handle.stat();
      const cached = this.cache.get(id);
      if (cached && cached.size === size) return cached.title;
      const buf = Buffer.alloc(Math.min(size, FIRST_PROMPT_BYTES));
      await handle.read(buf, 0, buf.length, 0);
      const title = firstPrompt(buf.toString("utf8"));
      this.cache.set(id, { size, title });
      return title;
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
  }
}

export class OmpAdapter implements HarnessAdapter {
  readonly id = asHarnessId("omp");
  readonly displayName = "omp";
  readonly cliCommand: string;
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
  };
  private lister: AcpLister;
  private firstPrompts = new FirstPrompts(() => this.resolveSessionDir());
  private probeCache = new Map<string, { at: number; models: ModelInfo[]; levels: string[] }>();

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
    return this.firstPrompts.fill(await this.lister.list(cwd));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const pages = Math.max(1, Math.ceil(limit / ACP_SESSION_PAGE));
    return this.firstPrompts.fill((await this.lister.list(undefined, pages)).filter((s) => s.cwd).slice(0, limit));
  }

  /** The .jsonl of a session, across the store's per-project buckets. */
  private async sessionFile(nativeId: string): Promise<string | null> {
    const root = await this.resolveSessionDir();
    for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
      for (const name of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
        if (name.endsWith(".jsonl") && name.slice(name.lastIndexOf("_") + 1, -".jsonl".length) === nativeId) return path.join(root, dir, name);
      }
    }
    return null;
  }

  /**
   * omp has no entry-indexed fork (its CLI only copies whole sessions and its RPC
   * branch moves the leaf in place), so the copy is written here: same branch,
   * cut after the Nth user turn, fresh id in the header and file name.
   */
  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const file = await this.sessionFile(req.nativeId);
    if (!file) throw new Error(`omp session ${req.nativeId} is not on disk`);
    const source = await fs.readFile(file, "utf8");
    const id = uuidv7();
    const now = new Date();
    const body = forkSessionText(source, { throughTurns: req.throughTurns, id, now, cwd: req.cwd, parentSession: req.nativeId });
    const target = path.join(path.dirname(file), `${sessionFileTimestamp(now)}_${id}.jsonl`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, target);
    return { nativeId: id };
  }

  /** One throwaway `--no-session` child per workspace (cached) for models and thinking levels. */
  private async probe(cwd: string): Promise<{ models: ModelInfo[]; levels: string[] }> {
    const cached = this.probeCache.get(cwd);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
    const rpc = new OmpRpc(this.cliCommand, ["--mode", "rpc-ui", "--no-session", "--cwd", cwd], this.env(), cwd, () => undefined, () => undefined);
    try {
      await rpc.ready;
      const models = await rpc.command<Obj>("get_available_models");
      const levels = await rpc.command<Obj>("get_available_thinking_levels");
      const result = {
        at: Date.now(),
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

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const problem = this.workspaceProblem(req.cwd);
    if (problem) throw new Error(problem);
    const chat = new OmpLiveChat(this.cliCommand, () => this.env(), req.cwd);
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
  /** Whether /context is an omp builtin (checked once), the pending probe, and their queue. */
  private contextBuiltin: Promise<boolean> | null = null;
  private contextProbe: ((text: string) => void) | null = null;
  /** Output of a "/" command in flight, held until omp says whether it ran locally. */
  private commandOutput: string[] | null = null;
  private contextChain: Promise<unknown> = Promise.resolve();
  private models: ModelInfo[] | null = null;
  private sessionId: string | null = null;
  private sessionName: string | null = null;
  private disposed = false;

  constructor(
    private readonly command: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly cwd: string,
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

  /** Spawn the omp child with its normal tool set (no --tools); stale-child events are ignored. */
  async start(resumeId: string | null): Promise<void> {
    const generation = ++this.generation;
    const args = ["--mode", "rpc-ui", "--cwd", this.cwd];
    if (resumeId) args.push("--resume", resumeId);
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
      case "command_output":
        // Output of a builtin slash command: the context probe's, or one the user typed.
        if (this.contextProbe) this.contextProbe(String(frame.text ?? ""));
        else if (typeof frame.text === "string" && frame.text.trim()) {
          if (this.commandOutput) this.commandOutput.push(frame.text);
          else this.hub.emit({ type: "notice", level: "info", text: frame.text });
        }
        return;
      case "queue_update":
        this.queue = {
          steering: Array.isArray(frame.steering) ? frame.steering.map(String) : [],
          followUp: Array.isArray(frame.followUp) ? frame.followUp.map(String) : [],
        };
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

  /** omp has no refresh command; get_available_models waits for its own background refresh. */
  async refreshModels(): Promise<void> {
    this.models = null;
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
      models: this.models,
      thinkingLevels: Array.isArray(levels?.levels) ? levels.levels.map(String) : [],
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const state = await this.live.command<Obj>("get_state");
    const usage = state?.contextUsage;
    if (!isObj(usage) || typeof usage.contextWindow !== "number") return null;
    // Only while settled, so the probe can never land inside a run.
    const categories = state?.isSettled === true ? await this.contextReport() : null;
    return {
      tokens: typeof usage.tokens === "number" ? usage.tokens : null,
      window: usage.contextWindow,
      percent: typeof usage.percent === "number" ? usage.percent : null,
      ...(categories ? { categories } : {}),
    };
  }

  /**
   * omp's `/context` breakdown. RPC runs that builtin locally and answers with
   * `command_output` (agentInvoked: false), so no model is called; it is only
   * sent once get_available_commands confirms /context is a builtin.
   */
  private contextReport(): Promise<ContextCategory[] | null> {
    const job = this.contextChain.then(async () => {
      this.contextBuiltin ??= this.live.command<Obj>("get_available_commands").then(
        (data) => Array.isArray(data?.commands) && data.commands.some((c) => isObj(c) && c.name === "context" && c.source === "builtin"),
        () => false,
      );
      if (!(await this.contextBuiltin)) return null;
      const output = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), CONTEXT_REPORT_TIMEOUT_MS);
        this.contextProbe = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
      });
      try {
        await this.live.command("prompt", { message: "/context" });
        return parseContextReport((await output) ?? "");
      } finally {
        this.contextProbe = null;
      }
    });
    this.contextChain = job.catch(() => undefined);
    return job.catch(() => null);
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const stats = await this.live.command<Obj>("get_session_stats");
    const tokens = isObj(stats?.tokens) ? stats.tokens : null;
    if (!stats || !tokens) return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      turns: n(stats.userMessages),
      steps: n(stats.assistantMessages),
      input: n(tokens.input),
      cachedInput: n(tokens.cacheRead),
      cacheWrite: n(tokens.cacheWrite),
      output: n(tokens.output),
      cost: n(stats.cost) > 0 ? n(stats.cost) : null,
    };
  }

  /** omp lists only commands that run over RPC: builtins with a text handler, skills, extensions, files, MCP prompts. */
  async listCommands(): Promise<SlashCommand[]> {
    const data = await this.live.command<Obj>("get_available_commands");
    return (Array.isArray(data?.commands) ? data.commands : []).flatMap((c): SlashCommand[] => {
      if (!isObj(c) || typeof c.name !== "string") return [];
      const hint = isObj(c.input) && typeof c.input.hint === "string" ? c.input.hint : "";
      return [
        {
          name: c.name,
          ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
          ...(hint ? { hint } : {}),
          source: typeof c.source === "string" ? c.source : "builtin",
        },
      ];
    });
  }

  /** omp's todo phases (`get_state.todoPhases`), flattened. */
  async getTodos(): Promise<TodoItem[]> {
    const state = await this.live.command<Obj>("get_state");
    const phases = Array.isArray(state?.todoPhases) ? state.todoPhases : [];
    const out: TodoItem[] = [];
    for (const phase of phases) {
      if (!isObj(phase)) continue;
      const name = typeof phase.name === "string" ? phase.name : undefined;
      for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
        if (!isObj(task) || typeof task.content !== "string") continue;
        out.push({ ...(name ? { phase: name } : {}), text: task.content.slice(0, 500), status: String(task.status ?? "pending") });
      }
    }
    return out.slice(0, 100);
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    // A "/" command may run locally; its output comes before the response that says so.
    this.commandOutput = text.trim().startsWith("/") ? [] : null;
    let result: Obj | undefined;
    try {
      result = await this.live.command<Obj>("prompt", withImages(text, images));
    } finally {
      const outputs = this.commandOutput ?? [];
      this.commandOutput = null;
      // A builtin (/context, /usage...) runs locally: no turn and no prompt_result, so show the
      // command as the prompt, then its output, and settle here.
      if (isObj(result) && result.agentInvoked === false) {
        this.hub.emit({ type: "user_message", text: text.trim() });
        for (const event of commandOutputEvents(outputs.join("\n\n"))) this.hub.emit(event);
        this.hub.emit({ type: "settled" });
      } else for (const output of outputs) this.hub.emit({ type: "notice", level: "info", text: output });
    }
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.live.command("steer", withImages(text, images));
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.live.command("follow_up", withImages(text, images));
  }

  async abort(): Promise<void> {
    this.cancelDialogs();
    const rpc = this.live;
    for (const message of this.queue.steering) await rpc.command("remove_queued_message", { message, queue: "steering" }).catch(() => undefined);
    for (const message of this.queue.followUp) await rpc.command("remove_queued_message", { message, queue: "followUp" }).catch(() => undefined);
    await rpc.command("abort");
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    if (patch.model !== undefined) {
      const slash = patch.model.indexOf("/");
      if (slash <= 0) throw new Error("Model must be provider/id");
      await this.live.command("set_model", { provider: patch.model.slice(0, slash), modelId: patch.model.slice(slash + 1) });
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
