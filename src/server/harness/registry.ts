// Adding a harness = one adapter file + one entry in `factories`.
import { asHarnessId, type HarnessId, type HarnessStatus } from "../../shared/protocol.js";
import type { ServerConfig } from "../config.js";
import { FakeAdapter } from "./fake.js";
import { OmpAdapter } from "./omp.js";
import { PiAdapter } from "./pi.js";
import type { HarnessAdapter } from "./types.js";

const factories: Record<string, (config: ServerConfig) => HarnessAdapter> = {
  pi: () => new PiAdapter(),
  omp: (config) => new OmpAdapter({ agentDir: config.ompAgentDir, sessionDir: config.ompSessionDir, home: config.home }),
  // Test-only adapters, selected with AWUI_HARNESSES=fake,fake-b.
  fake: () => new FakeAdapter(),
  "fake-b": () => new FakeAdapter({ id: "fake-b", displayName: "Fake B", capabilities: { supportsSteer: false } }),
};

export class HarnessRegistry {
  private adapters = new Map<HarnessId, HarnessAdapter>();
  private statuses = new Map<HarnessId, HarnessStatus>();

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  static fromConfig(config: ServerConfig): HarnessRegistry {
    const registry = new HarnessRegistry();
    for (const name of config.harnesses) {
      const factory = factories[name];
      if (!factory) throw new Error(`Unknown harness in AWUI_HARNESSES: ${name}`);
      registry.register(factory(config));
    }
    return registry;
  }

  list(): HarnessAdapter[] {
    return [...this.adapters.values()];
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(asHarnessId(id));
  }

  async refreshStatus(): Promise<HarnessStatus[]> {
    await Promise.all(
      this.list().map(async (adapter) => {
        const d = await adapter.discover().catch((error: unknown) => ({
          available: false,
          reason: `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          warnings: [],
          overrides: {},
        }));
        this.statuses.set(adapter.id, {
          id: adapter.id,
          displayName: adapter.displayName,
          available: d.available,
          ...("version" in d && d.version ? { version: d.version } : {}),
          ...(d.reason ? { reason: d.reason } : {}),
          warnings: d.warnings,
          capabilities: adapter.capabilities,
          overrides: d.overrides,
        });
      }),
    );
    return this.status();
  }

  status(): HarnessStatus[] {
    return this.list()
      .map((a) => this.statuses.get(a.id))
      .filter((s): s is HarnessStatus => s !== undefined);
  }

  isAvailable(id: string): boolean {
    return this.statuses.get(asHarnessId(id))?.available === true;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.list().map((a) => a.shutdown()));
  }
}
