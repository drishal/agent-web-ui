// The awui harness's flat, dated history. Buckets match Claude.ai's sidebar:
// Pinned first (its own list), then Today, Yesterday, this week's days (each
// its own short date, newest first), then Older. No projects.
import { describe, expect, it } from "vitest";
import { asHarnessId, type ProjectSession, type SessionsOverview } from "../../src/shared/protocol.js";
import { conversationBucket, historySections } from "../../src/web/session-groups.js";

// Fixed "now" so the buckets are deterministic: a Friday.
const NOW = new Date("2026-10-09T15:00:00"); // local
const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number, h = 12) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(h, 0, 0, 0);
  return iso(d);
};

const s = (id: string, updatedAt: string, opts: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  harnessId: asHarnessId("awui"),
  title: id,
  updatedAt,
  workspaceId: "ws",
  ...opts,
});

const overview = (sessions: ProjectSession[]): SessionsOverview => ({ workspaces: [], sessions, errors: [] });
const opts = { currentId: null, query: "", harnessId: "awui" as const, now: NOW.getTime() };

describe("conversationBucket", () => {
  it("labels Today, Yesterday, this week's days, Older", () => {
    expect(conversationBucket(daysAgo(0, 9), NOW)).toBe("Today");
    expect(conversationBucket(daysAgo(1), NOW)).toBe("Yesterday");
    // 3 days back is still this week: a short date ("Oct 6"), not a month name.
    const three = conversationBucket(daysAgo(3), NOW);
    expect(three).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(conversationBucket(daysAgo(9), NOW)).toBe("Older");
    expect(conversationBucket(null, NOW)).toBe("Older");
  });
});

describe("historySections", () => {
  const s = (id: string, updatedAt: string, opts: Partial<ProjectSession> = {}): ProjectSession => ({
    id,
    harnessId: asHarnessId("awui"),
    title: id,
    updatedAt,
    workspaceId: "ws",
    ...opts,
  });

  // "now" is Friday 15:00; hist ids sit clearly inside each bucket, not on a boundary.
  const hist = overview([
    s("old", daysAgo(30)),
    s("today", iso(new Date(NOW.getTime() - 60_000))),
    s("yesterday", daysAgo(1)),
    s("thisweek", daysAgo(3)),
    s("pinned", daysAgo(40), { pinned: true }),
  ]);

  it("orders Pinned, Today, Yesterday, this week, Older", () => {
    const labels = historySections(hist, opts).map((sec) => sec.label);
    expect(labels[0]).toBe("Pinned");
    expect(labels[1]).toBe("Today");
    expect(labels[2]).toBe("Yesterday");
    expect(labels[labels.length - 1]).toBe("Older");
    expect(labels).toHaveLength(5);
  });

  it("pins stay out of the dated buckets", () => {
    const dated = historySections(hist, opts).filter((sec) => sec.label !== "Pinned");
    expect(dated.flatMap((sec) => sec.sessions.map((x) => x.id))).not.toContain("pinned");
  });

  it("keeps only the selected harness, and honors search", () => {
    const mixed = overview([s("awui1", daysAgo(0)), { ...s("pi1", daysAgo(0)), harnessId: asHarnessId("pi") }]);
    expect(historySections(mixed, opts).flatMap((s2) => s2.sessions.map((x) => x.id))).toEqual(["awui1"]);
    const found = historySections(overview([s("alpha quest", daysAgo(0)), s("beta", daysAgo(0))]), { ...opts, query: "quest" });
    expect(found.flatMap((s2) => s2.sessions.map((x) => x.id))).toEqual(["alpha quest"]);
  });
});
