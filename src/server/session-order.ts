// Hand-made session orders: where the sidebar's drag (or Move up/down) put a
// project's sessions, for one harness, kept by this server for every device in
// its own state file. Only the order inside a date group follows it; which
// group a session is in is always its last activity. Bounded: a project keeps
// its 500 first ids, and the 300 projects arranged most recently.
import path from "node:path";
import { isObj, readJson, writeJson } from "./state-file.js";

const MAX_IDS = 500;
const MAX_KEYS = 300;

export class SessionOrder {
  /** Insertion order is recency: a key set again moves to the end. */
  private readonly orders = new Map<string, string[]>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): SessionOrder {
    return new SessionOrder(null);
  }

  static async open(stateDir: string): Promise<SessionOrder> {
    const store = new SessionOrder(path.join(stateDir, "session-order.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      for (const [key, ids] of Object.entries(raw)) {
        if (Array.isArray(ids)) store.orders.set(key, clean(ids));
      }
    }
    return store;
  }

  all(): Record<string, string[]> {
    return Object.fromEntries(this.orders);
  }

  async set(harnessId: string, workspaceId: string, ids: string[]): Promise<string[]> {
    const key = `${harnessId}:${workspaceId}`;
    const order = clean(ids);
    this.orders.delete(key);
    if (order.length > 0) this.orders.set(key, order);
    while (this.orders.size > MAX_KEYS) {
      const oldest = this.orders.keys().next().value;
      if (oldest === undefined) break;
      this.orders.delete(oldest);
    }
    await writeJson(this.file, this.all());
    return order;
  }
}

function clean(ids: unknown[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) if (typeof id === "string" && id && id.length <= 512) seen.add(id);
  return [...seen].slice(0, MAX_IDS);
}
