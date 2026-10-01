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
  MAX_MESSAGE_CHARS,
  openWorkspaceSchema,
  patchConfigSchema,
  renameSchema,
  resumeChatSchema,
  sendMessageSchema,
  type SessionSummary,
} from "../shared/protocol.js";
import { ChatError, errorMessage } from "./chats/chat.js";
import type { ChatManager } from "./chats/manager.js";
import type { HarnessRegistry } from "./harness/registry.js";
import type { Security } from "./security.js";
import type { ThemeStore } from "./theme.js";
import type { Workspaces } from "./workspaces.js";

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
  heartbeatMs?: number;
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

export function createApp(deps: AppDeps) {
  const { registry, manager, workspaces, security, theme } = deps;
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

  app.use("/api", security.requireAuth);
  app.use("/api", express.json({ limit: `${Math.ceil((MAX_MESSAGE_CHARS * 4) / 1024) + 64}kb` }));

  let statusAt = 0;
  app.get("/api/bootstrap", async (req, res) => {
    if (Date.now() - statusAt > 60_000 || req.query.refresh === "1") {
      await registry.refreshStatus();
      statusAt = Date.now();
    }
    const t = await theme.get();
    const payload: Bootstrap = {
      version: deps.version,
      harnesses: registry.status(),
      roots: workspaces.rootList,
      home: deps.home,
      theme: { active: t.name ?? "built-in", ...(t.problem ? { problem: t.problem } : {}) },
      pairing: { urls: deps.pairingUrls },
      limits: { maxMessageChars: MAX_MESSAGE_CHARS },
    };
    res.setHeader("Cache-Control", "no-store");
    res.json(payload);
  });

  app.get("/api/theme", async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
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
      const live = manager.liveChatFor(adapter.id, s.nativeId);
      return {
        id: `${adapter.id}:${s.nativeId}`,
        harnessId: adapter.id,
        title: s.title,
        updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
        ...(s.messageCount !== undefined ? { messageCount: s.messageCount } : {}),
        ...(live ? { liveChatId: live.chatId } : {}),
      };
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
      });
    }
    res.json({ sessions });
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
    const { text, mode } = body(sendMessageSchema, req);
    await chat.send(text, mode);
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

  app.post("/api/chats/:id/requests/:requestId", (req, res) => {
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

  app.get("/", security.exchange);
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
  if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
}
