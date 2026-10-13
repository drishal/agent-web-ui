// A run that stopped on a usage limit (T3 Code's recovery banner): the turn's
// error or short answer says so, and the reset comes from the message itself
// (Claude Code's "…|<epoch>" or "resets 5pm") or, failing that, from the limits
// the harness reports for its account. The composer shows when it resets and
// can send "continue" then.
import type { ChatItem, ChatStatus, UsageLimits } from "../shared/protocol.js";

const LIMIT_TEXT = /usage limit|rate[ -]?limit|limit reached|hit your limit|out of (?:credits|quota)|quota exceeded|too many requests|\b429\b|resource[_ ]exhausted/i;
/** What goes when it resets: the harness carries on from the cut. */
export const CONTINUE_TEXT = "Continue from where you stopped.";

export interface LimitStop {
  /** The item that said so: a dismissal or a scheduled continue belongs to it. */
  id: string;
  /** Epoch ms, when known. */
  resetsAt: number | null;
}

/** "resets 5pm", "resets at 17:30", "resets 9:15 am" as the next such time after `now`. */
export function resetFromText(text: string, now: number): number | null {
  const epoch = /\|(\d{10,13})\b/.exec(text);
  if (epoch?.[1]) return epoch[1].length === 10 ? Number(epoch[1]) * 1000 : Number(epoch[1]);
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m?.[1]) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const half = m[3]?.toLowerCase();
  if (!half && !m[2]) return null;
  if (half === "pm" && hour < 12) hour += 12;
  if (half === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** The latest reset among this harness's full windows, when its account says it is limited. */
function resetFromLimits(limits: UsageLimits | null, source: string, now: number): number | null {
  let best: number | null = null;
  for (const account of limits?.accounts ?? []) {
    if (account.source !== source) continue;
    for (const w of account.windows) {
      const full = account.limited ? (w.used ?? 1) >= 0.99 : (w.used ?? 0) >= 0.99;
      if (full && w.resetsAt !== null && w.resetsAt > now && (best === null || w.resetsAt > best)) best = w.resetsAt;
    }
  }
  return best;
}

/** The last turn's limit stop, if it ended on one. `source` is the harness's name as limits report it. */
export function limitStop(items: readonly ChatItem[], status: ChatStatus, limits: UsageLimits | null, source: string, now = Date.now()): LimitStop | null {
  if (status !== "idle" && status !== "error") return null;
  let start = items.length;
  while (start > 0 && items[start - 1]?.kind !== "user") start--;
  for (let i = items.length - 1; i >= start; i--) {
    const item = items[i];
    let text = "";
    if (item?.kind === "assistant") text = item.error ?? (item.text.length < 400 ? item.text : "");
    else if (item?.kind === "notice" && item.level !== "info") text = item.text;
    if (!item || !text || !LIMIT_TEXT.test(text)) continue;
    return { id: item.id, resetsAt: resetFromText(text, now) ?? resetFromLimits(limits, source, now) };
  }
  return null;
}
