/** @vitest-environment node */
// UI-24: page-boundary input validation. 128 chars / 8 terms mirror the
// backend bounds; malformed route ids 404 after auth instead of throwing.
import { describe, expect, it } from "vitest";

import {
  isRouteUuid,
  validateSearchQuery,
} from "@/lib/input-validation";

describe("UI-24 input validation", () => {
  it("accepts the 128-character / 8-term boundaries", () => {
    expect(validateSearchQuery("a".repeat(128))).toBeNull();
    expect(validateSearchQuery("é".repeat(128))).toBeNull();
    expect(validateSearchQuery("a b c d e f g h")).toBeNull();
    expect(validateSearchQuery("oatmeal")).toBeNull();
    expect(validateSearchQuery("")).toBeNull();
    expect(validateSearchQuery("   ")).toBeNull();
  });

  it("rejects 129 Unicode characters with an actionable message", () => {
    expect(validateSearchQuery("a".repeat(129))).toContain("128");
    expect(validateSearchQuery("é".repeat(129))).toContain("128");
    expect(validateSearchQuery("😀".repeat(129))).toContain("128");
  });

  it("rejects 9 terms with an actionable message", () => {
    expect(validateSearchQuery("a b c d e f g h i")).toContain("8");
  });

  it("does not silently truncate", () => {
    const tooLong = `oatmeal ${"a".repeat(130)}`;
    const message = validateSearchQuery(tooLong);
    expect(message).not.toBeNull();
    expect(tooLong.length).toBeGreaterThan(128);
  });

  it("accepts well-formed UUIDs and rejects malformed route ids", () => {
    expect(isRouteUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(isRouteUuid("not-a-uuid")).toBe(false);
    expect(isRouteUuid("")).toBe(false);
    expect(isRouteUuid("123")).toBe(false);
    expect(isRouteUuid("../../admin")).toBe(false);
    expect(isRouteUuid("123e4567-e89b-12d3-a456-42661417400")).toBe(false);
    expect(
      isRouteUuid("123e4567-e89b-12d3-a456-426614174000-extra"),
    ).toBe(false);
  });
});
