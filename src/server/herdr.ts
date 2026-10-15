// herdr (herdr.dev), the terminal workspace manager for coding agents, keeps a
// JSON socket API: one request per connection, a line of JSON each way. Its
// own integrations tell it which harness session each pane runs (Pi and omp by
// session file, Claude Code and Hermes by id). awui reads that list to mark the
// sessions open in a herdr pane, and to refuse a resume that would start a
// second harness on the same session file (one live writer per session); atui
// reports its own chats over the same socket (atui/herdr.ts). Herdr not
// running is the normal case, so every failure here is quiet: no panes.
import net from "node:net";
import path from "node:path";
import type { HerdrStatus } from "../shared/protocol.js";

export interface HerdrPane {
  paneId: string;
  agent: string;
  status: HerdrStatus;
  /** The session the pane's harness reported: a session file's path, or an id. */
  session: { kind: "id" | "path"; value: string; source: string } | null;
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Replies past this are not a pane list anyone runs. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
/** The sidebar polls; herdr answers in a millisecond or two, so a slow one is skipped, not waited on. */
const TIMEOUT_MS = 1000;
/** One pane list serves every request in this window (the sidebar, search, and a resume all ask). */
const PANES_TTL_MS = 1000;

/** Herdr's API socket: the one this process was started in (a herdr pane), else the file's, else the default session's. */
export function herdrSocketPath(env: NodeJS.ProcessEnv, home: string, configured?: string): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  if (configured) return configured === "~" || configured.startsWith("~/") ? path.join(home, configured.slice(1)) : configured;
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "herdr", "herdr.sock");
}

/** One request on herdr's socket: its `result`, or a HerdrError (herdr's own code, or why it could not be asked). */
export function herdrRequest(socket: string, method: string, params: Record<string, unknown> = {}, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const conn = net.createConnection(socket);
    const finish = (error: HerdrError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new HerdrError("timeout", `herdr did not answer ${method}`)), timeoutMs);
    conn.on("error", (error: NodeJS.ErrnoException) => finish(new HerdrError(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "not_running" : "socket", error.message)));
    conn.on("connect", () => conn.write(`${JSON.stringify({ id: `awui:${method}:${Date.now()}`, method, params })}\n`));
    conn.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPLY_BYTES) return finish(new HerdrError("too_large", `herdr's reply to ${method} is too large`));
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      let reply: { result?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof reply;
      } catch {
        return finish(new HerdrError("bad_reply", `herdr's reply to ${method} is not JSON`));
      }
      if (reply.error) finish(new HerdrError(String(reply.error.code ?? "error"), String(reply.error.message ?? "herdr refused")));
      else finish(null, reply.result);
    });
    conn.on("end", () => finish(new HerdrError("closed", `herdr closed the socket before answering ${method}`)));
  });
}

const STATUSES = new Set<HerdrStatus>(["idle", "done", "working", "blocked", "unknown"]);

/** `agent.list`'s agents, keeping only what awui uses (herdr adds fields freely). */
export function panesFrom(result: unknown): HerdrPane[] {
  const agents = (result as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(agents)) return [];
  const out: HerdrPane[] = [];
  for (const a of agents as Array<Record<string, unknown>>) {
    if (typeof a.pane_id !== "string" || typeof a.agent !== "string") continue;
    const s = a.agent_session as Record<string, unknown> | null | undefined;
    const kind = s?.kind === "id" ? "id" : s?.kind === "path" ? "path" : null;
    const session: HerdrPane["session"] = s && kind && typeof s.value === "string" && s.value ? { kind, value: s.value, source: typeof s.source === "string" ? s.source : "" } : null;
    out.push({ paneId: a.pane_id, agent: a.agent, status: STATUSES.has(a.agent_status as HerdrStatus) ? (a.agent_status as HerdrStatus) : "unknown", session });
  }
  return out;
}

/**
 * The awui session a pane runs, as `<harness>:<native id>`, or null. Pi and
 * omp report the session file, named `<time>_<id>.jsonl`, whose id is awui's
 * native id; Claude Code and Hermes report the id itself. A pane that atui
 * reported is awui's own chat, so it never counts.
 */
export function paneSessionId(p: HerdrPane): string | null {
  if (!p.session || p.session.source.startsWith("awui")) return null;
  if (p.session.kind === "id") return `${p.agent}:${p.session.value}`;
  const id = /_([^_/\\]+)\.jsonl$/.exec(p.session.value)?.[1];
  return id ? `${p.agent}:${id}` : null;
}

/** The server's view of herdr: its panes by session, while the setting is on. */
export class Herdr {
  private cached: { at: number; panes: Promise<HerdrPane[]> } | null = null;

  constructor(
    readonly socket: string,
    /** config.yml's `herdr` (or AWUI_HERDR), read when asked so the Settings dialog's change applies at once. */
    private readonly enabled: () => boolean,
  ) {}

  get on(): boolean {
    return this.enabled();
  }

  /** Every pane herdr knows an agent in; none while off or when herdr is not running. */
  panes(): Promise<HerdrPane[]> {
    if (!this.enabled()) return Promise.resolve([]);
    const now = Date.now();
    if (this.cached && now - this.cached.at < PANES_TTL_MS) return this.cached.panes;
    const panes = herdrRequest(this.socket, "agent.list").then(panesFrom, () => []);
    this.cached = { at: now, panes };
    return panes;
  }

  /** Session id (`<harness>:<native id>`) → the pane running it. */
  async bySession(): Promise<Map<string, HerdrPane>> {
    const out = new Map<string, HerdrPane>();
    for (const p of await this.panes()) {
      const id = paneSessionId(p);
      if (id && !out.has(id)) out.set(id, p);
    }
    return out;
  }

  /** Show `paneId` in herdr (its workspace and tab too), and mark its finish seen. */
  async focus(paneId: string): Promise<void> {
    if (!this.enabled()) throw new HerdrError("off", "The herdr integration is turned off");
    await herdrRequest(this.socket, "agent.focus", { target: paneId });
    this.cached = null;
  }
}
