// Normalization for Pi-family agent events and transcript messages. omp is a
// Pi fork and emits the same shapes over RPC, so both adapters share this.
// Inputs are untyped on purpose: SDK and wire types never leave the adapters.
import type { ChatItem, ToolCategory, ToolItem } from "../../shared/protocol.js";
import type { HarnessEvent, StepUsage } from "./types.js";

export const MAX_TOOL_OUTPUT_CHARS = 16_000;
export const MAX_TOOL_ARGS_CHARS = 4_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keep the head and tail of oversized output; payloads stay bounded on the wire. */
export function boundText(text: string, max = MAX_TOOL_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor((max - 40) / 2);
  const omitted = text.length - half * 2;
  return { text: `${text.slice(0, half)}\n…[${omitted} chars omitted]…\n${text.slice(-half)}`, truncated: true };
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isObj(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Output of a "/" command that ran without a model turn, as that turn's answer.
 * Fenced, because it is terminal text (padded columns, bars) that markdown would reflow.
 */
export function commandOutputEvents(output: string): HarnessEvent[] {
  // Terminal colours and hyperlinks (CSI and OSC sequences) would show as junk in a browser.
  const plain = output.replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
  const text = plain.trim() || "(no output)";
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [{ type: "assistant_start" }, { type: "assistant_end", text: `${fence}text\n${text}\n${fence}`, thinking: "" }];
}

/** pi-ai's per-message `usage` (Pi and omp share it). */
function stepUsage(raw: unknown): StepUsage | null {
  if (!isObj(raw)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage = { input: n(raw.input), output: n(raw.output), cacheRead: n(raw.cacheRead), cacheWrite: n(raw.cacheWrite) };
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? usage : null;
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => isObj(b) && b.type === "image").length;
}

export function stringifyArgs(args: unknown): string {
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args, null, 2) ?? "";
  } catch {
    text = String(args);
  }
  return boundText(text, MAX_TOOL_ARGS_CHARS).text;
}

/** Coarse tool kind, used for per-turn counts ("3 reads, 2 edits") and changed files. */
export function toolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  if (/web|fetch|browse|url|http/.test(n)) return "web";
  if (/(^|_)(edit|ast_edit|apply_patch|patch|multi_?edit|str_replace|replace)($|_)/.test(n)) return "edit";
  if (/(^|_)(write|create|new_file|save)($|_)/.test(n)) return "write";
  if (/grep|glob|find|search|(^|_)ls($|_)|list|lsp/.test(n)) return "search";
  if (/(^|_)(read|view|cat|open)($|_)/.test(n)) return "read";
  if (/bash|shell|exec|run|eval|terminal|command|python|ssh/.test(n)) return "command";
  return "other";
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target", "notebook_path"];

/** File paths named in tool arguments, as given (absolute or relative). */
export function toolPaths(args: unknown): string[] {
  if (!isObj(args)) return [];
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v && v.length < 1024) out.push(v);
  }
  for (const key of ["paths", "files", "edits"]) {
    const v = args[key];
    if (!Array.isArray(v)) continue;
    for (const entry of v.slice(0, 50)) {
      if (typeof entry === "string" && entry.length < 1024) out.push(entry);
      else if (isObj(entry)) {
        const p = entry.path ?? entry.file_path ?? entry.file;
        if (typeof p === "string" && p.length < 1024) out.push(p);
      }
    }
  }
  return [...new Set(out)];
}

/** One-line description of a call: its path, command, or query. */
export function toolSummary(args: unknown): string {
  if (typeof args === "string") return args.replace(/\s+/g, " ").slice(0, 160);
  if (!isObj(args)) return "";
  const paths = toolPaths(args);
  for (const key of ["command", "cmd", "script", "code"]) {
    if (typeof args[key] === "string") return (args[key] as string).replace(/\s+/g, " ").trim().slice(0, 160);
  }
  if (paths.length > 0) return paths.length > 1 ? `${paths[0]} +${paths.length - 1}` : (paths[0] as string);
  for (const key of ["pattern", "query", "url", "glob", "regex", "q", "prompt", "description"]) {
    if (typeof args[key] === "string") return (args[key] as string).replace(/\s+/g, " ").trim().slice(0, 160);
  }
  try {
    return JSON.stringify(args).slice(0, 160);
  } catch {
    return "";
  }
}

