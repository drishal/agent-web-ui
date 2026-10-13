// Terminal-style prompt recall in the composer (T3 Code's): ↑ in an empty
// composer walks back through this chat's sent prompts, ↓ walks forward and,
// past the newest, empties the box again. The list comes from the chat's own
// prompts on each key, so there is nothing to store or sync. Typing into a
// recalled prompt makes it a draft: the walk ends there.
import type { ChatItem } from "../shared/protocol.js";

/** This chat's prompts, newest first, a prompt sent twice in a row once. */
export function sentPrompts(items: readonly ChatItem[]): string[] {
  const out: string[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "user") continue;
    const text = item.text.trim();
    if (text && out[out.length - 1] !== text) out.push(text);
  }
  return out;
}

/** The recalled prompt on show: its place in sentPrompts and its text as recalled. */
export interface Recall {
  index: number;
  text: string;
}

/**
 * What ↑ or ↓ does to the composer, or null to leave the key to the textarea
 * (moving the caret through a prompt of several lines, or a draft being typed).
 */
export function recallStep(prompts: readonly string[], recall: Recall | null, key: "up" | "down", value: string, caret: number): { recall: Recall | null; text: string } | null {
  const walking = recall !== null && value === recall.text;
  if (!walking && value !== "") return null;
  // Inside a recalled prompt of several lines, the arrows move the caret until it reaches the edge.
  if (key === "up" && value.slice(0, caret).includes("\n")) return null;
  if (key === "down" && value.slice(caret).includes("\n")) return null;
  const at = walking ? recall.index : -1;
  if (key === "up") {
    const next = at + 1;
    const text = prompts[next];
    return text === undefined ? null : { recall: { index: next, text }, text };
  }
  if (!walking) return null;
  const next = at - 1;
  if (next < 0) return { recall: null, text: "" };
  const text = prompts[next] as string;
  return { recall: { index: next, text }, text };
}
