import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, CheckpointPreview, CheckpointRestored } from "../../src/shared/protocol.js";
import { Checkpoints } from "../../src/server/checkpoints.js";
import { makeTestApp, openSse, signedIn, tempDir, type TestApp } from "../helpers/app.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function repo(dir: string): void {
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n");
  writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
}

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("file checkpoints", () => {
  it("snapshots the work tree without touching the project's own git, and restores chosen files", async () => {
    const dir = tempDir("awui-cp-");
    repo(dir);
    const before = git(dir, "status", "--porcelain=v1", "--untracked-files=all");
    const objects = git(dir, "count-objects", "-v");
    const cp = new Checkpoints(path.join(tempDir("awui-cp-state-"), "checkpoints"));
    const top = (await cp.repoOf(dir)) as string;
    writeFileSync(path.join(dir, "notes.md"), "draft\n");
    const then = await cp.snapshot(top);

    writeFileSync(path.join(dir, "app.ts"), "const a = 2;\n");
    writeFileSync(path.join(dir, "new.ts"), "export {};\n");
    rmSync(path.join(dir, "notes.md"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "out.js"), "ignored\n");

    const preview = await cp.preview(top, then.tree);
    expect(preview.files).toEqual([
      { path: "app.ts", change: "restore" },
      { path: "new.ts", change: "delete" },
      { path: "notes.md", change: "recreate" },
    ]);
    // The project's own repository is untouched: no index change, no new objects, no refs.
    expect(git(dir, "count-objects", "-v")).toBe(objects);
    expect(git(dir, "status", "--porcelain=v1", "--untracked-files=all")).not.toBe(before);
    expect(git(dir, "for-each-ref")).not.toMatch(/awui|checkpoint/);

    const done = await cp.restore(top, then.tree, ["app.ts", "new.ts", "notes.md"]);
    expect(done.files.map((f) => f.path)).toEqual(["app.ts", "new.ts", "notes.md"]);
    expect(readFileSync(path.join(dir, "app.ts"), "utf8")).toBe("const a = 1;\n");
    expect(existsSync(path.join(dir, "new.ts"))).toBe(false);
    expect(readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("draft\n");
    expect(existsSync(path.join(dir, "dist", "out.js"))).toBe(true);

    // Putting back: the tree from just before the restore.
    await cp.restore(top, done.undo, ["app.ts", "new.ts", "notes.md"]);
    expect(readFileSync(path.join(dir, "app.ts"), "utf8")).toBe("const a = 2;\n");
    expect(existsSync(path.join(dir, "new.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "notes.md"))).toBe(false);
  });

  it("checkpoints each prompt of a chat and restores a turn over HTTP", async () => {
    t = await makeTestApp({ withCheckpoints: true });
    repo(t.project);
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.checkpoints).toEqual([]);
    const sse = openSse(t, chat.chatId, agent.cookie);
    const run = async (text: string) => {
      await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text }).expect(202);
      await sse.waitFor(() => t?.manager.get(chat.chatId).status === "idle" && sse.chatEvents().filter((e) => e.type === "status" && e.status === "idle").length >= run.count + 1);
      run.count += 1;
    };
    run.count = 0;
    await run("first");
    writeFileSync(path.join(t.project, "app.ts"), "const a = 2;\n");
    await run("second");
    writeFileSync(path.join(t.project, "app.ts"), "const a = 3;\n");
    writeFileSync(path.join(t.project, "extra.ts"), "x\n");
    await run("/fake-status");
    expect(t.manager.get(chat.chatId).snapshot().checkpoints).toEqual([1, 2]);
    expect(sse.chatEvents().some((e) => e.type === "checkpoints")).toBe(true);

    const preview = (await agent.get(`/api/chats/${chat.chatId}/checkpoints/2`).expect(200)).body as CheckpointPreview;
    expect(preview.files).toEqual([
      { path: "app.ts", change: "restore" },
      { path: "extra.ts", change: "delete" },
    ]);
    const restored = (await agent.post(`/api/chats/${chat.chatId}/checkpoints/2/restore`).send({ paths: ["app.ts"] }).expect(200)).body as CheckpointRestored;
    expect(restored.files).toEqual([{ path: "app.ts", change: "restore" }]);
    expect(readFileSync(path.join(t.project, "app.ts"), "utf8")).toBe("const a = 2;\n");
    expect(existsSync(path.join(t.project, "extra.ts"))).toBe(true);

    await agent.post(`/api/chats/${chat.chatId}/checkpoints/put-back`).send({ tree: restored.undo, paths: ["app.ts"] }).expect(200);
    expect(readFileSync(path.join(t.project, "app.ts"), "utf8")).toBe("const a = 3;\n");
    // Only this chat's own trees, and only real turns.
    await agent.post(`/api/chats/${chat.chatId}/checkpoints/put-back`).send({ tree: "0".repeat(40), paths: ["app.ts"] }).expect(422);
    await agent.get(`/api/chats/${chat.chatId}/checkpoints/7`).expect(422);
    sse.close();
  });

  it("keeps a session's checkpoints for when it is resumed", async () => {
    t = await makeTestApp({ withCheckpoints: true });
    repo(t.project);
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "only turn" }).expect(202);
    await sse.waitFor(() => t?.manager.get(chat.chatId).snapshot().checkpoints.length === 1 && t.manager.get(chat.chatId).status === "idle");
    const sessionId = t.manager.get(chat.chatId).sessionId as string;
    sse.close();
    await agent.post(`/api/chats/${chat.chatId}/dispose`).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    const resumed = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200)).body as ChatSnapshot;
    const live = t.manager.get(resumed.chatId);
    await live.checkpoints?.start();
    expect(live.snapshot().checkpoints).toEqual([1]);
  });
});
