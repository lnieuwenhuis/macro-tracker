/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GymOverlapList } from "@/components/gym-overlap-list";
import { useGymNowMinute } from "@/lib/gym-clock";
import { gymStatusLabel } from "@/lib/gym-time";

describe("GymOverlapList", () => {
  it("renders nothing without overlaps", () => {
    const { container } = render(<GymOverlapList overlaps={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders confirmed and tentative overlaps with distinct copy", () => {
    render(
      <GymOverlapList
        overlaps={[
          {
            buddy: { id: "b1", name: "Alex" },
            windows: [{ startMinute: 1080, endMinute: 1110, tentative: false }],
            tentative: false,
          },
          {
            buddy: { id: "b2", name: "Sam" },
            windows: [{ startMinute: 600, endMinute: 660, tentative: true }],
            tentative: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("You and Alex")).toBeTruthy();
    expect(screen.getByText(/18:00–18:30/)).toBeTruthy();
    expect(screen.getByText(/might overlap/)).toBeTruthy();
  });
});

function SkipLabelProbe({ date, todayStr }: { date: string; todayStr: string }) {
  const nowMinute = useGymNowMinute();
  return createElement(
    "span",
    null,
    gymStatusLabel("skipped", { date, todayStr, endMinute: 1439, nowMinute }),
  );
}

describe("tense-aware skip label SSR contract", () => {
  it("server-renders the neutral past form even when the slot has not ended", () => {
    // getServerSnapshot must stay clock-independent or SSR/hydration text will mismatch.
    const html = renderToString(
      createElement(SkipLabelProbe, {
        date: "2026-08-31",
        todayStr: "2026-08-31",
      }),
    );
    expect(html).toContain("Skipped");
    expect(html).not.toContain("Skipping");
  });
});