/** Tool results are `{ content: [...] }` in both harnesses; fall back to JSON. */
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (isObj(result) && "content" in result) {
    const text = textOf(result.content);
    if (text) return text;
    const images = imageCount(result.content);
    if (images) return `[${images} image${images === 1 ? "" : "s"}]`;
    return "";
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function assistantParts(message: Obj): { text: string; thinking: string } {
  const content = Array.isArray(message.content) ? message.content : [];
  const text: string[] = [];
  const thinking: string[] = [];
  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string" && block.redacted !== true) {
      thinking.push(block.thinking);
    }
  }
  return { text: text.join("\n"), thinking: thinking.join("\n") };
}

function assistantError(message: Obj): string | undefined {
  if (message.stopReason === "error") {
    return typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "Request failed";
  }
  if (message.stopReason === "aborted") return "Stopped";
  return undefined;
}

/**
 * Translate one Pi-family session event. `settledType` differs by harness:
 * Pi emits `agent_settled`, omp emits `session_settled`.
 */
export function normalizeAgentEvent(event: unknown, settledType: string): HarnessEvent[] {
  if (!isObj(event) || typeof event.type !== "string") return [];
  switch (event.type) {
    case "agent_start":
      return [{ type: "busy" }];
    case "message_start": {
      const message = event.message;
      if (!isObj(message)) return [];
      if (message.role === "user") {
        return [{ type: "user_message", text: textOf(message.content), imageCount: imageCount(message.content) }];
      }
      if (message.role === "assistant") {
        return [{ type: "assistant_start", ...(typeof message.model === "string" ? { model: message.model } : {}) }];
      }
      if (message.role === "custom" && message.display === true) {
        const text = textOf(message.content);
        return text ? [{ type: "notice", level: "info", text }] : [];
      }
      return [];
    }
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (!isObj(ame) || typeof ame.delta !== "string" || !ame.delta) return [];
      if (ame.type === "text_delta") return [{ type: "assistant_delta", field: "text", delta: ame.delta }];
      if (ame.type === "thinking_delta") return [{ type: "assistant_delta", field: "thinking", delta: ame.delta }];
      return [];
    }
    case "message_end": {
      const message = event.message;
      if (!isObj(message) || message.role !== "assistant") return [];
      const { text, thinking } = assistantParts(message);
      const error = assistantError(message);
      const usage = stepUsage(message.usage);
      return [{ type: "assistant_end", text, thinking, ...(error ? { error } : {}), ...(usage ? { usage } : {}) }];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool_start",
          toolCallId: String(event.toolCallId),
          name: String(event.toolName ?? "tool"),
          args: event.args,
        },
      ];
    case "tool_execution_update":
      return [{ type: "tool_update", toolCallId: String(event.toolCallId), output: toolResultText(event.partialResult) }];
    case "tool_execution_end":
      return [
        {
          type: "tool_end",
          toolCallId: String(event.toolCallId),
          output: toolResultText(event.result),
          isError: event.isError === true,
        },
      ];
    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering.map(String) : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp.map(String) : [];
      return [{ type: "queue", queue: { steering, followUp } }];
    }
    case "compaction_start":
      return [{ type: "compacting", active: true }];
    case "compaction_end": {
      const out: HarnessEvent[] = [{ type: "compacting", active: false }];
      if (typeof event.errorMessage === "string" && event.errorMessage) {
        out.push({ type: "notice", level: "error", text: `Compaction failed: ${event.errorMessage}` });
      } else if (event.aborted === true) {
        out.push({ type: "notice", level: "warning", text: "Compaction cancelled" });
      } else {
        const reason = event.reason === "manual" ? "Compacted conversation" : "Compacted conversation automatically";
        out.push({ type: "notice", level: "info", text: reason });
      }
      return out;
    }
    case "auto_retry_start": {
      const seconds = typeof event.delayMs === "number" ? Math.round(event.delayMs / 1000) : 0;
      const text = `Retrying (attempt ${String(event.attempt)}/${String(event.maxAttempts)}) in ${seconds}s: ${String(
        event.errorMessage ?? "error",
      )}`;
      return [{ type: "notice", level: "warning", text }];
    }
    case "auto_retry_end":
      return event.success === false
        ? [{ type: "notice", level: "error", text: `Retries exhausted: ${String(event.finalError ?? "error")}` }]
        : [];
    case "session_info_changed":
      return typeof event.name === "string" && event.name ? [{ type: "title", title: event.name }] : [];
    case "thinking_level_changed":
      return typeof event.level === "string" ? [{ type: "config", config: { thinkingLevel: event.level } }] : [];
    default:
      if (event.type === settledType) return [{ type: "settled" }];
      return [];
  }
}

