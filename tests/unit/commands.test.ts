import { describe, expect, it } from "vitest";
import type { SlashCommand } from "../../src/shared/protocol.js";
import { appCommand, isSkill, matchCommands, mergeCommands, skillMenu, skillName, slashMenu } from "../../src/web/commands.js";

const harness: SlashCommand[] = [
  { name: "review", description: "Review the work so far", source: "skill" },
  { name: "compact", description: "omp's own compact", source: "builtin" },
  { name: "usage", description: "Show token usage and cost", source: "builtin" },
  { name: "retry", description: "Retry the last message", source: "builtin" },
];

describe("the / menu", () => {
  it("puts the app's commands first and hides a harness command the app runs itself", () => {
    const names = mergeCommands(harness).map((c) => `${c.source}:${c.name}`);
    expect(names).toEqual(["app:new", "app:compact", "app:rename", "skill:review", "builtin:usage", "builtin:retry"]);
  });

  it("ranks a name prefix, then a name substring, then a description match", () => {
    const all = mergeCommands(harness);
    // compact matches only by its description ("free up context"), so it comes last.
    expect(matchCommands(all, "re").map((c) => c.name)).toEqual(["rename", "review", "retry", "compact"]);
    // "sag": inside the name usage, but only in retry's description ("message").
    expect(matchCommands(all, "sag").map((c) => c.name)).toEqual(["usage", "retry"]);
    expect(matchCommands(all, "token").map((c) => c.name)).toEqual(["usage"]);
    expect(matchCommands(all, "")).toHaveLength(all.length);
    expect(matchCommands(all, "zzz")).toEqual([]);
  });

  it("leaves skills to the $ menu, unless the / query asks for them", () => {
    const all = mergeCommands([
      ...harness,
      { name: "skill:tidy", description: "Tidy the imports", source: "skill" },
      { name: "skill:release-notes", description: "Write release notes", source: "extension" },
    ]);
    expect(all.filter(isSkill).map(skillName)).toEqual(["review", "tidy", "release-notes"]);
    expect(slashMenu(all, "").some(isSkill)).toBe(false);
    expect(slashMenu(all, "skill:t").map((c) => c.name)).toEqual(["skill:tidy"]);
    // "$" matches the short name first, then words in the description.
    expect(skillMenu(all, "").map(skillName)).toEqual(["review", "tidy", "release-notes"]);
    expect(skillMenu(all, "re").map(skillName)).toEqual(["review", "release-notes"]);
    expect(skillMenu(all, "imports").map((c) => c.name)).toEqual(["skill:tidy"]);
    expect(skillMenu(harness.filter((c) => !isSkill(c)), "")).toEqual([]);
  });

  it("recognises the app's own commands, with their argument", () => {
    expect(appCommand("/new")).toEqual({ name: "new", arg: "" });
    expect(appCommand("  /compact keep the API notes ")).toEqual({ name: "compact", arg: "keep the API notes" });
    expect(appCommand("/rename A better title")).toEqual({ name: "rename", arg: "A better title" });
    expect(appCommand("/review the tests")).toBeNull();
    expect(appCommand("new chat please")).toBeNull();
  });
});

describe("command output", () => {
  it("drops terminal colours and links, and fences the text so markdown leaves it alone", async () => {
    const { commandOutputEvents } = await import("../../src/server/harness/agent-events.js");
    const raw = "Context window: 1000 tokens\n  Skills [\u001b[1m\u001b[38;5;179m░\u001b[22m\u001b[39m] 1%  52 tokens\n\u001b]8;;https://x.y\u0007link\u001b]8;;\u0007 with ``` inside";
    const events = commandOutputEvents("/context", raw);
    expect(events[0]).toEqual({ type: "user_message", text: "/context", command: true });
    const end = events[2] as { text: string };
    expect(end.text).toBe("````text\nContext window: 1000 tokens\n  Skills [░] 1%  52 tokens\nlink with ``` inside\n````");
    expect((commandOutputEvents("/x", "  ")[2] as { text: string }).text).toBe("```text\n(no output)\n```");
  });
});
