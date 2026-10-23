"use client";

import type { WeightUnit } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useRef, useState, type Ref } from "react";

import { completeOnboardingAction } from "@/lib/actions";
import {
  convertWeight,
  normalizeOnboardingWeightKg,
} from "@/lib/onboarding-weight";
import {
  getNumberFieldError,
  getPositiveOptionalFieldError,
  snapshotNumberValidity,
} from "@/lib/number-input-validity";
import { parsePositiveNumber } from "@/lib/numbers";
import { getLocalDateString } from "@/lib/startup-date";
import { useActionRunner } from "@/lib/use-action-runner";

import {
  MacroCalculatorPanel,
  formatMacroInputValue,
  type MacroTargetDraft,
} from "./macro-calculator-panel";
import { NumberInputField } from "./number-input-field";
import { getPresetDraftError, presetDraftToInput } from "./preset-modal";
import { ThemePicker } from "./theme-toggle";

type OnboardingShellProps = {
  userEmail: string;
  preferredWeightUnit: WeightUnit;
};

const ONBOARDING_NUMBER_INPUT_CLASS =
  "w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 pr-14 text-sm font-semibold text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]";

function OnboardingNumberInput({
  label,
  value,
  unit,
  inputRef,
  invalid,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  inputRef?: Ref<HTMLInputElement>;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <NumberInputField
      label={label}
      value={value}
      unit={unit}
      step={unit === "kcal" ? "1" : "0.1"}
      fieldClassName="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]"
      inputClassName={ONBOARDING_NUMBER_INPUT_CLASS}
      unitClassName="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]"
      inputRef={inputRef}
      invalid={invalid}
      onChange={onChange}
    />
  );
}

