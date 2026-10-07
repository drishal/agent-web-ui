import { describe, expect, it } from "vitest";
import { View, plain, type Key } from "@stencil-hq/tern";
import type { ChatSnapshot, InteractionRequest } from "../../src/shared/protocol.js";
import { editDraft, type Draft } from "../../src/tern/draft.js";
import { readEvents } from "../../src/tern/server.js";
import { hunks, pickerModels, render, requestChoices, type Actions, type Ui } from "../../src/tern/view.js";

const key = (name: string, extra: Partial<Key> = {}): Key => ({
  name,
  text: name.length === 1 ? name : undefined,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...extra,
});

const type = (draft: Draft, ...keys: Key[]) => {
  for (const k of keys) editDraft(draft, k);
  return draft;
};

describe("awui draft", () => {
  it("inserts at the caret and deletes a whole surrogate pair", () => {
    const draft = type({ text: "", cursor: 0 }, key("a"), key("b"), key("left"), key("x", { text: "😀" }));
    expect(draft).toEqual({ text: "a😀b", cursor: 3 });
    type(draft, key("backspace"));
    expect(draft).toEqual({ text: "ab", cursor: 1 });
  });

  it("moves and deletes by word and by line", () => {
    const draft: Draft = { text: "one two\nthree four", cursor: 18 };
    type(draft, key("w", { ctrl: true, text: undefined }));
    expect(draft).toEqual({ text: "one two\nthree ", cursor: 14 });
    type(draft, key("home"));
    expect(draft.cursor).toBe(8);
    type(draft, key("u", { ctrl: true, text: undefined }));
    expect(draft.text).toBe("one two\nthree ");
    type(draft, key("left"), key("backspace", { alt: true }));
    expect(draft).toEqual({ text: "one \nthree ", cursor: 4 });
  });

  it("takes Meta for Ctrl, as Tern may report a PC keyboard's Ctrl", () => {
    const draft: Draft = { text: "one two", cursor: 7 };
    type(draft, key("w", { meta: true, text: undefined }));
    expect(draft).toEqual({ text: "one ", cursor: 4 });
  });

  it("normalizes pasted line endings and leaves chords and Enter to the caller", () => {
    const draft = type({ text: "", cursor: 0 }, key("paste", { text: "a\r\nb\rc" }));
    expect(draft.text).toBe("a\nb\nc");
    expect(editDraft(draft, key("p", { ctrl: true, text: undefined }))).toBe(false);
    expect(editDraft(draft, key("enter"))).toBe(false);
    expect(editDraft(draft, key("b", { alt: true }))).toBe(false);
    expect(draft.text).toBe("a\nb\nc");
  });
});

describe("awui event stream", () => {
  it("parses events split across chunks, with ids, event names and heartbeats", async () => {
    const encoder = new TextEncoder();
    async function* body() {
      for (const part of ["retry: 2000\n\nid: 7\nevent: ch", "at\ndata: {\"type\":\"status\",", "\"status\":\"idle\"}\n\nevent: heartbeat\ndata: {}\n\n"]) {
        yield encoder.encode(part);
      }
    }
    const seen = [];
    for await (const message of readEvents(body())) seen.push(message);
    expect(seen).toEqual([
      { id: "7", event: "chat", data: '{"type":"status","status":"idle"}' },
      { id: null, event: "heartbeat", data: "{}" },
    ]);
  });
});

const ask = (kind: InteractionRequest["kind"], options?: string[]): InteractionRequest => ({
  id: `r-${kind}`,
  kind,
  title: "Run tests?",
  message: "The agent wants to run `npm test`.",
  options,
  createdAt: 0,
});

