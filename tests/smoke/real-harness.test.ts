// Opt-in smoke tests against the real installed harnesses: `npm run smoke`.
// Without SMOKE_MODEL nothing calls a model (no tokens). With SMOKE_MODEL set
// to a model already configured in both harnesses, preferably local (e.g.
// SMOKE_MODEL=local2/GLM5), it also runs prompt -> stream -> stop. This never
// starts or reconfigures a model server.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { liveOmpChildren, OmpAdapter } from "../../src/server/harness/omp.js";
import { PiAdapter } from "../../src/server/harness/pi.js";
import type { HarnessAdapter } from "../../src/server/harness/types.js";

const enabled = process.env.SMOKE === "1";
const model = process.env.SMOKE_MODEL;

function installed(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function workspace(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "awui-smoke-")), "project");
  mkdirSync(dir);
  return dir;
}

async function until(predicate: () => boolean, ms: number) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const harnesses: Array<[string, () => HarnessAdapter]> = [
  ["pi", () => new PiAdapter()],
  ["omp", () => new OmpAdapter({ agentDir: null, sessionDir: null, home: homedir() })],
];

for (const [name, make] of harnesses) {
  describe.skipIf(!enabled || !installed(name))(`${name} (real)`, () => {
    it("discovers, opens a session with the harness's normal tools, reports config, and disposes (no model call)", async () => {
      const adapter = make();
      const discovery = await adapter.discover();
      expect(discovery.available).toBe(true);
      const cwd = workspace();
      const live = await adapter.openChat({ cwd });
      const chat = await Chat.open("smoke", adapter, { id: "w", path: cwd, name: "project" }, live);
      const snap = chat.snapshot();
      // Extensions may post startup notices; there must be no conversation yet.
      expect(snap.items.filter((i) => i.kind !== "notice")).toEqual([]);
      expect(snap.config.models.length).toBeGreaterThan(0);
      expect(JSON.stringify(snap)).not.toMatch(/api[_-]?key|Bearer |sk-[A-Za-z0-9]{10}/i);
      await chat.dispose("smoke done");
      await adapter.shutdown();
      expect(liveOmpChildren()).toBe(0);
    }, 60_000);

    it("lists sessions for a workspace through the harness's own API", async () => {
      const adapter = make();
      const sessions = await adapter.listSessions(workspace());
      expect(sessions).toEqual([]);
      await adapter.shutdown();
    }, 60_000);

    it.skipIf(!model)(`prompt -> stream -> stop with ${model ?? "(SMOKE_MODEL unset)"}`, async () => {
      const adapter = make();
      const cwd = workspace();
      const live = await adapter.openChat({ cwd });
      const chat = await Chat.open("smoke", adapter, { id: "w", path: cwd, name: "project" }, live);
      await chat.setConfig({ model: model as string });
      await chat.send("Count slowly from 1 to 200, one number per line.", "normal");
      await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && (i.text.length > 0 || i.thinking.length > 0)), 90_000);
      await chat.abort();
      expect(chat.status).toBe("idle");
      const nativeId = chat.nativeId as string;
      await chat.dispose("smoke done");
      // Resume after "restart": a fresh adapter instance rebuilds from the harness's history.
      const fresh = make();
      const listed = await fresh.listSessions(cwd);
      expect(listed.map((s) => s.nativeId)).toContain(nativeId);
      const resumed = await fresh.openChat({ cwd, resumeNativeId: nativeId });
      expect(resumed.nativeId).toBe(nativeId);
      expect((await resumed.history()).some((i) => i.kind === "user")).toBe(true);
      await resumed.dispose();
      await fresh.shutdown();
      await adapter.shutdown();
      expect(liveOmpChildren()).toBe(0);
    }, 180_000);
  });
}

describe.skipIf(!enabled)("pi resume across restart (session written via Pi's own SessionManager)", () => {
  it("lists and resumes a persisted session in a fresh adapter", async () => {
    const pi = await import("@earendil-works/pi-coding-agent");
    const cwd = workspace();
    const sessionDir = path.join(path.dirname(cwd), "sessions");
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    try {
      const sm = pi.SessionManager.create(cwd, sessionDir);
      sm.appendMessage({ role: "user", content: "fixture question", timestamp: Date.now() });
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "fixture answer" }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as never);
      const adapter = new PiAdapter();
      const listed = await adapter.listSessions(cwd);
      expect(listed).toHaveLength(1);
      const live = await adapter.openChat({ cwd, resumeNativeId: listed[0]?.nativeId as string });
      const items = await live.history();
      expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
      expect(items[1]).toMatchObject({ text: "fixture answer" });
      await live.dispose();
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
    }
  }, 60_000);
});
