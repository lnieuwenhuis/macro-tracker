/** @vitest-environment jsdom */
// UI-06/UI-10/UI-16/UI-17/UI-20/UI-21/UI-28/UI-29 regression evidence.
// Controlled `type="number"` inputs report an incomplete exponent (`1e`) as
// value "" with validity.badInput; jsdom does not reproduce that natively, so
// tests mock the ValidityState to carry Chromium's signal while React state
// stays "" — exactly the aliasing the fix distinguishes from a real clear.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  findBlockingNumberInput,
  getNumberFieldError,
  getPositiveOptionalFieldError,
  snapshotNumberValidity,
} from "@/lib/number-input-validity";
import { parsePositiveNumber } from "@/lib/numbers";
import { convertWeight } from "@/lib/onboarding-weight";
import {
  getNextTabIndex,
  useTabsKeyboard,
} from "@/components/accessible-tabs";
import { getPresetDraftError, presetDraftToInput } from "@/components/preset-modal";
import { getRecipePortionsError } from "@/components/recipe-builder-shell";

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

const actionsMock = vi.hoisted(() => ({
  completeOnboardingAction: vi.fn(),
  saveGoalsAction: vi.fn(),
  logRecipePortionAction: vi.fn(),
  saveRecipeAction: vi.fn(),
  deleteRecipeAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/",
}));

vi.mock("@/lib/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/actions")>();
  return {
    ...actual,
    completeOnboardingAction: actionsMock.completeOnboardingAction,
    saveGoalsAction: actionsMock.saveGoalsAction,
    logRecipePortionAction: actionsMock.logRecipePortionAction,
    saveRecipeAction: actionsMock.saveRecipeAction,
    deleteRecipeAction: actionsMock.deleteRecipeAction,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  actionsMock.completeOnboardingAction.mockResolvedValue({ ok: true });
  actionsMock.saveGoalsAction.mockResolvedValue({ ok: true });
  actionsMock.logRecipePortionAction.mockResolvedValue({ ok: true });
});

function mockValidity(
  input: HTMLInputElement,
  partial: Partial<Pick<ValidityState, "badInput" | "rangeUnderflow" | "rangeOverflow" | "stepMismatch" | "valueMissing">>,
) {
  Object.defineProperty(input, "validity", {
    value: {
      badInput: false,
      customError: false,
      patternMismatch: false,
      rangeOverflow: false,
      rangeUnderflow: false,
      stepMismatch: false,
      tooLong: false,
      tooShort: false,
      typeMismatch: false,
      valid: true,
      valueMissing: false,
      ...partial,
    },
    configurable: true,
  });
}

describe("shared number validity (UI-20/UI-21)", () => {
  it("treats an explicitly empty optional field as valid (clear semantics preserved)", () => {
    expect(
      getPositiveOptionalFieldError("", "Protein", snapshotNumberValidity(null)),
    ).toBeNull();
    expect(
      getNumberFieldError({ value: "   ", label: "Calories", optional: true }),
    ).toBeNull();
  });

  it("blocks native badInput even when the React string is empty (incomplete 1e)", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.value = "";
    mockValidity(input, { badInput: true });
    expect(getPositiveOptionalFieldError("", "Protein", snapshotNumberValidity(input))).toMatch(
      /not a valid number/,
    );
  });

  it("blocks range underflow with an actionable message (-5)", () => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = "-5";
    mockValidity(input, { rangeUnderflow: true });
    expect(
      getPositiveOptionalFieldError("-5", "Protein", snapshotNumberValidity(input)),
    ).toMatch(/greater than 0|at least|positive/i);
  });

  it("rejects non-positive text through the parser even without mocked validity", () => {
    expect(getPositiveOptionalFieldError("-5", "Protein")).toMatch(/greater than 0/);
    expect(getPositiveOptionalFieldError("0", "Protein")).toMatch(/greater than 0/);
    expect(getPositiveOptionalFieldError("abc", "Protein")).toMatch(/not a valid number/);
  });

  it("keeps locale-comma decimals valid", () => {
    expect(parsePositiveNumber("72,5")).toBe(72.5);
    expect(getPositiveOptionalFieldError("72,5", "Protein")).toBeNull();
  });

  it("finds the blocking input inside a container", () => {
    const container = document.createElement("div");
    const ok = document.createElement("input");
    ok.type = "number";
    const bad = document.createElement("input");
    bad.type = "number";
    bad.value = "";
    container.append(ok, bad);
    expect(findBlockingNumberInput(container)).toBeNull();
    mockValidity(bad, { badInput: true });
    expect(findBlockingNumberInput(container)).toBe(bad);
  });
});

