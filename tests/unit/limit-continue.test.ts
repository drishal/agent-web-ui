// A continuation scheduled for a usage limit's reset: the timer is the server's,
// so it fires with no browser open, and a prompt of the user's own, a stop, or a
// cancel calls it off.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { CONTINUE_TEXT } from "../../src/shared/limit-stop.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

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
  const live = () => (t as TestApp).manager.get(chat.chatId);
  const prompts = () => live().snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
  return { agent, chat, live, prompts };
}

describe("a continuation after a usage limit", () => {
  it("fires on the server's clock with nobody watching", async () => {
    const { agent, chat, live, prompts } = await setUp();
    const at = Date.now() + 150;
    const res = await agent.post(`/api/chats/${chat.chatId}/continue-at`).send({ at });
    expect(res.status).toBe(200);
    expect(res.body.continueAt).toBe(at);
    // The appointment is part of the chat, so every device sees it.
    expect(live().snapshot().continueAt).toBe(at);
    await until(() => prompts().includes(CONTINUE_TEXT));
    expect(live().snapshot().continueAt).toBeNull();
    await until(() => live().status === "idle");
  });

  it("is called off by a prompt of the user's own, or by a cancel", async () => {
    const { agent, chat, live, prompts } = await setUp();
    const far = Date.now() + 60_000;
    await agent.post(`/api/chats/${chat.chatId}/continue-at`).send({ at: far });
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" });
    await until(() => live().status === "idle");
    expect(live().snapshot().continueAt).toBeNull();

    await agent.post(`/api/chats/${chat.chatId}/continue-at`).send({ at: far });
    const cancelled = await agent.post(`/api/chats/${chat.chatId}/continue-at`).send({ at: null });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.continueAt).toBeNull();
    await new Promise((r) => setTimeout(r, 150));
    expect(prompts()).toEqual(["hello"]);
  });

  it("refuses a time that has passed, one beyond a month, and a body that is not a time", async () => {
    const { agent, chat } = await setUp();
    const post = (at: unknown) => agent.post(`/api/chats/${chat.chatId}/continue-at`).send({ at });
    expect((await post(Date.now() - 1_000)).status).toBe(400);
    expect((await post(Date.now() + 40 * 86_400_000)).status).toBe(400);
    expect((await post("soon")).status).toBe(400);
    expect((await agent.post("/api/chats/no-such-chat/continue-at").send({ at: Date.now() + 60_000 })).status).toBe(404);
  });
});
