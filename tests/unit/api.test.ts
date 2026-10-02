import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, SessionsOverview } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, tempDir, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(options: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp(options);
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
  return { t, agent, ws };
}

describe("bootstrap and workspaces", () => {
  it("reports the harness registry without paths or secrets", async () => {
    const { agent } = await setup();
    const res = await agent.get("/api/bootstrap");
    expect(res.status).toBe(200);
    expect(res.body.harnesses.map((h: { id: string }) => h.id)).toEqual(["fake", "fake-b"]);
    expect(JSON.stringify(res.body.harnesses)).not.toMatch(/nonexistent/);
  });

  it("opens workspaces only inside the roots, by realpath", async () => {
    const { agent, t } = await setup();
    const outside = tempDir("awui-outside-");
    expect((await agent.post("/api/workspaces/open").send({ path: outside })).status).toBe(403);
    expect((await agent.post("/api/workspaces/open").send({ path: `${t.project}/../../` })).status).toBe(403);
    symlinkSync(outside, path.join(t.root, "escape"));
    expect((await agent.post("/api/workspaces/open").send({ path: path.join(t.root, "escape") })).status).toBe(403);
    expect((await agent.post("/api/workspaces/open").send({ path: path.join(t.root, "missing") })).status).toBe(404);
  });

  it("browses one level of directories and hides symlink escapes", async () => {
    const { agent, t } = await setup();
    mkdirSync(path.join(t.root, ".hidden"));
    symlinkSync(tempDir("awui-out-"), path.join(t.root, "escape"));
    symlinkSync(t.project, path.join(t.root, "inside-link"));
    const roots = await agent.get("/api/workspaces/browse");
    expect(roots.body.path).toBeNull();
    const res = await agent.get(`/api/workspaces/browse?path=${encodeURIComponent(t.root)}`);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual([".hidden", "inside-link", "proj"]);
    expect(res.body.entries[0].hidden).toBe(true);
  });
});

