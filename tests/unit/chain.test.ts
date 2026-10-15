// The chain: steps a chat runs after its runs settle, kept by the server so
// they happen with no browser open; a stop or a failure pauses it.
import { afterEach, describe, expect, it } from "vitest";
import type { ChainStep, ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function setUp() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const sse = openSse(t, chat.chatId, agent.cookie);
  await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
  const live = () => (t as TestApp).manager.get(chat.chatId);
  const prompts = () => live().snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
  return { agent, chat, sse, live, prompts };
}

describe("the chain", () => {
  it("runs each step once the run before it settles, starting at once on an idle chat", async () => {
    const { agent, chat, sse, live, prompts } = await setUp();
    const res = await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: [{ kind: "send", text: "step one" }, { kind: "send", text: "step two" }] });
    expect(res.status).toBe(200);
    expect((res.body.chain as ChainStep[]).every((s) => typeof s.id === "string")).toBe(true);
    await until(() => prompts().length === 2 && live().status === "idle");
    expect(prompts()).toEqual(["step one", "step two"]);
    expect(live().snapshot().chain).toEqual([]);
    expect(sse.chatEvents().some((e) => e.type === "chain")).toBe(true);
    sse.close();
  });

  it("pauses when a run is stopped, keeping what was left, and goes on when resumed", async () => {
    const { agent, chat, sse, live, prompts } = await setUp();
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow first run" });
    await until(() => live().status === "running");
    await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: [{ kind: "send", text: "after it" }] });
    await agent.post(`/api/chats/${chat.chatId}/abort`).send({});
    await until(() => live().status === "idle");
    await new Promise((r) => setTimeout(r, 100));
    expect(live().snapshot()).toMatchObject({ chainPaused: "Stopped", chain: [{ kind: "send", text: "after it" }] });
    expect(prompts()).toEqual(["slow first run"]);
    await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: [{ kind: "send", text: "after it" }], resume: true });
    await until(() => prompts().length === 2 && live().status === "idle");
    expect(live().snapshot().chainPaused).toBeNull();
    sse.close();
  });

  it("hands the chat off to another harness, the rest of the chain going with it", async () => {
    const { agent, chat, sse, live } = await setUp();
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "the work so far" });
    await until(() => live().status === "idle" && live().snapshot().items.some((i) => i.kind === "assistant"));
    await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: [{ kind: "handoff", harness: "fake-b", prompt: "carry on" }, { kind: "send", text: "then this" }] });
    const other = () => (t as TestApp).manager.list().find((c) => c.adapter.id === "fake-b");
    await until(() => {
      const moved = other();
      return Boolean(moved && moved.status === "idle" && moved.snapshot().items.filter((i) => i.kind === "user").length >= 2);
    }, 15_000);
    const texts = (other() as NonNullable<ReturnType<typeof other>>).snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
    expect(texts.slice(-2)).toEqual(["carry on", "then this"]);
    expect(live().snapshot().items.some((i) => i.kind === "notice" && /handed this chat off/.test(i.text))).toBe(true);
    sse.close();
  });

  it("refuses a handoff to the same harness or one it does not know, and too many steps", async () => {
    const { agent, chat, sse } = await setUp();
    expect((await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: [{ kind: "handoff", harness: "fake" }] })).status).toBe(400);
    expect((await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: [{ kind: "handoff", harness: "nope" }] })).status).toBe(404);
    const many = Array.from({ length: 11 }, (_, i) => ({ kind: "send", text: `s${i}` }));
    expect((await agent.put(`/api/chats/${chat.chatId}/chain`).send({ steps: many })).status).toBe(400);
    sse.close();
  });
});
