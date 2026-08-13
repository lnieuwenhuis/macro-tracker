import { describe, expect, it } from "vitest";

import {
  computeStreaks,
  ensureDateString,
  getCalendarMonthRange,
  getIsoWeekRange,
  getPeriodRanges,
  getRollingRange,
  isValidDateString,
  nextDateString,
  previousDateString,
  todayDateString,
} from "../src/dates";

describe("isValidDateString", () => {
  it("accepts a well-formed calendar date", () => {
    expect(isValidDateString("2026-02-28")).toBe(true);
    expect(isValidDateString("2024-02-29")).toBe(true);
  });

  it("rejects malformed and impossible dates", () => {
    expect(isValidDateString("")).toBe(false);
    expect(isValidDateString("2026-2-8")).toBe(false);
    expect(isValidDateString("26-02-08")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-02-30")).toBe(false);
    // Postgres accepts these as `date` input; the app must not.
    expect(isValidDateString("infinity")).toBe(false);
    expect(isValidDateString("today")).toBe(false);
    expect(isValidDateString("epoch")).toBe(false);
  });
});

describe("ensureDateString", () => {
  it("returns a valid value unchanged", () => {
    expect(ensureDateString("2026-05-01", "2026-01-01")).toBe("2026-05-01");
  });

  it("falls back for empty and invalid values", () => {
    expect(ensureDateString(undefined, "2026-01-01")).toBe("2026-01-01");
    expect(ensureDateString(null, "2026-01-01")).toBe("2026-01-01");
    expect(ensureDateString("", "2026-01-01")).toBe("2026-01-01");
    expect(ensureDateString("infinity", "2026-01-01")).toBe("2026-01-01");
  });

  it("defaults to the caller's own today when no fallback is given", () => {
    expect(ensureDateString("nonsense")).toBe(todayDateString());
  });
});

describe("day arithmetic", () => {
  it("steps across month boundaries", () => {
    expect(nextDateString("2026-01-31")).toBe("2026-02-01");
    expect(previousDateString("2026-02-01")).toBe("2026-01-31");
  });

  it("steps across a leap day", () => {
    expect(nextDateString("2024-02-28")).toBe("2024-02-29");
    expect(nextDateString("2024-02-29")).toBe("2024-03-01");
    expect(previousDateString("2024-03-01")).toBe("2024-02-29");
  });

  it("steps across a year boundary", () => {
    expect(nextDateString("2025-12-31")).toBe("2026-01-01");
    expect(previousDateString("2026-01-01")).toBe("2025-12-31");
  });
});

describe("computeStreaks", () => {
  it("returns zero for an empty history", () => {
    expect(computeStreaks([], "2026-01-10")).toEqual({
      currentStreak: 0,
      longestStreak: 0,
    });
  });

  it("counts a streak that includes today", () => {
    const dates = ["2026-01-08", "2026-01-09", "2026-01-10"];
    expect(computeStreaks(dates, "2026-01-10")).toEqual({
      currentStreak: 3,
      longestStreak: 3,
    });
  });

  it("counts a streak that ended yesterday", () => {
    const dates = ["2026-01-08", "2026-01-09"];
    expect(computeStreaks(dates, "2026-01-10")).toEqual({
      currentStreak: 2,
      longestStreak: 2,
    });
  });

  it("breaks the current streak once two days are missed", () => {
    const dates = ["2026-01-06", "2026-01-07"];
    expect(computeStreaks(dates, "2026-01-10").currentStreak).toBe(0);
  });

  it("reports the longest run separately from the current one", () => {
    const dates = [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-09",
      "2026-01-10",
    ];
    expect(computeStreaks(dates, "2026-01-10")).toEqual({
      currentStreak: 2,
      longestStreak: 4,
    });
  });
});

describe("period ranges", () => {
  it("uses ISO weeks (Monday to Sunday)", () => {
    // 2026-01-15 is a Thursday.
    expect(getIsoWeekRange("2026-01-15")).toEqual({
      startDate: "2026-01-12",
      endDate: "2026-01-18",
    });
  });

  it("covers the whole calendar month", () => {
    expect(getCalendarMonthRange("2026-02-15")).toEqual({
      startDate: "2026-02-01",
      endDate: "2026-02-28",
    });
    expect(getCalendarMonthRange("2024-02-15").endDate).toBe("2024-02-29");
  });

  it("makes a rolling range inclusive of both ends", () => {
    expect(getRollingRange("2026-01-10", 7)).toEqual({
      startDate: "2026-01-04",
      endDate: "2026-01-10",
    });
    expect(getRollingRange("2026-01-10", 1)).toEqual({
      startDate: "2026-01-10",
      endDate: "2026-01-10",
    });
  });

  it("exposes all four periods together", () => {
    const ranges = getPeriodRanges("2026-01-15");
    expect(Object.keys(ranges).sort()).toEqual([
      "month",
      "rolling30",
      "rolling7",
      "week",
    ]);
    expect(ranges.rolling30).toEqual({
      startDate: "2025-12-17",
      endDate: "2026-01-15",
    });
  });
});
