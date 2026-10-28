// What kinds of tools a run used, for the card header's icon stack: one chip per
// kind in first-use order, an MCP server counting as a kind of its own, "+N" for
// the rest. Also the monogram and hue an MCP server's chip wears. Pure.
import type { ChatItem, ToolCategory } from "../shared/protocol.js";

export interface ToolKind {
  /** Distinct per kind: the category, or `mcp:<server>`. */
  key: string;
  category: ToolCategory;
  /** The MCP server, for a monogram chip. */
  server?: string;
}

/** The distinct kinds of tool the items called, in the order each was first used. */
export function toolKinds(items: readonly ChatItem[]): ToolKind[] {
  const seen = new Map<string, ToolKind>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const server = /^mcp__(.+?)__/.exec(item.name)?.[1];
    const key = server ? `mcp:${server}` : item.category;
    if (!seen.has(key)) seen.set(key, { key, category: item.category, ...(server ? { server } : {}) });
  }
  return [...seen.values()];
}

/** The chips to draw (at most `max`) and how many kinds are left out. */
export function iconStack(kinds: readonly ToolKind[], max = 3): { shown: ToolKind[]; more: number } {
  return { shown: kinds.slice(0, max), more: Math.max(0, kinds.length - max) };
}

/** An MCP server's chip letters: the first letter, or the first of each of the first two words ("GH" for "git-hub"). */
export function monogram(server: string): string {
  const words = server.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0]?.[0] ?? server[0] ?? "?");
  return letters.toUpperCase();
}

/** A stable hue slot (0 to 3) for a server name; the stylesheet maps each slot onto theme tokens. */
export function serverHue(server: string): number {
  let h = 0;
  for (const ch of server) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4;
}

/** "Used 1 tool", "Used 6 tools". */
export function usedLabel(n: number): string {
  return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
}
