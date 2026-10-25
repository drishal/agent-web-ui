// The routines timer's one decision, kept out of the wiring so it can be tested:
// which due routines to start now. Each is marked as run *before* it starts, so a
// start that throws (or a tick that overlaps) cannot run the same routine twice;
// the next slot is its retry. A failure does not stop the others.
import type { Routine } from "../shared/protocol.js";

/** The store's part of the timer: what is due, and marking one as run. */
export interface RoutineDue {
  due(now: number): Routine[];
  markRan(id: string, at: number): Promise<Routine | undefined>;
}

/** Starts every routine due at `now`; answers the ids it started. */
export async function startDue(
  store: RoutineDue,
  start: (routine: Routine) => Promise<void>,
  now = Date.now(),
  report: (routine: Routine, error: unknown) => void = () => undefined,
): Promise<string[]> {
  const started: string[] = [];
  for (const routine of store.due(now)) {
    // Claimed before the work: a throw must not leave it due for the next tick.
    const claimed = await store.markRan(routine.id, now);
    if (!claimed) continue;
    try {
      await start(routine);
      started.push(routine.id);
    } catch (error) {
      report(routine, error);
    }
  }
  return started;
}
