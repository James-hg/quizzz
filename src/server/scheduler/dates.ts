/**
 * Local calendar days for the scheduler. "Today" is the student's own day, so everything here
 * works on `YYYY-MM-DD` strings in an IANA timezone and converts to an instant only at the end.
 * Daylight-saving changes need no special case: a local day is whatever instants map to that
 * date, so it may be 23 or 25 hours long.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** The local date (`YYYY-MM-DD`) of an instant in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const parts = formatterFor(tz).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/**
 * The first instant of a local date. Found by search rather than offset arithmetic so it is
 * right when midnight does not exist or happens twice on a clock-change day.
 */
export function startOfLocalDay(date: string, tz: string): Date {
  let lo = Date.parse(`${date}T00:00:00Z`) - 36 * 3_600_000;
  let hi = Date.parse(`${date}T00:00:00Z`) + 36 * 3_600_000;
  // Invariant: localDate(lo) < date <= localDate(hi).
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDate(new Date(mid), tz) < date) lo = mid;
    else hi = mid;
  }
  return new Date(hi);
}
