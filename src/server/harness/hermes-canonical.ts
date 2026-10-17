// The canonical session dialect: how a chat rides the Hermes gateway that owns its home.
//
// A ticketed `/api/ws` connection (see hermes-gateway.ts) speaks Hermes's canonical
// wire — `gateway/session_contract.py`, the one its own Ink TUI, Desktop, and dashboard
// use — where the session namespace has different verbs and stricter contracts than the
// stdio `tui_gateway.entry` dialect the chat code was written against: `session.create`
// takes a closed parameter set with a `request_id`, prompts are admitted with a
// client-minted `input_id` and fenced by `execution_generation`, edits are
// revision-fenced `session.mutate` operations, and approvals arrive as events rather
// than server→client requests.
//
// Rather than rewrite the chat for that wire (and again on the next one), this module
// translates: it presents the stdio dialect's methods and shapes on top of the canonical
// connection, the way upstream's own clients do (the Ink TUI's `canonicalRequest` /
// `canonicalResult` shim, `hermes_cli/gateway_client.py`). The wire's differences then
// land here — negotiated through `runtime.describe`, which names the create contract the
// owner accepts — instead of breaking every call site. Nothing is written to the home,
// and the session belongs to the gateway: it outlives this link and every other client
// keeps seeing it.
import { randomUUID } from "node:crypto";
import { isObj, type Obj } from "./agent-events.js";
import { GatewaySocket, type GatewayEndpoint, type GatewayFrame, type GatewayLink } from "./hermes-gateway.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What `runtime.describe` promised: the create contract this owner accepts. */
interface Described {
  sources: string[];
  parameters: string[];
}

/** The live session this link holds: its subscription and the two fences edits are checked against. */
interface Tracked {
  sessionId: string;
  /** The durable id a resume is addressed by (the session survives this link). */
  storedId: string;
  subscriptionId: string;
  revision: number;
  generation: number;
}

/** A pending approval/clarify, keyed by the prompt id its `…respond` verb wants back. */
interface Control {
  kind: "approval" | "clarify";
  sessionId: string;
  generation: number;
  promptId: string;
}

/** Transcript rows as the stdio dialect projects them (role/text/tool_call_id/row_id/…). */
function projectedRows(messages: unknown): Obj[] {
  return (Array.isArray(messages) ? messages : []).filter(isObj).map((row) => {
    const content = row.content;
    const text = str(row.text) || (Array.isArray(content) ? content.map((part) => (typeof part === "string" ? part : isObj(part) && typeof part.text === "string" ? part.text : "")).filter(Boolean).join("\n") : "");
    return { ...row, ...(text ? { text } : {}) };
  });
}

/** A `prompt.submit`'s stdio-dialect edit keys, which the canonical wire does its own way. */
function truncateTarget(params: Obj): number | null {
  return num(params.truncate_before_row_id);
}

/**
 * One chat's connection to the owner: the stdio dialect in, the canonical wire out.
 * Also the reverse for prompts — canonical `approval.request` / `clarify.request`
 * events are presented as the `approval` / `clarify` server→client requests the chat
 * answers, and its answers go back as `approval.respond` / `clarify.respond`.
 */
export class CanonicalChatLink implements GatewayLink {
  readonly attached = true;
  private socket!: GatewaySocket;
  private described: Described | null = null;
  private session: Tracked | null = null;
  private rows: Obj[] | null = null;
  private readonly controls = new Map<string, Control>();

  private constructor(
    private readonly onEventOuter: (params: Obj) => void,
    private readonly onRequestOuter: (frame: GatewayFrame) => void,
  ) {}

