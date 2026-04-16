"use client";

import type {
  DailySummary,
  FoodPreset,
  MacroGoals,
  MealEntryRecord,
  QuickAddCandidate,
  RecentQuickAddItem,
  RecipeRecord,
} from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { deletePresetAction, deleteMealEntryAction, savePresetAction, saveMealEntryAction, touchPresetAction, updatePresetAction } from "@/lib/actions";
import { prepareNavigationMotion } from "@/lib/navigation-motion";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import {
  computeLiveTotalsFromDrafts,
  computeRemainingFromGoals,
  dedupeBestFitCandidates,
  hasAnyMacroGoals,
  presetToQuickAddCandidate,
  rankQuickAddCandidates,
} from "@/lib/quick-add";
import { getLocalDateString } from "@/lib/startup-date";

import { AddFoodButton } from "./add-food-button";
import { AppShell } from "./app-shell";
import { BarcodeResult } from "./barcode-result";
import { BarcodeScanner } from "./barcode-scanner";
import { FoodSearchModal } from "./food-search-modal";
import { MacroBarGroup } from "./macro-bar";
import { MealCard, type MealDraft } from "./meal-card";
import { PresetModal } from "./preset-modal";
import { QuickAddRail } from "./quick-add-rail";
import { RemainingMacrosCard } from "./remaining-macros-card";
import { RecipePickerModal } from "./recipe-picker-modal";
import { TransitionLink } from "./transition-link";

type DashboardShellProps = {
  userEmail: string;
  selectedDate: string;
  dailySummary: DailySummary;
  goals: MacroGoals;
  presets: FoodPreset[];
  recentQuickAddItems: RecentQuickAddItem[];
  recipes: RecipeRecord[];
};

type ErrorState = Record<string, string | null>;
type PresetMutationState =
  | { type: "save" }
  | { type: "update" | "delete"; presetId: string };

function mealToDraft(meal: MealEntryRecord): MealDraft {
  return {
    clientId: meal.id,
    id: meal.id,
    label: meal.label,
    // Use String() unconditionally: a falsy check like `meal.proteinG ? ...`
    // incorrectly converts a legitimate 0 value into an empty string.
    proteinG: String(meal.proteinG),
    carbsG: String(meal.carbsG),
    fatG: String(meal.fatG),
    caloriesKcal: String(meal.caloriesKcal),
    sortOrder: meal.sortOrder,
  };
}

function createEmptyDraft(sortOrder: number): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: "",
    proteinG: "",
    carbsG: "",
    fatG: "",
    caloriesKcal: "",
    sortOrder,
  };
}

function getNextSortOrder(drafts: MealDraft[]) {
  return drafts.reduce((highest, draft) => Math.max(highest, draft.sortOrder), -1) + 1;
}

function createDraftFromPrefill(
  prefill: Pick<
    QuickAddCandidate,
    "label" | "proteinG" | "carbsG" | "fatG" | "caloriesKcal"
  >,
  sortOrder: number,
): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: prefill.label,
    proteinG: String(prefill.proteinG),
    carbsG: String(prefill.carbsG),
    fatG: String(prefill.fatG),
    caloriesKcal: String(prefill.caloriesKcal),
    sortOrder,
  };
}

