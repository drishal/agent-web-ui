// How many streams watch a chat (a count, announced a second after it changes) and the bounded
// history of context readings the panel's sparkline draws.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CONTEXT_HISTORY, type ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  return { t, agent, chat };
}

describe("viewers", () => {
  it("counts the attached streams, announced after a pause, and only a count", async () => {
    const { t, agent, chat } = await setup();
    const a = openSse(t, chat.chatId, agent.cookie);
    await a.waitFor(() => a.chatEvents().some((e) => e.type === "snapshot"));
    const b = openSse(t, chat.chatId, agent.cookie);
    await b.waitFor(() => b.chatEvents().some((e) => e.type === "snapshot"));
    await a.waitFor(() => a.chatEvents().some((e) => e.type === "viewers" && e.viewers === 2));
    expect(a.chatEvents().filter((e) => e.type === "viewers").every((e) => Object.keys(e).sort().join() === "type,viewers")).toBe(true);
    expect(((await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot).viewers).toBe(2);
    b.close();
    await a.waitFor(() => a.chatEvents().some((e) => e.type === "viewers" && e.viewers === 1));
    a.close();
  });

  it("says nothing when a reconnect leaves the count where it was", async () => {
    const { t, agent, chat } = await setup();
    const a = openSse(t, chat.chatId, agent.cookie);
    await a.waitFor(() => a.chatEvents().some((e) => e.type === "snapshot"));
    await a.waitFor(() => a.chatEvents().some((e) => e.type === "viewers" && e.viewers === 1));
    const b = openSse(t, chat.chatId, agent.cookie);
    await b.waitFor(() => b.chatEvents().some((e) => e.type === "snapshot"));
    b.close();
    await new Promise((r) => setTimeout(r, 1300));
    expect(a.chatEvents().filter((e) => e.type === "viewers").map((e) => e.viewers)).toEqual([1]);
    a.close();
  });
});

describe("context history", () => {
  it("records a reading per change and stays bounded", async () => {
    const { t, agent, chat } = await setup();
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" });
    const live = t.manager.get(chat.chatId);
    await new Promise<void>((resolve) => {
      const tick = () => (live.contextReadings.length > 0 ? resolve() : setTimeout(tick, 20));
      tick();
    });
    for (let i = 0; i < MAX_CONTEXT_HISTORY + 50; i++) (live as unknown as { noteContext(c: unknown): void }).noteContext({ tokens: i, window: 1000, percent: i / 10 });
    const readings = ((await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot).contextHistory;
    expect(readings).toHaveLength(MAX_CONTEXT_HISTORY);
    expect(readings.at(-1)).toEqual({ tokens: MAX_CONTEXT_HISTORY + 49, percent: (MAX_CONTEXT_HISTORY + 49) / 10 });
  });
});
