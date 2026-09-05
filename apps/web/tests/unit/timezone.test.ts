import {
  TIMEZONE_COOKIE_NAME,
  dateStringInTimeZone,
  isValidTimeZone,
  normalizeTimeZone,
} from "@/lib/timezone";
import { describe, expect, it } from "vitest";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("Europe/Amsterdam")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Pacific/Auckland")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
  });

  it("rejects anything that is not a zone name", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("Europe/Amsterdam; DROP TABLE users")).toBe(false);
    expect(isValidTimeZone("../../etc/passwd")).toBe(false);
    expect(isValidTimeZone("A".repeat(200))).toBe(false);
  });

  it("normalizes an unusable cookie value to null", () => {
    expect(normalizeTimeZone("Europe/Amsterdam")).toBe("Europe/Amsterdam");
    expect(normalizeTimeZone("garbage")).toBeNull();
  });

  it("normalizes equivalent zone aliases to one canonical cookie value", () => {
    expect(normalizeTimeZone("Etc/UTC")).toBe("UTC");
  });
});

describe("dateStringInTimeZone", () => {
  it("resolves the calendar day in the user's zone, not UTC", () => {
    // 02:30 UTC on the 16th is still 21:30 on the 15th in New York.
    const instant = new Date("2026-01-16T02:30:00Z");

    expect(dateStringInTimeZone("UTC", instant)).toBe("2026-01-16");
    expect(dateStringInTimeZone("America/New_York", instant)).toBe("2026-01-15");
  });

  it("resolves a day ahead of UTC for zones east of the line", () => {
    // 20:00 UTC on the 14th is already 09:00 on the 15th in Auckland.
    const instant = new Date("2026-01-14T20:00:00Z");

    expect(dateStringInTimeZone("UTC", instant)).toBe("2026-01-14");
    expect(dateStringInTimeZone("Pacific/Auckland", instant)).toBe("2026-01-15");
  });

  it("zero-pads month and day", () => {
    expect(dateStringInTimeZone("UTC", new Date("2026-03-05T12:00:00Z"))).toBe(
      "2026-03-05",
    );
  });

  it("honours a DST transition", () => {
    // 01:30 UTC on the last Sunday of March is 02:30 in Amsterdam (CEST).
    const instant = new Date("2026-03-29T01:30:00Z");
    expect(dateStringInTimeZone("Europe/Amsterdam", instant)).toBe("2026-03-29");
  });
});

describe("cookie contract", () => {
  it("uses a stable name the layout script and the server agree on", () => {
    expect(TIMEZONE_COOKIE_NAME).toBe("mt_tz");
  });
});
