import { describe, expect, it } from "vitest";
import { addDays, daysBetween, localDate, startOfLocalDay } from "./dates";

describe("local dates", () => {
  it("uses the student's day, not UTC's", () => {
    const instant = new Date("2026-03-10T03:30:00Z");
    expect(localDate(instant, "UTC")).toBe("2026-03-10");
    expect(localDate(instant, "America/Vancouver")).toBe("2026-03-09");
    expect(localDate(instant, "Pacific/Auckland")).toBe("2026-03-10");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-03-01", "2026-03-15")).toBe(14);
    expect(daysBetween("2026-03-15", "2026-03-01")).toBe(-14);
  });

  it.each([
    ["UTC", "2026-03-08", "2026-03-08T00:00:00.000Z"],
    ["America/Vancouver", "2026-03-08", "2026-03-08T08:00:00.000Z"], // PST, the day DST starts
    ["America/Vancouver", "2026-03-09", "2026-03-09T07:00:00.000Z"], // PDT
    ["America/Vancouver", "2026-11-01", "2026-11-01T07:00:00.000Z"], // the day DST ends
    ["America/Vancouver", "2026-11-02", "2026-11-02T08:00:00.000Z"],
    ["Australia/Sydney", "2026-10-04", "2026-10-03T14:00:00.000Z"], // AEST, DST starts
    ["Australia/Sydney", "2026-10-05", "2026-10-04T13:00:00.000Z"], // AEDT
    ["Asia/Kolkata", "2026-06-01", "2026-05-31T18:30:00.000Z"],
  ])("finds the start of the day in %s on %s", (tz, date, iso) => {
    expect(startOfLocalDay(date, tz).toISOString()).toBe(iso);
  });

  it("handles a day whose midnight does not exist", () => {
    // Havana skips 00:00 when DST starts, so the day begins at 01:00 local.
    const start = startOfLocalDay("2026-03-08", "America/Havana");
    expect(localDate(start, "America/Havana")).toBe("2026-03-08");
    expect(localDate(new Date(start.getTime() - 1), "America/Havana")).toBe("2026-03-07");
  });
});
