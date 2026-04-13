import {
  markNavigationRendered,
  prepareNavigationMotion,
  resetNavigationMotionState,
  resolveNavigationMotion,
} from "@/lib/navigation-motion";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  resetNavigationMotionState();
});

describe("navigation-motion", () => {
  it("uses the intro motion for the first screen render", () => {
    expect(resolveNavigationMotion("/", "2026-04-13")).toBe("intro");
  });

  it("keeps the current screen still on same-route refreshes", () => {
    markNavigationRendered("/", "2026-04-13");

    expect(resolveNavigationMotion("/", "2026-04-13")).toBe("none");
  });

  it("plays the prepared day motion when the target date arrives", () => {
    markNavigationRendered("/", "2026-04-13");
    prepareNavigationMotion("/?date=2026-04-14", "day-forward");

    expect(resolveNavigationMotion("/", "2026-04-14")).toBe("day-forward");

    markNavigationRendered("/", "2026-04-14");

    expect(resolveNavigationMotion("/", "2026-04-14")).toBe("none");
  });

  it("matches path-only screen transitions for routes without a date query", () => {
    markNavigationRendered("/summary", "2026-04-13");
    prepareNavigationMotion("/stats", "screen");

    expect(resolveNavigationMotion("/stats", "2026-04-13")).toBe("screen");
  });
});
