/** @vitest-environment node */
// UI-15: the root layout resolves the per-request day from the already
// fetched Headers so SSR and the first client render agree.
import { describe, expect, it } from "vitest";

import { getRequestTodayFromHeaders } from "@/lib/server-timezone";

describe("UI-15 request day from headers", () => {
  it("resolves the browser day from the timezone cookie", () => {
    // 2026-08-18T13:00Z is still the 18th in UTC but the 19th in Auckland.
    const headers = new Headers({
      cookie: `mt_tz=${encodeURIComponent("Pacific/Auckland")}`,
    });
    expect(getRequestTodayFromHeaders(headers, new Date("2026-08-18T13:00:00Z"))).toBe(
      "2026-08-19",
    );
  });

  it("falls back to the server day without a cookie or with a bogus zone", () => {
    const fixedNow = new Date("2026-08-18T11:00:00Z");
    expect(getRequestTodayFromHeaders(new Headers(), fixedNow)).toBe(
      getRequestTodayFromHeaders(
        new Headers({ cookie: "mt_tz=Not%2FAZone" }),
        fixedNow,
      ),
    );
    expect(
      getRequestTodayFromHeaders(
        new Headers({ cookie: "other=1; mt_tz=UTC" }),
        fixedNow,
      ),
    ).toBe("2026-08-18");
  });
});
