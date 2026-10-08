// What atui prints, worked out apart from the drawing so it can be tested:
// tool lines, the fold line, diffs in unified form for OpenTUI's <diff>,
// token counts, limits, and the status words.
import type { ChatStatus, LimitAccount, ToolDiff, ToolItem } from "../shared/protocol.js";
import { countSummary, formatDuration, relativePath, type Turn } from "../web/turns.js";

export const STATUS_LABEL: Record<ChatStatus, string> = {
  starting: "Starting",
  idle: "Idle",
  running: "Working",
  stopping: "Stopping",
  compacting: "Compacting",
  error: "Error",
  disposed: "Closed",
};

/** A tool call's one line: its target as the web UI shows it (paths relative to the project). */
export function toolTarget(item: ToolItem, workspace: string): string {
  if (item.subagents) {
    const n = item.subagents.runs.length;
    return `${n} ${n === 1 ? "agent" : "agents"}`;
  }
  return item.paths.length > 0 && item.summary === item.paths[0] ? relativePath(item.summary, workspace) : item.summary;
}

/** "Working · 12s · 2 reads" while live, "Worked for 1m 4s · 3 reads, 1 edit" after. */
export function foldLabel(turn: Turn, now = Date.now()): string {
  const counts = countSummary(turn.counts);
  const duration = turn.startedAt !== undefined ? formatDuration((turn.live ? now : (turn.endedAt ?? turn.startedAt)) - turn.startedAt) : null;
  const head = turn.live ? (duration ? `Working · ${duration}` : "Working") : duration ? `Worked for ${duration}` : "Worked";
  return counts ? `${head} · ${counts}` : head;
}

/**
 * A tool's diff as a unified diff for OpenTUI's <diff>. Each run between
 * folds becomes a hunk; its starts come from the first numbered line (the new
 * side for added and context lines, the old side for removed ones).
 */
export function unifiedDiff(file: string, diff: ToolDiff): string {
  const hunks: Array<typeof diff.lines> = [[]];
  for (const line of diff.lines) {
    if (line.kind === "gap" || line.kind === "hunk") {
      if ((hunks[hunks.length - 1] as typeof diff.lines).length > 0) hunks.push([]);
      continue;
    }
    (hunks[hunks.length - 1] as typeof diff.lines).push(line);
  }
  const out = [`--- a/${file}`, `+++ b/${file}`];
  for (const hunk of hunks) {
    if (hunk.length === 0) continue;
    const firstNew = hunk.find((l) => l.kind !== "del" && l.line !== undefined)?.line;
    const firstOld = hunk.find((l) => l.kind === "del" && l.line !== undefined)?.line;
    const oldCount = hunk.filter((l) => l.kind !== "add").length;
    const newCount = hunk.filter((l) => l.kind !== "del").length;
    const newStart = firstNew ?? firstOld ?? 1;
    const oldStart = firstOld ?? newStart;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of hunk) out.push(`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`);
  }
  return `${out.join("\n")}\n`;
}

/** 950, 12k, 1.2M. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const PROVIDERS: Record<string, string> = { anthropic: "Anthropic", "openai-codex": "ChatGPT", openai: "OpenAI", "google-gemini-cli": "Gemini", "github-copilot": "Copilot" };

/** "Claude 5h 15% · 7d 55%": an account's windows on one line. */
export function limitLine(a: LimitAccount): string {
  const name = a.source === "Claude Code" ? "Claude" : (PROVIDERS[a.provider] ?? a.provider);
  const windows = a.windows.map((w) => `${w.label.replace(" hours", "h").replace(" days", "d")} ${w.used === null ? "—" : `${Math.round(w.used * 100)}%`}`);
  return [name, ...windows].join(" · ") + (a.limited ? " · limited" : "");
}

/** A short line of text, cut with an ellipsis. */
export function clip(text: string, width: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}

/** "now", "12m", "3h", "5d", or the date: how long ago a session was active. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d` : new Date(iso).toLocaleDateString();
}
