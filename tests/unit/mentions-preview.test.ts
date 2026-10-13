// The two read-only routes atui's composer and history picker use: a
// project's files for @mentions, and a session's last exchange as a preview
// (which the web sidebar's hover card shows too, with its model and files).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, SessionPreview } from "../../src/shared/protocol.js";
import { searchFiles } from "../../src/server/project-files.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("project files for @mentions", () => {
  it("lists a project's files relative to it, skipping dependency folders, and ranks by name", async () => {
    t = await makeTestApp();
    mkdirSync(path.join(t.project, "src"), { recursive: true });
    mkdirSync(path.join(t.project, "node_modules", "dep"), { recursive: true });
    writeFileSync(path.join(t.project, "src", "app.ts"), "x");
    writeFileSync(path.join(t.project, "src", "mapping.ts"), "x");
    writeFileSync(path.join(t.project, "node_modules", "dep", "app.js"), "x");
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const found = (await agent.get(`/api/workspaces/${ws.id}/files?q=app`)).body as { files: string[] };
    expect(found.files[0]).toBe(path.join("src", "app.ts"));
    expect(found.files).not.toContain(path.join("node_modules", "dep", "app.js"));
    expect(found.files.every((f) => !path.isAbsolute(f))).toBe(true);
    expect((await agent.get("/api/workspaces/nope/files")).status).toBe(404);
  });

  it("ranks a name match over a path match over letters in order", () => {
    const files = ["docs/app-notes.md", "src/app.ts", "lib/a/p/p.ts", "apps/x.ts"];
    expect(searchFiles(files, "app")).toEqual(["src/app.ts", "docs/app-notes.md", "apps/x.ts", "lib/a/p/p.ts"]);
    expect(searchFiles(files, "zzz")).toEqual([]);
  });
});

describe("session preview", () => {
  it("shows a session's last prompt and answer, and refuses another harness's id", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "preview me" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    sse.close();
    const sessionId = (await agent.get(`/api/chats/${chat.chatId}`)).body.sessionId as string;
    const query = (id: string) => `/api/sessions/preview?harnessId=fake&workspaceId=${ws.id}&sessionId=${encodeURIComponent(id)}`;
    const live = (await agent.get(query(sessionId))).body as SessionPreview;
    expect(live).toMatchObject({ prompt: "preview me", turns: 1 });
    expect(live.answer).toContain("preview me");
    // Closed, it is read from the harness's own record without starting it.
    await agent.post(`/api/chats/${chat.chatId}/dispose`);
    expect(((await agent.get(query(sessionId))).body as SessionPreview).prompt).toBe("preview me");
    expect((await agent.get(query("fake-b:x"))).status).toBe(400);
    expect((await agent.get(`/api/sessions/preview?harnessId=fake`)).status).toBe(400);
  });
});

describe("the hover card's preview", () => {
  it("names the model and the files the session changed", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "edit the file" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    sse.close();
    const sessionId = (await agent.get(`/api/chats/${chat.chatId}`)).body.sessionId as string;
    const preview = (await agent.get(`/api/sessions/preview?harnessId=fake&workspaceId=${ws.id}&sessionId=${encodeURIComponent(sessionId)}`)).body as SessionPreview;
    expect(preview.files).toEqual([path.join("src", "app.ts")]);
    expect(preview.model).toBe("fake/echo");
  });
});