/** Rebuild display items from the active branch's message list. */
export function historyToItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ToolItem>();
  let n = 0;
  const nextId = (prefix: string) => `h${prefix}${n++}`;
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    const at = typeof raw.timestamp === "number" ? raw.timestamp : undefined;
    const stamp = at !== undefined ? { at } : {};
    switch (raw.role) {
      case "user": {
        const count = imageCount(raw.content);
        items.push({
          kind: "user",
          id: nextId("u"),
          text: textOf(raw.content),
          ...(count ? { imageCount: count } : {}),
          ...stamp,
        });
        break;
      }
      case "assistant": {
        const { text, thinking } = assistantParts(raw);
        const error = assistantError(raw);
        if (text || thinking || error) {
          items.push({
            kind: "assistant",
            id: nextId("a"),
            text,
            thinking,
            streaming: false,
            ...(error ? { error } : {}),
            ...(typeof raw.model === "string" ? { model: raw.model } : {}),
            ...stamp,
          });
        }
        const content = Array.isArray(raw.content) ? raw.content : [];
        for (const block of content) {
          if (!isObj(block) || block.type !== "toolCall") continue;
          const id = String(block.id);
          const name = String(block.name ?? "tool");
          const tool: ToolItem = {
            kind: "tool",
            id: `t:${id}`,
            name,
            args: stringifyArgs(block.arguments),
            status: "running",
            output: "",
            truncated: false,
            category: toolCategory(name),
            summary: toolSummary(block.arguments),
            paths: toolPaths(block.arguments),
            ...stamp,
          };
          tools.set(id, tool);
          items.push(tool);
        }
        break;
      }
      case "toolResult": {
        const tool = tools.get(String(raw.toolCallId));
        const bounded = boundText(toolResultText(raw));
        if (tool) {
          tool.output = bounded.text;
          tool.truncated = bounded.truncated;
          tool.status = raw.isError === true ? "error" : "done";
          if (at !== undefined) tool.endedAt = at;
        }
        break;
      }
      case "compactionSummary":
        items.push({ kind: "notice", id: nextId("n"), level: "info", text: "Earlier conversation was compacted", ...stamp });
        break;
      case "branchSummary":
        items.push({ kind: "notice", id: nextId("n"), level: "info", text: "Returned from another branch (summarized)" });
        break;
      case "custom":
        if (raw.display === true) {
          const text = textOf(raw.content);
          if (text) items.push({ kind: "notice", id: nextId("n"), level: "info", text });
        }
        break;
      default:
        break;
    }
  }
  // A tool call without a result in a settled transcript was interrupted.
  for (const tool of tools.values()) if (tool.status === "running") tool.status = "error";
  return items;
}
