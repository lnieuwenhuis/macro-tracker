/** @vitest-environment jsdom */
// todayStr comes from the server prop so SSR/hydration agree across zones.
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "@/components/app-shell";

const mocked = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocked.push, replace: mocked.replace }),
  usePathname: () => "/",
}));

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
  delete document.documentElement.dataset.appHydrated;
});

function renderShell(props: { selectedDate: string; todayStr?: string }) {
  return render(
    <AppShell
      userEmail="user@example.com"
      canAccessAdmin={false}
      selectedDate={props.selectedDate}
      title="Food Log"
      activeTab="log"
      showDateNavigation
      todayStr={props.todayStr}
    >
      <div>content</div>
    </AppShell>,
  );
}

describe("AppShell todayStr", () => {
  it("treats selectedDate as today when it matches the supplied todayStr, regardless of the runtime's own zone", () => {
    // Pacific/Auckland is far enough ahead of UTC to disagree with "now" in this zone.
    process.env.TZ = "Pacific/Auckland";

    renderShell({ selectedDate: "2026-08-18", todayStr: "2026-08-18" });

    // Absence proves isToday came from the prop, not a fresh zone-based recompute.
    expect(screen.queryByRole("button", { name: /today/i })).toBeNull();
  });

  it("shows the Today button when the supplied todayStr disagrees with the selected day", () => {
    process.env.TZ = "Pacific/Auckland";

    renderShell({ selectedDate: "2026-08-17", todayStr: "2026-08-18" });

    const todayButton = screen.getByRole("button", { name: /today/i });
    expect(todayButton).not.toBeNull();

    fireEvent.click(todayButton);
    expect(mocked.push).toHaveBeenCalledWith(expect.stringContaining("date=2026-08-18"));
  });

  it("falls back to the local runtime day when no todayStr prop is supplied", () => {
    process.env.TZ = "UTC";
    const fixedNow = new Date("2026-08-18T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    try {
      renderShell({ selectedDate: "2026-08-18" });
      expect(screen.queryByRole("button", { name: /today/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the document as hydrated after mount so E2E tests can wait for interactivity", () => {
    // `waitForAppReady` in test-users.ts waits for this beacon before interacting.
    expect(document.documentElement.dataset.appHydrated).toBeUndefined();

    renderShell({ selectedDate: "2026-08-18", todayStr: "2026-08-18" });

    expect(document.documentElement.dataset.appHydrated).toBe("true");
  });
});
