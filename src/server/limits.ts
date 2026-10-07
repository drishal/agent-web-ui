// The subscription limits the sidebar shows: what Claude Code said on its
// latest run (kept across restarts) and what omp reports for every signed-in
// account (asked at most once a minute, since omp asks each provider).
import path from "node:path";
import type { LimitAccount, UsageLimits } from "../shared/protocol.js";
import { errorMessage } from "./chats/chat.js";
import type { HarnessRegistry } from "./harness/registry.js";
import { isObj, readJson, writeJson } from "./state-file.js";

const POLL_MS = 60_000;

export class Limits {
  private reported = new Map<string, LimitAccount>();
  private polled: { at: number; accounts: LimitAccount[]; errors: string[] } | null = null;
  private polling: Promise<void> | null = null;

  private constructor(
    private readonly registry: HarnessRegistry,
    private readonly file: string | null,
  ) {}

  static inMemory(registry: HarnessRegistry): Limits {
    return new Limits(registry, null);
  }

  static async open(registry: HarnessRegistry, stateDir: string): Promise<Limits> {
    const limits = new Limits(registry, path.join(stateDir, "limits.json"));
    const raw = await readJson(limits.file);
    if (Array.isArray(raw)) for (const a of raw) if (isObj(a) && typeof a.id === "string" && Array.isArray(a.windows)) limits.reported.set(a.id, a as unknown as LimitAccount);
    return limits;
  }

  /** A harness heard its limits during a run. */
  report(account: LimitAccount): void {
    this.reported.set(account.id, account);
    void writeJson(this.file, [...this.reported.values()]);
  }

  async get(): Promise<UsageLimits> {
    if (!this.polled || Date.now() - this.polled.at > POLL_MS) await this.poll();
    const polled = this.polled ?? { accounts: [], errors: [] };
    return { accounts: [...this.reported.values(), ...polled.accounts], errors: polled.errors };
  }

  private poll(): Promise<void> {
    this.polling ??= (async () => {
      const accounts: LimitAccount[] = [];
      const errors: string[] = [];
      await Promise.all(
        this.registry.list().map(async (adapter) => {
          if (!adapter.usageLimits || !this.registry.isAvailable(adapter.id)) return;
          try {
            accounts.push(...(await adapter.usageLimits()));
          } catch (error) {
            errors.push(`${adapter.displayName}: ${errorMessage(error).split("\n")[0]}`);
          }
        }),
      );
      this.polled = { at: Date.now(), accounts, errors };
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }
}
