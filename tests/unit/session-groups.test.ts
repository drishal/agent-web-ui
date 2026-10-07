import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { archivedCount, dateBucket, groupByProject, pinnedSessions } from "../../src/web/session-groups.js";

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
    const groups = groupByProject(overview, { currentId: "webui", query: "", harnessId: "pi" });
    expect(groups.map((g) => [g.workspace.name, g.current, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", true, ["w1"]],
      ["dotfiles", false, ["d2"]],
    ]);
  });

  it("scopes the list to the selected harness, and a search stays inside it", () => {
    const omp = groupByProject(overview, { currentId: "notes", query: "", harnessId: "omp" });
    expect(omp.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["notes", []],
      ["dotfiles", ["d1"]],
    ]);
    // A pi session does not show up while omp is selected, even by exact title.
    const search = groupByProject(overview, { currentId: "notes", query: "  WAYBAR ", harnessId: "pi" });
    expect(search.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([]);
    const own = groupByProject(overview, { currentId: "notes", query: "stylix", harnessId: "pi" });
    expect(own.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([["dotfiles", ["d2"]]]);
  });

  it("drops projects a search leaves empty, and keeps the empty current project otherwise", () => {
    const all = groupByProject(overview, { currentId: "notes", query: "", harnessId: "pi" });
    expect(all.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["notes", []],
      ["webui", ["w1"]],
      ["dotfiles", ["d2"]],
    ]);
    const search = groupByProject(overview, { currentId: "notes", query: "model picker", harnessId: "pi" });
    expect(search.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([["webui", ["w1"]]]);
  });
});

describe("pinned and archived sessions", () => {
  const marked: SessionsOverview = {
    ...overview,
    sessions: [
      { ...s("p1", "dotfiles", "pi", "2026-10-03T10:00:00Z", "Pinned one"), pinned: true },
      { ...s("a1", "webui", "pi", "2026-10-02T10:00:00Z", "Old idea"), archived: true },
      ...overview.sessions,
    ],
  };
  const opts = { currentId: "webui", query: "", harnessId: "pi" };

  it("lifts pinned sessions out of their projects and leaves archived ones out", () => {
    expect(pinnedSessions(marked, opts).map((x) => x.id)).toEqual(["p1"]);
    expect(groupByProject(marked, opts).map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", ["w1"]],
      ["dotfiles", ["d2"]],
    ]);
    expect(archivedCount(marked, "pi")).toBe(1);
    expect(archivedCount(marked, "omp")).toBe(0);
  });

  it("shows archived sessions in place on request", () => {
    const groups = groupByProject(marked, { ...opts, showArchived: true });
    expect(groups.map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", ["a1", "w1"]],
      ["dotfiles", ["d2"]],
    ]);
  });

  it("finds pinned and archived sessions where they live while searching", () => {
    expect(pinnedSessions(marked, { ...opts, query: "pinned" })).toEqual([]);
    expect(groupByProject(marked, { ...opts, query: "o" }).map((g) => [g.workspace.name, g.sessions.map((x) => x.id)])).toEqual([
      ["webui", ["a1", "w1"]],
      ["dotfiles", ["p1"]],
    ]);
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
