#!/usr/bin/env node
// Scripted `tui_gateway.entry` for adapter tests: newline-delimited JSON-RPC on
// stdio, the shapes the real gateway speaks. Prompt text selects behaviour —
// the same scenario set as the pi fake (src/server/harness/fake.ts):
//   "tool"  run a fake tool            "ask"    raise an approval request first
//   "ask twice"  two approval requests at once (stacked approvals)
//   "fail"  end the turn with an error "slow"   stream many chunks
//   "big"   oversized tool output          "edit"  edit a file (src/app.ts)
//   "vanish"  the turn stops on a fallback model with no message.complete
// Session rows for projects.tree/list come from FAKE_HERMES_STATE (JSON file).
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const stateFile = process.env.FAKE_HERMES_STATE;
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ok = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const event = (type, payload, sessionId = runtimeId) =>
  out({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, ...(payload === undefined ? {} : { payload }) } });

const storedId = "20261002_120000_fake1";
let runtimeId = "4242";
let title = "Fake Hermes session";
let model = "fake-model";
let effort = "medium";
let aborted = false;
let turns = 0;
const messages = [];
const approvals = [];

const state = () => {
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8"));
    return { rows: Array.isArray(raw?.rows) ? raw.rows : [], spawns: Array.isArray(raw?.spawns) ? raw.spawns : [] };
  } catch {
    return { rows: [], spawns: [] };
  }
};
const persist = (patch) => {
  if (!stateFile) return;
  writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
};

persist({ spawns: [...state().spawns, { cwd: process.cwd(), args: process.argv.slice(2) }] });

event("gateway.ready", { skin: { name: "fake" }, change_events: true, replay_epoch: "test-epoch" }, "");

function emitUsage() {
  return { model: "fake-model", input: 900, output: 12, reasoning: 3, total: 912, calls: turns, context_used: 1200, context_max: 200000, context_percent: 1, cache_read: 300, cache_write: 0 };
}

async function runPrompt(text) {
  aborted = false;
  const sessionId = runtimeId;
  event("session.info", { model, provider: "fake", reasoning_effort: effort, running: true, title, stored_session_id: storedId });
  event("message.start", undefined, sessionId);
  if (/\bask\b/.test(text)) {
    // "ask twice" raises both requests before awaiting (stacked approvals).
    const count = /\btwice\b/.test(text) ? 2 : 1;
    const answers = Array.from({ length: count }, (_, i) => {
      const requestId = `req-${approvals.length + 1}`;
      approvals.push(requestId);
      const { promise, resolve } = Promise.withResolvers();
      pendingApprovals.set(`srq-${requestId}`, resolve);
      out({
        jsonrpc: "2.0",
        id: `srq-${requestId}`,
        method: "approval",
        params: { session_id: sessionId, request_id: requestId, command: i === 0 ? "rm -rf /tmp/x" : "cat /etc/secrets", description: i === 0 ? "Delete a scratch tree" : "Read a secret file", choices: ["once", "session", "always", "deny"], tool_name: "terminal" },
      });
      return promise;
    });
    await Promise.all(answers);
    event("tool.start", { tool_id: "t-approval", name: "terminal", args: { command: "rm -rf /tmp/x" } });
    event("tool.complete", { tool_id: "t-approval", name: "terminal", result: "removed", summary: "rm -rf /tmp/x" });
  }
  if (/\btool\b|\bbig\b/.test(text)) {
    const big = /\bbig\b/.test(text);
    event("tool.start", { tool_id: "t1", name: "read", args: { path: "README.md" } });
    event("tool.complete", { tool_id: "t1", name: "read", result: { content: [{ type: "text", text: big ? "x".repeat(200_000) : "file.txt" }] } });
  }
  if (/\bedit\b/.test(text)) {
    event("tool.start", { tool_id: "t2", name: "edit", args: { path: `${process.cwd()}/src/app.ts`, oldText: "a", newText: "b" } });
    event("tool.complete", { tool_id: "t2", name: "edit", result: { content: [{ type: "text", text: "Edited src/app.ts (+1 -1)" }] } });
  }
  let body = "";
  const chunks = /\bslow\b/.test(text) ? ["a", "b", "c", "d", "e"] : [`hermes says ${text}`];
  for (const chunk of chunks) {
    if (aborted) break;
    await new Promise((r) => setTimeout(r, 5));
    body += chunk;
    event("reasoning.delta", { text: "hmm " }, sessionId);
    event("message.delta", { text: chunk }, sessionId);
  }
  if (/\bvanish\b/.test(text)) {
    // A reclaimed turn: only session.info says it stopped (and on which model).
    event("session.info", { model: "fake-fallback", provider: "fake", reasoning_effort: effort, running: false, title, stored_session_id: storedId });
    return;
  }
  turns += 1;
  const failed = /\bfail\b/.test(text);
  event("message.complete", { text: body, status: aborted ? "interrupted" : failed ? "error" : "complete", ...(failed ? { error: "fake failure" } : {}), reasoning: "hmm ", usage: emitUsage() }, sessionId);
  event("session.info", { model, provider: "fake", reasoning_effort: effort, running: false, title, stored_session_id: storedId, usage: emitUsage() });
  messages.push({ role: "user", text, timestamp: Date.now() / 1000 }, { role: "assistant", text: body, reasoning: "hmm", timestamp: Date.now() / 1000 });
}

