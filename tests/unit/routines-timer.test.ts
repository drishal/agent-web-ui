// The routines timer's decision (routines-timer.ts): start each due routine once.
import { describe, expect, it } from "vitest";
import type { Routine } from "../../src/shared/protocol.js";
import { type RoutineDue, startDue } from "../../src/server/routines-timer.js";

const routine = (id: string, nextRunAt: number, enabled = true): Routine => ({
  id,
  name: id,
  prompt: "go",
  harnessId: "pi",
  workspaceId: "w",
  cadence: { kind: "daily", hour: 9, minute: 0 },
  enabled,
  nextRunAt,
  lastRunAt: null,
});

/** A store that remembers the marks, so a second tick sees what the first did. */
function fakeStore(routines: Routine[]): RoutineDue & { marks: Array<[string, number]> } {
  const marks: Array<[string, number]> = [];
  return {
    marks,
    due: (now: number) => routines.filter((r) => r.enabled && r.nextRunAt <= now),
    markRan: async (id: string, at: number) => {
      marks.push([id, at]);
      const found = routines.find((r) => r.id === id);
      if (!found) return undefined;
      found.nextRunAt = at + 86_400_000;
      found.lastRunAt = at;
      return found;
    },
  };
}

describe("the routines timer", () => {
  it("starts every routine that is due, in one pass", async () => {
    const store = fakeStore([routine("a", 100), routine("b", 100), routine("later", 10_000)]);
    const started: string[] = [];
    expect(await startDue(store, async (r) => void started.push(r.id), 500)).toEqual(["a", "b"]);
    expect(started).toEqual(["a", "b"]);
    expect(store.marks).toEqual([
      ["a", 500],
      ["b", 500],
    ]);
    // A second tick at the same time starts nothing: they were claimed.
    expect(await startDue(store, async (r) => void started.push(r.id), 500)).toEqual([]);
  });

  it("claims one whose start throws, tells the reporter, and goes on", async () => {
    const store = fakeStore([routine("bad", 100), routine("good", 100)]);
    const started: string[] = [];
    const reported: string[] = [];
    const ids = await startDue(
      store,
      async (r) => {
        if (r.id === "bad") throw new Error("no model");
        started.push(r.id);
      },
      500,
      (r) => void reported.push(r.id),
    );
    expect(ids).toEqual(["good"]);
    expect(started).toEqual(["good"]);
    expect(reported).toEqual(["bad"]);
    // Claimed, so it does not spin on the next tick; its next slot is the retry.
    expect(await startDue(store, async (r) => void started.push(r.id), 500)).toEqual([]);
  });

  it("never starts a disabled routine", async () => {
    const store = fakeStore([routine("off", 100, false), routine("on", 100)]);
    expect(await startDue(store, async () => undefined, 500)).toEqual(["on"]);
  });
});
