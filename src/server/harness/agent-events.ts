// Normalization for Pi-family agent events and transcript messages. omp is a
// Pi fork and emits the same shapes over RPC, so both adapters share this.
// Inputs are untyped on purpose: SDK and wire types never leave the adapters.
import type { ChatItem, ToolItem } from "../../shared/protocol.js";
import type { HarnessEvent } from "./types.js";

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
      return [{ type: "assistant_end", text, thinking, ...(error ? { error } : {}) }];
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
    switch (raw.role) {
      case "user": {
        const count = imageCount(raw.content);
        items.push({
          kind: "user",
          id: nextId("u"),
          text: textOf(raw.content),
          ...(count ? { imageCount: count } : {}),
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
          });
        }
        const content = Array.isArray(raw.content) ? raw.content : [];
        for (const block of content) {
          if (!isObj(block) || block.type !== "toolCall") continue;
          const id = String(block.id);
          const tool: ToolItem = {
            kind: "tool",
            id: `t:${id}`,
            name: String(block.name ?? "tool"),
            args: stringifyArgs(block.arguments),
            status: "running",
            output: "",
            truncated: false,
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
        }
        break;
      }
      case "compactionSummary":
        items.push({ kind: "notice", id: nextId("n"), level: "info", text: "Earlier conversation was compacted" });
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
