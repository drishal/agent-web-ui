#!/usr/bin/env node
// Scripted `claude -p --input-format stream-json --output-format stream-json`
// for adapter tests: the frames and control requests the real CLI speaks (as
// recorded from Claude Code 2.1.289), and session files in its shape under
// $CLAUDE_CONFIG_DIR/projects/<cwd as dashes>/<id>.jsonl. Prompt text selects
// behaviour:
//   "tool"  read a file first        "ask"       a Bash call that needs approval
//   "slow"  stream many chunks       "fail"      end the turn with an error
//   "todo"  write a TodoWrite list   "question"  an AskUserQuestion call
//   "/compact"  compact the conversation
// A message sent while a turn runs is queued: priority "next" lands after the
// current tool call, anything else runs once the turn ends. Every permission
// answer is recorded in $FAKE_CLAUDE_STATE.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const persist = !argv.includes("--no-session-persistence");
const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id") ?? randomUUID();
const cwd = process.cwd();
const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude"), "projects");
const file = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
if (resume && !existsSync(file)) {
  console.error(`No conversation found with session ID: ${resume}`);
  process.exit(1);
}

const statePath = process.env.FAKE_CLAUDE_STATE;
const record = (key, value) => {
  if (!statePath) return;
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  state[key] = [...(state[key] ?? []), value];
  writeFileSync(statePath, JSON.stringify(state));
};

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the session file ------------------------------------------------------
let leaf = null;
if (resume) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (typeof e.uuid === "string") leaf = e.uuid;
    } catch {}
  }
}
const write = (entry) => {
  if (!persist) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ...entry, sessionId })}\n`);
};
const chained = (entry) => {
  const uuid = randomUUID();
  write({ ...entry, uuid, parentUuid: leaf, isSidechain: false, cwd, timestamp: new Date().toISOString() });
  leaf = uuid;
};

// ---- turns -------------------------------------------------------------------
const MODELS = [
  { value: "default", resolvedModel: "fake-opus", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "fake-haiku", displayName: "Haiku", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
];
let model = "default";
let busy = false;
let aborted = false;
const steering = [];
const followUps = [];
const pendingPermissions = new Map();

function usage(output) {
  return { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: output };
}

/** One model call: stream its text, then write its blocks; returns the message id. */
async function modelCall(text, { thinking = "hmm", tool = null, chunks = null, delay = 2 } = {}) {
  const id = `msg_${randomUUID().slice(0, 8)}`;
  out({ type: "stream_event", event: { type: "message_start", message: { id, model: "fake-opus", usage: usage(1) } }, parent_tool_use_id: null, session_id: sessionId });
  if (thinking) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "thinking", thinking }] }, parent_tool_use_id: null, session_id: sessionId });
    chained({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "thinking", thinking, signature: "sig" }], usage: usage(1) } });
  }
  let body = "";
  for (const chunk of chunks ?? (text ? [text] : [])) {
    if (aborted) break;
    await sleep(delay);
    body += chunk;
    out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chunk } }, parent_tool_use_id: null, session_id: sessionId });
  }
  if (body) {
    out({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "text", text: body }] }, parent_tool_use_id: null, session_id: sessionId });
    chained({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "text", text: body }], usage: usage(12) } });
  }
  if (tool && !aborted) {
    const block = { type: "tool_use", id: tool.id, name: tool.name, input: tool.input };
    out({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [block] }, parent_tool_use_id: null, session_id: sessionId });
    chained({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [block], usage: usage(12) } });
  }
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 12 } }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, session_id: sessionId });
  return body;
}

function toolResult(toolUseId, content, isError = false) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
  out({ type: "user", message: { role: "user", content: [block] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
  chained({ type: "user", message: { role: "user", content: [block] } });
}

/** Ask the host, as the CLI does over --permission-prompt-tool stdio. */
function askPermission(toolName, input, toolUseId) {
  const requestId = randomUUID();
  out({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      display_name: toolName,
      input,
      description: "Create a scratch file",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName, ruleContent: input.command ?? "" }], behavior: "allow", destination: "localSettings" }],
      tool_use_id: toolUseId,
    },
  });
  return new Promise((resolve) => pendingPermissions.set(requestId, resolve));
}

/** Messages that arrived mid-turn and land at this tool boundary. */
function drainSteering() {
  while (steering.length > 0) {
    const m = steering.shift();
    consume(m, true);
  }
}

/** The CLI takes a prompt: echo it, and record it (injected ones as queued_command attachments). */
function consume(m, injected, record = true) {
  out({ type: "user", message: m.message, parent_tool_use_id: null, session_id: sessionId, uuid: m.uuid, isReplay: true, timestamp: new Date().toISOString() });
  const text = typeof m.message.content === "string" ? m.message.content : m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!record) return text;
  if (injected) chained({ type: "attachment", attachment: { type: "queued_command", prompt: text, source_uuid: m.uuid } });
  else chained({ type: "user", message: m.message });
  return text;
}

async function runTurn(m) {
  busy = true;
  aborted = false;
  const compacting = typeof m.message.content === "string" && m.message.content.startsWith("/compact");
  const text = consume(m, false, !compacting);
  out({ type: "system", subtype: "init", session_id: sessionId, cwd, model: "fake-opus", tools: ["Bash", "Read"] });
  let error = null;
  let answer = "";
  if (text.startsWith("/compact")) {
    out({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
    await sleep(5);
    // As recorded from print mode: boundary → summary on a new chain, the
    // command's own entries still appended to the old leaf.
    const boundary = randomUUID();
    write({ type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null, cwd, timestamp: new Date().toISOString() });
    write({ type: "user", uuid: randomUUID(), parentUuid: boundary, isCompactSummary: true, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "Summary of the conversation so far" } });
    chained({ type: "user", message: { role: "user", content: `<command-name>/compact</command-name>\n<command-args>${text.slice("/compact".length).trim()}</command-args>` } });
    chained({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } });
    out({ type: "system", subtype: "compact_boundary", session_id: sessionId });
  } else {
    if (/\btool\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      await modelCall("", { tool: { id, name: "Read", input: { file_path: "README.md" } } });
      toolResult(id, "file.txt");
      drainSteering();
    }
    if (/\btodo\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      await modelCall("", { tool: { id, name: "TodoWrite", input: { todos: [{ content: "Write tests", status: "in_progress", activeForm: "Writing tests" }, { content: "Ship", status: "pending", activeForm: "Shipping" }] } } });
      toolResult(id, "Todos have been modified successfully.");
    }
    if (/\bask\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const input = { command: "touch made.txt", description: "Create a scratch file" };
      await modelCall("", { tool: { id, name: "Bash", input } });
      const verdict = await askPermission("Bash", input, id);
      record("permissions", verdict);
      if (verdict.behavior === "allow") toolResult(id, "made");
      else toolResult(id, verdict.message ?? "denied", true);
      drainSteering();
    }
    if (/\bquestion\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const input = { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false }] };
      await modelCall("", { tool: { id, name: "AskUserQuestion", input } });
      const verdict = await askPermission("AskUserQuestion", input, id);
      record("permissions", verdict);
      toolResult(id, verdict.behavior === "allow" ? `answered ${JSON.stringify(verdict.updatedInput?.answers ?? {})}` : "dismissed", verdict.behavior !== "allow");
    }
    const slow = /\bslow\b/.test(text);
    answer = await modelCall(`claude says ${text}`, slow ? { chunks: Array.from({ length: 40 }, (_, i) => `${i} `), delay: 20 } : {});
    if (/\bfail\b/.test(text)) error = "fake failure";
  }
  const interrupted = aborted;
  if (interrupted) write({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, uuid: randomUUID(), parentUuid: leaf, cwd, timestamp: new Date().toISOString() });
  out({
    type: "result",
    subtype: interrupted ? "error_during_execution" : error ? "error_max_turns" : "success",
    is_error: interrupted || Boolean(error),
    terminal_reason: interrupted ? "aborted_streaming" : "completed",
    ...(error ? { errors: [error] } : {}),
    result: answer,
    usage: usage(12),
    total_cost_usd: 0.01,
    num_turns: 1,
    session_id: sessionId,
  });
  write({ type: "cost-state", totalCostUSD: 0.01, modelUsage: {} });
  busy = false;
  const next = followUps.shift() ?? steering.shift();
  if (next) void runTurn(next);
}

// ---- control ---------------------------------------------------------------------
function control(frame) {
  const { request_id: id, request } = frame;
  const ok = (response) => out({ type: "control_response", response: { subtype: "success", request_id: id, ...(response === undefined ? {} : { response }) } });
  switch (request.subtype) {
    case "initialize":
      return ok({
        commands: [{ name: "review", description: "Review the change", argumentHint: "[focus]" }],
        models: MODELS,
        account: { email: "someone@example.com", subscriptionType: "Claude Pro" },
        current_permission_mode: "default",
      });
    case "get_settings":
      return ok({ effective: { model: "default", effortLevel: "medium" } });
    case "set_model":
      model = request.model ?? "default";
      record("models", model);
      return ok();
    case "apply_flag_settings":
      record("flags", request.settings);
      return ok();
    case "set_max_thinking_tokens":
      return ok();
    case "list_models":
      return ok({ models: [...MODELS, { value: "sonnet", resolvedModel: "fake-sonnet", displayName: "Sonnet", supportedEffortLevels: ["low"] }] });
    case "get_context_usage":
      return ok({
        totalTokens: 3000,
        maxTokens: 200000,
        percentage: 1.5,
        categories: [
          { name: "System prompt", tokens: 2000, kind: "used" },
          { name: "System tools (deferred)", tokens: 9000, kind: "deferred" },
          { name: "Messages", tokens: 1000, kind: "used" },
          { name: "Free space", tokens: 197000, kind: "free" },
        ],
      });
    case "rename_session":
      write({ type: "custom-title", customTitle: request.title });
      out({ type: "system", subtype: "session_title_changed", title: request.title, session_id: sessionId });
      return ok();
    case "interrupt":
      aborted = true;
      for (const [rid, resolve] of pendingPermissions) {
        pendingPermissions.delete(rid);
        out({ type: "control_cancel_request", request_id: rid });
        resolve({ behavior: "deny", message: "interrupted" });
      }
      return ok();
    case "cancel_async_message": {
      for (const queue of [steering, followUps]) {
        const i = queue.findIndex((m) => m.uuid === request.message_uuid);
        if (i >= 0) queue.splice(i, 1);
      }
      record("cancelled", request.message_uuid);
      return ok({ cancelled: true });
    }
    default:
      return out({ type: "control_response", response: { subtype: "error", request_id: id, error: `unknown subtype ${request.subtype}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === "control_request") return control(frame);
  if (frame.type === "control_response") {
    const resolve = pendingPermissions.get(frame.response.request_id);
    if (resolve) {
      pendingPermissions.delete(frame.response.request_id);
      resolve(frame.response.response);
    }
    return;
  }
  if (frame.type === "user") {
    const m = { message: frame.message, uuid: frame.uuid ?? randomUUID() };
    if (!busy) return void runTurn(m);
    if (frame.priority === "next") steering.push(m);
    else followUps.push(m);
  }
});
rl.on("close", () => process.exit(0));
