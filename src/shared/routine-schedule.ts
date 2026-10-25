// When a routine next runs. Shared: the server schedules from it and the Routines
// dialog says when that will be. Times are this machine's local time, as the
// dialog reads them; a weekly day follows Date's convention (0 = Sunday).
export type RoutineCadence =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The first run strictly after `now`, in local time (a few days out at most). */
export function nextRunAt(cadence: RoutineCadence, now = Date.now()): number {
  const from = new Date(now);
  if (cadence.kind === "hourly") {
    const at = new Date(from);
    at.setMinutes(cadence.minute, 0, 0);
    if (at.getTime() <= now) at.setHours(at.getHours() + 1);
    return at.getTime();
  }
  const sameDay = (offset: number) => {
    const day = new Date(from);
    day.setDate(from.getDate() + offset);
    day.setHours((cadence as { hour: number }).hour, cadence.minute, 0, 0);
    return day;
  };
  if (cadence.kind === "daily") {
    const today = sameDay(0);
    return today.getTime() > now ? today.getTime() : sameDay(1).getTime();
  }
  for (let offset = 0; offset < 8; offset++) {
    const day = sameDay(offset);
    if (day.getTime() <= now) continue;
    if (cadence.kind === "weekdays" ? day.getDay() >= 1 && day.getDay() <= 5 : day.getDay() === cadence.weekday) return day.getTime();
  }
  // Unreachable: eight days always include the wanted weekday.
  return now + 7 * DAY;
}

/** The dialog's own words for a cadence. */
export function cadenceLabel(cadence: RoutineCadence): string {
  const time = `${String("hour" in cadence ? cadence.hour : 0).padStart(2, "0")}:${String(cadence.minute).padStart(2, "0")}`;
  switch (cadence.kind) {
    case "hourly":
      return `every hour at :${String(cadence.minute).padStart(2, "0")}`;
    case "daily":
      return `every day at ${time}`;
    case "weekdays":
      return `weekdays at ${time}`;
    case "weekly":
      return `${WEEKDAYS[cadence.weekday] ?? "?"}s at ${time}`;
  }
}
