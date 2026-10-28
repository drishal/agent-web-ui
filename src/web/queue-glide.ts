// A queued message's way into the conversation. The status stack tells this
// module where a queued row was when it ran (it left the queue without being
// edited or removed); the prompt that appears for it claims that spot and
// glides from there (FLIP, with the Web Animations API, so every browser that
// has it glides: no view-transition names, which would need both ends to be
// named in one DOM update, and these two arrive in separate server events).
// Either end may come first, so a landing waits for its prompt and a prompt
// for its landing, each a couple of seconds at most. Pure apart from the timers.

export interface Spot {
  left: number;
  top: number;
}

/** How long one end waits for the other. */
const WAIT_MS = 2500;

const landings = new Map<string, { spot: Spot; at: number }>();
const waiters = new Map<string, { run: (spot: Spot) => void; at: number }>();

const keyOf = (text: string) => text.trim();

/** A queued message left the queue by running: remember where its row was. */
export function announceLanding(text: string, spot: Spot, now = Date.now()): void {
  const key = keyOf(text);
  const waiting = waiters.get(key);
  if (waiting && now - waiting.at < WAIT_MS) {
    waiters.delete(key);
    waiting.run(spot);
    return;
  }
  landings.set(key, { spot, at: now });
}

/**
 * A prompt that just arrived asks for the spot of the queued message with its text; `run` is called
 * with it now or as soon as the queue row's departure is announced. Returns a function that cancels the wait.
 */
export function claimLanding(text: string, run: (spot: Spot) => void, now = Date.now()): () => void {
  const key = keyOf(text);
  for (const [k, v] of landings) if (now - v.at >= WAIT_MS) landings.delete(k);
  const found = landings.get(key);
  if (found) {
    landings.delete(key);
    run(found.spot);
    return () => {};
  }
  const mine = { run, at: now };
  waiters.set(key, mine);
  return () => {
    if (waiters.get(key) === mine) waiters.delete(key);
  };
}

/** The translation that puts the prompt back where its queue row was; null when it would not move. */
export function glideOffset(from: Spot, to: Spot): { dx: number; dy: number } | null {
  const dx = Math.round(from.left - to.left);
  const dy = Math.round(from.top - to.top);
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

/** Which texts left the queue, from the last render's to this one's, minus the ones the user took out. */
export function ranFromQueue(before: readonly string[], after: readonly string[], taken: ReadonlySet<string>): string[] {
  const left = [...after];
  const gone: string[] = [];
  for (const text of before) {
    const at = left.indexOf(text);
    if (at >= 0) left.splice(at, 1);
    else if (!taken.has(text)) gone.push(text);
  }
  return gone;
}
