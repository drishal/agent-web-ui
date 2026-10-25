// Running a routine (routine-runner.ts): a chat in its project, with its prompt sent.
import { afterEach, describe, expect, it } from "vitest";
import type { Routine, WorkspaceInfo } from "../../src/shared/protocol.js";
import { runRoutine } from "../../src/server/routine-runner.js";
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

describe("running a routine", () => {
  it("opens a chat in its project and sends the prompt", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;
    const routine: Routine = {
      id: "r1",
      name: "Nightly review",
      prompt: "Review today's commits",
      harnessId: "fake",
      workspaceId: ws.id,
      cadence: { kind: "daily", hour: 9, minute: 0 },
      enabled: true,
      nextRunAt: Date.now(),
      lastRunAt: null,
    };

    const chat = await runRoutine(routine, ws, t.fake, t.manager);
    await until(() => chat.snapshot().items.some((item) => item.kind === "user"));
    expect(chat.snapshot().workspace.id).toBe(ws.id);
    expect(chat.snapshot().items.flatMap((item) => (item.kind === "user" ? [item.text] : []))).toEqual(["Review today's commits"]);
    await until(() => chat.status === "idle");
  });
});
