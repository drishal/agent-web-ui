// Deterministic in-process harness for tests and UI development. It never
// touches the network or a model. Prompt text selects scripted behaviour:
//   "tool"  run a fake tool          "ask"   raise a confirm request first
//   "fail"  end with an error        "slow"  stream many chunks
//   "big"   produce oversized tool output    "edit"  edit a file (src/app.ts)
import { randomUUID } from "node:crypto";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type ModelInfo,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { commandOutputEvents, extensionMessage, forkCutIndex, historyToItems } from "./agent-events.js";
import { seedTranscript, toolRecordText, type HandoffSeed } from "./handoff.js";
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

interface FakeCall {
  name: string;
  args: Record<string, unknown>;
  output: string;
  details?: Record<string, unknown>;
}

const FAKE_MODELS: ModelInfo[] = [
  { key: "fake/echo", provider: "fake", id: "echo", name: "Fake Echo", reasoning: true, vision: true, levels: ["low", "high"] },
  { key: "fake/slow", provider: "fake", id: "slow", name: "Fake Slow", reasoning: false },
  { key: "acme/gpt-5.5", provider: "acme", id: "gpt-5.5", name: "GPT-5.5", reasoning: true, levels: ["minimal", "low", "medium", "high", "xhigh"] },
  { key: "acme/gpt-5.5-mini", provider: "acme", id: "gpt-5.5-mini", name: "GPT-5.5 Mini" },
  { key: "zeta/glm-5.3-flash", provider: "zeta", id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true, vision: false, levels: ["low", "high", "max"] },
];
const FAKE_THINKING = ["off", "low", "high"];

interface FakeSession {
  nativeId: string;
  cwd: string;
  title: string;
  messages: unknown[];
  updatedAt: Date;
}

export interface FakeAdapterOptions {
  id?: string;
  displayName?: string;
  /** Delay between streamed chunks. */
  chunkDelayMs?: number;
  /** How long resuming a session takes to "start the harness" (the real ones take 0.4–3 s). */
  resumeDelayMs?: number;
  capabilities?: Partial<HarnessCapabilities>;
}

class Aborted extends Error {}

export class FakeAdapter implements HarnessAdapter {
  readonly id;
  readonly displayName;
  readonly cliCommand = "fake";
  readonly capabilities: HarnessCapabilities;
  readonly sessions = new Map<string, FakeSession>();
  private readonly chunkDelayMs: number;
  private readonly resumeDelayMs: number;

  constructor(options: FakeAdapterOptions = {}) {
    this.resumeDelayMs = options.resumeDelayMs ?? 0;
    this.id = asHarnessId(options.id ?? "fake");
    this.displayName = options.displayName ?? "Fake";
    this.chunkDelayMs = options.chunkDelayMs ?? 15;
    this.capabilities = {
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
      ...options.capabilities,
    };
  }

  async discover(): Promise<HarnessDiscovery> {
    return { available: true, version: "fake-1", warnings: [], overrides: {} };
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return "/nonexistent/fake-agent";
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return `/nonexistent/fake-sessions${cwd}`;
  }

  async listModels(): Promise<ModelInfo[]> {
    return FAKE_MODELS;
  }

