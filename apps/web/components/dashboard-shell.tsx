"use client";

import type { DailySummary, FoodPreset, MacroGoals, MealEntryRecord, QuickAddCandidate, RecipeRecord } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from "react";

import { deletePresetAction, deleteMealEntryAction, savePresetAction, saveMealEntryAction, touchPresetAction, updatePresetAction } from "@/lib/actions";
import {
  getDailyMutationCacheKeys,
  getPresetMutationCacheKeys,
} from "@/lib/app-warmup";
import type { ComposeAction } from "@/lib/compose";
import { computeLiveTotals, computeRemaining, rankCandidates } from "@/lib/quick-add";
import { prepareNavigationMotion } from "@/lib/navigation-motion";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import { getLocalDateString } from "@/lib/startup-date";
import type { UiMode } from "@/lib/ui-mode";

import { AddFoodButton } from "./add-food-button";
import { invalidateAppDataCache } from "./app-data-cache";
import { AppShell } from "./app-shell";
import { BarcodeResult } from "./barcode-result";
import { BarcodeScanner } from "./barcode-scanner";
import { ExperimentalAppShell } from "./experimental-app-shell";
import { FoodSearchModal } from "./food-search-modal";
import { MacroBarGroup } from "./macro-bar";
import { MealCard, type MealDraft } from "./meal-card";
import { PresetModal } from "./preset-modal";
import { QuickAddRail } from "./quick-add-rail";
import { RecipePickerModal } from "./recipe-picker-modal";

type DashboardShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  dailySummary: DailySummary;
  goals: MacroGoals;
  presets: FoodPreset[];
  recipes: RecipeRecord[];
  recentCandidates: QuickAddCandidate[];
  uiMode?: UiMode;
  initialComposeAction?: ComposeAction | null;
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

function createDraftFromPreset(preset: FoodPreset, sortOrder: number): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: preset.label,
    proteinG: String(preset.proteinG),
    carbsG: String(preset.carbsG),
    fatG: String(preset.fatG),
    caloriesKcal: String(preset.caloriesKcal),
    sortOrder,
  };
}

