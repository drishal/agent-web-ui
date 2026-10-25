// The file viewer's route: a project's own files, read-only and bounded;
// what git ignores, what links out, and what is outside are refused.
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileView } from "../../src/shared/protocol.js";
import { readMedia, VIEW_BYTES } from "../../src/server/file-view.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setUp(withGit: boolean) {
  t = await makeTestApp();
  const root = t.project;
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "app.ts"), "const a = 1;\nexport default a;\n");
  writeFileSync(path.join(root, ".env"), "TOKEN=secret\n");
  writeFileSync(path.join(root, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(path.join(root, "big.txt"), `${"x".repeat(99)}\n`.repeat(Math.ceil((VIEW_BYTES * 1.5) / 100)));
  const outside = path.join(tempDir("awui-outside-"), "secret.txt");
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, path.join(root, "link.txt"));
  if (withGit) {
    writeFileSync(path.join(root, ".gitignore"), "ignored.log\n");
    writeFileSync(path.join(root, "ignored.log"), "noise\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
  }
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: root })).body as { id: string };
  const get = (p: string) => agent.get(`/api/workspaces/${ws.id}/file?path=${encodeURIComponent(p)}`);
  return { root, get };
}

describe("the file viewer's route", () => {
  it("reads a project file by its relative or absolute path", async () => {
    const { root, get } = await setUp(false);
    const view = (await get("src/app.ts")).body as FileView;
    expect(view).toEqual({ path: "src/app.ts", size: 31, text: "const a = 1;\nexport default a;\n", binary: false, truncated: false, lines: 2 });
    expect(((await get(path.join(root, "src", "app.ts"))).body as FileView).path).toBe("src/app.ts");
  });

  it("shows a binary file as binary, and only the head of a big one, cut at a line", async () => {
    const { get } = await setUp(false);
    expect((await get("blob.bin")).body).toMatchObject({ binary: true, text: null });
    const big = (await get("big.txt")).body as FileView;
    expect(big.truncated).toBe(true);
    expect(big.text?.length).toBeLessThanOrEqual(VIEW_BYTES);
    expect(big.text?.endsWith("\n")).toBe(true);
    expect(big.lines).toBe(Math.floor(VIEW_BYTES / 100));
  });

  it("refuses what is outside, what links out, and what the project does not list", async () => {
    const { get } = await setUp(false);
    expect((await get("../../etc/passwd")).status).toBe(403);
    expect((await get("/etc/passwd")).status).toBe(403);
    // Outside git the walk does not follow links, so one is not listed at all.
    expect((await get("link.txt")).status).toBe(404);
    // Outside git, the walk skips dotfiles: a .env is not the project's to show.
    expect((await get(".env")).status).toBe(404);
    expect((await get("src/nope.ts")).status).toBe(404);
    expect((await get("src")).status).toBe(404);
  });

  it("in a repository, refuses what git ignores, and finds a file made a moment ago", async () => {
    const { root, get } = await setUp(true);
    expect((await get("ignored.log")).status).toBe(404);
    expect((await get(".gitignore")).status).toBe(200);
    expect((await get("src/app.ts")).status).toBe(200);
    // git lists a link it does not ignore; where it points is outside, so it is refused.
    expect((await get("link.txt")).status).toBe(403);
    writeFileSync(path.join(root, "src", "fresh.ts"), "new\n");
    expect(((await get("src/fresh.ts")).body as FileView).text).toBe("new\n");
  });

  it("reads an image by its magic bytes, and refuses what is not one", async () => {
    const app = await makeTestApp();
    t = app;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    writeFileSync(path.join(app.project, "pic.png"), png);
    // A page or a script named .png is refused: the type is sniffed, not trusted.
    writeFileSync(path.join(app.project, "fake.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(await readMedia(app.project, "pic.png")).toEqual({ bytes: png, mimeType: "image/png" });
    await expect(readMedia(app.project, "fake.png")).rejects.toMatchObject({ status: 415 });
    await expect(readMedia(app.project, "../escape.png")).rejects.toMatchObject({ status: 403 });
  });
});
