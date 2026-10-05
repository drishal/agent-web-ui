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
