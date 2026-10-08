import { describe, expect, it } from "vitest";
import { assignAccents } from "../../src/server/harness/registry.js";
import type { HarnessAdapter } from "../../src/server/harness/types.js";
import { HARNESS_ACCENTS } from "../../src/shared/protocol.js";

const adapter = (id: string, accent?: string) => ({ id, ...(accent ? { accent } : {}) }) as unknown as HarnessAdapter;

describe("harness accents", () => {
  it("keeps declared accents and gives the rest the colours nobody claimed", () => {
    const accents = assignAccents([adapter("pi", "link"), adapter("new"), adapter("omp", "thinking"), adapter("other"), adapter("odd", "not-a-token")]);
    expect(Object.fromEntries(accents)).toEqual({ pi: "link", omp: "thinking", new: "orange", other: "rare", odd: "info" });
  });

  it("cycles through the palette once every colour is taken", () => {
    const many = Array.from({ length: HARNESS_ACCENTS.length + 2 }, (_, i) => adapter(`h${i}`));
    const accents = [...assignAccents(many).values()];
    expect(accents.slice(0, HARNESS_ACCENTS.length)).toEqual([...HARNESS_ACCENTS]);
    expect(accents.slice(HARNESS_ACCENTS.length)).toEqual(["link", "thinking"]);
  });
});

describe("the rewind-to extension", async () => {
  const { rewindExtension, rewindWithExtension } = await import("../../src/server/harness/rewind-extension.js");
  it("is found next to the server, for Pi and omp to load with -e", () => {
    expect(rewindExtension()).toMatch(/extensions\/rewind-to\.ts$/);
  });
  it("refuses when the harness has not loaded it, and checks the session really went back", async () => {
    const user = (text: string) => ({ kind: "user" as const, id: text, text });
    const ran: string[] = [];
    const live = (commands: string[], after: number) => {
      let calls = 0;
      return {
        commandNames: async () => commands,
        runCommand: async (c: string) => (ran.push(c), true),
        history: async () => (calls++ === 0 ? [user("a"), user("b"), user("c")] : [user("a"), user("b"), user("c")].slice(0, after)),
      };
    };
    await expect(rewindWithExtension("Pi", 2, live([], 1))).rejects.toThrow(/has not loaded the rewind-to extension/);
    expect(ran).toEqual([]);
    await expect(rewindWithExtension("Pi", 9, live(["rewind-to"], 1))).rejects.toThrow(/no longer in the session/);
    await rewindWithExtension("Pi", 2, live(["rewind-to"], 1));
    expect(ran).toEqual(["/rewind-to 2"]);
    await expect(rewindWithExtension("Pi", 2, live(["rewind-to"], 3))).rejects.toThrow(/did not go back/);
  }, 10_000);
});
