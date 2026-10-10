// An agent's render_html call publishes a page: the fake harness POSTs it to
// the chat's render endpoint, the reference rides the tool card's details into
// the transcript, and the framed page is served back under the chat that owns
// it. Reloading the chat re-reads the stored reference and re-arms the frame.
import { describe, expect, it, afterEach } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
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
  return { t, agent, ws };
}

describe("agent HTML renders", () => {
  it("stores a render_html page and serves it back to its chat", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    // The fake answers "render" with a real render_html call through the endpoint.
    const sent = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "render a report" });
    expect(sent.status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));

    const snap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const tool = snap.items.find((i) => i.kind === "tool" && i.name === "render_html");
    expect(tool && tool.kind === "tool" ? tool.status : null).toBe("done");
    const page = tool && tool.kind === "tool" ? tool.htmlRender : undefined;
    expect(page).toMatchObject({ title: "Fake report", height: 160 });
    expect(page?.id).toMatch(/^[0-9a-f]{32}$/);

    // The owning chat gets the page; the frame's bootstrap was injected.
    const served = await agent.get(`/api/chats/${chat.chatId}/html-render/${page!.id}`);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toMatch(/^text\/html/);
    expect(served.text).toContain("<h1>Fake report</h1>");
    expect(served.text).toContain("awui-html-render-theme");
    sse.close();
  });

  it("rejects a page posted with a token no live chat holds", async () => {
    const { agent } = await setup();
    const res = await agent.post("/api/render").set("x-awui-render-token", "0".repeat(32)).send({ html: "<p>x</p>", title: "x", height: 120 });
    expect(res.status).toBe(403);
  });

  it("does not serve one chat's page to another", async () => {
    const { agent, ws } = await setup();
    const first = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, first.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${first.chatId}/messages`).send({ text: "render" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const snap = (await agent.get(`/api/chats/${first.chatId}`)).body as ChatSnapshot;
    const page = snap.items.find((i) => i.kind === "tool" && i.htmlRender);
    const id = page && page.kind === "tool" ? page.htmlRender?.id : undefined;
    expect(id).toBeDefined();

    const other = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.get(`/api/chats/${other.chatId}/html-render/${id}`)).status).toBe(404);
    expect((await agent.get(`/api/chats/${first.chatId}/html-render/${id}`)).status).toBe(200);
    sse.close();
  });

  it("re-arms the frame's reference when the chat's transcript is re-read", async () => {
    const { agent, ws, t } = await setup();
    const first = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, first.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${first.chatId}/messages`).send({ text: "render" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const found = t.manager
      .get(first.chatId)
      .snapshot()
      .items.find((i) => i.kind === "tool" && i.htmlRender !== undefined);
    const pageId = found && found.kind === "tool" ? found.htmlRender?.id : undefined;
    expect(pageId).toBeDefined();
    sse.close();

    // Re-reading the native session's transcript (what a fresh open does) must
    // carry the same reference, so the frame re-arms from history.
    const nativeId = first.sessionId!.split(":")[1] ?? "";
    const history = await t.fake.readTranscript({ cwd: t.project, nativeId });
    const tool = history?.items.find((i) => i.kind === "tool" && i.name === "render_html");
    expect(tool && tool.kind === "tool" ? tool.htmlRender?.id : undefined).toBe(pageId);
  });
});
