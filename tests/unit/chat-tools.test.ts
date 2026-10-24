// A call the harness never answers: a cancelled question, or a lost result. The
// run says when it is over, and no row may still spin after that.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, ToolItem } from "../../src/shared/protocol.js";
import { NO_RESULT_TEXT } from "../../src/server/harness/agent-events.js";
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

const tools = (chat: ChatSnapshot): ToolItem[] => chat.items.filter((i): i is ToolItem => i.kind === "tool");

describe("a call left open when its run ends", () => {
  it("is closed, and says it got no result, instead of spinning on", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const live = () => (t as TestApp).manager.get(chat.chatId);

    expect(tools(live().snapshot())).toEqual([]);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "leave one unfinished" });
    await until(() => tools(live().snapshot()).length === 1);
    await until(() => live().status === "idle");

    const [tool] = tools(live().snapshot());
    expect(tool).toMatchObject({ name: "ask_user", status: "done", output: NO_RESULT_TEXT });
    expect(tool?.endedAt).toBeTypeOf("number");
  });
});
