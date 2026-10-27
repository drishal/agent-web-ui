import { describe, expect, it } from "vitest";
import type { ProjectSession, SessionsOverview } from "../../src/shared/protocol.js";
import { asHarnessId } from "../../src/shared/protocol.js";
import { applyQuick, asQuickFilter, chipsShown, escapeClears, matchesQuick, quickCounts } from "../../src/web/sidebar-filter.js";

// Noon, local time: midnight is 12 hours behind it whatever the zone.
const now = new Date(2026, 9, 27, 12, 0, 0).getTime();
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const s = (id: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  harnessId: asHarnessId("pi"),
  title: id,
  updatedAt: at(1),
  workspaceId: "w",
  ...extra,
});

const overview: SessionsOverview = {
  workspaces: [{ id: "w", path: "/w", name: "w" }],
  sessions: [
    s("run", { liveChatId: "c1", status: "running" }),
    s("ask", { liveChatId: "c2", status: "idle", asking: true, updatedAt: at(30) }),
    s("old", { updatedAt: at(100) }),
    s("undated", { updatedAt: null }),
    s("other", { harnessId: asHarnessId("omp"), liveChatId: "c3", status: "running" }),
    s("done", { settled: true, updatedAt: at(2) }),
    s("gone", { archived: true, updatedAt: at(2) }),
  ],
  errors: [],
};
const opts = { currentId: null, query: "", harnessId: "pi", now };

describe("matchesQuick", () => {
  it("runs on the chat's status, or on what the caller knows of it", () => {
    expect(matchesQuick(s("a", { status: "running" }), "running", now)).toBe(true);
    expect(matchesQuick(s("a", { status: "compacting" }), "running", now)).toBe(true);
    expect(matchesQuick(s("a", { status: "idle" }), "running", now)).toBe(false);
    expect(matchesQuick(s("a", { status: "idle" }), "running", now, () => true)).toBe(true);
  });

  it("needs you is a live chat asking, as the title's count has it", () => {
    expect(matchesQuick(s("a", { asking: true, liveChatId: "c" }), "needs", now)).toBe(true);
    expect(matchesQuick(s("a", { asking: true }), "needs", now)).toBe(false);
    expect(matchesQuick(s("a", { liveChatId: "c" }), "needs", now)).toBe(false);
  });

  it("today is last activity since local midnight", () => {
    expect(matchesQuick(s("a", { updatedAt: at(11) }), "today", now)).toBe(true);
    expect(matchesQuick(s("a", { updatedAt: at(13) }), "today", now)).toBe(false);
    expect(matchesQuick(s("a", { updatedAt: null }), "today", now)).toBe(false);
  });
});

describe("quickCounts", () => {
  it("counts the selected harness's listed sessions: not another harness's, archived, or settled ones", () => {
    expect(quickCounts(overview, opts)).toEqual({ running: 1, needs: 1, today: 1 });
  });

  it("does not move with the text search", () => {
    expect(quickCounts(overview, { ...opts, query: "nothing like it" })).toEqual({ running: 1, needs: 1, today: 1 });
  });
});

describe("applyQuick", () => {
  it("is the same overview with no filter", () => {
    expect(applyQuick(overview, null, now)).toBe(overview);
  });

  it("keeps only the sessions that pass, and everything else of the overview", () => {
    const out = applyQuick(overview, "needs", now);
    expect(out.sessions.map((x) => x.id)).toEqual(["ask"]);
    expect(out.workspaces).toBe(overview.workspaces);
    expect(applyQuick(overview, "running", now).sessions.map((x) => x.id)).toEqual(["run", "other"]);
  });
});

describe("chipsShown", () => {
  it("hides Running and Needs you at zero, keeps Today, and keeps the one that is on", () => {
    expect(chipsShown({ running: 0, needs: 0, today: 0 }, null)).toEqual(["today"]);
    expect(chipsShown({ running: 2, needs: 0, today: 3 }, null)).toEqual(["running", "today"]);
    expect(chipsShown({ running: 0, needs: 0, today: 0 }, "needs")).toEqual(["needs", "today"]);
  });
});

describe("escapeClears", () => {
  it("clears the search, then the filter", () => {
    expect(escapeClears("x", "today")).toBe("query");
    expect(escapeClears("", "today")).toBe("filter");
    expect(escapeClears("", null)).toBeNull();
  });
});

describe("asQuickFilter", () => {
  it("reads only the chips' names", () => {
    expect(asQuickFilter("needs")).toBe("needs");
    expect(asQuickFilter("everything")).toBeNull();
    expect(asQuickFilter(3)).toBeNull();
  });
});