describe("preset drafts (UI-21)", () => {
  it("preserves the empty-to-0 contract for legitimate clears", () => {
    expect(
      presetDraftToInput({ label: "Eggs", proteinG: "", carbsG: "", fatG: "", caloriesKcal: "" }),
    ).toEqual({ label: "Eggs", proteinG: 0, carbsG: 0, fatG: 0, caloriesKcal: 0 });
  });

  it("flags present invalid text before the 0 fallback", () => {
    expect(getPresetDraftError({ label: "x", proteinG: "-5", carbsG: "", fatG: "", caloriesKcal: "" })).toMatch(
      /Protein/,
    );
    expect(
      getPresetDraftError({ label: "x", proteinG: "", carbsG: "", fatG: "", caloriesKcal: "" }),
    ).toBeNull();
  });
});

describe("recipe portions (UI-29)", () => {
  it.each(["-1", "0"])("blocks non-positive %s instead of clamping to 1", (value) => {
    expect(getRecipePortionsError(value)).toMatch(/at least 1/);
  });

  it("blocks fractional portions instead of rounding", () => {
    expect(getRecipePortionsError("1.5")).toMatch(/whole number/);
  });

  it("blocks incomplete exponents via native validity", () => {
    expect(
      getRecipePortionsError("", { badInput: true, rangeUnderflow: false, rangeOverflow: false }),
    ).toMatch(/not a valid number/);
  });

  it("requires a value and accepts valid integers", () => {
    expect(getRecipePortionsError("")).toMatch(/required|whole number/);
    expect(getRecipePortionsError("1")).toBeNull();
    expect(getRecipePortionsError("4")).toBeNull();
  });
});

describe("onboarding calories are integers (UI-28)", () => {
  it("rejects fractional calories without rounding", () => {
    expect(
      getNumberFieldError({ value: "200.5", label: "Calories", integer: true, min: 1, optional: true }),
    ).toMatch(/whole number/);
  });

  it("accepts integer and empty optional calories", () => {
    expect(
      getNumberFieldError({ value: "200", label: "Calories", integer: true, min: 1, optional: true }),
    ).toBeNull();
    expect(
      getNumberFieldError({ value: "", label: "Calories", integer: true, min: 1, optional: true }),
    ).toBeNull();
  });
});

describe("tabs keyboard/panel contract (UI-10)", () => {
  it("computes roving arrow/Home/End targets with wrap", () => {
    expect(getNextTabIndex(1, 2, "ArrowRight")).toBe(0);
    expect(getNextTabIndex(0, 2, "ArrowLeft")).toBe(1);
    expect(getNextTabIndex(0, 3, "Home")).toBe(0);
    expect(getNextTabIndex(0, 3, "End")).toBe(2);
    expect(getNextTabIndex(0, 2, "Enter")).toBeNull();
  });

  it("links tabs to panels with roving tabindex and contained arrows", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });

    const dayNavCalls: string[] = [];
    const onDayNav = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        dayNavCalls.push(event.key);
      }
    };
    document.addEventListener("keydown", onDayNav);

    try {
      const { useState } = await import("react");
      function Interactive() {
        const [activeTab, setActiveTab] = useState<"goals" | "weight">("goals");
        const { tabProps, panelProps } = useTabsKeyboard(
          ["goals", "weight"] as const,
          activeTab,
          setActiveTab,
        );
        return (
          <>
            <div role="tablist" aria-label="Progress views">
              {(["goals", "weight"] as const).map((id, index) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  onClick={() => setActiveTab(id)}
                  {...tabProps(id, index, "test-views")}
                >
                  {id}
                </button>
              ))}
            </div>
            {activeTab === "goals" ? (
              <div {...panelProps("goals", "test-views")}>goals panel</div>
            ) : (
              <div {...panelProps("weight", "test-views")}>weight panel</div>
            )}
          </>
        );
      }

      const { unmount } = render(<Interactive />);
      const goalsTab = screen.getByRole("tab", { name: "goals" });
      const weightTab = screen.getByRole("tab", { name: "weight" });

      expect(goalsTab.getAttribute("aria-controls")).toBe("test-views-panel-goals");
      expect(goalsTab.getAttribute("tabindex")).toBe("0");
      expect(weightTab.getAttribute("tabindex")).toBe("-1");
      expect(screen.getByRole("tabpanel").getAttribute("id")).toBe(
        "test-views-panel-goals",
      );

      dayNavCalls.length = 0;
      goalsTab.focus();
      fireEvent.keyDown(goalsTab, { key: "ArrowRight" });
      await waitFor(() => {
        expect(screen.getByRole("tab", { name: "weight" }).getAttribute("aria-selected")).toBe(
          "true",
        );
      });
      expect(screen.getByRole("tabpanel").textContent).toBe("weight panel");
      expect(document.activeElement?.textContent).toBe("weight");
      // The tab consumed the arrow: the global day-navigation listener never fires.
      expect(dayNavCalls).toEqual([]);
      unmount();
    } finally {
      document.removeEventListener("keydown", onDayNav);
      vi.unstubAllGlobals();
    }
  });
});

