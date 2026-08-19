import { describe, expect, it } from "vitest";

import {
  ensureDateString,
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
