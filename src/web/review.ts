// The review panel's model: every edit and write in the chat, by file in the
// order they were first touched, and comments on their diff lines that go
// back to the agent as one prompt (OpenCode's review tab).
import type { ChatItem, DiffLine, ToolItem } from "../shared/protocol.js";
import { buildTurns, relativePath } from "./turns.js";

export interface FileEdit {
  tool: ToolItem;
  /** The turn's ordinal, as the fork counts them. */
  turn: number;
}

export interface FileChanges {
  path: string;
  edits: FileEdit[];
  added: number;
  removed: number;
}

export interface ReviewComment {
  /** `toolId:lineIndex`: the diff line it is on. */
  key: string;
  path: string;
  line: DiffLine;
  text: string;
}

export const commentKey = (toolId: string, index: number): string => `${toolId}:${index}`;

export function collectChanges(items: ChatItem[], workspace: string): FileChanges[] {
  const turnOf = new Map<string, number>();
  for (const turn of buildTurns(items, "idle")) for (const item of turn.process) turnOf.set(item.id, turn.through);
  const files = new Map<string, FileChanges>();
  for (const item of items) {
    if (item.kind !== "tool" || (item.category !== "edit" && item.category !== "write") || item.status !== "done" || !item.diff) continue;
    const path = relativePath(item.paths[0] ?? item.summary, workspace);
    const file = files.get(path) ?? { path, edits: [], added: 0, removed: 0 };
    file.edits.push({ tool: item, turn: turnOf.get(item.id) ?? 0 });
    file.added += item.diff.added;
    file.removed += item.diff.removed;
    files.set(path, file);
  }
  return [...files.values()];
}

/** A line can take a comment when it is real code: not a hunk header or a fold. */
export const commentable = (line: DiffLine): boolean => line.kind === "add" || line.kind === "del" || line.kind === "ctx";

function where(c: ReviewComment): string {
  if (c.line.line === undefined) return c.path;
  return c.line.kind === "del" ? `${c.path} (removed line ${c.line.line})` : `${c.path}:${c.line.line}`;
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " ", hunk: "", gap: "" };

/** The prompt the comments become: each one under the line it is on, in file order. */
export function reviewPrompt(comments: ReviewComment[]): string {
  const parts = comments.map((c) => `${where(c)}\n    ${SIGN[c.line.kind]} ${c.line.text.trim()}\n${c.text.trim()}`);
  return `Review comments on your changes:\n\n${parts.join("\n\n")}`;
}
