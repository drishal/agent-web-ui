// One live chat: owns the adapter's LiveChat, folds normalized harness events
// into display state, and fans out a replayable, monotonic event stream.
import type {
  AssistantItem,
  ChatConfig,
  ChatEvent,
  ChatItem,
  ChatSnapshot,
  ChatStatus,
  ContextUsage,
  ImageAttachment,
  InteractionAnswer,
  InteractionRequest,
  QueueState,
  SendMode,
  SessionUsage,
  TodoItem,
  ToolItem,
  WorkspaceInfo,
} from "../../shared/protocol.js";
import { boundText, stringifyArgs, toolCategory, toolPaths, toolSummary } from "../harness/agent-events.js";
import type { HarnessAdapter, HarnessEvent, HarnessUsage, LiveChat } from "../harness/types.js";

export class ChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChatSubscriber {
  send(id: number, event: ChatEvent): void;
  close(): void;
}

const MAX_LOG_EVENTS = 5000;
const DELTA_FLUSH_MS = 30;
const SETTLE_TIMEOUT_MS = 20_000;

export function namespacedSessionId(harnessId: string, nativeId: string | null): string | null {
  return nativeId ? `${harnessId}:${nativeId}` : null;
}

function describeAnswer(request: InteractionRequest, answer: InteractionAnswer): string {
  switch (answer.kind) {
    case "cancel":
      return "Dismissed";
    case "confirm":
      return answer.confirmed ? "Approved" : "Denied";
    case "select":
      return `Chose “${answer.value}”`;
    default:
      return request.kind === "editor" ? "Edited" : "Answered";
  }
}

export class Chat {
  readonly createdAt = Date.now();
  nativeId: string | null;
  status: ChatStatus = "idle";
  title = "";
  generation = 0;
  lastActivity = Date.now();
  onSession?: (chat: Chat) => void;
  onDisposed?: (chat: Chat) => void;

  private items: ChatItem[] = [];
  private index = new Map<string, number>();
  private queue: QueueState = { steering: [], followUp: [] };
  private pending = new Map<string, InteractionRequest>();
  private extensionStatus: Record<string, string> = {};
  private context: ContextUsage | null = null;
  private usage: SessionUsage | null = null;
  private todos: TodoItem[] = [];
  /**
   * Model timing, measured from the stream because no harness reports it: a
   * call's request starts at the prompt or the last tool result (the hand-off),
   * its first token is its first delta, and it ends at assistant_end.
   */
  private timing = { handoffAt: 0, requestAt: 0, firstTokenAt: 0, llmMs: 0, ttftMs: 0, ttftCount: 0, genMs: 0, genTokens: 0 };
  private config: ChatConfig;
  private log: Array<{ id: number; event: ChatEvent }> = [];
  private nextEventId = 1;
  private subscribers = new Set<ChatSubscriber>();
  private counter = 0;
  private currentAssistant: string | null = null;
  private currentModel: string | undefined;
  private pendingDeltas: Array<{ itemId: string; field: "text" | "thinking" | "output"; append: string }> = [];
  private dirtyTools = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private settleWaiters: Array<() => void> = [];
  private unsubscribe: (() => void) | null = null;
  private live: LiveChat;

  private constructor(
    readonly chatId: string,
    readonly adapter: HarnessAdapter,
    readonly workspace: WorkspaceInfo,
    live: LiveChat,
    config: ChatConfig,
  ) {
    this.live = live;
    this.nativeId = live.nativeId;
    this.config = config;
  }

  static async open(chatId: string, adapter: HarnessAdapter, workspace: WorkspaceInfo, live: LiveChat): Promise<Chat> {
    const [items, config, context, usage, todos] = await Promise.all([
      live.history(),
      live.getConfig(),
      live.getContextUsage().catch(() => null),
      live.getUsage().catch(() => null),
      live.getTodos().catch(() => []),
    ]);
    const chat = new Chat(chatId, adapter, workspace, live, config);
    chat.context = context;
    chat.usage = chat.composeUsage(usage);
    chat.todos = todos;
    for (const item of items) chat.upsert(item);
    chat.title = live.title ?? chat.firstUserText() ?? "";
    chat.attach();
    return chat;
  }

  get harnessId() {
    return this.adapter.id;
  }

