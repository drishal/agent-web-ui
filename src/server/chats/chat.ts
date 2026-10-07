// One live chat: owns the adapter's LiveChat, folds normalized harness events
// into display state, and fans out a replayable, monotonic event stream. The
// fold (EventReducer), the stream (EventLog), and model-call timing (Timing)
// are collaborators; Chat itself keeps the LiveChat binding and the commands.
import type {
  AssistantItem,
  ChatConfig,
  ChatEvent,
  ChatItem,
  ChatSnapshot,
  ChatStatus,
  ContextUsage,
  ImageAttachment,
  ImageRef,
  InteractionAnswer,
  InteractionRequest,
  LimitAccount,
  QueueState,
  SendMode,
  SessionUsage,
  SlashCommand,
  SubagentRun,
  TodoItem,
  ToolItem,
  WorkspaceInfo,
} from "../../shared/protocol.js";
import { promises as fs } from "node:fs";
import { boundText, editShape, historyToItems, stringifyArgs, toolCategory, toolPaths, toolSummary } from "../harness/agent-events.js";
import { argsDiff, resultDiff } from "../harness/tool-diff.js";
import { applyReports, detailReports, runsFromArgs, runsFromDetails, settleRuns, transcriptFile, transcriptRecords, type AgentReport } from "../harness/subagents.js";
import { branchMessages } from "../harness/session-files.js";
import { rememberImage } from "../image-store.js";
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

/** Past this, a subagent transcript is read as its first and last halves. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

async function readEnds(file: string, size: number): Promise<string> {
  const half = MAX_TRANSCRIPT_BYTES / 2;
  const handle = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    await handle.read(head, 0, half, 0);
    await handle.read(tail, 0, half, size - half);
    // Cut lines are dropped by the JSONL readers.
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
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

/**
 * Model timing, measured from the stream because no harness reports it: a
 * call's request starts at the prompt or the last tool result (the hand-off),
 * its first token is its first delta, and it ends at assistant_end.
 */
class Timing {
  private handoffAt = 0;
  private requestAt = 0;
  private firstTokenAt = 0;
  private llmMs = 0;
  private ttftMs = 0;
  private ttftCount = 0;
  private genMs = 0;
  private genTokens = 0;

  /** Close the previous hand-off: the next call's request starts here. */
  markHandoff(at = Date.now()): void {
    this.handoffAt = at;
  }

  /** A model call begins; time-to-first-token is measured once per call. */
  startRequest(at = Date.now()): void {
    this.requestAt = this.handoffAt || at;
    this.firstTokenAt = 0;
  }

  firstToken(at = Date.now()): void {
    if (!this.requestAt || this.firstTokenAt) return;
    this.firstTokenAt = at;
    this.ttftMs += at - this.requestAt;
    this.ttftCount += 1;
  }

  /** Close the current model call; `outputTokens` feeds tokens per second. */
  endStep(outputTokens: number, at = Date.now()): void {
    if (!this.requestAt) return;
    this.llmMs += at - this.requestAt;
    if (this.firstTokenAt && outputTokens > 0 && at > this.firstTokenAt) {
      this.genMs += at - this.firstTokenAt;
      this.genTokens += outputTokens;
    }
    this.requestAt = 0;
    this.firstTokenAt = 0;
    this.handoffAt = at;
  }

  /** The harness's usage plus the timing it never reports. */
  compose(harness: HarnessUsage | null): SessionUsage | null {
    if (!harness) return null;
    return {
      ...harness,
      llmMs: this.llmMs > 0 ? this.llmMs : null,
      ttftMs: this.ttftCount > 0 ? Math.round(this.ttftMs / this.ttftCount) : null,
      tokensPerSecond: this.genMs > 0 ? Math.round((this.genTokens / this.genMs) * 1000) : null,
    };
  }
}

/**
 * The replayable, monotonic ChatEvent stream: event ids, fan-out to
 * subscribers, and the replay window that lets a reconnecting stream catch up.
 */
class EventLog {
  private entries: Array<{ id: number; event: ChatEvent }> = [];
  private nextEventId = 1;
  private subscribers = new Set<ChatSubscriber>();

