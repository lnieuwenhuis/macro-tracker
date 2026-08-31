import { describe, expect, it } from "vitest";

import { formatMinutesAsTime } from "@/lib/formatting";
import {
  formatFriendCode,
  gymStatusLabel,
  minutesToTimeInput,
  timeInputToMinutes,
} from "@/lib/gym-time";

describe("gym time helpers", () => {
  it("maps time-input values to minutes with the midnight-end special case", () => {
    expect(timeInputToMinutes("00:00", "start")).toBe(0);
    expect(timeInputToMinutes("17:30", "start")).toBe(1050);
    // An END of 00:00 means "until midnight" (minute 1440), so a plain
    // 23:00-00:00 slot stays representable.
    expect(timeInputToMinutes("00:00", "end")).toBe(1440);
    expect(timeInputToMinutes("23:59", "end")).toBe(1439);
  });

  it("round-trips minutes back into input values", () => {
    expect(minutesToTimeInput(0)).toBe("00:00");
    expect(minutesToTimeInput(1050)).toBe("17:30");
    expect(minutesToTimeInput(1440)).toBe("00:00");
  });

  it("never renders 24:00", () => {
    expect(formatMinutesAsTime(1440)).toBe("00:00");
    expect(formatMinutesAsTime(1439)).toBe("23:59");
    expect(formatMinutesAsTime(9 * 60 + 5)).toBe("09:05");
  });

  it("formats bare friend codes with a dash and passes everything else through", () => {
    expect(formatFriendCode("AB23CD45")).toBe("AB23-CD45");
    // Already-formatted codes, emails, and unexpected data are untouched.
    expect(formatFriendCode("AB23-CD45")).toBe("AB23-CD45");
    expect(formatFriendCode("bob@example.com")).toBe("bob@example.com");
    expect(formatFriendCode("")).toBe("");
  });
});

describe("gymStatusLabel", () => {
  const base = { todayStr: "2026-08-31", endMinute: 18 * 60 };

  it("renders non-skip statuses without tense", () => {
    expect(
      gymStatusLabel("going", { ...base, date: "2026-08-31", nowMinute: 0 }),
    ).toBe("Going");
    expect(
      gymStatusLabel("maybe", { ...base, date: "2026-08-31", nowMinute: 0 }),
    ).toBe("Maybe");
    expect(
      gymStatusLabel("done", { ...base, date: "2026-08-31", nowMinute: 0 }),
    ).toBe("Done");
  });

  it("is tense-aware for skips: Skipping before the slot's end, Skipped after", () => {
    expect(
      gymStatusLabel("skipped", {
        ...base,
        date: "2026-08-31",
        nowMinute: 18 * 60 - 1,
      }),
    ).toBe("Skipping");
    // Boundary: exactly at the end time the slot is over.
    expect(
      gymStatusLabel("skipped", {
        ...base,
        date: "2026-08-31",
        nowMinute: 18 * 60,
      }),
    ).toBe("Skipped");
  });

  it("uses the day-level comparison for non-today dates regardless of clock", () => {
    expect(
      gymStatusLabel("skipped", { ...base, date: "2026-09-01", nowMinute: 1439 }),
    ).toBe("Skipping");
    expect(
      gymStatusLabel("skipped", { ...base, date: "2026-08-30", nowMinute: 0 }),
    ).toBe("Skipped");
  });

  it("falls back to the neutral past form when the clock is unknown (SSR)", () => {
    expect(
      gymStatusLabel("skipped", { ...base, date: "2026-08-31", nowMinute: null }),
    ).toBe("Skipped");
  });
});
