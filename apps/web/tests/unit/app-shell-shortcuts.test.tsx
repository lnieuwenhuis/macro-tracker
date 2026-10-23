/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocked.push, replace: mocked.replace }),
  usePathname: () => "/",
}));

import { AppShell } from "@/components/app-shell";

function renderLog(selectedDate = "2026-08-18") {
  return render(
    <AppShell
      userEmail="user@example.com"
      canAccessAdmin={false}
      selectedDate={selectedDate}
      title="Food Log"
      activeTab="log"
      showDateNavigation
      todayStr="2026-08-18"
    >
      <div>content</div>
    </AppShell>,
  );
}

describe("AppShell day shortcuts (UI-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("navigates the day with arrows when no overlay is open", () => {
    renderLog();
    mocked.push.mockClear();

    fireEvent.keyDown(document.body, { key: "ArrowRight" });

    expect(mocked.push).toHaveBeenCalledTimes(1);
    expect(mocked.push).toHaveBeenCalledWith(
      expect.stringContaining("date=2026-08-19"),
    );
  });

  it("keeps an open dialog stable when arrows are pressed on its button", () => {
    render(
      <>
        <AppShell
          userEmail="user@example.com"
          canAccessAdmin={false}
          selectedDate="2026-08-18"
          title="Food Log"
          activeTab="log"
          showDateNavigation
          todayStr="2026-08-18"
        >
          <div>content</div>
        </AppShell>
        <div role="dialog" aria-label="Meal Templates">
          <button type="button">Template action</button>
        </div>
      </>,
    );
    mocked.push.mockClear();

    const dialogButton = screen.getByRole("button", { name: "Template action" });
    dialogButton.focus();
    fireEvent.keyDown(dialogButton, { key: "ArrowRight" });
    fireEvent.keyDown(dialogButton, { key: "ArrowLeft" });

    expect(mocked.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("suppresses day navigation while a menu is open", () => {
    render(
      <>
        <AppShell
          userEmail="user@example.com"
          canAccessAdmin={false}
          selectedDate="2026-08-18"
          title="Food Log"
          activeTab="log"
          showDateNavigation
          todayStr="2026-08-18"
        >
          <div>content</div>
        </AppShell>
        <div role="menu">
          <button type="button" role="menuitem">
            Mark eaten
          </button>
        </div>
      </>,
    );
    mocked.push.mockClear();

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Mark eaten" }), {
      key: "ArrowLeft",
    });

    expect(mocked.push).not.toHaveBeenCalled();
  });

  it("does not navigate when the arrow event was already consumed", () => {
    renderLog();
    mocked.push.mockClear();

    const event = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(mocked.push).not.toHaveBeenCalled();
  });
});