  get lastEventId(): number {
    return this.nextEventId - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  record(event: ChatEvent): void {
    const id = this.nextEventId++;
    this.entries.push({ id, event });
    if (this.entries.length > MAX_LOG_EVENTS) this.entries.splice(0, this.entries.length - MAX_LOG_EVENTS);
    for (const s of this.subscribers) s.send(id, event);
  }

  /**
   * Subscribe a stream. With a lastEventId still inside the replay window the
   * missed events are replayed; otherwise the subscriber gets a fresh snapshot.
   */
  subscribe(subscriber: ChatSubscriber, lastEventId: number | undefined, snapshot: () => ChatSnapshot): () => void {
    const oldest = this.entries[0]?.id ?? this.nextEventId;
    const canReplay = lastEventId !== undefined && lastEventId >= oldest - 1 && lastEventId <= this.nextEventId - 1;
    if (canReplay) {
      for (const entry of this.entries) if (entry.id > lastEventId) subscriber.send(entry.id, entry.event);
    } else {
      subscriber.send(this.nextEventId - 1, { type: "snapshot", snapshot: snapshot() });
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Close every subscriber; the chat is going away. */
  closeAll(): void {
    for (const s of this.subscribers) s.close();
    this.subscribers.clear();
  }
}

/** What the event fold asks of the Chat around it: its side effects. */
interface ReducerEffects {
  /** The chat's current status (guards status transitions and notice ambience). */
  status(): ChatStatus;
  /** Move to a new status; the Chat emits the event and wakes settle waiters. */
  setStatus(status: ChatStatus): void;
  /** Re-read a derived view from the harness (best-effort). */
  refreshContext(): void;
  refreshUsage(): void;
  refreshTodos(): void;
  /** A session id arrived from the harness: tell the manager. */
  sessionAssigned(): void;
}

/**
 * The event fold: normalized harness events into display state (items, queue,
 * pending requests, config, title, …) and the outbound ChatEvent stream, with
 * deltas coalesced per item/field and tool updates throttled to the next
 * flush. Side effects — status changes, refreshes, the manager hook — go
 * through `fx`; everything else lives and dies here.
 */
class EventReducer {
  items: ChatItem[] = [];
  queue: QueueState = { steering: [], followUp: [] };
  extensionStatus: Record<string, string> = {};
  title = "";
  nativeId: string | null;
  config: ChatConfig;

  private index = new Map<string, number>();
  private pending = new Map<string, InteractionRequest>();
  private counter = 0;
  private currentAssistant: string | null = null;
  private currentModel: string | undefined;
  private pendingDeltas: Array<{ itemId: string; field: "text" | "thinking" | "output"; append: string }> = [];
  private dirtyTools = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly log: EventLog,
    private readonly timing: Timing,
    private readonly harnessId: HarnessAdapter["id"],
    config: ChatConfig,
    nativeId: string | null,
    private readonly fx: ReducerEffects,
  ) {
    this.config = config;
    this.nativeId = nativeId;
  }

  get sessionId(): string | null {
    return namespacedSessionId(this.harnessId, this.nativeId);
  }

  /** Seed from the harness's stored history: its items and the title it knows. */
  load(items: ChatItem[], title: string | null): void {
    for (const item of items) this.upsert(item);
    this.title = title ?? this.firstUserText() ?? "";
  }

  apply(event: HarnessEvent): void {
    switch (event.type) {
      case "user_message":
        this.finishStreaming();
        this.put({
          kind: "user",
          id: this.nextId("u"),
          text: event.text,
          ...(event.imageCount ? { imageCount: event.imageCount } : {}),
          ...(event.images?.length ? { images: event.images } : {}),
          ...(event.command ? { command: true as const } : {}),
          at: Date.now(),
        });
        if (!this.title && !event.command) this.setTitle(event.text.slice(0, 80));
        break;
      case "assistant_start":
        this.finishStreaming();
        this.currentModel = event.model;
        this.timing.startRequest();
        break;
      case "assistant_delta": {
        this.timing.firstToken();
        const item = this.ensureAssistant();
        item[event.field] += event.delta;
        this.pendingDeltas.push({ itemId: item.id, field: event.field, append: event.delta });
        this.scheduleFlush();
        break;
      }
      case "assistant_end": {
        this.timing.endStep(event.usage?.output ?? 0);
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
        const category = toolCategory(event.name);
        const edits = category === "edit" || category === "write";
        const runs = category === "agent" ? runsFromArgs(event.args) : null;
        const tool: ToolItem = {
          kind: "tool",
          id: `t:${event.toolCallId}`,
          name: event.name,
          args: stringifyArgs(event.args, category === "edit"),
          status: "running",
          output: "",
          truncated: false,
          category,
          summary: toolSummary(event.args),
          paths: toolPaths(event.args),
          ...(edits ? editShape(argsDiff(event.args), null) : {}),
          ...(runs ? { subagents: runs } : {}),
          at: Date.now(),
        };
        this.put(tool);
        break;
      }
      case "tool_update": {
        const item = this.get(`t:${event.toolCallId}`);
        if (!item || item.kind !== "tool") break;
        const bounded = boundText(event.output);
        // Subagent progress replaces the last snapshot (it is not a patch).
        const runs = item.category === "agent" && event.details !== undefined ? runsFromDetails(event.toolCallId, event.details, item.subagents ?? null) : null;
        this.upsert({ ...item, output: bounded.text, truncated: bounded.truncated, ...(runs ? { subagents: runs } : {}) });
        this.dirtyTools.add(item.id);
        this.scheduleFlush();
        break;
      }
      case "tool_end": {
        this.timing.markHandoff();
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
        const edits = base.category === "edit" || base.category === "write";
        // The harness's own diff beats the arguments' one; with neither, its output's own count.
        const reported = edits ? resultDiff(event.details, event.output) : null;
        const settled: ToolItem = { ...base, ...(!edits ? {} : reported ? editShape(reported, null) : base.diff ? {} : editShape(null, bounded.text)) };
        if (settled.category === "agent") {
          const runs = runsFromDetails(event.toolCallId, event.details, settled.subagents ?? null);
          if (runs) settled.subagents = settleRuns(runs, event.output, event.isError);
        }
        // A failed edit keeps the diff it tried, but changed nothing to count.
        const { diffStat: _attempted, ...uncounted } = settled;
        this.put({
          ...(event.isError ? uncounted : settled),
          output: bounded.text,
          truncated: bounded.truncated,
          status: event.isError ? "error" : "done",
          endedAt: Date.now(),
        });
        if (base.name.toLowerCase().includes("todo")) this.fx.refreshTodos();
        // A wait or a proc read reports on background runs another call started.
        const reports = detailReports(event.details);
        if (reports.length > 0) this.applyReports(reports);
        break;
      }
      case "subagent_reports":
        this.applyReports(event.reports);
        break;
      case "busy":
        if (this.fx.status() !== "stopping") this.fx.setStatus("running");
        break;
      case "settled":
        this.finishStreaming();
        if (this.fx.status() !== "error") this.fx.setStatus("idle");
        this.fx.refreshContext();
        this.fx.refreshUsage();
        this.fx.refreshTodos();
        break;
      case "compacting":
        if (event.active) this.fx.setStatus("compacting");
        else {
          if (this.fx.status() === "compacting") this.fx.setStatus("idle");
          this.fx.refreshContext();
        }
        break;
      case "queue":
        this.queue = { steering: [...event.queue.steering], followUp: [...event.queue.followUp] };
        this.emit({ type: "queue", queue: this.queue });
        break;
      case "notice":
        this.notice(event.level, event.text, undefined, { ...(event.title ? { title: event.title } : {}), ...(event.detail ? { detail: event.detail } : {}) });
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
          this.fx.sessionAssigned();
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
        this.fx.setStatus("error");
        break;
    }
  }

  /** Coalesce deltas per item/field and throttled tool updates into few events. */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const deltas = this.pendingDeltas;
    this.pendingDeltas = [];
    for (const d of deltas) this.log.record({ type: "delta", ...d });
    const tools = [...this.dirtyTools];
    this.dirtyTools.clear();
    for (const id of tools) {
      const item = this.get(id);
      if (item) this.log.record({ type: "item", item: { ...item } });
    }
  }

  emit(event: ChatEvent): void {
    if (event.type !== "delta") this.flushNow();
    this.log.record(event);
  }

  notice(level: "info" | "warning" | "error", text: string, ambient?: boolean, more: { title?: string; detail?: string } = {}): void {
    const status = this.fx.status();
    const busy = status === "running" || status === "stopping" || status === "compacting";
    const between = ambient ?? !busy;
    this.put({
      kind: "notice",
      id: this.nextId("n"),
      level,
      text,
      ...(more.title ? { title: more.title } : {}),
      ...(more.detail ? { detail: more.detail } : {}),
      at: Date.now(),
      ...(between ? { ambient: true } : {}),
    });
  }

  setTitle(title: string): void {
    this.title = title;
    this.emit({ type: "title", title, sessionId: this.sessionId });
  }

  replaceConfig(config: ChatConfig): void {
    this.config = config;
    this.emit({ type: "config", config });
  }

  /** Background runs reporting in: the call that started them shows it. */
  private applyReports(reports: AgentReport[]): void {
    for (const item of this.items) {
      if (item.kind !== "tool" || !item.subagents) continue;
      const next = applyReports(item.subagents, reports);
      if (next) this.put({ ...item, subagents: next });
    }
  }

  item(id: string): ChatItem | undefined {
    return this.get(id);
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  pendingRequest(requestId: string): InteractionRequest | undefined {
    return this.pending.get(requestId);
  }

  pendingRequests(): InteractionRequest[] {
    return [...this.pending.values()];
  }

  resolveRequest(requestId: string, outcome: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    this.put({ kind: "request", id: `r:${requestId}`, request, outcome });
    this.emit({ type: "request_resolved", requestId, outcome });
  }

  private firstUserText(): string | null {
    const first = this.items.find((i) => i.kind === "user");
    return first && first.kind === "user" ? first.text.slice(0, 80) : null;
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushNow(), DELTA_FLUSH_MS);
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
}

export class Chat {
  readonly createdAt = Date.now();
  status: ChatStatus = "idle";
  generation = 0;
  /** Last real conversation (a prompt sent, a turn finished): sidebar order. */
  lastActivity = Date.now();
  /** Last sign of use of any kind (events, sends, a viewer leaving): what the reaper's idle clock reads. */
  lastSeen = Date.now();
  onSession?: (chat: Chat) => void;
  onDisposed?: (chat: Chat) => void;
  /** The harness reported its subscription limits. */
  onLimits?: (account: LimitAccount) => void;

  private readonly log = new EventLog();
  private readonly timing = new Timing();
  private readonly reducer: EventReducer;
  private context: ContextUsage | null = null;
  private usage: SessionUsage | null = null;
  private todos: TodoItem[] = [];
  private settleWaiters: Array<() => void> = [];
  private unsubscribe: (() => void) | null = null;
  private readonly live: LiveChat;

  private constructor(
    readonly chatId: string,
    readonly adapter: HarnessAdapter,
    readonly workspace: WorkspaceInfo,
    live: LiveChat,
    config: ChatConfig,
  ) {
    this.live = live;
    this.reducer = new EventReducer(this.log, this.timing, adapter.id, config, live.nativeId, {
      status: () => this.status,
      setStatus: (status) => this.setStatus(status),
      refreshContext: () => void this.refreshContext(),
      refreshUsage: () => void this.refreshUsage(),
      refreshTodos: () => void this.refreshTodos(),
      sessionAssigned: () => this.onSession?.(this),
    });
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
    if (live.starting) chat.status = "starting";
    chat.context = context;
    chat.usage = chat.timing.compose(usage);
    chat.todos = todos;
    chat.reducer.load(items, live.title);
    // A resumed old chat keeps its stored recency until someone talks in it;
    // only a brand-new (empty) history starts at now.
    let latest: number | null = null;
    for (const i of items) {
      const at = i.at ?? (i.kind === "assistant" || i.kind === "tool" ? i.endedAt : undefined) ?? null;
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
    chat.lastActivity = latest ?? Date.now();
    chat.attach();
    return chat;
  }

  get harnessId() {
    return this.adapter.id;
  }

  get sessionId(): string | null {
    return this.reducer.sessionId;
  }

  get nativeId(): string | null {
    return this.reducer.nativeId;
  }

  get title(): string {
    return this.reducer.title;
  }

  get subscriberCount(): number {
    return this.log.subscriberCount;
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
    this.reducer.flushNow();
    return {
      chatId: this.chatId,
      harnessId: this.adapter.id,
      sessionId: this.sessionId,
      workspace: this.workspace,
      title: this.title,
      status: this.status,
      items: this.reducer.items.map((i) => ({ ...i })),
      queue: { steering: [...this.reducer.queue.steering], followUp: [...this.reducer.queue.followUp] },
      pending: this.reducer.pendingRequests(),
      config: this.reducer.config,
      capabilities: this.adapter.capabilities,
      extensionStatus: { ...this.reducer.extensionStatus },
      context: this.context,
      usage: this.usage,
      todos: [...this.todos],
      generation: this.generation,
      lastEventId: this.log.lastEventId,
    };
  }

  /**
   * Subscribe a stream. With a lastEventId still inside the replay window the
   * missed events are replayed; otherwise the subscriber gets a fresh snapshot.
   */
  subscribe(subscriber: ChatSubscriber, lastEventId?: number): () => void {
    this.reducer.flushNow();
    this.lastSeen = Date.now();
    const unsubscribe = this.log.subscribe(subscriber, lastEventId, () => this.snapshot());
    return () => {
      // The idle clock starts when the last viewer leaves, not at the last message.
      this.lastSeen = Date.now();
      unsubscribe();
    };
  }

  apply(event: HarnessEvent): void {
    if (event.type === "limits") {
      this.onLimits?.(event.account);
      return;
    }
    // Viewing must not promote the chat: only real conversation (a prompt sent
    // or a turn finished) counts as activity for sidebar ordering. Replay on
    // open, status flaps, config/title/usage refreshes all stay quiet.
    if (event.type === "user_message" || event.type === "assistant_end") this.lastActivity = Date.now();
    this.lastSeen = Date.now();
    this.reducer.apply(event.type === "user_message" ? this.withSentImages(event) : event);
  }

  /**
   * Images sent from here, oldest first, until the harness echoes their prompt.
   * Most harnesses echo only a count; the prompt then gets the images it was sent with.
   */
  private sentImages: ImageRef[][] = [];

  private withSentImages(event: Extract<HarnessEvent, { type: "user_message" }>): HarnessEvent {
    if (!event.imageCount) return event;
    const at = this.sentImages.findIndex((refs) => refs.length === event.imageCount);
    const sent = at >= 0 ? this.sentImages.splice(at, 1)[0] : undefined;
    return event.images?.length || !sent ? event : { ...event, images: sent };
  }

  private setStatus(status: ChatStatus): void {
    if (this.status === status || this.status === "disposed") return;
    this.status = status;
    this.reducer.emit({ type: "status", status });
    if (status === "idle" || status === "error") {
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private async refreshContext(): Promise<void> {
    const generation = this.generation;
    try {
      const context = await this.live.getContextUsage();
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(context) === JSON.stringify(this.context)) return;
      this.context = context;
      this.reducer.emit({ type: "context", context });
    } catch {
      // usage is best-effort
    }
  }

  private async refreshUsage(): Promise<void> {
    const generation = this.generation;
    try {
      const usage = this.timing.compose(await this.live.getUsage());
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
      this.usage = usage;
      this.reducer.emit({ type: "usage", usage });
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
      this.reducer.emit({ type: "todos", todos });
    } catch {
      // todos are best-effort
    }
  }

  private waitForSettle(): Promise<void> {
    if (this.status === "idle" || this.status === "error" || this.status === "disposed") return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    this.settleWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    return promise;
  }

  private assertOpen(): void {
    if (this.status === "disposed") throw new ChatError(410, "chat_closed", "This chat was closed");
  }

  // ---- commands -------------------------------------------------------------

  async send(text: string, mode: SendMode, images: ImageAttachment[] = []): Promise<void> {
    this.assertOpen();
    if (images.length > 0) {
      const refs = images.map((i) => rememberImage(i.mimeType, i.data)).filter((r): r is ImageRef => r !== null);
      // A handful at most: a prompt the harness never echoes must not pin images forever.
      this.sentImages = [...this.sentImages, refs].slice(-8);
    }
    this.lastActivity = Date.now();
    this.lastSeen = this.lastActivity;
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
    this.timing.markHandoff();
    try {
      await this.live.prompt(text, images);
    } catch (error) {
      this.reducer.notice("error", `Prompt rejected: ${errorMessage(error)}`, true);
      this.setStatus("idle");
      throw new ChatError(422, "prompt_rejected", errorMessage(error));
    }
  }

  async abort(): Promise<void> {
    this.assertOpen();
    if (this.status !== "running" && this.status !== "compacting" && this.status !== "stopping") return;
    this.setStatus("stopping");
    for (const id of this.reducer.pendingIds()) this.reducer.resolveRequest(id, "Cancelled");
    try {
      await this.live.abort();
    } catch (error) {
      this.reducer.notice("error", `Stop failed: ${errorMessage(error)}`);
    }
    await this.waitForSettle();
    if (this.status === "stopping") this.setStatus("idle");
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    this.assertOpen();
    // While starting the change waits for the harness, which applies it before any run.
    if (this.status !== "idle" && this.status !== "error" && this.status !== "starting") {
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
    this.reducer.replaceConfig(await this.live.getConfig());
  }

  /** The harness's "/" commands; an empty list when it cannot say (the menu then offers the app's own). */
  async commands(): Promise<SlashCommand[]> {
    this.assertOpen();
    return this.live.listCommands().catch(() => []);
  }

  async refreshModels(): Promise<void> {
    this.assertOpen();
    await this.live.refreshModels();
    this.reducer.replaceConfig(await this.live.getConfig());
  }

  async rename(name: string): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsRename) throw new ChatError(400, "unsupported", "Rename is not supported");
    await this.live.rename(name);
    this.reducer.setTitle(name);
  }

  async compact(instructions?: string): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsCompact) throw new ChatError(400, "unsupported", "Compact is not supported");
    if (this.status !== "idle") throw new ChatError(409, "busy", "Compact only while idle");
    this.setStatus("compacting");
    try {
      await this.live.compact(instructions);
    } catch (error) {
      this.reducer.notice("error", `Compaction failed: ${errorMessage(error)}`);
    } finally {
      // Re-read: events during the await may have moved the status on.
      if ((this.status as ChatStatus) === "compacting") this.setStatus("idle");
    }
  }

  /** A subagent's own transcript, as display items: read from the file its harness wrote. */
  async subagentTranscript(toolId: string, runId: string): Promise<{ run: SubagentRun; items: ChatItem[] }> {
    const tool = this.reducer.item(toolId);
    const run = tool?.kind === "tool" ? tool.subagents?.runs.find((r) => r.id === runId) : undefined;
    if (!tool || tool.kind !== "tool" || !run) throw new ChatError(404, "no_subagent", "No such subagent in this chat");
    const callId = toolId.replace(/^t:/, "");
    const file =
      transcriptFile(callId, runId) ??
      (this.nativeId && this.adapter.subagentTranscriptFile ? await this.adapter.subagentTranscriptFile({ nativeId: this.nativeId, cwd: this.workspace.path }, run) : null);
    if (!file) return { run, items: [] };
    let text: string;
    try {
      const { size } = await fs.stat(file);
      // Head and tail of an enormous one: its brief and how it ended.
      text = size > MAX_TRANSCRIPT_BYTES ? await readEnds(file, size) : await fs.readFile(file, "utf8");
    } catch {
      return { run, items: [] };
    }
    const messages = transcriptRecords(text) ?? branchMessages(text);
    return { run, items: historyToItems(messages) };
  }

  answer(requestId: string, answer: InteractionAnswer): string {
    this.assertOpen();
    const request = this.reducer.pendingRequest(requestId);
    if (!request) throw new ChatError(409, "request_resolved", "This request was already answered or cancelled");
    const outcome = describeAnswer(request, answer);
    // Synchronous check-deliver-resolve: the first answer wins, later ones see 409.
    const delivered = this.live.answer(requestId, answer);
    if (!delivered) {
      this.reducer.resolveRequest(requestId, "Cancelled");
      throw new ChatError(409, "request_resolved", "The harness no longer waits for this request");
    }
    this.reducer.resolveRequest(requestId, outcome);
    return outcome;
  }

  async dispose(reason: string): Promise<void> {
    if (this.status === "disposed") return;
    for (const id of this.reducer.pendingIds()) this.reducer.resolveRequest(id, "Cancelled");
    this.reducer.flushNow();
    this.status = "disposed";
    this.log.record({ type: "status", status: "disposed" });
    this.log.record({ type: "disposed", reason });
    this.unsubscribe?.();
    this.unsubscribe = null;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
    this.log.closeAll();
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
