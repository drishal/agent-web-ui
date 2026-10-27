// One turn as Markdown for pasting into an issue or a PR: the prompt, the work in
// order (each tool call as one line, the agent's replies between them as plain
// paragraphs), and the answer. Unlike the whole-chat export (export.ts) it carries
// no diffs and no tool output, so it stays short; thinking is left out in both.
import type { ChatItem, ToolCategory, ToolItem } from "../shared/protocol.js";
import { relativePath, saysSomething, toolLabel, type Turn } from "./turns.js";

/** The most a copied turn holds: past it the end is cut, so a huge answer cannot fill the clipboard. */
export const TURN_MARKDOWN_MAX = 200_000;

/** The longest a call's target (a command, a path) runs in its line; commands can be whole scripts. */
const TARGET_MAX = 200;

const LABELS: Partial<Record<ToolCategory, string>> = { read: "Read", search: "Search", edit: "Edit", write: "Write", command: "Run", web: "Web", agent: "Agent" };

/** Inline code that a backtick in the text cannot close: the fence is one backtick longer than any run inside. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  // A fence's edge touching a backtick of the text needs a space to keep them apart.
  return text.startsWith("`") || text.endsWith("`") ? `${f} ${text} ${f}` : `${f}${text}${f}`;
}

/** One tool call as a list line: "- **Edit** `src/app.ts` (+12 −3)", a failed call marked. */
export function toolLine(tool: ToolItem, workspace: string): string {
  const label = LABELS[tool.category] ?? toolLabel(tool.name);
  let target = tool.summary.replace(/\s+/g, " ").trim();
  if (tool.category !== "command") target = relativePath(target, workspace);
  if (target.length > TARGET_MAX) target = `${target.slice(0, TARGET_MAX - 1)}…`;
  const stat = tool.category === "edit" || tool.category === "write" ? (tool.diffStat ?? tool.diff) : undefined;
  const lines = stat && stat.added + stat.removed > 0 ? ` (+${stat.added} −${stat.removed})` : "";
  const state = tool.status === "error" ? " (failed)" : tool.status === "running" ? " (still running)" : "";
  return `- **${label}**${target ? ` ${inlineCode(target)}` : ""}${lines}${state}`;
}

/** The work and replies of a stretch of the turn, in order: tool lines grouped into one list, a reply as its own paragraph. */
function workBlocks(items: ChatItem[], workspace: string): string[] {
  const blocks: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length > 0) blocks.push(list.join("\n"));
    list = [];
  };
  for (const item of items) {
    if (item.kind === "tool") list.push(toolLine(item, workspace));
    else if (item.kind === "assistant" && saysSomething(item.text)) {
      flush();
      blocks.push(item.text.trim());
    }
  }
  flush();
  return blocks;
}

/** A turn as Markdown: `## Prompt`, `## Work` (when it ran or said anything before the answer), `## Answer`. */
export function turnMarkdown(turn: Turn, workspace: string): string {
  const out: string[] = [];
  if (turn.prompt) {
    out.push("## Prompt", turn.prompt.text);
    const images = turn.prompt.imageCount ?? turn.prompt.images?.length ?? 0;
    if (images > 0) out.push(`_${images} ${images === 1 ? "image" : "images"} attached_`);
  }
  const work = workBlocks(turn.process, workspace);
  if (work.length > 0) out.push("## Work", ...work);
  for (const e of turn.errors) out.push(`> **Error:** ${e.text}`);
  if (turn.answer?.text) out.push("## Answer", turn.answer.text);
  // What the agent did after writing its reply keeps its place after it.
  const after = workBlocks(turn.workAfter, workspace);
  if (after.length > 0) out.push("## Work after the answer", ...after);
  let text = `${out.join("\n\n").trimEnd()}\n`;
  if (text.length > TURN_MARKDOWN_MAX) {
    // Cut between code units, but never inside a surrogate pair.
    let end = TURN_MARKDOWN_MAX;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    text = `${text.slice(0, end)}\n\n_(cut: this turn is longer than ${TURN_MARKDOWN_MAX / 1000} KB)_\n`;
  }
  return text;
}
