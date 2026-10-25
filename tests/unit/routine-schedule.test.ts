// A routine's cadence (routine-schedule.ts): when it next runs, and how it reads.
import { describe, expect, it } from "vitest";
import { cadenceLabel, nextRunAt } from "../../src/shared/routine-schedule.js";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);
const same = (got: number, want: Date) => expect(new Date(got).toString()).toBe(want.toString());

describe("a routine's next run", () => {
  it("hourly is the next :MM, strictly after now", () => {
    same(nextRunAt({ kind: "hourly", minute: 30 }, at(9, 10, 45).getTime()), at(9, 11, 30));
    same(nextRunAt({ kind: "hourly", minute: 30 }, at(9, 10, 30).getTime()), at(9, 11, 30));
  });

  it("daily is today if the time is still ahead, else tomorrow", () => {
    same(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, at(9, 8, 0).getTime()), at(9, 9, 0));
    same(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, at(9, 9, 0).getTime()), at(10, 9, 0));
  });

  it("weekdays skip the weekend, and today counts when it is still ahead", () => {
    // Friday 9 October 2026.
    same(nextRunAt({ kind: "weekdays", hour: 9, minute: 0 }, at(9, 8, 0).getTime()), at(9, 9, 0));
    same(nextRunAt({ kind: "weekdays", hour: 9, minute: 0 }, at(9, 10, 0).getTime()), at(12, 9, 0));
    // Saturday asks for Monday.
    same(nextRunAt({ kind: "weekdays", hour: 9, minute: 0 }, at(10, 10, 0).getTime()), at(12, 9, 0));
  });

  it("weekly waits for its weekday, a week out when today's time has gone", () => {
    // Monday 12 October 2026.
    same(nextRunAt({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, at(12, 8, 0).getTime()), at(12, 9, 0));
    same(nextRunAt({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, at(12, 9, 30).getTime()), at(19, 9, 0));
  });

  it("reads as the dialog says it", () => {
    expect(cadenceLabel({ kind: "hourly", minute: 5 })).toBe("every hour at :05");
    expect(cadenceLabel({ kind: "daily", hour: 9, minute: 0 })).toBe("every day at 09:00");
    expect(cadenceLabel({ kind: "weekdays", hour: 8, minute: 30 })).toBe("weekdays at 08:30");
    expect(cadenceLabel({ kind: "weekly", weekday: 1, hour: 9, minute: 0 })).toBe("Mondays at 09:00");
  });
});