  /** Dial the owner's canonical socket and wrap it in this dialect. */
  static async open(endpoint: GatewayEndpoint, ticket: string, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<CanonicalChatLink> {
    const link = new CanonicalChatLink(onEvent, onRequest);
    link.socket = await GatewaySocket.open(endpoint, ticket, (params) => link.onEvent(params), (frame) => link.onRequest(frame));
    return link;
  }

  get ready(): Promise<void> {
    return this.socket.ready;
  }

  get exited(): boolean {
    return this.socket.exited;
  }

  async request<T = unknown>(method: string, params: Obj = {}): Promise<T> {
    switch (method) {
      // Prompts are events on this wire; there is no capability handshake to make.
      case "client.capabilities":
        return {} as T;
      case "session.create":
        return this.create(params) as Promise<T>;
      case "session.resume":
        return this.resume(str(params.session_id)) as Promise<T>;
      case "session.history":
        return this.history(str(params.session_id)) as Promise<T>;
      case "prompt.submit":
        return this.submit(params) as Promise<T>;
      case "session.interrupt": {
        const session = this.require();
        return this.socket.request("session.interrupt", { session_id: session.sessionId, execution_generation: session.generation }) as Promise<T>;
      }
      // Closing the link detaches; the session belongs to the gateway and outlives it.
      case "session.close":
        return this.detach("client_close") as Promise<T>;
      case "config.set":
        return this.setConfig(params) as Promise<T>;
      case "session.title":
        return this.mutate("rename", { title: str(params.title) }, false) as Promise<T>;
      case "session.compress":
        return this.mutate("compress", str(params.focus_topic) ? { focus: str(params.focus_topic) } : {}, true) as Promise<T>;
      // Everything else (slash.exec, command.dispatch, complete.slash, model.options,
      // projects.tree, image.attach_bytes, …) is the same verb on both wires.
      default:
        return this.socket.request(method, params) as Promise<T>;
    }
  }

  /**
   * Answer a chat-side prompt. The synthesized prompt frames carry the prompt id as
   * their id, which is the key back to the fenced `…respond` verb; anything else is an
   * answer to a real server→client request (sudo, secret), which this wire still speaks.
   */
  respond(id: string | number, result: unknown): void {
    const control = this.controls.get(String(id));
    if (!control) return this.socket.respond(id, result);
    this.controls.delete(String(id));
    const payload = isObj(result) ? result : {};
    if (control.kind === "approval") {
      void this.socket
        .request("approval.respond", { session_id: control.sessionId, execution_generation: control.generation, prompt_id: control.promptId, choice: str(payload.choice) || "deny" })
        .catch(() => undefined);
      return;
    }
    const answers = isObj(payload.answers) ? payload.answers : {};
    // Canonical prompts arrive one question per card, so one answer settles one prompt.
    const answer = str(answers[control.promptId]) || str(Object.values(answers)[0]) || "";
    void this.socket
      .request("clarify.respond", { session_id: control.sessionId, execution_generation: control.generation, prompt_id: control.promptId, answer })
      .catch(() => undefined);
  }

  onExit(listener: (message: string) => void): void {
    this.socket.onExit(listener);
  }

  async kill(): Promise<void> {
    await this.socket.kill();
  }

  // ---- translation: the chat's verbs onto the wire's ------------------------------------------

  private require(): Tracked {
    if (!this.session) throw new Error("hermes has no session on this connection");
    return this.session;
  }

  /** `runtime.describe`, once per connection: the create contract this owner accepts. */
  private async describe(): Promise<Described> {
    if (this.described) return this.described;
    const result = await this.socket.request<Obj>("runtime.describe", {});
    const descriptor = isObj(result?.session_create) ? result.session_create : {};
    this.described = {
      sources: Array.isArray(descriptor.sources) ? descriptor.sources.map(String) : [],
      parameters: Array.isArray(descriptor.parameters) ? descriptor.parameters.map(String) : [],
    };
    return this.described;
  }

  private async create(params: Obj): Promise<Obj> {
    const described = await this.describe();
    // The owner names the sources it runs; "gui" is this surface, and a policy that
    // names none gets its first allowed one rather than a refused create.
    const source = described.sources.includes("gui") ? "gui" : (described.sources[0] ?? "cli");
    const request: Obj = { request_id: randomUUID(), source };
    const cwd = str(params.cwd);
    if (cwd && described.parameters.includes("cwd")) request.cwd = cwd;
    const title = str(params.title);
    if (title && described.parameters.includes("title")) request.title = title;
    return this.adopt(await this.socket.request<Obj>("session.create", request));
  }

  private async resume(sessionId: string): Promise<Obj> {
    return this.adopt(await this.socket.request<Obj>("session.resume", { session_id: sessionId, source: "webui", display_projection: true }));
  }

  /**
   * `session.history` is the stdio dialect's read; this wire projects the same rows on
   * create/resume ("resuming a live session attaches another event subscriber"), so the
   * snapshot is the history.
   */
  private async history(sessionId: string): Promise<Obj> {
    await this.resume(this.require().storedId || sessionId);
    return { messages: this.rows ?? [] };
  }
  /** Take a canonical snapshot as the stdio create/resume answer, keeping its fences. */
  private adopt(snapshot: Obj): Obj {
    const sessionId = str(snapshot.session_id);
    const subscriptionId = str(snapshot.subscription_id);
    const previous = this.session;
    this.session = {
      sessionId,
      storedId: str(snapshot.stored_session_id) || sessionId,
      subscriptionId,
      revision: num(snapshot.revision) ?? 0,
      generation: num(snapshot.execution_generation) ?? 0,
    };
    this.rows = projectedRows(snapshot.messages);
    // A resume over a live session returns a new subscription (the old one is a stale
    // viewer now); the TUI drops its predecessor the same way.
    if (previous?.subscriptionId && (previous.sessionId !== sessionId || previous.subscriptionId !== subscriptionId)) {
      void this.socket.request("session.detach", { session_id: previous.sessionId, subscription_id: previous.subscriptionId, end_reason: "superseded" }).catch(() => undefined);
    }
    const info: Obj = isObj(snapshot.info) ? snapshot.info : {};
    return {
      session_id: sessionId,
      stored_session_id: str(snapshot.stored_session_id) || sessionId,
      info: { ...info, running: snapshot.running === true },
      ...(isObj(snapshot.todo_state) ? { todo_state: snapshot.todo_state } : {}),
    };
  }

  /**
   * `prompt.submit`, with the stdio dialect's edit-and-retry (cut before a row, run the
   * new prompt in its place) done the canonical way: a `rewind` mutation first, then an
   * admitted submission with a client-minted input id.
   */
  private async submit(params: Obj): Promise<Obj> {
    const session = this.require();
    let target = truncateTarget(params);
    if (target === null && params.truncate_before_user_ordinal !== undefined) {
      // The stdio dialect cuts by turn number; the canonical wire rewinds to a row.
      const rows = ((await this.history(session.sessionId)) as { messages?: unknown }).messages;
      const users = (Array.isArray(rows) ? rows : []).filter(isObj).filter((row) => row.role === "user");
      target = num(users[num(params.truncate_before_user_ordinal) ?? 0]?.row_id);
    }
    if (target !== null) await this.mutate("rewind", { target_message_id: target }, true);
    const receipt = await this.socket.request<Obj>("prompt.submit", {
      session_id: session.sessionId,
      text: str(params.text),
      input_id: randomUUID(),
      queued: params.queued !== false,
    });
    const generation = num(receipt?.execution_generation);
    if (generation !== null) session.generation = generation;
    return receipt ?? {};
  }

  /** `config.set`'s model and reasoning keys are session mutations on this wire. */
  private async setConfig(params: Obj): Promise<Obj> {
    const key = str(params.key);
    if (key === "model") {
      // The picker's value is "model --provider provider" (see switchTarget in hermes.ts).
      const parts = str(params.value).trim().split(/\s+/);
      const model = parts.shift() ?? "";
      const providerAt = parts.indexOf("--provider");
      const provider = providerAt >= 0 ? parts[providerAt + 1] : undefined;
      return this.mutate("model", { model, ...(provider ? { provider } : {}) }, true);
    }
    if (key === "reasoning") return this.mutate("reasoning", { effort: str(params.value) }, true);
    return this.socket.request("config.set", params);
  }

  /** One revision-fenced edit; `fenced` edits also carry the generation they expect. */
  private async mutate(operation: string, payload: Obj, fenced: boolean): Promise<Obj> {
    const session = this.require();
    const request: Obj = { session_id: session.sessionId, request_id: randomUUID(), expected_revision: session.revision, operation, payload };
    if (fenced) request.expected_generation = session.generation;
    const result = await this.socket.request<Obj>("session.mutate", request);
    const revision = num(result?.revision);
    if (revision !== null) session.revision = revision;
    const generation = num(result?.execution_generation);
    if (generation !== null) session.generation = generation;
    return result ?? {};
  }

  private async detach(endReason: string): Promise<Obj> {
    const session = this.session;
    this.session = null;
    if (!session?.subscriptionId) return { detached: false };
    return this.socket.request("session.detach", { session_id: session.sessionId, subscription_id: session.subscriptionId, end_reason: endReason });
  }

  // ---- translation: the wire's events and prompts into the chat's ------------------------------

  private onEvent(params: Obj): void {
    const type = str(params.type);
    const payload = isObj(params.payload) ? params.payload : {};
    if (type === "approval.request" || type === "clarify.request") {
      const promptId = str(payload.prompt_id);
      if (!promptId) return;
      const sessionId = str(params.session_id) || this.session?.sessionId || "";
      const generation = num(payload.execution_generation) ?? this.session?.generation ?? 0;
      const kind = type === "approval.request" ? "approval" : "clarify";
      this.controls.set(promptId, { kind, sessionId, generation, promptId });
      this.onRequestOuter(promptFrame(kind, promptId, payload));
      return;
    }
    if (type === "approval.settled" || type === "clarify.settled") {
      // Another client answered (or the owner gave up on) a prompt this one still shows.
      const promptId = str(payload.prompt_id);
      if (promptId) this.onEventOuter({ type: "request.cancel", payload: { id: promptId } });
    }
    this.onEventOuter(params);
  }

  private onRequest(frame: GatewayFrame): void {
    this.onRequestOuter(frame);
  }
}

/** The `approval` / `clarify` request the chat already understands, for one canonical prompt. */
function promptFrame(kind: "approval" | "clarify", promptId: string, payload: Obj): GatewayFrame {
  if (kind === "approval") {
    return { jsonrpc: "2.0", id: promptId, method: "approval", params: { ...payload, request_id: promptId } };
  }
  // One question per card, unless a submitter asked for the batch (clarify_batch).
  const batch = (Array.isArray(payload.questions) ? payload.questions : []).filter(isObj).map((question) => ({
    qid: str(question.qid) || promptId,
    question: str(question.question),
    choices: Array.isArray(question.choices) ? question.choices.map(String) : [],
    multi_select: question.multi_select === true,
  }));
  const single = {
    qid: promptId,
    question: str(payload.question),
    choices: Array.isArray(payload.choices) ? payload.choices.map(String) : [],
    multi_select: payload.multi_select === true,
  };
  const questions = batch.length > 0 ? batch : single.question ? [single] : [];
  return { jsonrpc: "2.0", id: promptId, method: "clarify", params: { questions } };
}
