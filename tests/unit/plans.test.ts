// Proposed plans (harness/plans.ts): a plan call's plan onto its tool item, live and from history.
import { describe, expect, it } from "vitest";
import { planFromArgs } from "../../src/server/harness/plans.js";
import { historyToItems } from "../../src/server/harness/agent-events.js";

describe("proposed plans", () => {
  it("takes the plan from a plan call's arguments, live and from history, and nothing from other calls", () => {
    expect(planFromArgs("ExitPlanMode", { plan: "  1. Do it  " })).toBe("1. Do it");
    expect(planFromArgs("plan_mode_complete", { plan: "## Plan" })).toBe("## Plan");
    expect(planFromArgs("bash", { plan: "x" })).toBeNull();
    expect(planFromArgs("ExitPlanMode", {})).toBeNull();
    expect(planFromArgs("ExitPlanMode", { plan: "x".repeat(40_000) })?.length).toBeLessThan(33_000);
    const items = historyToItems([
      { role: "user", content: "plan it" },
      { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "ExitPlanMode", arguments: { plan: "1. Read\n2. Write" } }], stopReason: "toolUse" },
    ]);
    const tool = items.find((i) => i.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.plan : null).toBe("1. Read\n2. Write");
  });
});
