/**
 * @vitest-environment jsdom
 *
 * UI-02: `todayStr` used to be computed with `getLocalDateString()` inside a
 * `useMemo` on every render of `AppShell`/`DashboardShell`. Both components
 * are client components still SSR'd on first load, so that `useMemo` runs
 * once on the server (Node's `process.env.TZ`, UTC in production) and again
 * during hydration (the browser's zone) -- a real DOM-subtree hydration
 * mismatch for any user at a non-zero UTC offset.
 *
 * The fix threads a single `todayStr` resolved server-side via
 * `getRequestToday()` (which reads the `mt_tz` cookie) down as a prop, the
 * same way `selectedDate` already works. These tests pin `process.env.TZ` to
 * a zone that disagrees with the supplied `todayStr` and assert the
 * component trusts the prop rather than recomputing the day from the
 * runtime's zone.
 */
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
    // Pacific/Auckland is far enough ahead of UTC that `getLocalDateString()`
    // (no explicit instant, i.e. "now") would very likely report a different
    // calendar day than a fixed prop value picked to disagree with it.
    process.env.TZ = "Pacific/Auckland";

    renderShell({ selectedDate: "2026-08-18", todayStr: "2026-08-18" });

    // The floating "Today" button only renders when the viewed day is NOT
    // today. Since selectedDate === todayStr (from the prop), it must be
    // absent -- proving isToday was derived from the prop, not a fresh
    // `getLocalDateString()` call in this zone.
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
    // The Playwright suite fills the date picker and clicks buttons that only
    // work once React has hydrated; on slow CI runners those interactions
    // raced hydration and got swallowed (the controlled date input snapped
    // back to today). `test-users.ts#waitForAppReady` waits for this beacon,
    // so removing it silently re-introduces that flake class.
    expect(document.documentElement.dataset.appHydrated).toBeUndefined();

    renderShell({ selectedDate: "2026-08-18", todayStr: "2026-08-18" });

    expect(document.documentElement.dataset.appHydrated).toBe("true");
  });
});
