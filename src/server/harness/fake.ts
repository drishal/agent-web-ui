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
  type InteractionAnswer,
  type ModelInfo,
  type TodoItem,
} from "../../shared/protocol.js";
import { historyToItems } from "./agent-events.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEvent,
  HarnessEventListener,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
} from "./types.js";

const FAKE_MODELS: ModelInfo[] = [
  { key: "fake/echo", provider: "fake", id: "echo", name: "Fake Echo", reasoning: true },
  { key: "fake/slow", provider: "fake", id: "slow", name: "Fake Slow", reasoning: false },
  { key: "acme/gpt-5.5", provider: "acme", id: "gpt-5.5", name: "GPT-5.5", reasoning: true },
  { key: "acme/gpt-5.5-mini", provider: "acme", id: "gpt-5.5-mini", name: "GPT-5.5 Mini" },
  { key: "zeta/glm-5.3-flash", provider: "zeta", id: "glm-5.3-flash", name: "GLM-5.3-Flash", reasoning: true },
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

  constructor(options: FakeAdapterOptions = {}) {
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

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    let session: FakeSession | undefined;
    if (req.resumeNativeId) {
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

  async getConfig(): Promise<ChatConfig> {
    return {
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      models: FAKE_MODELS,
      thinkingLevels: FAKE_THINKING,
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const tokens = this.session.messages.length * 850;
    return { tokens, window: 100_000, percent: Math.min(100, (tokens / 100_000) * 100) };
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

  async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("Chat is closed");
    if (this.running) throw new Error("Agent is busy");
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.emit({ type: "busy" });
    this.running = this.run(text, signal).finally(() => {
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

  private async run(firstText: string, signal: AbortSignal): Promise<void> {
    let text: string | undefined = firstText;
    while (text !== undefined) {
      await this.turn(text, signal);
      text = this.followUps.shift();
      if (text !== undefined) this.emitQueue();
    }
  }

  private async turn(text: string, signal: AbortSignal): Promise<void> {
    this.record({ role: "user", content: text });
    this.emit({ type: "user_message", text });
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
      if (/\btool\b|\bbig\b|\bask\b/i.test(text)) await this.tool(/\bbig\b/i.test(text) ? "big" : "read", signal);
      if (/\bedit\b/i.test(text)) await this.tool("edit", signal);
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
    this.emit({ type: "assistant_end", text: body, thinking });
  }

  private async tool(kind: "read" | "big" | "edit", signal: AbortSignal): Promise<void> {
    const toolCallId = randomUUID();
    const big = kind === "big";
    const name = kind === "edit" ? "edit" : "read";
    const args = kind === "edit" ? { path: `${this.session.cwd}/src/app.ts`, oldText: "a", newText: "b" } : { path: "README.md" };
    this.emit({ type: "assistant_start", model: this.model });
    this.record({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name, arguments: args }],
      stopReason: "toolUse",
    });
    this.emit({ type: "assistant_end", text: "", thinking: "" });
    this.emit({ type: "tool_start", toolCallId, name, args });
    await this.pause(signal, 2);
    this.emit({ type: "tool_update", toolCallId, output: "partial output…" });
    await this.pause(signal, 2);
    const output = big ? "x".repeat(200_000) : kind === "edit" ? "Edited src/app.ts (+1 -1)" : "# Fake README\nhello";
    this.record({ role: "toolResult", toolCallId, toolName: name, content: [{ type: "text", text: output }], isError: false });
    this.emit({ type: "tool_end", toolCallId, output, isError: false });
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
