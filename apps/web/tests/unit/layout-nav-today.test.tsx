/** @vitest-environment jsdom */
// UI-15: LayoutNav must not recompute "today" during render (SSR/client zone
// disagreement across a date boundary); it uses the stable server prop and
// only reads the browser clock after hydration.
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rankCandidates } from "@/lib/quick-add";

const mocked = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  searchDate: null as string | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocked.push, replace: mocked.replace }),
  usePathname: () => "/",
  useSearchParams: () => ({ get: (key: string) => (key === "date" ? mocked.searchDate : null) }),
}));

import { LayoutNav } from "@/components/layout-nav";

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
  mocked.searchDate = null;
  vi.useRealTimers();
});

describe("UI-15 stable SSR clock", () => {
  it("uses the explicit date query verbatim", () => {
    mocked.searchDate = "2026-08-18";
    process.env.TZ = "Pacific/Auckland";
    render(<LayoutNav todayStr="2026-08-19" />);

    expect(screen.getByRole("link", { name: /food log/i }).getAttribute("href")).toBe(
      "/?date=2026-08-18",
    );
  });

  it("uses the server todayStr prop instead of recomputing the local day", () => {
    mocked.searchDate = null;
    // 2026-08-18T13:00Z is 2026-08-18 in UTC but 2026-08-19 in Auckland.
    process.env.TZ = "Pacific/Auckland";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T13:00:00Z"));

    try {
      render(<LayoutNav todayStr="2026-08-18" />);
      // First render agrees with the server prop even though the browser's
      // own local day is already the 19th.
      expect(screen.getByRole("link", { name: /food log/i }).getAttribute("href")).toBe(
        "/?date=2026-08-18",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("quick-add ranking flips across an hour boundary (hazard pinned)", () => {
    const candidates = [
      {
        label: "Morning oats",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 200,
        source: "recent" as const,
        peakHourUtc: 7,
        habitCount: 5,
      },
      {
        label: "Late snack",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 200,
        source: "recent" as const,
        peakHourUtc: 22,
        habitCount: 5,
      },
    ];
    const morning = rankCandidates(candidates, {
      currentHourUtc: 7,
      referenceDate: "2026-08-18",
    }).map((c) => c.label);
    const night = rankCandidates(candidates, {
      currentHourUtc: 22,
      referenceDate: "2026-08-18",
    }).map((c) => c.label);

    expect(morning[0]).toBe("Morning oats");
    expect(night[0]).toBe("Late snack");
    expect(morning).not.toEqual(night);
  });
});
