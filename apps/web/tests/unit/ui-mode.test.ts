import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeComposeAction } from "@/lib/compose";
import {
  UI_MODE_COOKIE_NAME,
  UI_MODE_STORAGE_KEY,
  mapRouteForUiMode,
  normalizeProgressTab,
  setUiMode,
} from "@/lib/ui-mode";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ui-mode", () => {
  it("maps legacy goals routes into progress when enabling the experiment", () => {
    const searchParams = new URLSearchParams({ date: "2026-04-20" });

    expect(
      mapRouteForUiMode({
        pathname: "/goals",
        searchParams,
        nextMode: "experimental",
      }),
    ).toBe("/progress?date=2026-04-20&tab=goals");
  });

  it("maps progress routes back into legacy pages when disabling the experiment", () => {
    const searchParams = new URLSearchParams({
      date: "2026-04-20",
      tab: "weight",
    });

    expect(
      mapRouteForUiMode({
        pathname: "/progress",
        searchParams,
        nextMode: "legacy",
      }),
    ).toBe("/weight?date=2026-04-20");
  });

  it("maps stats into summary for the experimental layout", () => {
    const searchParams = new URLSearchParams({ date: "2026-04-20" });

    expect(
      mapRouteForUiMode({
        pathname: "/stats",
        searchParams,
        nextMode: "experimental",
      }),
    ).toBe("/summary?date=2026-04-20");
  });

  it("stores the chosen ui mode in both local storage and a cookie", () => {
    const setItem = vi.fn();
    const dispatchEvent = vi.fn();

    vi.stubGlobal("Event", class MockEvent {
      type: string;

      constructor(type: string) {
        this.type = type;
      }
    });
    vi.stubGlobal("window", {
      localStorage: { setItem },
      dispatchEvent,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", { cookie: "" });

    setUiMode("experimental");

    expect(setItem).toHaveBeenCalledWith(UI_MODE_STORAGE_KEY, "experimental");
    expect((document as { cookie: string }).cookie).toContain(
      `${UI_MODE_COOKIE_NAME}=experimental`,
    );
    expect(dispatchEvent).toHaveBeenCalled();
  });
});

describe("compose + progress helpers", () => {
  it("normalizes progress tabs", () => {
    expect(normalizeProgressTab("weight")).toBe("weight");
    expect(normalizeProgressTab("unexpected")).toBe("goals");
  });

  it("normalizes compose actions", () => {
    expect(normalizeComposeAction("custom")).toBe("custom");
    expect(normalizeComposeAction("recipe")).toBe("recipe");
    expect(normalizeComposeAction("unexpected")).toBeNull();
  });
});