  get sessionId(): string | null {
    return namespacedSessionId(this.adapter.id, this.nativeId);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  private firstUserText(): string | null {
    const first = this.items.find((i) => i.kind === "user");
    return first && first.kind === "user" ? first.text.slice(0, 80) : null;
  }

  /** Bind to the LiveChat; events from a previous binding are dropped. */
  private attach(): void {
    this.unsubscribe?.();
    const generation = ++this.generation;
    this.unsubscribe = this.live.subscribe((event) => {
      if (generation !== this.generation) return;
      this.apply(event);
    });
  }

  snapshot(): ChatSnapshot {
    this.flushNow();
    return {
      chatId: this.chatId,
      harnessId: this.adapter.id,
      sessionId: this.sessionId,
      workspace: this.workspace,
      title: this.title,
      status: this.status,
      items: this.items.map((i) => ({ ...i })),
      queue: { steering: [...this.queue.steering], followUp: [...this.queue.followUp] },
      pending: [...this.pending.values()],
      config: this.config,
      capabilities: this.adapter.capabilities,
      extensionStatus: { ...this.extensionStatus },
      context: this.context,
      usage: this.usage,
      todos: [...this.todos],
      generation: this.generation,
      lastEventId: this.nextEventId - 1,
    };
  }

  /**
   * Subscribe a stream. With a lastEventId still inside the replay window the
   * missed events are replayed; otherwise the subscriber gets a fresh snapshot.
   */
  subscribe(subscriber: ChatSubscriber, lastEventId?: number): () => void {
    this.flushNow();
    const oldest = this.log[0]?.id ?? this.nextEventId;
    const canReplay =
      lastEventId !== undefined && lastEventId >= oldest - 1 && lastEventId <= this.nextEventId - 1;
    if (canReplay) {
      for (const entry of this.log) if (entry.id > lastEventId) subscriber.send(entry.id, entry.event);
    } else {
      subscriber.send(this.nextEventId - 1, { type: "snapshot", snapshot: this.snapshot() });
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private emit(event: ChatEvent): void {
    if (event.type !== "delta") this.flushNow();
    this.record(event);
  }

  private record(event: ChatEvent): void {
    const id = this.nextEventId++;
    this.log.push({ id, event });
    if (this.log.length > MAX_LOG_EVENTS) this.log.splice(0, this.log.length - MAX_LOG_EVENTS);
    for (const s of this.subscribers) s.send(id, event);
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushNow(), DELTA_FLUSH_MS);
  }

  /** Coalesce deltas per item/field and throttled tool updates into few events. */
  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const deltas = this.pendingDeltas;
    this.pendingDeltas = [];
    for (const d of deltas) this.record({ type: "delta", ...d });
    const tools = [...this.dirtyTools];
    this.dirtyTools.clear();
    for (const id of tools) {
      const item = this.get(id);
      if (item) this.record({ type: "item", item: { ...item } });
    }
  }

  private get(id: string): ChatItem | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  private upsert(item: ChatItem): void {
    const i = this.index.get(item.id);
    if (i === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[i] = item;
    }
  }

  private put(item: ChatItem): void {
    this.upsert(item);
    this.emit({ type: "item", item: { ...item } });
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private setStatus(status: ChatStatus): void {
    if (this.status === status || this.status === "disposed") return;
    this.status = status;
    this.emit({ type: "status", status });
    if (status === "idle" || status === "error") {
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private ensureAssistant(): AssistantItem {
    const current = this.currentAssistant ? this.get(this.currentAssistant) : undefined;
    if (current && current.kind === "assistant") return current;
    const item: AssistantItem = {
      kind: "assistant",
      id: this.nextId("a"),
      text: "",
      thinking: "",
      streaming: true,
      at: Date.now(),
      ...(this.currentModel ? { model: this.currentModel } : {}),
    };
    this.currentAssistant = item.id;
    this.put(item);
    return item;
  }

  private finishStreaming(): void {
    const current = this.currentAssistant ? this.get(this.currentAssistant) : undefined;
    if (current && current.kind === "assistant" && current.streaming) this.put({ ...current, streaming: false, endedAt: Date.now() });
    this.currentAssistant = null;
  }

  private notice(level: "info" | "warning" | "error", text: string, ambient?: boolean): void {
    const busy = this.status === "running" || this.status === "stopping" || this.status === "compacting";
    const between = ambient ?? !busy;
    this.put({ kind: "notice", id: this.nextId("n"), level, text, at: Date.now(), ...(between ? { ambient: true } : {}) });
  }

  apply(event: HarnessEvent): void {
    this.lastActivity = Date.now();
    switch (event.type) {
      case "user_message":
        this.finishStreaming();
        this.put({
          kind: "user",
          id: this.nextId("u"),
          text: event.text,
          ...(event.imageCount ? { imageCount: event.imageCount } : {}),
          at: Date.now(),
        });
        if (!this.title) this.setTitle(event.text.slice(0, 80));
        break;
      case "assistant_start":
        this.finishStreaming();
        this.currentModel = event.model;
        this.timing.requestAt = this.timing.handoffAt || Date.now();
        this.timing.firstTokenAt = 0;
        break;
      case "assistant_delta": {
        if (this.timing.requestAt && !this.timing.firstTokenAt) {
          this.timing.firstTokenAt = Date.now();
          this.timing.ttftMs += this.timing.firstTokenAt - this.timing.requestAt;
          this.timing.ttftCount += 1;
        }
        const item = this.ensureAssistant();
        item[event.field] += event.delta;
        this.pendingDeltas.push({ itemId: item.id, field: event.field, append: event.delta });
        this.scheduleFlush();
        break;
      }
      case "assistant_end": {
        this.endStep(event.usage?.output ?? 0);
        const existing = this.currentAssistant ? this.get(this.currentAssistant) : undefined;
        if (!existing && !event.text && !event.thinking && !event.error) {
          this.currentAssistant = null;
          break;
        }
        const item = existing && existing.kind === "assistant" ? existing : this.ensureAssistant();
        this.put({
          ...item,
          text: event.text || item.text,
          thinking: event.thinking || item.thinking,
          streaming: false,
          endedAt: Date.now(),
          ...(event.error ? { error: event.error } : {}),
        });
        this.currentAssistant = null;
        break;
      }
      case "tool_start": {
        this.finishStreaming();
        const tool: ToolItem = {
          kind: "tool",
          id: `t:${event.toolCallId}`,
          name: event.name,
          args: stringifyArgs(event.args),
          status: "running",
          output: "",
          truncated: false,
          category: toolCategory(event.name),
          summary: toolSummary(event.args),
          paths: toolPaths(event.args),
          at: Date.now(),
        };
        this.put(tool);
        break;
      }
      case "tool_update": {
        const item = this.get(`t:${event.toolCallId}`);
        if (!item || item.kind !== "tool") break;
        const bounded = boundText(event.output);
        this.upsert({ ...item, output: bounded.text, truncated: bounded.truncated });
        this.dirtyTools.add(item.id);
        this.scheduleFlush();
        break;
      }
      case "tool_end": {
        this.timing.handoffAt = Date.now();
        const id = `t:${event.toolCallId}`;
        this.dirtyTools.delete(id);
        const item = this.get(id);
        const bounded = boundText(event.output);
        const base: ToolItem =
          item && item.kind === "tool"
            ? item
            : {
                kind: "tool",
                id,
                name: "tool",
                args: "",
                status: "running",
                output: "",
                truncated: false,
                category: "other",
                summary: "",
                paths: [],
              };
        this.put({
          ...base,
          output: bounded.text,
          truncated: bounded.truncated,
          status: event.isError ? "error" : "done",
          endedAt: Date.now(),
        });
        if (base.name.toLowerCase().includes("todo")) void this.refreshTodos();
        break;
      }
      case "busy":
        if (this.status !== "stopping") this.setStatus("running");
        break;
      case "settled":
        this.finishStreaming();
        if (this.status !== "error") this.setStatus("idle");
        void this.refreshContext();
        void this.refreshUsage();
        void this.refreshTodos();
        break;
      case "compacting":
        if (event.active) this.setStatus("compacting");
        else {
          if (this.status === "compacting") this.setStatus("idle");
          void this.refreshContext();
        }
        break;
      case "queue":
        this.queue = { steering: [...event.queue.steering], followUp: [...event.queue.followUp] };
        this.emit({ type: "queue", queue: this.queue });
        break;
      case "notice":
        this.notice(event.level, event.text);
        break;
      case "config":
        this.config = { ...this.config, ...event.config };
        this.emit({ type: "config", config: this.config });
        break;
      case "title":
        this.setTitle(event.title);
        break;
      case "session":
        if (this.nativeId !== event.nativeId) {
          this.nativeId = event.nativeId;
          this.onSession?.(this);
          this.emit({ type: "title", title: this.title, sessionId: this.sessionId });
        }
        break;
      case "request":
        this.pending.set(event.request.id, event.request);
        this.put({ kind: "request", id: `r:${event.request.id}`, request: event.request });
        this.emit({ type: "request", request: event.request });
        break;
      case "request_cancelled":
        this.resolveRequest(event.requestId, event.outcome === "cancelled" ? "Cancelled" : event.outcome);
        break;
      case "extension_status":
        if (event.text === null) delete this.extensionStatus[event.key];
        else this.extensionStatus[event.key] = event.text;
        this.emit({ type: "extension_status", key: event.key, text: event.text });
        break;
      case "fatal":
        this.finishStreaming();
        for (const id of [...this.pending.keys()]) this.resolveRequest(id, "Cancelled");
        this.notice("error", event.message);
        this.setStatus("error");
        break;
    }
  }

  private async refreshContext(): Promise<void> {
    const generation = this.generation;
    try {
      const context = await this.live.getContextUsage();
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(context) === JSON.stringify(this.context)) return;
      this.context = context;
      this.emit({ type: "context", context });
    } catch {
      // usage is best-effort
    }
  }

  /** Close the current model call's timing; `outputTokens` feeds tokens per second. */
  private endStep(outputTokens: number): void {
    const t = this.timing;
    if (!t.requestAt) return;
    const now = Date.now();
    t.llmMs += now - t.requestAt;
    if (t.firstTokenAt && outputTokens > 0 && now > t.firstTokenAt) {
      t.genMs += now - t.firstTokenAt;
      t.genTokens += outputTokens;
    }
    t.requestAt = 0;
    t.firstTokenAt = 0;
    t.handoffAt = now;
  }

  private composeUsage(harness: HarnessUsage | null): SessionUsage | null {
    if (!harness) return null;
    const t = this.timing;
    return {
      ...harness,
      llmMs: t.llmMs > 0 ? t.llmMs : null,
      ttftMs: t.ttftCount > 0 ? Math.round(t.ttftMs / t.ttftCount) : null,
      tokensPerSecond: t.genMs > 0 ? Math.round((t.genTokens / t.genMs) * 1000) : null,
    };
  }

  private async refreshUsage(): Promise<void> {
    const generation = this.generation;
    try {
      const usage = this.composeUsage(await this.live.getUsage());
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
      this.usage = usage;
      this.emit({ type: "usage", usage });
    } catch {
      // usage is best-effort
    }
  }

  private async refreshTodos(): Promise<void> {
    const generation = this.generation;
    try {
      const todos = await this.live.getTodos();
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(todos) === JSON.stringify(this.todos)) return;
      this.todos = todos;
      this.emit({ type: "todos", todos });
    } catch {
      // todos are best-effort
    }
  }

  private setTitle(title: string): void {
    this.title = title;
    this.emit({ type: "title", title, sessionId: this.sessionId });
  }

  private resolveRequest(requestId: string, outcome: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    this.put({ kind: "request", id: `r:${requestId}`, request, outcome });
    this.emit({ type: "request_resolved", requestId, outcome });
  }

  private waitForSettle(): Promise<void> {
    if (this.status === "idle" || this.status === "error" || this.status === "disposed") return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
      this.settleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private assertOpen(): void {
    if (this.status === "disposed") throw new ChatError(410, "chat_closed", "This chat was closed");
  }

  // ---- commands -------------------------------------------------------------

  async send(text: string, mode: SendMode, images: ImageAttachment[] = []): Promise<void> {
    this.assertOpen();
    this.lastActivity = Date.now();
    const caps = this.adapter.capabilities;
    const busy = this.status === "running" || this.status === "stopping" || this.status === "compacting";
    switch (mode) {
      case "steer":
        if (!caps.supportsSteer) throw new ChatError(400, "unsupported", "This harness cannot steer");
        if (this.status !== "running") throw new ChatError(409, "not_running", "Nothing is running to steer");
        await this.live.steer(text, images);
        return;
      case "followUp":
        if (!caps.supportsFollowUp) throw new ChatError(400, "unsupported", "This harness has no follow-up queue");
        if (this.status !== "running") throw new ChatError(409, "not_running", "Nothing is running to follow");
        await this.live.followUp(text, images);
        return;
      case "stopAndSend":
        if (busy) await this.abort();
        break;
      case "normal":
        if (busy) throw new ChatError(409, "busy", "The agent is busy; steer, queue a follow-up, or stop it first");
        break;
    }
    if (this.status === "error") this.status = "idle";
    this.setStatus("running");
    this.timing.handoffAt = Date.now();
    try {
      await this.live.prompt(text, images);
    } catch (error) {
      this.notice("error", `Prompt rejected: ${errorMessage(error)}`, true);
      this.setStatus("idle");
      throw new ChatError(422, "prompt_rejected", errorMessage(error));
    }
  }

  async abort(): Promise<void> {
    this.assertOpen();
    if (this.status !== "running" && this.status !== "compacting" && this.status !== "stopping") return;
    this.setStatus("stopping");
    for (const id of [...this.pending.keys()]) this.resolveRequest(id, "Cancelled");
    try {
      await this.live.abort();
    } catch (error) {
      this.notice("error", `Stop failed: ${errorMessage(error)}`);
    }
    await this.waitForSettle();
    if (this.status === "stopping") this.setStatus("idle");
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    this.assertOpen();
    if (this.status !== "idle" && this.status !== "error") {
      throw new ChatError(409, "busy", "Settings can only change while the agent is idle");
    }
    const caps = this.adapter.capabilities;
    if (patch.model !== undefined && !caps.supportsModelSelection) {
      throw new ChatError(400, "unsupported", "This harness cannot change models");
    }
    if (patch.thinkingLevel !== undefined && !caps.supportsThinkingLevel) {
      throw new ChatError(400, "unsupported", "This harness has no thinking levels");
    }
    try {
      await this.live.setConfig(patch);
    } catch (error) {
      throw new ChatError(422, "config_rejected", errorMessage(error));
    }
    this.config = await this.live.getConfig();
    this.emit({ type: "config", config: this.config });
  }

  async rename(name: string): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsRename) throw new ChatError(400, "unsupported", "Rename is not supported");
    await this.live.rename(name);
    this.setTitle(name);
  }

  async compact(instructions?: string): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsCompact) throw new ChatError(400, "unsupported", "Compact is not supported");
    if (this.status !== "idle") throw new ChatError(409, "busy", "Compact only while idle");
    this.setStatus("compacting");
    try {
      await this.live.compact(instructions);
    } catch (error) {
      this.notice("error", `Compaction failed: ${errorMessage(error)}`);
    } finally {
      // Re-read: events during the await may have moved the status on.
      if ((this.status as ChatStatus) === "compacting") this.setStatus("idle");
    }
  }

  answer(requestId: string, answer: InteractionAnswer): string {
    this.assertOpen();
    const request = this.pending.get(requestId);
    if (!request) throw new ChatError(409, "request_resolved", "This request was already answered or cancelled");
    const outcome = describeAnswer(request, answer);
    // Synchronous check-deliver-resolve: the first answer wins, later ones see 409.
    const delivered = this.live.answer(requestId, answer);
    if (!delivered) {
      this.resolveRequest(requestId, "Cancelled");
      throw new ChatError(409, "request_resolved", "The harness no longer waits for this request");
    }
    this.resolveRequest(requestId, outcome);
    return outcome;
  }

  /** Swap the LiveChat (e.g. an omp respawn); stale events are dropped by generation. */
  rebind(live: LiveChat): void {
    this.live = live;
    this.attach();
  }

  async dispose(reason: string): Promise<void> {
    if (this.status === "disposed") return;
    for (const id of [...this.pending.keys()]) this.resolveRequest(id, "Cancelled");
    this.flushNow();
    this.status = "disposed";
    this.record({ type: "status", status: "disposed" });
    this.record({ type: "disposed", reason });
    this.unsubscribe?.();
    this.unsubscribe = null;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
    for (const s of this.subscribers) s.close();
    this.subscribers.clear();
    try {
      await this.live.dispose();
    } finally {
      this.onDisposed?.(this);
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
