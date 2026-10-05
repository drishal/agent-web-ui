import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { ClaudeAdapter, liveClaudeChildren } from "../../src/server/harness/claude.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-claude.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: ClaudeAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-claude-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new ClaudeAdapter({
    command: script,
    home,
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_STATE: state, CLAUDECODE: "1" },
  });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveClaudeChildren()).toBe(0);
});

const ws = (): WorkspaceInfo => ({ id: "w", path: project, name: "proj" });

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}) });
  open.push(live);
  return { live, chat: await Chat.open(`c${open.length}`, adapter, ws(), live) };
}

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const recorded = (key: string): unknown[] => {
  try {
    return (JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown[]>)[key] ?? [];
  } catch {
    return [];
  }
};

const answered = (chat: Chat, text: string) => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes(text));

describe("claude adapter (scripted CLI)", () => {
  it("opens with a session id of its own, then streams a turn with thinking and usage", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.snapshot().config).toMatchObject({ model: "default", thinkingLevel: "medium" });
    expect(chat.snapshot().config.models.map((m) => [m.key, m.levels])).toEqual([
      ["default", ["low", "medium", "high"]],
      ["haiku", ["low", "high"]],
    ]);
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says hello there"));
    const snap = chat.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items[1]).toMatchObject({ text: "claude says hello there", thinking: "hmm", streaming: false });
    expect(await live.getUsage()).toMatchObject({ turns: 1, steps: 1, input: 10, cachedInput: 100, cacheWrite: 20, output: 12, cost: 0.01 });
    // The account (email, plan) from the handshake never reaches a snapshot.
    expect(JSON.stringify(snap)).not.toContain("someone@example.com");
  });

  it("shows tool calls after the model call that made them, with their output", async () => {
    const { chat } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    const kinds = chat.snapshot().items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(chat.snapshot().items[2]).toMatchObject({ name: "Read", status: "done", output: "file.txt", category: "read", summary: "README.md" });
  });

  it("turns can_use_tool into an approval card and answers it, session rules scoped to the session", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    expect(card).toMatchObject({ kind: "select", title: "Allow Bash?", options: ["Allow once", "Allow for this session", "Deny"] });
    expect(card?.message).toContain("touch made.txt");
    chat.answer(card?.id as string, { kind: "select", value: "Allow for this session" });
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    const verdict = recorded("permissions")[0] as { behavior: string; updatedInput: unknown; updatedPermissions: Array<{ destination: string }> };
    expect(verdict.behavior).toBe("allow");
    expect(verdict.updatedInput).toMatchObject({ command: "touch made.txt" });
    expect(verdict.updatedPermissions.map((p) => p.destination)).toEqual(["session"]);
    expect(chat.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ status: "done", output: "made" });
  });

  it("a denial reaches the CLI and the tool shows as failed", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Deny" });
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    expect(recorded("permissions")[0]).toMatchObject({ behavior: "deny" });
    expect(chat.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ status: "error" });
  });

  it("asks AskUserQuestion's questions as cards and hands the answers back", async () => {
    const { chat } = await openChat();
    await chat.send("question time", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    expect(chat.snapshot().pending[0]).toMatchObject({ title: "Colour", message: "Which colour?", options: ["Red", "Blue"] });
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Blue" });
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    expect(recorded("permissions")[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which colour?": "Blue" } } });
  });

  it("steers into the running turn and queues follow-ups for after it", async () => {
    const { chat } = await openChat();
    await chat.send("ask first", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    await chat.send("also this", "steer");
    await chat.send("and then that", "followUp");
    expect(chat.snapshot().queue).toEqual({ steering: ["also this"], followUp: ["and then that"] });
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && answered(chat, "claude says and then that"));
    const prompts = chat.snapshot().items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""));
    expect(prompts).toEqual(["ask first", "also this", "and then that"]);
    expect(chat.snapshot().queue).toEqual({ steering: [], followUp: [] });
  });

  it("stops a run, dropping what was queued behind it", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("never run", "followUp");
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(recorded("cancelled")).toHaveLength(1);
    expect(chat.snapshot().queue.followUp).toEqual([]);
    const answer = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(answer && answer.kind === "assistant" && answer.text.length).toBeLessThan("claude says slow please".length + 80);
  });

  it("reports a failed turn as a notice and still settles", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "notice"));
    expect(chat.snapshot().items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: "fake failure" });
  });

  it("keeps Claude Code's TodoWrite list as the chat's todos", async () => {
    const { chat, live } = await openChat();
    await chat.send("todo list", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    expect(await live.getTodos()).toEqual([
      { text: "Write tests", status: "in_progress" },
      { text: "Ship", status: "pending" },
    ]);
  });

  it("changes model and effort for this session only", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ model: "haiku", thinkingLevel: "high" });
    expect(chat.snapshot().config).toMatchObject({ model: "haiku", thinkingLevel: "high" });
    expect(recorded("models")).toEqual(["haiku"]);
    expect(recorded("flags")).toEqual([{ effortLevel: "high" }]);
    await chat.refreshModels();
    expect(chat.snapshot().config.models.map((m) => m.key)).toContain("sonnet");
  });

  it("reads context usage with Claude Code's own categories, minus deferred and free space", async () => {
    const { live } = await openChat();
    expect(await live.getContextUsage()).toEqual({
      tokens: 3000,
      window: 200000,
      percent: 1.5,
      categories: [
        { id: "system-prompt", label: "System prompt", tokens: 2000 },
        { id: "messages", label: "Messages", tokens: 1000 },
      ],
    });
    expect((await live.listCommands())[0]).toEqual({ name: "review", description: "Review the change", hint: "[focus]", source: "command" });
  });

  it("renames, lists, resumes from the file, and forks through a turn", async () => {
    const { chat, live } = await openChat();
    await chat.send("first prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says first prompt"));
    await chat.send("second tool prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says second tool prompt"));
    await chat.rename("Named session");
    const nativeId = live.nativeId as string;
    expect((await adapter.listSessions(project)).map((s) => [s.nativeId, s.title, s.messageCount])).toEqual([[nativeId, "Named session", 2]]);
    expect((await adapter.listRecentSessions(10)).map((s) => s.cwd)).toEqual([project]);
    await chat.dispose("done");

    const { chat: resumed, live: again } = await openChat(nativeId);
    expect(again.title).toBe("Named session");
    expect(resumed.snapshot().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant"]);
    expect(resumed.snapshot().usage).toMatchObject({ turns: 2, cost: 0.01 });

    const fork = await adapter.forkSession({ cwd: project, nativeId, throughTurns: 1 });
    const { chat: copy } = await openChat(fork.nativeId);
    expect(copy.snapshot().items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual(["first prompt", "claude says first prompt"]);
  });

  it("compacts and waits for the CLI to finish", async () => {
    const { chat } = await openChat();
    await chat.send("first prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    await chat.compact("keep it short");
    expect(chat.status).toBe("idle");
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.text === "Compacted conversation")).toBe(true);
    // Reopened, the history starts at the compaction, not with what it summarized.
    expect((await open[0]?.history())?.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["notice", "/compact keep it short", "assistant"]);
  });

  it("refuses a session that is not in the project's folder", async () => {
    await expect(adapter.openChat({ cwd: project, resumeNativeId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/not found/);
  });
});
