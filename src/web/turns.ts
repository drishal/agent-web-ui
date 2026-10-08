// Groups the flat item list into turns: the user's prompt, the work the agent
// did (folded into one "Worked for …" line), and the final answer. Pattern
// from DeepSeek Harness (process fold) with OpenCode-style tool counts.
import type { AssistantItem, ChatItem, ChatStatus, NoticeItem, ToolCategory, UserItem } from "../shared/protocol.js";

export interface Turn {
  id: string;
  index: number;
  /** 1-based ordinal of stored user turns (what the server's fork `through` counts); 0 for a preamble or a command the harness answered itself. */
  through: number;
  prompt: UserItem | null;
  /** Everything before the answer: thinking, intermediate text, tools, notices, requests. */
  process: ChatItem[];
  answer: AssistantItem | null;
  /** Error notices stay visible under the answer instead of inside the fold. */
  errors: NoticeItem[];
  /** Notices that arrived while the agent was idle, shown after the turn. */
  after: NoticeItem[];
  live: boolean;
  startedAt?: number;
  endedAt?: number;
  counts: Partial<Record<ToolCategory, number>>;
  changedFiles: string[];
  /** The model that answered (its last model call), when the harness says. */
  model?: string;
}

export function buildTurns(items: ChatItem[], status: ChatStatus): Turn[] {
  const groups: ChatItem[][] = [];
  let current: ChatItem[] = [];
  for (const item of items) {
    if (item.kind === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);

  const busy = status === "running" || status === "stopping" || status === "compacting";
  let userTurns = 0;
  return groups.map((group, index) => {
    const prompt = group[0]?.kind === "user" ? group[0] : null;
    const through = prompt && !prompt.command ? ++userTurns : 0;
    const rest = prompt ? group.slice(1) : group;
    const live = busy && index === groups.length - 1;

    // The answer is the last assistant message with text, unless work follows it.
    let answerIndex = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      const item = rest[i] as ChatItem;
      if (item.kind === "tool" || item.kind === "request") break;
      if (item.kind === "assistant" && (item.text.trim() || item.error)) {
        answerIndex = i;
        break;
      }
    }
    const answer = answerIndex >= 0 ? (rest[answerIndex] as AssistantItem) : null;
    const process: ChatItem[] = [];
    const errors: NoticeItem[] = [];
    const after: NoticeItem[] = [];
    rest.forEach((item, i) => {
      if (i === answerIndex) return;
      if (item.kind === "notice" && item.ambient) after.push(item);
      else if (item.kind === "notice" && item.level === "error") errors.push(item);
      else process.push(item);
    });

    let model: string | undefined;
    for (const item of rest) if (item.kind === "assistant" && item.model) model = item.model;
    const counts: Partial<Record<ToolCategory, number>> = {};
    const changed = new Set<string>();
    let startedAt = prompt?.at;
    let endedAt: number | undefined;
    for (const item of rest) {
      if (item.kind === "tool") {
        counts[item.category] = (counts[item.category] ?? 0) + 1;
        if ((item.category === "edit" || item.category === "write") && item.status !== "error") {
          for (const p of item.paths) changed.add(p);
        }
      }
      // Timing comes from the agent's own work, never from notices.
      if (item.kind === "notice") continue;
      const a = "at" in item ? item.at : undefined;
      const e = "endedAt" in item ? item.endedAt : undefined;
      if (startedAt === undefined && a !== undefined) startedAt = a;
      for (const t of [a, e]) if (t !== undefined && (endedAt === undefined || t > endedAt)) endedAt = t;
    }
    return {
      id: prompt?.id ?? `pre-${group[0]?.id ?? index}`,
      index,
      through,
      prompt,
      process,
      answer,
      errors,
      after,
      live,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      counts,
      changedFiles: [...changed],
      ...(model ? { model } : {}),
    };
  });
}

const COUNT_LABELS: Array<[ToolCategory, string, string]> = [
  ["read", "read", "reads"],
  ["search", "search", "searches"],
  ["edit", "edit", "edits"],
  ["write", "file written", "files written"],
  ["command", "command", "commands"],
  ["web", "web lookup", "web lookups"],
  ["agent", "delegation", "delegations"],
  ["other", "tool call", "tool calls"],
];

export function countSummary(counts: Turn["counts"]): string {
  const parts: string[] = [];
  for (const [key, one, many] of COUNT_LABELS) {
    const n = counts[key] ?? 0;
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(", ");
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Show workspace-relative paths when the file is inside the project. */
export function relativePath(path: string, workspace: string): string {
  const base = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** "3m ago", "2h ago", "4d ago", else the date. */
export function ago(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}

/** Where the model changes between turns: turn id → the model it switched to. Turns that name no model are skipped over. */
export function modelSwitches(turns: Turn[]): Map<string, string> {
  const switches = new Map<string, string>();
  let last: string | undefined;
  for (const turn of turns) {
    if (!turn.model) continue;
    if (last !== undefined && turn.model !== last) switches.set(turn.id, turn.model);
    last = turn.model;
  }
  return switches;
}

/** A model's display name from the chat's list (by key or id), else what the harness called it. */
export function modelName(model: string, models: ReadonlyArray<{ key: string; id: string; name: string }>): string {
  return models.find((m) => m.key === model || m.id === model)?.name ?? model;
}

/** Text worth a row in the fold: some letter or digit, not a stray "." or blank lines a model sent between tool calls. */
export const saysSomething = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

