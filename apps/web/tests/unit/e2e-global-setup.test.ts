import { describe, expect, it } from "vitest";

import { resolveE2eDatabaseUrl } from "../e2e/global-setup";

describe("Playwright global setup database safety", () => {
  it("refuses to truncate a plain non-test DATABASE_URL", () => {
    expect(() =>
      resolveE2eDatabaseUrl({
        DATABASE_URL:
          "postgres://macro:secret@db.internal.example.com:5432/macro_tracker",
      }),
    ).toThrow(/Refusing to truncate plain DATABASE_URL/);
  });

  it("refuses to truncate an explicit local non-test E2E_DATABASE_URL by default", () => {
    expect(() =>
      resolveE2eDatabaseUrl({
        E2E_DATABASE_URL: "postgres://postgres:***@localhost:5432/macro_tracker",
      }),
    ).toThrow(/does not look like a test database/);
  });

  it("accepts an explicit local test-named E2E_DATABASE_URL", () => {
    const e2eDatabaseUrl =
      "postgres://postgres:***@127.0.0.1:55432/macro_tracker_e2e";

    expect(
      resolveE2eDatabaseUrl({
        DATABASE_URL:
          "postgres://macro:secret@db.internal.example.com:5432/macro_tracker",
        E2E_DATABASE_URL: e2eDatabaseUrl,
      }),
    ).toBe(e2eDatabaseUrl);
  });
});
