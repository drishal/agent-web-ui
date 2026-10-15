// Saved prompts: kept by the server for every device, names unique, bounded,
// and written to the state folder so a restart keeps them.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_SAVED_PROMPT_CHARS, type SavedPrompt } from "../../src/shared/protocol.js";
import { SavedPrompts } from "../../src/server/saved-prompts.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("saved prompts", () => {
  it("saves, lists by name, renames, and removes, refusing a name already taken", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const review = (await agent.post("/api/prompts").send({ name: "review", text: "Review {{file}} for {{what}}" })).body as SavedPrompt;
    expect(review).toMatchObject({ name: "review", text: "Review {{file}} for {{what}}" });
    await agent.post("/api/prompts").send({ name: "Changelog", text: "Write the changelog" });
    expect(((await agent.get("/api/prompts")).body.prompts as SavedPrompt[]).map((p) => p.name)).toEqual(["Changelog", "review"]);
    expect((await agent.post("/api/prompts").send({ name: "REVIEW", text: "x" })).status).toBe(409);
    // Its own name, kept while the text changes, is no clash.
    const edited = (await agent.post("/api/prompts").send({ id: review.id, name: "review", text: "Review {{file}}" })).body as SavedPrompt;
    expect(edited).toMatchObject({ id: review.id, text: "Review {{file}}" });
    expect((await agent.delete(`/api/prompts/${review.id}`)).status).toBe(200);
    expect((await agent.delete(`/api/prompts/${review.id}`)).status).toBe(404);
    expect((await agent.post("/api/prompts").send({ id: review.id, name: "gone", text: "x" })).status).toBe(404);
  });

  it("refuses an empty, multi-line, or oversized prompt", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    expect((await agent.post("/api/prompts").send({ name: "  ", text: "x" })).status).toBe(400);
    expect((await agent.post("/api/prompts").send({ name: "a\nb", text: "x" })).status).toBe(400);
    expect((await agent.post("/api/prompts").send({ name: "big", text: "x".repeat(MAX_SAVED_PROMPT_CHARS + 1) })).status).toBe(400);
  });

  it("keeps them across a restart, in the state folder", async () => {
    const dir = tempDir("awui-prompts-");
    const store = await SavedPrompts.open(dir);
    await store.save({ name: "tests", text: "Run the tests" });
    const again = await SavedPrompts.open(dir);
    expect(again.list().map((p) => [p.name, p.text])).toEqual([["tests", "Run the tests"]]);
  });
});
