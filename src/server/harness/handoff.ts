// Cross-harness handoff: a portable transcript seed built from normalized
// ChatItems, written into a fresh session by each adapter's seedChat. Only the
// build side lives here; the write side is per-adapter (file shape differs).
import type { ChatItem, TodoItem } from "../../shared/protocol.js";
import { boundText } from "./agent-events.js";

/** One tool call collapsed to a record: never live state, never an id remap. */
export interface HandoffTool {
  name: string;
  summary: string;
  output: string;
}

export interface HandoffTurn {
  prompt: { text: string };
  answer: { text: string; thinking?: string } | null;
  tools: HandoffTool[];
}

export interface HandoffSeed {
  title: string | null;
  todos: TodoItem[];
  turns: HandoffTurn[];
  /** The dropped middle (first prompt + recent N stay verbatim); it follows the first turn. */
  summary: string | null;
}

/** One line of the seed in transcript order; each adapter writes these in its own shape. */
export type SeedEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; thinking?: string }
  | ({ role: "tool" } & HandoffTool);

/** Verbatim turns kept at the tail; older turns collapse into `summary`. */
const RECENT_TURNS = 10;

/** Group items into user-prompted turns (same grouping the UI builds turns from). */
function groupTurns(items: ChatItem[]): HandoffTurn[] {
  const turns: HandoffTurn[] = [];
  let current: HandoffTurn | null = null;
  for (const item of items) {
    if (item.kind === "user") {
      // Image bytes are not kept in chat items, so the prompt says what is missing.
      const images = item.imageCount ? `\n[${item.imageCount} image${item.imageCount === 1 ? "" : "s"} not carried over]` : "";
      current = { prompt: { text: `${item.text}${images}` }, answer: null, tools: [] };
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
export function toSeed(items: ChatItem[], opts: { title?: string | null; todos?: TodoItem[]; throughTurns?: number } = {}): HandoffSeed {
  let turns = groupTurns(items);
  if (opts.throughTurns !== undefined) turns = turns.slice(0, opts.throughTurns);
  let summary: string | null = null;
  if (turns.length > RECENT_TURNS + 1) {
    const dropped = turns.slice(1, turns.length - RECENT_TURNS);
    const lines = dropped.map((t) => `- User: ${t.prompt.text.slice(0, 200)}${t.answer ? ` → ${t.answer.text.slice(0, 200)}` : ""}`);
    summary = `Earlier in this conversation (continued from another harness):\n${lines.join("\n")}`;
    turns = [turns[0] as HandoffTurn, ...turns.slice(turns.length - RECENT_TURNS)];
  }
  return { title: opts.title ?? null, todos: opts.todos ?? [], turns, summary };
}

/** The seed in reading order: first turn, the summary of what was dropped, then the recent turns. */
export function seedTranscript(seed: HandoffSeed): SeedEntry[] {
  const out: SeedEntry[] = [];
  seed.turns.forEach((turn, i) => {
    out.push({ role: "user", text: turn.prompt.text });
    for (const tool of turn.tools) out.push({ role: "tool", ...tool });
    if (turn.answer && (turn.answer.text || turn.answer.thinking)) {
      out.push({ role: "assistant", text: turn.answer.text, ...(turn.answer.thinking ? { thinking: turn.answer.thinking } : {}) });
    }
    if (i === 0 && seed.summary) out.push({ role: "assistant", text: seed.summary });
  });
  return out;
}

/** Plain-text form of a tool record, for harnesses that cannot store a foreign tool call. */
export function toolRecordText(tool: HandoffTool): string {
  return `[Handed off from another harness] ${tool.name}: ${tool.summary}\n${tool.output}`;
}

/** Seed has no turns worth opening a session for. */
export function isEmptySeed(seed: HandoffSeed): boolean {
  return seed.turns.length === 0;
}