function toNumber(value: string, fallback = 0) {
  if (!value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function DashboardShell({
  userEmail,
  selectedDate,
  dailySummary,
  goals,
  presets: initialPresets,
  recentQuickAddItems,
  recipes,
}: DashboardShellProps) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<MealDraft[]>(() =>
    dailySummary.meals.map(mealToDraft),
  );
  const [errors, setErrors] = useState<ErrorState>({});
  const [activeMutation, setActiveMutation] = useState<string | null>(null);
  const [isPending, beginMutation] = useTransition();

  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [localPresets, setLocalPresets] = useState<FoodPreset[]>(initialPresets);
  const [presetMutation, setPresetMutation] = useState<PresetMutationState | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  // Recipe picker state
  const [showRecipePickerModal, setShowRecipePickerModal] = useState(false);

  // Food search state
  const [showSearchModal, setShowSearchModal] = useState(false);

  // Tracks cards that were recently copied to today so the button can give
  // brief visual confirmation before returning to its normal state.
  const [copiedCardIds, setCopiedCardIds] = useState<Set<string>>(new Set());

  // Barcode scanner state
  const [showScanner, setShowScanner] = useState(false);
  const [scanResult, setScanResult] = useState<OpenFoodFactsProduct | null>(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState<string | null>(null);

  function updateDraft(
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) {
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) =>
        draft.clientId === clientId ? { ...draft, [field]: value } : draft,
      ),
    );
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));
  }

  function addCustomDraft() {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createEmptyDraft(getNextSortOrder(currentDrafts)),
    ]);
  }

  function appendPrefilledDraft(
    prefill: Pick<
      QuickAddCandidate,
      "label" | "proteinG" | "carbsG" | "fatG" | "caloriesKcal"
    > & {
      source?: QuickAddCandidate["source"];
      sourceId?: string;
    },
  ) {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createDraftFromPrefill(prefill, getNextSortOrder(currentDrafts)),
    ]);
    setPresetError(null);

    if (prefill.source === "preset" && prefill.sourceId) {
      void touchPresetAction({ id: prefill.sourceId });
    }
  }

  function addDraftFromPreset(preset: FoodPreset) {
    appendPrefilledDraft(presetToQuickAddCandidate(preset));
    setShowPresetsModal(false);
  }

  function addDraftFromRecipe(recipe: RecipeRecord) {
    const macros = recipe.perPortionMacros;
    appendPrefilledDraft({
      label: `${recipe.label} (1 portion)`,
      proteinG: macros.proteinG,
      carbsG: macros.carbsG,
      fatG: macros.fatG,
      caloriesKcal: macros.caloriesKcal,
    });
    setShowRecipePickerModal(false);
  }

  function handleQuickAddSelect(candidate: QuickAddCandidate) {
    appendPrefilledDraft(candidate);
  }

  function removeLocalDraft(clientId: string) {
    setDrafts((currentDrafts) =>
      currentDrafts.filter((draft) => draft.clientId !== clientId),
    );
    setErrors((currentErrors) => {
      const nextErrors = { ...currentErrors };
      delete nextErrors[clientId];
      return nextErrors;
    });
  }

  function handleSave(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await saveMealEntryAction({
        id: draft.id,
        date: selectedDate,
        label: draft.label,
        sortOrder: draft.sortOrder,
        proteinG: toNumber(draft.proteinG),
        carbsG: toNumber(draft.carbsG),
        fatG: toNumber(draft.fatG),
        caloriesKcal: Math.round(toNumber(draft.caloriesKcal)),
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to save food item.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  function handleDelete(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return;
    }

    if (!draft.id) {
      removeLocalDraft(clientId);
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await deleteMealEntryAction({
        id: draft.id!,
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to delete food item.",
        }));
        setActiveMutation(null);
        return;
      }

      router.refresh();
    });
  }

  async function handleSavePreset(input: Omit<FoodPreset, "id" | "userId">) {
    setPresetError(null);
    setPresetMutation({ type: "save" });

    try {
      const result = await savePresetAction(input);
      const savedPreset = result.preset;
      if (!result.ok || !savedPreset) {
        setPresetError(result.error ?? "Unable to save preset.");
        return false;
      }

      setLocalPresets((prev) =>
        [...prev, savedPreset].sort((a, b) => a.label.localeCompare(b.label)),
      );
      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  async function handleDeletePreset(presetId: string) {
    const previousPresets = localPresets;

    setPresetError(null);
    setPresetMutation({ type: "delete", presetId });
    setLocalPresets((prev) => prev.filter((p) => p.id !== presetId));

    try {
      const result = await deletePresetAction({ id: presetId });
      if (!result.ok) {
        setLocalPresets(previousPresets);
        setPresetError(result.error ?? "Unable to delete preset.");
        return false;
      }

      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  async function handleUpdatePreset(id: string, input: Omit<FoodPreset, "id" | "userId">) {
    setPresetError(null);
    setPresetMutation({ type: "update", presetId: id });

    try {
      const result = await updatePresetAction({ id, ...input });
      const updatedPreset = result.preset;
      if (!result.ok || !updatedPreset) {
        setPresetError(result.error ?? "Unable to update preset.");
        return false;
      }

      setLocalPresets((prev) =>
        prev
          .map((preset) => (preset.id === id ? updatedPreset : preset))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  const todayStr = useMemo(() => getLocalDateString(), []);
  const isViewingToday = selectedDate === todayStr;

  function handleDuplicate(clientId: string) {
    setDrafts((currentDrafts) => {
      const draft = currentDrafts.find((d) => d.clientId === clientId);
      if (!draft) return currentDrafts;

      const maxSortOrder = currentDrafts.reduce(
        (max, d) => Math.max(max, d.sortOrder),
        -1,
      );

      return [
        ...currentDrafts,
        {
          clientId: `draft-${crypto.randomUUID()}`,
          label: draft.label,
          proteinG: draft.proteinG,
          carbsG: draft.carbsG,
          fatG: draft.fatG,
          caloriesKcal: draft.caloriesKcal,
          sortOrder: maxSortOrder + 1,
        },
      ];
    });
  }

  function handleCopyToToday(clientId: string) {
    const draft = drafts.find((d) => d.clientId === clientId);
    if (!draft) return;

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await saveMealEntryAction({
        date: todayStr,
        label: draft.label,
        proteinG: toNumber(draft.proteinG),
        carbsG: toNumber(draft.carbsG),
        fatG: toNumber(draft.fatG),
        caloriesKcal: Math.round(toNumber(draft.caloriesKcal)),
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to copy entry to today.",
        }));
      } else {
        // Show a brief "copied" confirmation on the button, then clear it.
        setCopiedCardIds((prev) => new Set([...prev, clientId]));
        setTimeout(() => {
          setCopiedCardIds((prev) => {
            const next = new Set(prev);
            next.delete(clientId);
            return next;
          });
        }, 2000);
      }

      setActiveMutation(null);
    });
  }

  const liveTotals = computeLiveTotalsFromDrafts(drafts);
  const remainingToday = computeRemainingFromGoals(liveTotals, goals);
  const goalsAreSet = hasAnyMacroGoals(goals);
  const bestFits = goalsAreSet
    ? rankQuickAddCandidates(
        dedupeBestFitCandidates([
          ...localPresets.map(presetToQuickAddCandidate),
          ...recentQuickAddItems,
        ]),
        remainingToday,
      ).slice(0, 8)
    : [];
  const recentRepeats = recentQuickAddItems.slice(0, 8);

  return (
    <AppShell userEmail={userEmail} selectedDate={selectedDate} activeTab="log">
      <div className="space-y-5">
        {/* Daily Report — macro bar charts */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Daily Report
            </h2>
            <span className="text-2xl font-bold tabular-nums text-[var(--color-ink)]">
              {liveTotals.caloriesKcal}
              <span className="ml-1 text-xs font-semibold text-[var(--color-muted)]">kcal</span>
            </span>
          </div>

          <MacroBarGroup
            proteinG={liveTotals.proteinG}
            carbsG={liveTotals.carbsG}
            fatG={liveTotals.fatG}
            caloriesKcal={liveTotals.caloriesKcal}
            goals={goals}
          />
        </section>

        <RemainingMacrosCard
          goals={goals}
          remaining={remainingToday}
          selectedDate={selectedDate}
        />

        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Quick Add
            </h2>
            <span className="text-xs text-[var(--color-muted)]">
              Prefills a draft card
            </span>
          </div>

          {goalsAreSet ? (
            bestFits.length > 0 ? (
              <QuickAddRail title="Best Fits" items={bestFits} onSelect={handleQuickAddSelect} />
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] p-4">
                <p className="text-sm text-[var(--color-muted)]">
                  Best fits will appear once you have presets or recent foods to rank.
                </p>
              </div>
            )
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-[var(--color-muted)]">
                  Set goals to unlock Best Fits based on what is left for today.
                </p>
                <TransitionLink
                  href={`/goals?date=${selectedDate}`}
                  className="shrink-0 rounded-full border border-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
                >
                  Go to goals
                </TransitionLink>
              </div>
            </div>
          )}

          {recentRepeats.length > 0 ? (
            <QuickAddRail
              title="Recent Repeats"
              items={recentRepeats}
              onSelect={handleQuickAddSelect}
            />
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] p-4">
              <p className="text-sm text-[var(--color-muted)]">
                Recent repeats will show up here after you log a few foods.
              </p>
            </div>
          )}
        </section>

        {/* Food log */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Food Items
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowSearchModal(true)}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)]"
                aria-label="Search food history"
              >
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="7.5" cy="7.5" r="5" />
                  <line x1="11.5" y1="11.5" x2="15" y2="15" />
                </svg>
              </button>
              <AddFoodButton
              onCustom={addCustomDraft}
              onPreset={() => {
                setPresetError(null);
                setShowPresetsModal(true);
              }}
              onScan={() => {
                setScanResult(null);
                setNotFoundBarcode(null);
                setShowScanner(true);
              }}
              onRecipe={() => setShowRecipePickerModal(true)}
            />
            </div>
          </div>

          {drafts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
              <p className="text-sm text-[var(--color-muted)]">No food items logged yet.</p>
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPresetError(null);
                    setShowPresetsModal(true);
                  }}
                  className="rounded-full border border-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
                >
                  From preset
                </button>
                <button
                  type="button"
                  onClick={addCustomDraft}
                  className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5"
                >
                  Add custom
                </button>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            {drafts.map((draft) => {
              const busy = isPending && activeMutation === draft.clientId;

              return (
                <MealCard
                  key={draft.clientId}
                  draft={draft}
                  busy={busy}
                  error={errors[draft.clientId]}
                  isCopied={copiedCardIds.has(draft.clientId)}
                  onChange={updateDraft}
                  onSave={handleSave}
                  onDelete={handleDelete}
                  onDuplicate={handleDuplicate}
                  onCopyToToday={isViewingToday ? undefined : handleCopyToToday}
                />
              );
            })}
          </div>
        </section>
      </div>

      {/* Food search modal */}
      {showSearchModal && (
        <FoodSearchModal
          onClose={() => setShowSearchModal(false)}
          onViewDate={(date) => {
            setShowSearchModal(false);
            const href = `/?date=${date}`;
            prepareNavigationMotion(href, "day-jump");
            router.push(href);
          }}
        />
      )}

      {/* Presets modal */}
      {showPresetsModal && (
        <PresetModal
          presets={localPresets}
          mutation={presetMutation}
          errorMessage={presetError}
          onClose={() => {
            setPresetError(null);
            setShowPresetsModal(false);
          }}
          onSelect={addDraftFromPreset}
          onSave={handleSavePreset}
          onUpdate={handleUpdatePreset}
          onDelete={handleDeletePreset}
        />
      )}

      {/* Recipe picker modal */}
      {showRecipePickerModal && (
        <RecipePickerModal
          recipes={recipes}
          onClose={() => setShowRecipePickerModal(false)}
          onSelect={addDraftFromRecipe}
        />
      )}

      {/* Barcode scanner modal */}
      {showScanner && (
        <BarcodeScanner
          onScan={(product) => {
            setShowScanner(false);
            setScanResult(product);
            setNotFoundBarcode(null);
          }}
          onNotFound={(barcode) => {
            setShowScanner(false);
            setScanResult(null);
            setNotFoundBarcode(barcode);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}

      {/* Barcode result modal */}
      {(scanResult || notFoundBarcode) && (
        <BarcodeResult
          product={scanResult}
          notFoundBarcode={notFoundBarcode}
          onAddToLog={(macros) => {
            appendPrefilledDraft({
              label: macros.label,
              proteinG: macros.proteinG,
              carbsG: macros.carbsG,
              fatG: macros.fatG,
              caloriesKcal: macros.caloriesKcal,
            });
            setScanResult(null);
            setNotFoundBarcode(null);
          }}
          onSaveAsPreset={(input) => {
            handleSavePreset(input);
          }}
          onScanAnother={() => {
            setScanResult(null);
            setNotFoundBarcode(null);
            setShowScanner(true);
          }}
          onClose={() => {
            setScanResult(null);
            setNotFoundBarcode(null);
          }}
        />
      )}
    </AppShell>
  );
}