describe("chat lifecycle over HTTP + SSE", () => {
  it("creates a chat, streams a reply, and settles", async () => {
    const { agent, ws, t } = await setup();
    const created = await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id });
    expect(created.status).toBe(201);
    const chat = created.body as ChatSnapshot;
    expect(chat.config).not.toHaveProperty("toolsMode");
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    const sent = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello tool" });
    expect(sent.status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const snap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const kinds = snap.items.map((i) => i.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("tool");
    const reply = snap.items.find((i) => i.kind === "assistant" && i.text.startsWith("Echo"));
    expect(reply && reply.kind === "assistant" && reply.thinking).toBeTruthy();
    expect(snap.items.find((i) => i.kind === "tool")).toMatchObject({
      status: "done",
      name: "read",
      category: "read",
      summary: "README.md",
      paths: ["README.md"],
    });
    const user = snap.items.find((i) => i.kind === "user");
    expect(user?.at).toBeGreaterThan(0);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "context"));
    expect(t.manager.get(chat.chatId).snapshot().context?.tokens).toBeGreaterThan(0);
    // Monotonic event ids.
    const ids = sse.messages.filter((m) => m.id !== undefined).map((m) => m.id as number);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    sse.close();
  });

  it("returns 409 for a normal send while busy, and steers / queues follow-ups", async () => {
    const { agent, ws, t } = await setup({ chunkDelayMs: 15 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow one" });
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "again" })).status).toBe(409);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "go left", mode: "steer" })).status).toBe(202);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "then this", mode: "followUp" })).status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "queue"));
    await sse.waitFor(() => {
      const items = t.manager.get(chat.chatId).snapshot().items;
      return t.manager.get(chat.chatId).status === "idle" && items.some((i) => i.kind === "assistant" && i.text.startsWith("Echo: then this"));
    }, 15_000);
    const texts = t.manager.get(chat.chatId).snapshot().items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
    expect(texts).toEqual(["slow one", "go left", "then this"]);
    sse.close();
  });

  it("stop goes through Stopping and settles; queue is cleared", async () => {
    const { agent, ws, t } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "later", mode: "followUp" });
    expect((await agent.post(`/api/chats/${chat.chatId}/abort`)).status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "stopping"));
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const snap = t.manager.get(chat.chatId).snapshot();
    expect(snap.queue.followUp).toEqual([]);
    expect(snap.items.some((i) => i.kind === "assistant" && i.error === "Stopped")).toBe(true);
    expect(snap.items.filter((i) => i.kind === "user").length).toBe(1);
    sse.close();
  });

  it("stop-and-send aborts then sends", async () => {
    const { agent, ws, t } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake-b", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.capabilities.supportsSteer).toBe(false);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "x", mode: "steer" })).status).toBe(400);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "instead", mode: "stopAndSend" })).status).toBe(202);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => {
      const c = t.manager.get(chat.chatId);
      return c.status === "idle" && c.snapshot().items.some((i) => i.kind === "assistant" && i.text.startsWith("Echo: instead"));
    });
    sse.close();
  });

  it("replays from lastEventId without duplicates, and resnapshots when too old", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const first = openSse(t, chat.chatId, agent.cookie);
    await first.waitFor(() => first.chatEvents().length > 0);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "one" });
    await first.waitFor(() => first.chatEvents().filter((e) => e.type === "item").length >= 2);
    const cut = first.lastId() as number;
    first.close();
    await new Promise<void>((resolve) => {
      const check = () => (t?.manager.get(chat.chatId).status === "idle" ? resolve() : setTimeout(check, 10));
      check();
    });
    const second = openSse(t, chat.chatId, agent.cookie, cut);
    await second.waitFor(() => second.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    expect(second.chatEvents().some((e) => e.type === "snapshot")).toBe(false);
    const replayedIds = second.messages.filter((m) => m.id !== undefined).map((m) => m.id as number);
    expect(Math.min(...replayedIds)).toBe(cut + 1);
    second.close();
    const stale = openSse(t, chat.chatId, agent.cookie, 999_999);
    await stale.waitFor(() => stale.chatEvents().some((e) => e.type === "snapshot"));
    stale.close();
  });

  it("resumes an existing live session instead of opening a second writer", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "persist me" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    sse.close();
    const list = await agent.get(`/api/harnesses/fake/sessions?workspaceId=${ws.id}`);
    expect(list.body.sessions).toHaveLength(1);
    const session = list.body.sessions[0];
    expect(session.id).toBe(`fake:${t.fake.sessions.keys().next().value}`);
    expect(session.liveChatId).toBe(chat.chatId);
    const resumed = await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: session.id });
    expect(resumed.body.chatId).toBe(chat.chatId);
    // After closing the live chat, resume opens a fresh instance rebuilt from history.
    await agent.post(`/api/chats/${chat.chatId}/dispose`);
    const reopened = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: session.id }))
      .body as ChatSnapshot;
    expect(reopened.chatId).not.toBe(chat.chatId);
    expect(reopened.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["persist me"]);
    expect(reopened.items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string; error?: string }).error ?? "ok")).toEqual(["ok"]);
    expect((await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: "fake-b:x" })).status).toBe(400);
    expect((await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: "fake:unknown" })).status).toBe(404);
  });

  it("round-trips an approval request; first answer wins, late answers get 409", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "please ask first" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "request"));
    const request = (sse.chatEvents().find((e) => e.type === "request") as unknown as { request: { id: string } }).request;
    // A reconnecting device sees the pending request in its snapshot.
    const other = openSse(t, chat.chatId, agent.cookie);
    await other.waitFor(() => other.chatEvents().some((e) => e.type === "snapshot"));
    const snap = (other.chatEvents()[0] as unknown as { snapshot: ChatSnapshot }).snapshot;
    expect(snap.pending.map((p) => p.id)).toEqual([request.id]);
    const ok = await agent.post(`/api/chats/${chat.chatId}/requests/${request.id}`).send({ answer: { kind: "confirm", confirmed: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe("Approved");
    const late = await agent.post(`/api/chats/${chat.chatId}/requests/${request.id}`).send({ answer: { kind: "confirm", confirmed: false } });
    expect(late.status).toBe(409);
    await other.waitFor(() => other.chatEvents().some((e) => e.type === "request_resolved"));
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect(t.manager.get(chat.chatId).snapshot().items.some((i) => i.kind === "tool")).toBe(true);
    sse.close();
    other.close();
  });

  it("abort cancels a pending request", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "ask now" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "request"));
    await agent.post(`/api/chats/${chat.chatId}/abort`);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "request_resolved"));
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect(t.manager.get(chat.chatId).snapshot().pending).toEqual([]);
    sse.close();
  });

  it("changes config only while idle and validates values", async () => {
    const { agent, ws } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const ok = await agent.patch(`/api/chats/${chat.chatId}/config`).send({ model: "fake/slow", thinkingLevel: "high" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ model: "fake/slow", thinkingLevel: "high" });
    // There is no tool-narrowing mode to switch to.
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ toolsMode: "readOnly" })).status).toBe(400);
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ model: "nope/x" })).status).toBe(422);
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({})).status).toBe(400);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ thinkingLevel: "off" })).status).toBe(409);
  });

  it("bounds oversized tool output", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "big output" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const tool = t.manager.get(chat.chatId).snapshot().items.find((i) => i.kind === "tool");
    expect(tool && tool.kind === "tool" && tool.truncated).toBe(true);
    expect(tool && tool.kind === "tool" && tool.output.length).toBeLessThan(17_000);
    const largest = Math.max(...sse.messages.map((m) => JSON.stringify(m.data).length));
    expect(largest).toBeLessThan(64_000);
    sse.close();
  });

  it("rejects oversized and malformed bodies", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "" })).status).toBe(400);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "x".repeat(100_001) })).status).toBe(400);
    expect((await agent.post("/api/chats").send({ harnessId: "nope", workspaceId: ws.id })).status).toBe(404);
    expect((await agent.get("/api/chats/does-not-exist")).status).toBe(404);
  });

  it("sends pasted images with the prompt, and refuses fakes, extras, and image-only messages", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const url = `/api/chats/${chat.chatId}/messages`;
    // A ~1 MB PNG: well past the 455 kB limit every other body keeps.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024)]).toString("base64");
    const image = { mimeType: "image/png", data: png };

    expect((await agent.post(url).send({ text: "what is this?", images: [{ ...image, mimeType: "image/jpeg" }] })).body.code).toBe("bad_image");
    expect((await agent.post(url).send({ text: "", images: [image] })).status).toBe(400);
    expect((await agent.post(url).send({ text: "too many", images: Array(9).fill(image) })).status).toBe(400);
    expect((await agent.post(url).send({ text: "svg", images: [{ mimeType: "image/svg+xml", data: png }] })).status).toBe(400);

    const sse = openSse(t, chat.chatId, agent.cookie);
    expect((await agent.post(url).send({ text: "what is this?", images: [image, image] })).status).toBe(202);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const user = (await agent.get(`/api/chats/${chat.chatId}`)).body.items.find((i: { kind: string }) => i.kind === "user");
    expect(user).toMatchObject({ text: "what is this?", imageCount: 2 });
    sse.close();
  });

  it("never returns filesystem paths for sessions", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hi" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const list = await agent.get(`/api/harnesses/fake/sessions?workspaceId=${ws.id}`);
    expect(JSON.stringify(list.body)).not.toMatch(/nonexistent|\.jsonl/);
    sse.close();
  });
});

