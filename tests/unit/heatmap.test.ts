import { describe, expect, it } from "vitest";
import { heatLevel, heatmapCells, heatMonths, heatStep, heatThresholds, type HeatDay } from "../../src/web/heatmap.js";

const run = (first: string, tokens: number[]): HeatDay[] =>
  tokens.map((t, i) => ({ day: new Date(Date.parse(`${first}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), tokens: t, cost: t / 1000 }));

describe("heatmap", () => {
  it("has no cells for no days", () => {
    expect(heatmapCells([], "tokens")).toEqual({ cells: [], weeks: 0, thresholds: [0, 0, 0] });
    expect(heatThresholds([0, 0])).toEqual([0, 0, 0]);
  });

  it("shades one busy day the darkest, and an idle one not at all", () => {
    const { cells, weeks } = heatmapCells(run("2026-10-14", [500]), "tokens");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ level: 4, col: 0, row: 3 });
    expect(weeks).toBe(1);
    expect(heatmapCells(run("2026-10-14", [0]), "tokens").cells[0]?.level).toBe(0);
  });

  it("puts weeks in columns and Sunday in row 0, the busiest day darkest", () => {
    // 2026-10-11 is a Sunday.
    const { cells, weeks } = heatmapCells(run("2026-10-11", [0, 1, 2, 3, 4, 5, 6, 7, 8, 100]), "tokens");
    expect(cells.map((c) => [c.col, c.row])).toEqual([[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 0], [1, 1], [1, 2]]);
    expect(weeks).toBe(2);
    expect(cells[0]?.level).toBe(0);
    expect(cells[9]?.level).toBe(4);
    expect(cells[1]?.level).toBe(1);
  });

  it("starts the first column part way down when the range starts mid-week", () => {
    const { cells } = heatmapCells(run("2026-10-14", [1, 1, 1, 1, 1]), "tokens");
    expect(cells.map((c) => [c.col, c.row])).toEqual([[0, 3], [0, 4], [0, 5], [0, 6], [1, 0]]);
  });

  it("keeps a daylight-saving week seven days (US spring forward on 2026-03-08, fall back on 2026-11-01)", () => {
    for (const first of ["2026-03-04", "2026-10-28"]) {
      const { cells, weeks } = heatmapCells(run(first, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), "tokens");
      const dow = new Date(`${first}T12:00:00Z`).getUTCDay();
      expect(cells.map((c) => c.row)).toEqual(cells.map((_, i) => (dow + i) % 7));
      expect(cells.map((c) => c.col)).toEqual(cells.map((_, i) => Math.floor((dow + i) / 7)));
      expect(weeks).toBe(Math.floor((dow + 9) / 7) + 1);
    }
  });

  it("shades by cost when asked", () => {
    const days: HeatDay[] = [{ day: "2026-10-12", tokens: 900, cost: 0 }, { day: "2026-10-13", tokens: 1, cost: 5 }];
    expect(heatmapCells(days, "tokens").cells.map((c) => c.level)).toEqual([4, 1]);
    expect(heatmapCells(days, "cost").cells.map((c) => c.level)).toEqual([0, 4]);
  });

  it("cuts shades at the busy days' quartiles", () => {
    const t = heatThresholds([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(t).toEqual([2, 4, 6]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => heatLevel(v, t))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("names a month where it starts, not twice in a row", () => {
    const short = heatmapCells(run("2026-09-28", Array(8).fill(1)), "tokens").cells;
    expect(heatMonths(short)).toEqual([{ col: 0, label: "Sep" }]);
    const longer = heatmapCells(run("2026-09-06", Array(50).fill(1)), "tokens").cells;
    expect(heatMonths(longer).map((m) => m.label)).toEqual(["Sep", "Oct"]);
  });

  it("steps a week sideways and a day vertically, staying put at the ends", () => {
    expect(heatStep(10, "ArrowRight", 30)).toBe(17);
    expect(heatStep(10, "ArrowLeft", 30)).toBe(3);
    expect(heatStep(10, "ArrowDown", 30)).toBe(11);
    expect(heatStep(0, "ArrowUp", 30)).toBeNull();
    expect(heatStep(25, "ArrowRight", 30)).toBe(29);
    expect(heatStep(10, "a", 30)).toBeNull();
    expect(heatStep(10, "End", 30)).toBe(29);
  });
});