function createDraftFromCandidate(
  candidate: QuickAddCandidate,
  sortOrder: number,
): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    label: candidate.label,
    proteinG: String(candidate.proteinG),
    carbsG: String(candidate.carbsG),
    fatG: String(candidate.fatG),
    caloriesKcal: String(candidate.caloriesKcal),
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
  canAccessAdmin,
  selectedDate,
  dailySummary,
  goals,
  presets: initialPresets,
  recipes,
  recentCandidates,
  uiMode = "legacy",
  initialComposeAction = null,
}: DashboardShellProps) {
  const router = useRouter();
  const composeHandledRef = useRef<string | null>(null);
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

  // ---------------------------------------------------------------------------
  // Live totals + remaining (react to unsaved drafts immediately)
  // ---------------------------------------------------------------------------

  const liveTotals = useMemo(() => computeLiveTotals(drafts), [drafts]);
  const remaining = useMemo(
    () => computeRemaining(liveTotals, goals),
    [liveTotals, goals],
  );
  const todayStr = useMemo(() => getLocalDateString(), []);

  // ---------------------------------------------------------------------------
  // Quick-add rails
  // ---------------------------------------------------------------------------

  // Build a unified candidate pool: preset candidates + recent history candidates
  const allCandidates = useMemo<QuickAddCandidate[]>(() => {
    const presetCandidates: QuickAddCandidate[] = localPresets.map((p) => ({
      label: p.label,
      proteinG: p.proteinG,
      carbsG: p.carbsG,
      fatG: p.fatG,
      caloriesKcal: p.caloriesKcal,
      source: "preset" as const,
      presetId: p.id,
    }));
    return [...presetCandidates, ...recentCandidates];
  }, [localPresets, recentCandidates]);

  // Single unified quick-add list: always ranked, with usage signals carrying
  // no-goal users and macro fit contributing when goals exist.
  const quickAddItems = useMemo(
    () =>
      rankCandidates(allCandidates, remaining, {
        limit: 10,
        currentHourUtc: new Date().getUTCHours(),
        referenceDate: todayStr,
      }),
    [allCandidates, remaining, todayStr],
  );

  // ---------------------------------------------------------------------------
  // Draft helpers
  // ---------------------------------------------------------------------------

  function nextSortOrder() {
    return drafts.reduce((highest, draft) => Math.max(highest, draft.sortOrder), -1) + 1;
  }

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
    setDrafts((currentDrafts) => [...currentDrafts, createEmptyDraft(nextSortOrder())]);
  }

  function addDraftFromPreset(preset: FoodPreset) {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createDraftFromPreset(preset, nextSortOrder()),
    ]);
    setPresetError(null);
    // Fire-and-forget: mark this preset as most-recently-used so the next time
    // the modal opens it floats to the top of the list. We don't block the UI
    // on the result or surface errors — sort order is best-effort.
    void touchPresetAction({ id: preset.id });
    setShowPresetsModal(false);
  }

  function addDraftFromRecipe(recipe: RecipeRecord) {
    const macros = recipe.perPortionMacros;
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      {
        clientId: `draft-${crypto.randomUUID()}`,
        label: `${recipe.label} (1 portion)`,
        proteinG: String(macros.proteinG),
        carbsG: String(macros.carbsG),
        fatG: String(macros.fatG),
        caloriesKcal: String(macros.caloriesKcal),
        sortOrder: nextSortOrder(),
      },
    ]);
    setShowRecipePickerModal(false);
  }

  /** Source-agnostic: tap any quick-add card to open a prefilled draft (no auto-save). */
  function addDraftFromCandidate(candidate: QuickAddCandidate) {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createDraftFromCandidate(candidate, nextSortOrder()),
    ]);

    // If this was a preset candidate, touch it so its sort order floats up.
    if (candidate.source === "preset" && candidate.presetId) {
      void touchPresetAction({ id: candidate.presetId });
    }
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

      // Stamp the server-assigned ID onto the draft so subsequent edits go
      // through the update path rather than creating a duplicate entry.
      if (result.entry) {
        setDrafts((currentDrafts) =>
          currentDrafts.map((d) =>
            d.clientId === clientId ? { ...d, id: result.entry!.id } : d,
          ),
        );
      }

      invalidateAppDataCache(getDailyMutationCacheKeys(selectedDate));
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

      invalidateAppDataCache(getDailyMutationCacheKeys(selectedDate));
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
      invalidateAppDataCache(getPresetMutationCacheKeys());
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

      invalidateAppDataCache(getPresetMutationCacheKeys());
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
      invalidateAppDataCache(getPresetMutationCacheKeys());
      return true;
    } finally {
      setPresetMutation(null);
    }
  }

  const isViewingToday = selectedDate === todayStr;
  const isExperimental = uiMode === "experimental";

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
        invalidateAppDataCache(getDailyMutationCacheKeys(todayStr));
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

  function handleComposeAction(action: ComposeAction) {
    switch (action) {
      case "custom":
        addCustomDraft();
        break;
      case "preset":
        setPresetError(null);
        setShowPresetsModal(true);
        break;
      case "scan":
        setScanResult(null);
        setNotFoundBarcode(null);
        setShowScanner(true);
        break;
      case "recipe":
        setShowRecipePickerModal(true);
        break;
    }
  }

  const handleComposeActionEffect = useEffectEvent((action: ComposeAction) => {
    handleComposeAction(action);
  });

  useEffect(() => {
    if (!initialComposeAction) {
      return;
    }

    const composeKey = `${selectedDate}:${initialComposeAction}`;
    if (composeHandledRef.current === composeKey) {
      return;
    }

    composeHandledRef.current = composeKey;
    handleComposeActionEffect(initialComposeAction);

    const params = new URLSearchParams(window.location.search);
    params.delete("compose");
    const href = params.toString() ? `/?${params.toString()}` : "/";
    router.replace(href, { scroll: false });
  }, [initialComposeAction, router, selectedDate]);

  const content = (
    <div className={isExperimental ? "space-y-6" : "space-y-5"}>
      <section className={isExperimental
        ? "overflow-hidden rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] shadow-[0_20px_40px_rgba(0,0,0,0.08)]"
        : "rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]"}
      >
        <div className={isExperimental ? "border-b border-[var(--color-border)] p-5 pb-4" : "mb-4 flex items-center justify-between"}>
          <div className={isExperimental ? "flex items-start justify-between gap-4" : "flex items-center justify-between w-full"}>
            <div>
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                Daily Report
              </h2>
              {isExperimental ? (
                <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                  Your logged intake for {isViewingToday ? "today" : "this selected day"}.
                </p>
              ) : null}
            </div>
            <span className="text-2xl font-bold tabular-nums text-[var(--color-ink)]">
              {liveTotals.caloriesKcal}
              <span className="ml-1 text-xs font-semibold text-[var(--color-muted)]">kcal</span>
            </span>
          </div>
        </div>

        <div className={isExperimental ? "p-5 pt-4" : ""}>
          <MacroBarGroup
            proteinG={liveTotals.proteinG}
            carbsG={liveTotals.carbsG}
            fatG={liveTotals.fatG}
            caloriesKcal={liveTotals.caloriesKcal}
            goals={goals}
          />
        </div>
      </section>

      <section>
        <div className={isExperimental ? "mb-3 flex items-end justify-between gap-3" : ""}>
          <div>
            <h2 className="mb-2.5 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Quick Add
            </h2>
            {isExperimental ? (
              <p className="mb-2 text-sm text-[var(--color-muted)]">
                Repeat foods that already fit your routine.
              </p>
            ) : null}
          </div>
        </div>
        <QuickAddRail
          items={quickAddItems}
          onAdd={addDraftFromCandidate}
          emptyState={
            <p className="text-sm text-[var(--color-muted)]">
              Log some foods or add presets to see suggestions here.
            </p>
          }
        />
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Food Items
            </h2>
            {isExperimental ? (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                The main log for the day. Use the center + button to add more.
              </p>
            ) : null}
          </div>
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
            {!isExperimental ? (
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
            ) : null}
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
  );

  return (
    <>
      {isExperimental ? (
        <ExperimentalAppShell
          userEmail={userEmail}
          canAccessAdmin={canAccessAdmin}
          selectedDate={selectedDate}
          title="Food Log"
          activeTab="log"
          showDateNavigation
          onComposeAction={handleComposeAction}
        >
          {content}
        </ExperimentalAppShell>
      ) : (
        <AppShell
          userEmail={userEmail}
          canAccessAdmin={canAccessAdmin}
          selectedDate={selectedDate}
          activeTab="log"
        >
          {content}
        </AppShell>
      )}

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

      {showRecipePickerModal && (
        <RecipePickerModal
          recipes={recipes}
          onClose={() => setShowRecipePickerModal(false)}
          onSelect={addDraftFromRecipe}
        />
      )}

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

      {(scanResult || notFoundBarcode) && (
        <BarcodeResult
          product={scanResult}
          notFoundBarcode={notFoundBarcode}
          onAddToLog={(macros) => {
            setDrafts((currentDrafts) => [
              ...currentDrafts,
              {
                clientId: `draft-${crypto.randomUUID()}`,
                label: macros.label,
                proteinG: String(macros.proteinG),
                carbsG: String(macros.carbsG),
                fatG: String(macros.fatG),
                caloriesKcal: String(macros.caloriesKcal),
            sortOrder: nextSortOrder(),
          },
        ]);
        invalidateAppDataCache(getDailyMutationCacheKeys(selectedDate));
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
    </>
  );
}
