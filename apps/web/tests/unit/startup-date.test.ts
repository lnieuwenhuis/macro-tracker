import { describe, expect, it } from "vitest";

import { getLocalDateString, getStartupDateRedirect } from "@/lib/startup-date";

describe("getLocalDateString", () => {
  it("formats a browser-local date string", () => {
    expect(getLocalDateString(new Date(2026, 3, 2))).toBe("2026-04-02");
  });
});

describe("getStartupDateRedirect", () => {
  it("does not redirect when the URL already contains the selected date", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: "2026-04-02",
        selectedDate: "2026-04-02",
        localDate: "2026-04-03",
      }),
    ).toBeNull();
  });

  it("does not redirect when the server fallback already matches the browser date", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: null,
        selectedDate: "2026-04-02",
        localDate: "2026-04-02",
      }),
    ).toBeNull();
  });

  it("redirects to the browser date when startup has no date param", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: null,
        selectedDate: "2026-04-01",
        localDate: "2026-04-02",
      }),
    ).toBe("2026-04-02");
  });

  it("redirects invalid date params to the browser date", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: "not-a-date",
        selectedDate: "2026-04-01",
        localDate: "2026-04-02",
      }),
    ).toBe("2026-04-02");
  });
});

describe("startup redirect is a one-shot", () => {
  it("would bounce a user-picked day back to today if it re-ran mid-navigation", () => {
    // Reproduces the race the mount guard exists to prevent: after picking a
    // day, the pushed URL has not landed yet, so `window.location.search` still
    // has no `date` while `selectedDate` already holds the new day.
    expect(
      getStartupDateRedirect({
        requestedDate: null,
        selectedDate: "2026-03-17",
        localDate: "2026-08-13",
      }),
    ).toBe("2026-08-13");
  });

  it("is a no-op once the pushed URL has landed", () => {
    expect(
      getStartupDateRedirect({
        requestedDate: "2026-03-17",
        selectedDate: "2026-03-17",
        localDate: "2026-08-13",
      }),
    ).toBeNull();
  });
});
