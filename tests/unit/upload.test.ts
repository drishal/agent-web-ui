// Uploading into a project: new files only, inside the folder, bounded by the body.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setUp() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
  const post = (name: string, body: Buffer) =>
    agent.post(`/api/workspaces/${ws.id}/upload`).query({ name }).set("content-type", "application/octet-stream").send(body);
  return { root: t.project, post };
}

describe("uploading a file into a project", () => {
  it("writes a new file, and refuses to replace one", async () => {
    const { root, post } = await setUp();
    const res = await post("notes.txt", Buffer.from("hello")).expect(201);
    expect(res.body).toEqual({ path: "notes.txt", bytes: 5 });
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("hello");
    expect((await post("notes.txt", Buffer.from("again"))).status).toBe(409);
    expect(readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("hello");
  });

  it("keeps the base name, and refuses a nameless or empty upload", async () => {
    const { root, post } = await setUp();
    expect((await post("../escape.txt", Buffer.from("x"))).status).toBe(201);
    expect(readFileSync(path.join(root, "escape.txt"), "utf8")).toBe("x");
    expect((await post("", Buffer.from("x"))).status).toBe(400);
    expect((await post(".", Buffer.from("x"))).status).toBe(400);
    expect((await post("empty.txt", Buffer.alloc(0))).status).toBe(400);
  });
});
