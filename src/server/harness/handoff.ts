// Cross-harness handoff: a portable transcript seed built from normalized
// ChatItems, written into a fresh session by each adapter's seedChat. Only the
// build side lives here; the write side is per-adapter (file shape differs).
import type { ChatItem, ImageAttachment, TodoItem } from "../../shared/protocol.js";
import { boundText } from "./agent-events.js";

/** One tool call collapsed to a record: never live state, never an id remap. */
export interface HandoffTool {
  name: string;
  summary: string;
  output: string;
}

export interface HandoffTurn {
  prompt: { text: string; images?: ImageAttachment[] };
  answer: { text: string; thinking?: string } | null;
  tools: HandoffTool[];
}

export interface HandoffSeed {
  title: string | null;
  todos: TodoItem[];
  turns: HandoffTurn[];
  /** Collapsed middle (first prompt + recent N verbatim); inserted as the first assistant record. */
  summary: string | null;
  /** Composer draft at handoff time: the target's first turn after the transcript. */
  prompt: string | null;
}

/** Verbatim turns kept at the tail; older turns collapse into `summary`. */
const RECENT_TURNS = 10;

interface BuiltTurn {
  prompt: { text: string };
  answer: { text: string; thinking?: string } | null;
  tools: HandoffTool[];
}

/** Group items into user-prompted turns (same grouping the UI builds turns from). */
function groupTurns(items: ChatItem[]): BuiltTurn[] {
  const turns: BuiltTurn[] = [];
  let current: BuiltTurn | null = null;
  for (const item of items) {
    if (item.kind === "user") {
      current = { prompt: { text: item.text }, answer: null, tools: [] };
      turns.push(current);
    } else if (item.kind === "assistant" && current) {
      const thinking = item.thinking ? { thinking: item.thinking } : {};
      current.answer = { text: item.text, ...thinking };
    } else if (item.kind === "tool" && current) {
      current.tools.push({
        name: item.name,
        summary: item.summary || item.name,
        output: boundText(item.output).text,
      });
    }
    // Notices/requests are live UI state, not transcript: dropped by construction.
  }
  return turns.filter((t) => t.prompt.text);
}

/**
 * Portable seed from a source chat's items: title, todos, first prompt plus
 * the most recent turns verbatim, the middle collapsed into one summary line
 * per dropped turn. Pure; unit-tested with historyToItems fixtures.
 */
export function toSeed(
  items: ChatItem[],
  opts: { title?: string | null; todos?: TodoItem[]; throughTurns?: number; prompt?: string | null } = {},
): HandoffSeed {
  let turns = groupTurns(items);
  if (opts.throughTurns !== undefined) turns = turns.slice(0, opts.throughTurns);
  let summary: string | null = null;
  if (turns.length > RECENT_TURNS + 1) {
    const dropped = turns.slice(1, turns.length - RECENT_TURNS);
    const lines = dropped.map((t) => `- User: ${t.prompt.text.slice(0, 200)}${t.answer ? ` → ${t.answer.text.slice(0, 200)}` : ""}`);
    summary = `Earlier in this conversation (continued from another harness):\n${lines.join("\n")}`;
    turns = [turns[0] as BuiltTurn, ...turns.slice(turns.length - RECENT_TURNS)];
  }
  return {
    title: opts.title ?? null,
    todos: opts.todos ?? [],
    turns: turns.map((t) => ({ prompt: t.prompt, answer: t.answer, tools: t.tools })),
    summary,
    prompt: opts.prompt?.trim() ? (opts.prompt as string) : null,
  };
}

/** Seed has nothing worth opening a session for (no turns, no draft). */
export function isEmptySeed(seed: HandoffSeed): boolean {
  return seed.turns.length === 0 && !seed.prompt;
}