export function OnboardingShell({
  userEmail,
  preferredWeightUnit,
}: OnboardingShellProps) {
  const router = useRouter();
  const { run, isPending, error, setError, clearError } = useActionRunner();
  const [unit, setUnit] = useState<WeightUnit>(preferredWeightUnit);
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [goalWeight, setGoalWeight] = useState("");
  const [currentWeight, setCurrentWeight] = useState("");
  // UI-17: canonical kg values preserve entered precision across unit-only
  // toggles; display text may round, but saves use the canonical value.
  const [currentWeightCanonicalKg, setCurrentWeightCanonicalKg] = useState<number | null>(null);
  const [goalWeightCanonicalKg, setGoalWeightCanonicalKg] = useState<number | null>(null);
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>({});
  const [templateLabel, setTemplateLabel] = useState("");
  const [templateProtein, setTemplateProtein] = useState("");
  const [templateCarbs, setTemplateCarbs] = useState("");
  const [templateFat, setTemplateFat] = useState("");
  const [templateCalories, setTemplateCalories] = useState("");
  const caloriesRef = useRef<HTMLInputElement>(null);
  const proteinRef = useRef<HTMLInputElement>(null);
  const carbsRef = useRef<HTMLInputElement>(null);
  const fatRef = useRef<HTMLInputElement>(null);
  const currentWeightRef = useRef<HTMLInputElement>(null);
  const goalWeightRef = useRef<HTMLInputElement>(null);
  const templateProteinRef = useRef<HTMLInputElement>(null);
  const templateCarbsRef = useRef<HTMLInputElement>(null);
  const templateFatRef = useRef<HTMLInputElement>(null);
  const templateCaloriesRef = useRef<HTMLInputElement>(null);

  function displayFromCanonical(canonicalKg: number | null, fallback: string, nextUnit: WeightUnit) {
    if (fallback.trim() === "" || canonicalKg == null) {
      return fallback;
    }

    // Weight display follows the stored two-decimal precision; the macro
    // one-decimal formatter would show 72.5 for an entered 72.55 kg.
    return String(convertWeight(canonicalKg, "kg", nextUnit));
  }

  function changeUnit(nextUnit: WeightUnit) {
    if (nextUnit === unit) {
      return;
    }

    // Unit-only toggles re-render from the canonical value so 72.55 kg
    // survives kg -> lb -> kg without collapsing to one-decimal display text.
    // Invalid/empty text is left untouched and stays invalid until edited.
    setCurrentWeight((prev) => displayFromCanonical(currentWeightCanonicalKg, prev, nextUnit));
    setGoalWeight((prev) => displayFromCanonical(goalWeightCanonicalKg, prev, nextUnit));
    setUnit(nextUnit);
  }

  function editWeight(
    value: string,
    setDisplay: (value: string) => void,
    setCanonical: (value: number | null) => void,
    field: string,
  ) {
    setDisplay(value);
    setCanonical(normalizeOnboardingWeightKg(value, unit));
    setInvalidFields((prev) => ({ ...prev, [field]: false }));
    clearError();
  }

  function applyCalculatedTargets(targets: MacroTargetDraft) {
    setCalories(String(targets.caloriesKcal));
    setProtein(formatMacroInputValue(targets.proteinG));
    setCarbs(formatMacroInputValue(targets.carbsG));
    setFat(formatMacroInputValue(targets.fatG));
    setInvalidFields({});
    clearError();
  }

  function failWith(field: string, message: string) {
    setInvalidFields({ [field]: true });
    setError(message);
  }

  function submit() {
    // UI-28: fractional calories (200.5) and incomplete exponents (1e with
    // native badInput) fail here with a field error and make no mutation call.
    // Empty optional fields stay legitimate and map to null downstream.
    const calorieError = getNumberFieldError({
      value: calories,
      label: "Calories",
      validity: snapshotNumberValidity(caloriesRef.current),
      integer: true,
      min: 1,
      optional: true,
    });
    if (calorieError) {
      failWith("Calories", "Calories must be a whole number, or cleared.");
      return;
    }

    for (const check of [
      { label: "Protein", value: protein, ref: proteinRef },
      { label: "Carbs", value: carbs, ref: carbsRef },
      { label: "Fat", value: fat, ref: fatRef },
    ] as const) {
      const fieldError = getPositiveOptionalFieldError(
        check.value,
        check.label,
        snapshotNumberValidity(check.ref.current),
      );
      if (fieldError) {
        failWith(check.label, fieldError);
        return;
      }
    }

    for (const check of [
      { label: "Current weight", value: currentWeight, ref: currentWeightRef, field: "Current" },
      { label: "Goal weight", value: goalWeight, ref: goalWeightRef, field: "Goal" },
    ] as const) {
      const fieldError = getPositiveOptionalFieldError(
        check.value,
        check.label,
        snapshotNumberValidity(check.ref.current),
      );
      if (fieldError) {
        failWith(check.field, fieldError);
        return;
      }
    }

    if (templateLabel.trim()) {
      for (const check of [
        { label: "Protein", value: templateProtein, ref: templateProteinRef, field: "Template protein" },
        { label: "Carbs", value: templateCarbs, ref: templateCarbsRef, field: "Template carbs" },
        { label: "Fat", value: templateFat, ref: templateFatRef, field: "Template fat" },
        { label: "Calories", value: templateCalories, ref: templateCaloriesRef, field: "Template calories" },
      ] as const) {
        const native = snapshotNumberValidity(check.ref.current);
        if (native.badInput || native.rangeUnderflow || native.rangeOverflow) {
          failWith(check.field, `${check.label} is not a valid number yet. Finish or clear it before saving.`);
          return;
        }
      }

      const templateError = getPresetDraftError({
        label: templateLabel,
        proteinG: templateProtein,
        carbsG: templateCarbs,
        fatG: templateFat,
        caloriesKcal: templateCalories,
      });
      if (templateError) {
        setError(templateError);
        return;
      }
    }

    setInvalidFields({});
    run(
      () => {
        const starterTemplate = templateLabel.trim()
          ? presetDraftToInput({
              label: templateLabel,
              proteinG: templateProtein,
              carbsG: templateCarbs,
              fatG: templateFat,
              caloriesKcal: templateCalories,
            })
          : null;

        // Resolved on the device, not the server, so the first weigh-in lands on the user's own calendar day.
        const currentDate = getLocalDateString();

        return completeOnboardingAction({
          preferredWeightUnit: unit,
          goals: {
            caloriesKcal: parsePositiveNumber(calories),
            proteinG: parsePositiveNumber(protein),
            carbsG: parsePositiveNumber(carbs),
            fatG: parsePositiveNumber(fat),
          },
          // UI-17: saves use the canonical kg value so toggles never lose precision.
          goalWeightKg: goalWeight.trim()
            ? (goalWeightCanonicalKg ?? normalizeOnboardingWeightKg(goalWeight, unit))
            : null,
          currentWeightKg: currentWeight.trim()
            ? (currentWeightCanonicalKg ?? normalizeOnboardingWeightKg(currentWeight, unit))
            : null,
          currentWeightDate: currentDate,
          starterTemplate,
        });
      },
      {
        fallbackError: "Unable to finish setup.",
        refresh: true,
        onSuccess: () => router.replace("/"),
      },
    );
  }

  return (
    <main className="min-h-screen bg-[var(--color-app-bg)] px-4 py-[calc(1rem+env(safe-area-inset-top))] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col justify-center">
        <div className="mb-6">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[var(--color-muted-strong)]">
            Macro Tracker
          </p>
          <h1 className="mt-2 font-serif text-4xl">Set up your tracker</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">{userEmail}</p>
        </div>

        <div className="space-y-4">
          <MacroCalculatorPanel
            disabled={isPending}
            applyLabel="Apply to daily goals"
            onApplyTargets={applyCalculatedTargets}
          />

          <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
            <h2 className="text-sm font-bold text-[var(--color-ink)]">Daily goals</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <OnboardingNumberInput label="Calories" unit="kcal" value={calories} inputRef={caloriesRef} invalid={invalidFields.Calories} onChange={(v) => { setCalories(v); setInvalidFields((prev) => ({ ...prev, Calories: false })); clearError(); }} />
              <OnboardingNumberInput label="Protein" unit="g" value={protein} inputRef={proteinRef} invalid={invalidFields.Protein} onChange={(v) => { setProtein(v); setInvalidFields((prev) => ({ ...prev, Protein: false })); clearError(); }} />
              <OnboardingNumberInput label="Carbs" unit="g" value={carbs} inputRef={carbsRef} invalid={invalidFields.Carbs} onChange={(v) => { setCarbs(v); setInvalidFields((prev) => ({ ...prev, Carbs: false })); clearError(); }} />
              <OnboardingNumberInput label="Fat" unit="g" value={fat} inputRef={fatRef} invalid={invalidFields.Fat} onChange={(v) => { setFat(v); setInvalidFields((prev) => ({ ...prev, Fat: false })); clearError(); }} />
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
            <h2 className="text-sm font-bold text-[var(--color-ink)]">Weight</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label>
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                  Unit
                </span>
                <select
                  value={unit}
                  onChange={(event) => changeUnit(event.target.value as WeightUnit)}
                  className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm font-semibold text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="kg">kg</option>
                  <option value="lb">lb</option>
                </select>
              </label>
              <OnboardingNumberInput label="Current" unit={unit} value={currentWeight} inputRef={currentWeightRef} invalid={invalidFields.Current} onChange={(v) => editWeight(v, setCurrentWeight, setCurrentWeightCanonicalKg, "Current")} />
              <OnboardingNumberInput label="Goal" unit={unit} value={goalWeight} inputRef={goalWeightRef} invalid={invalidFields.Goal} onChange={(v) => editWeight(v, setGoalWeight, setGoalWeightCanonicalKg, "Goal")} />
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
            <h2 className="text-sm font-bold text-[var(--color-ink)]">Starter template</h2>
            <input
              type="text"
              value={templateLabel}
              onChange={(event) => setTemplateLabel(event.target.value)}
              placeholder="Optional favorite food"
              className="mt-4 w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <OnboardingNumberInput label="Protein" unit="g" value={templateProtein} inputRef={templateProteinRef} invalid={invalidFields["Template protein"]} onChange={(v) => { setTemplateProtein(v); clearError(); }} />
              <OnboardingNumberInput label="Carbs" unit="g" value={templateCarbs} inputRef={templateCarbsRef} invalid={invalidFields["Template carbs"]} onChange={(v) => { setTemplateCarbs(v); clearError(); }} />
              <OnboardingNumberInput label="Fat" unit="g" value={templateFat} inputRef={templateFatRef} invalid={invalidFields["Template fat"]} onChange={(v) => { setTemplateFat(v); clearError(); }} />
              <OnboardingNumberInput label="Calories" unit="kcal" value={templateCalories} inputRef={templateCaloriesRef} invalid={invalidFields["Template calories"]} onChange={(v) => { setTemplateCalories(v); clearError(); }} />
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
            <h2 className="mb-4 text-sm font-bold text-[var(--color-ink)]">Theme</h2>
            <ThemePicker />
          </section>
        </div>

        {error ? <p className="mt-4 text-sm text-[var(--color-danger)]">{error}</p> : null}

        <button
          type="button"
          disabled={isPending}
          onClick={submit}
          className="mt-5 rounded-2xl bg-[var(--color-accent)] px-5 py-4 text-sm font-bold text-white transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? "Saving..." : "Start tracking"}
        </button>
      </div>
    </main>
  );
}
