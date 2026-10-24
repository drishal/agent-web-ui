// Git from the panel: stage, unstage, and commit, with every path confined to a
// file the project's own status lists.
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, GitStatus } from "../../src/shared/protocol.js";
import { git } from "../../src/server/git.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/** A workspace at `dir`, a chat in it, and the three git routes bound to that chat. */
async function chatIn(agent: Awaited<ReturnType<typeof signedIn>>, dir: string) {
  const ws = (await agent.post("/api/workspaces/open").send({ path: dir })).body as { id: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const post = (action: string, body: object) => agent.post(`/api/chats/${chat.chatId}/git/${action}`).send(body);
  return { chat, post };
}

async function setUp() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const cwd = t.project;
  await git(["init", "-q", "-b", "main"], { cwd });
  await git(["config", "user.name", "Test"], { cwd });
  await git(["config", "user.email", "test@example.com"], { cwd });
  await fs.writeFile(path.join(cwd, "a.txt"), "one\n");
  await git(["add", "-A"], { cwd });
  await git(["commit", "-qm", "first"], { cwd });
  const { chat, post } = await chatIn(agent, cwd);
  return { agent, cwd, chat, post };
}

describe("git from the panel", () => {
  it("stages, unstages, and commits a changed file", async () => {
    const { cwd, post } = await setUp();
    await fs.writeFile(path.join(cwd, "a.txt"), "two\n");

    const staged = await post("stage", { paths: ["a.txt"] });
    expect(staged.status).toBe(200);
    expect((staged.body.status as GitStatus).counts.staged).toBe(1);

    const unstage = await post("unstage", { paths: ["a.txt"] });
    expect(unstage.status).toBe(200);
    expect((unstage.body.status as GitStatus).counts.staged).toBe(0);
    expect((unstage.body.status as GitStatus).counts.changed).toBe(1);

    await post("stage", { paths: ["a.txt"] });
    const committed = await post("commit", { message: "Change a" });
    expect(committed.status).toBe(200);
    const after = committed.body.status as GitStatus;
    expect(after.lastCommit?.subject).toBe("Change a");
    expect(after.counts).toMatchObject({ staged: 0, changed: 0, untracked: 0 });
    expect(await git(["log", "-1", "--format=%s"], { cwd })).toBe("Change a\n");
  });

  it("stages a new file, refuses an empty commit, and refuses a path it does not list", async () => {
    const { cwd, post } = await setUp();
    await fs.writeFile(path.join(cwd, "b.txt"), "new\n");
    expect((await post("commit", { message: "nothing yet" })).status).toBe(409);
    expect(((await post("stage", { paths: ["b.txt"] })).body.status as GitStatus).counts.staged).toBe(1);
    expect((await post("commit", { message: "Add b" })).status).toBe(200);

    for (const bad of ["../a.txt", "/etc/passwd", "a.txt/../../b", "missing.txt", ".git/config"]) {
      const res = await post("stage", { paths: [bad] });
      expect(res.status, bad).toBe(400);
    }
    expect((await post("stage", { paths: [] })).status).toBe(400);
    expect((await post("commit", { message: "   " })).status).toBe(400);
  });

  it("unstages before the first commit, where there is no HEAD to restore from", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const dir = path.join((t as TestApp).root, "fresh");
    await fs.mkdir(dir, { recursive: true });
    await git(["init", "-q", "-b", "main"], { cwd: dir });
    const { post } = await chatIn(agent, dir);
    await fs.writeFile(path.join(dir, "first.txt"), "hello\n");
    expect(((await post("stage", { paths: ["first.txt"] })).body.status as GitStatus).counts.staged).toBe(1);
    const unstaged = await post("unstage", { paths: ["first.txt"] });
    expect(unstaged.status).toBe(200);
    expect((unstaged.body.status as GitStatus).counts).toMatchObject({ staged: 0, untracked: 1 });
  });
});
