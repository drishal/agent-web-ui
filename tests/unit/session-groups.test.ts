import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { dateBucket, groupByProject } from "../../src/web/session-groups.js";

const ws = (id: string): WorkspaceInfo => ({ id, path: `/home/u/${id}`, name: id });
const s = (id: string, workspaceId: string, harness: string, updatedAt: string, title = id): ProjectSession => ({
  id,
  harnessId: asHarnessId(harness),
  title,
  updatedAt,
  workspaceId,
});

const overview: SessionsOverview = {
  workspaces: [ws("webui"), ws("dotfiles"), ws("notes")],
  sessions: [
    s("d1", "dotfiles", "omp", "2026-10-02T10:00:00Z", "Fix waybar"),
    s("w1", "webui", "pi", "2026-10-01T10:00:00Z", "Model picker"),
    s("d2", "dotfiles", "pi", "2026-09-20T10:00:00Z", "Stylix theme"),
  ],
  errors: [],
};

describe("groupByProject", () => {
  it("puts the current project first, then projects by their newest session", () => {
    const groups = groupByProject(overview, { currentId: "webui", harnessId: "pi", scope: "all", query: "" });
    expect(groups.map((g) => [g.workspace.name, g.current, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", true, ["w1"]],
      ["dotfiles", false, ["d1", "d2"]],
    ]);
  });

  it("filters by harness and by search, dropping empty projects but keeping the current one", () => {
    const pi = groupByProject(overview, { currentId: "notes", harnessId: "pi", scope: "harness", query: "" });
    expect(pi.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["notes", []],
      ["webui", ["w1"]],
      ["dotfiles", ["d2"]],
    ]);
    const search = groupByProject(overview, { currentId: "notes", harnessId: "pi", scope: "all", query: "  WAYBAR " });
    expect(search.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([["dotfiles", ["d1"]]]);
  });
});

describe("dateBucket", () => {
  const now = new Date(2026, 9, 2, 15, 0); // Fri 2 Oct 2026, local time
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();
  it("uses Today, Yesterday, Earlier this week, then month names", () => {
    expect(dateBucket(at(2026, 9, 2, 1), now)).toBe("Today");
    expect(dateBucket(at(2026, 9, 1), now)).toBe("Yesterday");
    expect(dateBucket(at(2026, 8, 27), now)).toBe("Earlier this week");
    expect(dateBucket(at(2026, 8, 14), now)).toBe("September");
    expect(dateBucket(at(2025, 7, 3), now)).toBe("August 2025");
    expect(dateBucket(null, now)).toBe("Older");
  });
});