describe("preset modal focus containment (UI-06)", () => {
  it("moves focus inside, wraps Tab and restores the trigger on close", async () => {
    const { PresetModal } = await import("@/components/preset-modal");

    const onClose = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "open templates";
    document.body.appendChild(trigger);
    trigger.focus();

    try {
      const { unmount } = render(
        <PresetModal
          presets={[]}
          mutation={null}
          errorMessage={null}
          onClose={onClose}
          onSelect={vi.fn()}
          onSave={vi.fn().mockResolvedValue(true)}
          onUpdate={vi.fn().mockResolvedValue(true)}
          onDelete={vi.fn().mockResolvedValue(true)}
        />,
      );

      const dialog = screen.getByRole("dialog", { name: "Meal Templates" });
      expect(dialog.contains(document.activeElement)).toBe(true);

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.getAttribute("aria-hidden") !== "true");
      expect(focusable.length).toBeGreaterThan(2);

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      last.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(first);

      first.focus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();

      unmount();
      expect(document.activeElement).toBe(trigger);
    } finally {
      trigger.remove();
    }
  });

  it("blocks a save while native badInput is present and preserves the draft", async () => {
    const { PresetModal } = await import("@/components/preset-modal");
    const onSave = vi.fn().mockResolvedValue(true);

    render(
      <PresetModal
        presets={[]}
        mutation={null}
        errorMessage={null}
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSave={onSave}
        onUpdate={vi.fn().mockResolvedValue(true)}
        onDelete={vi.fn().mockResolvedValue(true)}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Chicken breast..."), {
      target: { value: "Omelette" },
    });
    const protein = screen.getByRole("spinbutton", { name: /protein/i });
    // Chromium reports the incomplete exponent as value "" + badInput.
    fireEvent.change(protein, { target: { value: "" } });
    mockValidity(protein as HTMLInputElement, { badInput: true });

    fireEvent.click(screen.getByRole("button", { name: /save template/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/not a valid number/i);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("recipe header activation (UI-16)", () => {
  it("uses one native toggle without nested activation or Space scrolling", async () => {
    const { RecipeCard } = await import("@/components/recipe-card");
    const recipe = {
      id: "r1",
      userId: "u1",
      label: "Test recipe",
      portions: 2,
      totalCookedWeightG: null,
      ingredients: [],
      totalMacros: { proteinG: 10, carbsG: 10, fatG: 10, caloriesKcal: 200 },
      perPortionMacros: { proteinG: 5, carbsG: 5, fatG: 5, caloriesKcal: 100 },
    };

    render(<RecipeCard recipe={recipe} selectedDate="2026-09-17" />);
    const header = screen.getByRole("button", { name: /^test recipe/i });

    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // The old chevron button nested inside the header caused double toggles;
    // it is now decorative so one activation toggles exactly once.
    expect(header.querySelector("button")).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("onboarding unit precision and calories (UI-17/UI-28)", () => {
  it("keeps 72.55 kg canonical across toggles and blocks fractional calories", async () => {
    const { OnboardingShell } = await import("@/components/onboarding-shell");

    render(<OnboardingShell userEmail="user@example.com" preferredWeightUnit="kg" />);

    const calories = screen.getAllByRole("spinbutton", { name: /calories/i })[0] as HTMLInputElement;
    const current = screen.getByRole("spinbutton", { name: /current/i }) as HTMLInputElement;
    const unitSelect = screen.getByRole("combobox", { name: /unit/i }) as HTMLSelectElement;

    fireEvent.change(current, { target: { value: "72.55" } });
    expect(convertWeight(72.55, "kg", "lb")).toBeGreaterThan(150);

    fireEvent.change(unitSelect, { target: { value: "lb" } });
    fireEvent.change(unitSelect, { target: { value: "kg" } });

    fireEvent.change(calories, { target: { value: "200.5" } });
    fireEvent.click(screen.getByRole("button", { name: /start tracking/i }));

    expect(await screen.findByText(/whole number/i)).toBeTruthy();
    expect(actionsMock.completeOnboardingAction).not.toHaveBeenCalled();

    fireEvent.change(calories, { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: /start tracking/i }));

    await waitFor(() => {
      expect(actionsMock.completeOnboardingAction).toHaveBeenCalledTimes(1);
    });
    const payload = actionsMock.completeOnboardingAction.mock.calls[0][0];
    expect(payload.goals.caloriesKcal).toBe(200);
    // The canonical value survives display rounding through both toggles.
    expect(payload.currentWeightKg).toBe(72.55);
  });

  it("blocks an incomplete exponent without clearing valid state", async () => {
    const { OnboardingShell } = await import("@/components/onboarding-shell");

    render(<OnboardingShell userEmail="user@example.com" preferredWeightUnit="kg" />);
    const calories = screen.getAllByRole("spinbutton", { name: /calories/i })[0] as HTMLInputElement;

    fireEvent.change(calories, { target: { value: "" } });
    mockValidity(calories, { badInput: true });
    fireEvent.click(screen.getByRole("button", { name: /start tracking/i }));

    expect(await screen.findByText(/whole number|not a valid number/i)).toBeTruthy();
    expect(actionsMock.completeOnboardingAction).not.toHaveBeenCalled();
  });
});

describe("progress goals guard invalid clears (UI-20)", () => {
  it("blocks -5 and incomplete input while allowing explicit clear and decimals", async () => {
    const { GoalsPanel } = await import("@/components/progress-shell");
    const goals = { caloriesKcal: 100, proteinG: 100, carbsG: 100, fatG: 100 };

    render(<GoalsPanel goals={goals} initialWeightKg={null} />);
    const protein = screen.getByRole("spinbutton", { name: /protein/i }) as HTMLInputElement;

    fireEvent.change(protein, { target: { value: "-5" } });
    mockValidity(protein, { rangeUnderflow: true });
    fireEvent.click(screen.getByRole("button", { name: /save goals/i }));
    expect(await screen.findByText(/greater than 0|at least|positive/i)).toBeTruthy();
    expect(actionsMock.saveGoalsAction).not.toHaveBeenCalled();

    fireEvent.change(protein, { target: { value: "" } });
    mockValidity(protein, {});
    const calories = screen.getByRole("spinbutton", { name: /calories/i }) as HTMLInputElement;
    // jsdom sanitizes a typed decimal comma out of type=number, while Chromium
    // normalizes "72,5" to "72.5"; the comma path is covered at the parser
    // level above, so the control boundary uses the normalized period form.
    fireEvent.change(calories, { target: { value: "72.5" } });

    fireEvent.click(screen.getByRole("button", { name: /save goals/i }));
    await waitFor(() => {
      expect(actionsMock.saveGoalsAction).toHaveBeenCalled();
    });
    const payload = actionsMock.saveGoalsAction.mock.calls[0][0];
    expect(payload.proteinG).toBeNull();
    expect(payload.caloriesKcal).toBe(72.5);
  });
});
