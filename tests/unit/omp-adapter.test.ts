import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { liveOmpChildren, OmpAdapter } from "../../src/server/harness/omp.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-omp.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: OmpAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-omp-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new OmpAdapter({
    command: script,
    agentDir: null,
    sessionDir: null,
    home,
    env: { ...process.env, FAKE_OMP_STATE: state, PI_CODING_AGENT_DIR: "/belongs/to/pi" },
  });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveOmpChildren()).toBe(0);
});

const readState = () => JSON.parse(readFileSync(state, "utf8")) as {
  sessions: Record<string, { messages: unknown[] }>;
  spawns: Array<{ args: string[]; envPiDir: string | null }>;
  lastModel?: string;
};

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, toolsMode: "readOnly", ...(resumeNativeId ? { resumeNativeId } : {}) });
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

describe("omp adapter (scripted omp)", () => {
  it("discovers the version and refuses the home directory", async () => {
    const d = await adapter.discover();
    expect(d).toMatchObject({ available: true, version: "18.4.5", warnings: [] });
    expect(adapter.workspaceProblem(home)).toMatch(/home directory/);
    expect(adapter.workspaceProblem(project)).toBeNull();
  });

  it("spawns rpc-ui with read-only --tools and without Pi's PI_* overrides", async () => {
    const { chat } = await openChat();
    const spawn = readState().spawns[0];
    expect(spawn?.args.slice(0, 2)).toEqual(["--mode", "rpc-ui"]);
    expect(spawn?.args).toContain("--tools");
    expect(spawn?.envPiDir).toBeNull();
    expect(chat.snapshot().config).toMatchObject({ model: "fakeomp/m1", thinkingLevel: "low", toolsMode: "readOnly" });
    expect(JSON.stringify(chat.snapshot())).not.toMatch(/secret/);
    await until(() => chat.snapshot().extensionStatus.plan === "ready");
  });

  it("streams a prompt with a tool call and settles via session_settled", async () => {
    const { chat } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle");
    const items = chat.snapshot().items;
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant"]);
    expect(items[2]).toMatchObject({ text: "omp says run tool please", streaming: false });
  });

  it("surfaces select approvals and answers them over the protocol", async () => {
    const { chat } = await openChat();
    await chat.send("ask then tool", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const request = chat.snapshot().pending[0];
    expect(request).toMatchObject({ kind: "select", options: ["Approve", "Deny"] });
    expect(chat.answer(request?.id as string, { kind: "select", value: "Approve" })).toBe("Chose “Approve”");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().items.some((i) => i.kind === "tool")).toBe(true);
  });

  it("abort cancels pending dialogs and settles", async () => {
    const { chat } = await openChat();
    await chat.send("ask slow", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(chat.snapshot().pending).toEqual([]);
  });

  it("lists sessions through omp acp and resumes the exact session", async () => {
    const { chat, live } = await openChat();
    await chat.send("remember this", "normal");
    await until(() => chat.status === "idle");
    const nativeId = live.nativeId as string;
    await live.dispose();
    const sessions = await adapter.listSessions(project);
    expect(sessions.map((s) => s.nativeId)).toEqual([nativeId]);
    const { chat: resumed } = await openChat(nativeId);
    expect(resumed.nativeId).toBe(nativeId);
    expect(resumed.snapshot().items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["remember this"]);
  });

  it("restarts the child on the same session to change the tool set", async () => {
    const { chat, live } = await openChat();
    await chat.send("first", "normal");
    await until(() => chat.status === "idle");
    const before = live.nativeId;
    await chat.setConfig({ toolsMode: "full" });
    const spawns = readState().spawns;
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args).toContain("--resume");
    expect(spawns[1]?.args).not.toContain("--tools");
    expect(live.nativeId).toBe(before);
    expect(chat.snapshot().config.toolsMode).toBe("full");
    await chat.send("second", "normal");
    await until(() => chat.status === "idle");
    expect(chat.snapshot().items.filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("splits provider/model keys at the first slash only", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ model: "fakeomp/org/m2" });
    expect(readState().lastModel).toBe("fakeomp|org/m2");
  });

  it("reports a crashed child as a chat error", async () => {
    const { chat, live } = await openChat();
    const child = (live as unknown as { rpc: { proc: { child: { kill(s: string): void } } } }).rpc.proc.child;
    child.kill("SIGKILL");
    await until(() => chat.status === "error");
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.level === "error" && /stopped unexpectedly/.test(i.text))).toBe(true);
  });
});
