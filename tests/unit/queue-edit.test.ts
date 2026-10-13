// Editing a running chat's queue: the route replaces what the harness holds,
// bounded, and refuses once the run has ended.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent, ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("editing the queue", () => {
  it("replaces a running chat's queued messages, and refuses once the run has ended", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.capabilities.supportsQueueEdit).toBe(true);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow stream please" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "running"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "first follow-up", mode: "followUp" });
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "second follow-up", mode: "followUp" });
    const put = await agent.put(`/api/chats/${chat.chatId}/queue`).send({ steering: [], followUp: ["first, edited", "second follow-up"] });
    expect(put.status).toBe(200);
    const queues = () => sse.chatEvents().flatMap((e) => (e.type === "queue" ? [(e as unknown as Extract<ChatEvent, { type: "queue" }>).queue] : []));
    await sse.waitFor(() => queues().some((q) => q.followUp[0] === "first, edited"));
    expect((await agent.put(`/api/chats/${chat.chatId}/queue`).send({ steering: [], followUp: ["x".repeat(100_001)] })).status).toBe(400);
    await agent.post(`/api/chats/${chat.chatId}/abort`);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    sse.close();
    expect((await agent.put(`/api/chats/${chat.chatId}/queue`).send({ steering: [], followUp: [] })).status).toBe(409);
  });
});
