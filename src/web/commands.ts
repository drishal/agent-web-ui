// The composer's "/" menu: the app's own commands, then the harness's.
import type { SlashCommand } from "../shared/protocol.js";

/** Run by the app itself, the same for every harness. */
export const APP_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new chat in this project", source: "app" },
  { name: "compact", description: "Summarize the conversation to free up context", hint: "[focus]", source: "app" },
  { name: "rename", description: "Rename this chat", hint: "<title>", source: "app" },
];

/** App commands first; a harness command with the same name is left out, since the app runs that one. */
export function mergeCommands(harness: SlashCommand[]): SlashCommand[] {
  const taken = new Set(APP_COMMANDS.map((c) => c.name));
  const seen = new Set<string>();
  return [...APP_COMMANDS, ...harness.filter((c) => !taken.has(c.name) && !seen.has(c.name) && seen.add(c.name))];
}

/** Commands for what is typed after "/": name prefix, then name substring, then description. */
export function matchCommands(all: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return all;
  return all
    .map((c, i) => {
      const name = c.name.toLowerCase();
      const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : c.description?.toLowerCase().includes(q) ? 2 : -1;
      return { c, i, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.c);
}

/** "/compact keep the API notes" → { name: "compact", arg: "keep the API notes" } for an app command, else null. */
export function appCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m?.[1] || !APP_COMMANDS.some((c) => c.name === m[1])) return null;
  return { name: m[1], arg: (m[2] ?? "").trim() };
}
