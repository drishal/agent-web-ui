// The routines this server keeps: a prompt on a cadence, in a project, on a
// harness, in $XDG_STATE_HOME/awui/routines.json. nextRunAt is stored rather than
// derived on read, because the timer asks what is due now; saving, editing, and
// running a routine recompute it from shared/routine-schedule.ts.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { type Routine, type RoutineInput, routineSchema } from "../shared/protocol.js";
import { nextRunAt } from "../shared/routine-schedule.js";
import { isObj, readJson, writeJson } from "./state-file.js";

export const MAX_ROUTINES = 50;

/** A stored routine, kept only when it still validates (a hand-edited file loses nothing else). */
function clean(raw: unknown): Routine | null {
  if (!isObj(raw)) return null;
  const parsed = routineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { id, nextRunAt: at, lastRunAt } = raw as { id?: unknown; nextRunAt?: unknown; lastRunAt?: unknown };
  if (typeof id !== "string" || !id) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (lastRunAt !== null && typeof lastRunAt !== "number") return null;
  return { ...parsed.data, id, nextRunAt: at, lastRunAt: (lastRunAt as number | null) ?? null };
}

export class Routines {
  private readonly byId = new Map<string, Routine>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): Routines {
    return new Routines(null);
  }

  static async open(stateDir: string): Promise<Routines> {
    const store = new Routines(path.join(stateDir, "routines.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      for (const value of Object.values(raw)) {
        const routine = clean(value);
        if (routine) store.byId.set(routine.id, routine);
      }
    }
    return store;
  }

  /** The soonest first, so the timer can stop at the first one not yet due. */
  all(): Routine[] {
    return [...this.byId.values()].sort((a, b) => a.nextRunAt - b.nextRunAt || a.name.localeCompare(b.name));
  }

  get(id: string): Routine | undefined {
    return this.byId.get(id);
  }

  /** Create or replace one; a new routine gets an id and its first run time. */
  async save(input: RoutineInput, now = Date.now()): Promise<Routine> {
    // Parsed here as well as at the route: this is the last stop before disk, and
    // the schema is what supplies `enabled` and refuses a cadence that cannot run.
    const parsed = routineSchema.parse(input);
    const existing = parsed.id === undefined ? undefined : this.byId.get(parsed.id);
    if (!existing && this.byId.size >= MAX_ROUTINES) throw new Error(`At most ${MAX_ROUTINES} routines`);
    const routine: Routine = {
      ...parsed,
      id: existing?.id ?? randomUUID(),
      nextRunAt: nextRunAt(parsed.cadence, now),
      lastRunAt: existing?.lastRunAt ?? null,
    };
    this.byId.set(routine.id, routine);
    await this.persist();
    return routine;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.byId.delete(id)) return false;
    await this.persist();
    return true;
  }

  /** A routine that just ran counts the time and moves to its next slot. */
  async markRan(id: string, at = Date.now()): Promise<Routine | undefined> {
    const routine = this.byId.get(id);
    if (!routine) return undefined;
    const next: Routine = { ...routine, lastRunAt: at, nextRunAt: nextRunAt(routine.cadence, at) };
    this.byId.set(id, next);
    await this.persist();
    return next;
  }

  /** What the timer should start now: enabled, and its slot has come. */
  due(now = Date.now()): Routine[] {
    return this.all().filter((routine) => routine.enabled && routine.nextRunAt <= now);
  }

  private persist(): Promise<void> {
    return writeJson(this.file, Object.fromEntries(this.byId));
  }
}