const pendingApprovals = new Map();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  // A response to one of our server→client requests (approval).
  if (frame.method === undefined && frame.id !== undefined && pendingApprovals.size > 0) {
    const resolve = pendingApprovals.get(String(frame.id)) ?? pendingApprovals.values().next().value;
    if (resolve) {
      for (const [key, done] of pendingApprovals) {
        if (done === resolve) {
          pendingApprovals.delete(key);
          break;
        }
      }
      approvals.push(`answered:${frame.result?.choice ?? "?"}`);
      resolve();
    }
    return;
  }
  const { id, method, params = {} } = frame;
  switch (method) {
    case "ping":
      return ok(id, { pong: true });
    case "gateway.capabilities":
      return ok(id, { per_session_exclusive_submit: true });
    case "client.capabilities":
      return ok(id, { server_requests: ["approval", "clarify"], declines_not_shown: true });
    case "session.create":
      runtimeId = "4242";
      title = params.title ?? title;
      return ok(id, { session_id: runtimeId, stored_session_id: storedId, message_count: 0, messages: [], info: { model, provider: "fake", reasoning_effort: effort, title, cwd: params.cwd ?? process.cwd(), stored_session_id: storedId, running: false, lazy: true } });
    case "session.resume":
      runtimeId = "4242";
      if (params.session_id !== storedId && params.session_id !== title) return fail(id, 4006, "session not found");
      return ok(id, { session_id: runtimeId, stored_session_id: storedId, message_count: messages.length, messages, status: "idle", running: false, info: { model, provider: "fake", reasoning_effort: effort, title, cwd: process.cwd(), stored_session_id: storedId, running: false } });
    case "session.history":
      return ok(id, { count: messages.length, messages });
    case "session.title":
      if (params.title) {
        title = params.title;
        event("session.title", { session_id: storedId, title });
      }
      return ok(id, { title });
    case "session.interrupt":
      aborted = true;
      for (const resolve of pendingApprovals.values()) resolve();
      pendingApprovals.clear();
      return ok(id, { status: "interrupted", interrupted: true });
    case "session.compress":
      return ok(id, { status: "compressed", removed: 2, before_messages: 10, after_messages: 8 });
    case "session.close":
      runtimeId = "";
      return ok(id, { closed: true });
    // "/" commands as the gateway runs them: slash.exec answers built-ins, sends skills to command.dispatch.
    case "complete.slash":
      return ok(id, {
        items: [
          { text: "/status", display: "/status", meta: "Show session status", kind: "command" },
          { text: "/review", display: "/review", meta: "Review the work so far", kind: "skill" },
        ],
      });
    case "slash.exec":
      if (String(params.command).startsWith("/status")) return ok(id, { output: "hermes status: fine" });
      return fail(id, 4018, "skill command: use command.dispatch");
    case "command.dispatch":
      if (params.name === "review") return ok(id, { type: "skill", name: "review", message: `Review: ${params.arg || "everything"}` });
      return fail(id, 4018, `not a quick/plugin/bundle/skill command: ${params.name}`);
    case "prompt.submit":
      ok(id, { status: "streaming" });
      void runPrompt(String(params.text ?? ""));
      return;
    case "image.attach_bytes":
      return ok(id, { attached: true, count: 1, name: params.filename ?? "pasted.png" });
    case "config.set":
      if (params.key === "model") {
        model = String(params.value).split("/").pop();
        event("session.info", { model, provider: String(params.value).split("/")[0], reasoning_effort: effort, running: false, stored_session_id: storedId, title });
        return ok(id, { key: "model", value: params.value });
      }
      if (params.key === "reasoning") {
        effort = String(params.value);
        event("session.info", { model, provider: "fake", reasoning_effort: effort, running: false, stored_session_id: storedId, title });
        return ok(id, { key: "reasoning", value: params.value });
      }
      return fail(id, 4002, `unknown config key: ${params.key}`);
    case "model.options":
      return ok(id, {
        providers: [
          { slug: "fake", name: "Fake", models: ["fake-model", "fake-mini"], capabilities: { "fake-model": { reasoning: true, fast: false }, "fake-mini": { reasoning: false, fast: true } }, authenticated: true, is_current: true },
        ],
        model: "fake-model",
        provider: "fake",
      });
    case "projects.tree":
      return ok(id, {
        projects: [
          {
            id: "p1",
            label: "proj",
            path: process.cwd(),
            previewSessions: state().rows,
          },
        ],
        active_id: "p1",
      });
    default:
      return fail(id, -32601, `unknown method: ${method}`);
  }
});
process.stdin.on("end", () => process.exit(0));
