// Which transcript items arrived while the chat was on screen, so only those
// animate in. A chat opened, switched to, or loaded from its file shows at
// once: a render that brings many new items at a time is a load, not a run.
import { createContext, useContext, useState } from "react";

/** More new items than this in one render is a load (a resume, a tab switch), not live output. */
const BULK = 4;
/**
 * How long an item stays new after it arrived: a turn's parts mount over a few renders
 * (the answer takes its place once the turn settles), so "new in this render" alone missed them.
 */
const FRESH_MS = 1500;

export class Arrivals {
  private chat: string | null = null;
  private known = new Set<string>();
  private fresh = new Map<string, number>();
  private seen: readonly { id: string }[] | null = null;

  /** Called while rendering the transcript, before its items mount; the same list again (a repeat render) changes nothing. */
  update(chat: string, items: readonly { id: string }[], now = Date.now()): void {
    if (items === this.seen && chat === this.chat) return;
    this.seen = items;
    const ids = items.map((item) => item.id);
    if (chat !== this.chat) {
      this.chat = chat;
      this.known = new Set(ids);
      this.fresh = new Map();
      return;
    }
    const added = ids.filter((id) => !this.known.has(id));
    for (const [id, at] of this.fresh) if (now - at >= FRESH_MS) this.fresh.delete(id);
    if (added.length > BULK) this.fresh.clear();
    else for (const id of added) this.fresh.set(id, now);
    for (const id of added) this.known.add(id);
  }

  isFresh(id: string, now = Date.now()): boolean {
    const at = this.fresh.get(id);
    return at !== undefined && now - at < FRESH_MS;
  }
}

export const ArrivalsContext = createContext<Arrivals | null>(null);

/** " is-arriving" for an item that came in live, fixed at mount so re-renders never replay it. */
export function useArrival(id: string): string {
  const arrivals = useContext(ArrivalsContext);
  const [arriving] = useState(() => arrivals?.isFresh(id) ?? false);
  return arriving ? " is-arriving" : "";
}
