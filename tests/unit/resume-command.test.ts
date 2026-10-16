import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { shellLine, shellWord } from "../../src/server/shell-line.js";
import type { ChatSnapshot, ResumeCommand } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, tempDir, type TestApp } from "../helpers/app.js";

const has = (shell: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${shell}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

describe("a resume command's shell line", () => {
  it("leaves plain words bare and quotes the rest", () => {
    expect(shellWord("/home/me/proj-1")).toBe("/home/me/proj-1");
    expect(shellWord("my project")).toBe("'my project'");
    expect(shellWord("it's $HOME *")).toBe(`'it'\\''s $HOME *'`);
    expect(shellWord("~/x")).toBe("'~/x'");
    expect(shellLine("/srv/a b", ["claude", "--resume", "1234"])).toBe("cd '/srv/a b' && claude --resume 1234");
  });

  // The line goes into the user's own terminal, whatever its shell: run it in each.
  for (const shell of ["bash", "fish"]) {
    it.skipIf(!has(shell))(`lands in the folder in ${shell}, spaces, quotes, and $ included`, () => {
      const dir = path.join(tempDir(), "it's a $HOME (test)");
      mkdirSync(dir);
      const out = execFileSync(shell, ["-c", shellLine(dir, ["pwd"])], { encoding: "utf8", env: { ...process.env, HOME: "/nowhere" } });
      expect(out.trim()).toBe(realpathSync(dir));
    });
  }
});

describe("GET /api/sessions/resume-command", () => {
  let t: TestApp | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  it("gives the harness's own command for a saved session, and says when awui has it open", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const ask = (sessionId: string, harnessId = "fake") => agent.get("/api/sessions/resume-command").query({ harnessId, workspaceId: ws.id, sessionId });
    const sessionId = chat.sessionId as string;
    // Nothing is saved before the first message.
    expect((await ask(sessionId)).status).toBe(404);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "keep me" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    sse.close();
    const nativeId = sessionId.slice("fake:".length);
    const open = await ask(sessionId);
    expect(open.status).toBe(200);
    expect(open.body as ResumeCommand).toEqual({ command: `cd ${shellWord(ws.path)} && fake --resume ${nativeId}`, live: true });
    await agent.post(`/api/chats/${chat.chatId}/dispose`);
    expect(((await ask(sessionId)).body as ResumeCommand).live).toBe(false);
    // Fake B declares no resume command; an id must belong to the harness asked.
    expect((await ask(`fake-b:${nativeId}`, "fake-b")).status).toBe(400);
    expect((await ask(`other:${nativeId}`)).status).toBe(400);
  });

  it("needs a signed-in device", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: ["192.168.1.50"] });
    const res = await request(t.server).get("/api/sessions/resume-command").set("Host", `192.168.1.50:${t.port}`).query({ harnessId: "fake", workspaceId: "w", sessionId: "fake:x" });
    expect(res.status).toBe(401);
  });
});