const snapshot = (): ChatSnapshot => ({
  chatId: "c1",
  harnessId: "pi" as ChatSnapshot["harnessId"],
  sessionId: null,
  workspace: { id: "w1", path: "/home/u/project", name: "project" },
  title: "Fix the build",
  status: "running",
  items: [
    { kind: "user", id: "u1", text: "fix the build", imageCount: 1 },
    { kind: "assistant", id: "a1", text: "Looking at the **error**.", thinking: "It is a type error.", streaming: false },
    {
      kind: "tool",
      id: "t1",
      name: "edit",
      args: "",
      status: "done",
      output: "",
      truncated: false,
      category: "edit",
      summary: "/home/u/project/src/app.ts",
      paths: ["/home/u/project/src/app.ts"],
      diffStat: { added: 1, removed: 1 },
      diff: {
        added: 1,
        removed: 1,
        lines: [
          { kind: "hunk", text: "@@" },
          { kind: "ctx", text: "const a = 1;", line: 3 },
          { kind: "del", text: "const b = 2;", line: 4 },
          { kind: "add", text: "const b = 3;", line: 4 },
        ],
      },
      at: 1000,
      endedAt: 1640,
    },
    {
      kind: "tool",
      id: "t2",
      name: "task",
      args: "",
      status: "running",
      output: "",
      truncated: false,
      category: "agent",
      summary: "2 agents",
      paths: [],
      subagents: {
        runs: [
          { id: "0", agent: "scout", task: "Find the failing test", status: "running", activity: ["read src/app.test.ts"] },
          { id: "1", agent: "worker", task: "Fix it", status: "done", output: "Fixed." },
        ],
      },
      at: 2000,
    },
    { kind: "notice", id: "n1", level: "warning", text: "Context is filling up" },
  ],
  queue: { steering: ["also lint"], followUp: [] },
  pending: [ask("confirm")],
  config: {
    model: "anthropic/opus",
    thinkingLevel: "high",
    models: [
      { key: "anthropic/opus", provider: "anthropic", id: "opus", name: "Opus", reasoning: true },
      { key: "openai/gpt", provider: "openai", id: "gpt", name: "GPT" },
    ],
    thinkingLevels: ["low", "high"],
  },
  capabilities: {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    supportsExtensions: false,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
    supportsFork: true,
    supportsHandoff: true,
  },
  extensionStatus: {},
  context: { tokens: 50_000, window: 200_000, percent: 25 },
  usage: null,
  todos: [],
  generation: 1,
  lastEventId: 9,
});

const noop: Actions = { answer: () => {}, pickModel: () => {}, hoverModel: () => {}, send: () => {} };
const ui = (extra: Partial<Ui> = {}): Ui => ({
  draft: { text: "", cursor: 0 },
  connection: "connected",
  picker: null,
  flash: null,
  webUrl: "http://127.0.0.1:4783/#chat=c1",
  ...extra,
});

describe("awui view", () => {
  it("draws every kind of item with unique node ids", () => {
    const view = render(snapshot(), undefined, ui({ picker: { query: "", selected: null } }), noop, 3000);
    expect(() => View.from(view)).not.toThrow();
    const text = plain(view.main, 120);
    expect(text).toContain("fix the build");
    expect(text).toContain("Looking at the");
    expect(text).toContain("src/app.ts");
    expect(text).not.toContain("/home/u/project/src");
    expect(text).toContain("Find the failing test");
    expect(text).toContain("Context is filling up");
    const dock = plain(view.dock, 120);
    expect(dock).toContain("Run tests?");
    expect(dock).toContain("1 queued");
    expect(dock).toContain("25%");
  });

  it("numbers a question's choices and caps a select at nine", () => {
    expect(requestChoices(ask("confirm")).map((c) => c.answer)).toEqual([
      { kind: "confirm", confirmed: true },
      { kind: "confirm", confirmed: false },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `option ${i}`);
    expect(requestChoices(ask("select", many))).toHaveLength(9);
    expect(requestChoices(ask("input"))).toEqual([]);
  });

  it("turns a tool diff into Tern hunks", () => {
    const edit = snapshot().items[2];
    if (edit?.kind !== "tool" || !edit.diff) throw new Error("fixture: item 2 is the edit");
    expect(hunks(edit.diff)).toEqual([
      { newStart: 3, lines: [" const a = 1;", "-const b = 2;", "+const b = 3;"] },
    ]);
  });

  it("filters the model picker by name or key", () => {
    const { config } = snapshot();
    expect(pickerModels(config, "").map((m) => m.key)).toEqual(["anthropic/opus", "openai/gpt"]);
    expect(pickerModels(config, "OPENAI").map((m) => m.key)).toEqual(["openai/gpt"]);
  });
});