describe("sessions across projects", () => {
  it("lists every project's recent sessions, newest first, and leaves out folders outside the roots", async () => {
    const { agent, t } = await setup();
    const other = path.join(t.root, "other");
    mkdirSync(other);
    const outside = tempDir("awui-outside-");
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    for (const [nativeId, cwd, title, age] of [
      ["a1", t.project, "Fix the build", 5],
      ["b1", other, "Write docs", 1],
      ["x1", outside, "Somewhere else", 0],
      ["gone", path.join(t.root, "deleted"), "Removed project", 2],
    ] as const) {
      t.fake.sessions.set(nativeId, { nativeId, cwd, title, messages: [{}], updatedAt: minutesAgo(age) });
    }

    const body = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    expect(body.errors).toEqual([]);
    const project = (id: string) => body.workspaces.find((w) => w.id === id)?.name;
    expect(body.sessions.map((s) => [s.title, project(s.workspaceId)])).toEqual([
      ["Write docs", "other"],
      ["Fix the build", "proj"],
    ]);
    expect(JSON.stringify(body)).not.toContain(outside);

    // The current project is listed even before it has sessions.
    const empty = path.join(t.root, "empty");
    mkdirSync(empty);
    const current = (await agent.get(`/api/sessions?path=${encodeURIComponent(empty)}`).expect(200)).body as SessionsOverview;
    expect(current.workspaces.map((w) => w.name)).toContain("empty");
  });
});

describe("todos", () => {
  it("publishes the harness todo list after a run", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.todos).toEqual([]);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "make a todo list" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "todos"));
    expect(t.manager.get(chat.chatId).snapshot().todos.map((x) => x.status)).toEqual(["completed", "in_progress", "pending"]);
    sse.close();
  });
});

describe("ambient notices", () => {
  it("marks notices raised while idle so they stay out of turns", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const created = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const chat = t.manager.get(created.chatId);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "ask please" });
    await sse.waitFor(() => chat.snapshot().pending.length === 1);
    await agent.post(`/api/chats/${chat.chatId}/requests/${chat.snapshot().pending[0]?.id}`).send({ answer: { kind: "confirm", confirmed: false } });
    await sse.waitFor(() => chat.status === "idle");
    // "Fake tool denied" came mid-run: part of the turn.
    const denied = chat.snapshot().items.find((i) => i.kind === "notice" && i.text === "Fake tool denied");
    expect(denied && denied.kind === "notice" && denied.ambient).toBeFalsy();
    // A notice while idle (as extensions post on open) is ambient.
    chat.apply({ type: "notice", level: "info", text: "extension says hi" });
    const hi = chat.snapshot().items.find((i) => i.kind === "notice" && i.text === "extension says hi");
    expect(hi && hi.kind === "notice" && hi.ambient).toBe(true);
    sse.close();
  });
});
