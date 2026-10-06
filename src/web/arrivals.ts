// Which transcript items arrived while the chat was on screen, so only those
// animate in. A chat opened, switched to, or loaded from its file shows at
// once: a render that brings many new items at a time is a load, not a run.
import { createContext, useContext, useState } from "react";

/** More new items than this in one render is a load (a resume, a tab switch), not live output. */
const BULK = 4;

export class Arrivals {
  private chat: string | null = null;
  private known = new Set<string>();
  private fresh = new Set<string>();
  private seen: readonly { id: string }[] | null = null;

  /** Called while rendering the transcript, before its items mount; the same list again (a repeat render) changes nothing. */
  update(chat: string, items: readonly { id: string }[]): void {
    if (items === this.seen && chat === this.chat) return;
    this.seen = items;
    const ids = items.map((item) => item.id);
    if (chat !== this.chat) {
      this.chat = chat;
      this.known = new Set(ids);
      this.fresh = new Set();
      return;
    }
    const added = ids.filter((id) => !this.known.has(id));
    this.fresh = added.length > BULK ? new Set() : new Set(added);
    for (const id of added) this.known.add(id);
  }

  isFresh(id: string): boolean {
    return this.fresh.has(id);
  }
}

export const ArrivalsContext = createContext<Arrivals | null>(null);

/** " is-arriving" for an item that came in live, fixed at mount so re-renders never replay it. */
export function useArrival(id: string): string {
  const arrivals = useContext(ArrivalsContext);
  const [arriving] = useState(() => arrivals?.isFresh(id) ?? false);
  return arriving ? " is-arriving" : "";
}
