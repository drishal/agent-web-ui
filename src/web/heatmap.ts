// The Usage panel's heatmap of days: the report's days laid out as weeks (columns)
// by weekday (rows, Sunday first), each shaded in one of five levels by tokens or
// cost. Pure. The report's day names are already the browser's local days
// ("2026-10-14"), so the layout reads them as plain calendar dates at noon UTC:
// a daylight-saving week is still seven days and no hour is ever added up.

export type HeatMetric = "tokens" | "cost";

export interface HeatDay {
  day: string;
  tokens: number;
  cost: number;
}

export interface HeatCell extends HeatDay {
  /** The shown metric's value for the day. */
  value: number;
  /** 0 for nothing, 1 to 4 for the lightest to the darkest shade. */
  level: 0 | 1 | 2 | 3 | 4;
  /** The week it sits in (the grid's column, from 0) and its weekday (the row, 0 = Sunday). */
  col: number;
  row: number;
}

const DAY_MS = 86_400_000;

const noon = (day: string): number => Date.parse(`${day}T12:00:00Z`);

/**
 * The upper edges of shades 1 to 3: the quartiles of the days that have any
 * use, so each shade holds about a quarter of the busy days whatever the scale.
 */
export function heatThresholds(values: number[]): [number, number, number] {
  const used = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (used.length === 0) return [0, 0, 0];
  const at = (q: number) => used[Math.min(used.length - 1, Math.ceil(q * used.length) - 1)] as number;
  return [at(0.25), at(0.5), at(0.75)];
}

/** A value's shade: nothing is 0; otherwise the first shade whose edge holds it, and 4 above the third edge. */
export function heatLevel(value: number, thresholds: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (!(value > 0)) return 0;
  if (value <= thresholds[0]) return 1;
  if (value <= thresholds[1]) return 2;
  if (value <= thresholds[2]) return 3;
  return 4;
}

/**
 * The days as grid cells, in the report's order. Days run on from one another,
 * so the first one's weekday sets the first column's blank rows. The busiest
 * day is always the darkest shade, and so is every busy day when they all used
 * the same (one shade for one value would read as "a little").
 */
export function heatmapCells(days: HeatDay[], metric: HeatMetric): { cells: HeatCell[]; weeks: number; thresholds: [number, number, number] } {
  const first = days[0];
  if (!first) return { cells: [], weeks: 0, thresholds: [0, 0, 0] };
  const values = days.map((d) => (metric === "cost" ? d.cost : d.tokens));
  const thresholds = heatThresholds(values);
  const flat = thresholds[0] === thresholds[2];
  const top = Math.max(...values);
  const start = noon(first.day) - new Date(noon(first.day)).getUTCDay() * DAY_MS;
  const cells = days.map((d, i): HeatCell => {
    const at = noon(d.day);
    const value = values[i] ?? 0;
    return { ...d, value, level: value > 0 && (flat || value === top) ? 4 : heatLevel(value, thresholds), col: Math.floor(Math.round((at - start) / DAY_MS) / 7), row: new Date(at).getUTCDay() };
  });
  return { cells, weeks: (cells[cells.length - 1]?.col ?? 0) + 1, thresholds };
}

/** The month names over the columns: where a month's first day falls (and the first column), skipping any closer than `gap` columns to the one before. */
export function heatMonths(cells: HeatCell[], gap = 3): Array<{ col: number; label: string }> {
  const out: Array<{ col: number; label: string }> = [];
  cells.forEach((c, i) => {
    if (i > 0 && !c.day.endsWith("-01")) return;
    const last = out[out.length - 1];
    if (last && c.col - last.col < gap) return;
    out.push({ col: c.col, label: new Date(noon(c.day)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) });
  });
  return out;
}

/** The cell a key moves to from index `i` of `count` days: left and right a week, up and down a day (null when it stays). */
export function heatStep(i: number, key: string, count: number): number | null {
  const to = key === "ArrowLeft" ? i - 7 : key === "ArrowRight" ? i + 7 : key === "ArrowUp" ? i - 1 : key === "ArrowDown" ? i + 1 : key === "Home" ? 0 : key === "End" ? count - 1 : null;
  if (to === null) return null;
  const clamped = Math.max(0, Math.min(count - 1, to));
  return clamped === i ? null : clamped;
}