  async listThinkingLevels(): Promise<string[]> {
    return FAKE_THINKING;
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    return [...this.sessions.values()]
      .filter((s) => s.cwd === cwd && s.messages.length > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((s) => ({
        nativeId: s.nativeId,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.messages.length > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit)
      .map((s) => ({ nativeId: s.nativeId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  }

  /** Copy the messages of the first `throughTurns` user turns into a new in-memory session. */
  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const source = this.sessions.get(req.nativeId);
    if (!source || source.cwd !== req.cwd) throw new Error("Unknown session");
    const nativeId = randomUUID();
    this.sessions.set(nativeId, {
      nativeId,
      cwd: source.cwd,
      title: source.title,
      messages: source.messages.slice(0, forkCutIndex(source.messages, req.throughTurns)),
      updatedAt: new Date(),
    });
    return { nativeId };
  }

  /** Fresh in-memory session with the seed's turns recorded as transcript messages. */
  async seedChat(req: { cwd: string; seed: HandoffSeed }): Promise<LiveChat> {
    const session: FakeSession = { nativeId: randomUUID(), cwd: req.cwd, title: req.seed.title ?? "", messages: [], updatedAt: new Date() };
    this.sessions.set(session.nativeId, session);
    const push = (message: Record<string, unknown>) => {
      session.messages.push({ timestamp: Date.now(), ...message });
    };
    for (const entry of seedTranscript(req.seed)) {
      if (entry.role === "user") push({ role: "user", content: entry.text });
      else if (entry.role === "assistant") {
        const content: unknown[] = [];
        if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking });
        if (entry.text) content.push({ type: "text", text: entry.text });
        push({ role: "assistant", content, stopReason: "stop" });
      } else {
        const id = randomUUID();
        push({ role: "assistant", content: [{ type: "toolCall", id, name: entry.name, arguments: {} }], stopReason: "toolUse" });
        push({ role: "toolResult", toolCallId: id, toolName: entry.name, content: [{ type: "text", text: toolRecordText(entry) }], isError: false });
      }
    }
    return new FakeLiveChat(session, this.chunkDelayMs);
  }

  /** Like the file-backed harnesses: the stored transcript, without "starting" anything. */
  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const session = this.sessions.get(req.nativeId);
    if (!session || session.cwd !== req.cwd) return null;
    return { items: historyToItems(session.messages), title: session.title || null };
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    let session: FakeSession | undefined;
    if (req.resumeNativeId) {
      if (this.resumeDelayMs > 0) await new Promise((r) => setTimeout(r, this.resumeDelayMs));
      session = this.sessions.get(req.resumeNativeId);
      if (!session || session.cwd !== req.cwd) throw new Error("Unknown session");
    } else {
      session = { nativeId: randomUUID(), cwd: req.cwd, title: "", messages: [], updatedAt: new Date() };
      this.sessions.set(session.nativeId, session);
    }
    return new FakeLiveChat(session, this.chunkDelayMs);
  }

  async shutdown(): Promise<void> {}
}

class FakeLiveChat implements LiveChat {
  private listeners = new Set<HarnessEventListener>();
  private running: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private steering: string[] = [];
  private followUps: string[] = [];
  private pending = new Map<string, (answer: InteractionAnswer | null) => void>();
  private model = "fake/echo";
  private thinkingLevel = "low";
  private disposed = false;

  constructor(
    private readonly session: FakeSession,
    private readonly delayMs: number,
  ) {}

  get nativeId(): string {
    return this.session.nativeId;
  }

  get title(): string | null {
    return this.session.title || null;
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HarnessEvent): void {
    for (const l of this.listeners) l(event);
  }

  async history(): Promise<ChatItem[]> {
    return historyToItems(this.session.messages);
  }

  /** Tests: a refresh "discovers" one more model. */
  private refreshed = false;

  async refreshModels(): Promise<void> {
    this.refreshed = true;
  }

  async getConfig(): Promise<ChatConfig> {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      models: this.refreshed ? [...FAKE_MODELS, { key: "fake/fresh", provider: "fake", id: "fresh", name: "Fake Fresh" }] : FAKE_MODELS,
      thinkingLevels: FAKE_THINKING,
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const categories = [
      { id: "system", label: "System prompt", tokens: 1500 },
      { id: "tools", label: "Tool definitions", tokens: 5200 },
      { id: "messages", label: "Messages", tokens: this.session.messages.length * 850 },
    ];
    const tokens = categories.reduce((sum, c) => sum + c.tokens, 0);
    return { tokens, window: 100_000, percent: Math.min(100, (tokens / 100_000) * 100), categories };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const role = (r: string) => this.session.messages.filter((m) => (m as { role?: string }).role === r).length;
    const steps = role("assistant");
    return { turns: role("user"), steps, input: steps * 1200, cachedInput: Math.max(0, steps - 1) * 900, cacheWrite: 0, output: steps * 40, cost: null };
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [
      { name: "fake-status", description: "Report the fake harness's status without a model call", source: "builtin" },
      { name: "skill:review", description: "Review the work so far", hint: "[focus]", source: "skill" },
    ];
  }

  async getTodos(): Promise<TodoItem[]> {
    const wanted = this.session.messages.some((m) => {
      const msg = m as { role?: string; content?: unknown };
      return msg.role === "user" && typeof msg.content === "string" && /\btodo\b/i.test(msg.content);
    });
    if (!wanted) return [];
    return [
      { phase: "Plan", text: "Read the code", status: "completed" },
      { phase: "Plan", text: "Write the fix", status: "in_progress" },
      { phase: "Verify", text: "Run the tests", status: "pending" },
    ];
  }

  async prompt(text: string, images: ImageAttachment[] = []): Promise<void> {
    if (this.disposed) throw new Error("Chat is closed");
    // Like omp's builtins: runs locally, answers with output, no model turn.
    if (text.trim() === "/fake-status") {
      for (const event of commandOutputEvents("/fake-status", "fake status: all good")) this.emit(event);
      this.emit({ type: "settled" });
      return;
    }
    if (this.running) throw new Error("Agent is busy");
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.emit({ type: "busy" });
    this.running = this.run(text, signal, images.length).finally(() => {
      this.running = null;
      this.emit({ type: "settled" });
    });
  }

  private emitQueue(): void {
    this.emit({ type: "queue", queue: { steering: [...this.steering], followUp: [...this.followUps] } });
  }

  async steer(text: string): Promise<void> {
    if (!this.running) throw new Error("Nothing to steer");
    this.steering.push(text);
    this.emitQueue();
  }

  async followUp(text: string): Promise<void> {
    if (!this.running) throw new Error("Nothing to follow");
    this.followUps.push(text);
    this.emitQueue();
  }

  async abort(): Promise<void> {
    this.steering = [];
    this.followUps = [];
    this.emitQueue();
    for (const [id, resolve] of this.pending) {
      this.pending.delete(id);
      resolve(null);
      this.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
    }
    this.abortController?.abort();
    await this.running?.catch(() => undefined);
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    if (this.running) throw new Error("Agent is busy");
    if (patch.model !== undefined) {
      if (!FAKE_MODELS.some((m) => m.key === patch.model)) throw new Error("Unknown model");
      this.model = patch.model;
    }
    if (patch.thinkingLevel !== undefined) {
      if (!FAKE_THINKING.includes(patch.thinkingLevel)) throw new Error("Unknown thinking level");
      this.thinkingLevel = patch.thinkingLevel;
    }
    this.emit({ type: "config", config: await this.getConfig() });
  }

  async rename(name: string): Promise<void> {
    this.session.title = name;
    this.emit({ type: "title", title: name });
  }

  async compact(): Promise<void> {
    if (this.running) throw new Error("Agent is busy");
    this.emit({ type: "compacting", active: true });
    await sleep(this.delayMs * 3);
    this.session.messages = [{ role: "compactionSummary", summary: "fake", tokensBefore: 0 }];
    this.emit({ type: "compacting", active: false });
    this.emit({ type: "notice", level: "info", text: "Compacted conversation" });
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.pending.delete(requestId);
    resolve(answer);
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.abort();
    this.listeners.clear();
  }

  // ---- scripted run ------------------------------------------------------

  private async pause(signal: AbortSignal, factor = 1): Promise<void> {
    if (signal.aborted) throw new Aborted();
    await sleep(this.delayMs * factor);
    if (signal.aborted) throw new Aborted();
  }

  private async run(firstText: string, signal: AbortSignal, firstImages: number): Promise<void> {
    let text: string | undefined = firstText;
    let images = firstImages;
    while (text !== undefined) {
      await this.turn(text, signal, images);
      images = 0;
      text = this.followUps.shift();
      if (text !== undefined) this.emitQueue();
    }
  }

  private async turn(text: string, signal: AbortSignal, imageCount = 0): Promise<void> {
    const images = Array.from({ length: imageCount }, () => ({ type: "image", data: "", mimeType: "image/png" }));
    this.record({ role: "user", content: imageCount ? [{ type: "text", text }, ...images] : text });
    this.emit({ type: "user_message", text, ...(imageCount ? { imageCount } : {}) });
    if (!this.session.title) {
      this.session.title = text.slice(0, 60);
      this.emit({ type: "title", title: this.session.title });
    }
    try {
      if (/\bask\b/i.test(text)) {
        // "ask twice" raises two requests at once (stacked approvals).
        const asks = /\btwice\b/i.test(text) ? [this.ask(signal, "bash"), this.ask(signal, "read")] : [this.ask(signal)];
        const approved = (await Promise.all(asks)).every(Boolean);
        if (!approved) {
          this.emit({ type: "notice", level: "warning", text: "Fake tool denied" });
          await this.reply(`Denied: ${text}`, signal);
          return;
        }
      }
      if (/\brecall\b/i.test(text)) {
        // A memory extension's recall, as pi-book injects it (a displayed custom message).
        const recall = extensionMessage("book-recall", "<memory>\nYour memory book: notes about the user.\n- prefers tabs over spaces\n</memory>");
        if (recall) this.emit({ type: "notice", level: "info", ...recall });
      }
      if (/\btool\b|\bbig\b|\bask\b/i.test(text)) await this.tool(/\bbig\b/i.test(text) ? "big" : "read", signal);
      if (/\bedit\b/i.test(text)) await this.tool("edit", signal);
      if (/\bshowcase\b/i.test(text)) for (const call of this.showcase()) await this.call(call, signal);
      if (/\bfail\b/i.test(text)) {
        this.emit({ type: "assistant_start", model: this.model });
        await this.pause(signal);
        this.record({ role: "assistant", content: [], stopReason: "error", errorMessage: "Fake failure" });
        this.emit({ type: "assistant_end", text: "", thinking: "", error: "Fake failure" });
        return;
      }
      await this.reply(`Echo: ${text}`, signal, /\bslow\b/i.test(text) ? 60 : 1);
      while (this.steering.length > 0) {
        const steer = this.steering.shift() as string;
        this.emitQueue();
        this.record({ role: "user", content: steer });
        this.emit({ type: "user_message", text: steer });
        await this.reply(`Steered: ${steer}`, signal);
      }
    } catch (error) {
      if (!(error instanceof Aborted)) throw error;
      this.record({ role: "assistant", content: [], stopReason: "aborted" });
      this.emit({ type: "assistant_end", text: this.partial, thinking: "", error: "Stopped" });
    }
  }

  private partial = "";

  private async reply(text: string, signal: AbortSignal, repeat = 1): Promise<void> {
    this.partial = "";
    this.emit({ type: "assistant_start", model: this.model });
    const thinking = `Considering: ${text.slice(0, 40)}`;
    for (const chunk of chunks(thinking, 3)) {
      await this.pause(signal);
      this.emit({ type: "assistant_delta", field: "thinking", delta: chunk });
    }
    const body = `${text}\n\n${Array.from({ length: repeat }, (_, i) => `- line ${i + 1} with **markdown**`).join("\n")}`;
    // "slow" streams many small chunks so tests can act while the run is live.
    const size = repeat > 1 ? 24 : Math.max(4, Math.ceil(body.length / 8));
    for (const chunk of chunks(body, size)) {
      await this.pause(signal);
      this.partial += chunk;
      this.emit({ type: "assistant_delta", field: "text", delta: chunk });
    }
    this.record({
      role: "assistant",
      content: [
        { type: "thinking", thinking },
        { type: "text", text: body },
      ],
      stopReason: "stop",
      model: this.model,
    });
    this.emit({ type: "assistant_end", text: body, thinking, usage: { input: 1200, output: Math.ceil(body.length / 4), cacheRead: 0, cacheWrite: 0 } });
  }

  private async tool(kind: "read" | "big" | "edit", signal: AbortSignal): Promise<void> {
    const big = kind === "big";
    await this.call(
      kind === "edit"
        ? { name: "edit", args: { path: `${this.session.cwd}/src/app.ts`, oldText: "a", newText: "b" }, output: "Edited src/app.ts (+1 -1)" }
        : { name: "read", args: { path: "README.md" }, output: big ? "x".repeat(200_000) : "# Fake README\nhello" },
      signal,
    );
  }

  /** One call of every kind, as the harnesses send them: for screenshots and the tool-card tests. */
  private showcase(): FakeCall[] {
    const cwd = this.session.cwd;
    return [
      {
        name: "edit",
        args: {
          path: `${cwd}/src/server.ts`,
          edits: [{ oldText: "const port = 3000;\nconst host = \"localhost\";\nlisten(port);", newText: "const port = Number(process.env.PORT ?? 3000);\nconst host = \"localhost\";\nlisten(port, host);\nlog(`listening on ${host}:${port}`);" }],
        },
        output: "Successfully replaced 1 block in src/server.ts.",
        // Pi's own numbered diff, as its edit tool reports it.
        details: { diff: "  9 import { listen, log } from \"./net\";\n 10 \n-11 const port = 3000;\n+11 const port = Number(process.env.PORT ?? 3000);\n 12 const host = \"localhost\";\n-13 listen(port);\n+13 listen(port, host);\n+14 log(`listening on ${host}:${port}`);\n   ...\n 40 export {};", firstChangedLine: 11 },
      },
      { name: "write", args: { path: `${cwd}/notes/todo.md`, content: "# Todo\n\n- [ ] ship the diff view\n- [x] tidy tool cards\n" }, output: "Wrote 4 lines to notes/todo.md" },
      { name: "bash", args: { command: "npm test -- --run tool-diff", timeout: 120 }, output: " ✓ tests/unit/tool-diff.test.ts (5 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  5 passed (5)" },
      { name: "grep", args: { pattern: "listen\\(", path: "src" }, output: "src/server.ts:13:listen(port, host);\nsrc/net.ts:4:export function listen(port: number, host?: string) {" },
      { name: "read", args: { path: `${cwd}/src/net.ts`, offset: 1, limit: 20 }, output: "1\timport { createServer } from \"node:http\";\n2\t\n3\texport function listen(port: number, host?: string) {\n4\t  createServer().listen(port, host);\n5\t}" },
      { name: "web_fetch", args: { url: "https://example.com/docs/listen" }, output: "Example Domain\nThis domain is for use in illustrative examples in documents." },
      { name: "todo_write", args: { todos: [{ content: "Ship the diff view", status: "in_progress" }], merge: false }, output: "Updated 1 todo" },
    ];
  }

  private async call(call: FakeCall, signal: AbortSignal): Promise<void> {
    const toolCallId = randomUUID();
    this.emit({ type: "assistant_start", model: this.model });
    this.record({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: call.name, arguments: call.args }],
      stopReason: "toolUse",
    });
    this.emit({ type: "assistant_end", text: "", thinking: "" });
    this.emit({ type: "tool_start", toolCallId, name: call.name, args: call.args });
    await this.pause(signal, 2);
    this.emit({ type: "tool_update", toolCallId, output: "partial output…" });
    await this.pause(signal, 2);
    const details = call.details ? { details: call.details } : {};
    this.record({ role: "toolResult", toolCallId, toolName: call.name, content: [{ type: "text", text: call.output }], isError: false, ...details });
    this.emit({ type: "tool_end", toolCallId, output: call.output, isError: false, ...details });
  }

  private ask(signal: AbortSignal, tool = "read"): Promise<boolean> {
    const id = randomUUID();
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(id)) this.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
        reject(new Aborted());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, (answer) => {
        signal.removeEventListener("abort", onAbort);
        if (answer === null) return reject(new Aborted());
        resolve(answer.kind === "confirm" ? answer.confirmed : answer.kind === "select" && answer.value === "Approve");
      });
      this.emit({
        type: "request",
        request: {
          id,
          kind: "confirm",
          title: `Allow tool: ${tool}`,
          message: tool === "bash" ? "npm test -- --watch=false" : "The fake agent wants to read README.md",
          createdAt: Date.now(),
        },
      });
    });
  }

  private record(message: Record<string, unknown>): void {
    this.session.messages.push({ timestamp: Date.now(), ...message });
    this.session.updatedAt = new Date();
  }
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
