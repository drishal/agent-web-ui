import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { HermesAdapter, liveHermesChildren } from "../../src/server/harness/hermes.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-hermes.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: HermesAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-hermes-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      spawns: [],
      rows: [{ id: "20261002_120000_fake1", title: "Fake Hermes session", cwd: project, last_active: 1790921090, message_count: 3 }],
    }),
  );
  process.env.FAKE_HERMES_STATE = state;
  adapter = new HermesAdapter({ command: process.execPath, args: [script] });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveHermesChildren()).toBe(0);
});

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}) });
  open.push(live);
  const ws: WorkspaceInfo = { id: "w", path: project, name: "proj" };
  return { live, chat: await Chat.open("c1", adapter, ws, live) };
}

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("hermes adapter (scripted gateway)", () => {
  it("creates a session and streams a turn with thinking and usage", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toBe("20261002_120000_fake1");
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle");
    const snap = chat.snapshot();
    const assistant = snap.items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ text: "hermes says hello there", thinking: "hmm ", streaming: false });
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    const usage = await live.getUsage();
    expect(usage).toMatchObject({ turns: 1, input: 900, output: 12, cachedInput: 300 });
    expect(chat.snapshot().config).toMatchObject({ model: "fake/fake-model", thinkingLevel: "medium" });
  });

  it("streams tool rows from tool.start and tool.complete", async () => {
    const { chat } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle");
    const tool = chat.snapshot().items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ name: "read", status: "done", category: "read", summary: "README.md" });
    expect(tool && tool.kind === "tool" && tool.output).toContain("file.txt");
  });

  it("raises approvals from server requests and answers them", async () => {
    const { chat } = await openChat();
    await chat.send("ask to delete", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const request = chat.snapshot().pending[0];
    expect(request).toMatchObject({ kind: "select", options: ["once", "session", "always", "deny"] });
    expect(request?.message).toContain("rm -rf /tmp/x");
    expect(chat.answer(request?.id as string, { kind: "select", value: "once" })).toContain("once");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().pending).toEqual([]);
  });

  it("interrupts a running turn", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.status === "running");
    await chat.abort();
    expect(chat.status).toBe("idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant && assistant.kind === "assistant" && assistant.text.length).toBeLessThan("hermes says slow please".length);
  });

  it("lists models with model.options", async () => {
    const models = await adapter.listModels(project);
    expect(models.map((m) => m.key)).toEqual(["fake/fake-model", "fake/fake-mini"]);
    expect(models[0]).toMatchObject({ reasoning: true });
  });

  it("lists stored sessions for the workspace and recent ones across projects", async () => {
    const sessions = await adapter.listSessions(project);
    expect(sessions.map((s) => s.nativeId)).toEqual(["20261002_120000_fake1"]);
    expect(sessions[0]).toMatchObject({ title: "Fake Hermes session", messageCount: 3 });
    const recent = await adapter.listRecentSessions(10);
    expect(recent.map((s) => s.cwd)).toEqual([project]);
  });

  it("resumes a stored session and changes model and reasoning", async () => {
    const { chat, live } = await openChat("20261002_120000_fake1");
    expect(live.nativeId).toBe("20261002_120000_fake1");
    await chat.setConfig({ model: "fake/fake-mini", thinkingLevel: "high" });
    const config = await live.getConfig();
    expect(config).toMatchObject({ model: "fake/fake-mini", thinkingLevel: "high" });
  });

  it("reports a turn failure as an error on the assistant item", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle");
    const assistant = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(assistant).toMatchObject({ error: "fake failure" });
  });
});

describe("gateway runtime", () => {
  it("runs the gateway with the environment the hermes launcher sets up", async () => {
    // A Nix-style wrapper: exports, then exec. The TUI's gateway inherits these.
    const launcher = path.join(tempDir("awui-hermes-bin-"), "hermes");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        "export HERMES_PYTHON='/opt/fake/python3'",
        "export HERMES_BUNDLED_PLUGINS='/opt/fake/plugins'",
        "PYTHONPATH=/opt/fake/site-packages",
        "export PYTHONPATH",
        'exec /opt/fake/hermes "$@"',
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    const saved = { bin: process.env.HERMES_BIN, python: process.env.HERMES_PYTHON };
    process.env.HERMES_BIN = launcher;
    delete process.env.HERMES_PYTHON;
    try {
      const spec = await new HermesAdapter().spawnSpec();
      expect(spec.command).toBe("/opt/fake/python3");
      expect(spec.args).toEqual(["-m", "tui_gateway.entry"]);
      expect(spec.env).toMatchObject({ HERMES_BUNDLED_PLUGINS: "/opt/fake/plugins", PYTHONPATH: "/opt/fake/site-packages" });
    } finally {
      for (const [key, value] of [["HERMES_BIN", saved.bin], ["HERMES_PYTHON", saved.python]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
