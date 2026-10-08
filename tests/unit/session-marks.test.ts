import { describe, expect, it } from "vitest";
import { SessionMarks } from "../../src/server/session-marks.js";
import { asHarnessId, type ProjectSession, type SessionsOverview } from "../../src/shared/protocol.js";
import { groupByProject, placeOf, sidebarSections, snoozeOptions } from "../../src/web/session-groups.js";

describe("session marks", () => {
  it("keeps a session in one place: pin, archive, settle, and snooze each clear the others", async () => {
    const m = SessionMarks.inMemory();
    expect(await m.set("s", { pinned: true })).toEqual({ pinned: true });
    expect(await m.set("s", { settled: true })).toEqual({ settled: true });
    expect(await m.set("s", { snoozedUntil: 5000 })).toEqual({ snoozedUntil: 5000 });
    expect(await m.set("s", { archived: true })).toEqual({ archived: true });
    expect(await m.set("s", { pinned: true, replace: true })).toEqual({ pinned: true });
    expect(await m.set("s", { replace: true })).toEqual({});
    expect(m.get("s")).toBeUndefined();
  });

  it("wakes a settled or snoozed session, and leaves pins alone", async () => {
    const m = SessionMarks.inMemory();
    await m.set("a", { settled: true });
    await m.set("b", { snoozedUntil: 9e12 });
    await m.set("c", { pinned: true });
    for (const id of ["a", "b", "c"]) m.wake(id);
    await new Promise((r) => setTimeout(r, 5));
    expect([m.get("a"), m.get("b"), m.get("c")]).toEqual([undefined, undefined, { pinned: true }]);
  });
});

describe("the sidebar's places", () => {
  const s = (id: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({ id, harnessId: asHarnessId("pi"), title: id, updatedAt: "2026-10-08T10:00:00Z", workspaceId: "w", ...extra });
  const now = 1_000_000;
  const overview: SessionsOverview = {
    workspaces: [{ id: "w", path: "/w", name: "w" }],
    sessions: [
      s("asks", { liveChatId: "c1", status: "running", asking: true }),
      s("busy", { liveChatId: "c2", status: "running" }),
      s("open", { liveChatId: "c3", status: "running" }),
      s("pin", { pinned: true }),
      s("done", { settled: true }),
      s("later", { snoozedUntil: now + 1 }),
      s("woke", { snoozedUntil: now - 1 }),
      s("old", { archived: true }),
      s("plain"),
    ],
    errors: [],
  };
  const opts = { currentId: "w", query: "", harnessId: "pi", now, isActive: (x: ProjectSession) => x.id === "open" };

  it("puts what needs you and what works above the pins, and keeps the open chat in its project", () => {
    expect(overview.sessions.map((x) => placeOf(x, opts))).toEqual(["needs", "working", "project", "pinned", "settled", "snoozed", "project", "archived", "project"]);
    const sections = sidebarSections(overview, opts);
    expect([sections.needs, sections.working, sections.pinned].map((l) => l.map((x) => x.id))).toEqual([["asks"], ["busy"], ["pin"]]);
    expect(sections.counts).toEqual({ snoozed: 1, settled: 1, archived: 1 });
    expect(groupByProject(overview, opts)[0]?.sessions.map((x) => x.id)).toEqual(["open", "woke", "plain"]);
    expect(groupByProject(overview, { ...opts, showSettled: true, showSnoozed: true })[0]?.sessions.map((x) => x.id)).toEqual(["open", "done", "later", "woke", "plain"]);
  });

  it("offers an hour, tomorrow at 9, and next Monday at 9", () => {
    const friday = new Date(2026, 9, 9, 15, 30).getTime();
    const [hour, tomorrow, week] = snoozeOptions(friday);
    expect(hour?.until).toBe(friday + 3_600_000);
    expect(new Date(tomorrow?.until ?? 0).toString()).toContain("Sat Oct 10 2026 09:00");
    expect(new Date(week?.until ?? 0).toString()).toContain("Mon Oct 12 2026 09:00");
  });
});
