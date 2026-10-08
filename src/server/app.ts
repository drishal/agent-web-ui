import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError, type ZodType } from "zod";
import {
  answerSchema,
  type Bootstrap,
  type ChatEvent,
  compactSchema,
  createChatSchema,
  forkChatSchema,
  handoffSchema,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_MESSAGE_CHARS,
  openWorkspaceSchema,
  patchConfigSchema,
  renameSchema,
  settingsPatchSchema,
  resumeChatSchema,
  sessionMarkSchema,
  pushSubscriptionSchema,
  pushTestSchema,
  putBackSchema,
  restoreSchema,
  type CheckpointPreview,
  type CheckpointRestored,
  type ProjectSession,
  sendMessageSchema,
  type SessionsOverview,
  type SessionSummary,
  type WorkspaceInfo,
} from "../shared/protocol.js";
import { ChatError, errorMessage, type Chat } from "./chats/chat.js";
import { storedImage } from "./image-store.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessRegistry } from "./harness/registry.js";
import type { HarnessAdapter, NativeSessionSummary } from "./harness/types.js";
import { briefPrompt, isEmptySeed, toSeed } from "./harness/handoff.js";
import { sniffImage } from "./images.js";
import type { Security } from "./security.js";
import type { ThemeStore } from "./theme.js";
import { readSettings, writeSettings, type Requester, type SettingsContext } from "./settings.js";
import { readUserConfig, uiSettings } from "./user-config.js";
import { SessionMarks } from "./session-marks.js";
import { Limits } from "./limits.js";
import { Notifier, pushEndpointProblem } from "./notify.js";
import { Checkpoints } from "./checkpoints.js";
import { gitFileDiff, gitStatus } from "./git-status.js";
import type { Workspaces } from "./workspaces.js";

/** How many of each harness's newest sessions the sidebar sees across projects. */
export const RECENT_SESSIONS_PER_HARNESS = 200;

export interface AppDeps {
  version: string;
  home: string;
  registry: HarnessRegistry;
  manager: ChatManager;
  workspaces: Workspaces;
  security: Security;
  theme: ThemeStore;
  pairingUrls: string[];
  webDir: string | null;
  /** Where config.yml lives; its browser settings are re-read on every page load. */
  configDir?: string | null;
  /** The Settings dialog's view of config.yml; without it the settings routes answer 404. */
  settings?: SettingsContext;
  heartbeatMs?: number;
  /** Pinned and archived sessions; in memory when absent. */
  marks?: SessionMarks;
  /** Subscription limits; in memory when absent. */
  limits?: Limits;
  /** Notes and Web Push for devices that turned notifications on; in memory when absent. */
  notifier?: Notifier;
  /** Where file checkpoints live (shadow repositories, and each session's list); none when absent. */
  checkpointsDir?: string | null;
  log?: (message: string) => void;
}

function body<T>(schema: ZodType<T>, req: Request): T {
  return schema.parse(req.body ?? {});
}

