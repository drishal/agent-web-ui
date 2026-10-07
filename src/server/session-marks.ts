// Pinned and archived sessions: marks this server keeps for every device, in
// its own state file. The harness's session files are never touched.
import path from "node:path";
import { isObj, readJson, writeJson } from "./state-file.js";

export interface SessionMark {
  pinned?: true;
  archived?: true;
}

export class SessionMarks {
  private readonly marks = new Map<string, SessionMark>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): SessionMarks {
    return new SessionMarks(null);
  }

  static async open(stateDir: string): Promise<SessionMarks> {
    const store = new SessionMarks(path.join(stateDir, "session-marks.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      for (const [id, m] of Object.entries(raw)) {
        if (!isObj(m)) continue;
        const mark: SessionMark = { ...(m.pinned === true ? { pinned: true } : {}), ...(m.archived === true ? { archived: true } : {}) };
        if (mark.pinned || mark.archived) store.marks.set(id, mark);
      }
    }
    return store;
  }

  get(sessionId: string): SessionMark | undefined {
    return this.marks.get(sessionId);
  }

  /** Pinning unarchives and archiving unpins: a session is in one place in the list. */
  set(sessionId: string, change: { pinned?: boolean; archived?: boolean }): Promise<SessionMark> {
    const next: SessionMark = { ...this.marks.get(sessionId) };
    if (change.pinned !== undefined) {
      if (change.pinned) {
        next.pinned = true;
        delete next.archived;
      } else delete next.pinned;
    }
    if (change.archived !== undefined) {
      if (change.archived) {
        next.archived = true;
        delete next.pinned;
      } else delete next.archived;
    }
    if (next.pinned || next.archived) this.marks.set(sessionId, next);
    else this.marks.delete(sessionId);
    return writeJson(this.file, Object.fromEntries(this.marks)).then(() => next);
  }
}