function parseLastEventId(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * One native session as a sidebar row: ids, ISO timestamps, and the live chat
 * when one is open. Pass `ws` to attach the owning project — the all-projects
 * list carries `workspaceId`; the per-harness list intentionally does not.
 */
function toSession(adapter: HarnessAdapter, s: NativeSessionSummary, ws: WorkspaceInfo, live?: Chat | null): ProjectSession;
function toSession(adapter: HarnessAdapter, s: NativeSessionSummary, ws: null, live?: Chat | null): SessionSummary;
function toSession(
  adapter: HarnessAdapter,
  s: NativeSessionSummary,
  ws: WorkspaceInfo | null,
  live?: Chat | null,
): SessionSummary | ProjectSession {
  const summary: SessionSummary = {
    id: `${adapter.id}:${s.nativeId}`,
    harnessId: adapter.id,
    title: s.title,
    updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
    ...(s.messageCount !== undefined ? { messageCount: s.messageCount } : {}),
    ...(live ? { liveChatId: live.chatId, status: live.status } : {}),
  };
  return ws ? { ...summary, workspaceId: ws.id } : summary;
}

export function createApp(deps: AppDeps) {
  const { registry, manager, workspaces, security, theme } = deps;
  const marks = deps.marks ?? SessionMarks.inMemory();
  const limits = deps.limits ?? Limits.inMemory(registry);
  manager.onLimits = (account) => limits.report(account);
  const notifier = deps.notifier ?? Notifier.inMemory();
  if (deps.checkpointsDir) manager.checkpoints = { service: new Checkpoints(deps.checkpointsDir), sessionsDir: path.join(deps.checkpointsDir, "sessions") };
  manager.onNews = (chat, kind, text) => {
    notifier.notify({ kind, chatId: chat.chatId, sessionId: chat.sessionId, title: chat.title || "New chat", body: text });
  };
  const log = deps.log ?? ((m: string) => console.error(m));
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "font-src": ["'self'"],
          "connect-src": ["'self'"],
          "object-src": ["'none'"],
          "base-uri": ["'none'"],
          "form-action": ["'self'"],
          "frame-ancestors": ["'none'"],
        },
      },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: false,
    }),
  );
  app.use(security.trust);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Sign-in for other devices; reachable without a session.
  app.post("/api/login", express.json({ limit: "8kb" }), security.login);
  app.post("/api/logout", security.logout);

  app.use("/api", security.requireAuth, (_req, res, next) => {
    // Session-bearing JSON must never be cached by a browser or proxy.
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // Only sending a message may carry images; every other body stays small.
  const textJson = express.json({ limit: `${Math.ceil((MAX_MESSAGE_CHARS * 4) / 1024) + 64}kb` });
  const messageJson = express.json({
    limit: `${Math.ceil((MAX_MESSAGE_CHARS * 4 + MAX_IMAGES * Math.ceil(MAX_IMAGE_BYTES / 3) * 4) / 1024) + 64}kb`,
  });
  app.use("/api", (req, res, next) => (req.method === "POST" && /^\/chats\/[^/]+\/messages$/.test(req.path) ? messageJson : textJson)(req, res, next));

  // A broken config.yml keeps the defaults here; the server logged why at startup.
  const browserSettings = () => {
    try {
      return uiSettings(readUserConfig(deps.configDir ?? null)?.config);
    } catch {
      return uiSettings(undefined);
    }
  };

  let statusAt = 0;
  app.get("/api/bootstrap", async (req, res) => {
    if (Date.now() - statusAt > 60_000 || req.query.refresh === "1") {
      await registry.refreshStatus();
      statusAt = Date.now();
    }
    const t = await theme.get();
    const payload: Bootstrap = {
      version: deps.version,
      auth: {
        mode: res.locals.local === true ? "local" : "password",
        username: security.username,
        remoteEnabled: security.username !== null,
      },
      harnesses: registry.status(),
      roots: workspaces.rootList,
      home: deps.home,
      theme: { active: t.name ?? "built-in", ...(t.problem ? { problem: t.problem } : {}) },
      ui: browserSettings(),
      pairing: { urls: deps.pairingUrls },
      limits: { maxMessageChars: MAX_MESSAGE_CHARS },
    };
    res.json(payload);
  });

  // Settings: any signed-in device may read and change them (a save that would lock that device out is refused) and restart.
  const settingsCtx = (): SettingsContext => {
    if (!deps.settings) throw new ChatError(404, "no_settings", "Settings are not available on this server");
    return deps.settings;
  };
  const requester = (req: Request, res: Response): Requester => ({
    local: res.locals.local === true,
    kind: res.locals.hostKind as Requester["kind"],
    authority: String(res.locals.authority ?? ""),
    tailscaleUser: res.locals.hostKind === "remote" ? String(req.headers["tailscale-user-login"] ?? "").toLowerCase() || null : null,
  });
  app.get("/api/settings", (_req, res) => {
    res.json(readSettings(settingsCtx(), true));
  });
  app.put("/api/settings", (req, res) => {
    const ctx = settingsCtx();
    res.json(writeSettings(ctx, body(settingsPatchSchema, req), requester(req, res)));
  });
  app.post("/api/settings/restart", (_req, res) => {
    const ctx = settingsCtx();
    if (!ctx.canRestart) throw new ChatError(409, "no_supervisor", "Nothing would start the server again: restart it yourself");
    res.status(202).json({ restarting: true });
    // The same graceful stop as a SIGTERM from systemd, which then starts it again (Restart=always).
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 300);
  });

  app.get("/api/theme", async (_req, res) => {
    res.json(await theme.get());
  });

  app.get("/api/workspaces/browse", async (req, res) => {
    const p = typeof req.query.path === "string" ? req.query.path : undefined;
    res.json(await workspaces.browse(p));
  });

  app.post("/api/workspaces/open", async (req, res) => {
    const { path: p } = body(openWorkspaceSchema, req);
    res.json(await workspaces.open(p));
  });

  const adapterOr404 = (id: string) => {
    const adapter = registry.get(id);
    if (!adapter) throw new ChatError(404, "unknown_harness", "Unknown harness");
    return adapter;
  };
  const availableAdapter = (id: string) => {
    const adapter = adapterOr404(id);
    if (!registry.isAvailable(id)) throw new ChatError(422, "harness_unavailable", `${adapter.displayName} is not installed`);
    return adapter;
  };

  app.get("/api/harnesses/:id/sessions", async (req, res) => {
    const adapter = availableAdapter(req.params.id);
    const ws = await workspaces.get(String(req.query.workspaceId ?? ""));
    const problem = adapter.workspaceProblem(ws.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const native = await adapter.listSessions(ws.path);
    const seen = new Set<string>();
    const sessions: SessionSummary[] = native.map((s) => {
      seen.add(s.nativeId);
      // No workspaceId: this route is already project-scoped.
      return toSession(adapter, s, null, manager.liveChatFor(adapter.id, s.nativeId));
    });
    // Live chats whose session the harness has not persisted yet.
    for (const chat of manager.list()) {
      if (chat.harnessId !== adapter.id || chat.workspace.id !== ws.id || chat.status === "disposed") continue;
      if (chat.nativeId && seen.has(chat.nativeId)) continue;
      sessions.unshift({
        id: chat.sessionId ?? `${adapter.id}:live-${chat.chatId}`,
        harnessId: adapter.id,
        title: chat.title || "New chat",
        updatedAt: new Date(chat.lastActivity).toISOString(),
        liveChatId: chat.chatId,
        status: chat.status,
      });
    }
    res.json({ sessions });
  });

  // The sidebar's list: each harness's newest sessions across projects, every
  // session of the current project (`?path=`), and live chats not saved yet.
  // Projects outside WORKSPACE_ROOTS, or that a harness cannot open, are left out.
  app.get("/api/sessions", async (req, res) => {
    const resolved = new Map<string, Promise<WorkspaceInfo | null>>();
    const workspaceFor = (cwd: string) => {
      let ws = resolved.get(cwd);
      if (!ws) {
        ws = workspaces.open(cwd).catch(() => null);
        resolved.set(cwd, ws);
      }
      return ws;
    };
    const current = typeof req.query.path === "string" && req.query.path ? await workspaceFor(req.query.path) : null;
    const projects = new Map<string, WorkspaceInfo>(current ? [[current.id, current]] : []);
    const sessions = new Map<string, ProjectSession>();
    const add = (adapter: HarnessAdapter, s: NativeSessionSummary, ws: WorkspaceInfo) => {
      const id = `${adapter.id}:${s.nativeId}`;
      if (sessions.has(id)) return;
      projects.set(ws.id, ws);
      sessions.set(id, toSession(adapter, s, ws, manager.liveChatFor(adapter.id, s.nativeId)));
    };
    const errors: string[] = [];
    const adapters = registry.list().filter((a) => registry.isAvailable(a.id));
    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          const here = current && !adapter.workspaceProblem(current.path) ? await adapter.listSessions(current.path) : [];
          if (current) for (const s of here) add(adapter, s, current);
          for (const s of await adapter.listRecentSessions(RECENT_SESSIONS_PER_HARNESS)) {
            const ws = await workspaceFor(s.cwd);
            if (ws && !adapter.workspaceProblem(ws.path)) add(adapter, s, ws);
          }
        } catch (error) {
          errors.push(`${adapter.displayName}: ${errorMessage(error)}`);
        }
      }),
    );
    for (const chat of manager.list()) {
      if (chat.status === "disposed") continue;
      const id = chat.sessionId ?? `${chat.harnessId}:live-${chat.chatId}`;
      if (sessions.has(id)) continue;
      projects.set(chat.workspace.id, chat.workspace);
      sessions.set(id, {
        id,
        harnessId: chat.harnessId,
        title: chat.title || "New chat",
        updatedAt: new Date(chat.lastActivity).toISOString(),
        liveChatId: chat.chatId,
        status: chat.status,
        workspaceId: chat.workspace.id,
      });
    }
    for (const [id, s] of sessions) {
      const mark = marks.get(id);
      if (mark) sessions.set(id, { ...s, ...mark });
    }
    const overview: SessionsOverview = {
      workspaces: [...projects.values()],
      sessions: [...sessions.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
      errors,
    };
    res.json(overview);
  });

  // Notifications. A push only wakes the device's service worker, which then reads the notes here.
  app.get("/api/push/key", (_req, res) => {
    res.json({ key: notifier.applicationServerKey });
  });
  app.post("/api/push/subscribe", async (req, res) => {
    const { endpoint } = body(pushSubscriptionSchema, req);
    const problem = pushEndpointProblem(endpoint);
    if (problem) throw new ChatError(422, "bad_push_endpoint", problem);
    await notifier.subscribe(endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", async (req, res) => {
    await notifier.unsubscribe(body(pushSubscriptionSchema, req).endpoint);
    res.json({ ok: true });
  });
  app.post("/api/push/test", (req, res) => {
    const { endpoint } = body(pushTestSchema, req);
    res.json(notifier.notify({ kind: "done", chatId: "", sessionId: null, title: "Agent Web UI", body: "Notifications work on this device" }, endpoint));
  });
  /** Notes after `since` (epoch ms, as `now` last said); without it, the last two minutes. */
  app.get("/api/notifications", (req, res) => {
    const raw = typeof req.query.since === "string" && /^\d{1,15}$/.test(req.query.since) ? Number(req.query.since) : null;
    const now = Date.now();
    res.json({ notes: notifier.since(raw ?? now - 120_000), now });
  });

  app.get("/api/limits", async (_req, res) => {
    res.json(await limits.get());
  });

  app.post("/api/sessions/marks", async (req, res) => {
    const { sessionId, ...change } = body(sessionMarkSchema, req);
    res.json(await marks.set(sessionId, change));
  });

  app.post("/api/chats", async (req, res) => {
    const input = body(createChatSchema, req);
    const adapter = availableAdapter(input.harnessId);
    const ws = await workspaces.get(input.workspaceId);
    const chat = await manager.create(adapter, ws);
    res.status(201).json(chat.snapshot());
  });

  app.post("/api/chats/resume", async (req, res) => {
    const input = body(resumeChatSchema, req);
    const adapter = availableAdapter(input.harnessId);
    const prefix = `${adapter.id}:`;
    if (!input.sessionId.startsWith(prefix)) throw new ChatError(400, "wrong_harness", "Session belongs to another harness");
    const ws = await workspaces.get(input.workspaceId);
    const chat = await manager.resume(adapter, ws, input.sessionId.slice(prefix.length));
    res.json(chat.snapshot());
  });

  // An image under a prompt (see image-store): the id is the hash of its bytes, so it never changes.
  app.get("/api/images/:id", (req, res) => {
    const image = /^[0-9a-f]{32}$/.test(req.params.id) ? storedImage(req.params.id) : null;
    if (!image) throw new ChatError(404, "no_image", "That image is no longer held; reload the chat");
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(image.bytes);
  });

  app.get("/api/chats/:id", (req, res) => {
    res.json(manager.get(req.params.id).snapshot());
  });

  app.get("/api/chats/:id/events", (req, res) => {
    const chat = manager.get(req.params.id);
    const last = parseLastEventId(req.headers["last-event-id"] ?? req.query.lastEventId);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    let closed = false;
    const write = (chunk: string) => {
      if (!closed) res.write(chunk);
    };
    const unsubscribe = chat.subscribe(
      {
        send: (id: number, event: ChatEvent) => write(`id: ${id}\nevent: chat\ndata: ${JSON.stringify(event)}\n\n`),
        close: () => {
          if (!closed) {
            closed = true;
            res.end();
          }
        },
      },
      last,
    );
    const heartbeat = setInterval(() => write("event: heartbeat\ndata: {}\n\n"), deps.heartbeatMs ?? 20_000);
    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/chats/:id/messages", async (req, res) => {
    const chat = manager.get(req.params.id);
    const { text, images, mode } = body(sendMessageSchema, req);
    for (const image of images) {
      if (sniffImage(image.data) !== image.mimeType) throw new ChatError(400, "bad_image", "An attachment is not the image type it claims to be");
    }
    await chat.send(text, mode, images);
    res.status(202).json({ accepted: true, mode });
  });

  app.post("/api/chats/:id/abort", (req, res) => {
    const chat = manager.get(req.params.id);
    chat.abort().catch((error: unknown) => log(`abort failed: ${errorMessage(error)}`));
    res.status(202).json({ accepted: true });
  });

  app.patch("/api/chats/:id/config", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.setConfig(body(patchConfigSchema, req));
    res.json(chat.snapshot().config);
  });

  // A subagent's own transcript, for the viewer: read from the file its harness wrote.
  app.get("/api/chats/:id/tools/:toolId/agents/:runId", async (req, res) => {
    res.json(await manager.get(req.params.id).subagentTranscript(req.params.toolId, req.params.runId));
  });

  app.get("/api/chats/:id/commands", async (req, res) => {
    res.json({ commands: await manager.get(req.params.id).commands() });
  });

  app.post("/api/chats/:id/models/refresh", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.refreshModels();
    res.json(chat.snapshot().config);
  });

  app.post("/api/chats/:id/rename", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.rename(body(renameSchema, req).name);
    res.json({ title: chat.title });
  });

  app.post("/api/chats/:id/compact", (req, res) => {
    const chat = manager.get(req.params.id);
    const { instructions } = body(compactSchema, req);
    if (chat.status !== "idle") throw new ChatError(409, "busy", "Compact only while idle");
    chat.compact(instructions).catch((error: unknown) => log(`compact failed: ${errorMessage(error)}`));
    res.status(202).json({ accepted: true });
  });

  // The project's git status (the composer's git row) and a listed file's diff.
  app.get("/api/chats/:id/git", async (req, res) => {
    const chat = manager.get(req.params.id);
    res.json({ status: await gitStatus(chat.workspace.path).catch(() => null) });
  });
  app.get("/api/chats/:id/git/diff", async (req, res) => {
    const chat = manager.get(req.params.id);
    const file = typeof req.query.path === "string" ? req.query.path : "";
    if (!file || file.length > 4096) throw new ChatError(400, "bad_path", "Name a changed file");
    const side = req.query.side === "staged" || req.query.side === "untracked" ? req.query.side : "unstaged";
    const diff = await gitFileDiff(chat.workspace.path, file, side).catch((error: unknown) => {
      throw new ChatError(422, "git_failed", errorMessage(error));
    });
    if (!diff) throw new ChatError(404, "not_changed", "That file has no changes now");
    res.json(diff);
  });

  // File checkpoints: what restoring a turn would do, doing it, and putting the files back again.
  const checkpointsOf = (chat: Chat, write: boolean) => {
    if (!chat.checkpoints) throw new ChatError(404, "no_checkpoints", "This chat keeps no file checkpoints");
    if (write && chat.status !== "idle" && chat.status !== "error") throw new ChatError(409, "busy", "Wait until the agent is idle");
    return chat.checkpoints;
  };
  const turnOf = (raw: string) => {
    const turn = Number(raw);
    if (!Number.isInteger(turn) || turn < 1) throw new ChatError(400, "bad_turn", "Not a turn");
    return turn;
  };
  const checkpointFailure = (error: unknown): never => {
    throw error instanceof ChatError ? error : new ChatError(422, "checkpoint_failed", errorMessage(error));
  };
  app.get("/api/chats/:id/checkpoints/:turn", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), false);
    const { files } = await cp.preview(turnOf(req.params.turn)).catch(checkpointFailure);
    res.json({ files } satisfies CheckpointPreview);
  });
  app.post("/api/chats/:id/checkpoints/:turn/restore", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), true);
    const { paths } = body(restoreSchema, req);
    res.json((await cp.restore(turnOf(req.params.turn), paths).catch(checkpointFailure)) satisfies CheckpointRestored);
  });
  app.post("/api/chats/:id/checkpoints/put-back", async (req, res) => {
    const cp = checkpointsOf(manager.get(req.params.id), true);
    const { tree, paths } = body(putBackSchema, req);
    const all = paths ?? (await cp.previewTree(tree).catch(checkpointFailure)).files.map((f) => f.path);
    if (all.length === 0) {
      res.json({ files: [], undo: tree } satisfies CheckpointRestored);
      return;
    }
    res.json((await cp.restore(null, all, tree).catch(checkpointFailure)) satisfies CheckpointRestored);
  });

  app.post("/api/chats/:id/fork", async (req, res) => {
    const { through } = body(forkChatSchema, req);
    const chat = manager.get(req.params.id);
    if (!chat.adapter.capabilities.supportsFork) throw new ChatError(400, "unsupported", `${chat.adapter.displayName} sessions cannot be forked`);
    if (!chat.nativeId) throw new ChatError(409, "not_started", "This chat has no session to fork yet");
    const forked = await chat.adapter.forkSession({ cwd: chat.workspace.path, nativeId: chat.nativeId, throughTurns: through });
    res.status(201).json((await manager.resume(chat.adapter, chat.workspace, forked.nativeId)).snapshot());
  });

  app.post("/api/chats/:id/handoff", async (req, res) => {
    const { harness, through, prompt } = body(handoffSchema, req);
    const chat = manager.get(req.params.id);
    const target = availableAdapter(harness);
    if (target.id === chat.adapter.id) throw new ChatError(400, "same_harness", "That chat is already in this harness");
    if (!chat.nativeId) throw new ChatError(409, "not_started", "This chat has no session to hand off yet");
    // Busy chats stop first (stop-here-continue-there); the source stays open
    // in aborted state so nothing is lost if seeding fails.
    if (chat.status === "running" || chat.status === "compacting" || chat.status === "stopping") await chat.abort();
    const snap = chat.snapshot();
    const seed = toSeed(snap.items, { title: snap.title, todos: snap.todos, throughTurns: through });
    const draft = prompt?.trim() ? prompt : null;
    if (isEmptySeed(seed) && !draft) throw new ChatError(400, "empty_handoff", "There is nothing to hand off yet");
    if (!target.capabilities.supportsHandoff) {
      // No store of past turns to write into: a fresh chat whose first prompt is the briefing.
      let moved: Chat;
      try {
        moved = await manager.create(target, chat.workspace);
      } catch (error) {
        throw new ChatError(502, "handoff_failed", `${target.displayName} could not take this session: ${errorMessage(error)}`);
      }
      const brief = briefPrompt(seed, { from: chat.adapter.displayName, project: chat.workspace.name, draft });
      await moved.send(brief, "normal").catch(() => undefined);
      // After the send: some harnesses only have a session to name once the first prompt is in.
      if (seed.title && target.capabilities.supportsRename) await moved.rename(seed.title).catch(() => undefined);
      res.status(201).json(moved.snapshot());
      return;
    }
    let live;
    try {
      live = await target.seedChat({ cwd: chat.workspace.path, seed });
    } catch (error) {
      throw new ChatError(502, "handoff_failed", `${target.displayName} could not take this session: ${errorMessage(error)}`);
    }
    const moved = await manager.seedOpen(target, chat.workspace, live);
    // The draft is the target's first real turn: sent, not just recorded.
    // A rejected send leaves its notice in the new chat, which still opens.
    if (draft) await moved.send(draft, "normal").catch(() => undefined);
    res.status(201).json(moved.snapshot());
  });

  app.post("/api/chats/:id/requests/:requestId", async (req, res) => {
    const chat = manager.get(req.params.id);
    const { answer } = body(answerSchema, req);
    const outcome = chat.answer(req.params.requestId, answer);
    res.json({ outcome });
  });

  app.post("/api/chats/:id/dispose", async (req, res) => {
    const chat = manager.get(req.params.id);
    await chat.dispose("Closed by user");
    res.json({ disposed: true });
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found", code: "not_found" });
  });

  if (deps.webDir && existsSync(path.join(deps.webDir, "index.html"))) {
    const webDir = deps.webDir;
    app.use(express.static(webDir, { index: "index.html", maxAge: "1h", setHeaders: noStoreHtml }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof ChatError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: error.issues[0]?.message ?? "Invalid request", code: "invalid_request" });
      return;
    }
    const status = (error as { status?: number; type?: string }).status;
    if (status === 413 || status === 400) {
      res.status(status).json({ error: status === 413 ? "Request too large" : "Malformed request", code: "bad_request" });
      return;
    }
    log(`internal error: ${errorMessage(error)}`);
    res.status(500).json({ error: "Internal error", code: "internal" });
  });

  return app;
}

function noStoreHtml(res: Response, filePath: string): void {
  if (filePath.endsWith(".html") || path.basename(filePath) === "sw.js") res.setHeader("Cache-Control", "no-store");
}
