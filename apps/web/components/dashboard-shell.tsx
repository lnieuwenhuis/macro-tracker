"use client";

import type { DailySummary, GymHomeSummary, MacroGoals, MealEntryRecord, MealEntryStatus, MealGroup, MealTemplate, QuickAddCandidate, RecipeSummary } from "@macro-tracker/db";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";

import { applyTemplateAction, createMealGroupAction, deleteMealGroupAction, deleteMealEntryAction, loadRecipeSummariesAction, loadTemplatesAction, markMealEntryStatusAction, saveMealEntryAction, updateMealGroupAction } from "@/lib/actions";
import type { ComposeAction } from "@/lib/compose";
import { isFrameworkControlFlowError } from "@/lib/framework-control-flow";
import { computeLiveTotalsByStatus, rankCandidates } from "@/lib/quick-add";
import { prepareNavigationMotion } from "@/lib/navigation-motion";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import type { PresetTemplateKind } from "@/lib/preset-modal-state";
import { getLocalDateString } from "@/lib/startup-date";
import { createClientMutationIdStore } from "@/lib/client-mutation-id";
import { useCopiedFlash } from "@/lib/use-copied-flash";
import { useLazyCollection } from "@/lib/use-lazy-collection";
import { prefetchOnIdle } from "@/lib/idle-prefetch";

import { CompactModal } from "./compact-modal";
import { AppShell } from "./app-shell";
import { MacroBarGroup } from "./macro-bar";
import { MealCard, type MealDraft } from "./meal-card";
import {
  ModalChunkDismissProvider,
  ModalChunkFallback,
  OverlayBackdropFallback,
} from "./modal-chunk-fallback";
import { GymOverlapList } from "./gym-overlap-list";
import { QuickAddRail } from "./quick-add-rail";
import { TransitionLink } from "./transition-link";
import { useTemplateMutations } from "./use-template-mutations";

// `loading` is load-bearing for Suspense; keep it an inline literal, since dynamic() options are analyzed statically.
// Fallbacks mirror their modal shell; null would blank the overlay for a frame.
const AiFoodPhotoModal = dynamic(
  () => import("./ai-food-photo-modal").then((mod) => mod.AiFoodPhotoModal),
  { loading: () => <OverlayBackdropFallback /> },
);
const BarcodeCaptureModals = dynamic(
  () => import("./barcode-capture-modals").then((mod) => mod.BarcodeCaptureModals),
  { loading: () => <OverlayBackdropFallback /> },
);
const FoodSearchModal = dynamic(
  () => import("./food-search-modal").then((mod) => mod.FoodSearchModal),
  { loading: () => <ModalChunkFallback title="Search History" /> },
);
const PresetModal = dynamic(
  () => import("./preset-modal").then((mod) => mod.PresetModal),
  { loading: () => <ModalChunkFallback title="Meal Templates" /> },
);
const RecipePickerModal = dynamic(
  () => import("./recipe-picker-modal").then((mod) => mod.RecipePickerModal),
  { loading: () => <ModalChunkFallback title="Pick a Recipe" /> },
);

function prefetchModalChunks() {
  void Promise.allSettled([
    import("./ai-food-photo-modal"),
    import("./barcode-capture-modals"),
    import("./food-search-modal"),
    import("./preset-modal"),
    import("./recipe-picker-modal"),
  ]);
}

const GROUP_INPUT_CLASS =
  "min-w-0 flex-1 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]";

type DashboardShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  dailySummary: DailySummary;
  goals: MacroGoals;
  quickAddCandidates: QuickAddCandidate[];
  gymSummary?: GymHomeSummary | null;
  initialComposeAction?: ComposeAction | null;
  initialPresetTemplateKind?: PresetTemplateKind | null;
  // Server-resolved in the user's timezone so the client and server renders agree on hydration.
  todayStr?: string;
};

type ErrorState = Record<string, string | null>;
type PresetMutationState =
  | { type: "save" }
  | { type: "apply"; presetId: string }
  | { type: "update" | "delete"; presetId: string };

function mealToDraft(meal: MealEntryRecord): MealDraft {
  return {
    clientId: meal.id,
    id: meal.id,
    mealGroupId: meal.mealGroupId,
    status: meal.status,
    productId: meal.productId,
    label: meal.label,
    quantity: String(meal.quantity),
    unit: meal.unit,
    servingMultiplier: String(meal.servingMultiplier),
    // String() unconditionally: a falsy check would turn a legitimate 0 into an empty string.
    proteinG: String(meal.proteinG),
    carbsG: String(meal.carbsG),
    fatG: String(meal.fatG),
    caloriesKcal: String(meal.caloriesKcal),
    sortOrder: meal.sortOrder,
  };
}

function mealToDraftWithClientId(meal: MealEntryRecord, clientId = meal.id): MealDraft {
  return { ...mealToDraft(meal), clientId };
}

function upsertSavedMeal(meals: MealEntryRecord[], entry: MealEntryRecord) {
  const exists = meals.some((meal) => meal.id === entry.id);
  if (!exists) {
    return [...meals, entry];
  }

  return meals.map((meal) => (meal.id === entry.id ? entry : meal));
}

function reconcileDraftsWithSavedMeals(
  currentDrafts: MealDraft[],
  oldSavedMeals: MealEntryRecord[],
  meals: MealEntryRecord[],
) {
  // UI-03: a refresh triggered by one card must not discard another card's
  // unsaved edits. Fields that differ from the pre-refresh baseline stay local;
  // everything else takes the fresh server row.
  const oldById = new Map(oldSavedMeals.map((meal) => [meal.id, meal]));
  const savedDrafts = meals.map((meal) => {
    const existingDraft = currentDrafts.find((draft) => draft.id === meal.id);
    const clientId = existingDraft?.clientId ?? meal.id;
    if (!existingDraft) {
      return mealToDraftWithClientId(meal, clientId);
    }
    const oldSaved = oldById.get(meal.id);
    if (!oldSaved) {
      return mealToDraftWithClientId(meal, clientId);
    }
    return mergeServerMealPreservingDirty(existingDraft, oldSaved, meal, clientId);
  });
  const unsavedDrafts = currentDrafts.filter((draft) => !draft.id);

  return [...savedDrafts, ...unsavedDrafts];
}

// UI-03/UI-25: keep locally edited fields that differ from the baseline the
// user last saw; adopt the server row for untouched fields. sortOrder always
// follows the server so ordering stays authoritative.
function mergeServerMealPreservingDirty(
  currentDraft: MealDraft,
  oldSaved: MealEntryRecord,
  newSaved: MealEntryRecord,
  clientId: string,
) {
  const serverDraft = mealToDraftWithClientId(newSaved, clientId);
  const dirty = dirtyFieldsVsSaved(currentDraft, oldSaved);
  if (!dirty) {
    return serverDraft;
  }
  return { ...serverDraft, ...dirty };
}

function dirtyFieldsVsSaved(
  draft: MealDraft,
  saved: MealEntryRecord,
): Partial<MealDraft> | null {
  const dirty: Partial<MealDraft> = {};
  const sameText = (a: string, b: string) => a === b;
  const sameNumberText = (text: string, value: number) => {
    if (text === String(value)) {
      return true;
    }
    // "10.0" vs 10 is the same value; keep the server text to avoid churn.
    const parsed = Number(text);
    return text.trim() !== "" && Number.isFinite(parsed) && parsed === value;
  };

  if ((draft.mealGroupId ?? null) !== (saved.mealGroupId ?? null)) {
    dirty.mealGroupId = draft.mealGroupId;
  }
  if (draft.status !== saved.status) {
    dirty.status = draft.status;
  }
  if ((draft.productId ?? null) !== (saved.productId ?? null)) {
    dirty.productId = draft.productId;
  }
  if (!sameText(draft.label, saved.label)) {
    dirty.label = draft.label;
  }
  if (!sameNumberText(draft.quantity, saved.quantity)) {
    dirty.quantity = draft.quantity;
  }
  if (draft.unit !== saved.unit) {
    dirty.unit = draft.unit;
  }
  if (!sameNumberText(draft.servingMultiplier, saved.servingMultiplier)) {
    dirty.servingMultiplier = draft.servingMultiplier;
  }
  if (!sameNumberText(draft.proteinG, saved.proteinG)) {
    dirty.proteinG = draft.proteinG;
  }
  if (!sameNumberText(draft.carbsG, saved.carbsG)) {
    dirty.carbsG = draft.carbsG;
  }
  if (!sameNumberText(draft.fatG, saved.fatG)) {
    dirty.fatG = draft.fatG;
  }
  if (!sameNumberText(draft.caloriesKcal, saved.caloriesKcal)) {
    dirty.caloriesKcal = draft.caloriesKcal;
  }

  return Object.keys(dirty).length > 0 ? dirty : null;
}

// UI-25: a save that completes after newer local edits were admitted must not
// clobber them. Fields changed since submission stay local; the rest commit.
function mergeSaveResultPreservingNewerEdits(
  currentDraft: MealDraft,
  submittedDraft: MealDraft,
  savedEntry: MealEntryRecord,
  clientId: string,
) {
  const serverDraft = mealToDraftWithClientId(savedEntry, clientId);
  const merged: MealDraft = { ...serverDraft };
  ([
    "mealGroupId",
    "status",
    "productId",
    "label",
    "quantity",
    "unit",
    "servingMultiplier",
    "proteinG",
    "carbsG",
    "fatG",
    "caloriesKcal",
  ] as const).forEach((field) => {
    if (currentDraft[field] !== submittedDraft[field]) {
      (merged as unknown as Record<string, unknown>)[field] = currentDraft[field];
    }
  });
  return merged;
}

function baseDraft(
  sortOrder: number,
  status: MealEntryStatus,
  fields: Omit<MealDraft, "clientId" | "sortOrder" | "status">,
): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    status,
    sortOrder,
    ...fields,
  };
}

function createEmptyDraft(sortOrder: number, status: MealEntryStatus): MealDraft {
  return baseDraft(sortOrder, status, {
    label: "",
    quantity: "1",
    unit: "serving",
    servingMultiplier: "1",
    proteinG: "",
    carbsG: "",
    fatG: "",
    caloriesKcal: "",
  });
}

function createDraftFromCandidate(
  candidate: QuickAddCandidate,
  sortOrder: number,
  status: MealEntryStatus,
): MealDraft {
  return baseDraft(sortOrder, status, {
    label: candidate.label,
    quantity: "1",
    unit: "serving",
    servingMultiplier: "1",
    proteinG: String(candidate.proteinG),
    carbsG: String(candidate.carbsG),
    fatG: String(candidate.fatG),
    caloriesKcal: String(candidate.caloriesKcal),
  });
}

function createDraftFromMacroSelection(
  selection: {
    productId?: string | null;
    label: string;
    quantity?: number;
    unit?: MealDraft["unit"];
    servingMultiplier?: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  },
  sortOrder: number,
  status: MealEntryStatus,
): MealDraft {
  return baseDraft(sortOrder, status, {
    productId: selection.productId ?? null,
    label: selection.label,
    quantity: String(selection.quantity ?? 1),
    unit: selection.unit ?? "serving",
    servingMultiplier: String(selection.servingMultiplier ?? 1),
    proteinG: String(selection.proteinG),
    carbsG: String(selection.carbsG),
    fatG: String(selection.fatG),
    caloriesKcal: String(selection.caloriesKcal),
  });
}

function toNumber(value: string, fallback = 0) {
  if (!value.trim()) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mealDraftToSaveInput(
  draft: MealDraft,
  {
    date,
    includeId = true,
    includeSortOrder = true,
    mealGroupId = draft.mealGroupId ?? null,
    status = draft.status,
    clientMutationId,
  }: {
    date: string;
    includeId?: boolean;
    includeSortOrder?: boolean;
    mealGroupId?: string | null;
    status?: MealEntryStatus;
    clientMutationId?: string;
  },
): Parameters<typeof saveMealEntryAction>[0] {
  const input: Parameters<typeof saveMealEntryAction>[0] = {
    date,
    mealGroupId,
    status,
    productId: draft.productId ?? null,
    label: draft.label,
    quantity: toNumber(draft.quantity, 1),
    unit: draft.unit,
    servingMultiplier: toNumber(draft.servingMultiplier, 1),
    proteinG: toNumber(draft.proteinG),
    carbsG: toNumber(draft.carbsG),
    fatG: toNumber(draft.fatG),
    caloriesKcal: Math.round(toNumber(draft.caloriesKcal)),
  };

  if (includeId && draft.id) {
    input.id = draft.id;
  }
  if (includeSortOrder) {
    input.sortOrder = draft.sortOrder;
  }
  // Only creates need deduping; an update is already addressed by its id.
  if (!input.id && clientMutationId) {
    input.clientMutationId = clientMutationId;
  }

  return input;
}

function getNextSortOrder(drafts: MealDraft[]) {
  return drafts.reduce((highest, draft) => Math.max(highest, draft.sortOrder), -1) + 1;
}

function loadNamedCollection<Item>(
  action: () => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>,
  key: string,
  fallbackError: string,
) {
  return async (): Promise<Item[]> => {
    const result = await action();
    const items = result[key] as Item[] | undefined;
    if (!result.ok || !items) {
      throw new Error(result.error ?? fallbackError);
    }
    return items;
  };
}

function CollectionLoadStateModal({
  title,
  loading,
  error,
  onClose,
  onRetry,
}: {
  title: string;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <CompactModal ariaLabel={title} title={title} onClose={onClose}>
      <div className="py-8 text-center">
        {loading ? (
          <p className="text-sm text-[var(--color-muted)]">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-[var(--color-danger)]">
              {error ?? "Unable to load this collection."}
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-4 rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white"
            >
              Retry
            </button>
          </>
        )}
      </div>
    </CompactModal>
  );
}

export function DashboardShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  dailySummary,
  goals,
  quickAddCandidates,
  gymSummary = null,
  initialComposeAction = null,
  initialPresetTemplateKind = null,
  todayStr: todayStrProp,
}: DashboardShellProps) {
  const router = useRouter();
  const composeHandledRef = useRef<string | null>(null);
  // Survives re-renders so a repeat tap reuses the same idempotency key.
  const mutationIds = useRef(createClientMutationIdStore());
  const selectedDateRef = useRef(selectedDate);
  const [clientReady, setClientReady] = useState(false);
  const [drafts, setDrafts] = useState<MealDraft[]>(() =>
    dailySummary.meals.map(mealToDraft),
  );
  const [savedMeals, setSavedMeals] = useState<MealEntryRecord[]>(
    dailySummary.meals,
  );
  const [errors, setErrors] = useState<ErrorState>({});
  // UI-25: pending operations tracked per entry, guarded synchronously so one
  // card's save can never release (or admit edits on) another card.
  const [pendingClientIds, setPendingClientIds] = useState<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());

  function markPending(clientId: string) {
    if (pendingRef.current.has(clientId)) {
      return false;
    }
    pendingRef.current.add(clientId);
    setPendingClientIds((prev) => new Set(prev).add(clientId));
    return true;
  }

  function clearPending(clientId: string) {
    pendingRef.current.delete(clientId);
    setPendingClientIds((prev) => {
      if (!prev.has(clientId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(clientId);
      return next;
    });
  }

  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [presetInitialKind, setPresetInitialKind] =
    useState<PresetTemplateKind | null>(null);
  const templates = useLazyCollection(loadNamedCollection<MealTemplate>(loadTemplatesAction, "templates", "Unable to load templates."), "Unable to load templates.");
  const [presetMutation, setPresetMutation] = useState<PresetMutationState | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const {
    handleSavePreset,
    handleDeletePreset,
    handleUpdatePreset,
  } = useTemplateMutations({
    localTemplates: templates.items,
    setLocalTemplates: templates.setItems,
    setPresetError,
    setPresetMutation: (mutation) => setPresetMutation(mutation),
  });
  const [localMealGroups, setLocalMealGroups] = useState<MealGroup[]>(
    dailySummary.mealGroups,
  );
  const [showGroupManager, setShowGroupManager] = useState(false);
  const [newGroupLabel, setNewGroupLabel] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [groupMutationId, setGroupMutationId] = useState<string | null>(null);

  const [showRecipePickerModal, setShowRecipePickerModal] = useState(false);
  const recipes = useLazyCollection(loadNamedCollection<RecipeSummary>(loadRecipeSummariesAction, "recipes", "Unable to load recipes."), "Unable to load recipes.");

  const [showSearchModal, setShowSearchModal] = useState(false);

  const [showPhotoModal, setShowPhotoModal] = useState(false);

  useEffect(() => {
    setClientReady(true);
  }, []);

  useEffect(() => prefetchOnIdle(prefetchModalChunks), []);

  useEffect(() => {
    setSavedMeals(dailySummary.meals);
    setLocalMealGroups(dailySummary.mealGroups);
    // savedMeals here is the pre-refresh baseline for dirty detection.
    const baseline = savedMeals;
    setDrafts((currentDrafts) => {
      if (selectedDateRef.current !== selectedDate) {
        return dailySummary.meals.map(mealToDraft);
      }

      return reconcileDraftsWithSavedMeals(currentDrafts, baseline, dailySummary.meals);
    });
    selectedDateRef.current = selectedDate;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dailySummary.mealGroups, dailySummary.meals, selectedDate]);

  const { copiedIds: copiedCardIds, flash: flashCopied } = useCopiedFlash(2000);

  const [showScanner, setShowScanner] = useState(false);
  const [scanResult, setScanResult] = useState<OpenFoodFactsProduct | null>(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState<string | null>(null);

  function dismissBarcodeCapture() {
    setShowScanner(false);
    setScanResult(null);
    setNotFoundBarcode(null);
  }

  const totalsByStatus = useMemo(
    () => computeLiveTotalsByStatus(drafts),
    [drafts],
  );
  const liveTotals = totalsByStatus.eaten;
  const livePlannedTotals = totalsByStatus.planned;
  const liveSkippedTotals = totalsByStatus.skipped;
  const todayStr = useMemo(
    () => todayStrProp ?? getLocalDateString(),
    [todayStrProp],
  );
  const defaultEntryStatus: MealEntryStatus =
    selectedDate > todayStr ? "planned" : "eaten";

  // Single unified quick-add list: ranked by routine signals, not macro fit.
  const quickAddItems = useMemo(
    () =>
      rankCandidates(quickAddCandidates, {
        limit: 10,
        currentHourUtc: new Date().getUTCHours(),
        referenceDate: todayStr,
      }),
    [quickAddCandidates, todayStr],
  );

  function clearDraftError(clientId: string) {
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));
  }

  function appendMacroSelectionAsDraft(macros: Parameters<typeof createDraftFromMacroSelection>[0]) {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createDraftFromMacroSelection(
        macros,
        getNextSortOrder(currentDrafts),
        defaultEntryStatus,
      ),
    ]);
  }

  function updateDraft(
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) {
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) =>
        draft.clientId === clientId
          ? {
              ...draft,
              [field]: field === "mealGroupId" && value === "" ? null : value,
            }
          : draft,
      ),
    );
    clearDraftError(clientId);
  }

  function isOnlyGroupDirty(draft: MealDraft, nextGroupId: string | null) {
    if (!draft.id) return false;
    const saved = savedMeals.find((meal) => meal.id === draft.id);
    if (!saved) return false;

    const sameNumber = (draftValue: string, savedValue: number) =>
      Math.abs(toNumber(draftValue) - savedValue) < 0.01;

    return (
      (saved.mealGroupId ?? null) !== nextGroupId &&
      draft.label.trim() === saved.label &&
      draft.status === saved.status &&
      (draft.productId ?? null) === (saved.productId ?? null) &&
      sameNumber(draft.quantity, saved.quantity) &&
      draft.unit === saved.unit &&
      sameNumber(draft.servingMultiplier, saved.servingMultiplier) &&
      sameNumber(draft.proteinG, saved.proteinG) &&
      sameNumber(draft.carbsG, saved.carbsG) &&
      sameNumber(draft.fatG, saved.fatG) &&
      Math.round(toNumber(draft.caloriesKcal)) === saved.caloriesKcal &&
      draft.sortOrder === saved.sortOrder
    );
  }

  function handleGroupChange(clientId: string, mealGroupId: string | null) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) return;

    const previousMealGroupId = draft.mealGroupId;

    setDrafts((currentDrafts) =>
      currentDrafts.map((item) =>
        item.clientId === clientId ? { ...item, mealGroupId } : item,
      ),
    );
    clearDraftError(clientId);

    if (!draft.id || !isOnlyGroupDirty(draft, mealGroupId)) {
      return;
    }

    if (!markPending(clientId)) {
      return;
    }
    void (async () => {
      try {
        const result = await saveMealEntryAction(mealDraftToSaveInput(draft, {
          date: selectedDate,
          mealGroupId,
        }));

        if (!result.ok) {
          setDrafts((currentDrafts) =>
            currentDrafts.map((item) =>
              item.clientId === clientId
                ? { ...item, mealGroupId: previousMealGroupId }
                : item,
            ),
          );
          setErrors((currentErrors) => ({
            ...currentErrors,
            [clientId]: result.error ?? "Unable to update group.",
          }));
          return;
        }

        if (result.entry) {
          const savedEntry = result.entry;
          setSavedMeals((meals) => upsertSavedMeal(meals, savedEntry));
          setDrafts((currentDrafts) =>
            currentDrafts.map((item) =>
              item.clientId === clientId
                ? mealToDraftWithClientId(savedEntry, clientId)
                : item,
            ),
          );
        }
        router.refresh();
      } catch (error) {
        if (isFrameworkControlFlowError(error)) {
          throw error;
        }
        // UI-05: transport rejection rolls back the optimistic group change.
        setDrafts((currentDrafts) =>
          currentDrafts.map((item) =>
            item.clientId === clientId
              ? { ...item, mealGroupId: previousMealGroupId }
              : item,
          ),
        );
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: "Unable to update group.",
        }));
      } finally {
        clearPending(clientId);
      }
    })();
  }

  function addCustomDraft() {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createEmptyDraft(getNextSortOrder(currentDrafts), defaultEntryStatus),
    ]);
  }

  async function addDraftFromPreset(template: MealTemplate) {
    setPresetError(null);
    setPresetMutation({ type: "apply", presetId: template.id });

    try {
      const result = await applyTemplateAction({
        templateId: template.id,
        date: selectedDate,
      });
      const entries = result.entries ?? [];

      if (!result.ok || entries.length === 0) {
        setPresetError(result.error ?? "Unable to apply template.");
        return;
      }

      setSavedMeals((meals) =>
        entries.reduce((nextMeals, entry) => upsertSavedMeal(nextMeals, entry), meals),
      );
      setDrafts((currentDrafts) => [
        ...currentDrafts,
        ...entries.map((entry) => mealToDraft(entry)),
      ]);
      setShowPresetsModal(false);
      router.refresh();
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      // UI-05: transport rejection surfaces locally instead of unhandled.
      setPresetError("Unable to apply template.");
    } finally {
      setPresetMutation(null);
    }
  }

  function addDraftFromRecipe(recipe: RecipeSummary) {
    const macros = recipe.perPortionMacros;
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      {
        clientId: `draft-${crypto.randomUUID()}`,
        status: defaultEntryStatus,
        label: `${recipe.label} (1 portion)`,
        quantity: "1",
        unit: "serving",
        servingMultiplier: "1",
        proteinG: String(macros.proteinG),
        carbsG: String(macros.carbsG),
        fatG: String(macros.fatG),
        caloriesKcal: String(macros.caloriesKcal),
        sortOrder: getNextSortOrder(currentDrafts),
      },
    ]);
    setShowRecipePickerModal(false);
  }

  // useCallback keeps one identity across renders so the memoized QuickAddCard rows can skip re-rendering.
  const addDraftFromCandidate = useCallback(
    (candidate: QuickAddCandidate) => {
      setDrafts((currentDrafts) => [
        ...currentDrafts,
        createDraftFromCandidate(
          candidate,
          getNextSortOrder(currentDrafts),
          defaultEntryStatus,
        ),
      ]);
    },
    [defaultEntryStatus],
  );

  function handleSearchEntrySaved(entry: MealEntryRecord) {
    if (entry.date !== selectedDate) {
      return;
    }

    setSavedMeals((meals) => upsertSavedMeal(meals, entry));
    setDrafts((currentDrafts) => {
      const existingDraft = currentDrafts.find((draft) => draft.id === entry.id);

      if (!existingDraft) {
        return [
          ...currentDrafts,
          mealToDraftWithClientId(entry, entry.id),
        ];
      }

      // UI-03: a search-saved row for an already-dirty card must not wipe edits.
      const oldSaved = savedMeals.find((meal) => meal.id === entry.id);
      if (!oldSaved) {
        return currentDrafts.map((draft) =>
          draft.id === entry.id
            ? mealToDraftWithClientId(entry, draft.clientId)
            : draft,
        );
      }

      return currentDrafts.map((draft) =>
        draft.id === entry.id
          ? mergeServerMealPreservingDirty(draft, oldSaved, entry, draft.clientId)
          : draft,
      );
    });
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

  function discardDraftChanges(clientId: string) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft?.id) {
      return;
    }

    const saved = savedMeals.find((meal) => meal.id === draft.id);
    if (!saved) {
      return;
    }

    const knownGroupIds = new Set(localMealGroups.map((group) => group.id));
    const restored = mealToDraft(saved);
    if (restored.mealGroupId && !knownGroupIds.has(restored.mealGroupId)) {
      restored.mealGroupId = null;
    }

    setDrafts((currentDrafts) =>
      currentDrafts.map((currentDraft) =>
        currentDraft.clientId === clientId ? restored : currentDraft,
      ),
    );
    clearDraftError(clientId);
  }

  async function handleSave(clientId: string): Promise<boolean> {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return false;
    }

    // UI-25: synchronous per-card guard; only this card's marker is released.
    if (!markPending(clientId)) {
      return false;
    }
    const submittedDraft = { ...draft };
    try {
      const mutationKey = `draft:${clientId}:${selectedDate}`;
      let result: Awaited<ReturnType<typeof saveMealEntryAction>>;
      try {
        result = await saveMealEntryAction(
          mealDraftToSaveInput(submittedDraft, {
            date: selectedDate,
            clientMutationId: mutationIds.current.take(mutationKey),
          }),
        );
      } catch (error) {
        if (isFrameworkControlFlowError(error)) {
          throw error;
        }
        // UI-05: transport rejection is a local error, not a hang.
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: "Unable to save food item.",
        }));
        return false;
      }

      if (result.ok) {
        mutationIds.current.settle(mutationKey);
      }

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to save food item.",
        }));
        return false;
      }

      if (!result.entry) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: "The food item was saved without a response. Try again.",
        }));
        return false;
      }

      const savedEntry = result.entry;
      setDrafts((currentDrafts) =>
        currentDrafts.map((d) =>
          d.clientId === clientId
            ? mergeSaveResultPreservingNewerEdits(d, submittedDraft, savedEntry, clientId)
            : d,
        ),
      );
      setSavedMeals((meals) => upsertSavedMeal(meals, savedEntry));
      router.refresh();
      return true;
    } finally {
      clearPending(clientId);
    }
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

    if (!markPending(clientId)) {
      return;
    }
    void (async () => {
      try {
        const result = await deleteMealEntryAction({
          id: draft.id!,
        });

        if (!result.ok) {
          setErrors((currentErrors) => ({
            ...currentErrors,
            [clientId]: result.error ?? "Unable to delete food item.",
          }));
          return;
        }

        setSavedMeals((meals) => meals.filter((meal) => meal.id !== draft.id));
        removeLocalDraft(clientId);
        router.refresh();
      } catch (error) {
        if (isFrameworkControlFlowError(error)) {
          throw error;
        }
        // UI-05: transport rejection surfaces locally for this card only.
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: "Unable to delete food item.",
        }));
      } finally {
        clearPending(clientId);
      }
    })();
  }

  function handleStatusChange(clientId: string, status: MealEntryStatus) {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft?.id) {
      setDrafts((currentDrafts) =>
        currentDrafts.map((item) =>
          item.clientId === clientId ? { ...item, status } : item,
        ),
      );
      return;
    }

    if (!markPending(clientId)) {
      return;
    }
    // UI-03: capture pre-status edits so the server row cannot wipe them.
    const submittedDraft = { ...draft };
    const baseline = savedMeals.find((meal) => meal.id === draft.id);
    void (async () => {
      try {
        let result: Awaited<ReturnType<typeof markMealEntryStatusAction>>;
        try {
          result = await markMealEntryStatusAction({
            id: submittedDraft.id!,
            status,
          });
        } catch (error) {
          if (isFrameworkControlFlowError(error)) {
            throw error;
          }
          // UI-05: transport rejection keeps local edits and reports per card.
          setErrors((currentErrors) => ({
            ...currentErrors,
            [clientId]: "Unable to update status.",
          }));
          return;
        }

        if (!result.ok) {
          setErrors((currentErrors) => ({
            ...currentErrors,
            [clientId]: result.error ?? "Unable to update status.",
          }));
          return;
        }

        if (result.entry) {
          const savedEntry = result.entry;
          setSavedMeals((meals) => upsertSavedMeal(meals, savedEntry));
          setDrafts((currentDrafts) =>
            currentDrafts.map((item) => {
              if (item.clientId !== clientId) {
                return item;
              }
              // Preserve fields the user edited before tapping status; the
              // status endpoint only moves status, so dirty values win locally
              // until the user explicitly saves them.
              const dirty = baseline ? dirtyFieldsVsSaved(submittedDraft, baseline) : null;
              const serverDraft = mealToDraftWithClientId(savedEntry, clientId);
              if (!dirty) {
                return serverDraft;
              }
              const preserved = { ...dirty };
              delete preserved.status;
              return { ...serverDraft, ...preserved };
            }),
          );
        } else {
          setDrafts((currentDrafts) =>
            currentDrafts.map((item) =>
              item.clientId === clientId ? { ...item, status } : item,
            ),
          );
        }
        router.refresh();
      } finally {
        clearPending(clientId);
      }
    })();
  }

  async function handleCreateMealGroup() {
    const label = newGroupLabel.trim();
    if (!label) return;

    setGroupError(null);
    setGroupMutationId("new");
    try {
      const result = await createMealGroupAction({ label });
      if (!result.ok || !result.group) {
        setGroupError(result.error ?? "Unable to create group.");
        return;
      }

      setLocalMealGroups((groups) => [...groups, result.group!]);
      setNewGroupLabel("");
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      // UI-05: transport rejection surfaces locally instead of unhandled.
      setGroupError("Unable to create group.");
    } finally {
      setGroupMutationId(null);
    }
  }

  async function handleRenameMealGroup(groupId: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;

    const previousGroups = localMealGroups;
    setLocalMealGroups((groups) =>
      groups.map((group) =>
        group.id === groupId ? { ...group, label: trimmed } : group,
      ),
    );
    setGroupError(null);
    setGroupMutationId(groupId);
    try {
      const result = await updateMealGroupAction({ id: groupId, label: trimmed });
      if (!result.ok || !result.group) {
        setLocalMealGroups(previousGroups);
        setGroupError(result.error ?? "Unable to rename group.");
      }
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      // UI-05: transport rejection rolls back the optimistic rename.
      setLocalMealGroups(previousGroups);
      setGroupError("Unable to rename group.");
    } finally {
      setGroupMutationId(null);
    }
  }

  async function handleDeleteMealGroup(groupId: string) {
    const previousGroups = localMealGroups;
    const previousDrafts = drafts;
    setLocalMealGroups((groups) => groups.filter((group) => group.id !== groupId));
    setDrafts((currentDrafts) =>
      currentDrafts.map((draft) =>
        draft.mealGroupId === groupId ? { ...draft, mealGroupId: null } : draft,
      ),
    );
    setGroupError(null);
    setGroupMutationId(groupId);
    try {
      const result = await deleteMealGroupAction({ id: groupId });
      if (!result.ok) {
        setLocalMealGroups(previousGroups);
        setDrafts(previousDrafts);
        setGroupError(result.error ?? "Unable to delete group.");
        return;
      }

      setSavedMeals((meals) =>
        meals.map((meal) =>
          meal.mealGroupId === groupId ? { ...meal, mealGroupId: null } : meal,
        ),
      );
      router.refresh();
    } catch (error) {
      if (isFrameworkControlFlowError(error)) {
        throw error;
      }
      // UI-05: transport rejection rolls back the optimistic removal.
      setLocalMealGroups(previousGroups);
      setDrafts(previousDrafts);
      setGroupError("Unable to delete group.");
    } finally {
      setGroupMutationId(null);
    }
  }

  const isViewingToday = selectedDate === todayStr;

  // Card callbacks close over draft state, so they go through a ref: each card keeps stable props and MealCard's memo can skip the rows that did not change.
  const mealCardHandlersRef = useRef({
    updateDraft,
    handleSave,
    handleDelete,
    handleDuplicate,
    handleGroupChange,
    handleStatusChange,
    handleCopyToToday,
    discardDraftChanges,
  });
  useLayoutEffect(() => {
    mealCardHandlersRef.current = {
      updateDraft,
      handleSave,
      handleDelete,
      handleDuplicate,
      handleGroupChange,
      handleStatusChange,
      handleCopyToToday,
      discardDraftChanges,
    };
  });

  const mealCardHandlers = useMemo(
    () => ({
      onChange: (...args: Parameters<typeof updateDraft>) =>
        mealCardHandlersRef.current.updateDraft(...args),
      onSave: (clientId: string) =>
        mealCardHandlersRef.current.handleSave(clientId),
      onDelete: (clientId: string) =>
        mealCardHandlersRef.current.handleDelete(clientId),
      onDuplicate: (clientId: string) =>
        mealCardHandlersRef.current.handleDuplicate(clientId),
      onGroupChange: (clientId: string, mealGroupId: string | null) =>
        mealCardHandlersRef.current.handleGroupChange(clientId, mealGroupId),
      onStatusChange: (clientId: string, status: MealEntryStatus) =>
        mealCardHandlersRef.current.handleStatusChange(clientId, status),
      onCopyToToday: (clientId: string) =>
        mealCardHandlersRef.current.handleCopyToToday(clientId),
      onDiscardChanges: (clientId: string) =>
        mealCardHandlersRef.current.discardDraftChanges(clientId),
    }),
    [],
  );

  const groupedDraftSections = useMemo(
    () => {
      const knownGroupIds = new Set(localMealGroups.map((group) => group.id));
      const draftsByGroupId = new Map<string, MealDraft[]>();
      const ungroupedDrafts: MealDraft[] = [];

      for (const draft of drafts) {
        if (!draft.mealGroupId || !knownGroupIds.has(draft.mealGroupId)) {
          ungroupedDrafts.push(draft);
          continue;
        }

        const groupDrafts = draftsByGroupId.get(draft.mealGroupId);
        if (groupDrafts) {
          groupDrafts.push(draft);
        } else {
          draftsByGroupId.set(draft.mealGroupId, [draft]);
        }
      }

      return [
        ...localMealGroups.map((group) => ({
          group,
          drafts: draftsByGroupId.get(group.id) ?? [],
        })),
        { group: null, drafts: ungroupedDrafts },
      ];
    },
    [drafts, localMealGroups],
  );

  function handleDuplicate(clientId: string) {
    setDrafts((currentDrafts) => {
      const draft = currentDrafts.find((d) => d.clientId === clientId);
      if (!draft) return currentDrafts;

      return [
        ...currentDrafts,
        {
          clientId: `draft-${crypto.randomUUID()}`,
          mealGroupId: draft.mealGroupId,
          status: defaultEntryStatus,
          productId: draft.productId,
          label: draft.label,
          quantity: draft.quantity,
          unit: draft.unit,
          servingMultiplier: draft.servingMultiplier,
          proteinG: draft.proteinG,
          carbsG: draft.carbsG,
          fatG: draft.fatG,
          caloriesKcal: draft.caloriesKcal,
          sortOrder: getNextSortOrder(currentDrafts),
        },
      ];
    });
  }

  function handleCopyToToday(clientId: string) {
    const draft = drafts.find((d) => d.clientId === clientId);
    if (!draft) return;

    // Intentional add-to-today semantics preserved: a historical view copies
    // onto the local today, never onto the viewed date.
    const mutationKey = `copy:${draft.id ?? clientId}:${todayStr}`;
    if (!markPending(clientId)) {
      return;
    }
    void (async () => {
      try {
        const result = await saveMealEntryAction(mealDraftToSaveInput(draft, {
          date: todayStr,
          includeId: false,
          includeSortOrder: false,
          status: "eaten",
          clientMutationId: mutationIds.current.take(mutationKey),
        }));

        if (result.ok) {
          mutationIds.current.settle(mutationKey);
        }

        if (!result.ok) {
          setErrors((currentErrors) => ({
            ...currentErrors,
            [clientId]: result.error ?? "Unable to copy entry to today.",
          }));
        } else {
          flashCopied(clientId);
        }
      } catch (error) {
        if (isFrameworkControlFlowError(error)) {
          throw error;
        }
        // UI-05: transport rejection surfaces locally for this card only.
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: "Unable to copy entry to today.",
        }));
      } finally {
        clearPending(clientId);
      }
    })();
  }

  function openPresetModal(initialKind: PresetTemplateKind | null = null) {
    setPresetError(null);
    setPresetInitialKind(initialKind);
    setShowPresetsModal(true);
    void templates.ensureLoaded();
  }

  function dismissPresetModal() {
    setPresetError(null);
    setShowPresetsModal(false);
  }

  function openRecipePickerModal() {
    setShowRecipePickerModal(true);
    void recipes.ensureLoaded();
  }

  function handleComposeAction(
    action: ComposeAction,
    templateKind: PresetTemplateKind | null = null,
  ) {
    switch (action) {
      case "custom":
        addCustomDraft();
        break;
      case "template":
        openPresetModal(templateKind);
        break;
      case "scan":
        setScanResult(null);
        setNotFoundBarcode(null);
        setShowScanner(true);
        break;
      case "photo":
        setShowPhotoModal(true);
        break;
      case "recipe":
        openRecipePickerModal();
        break;
    }
  }

  const handleComposeActionEffect = useEffectEvent(
    (action: ComposeAction, templateKind: PresetTemplateKind | null) => {
      handleComposeAction(action, templateKind);
    },
  );

  useEffect(() => {
    if (!initialComposeAction) {
      composeHandledRef.current = null;
      return;
    }

    const composeKey = `${selectedDate}:${initialComposeAction}:${initialPresetTemplateKind ?? ""}`;
    if (composeHandledRef.current === composeKey) {
      return;
    }

    composeHandledRef.current = composeKey;
    handleComposeActionEffect(initialComposeAction, initialPresetTemplateKind);

    const params = new URLSearchParams(window.location.search);
    params.delete("compose");
    params.delete("templateKind");
    const href = params.toString() ? `/?${params.toString()}` : "/";
    router.replace(href, { scroll: false });
  }, [initialComposeAction, initialPresetTemplateKind, router, selectedDate]);

  const content = (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-[var(--color-border)] bg-[var(--color-surface-strong)] shadow-[0_20px_40px_rgba(0,0,0,0.08)]">
        <div className="border-b border-[var(--color-border)] p-5 pb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
                Daily Report
              </h2>
              <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                Your logged intake for {isViewingToday ? "today" : "this selected day"}.
              </p>
            </div>
            <span className="text-2xl font-bold tabular-nums text-[var(--color-ink)]">
              {liveTotals.caloriesKcal}
              <span className="ml-1 text-xs font-semibold text-[var(--color-muted)]">kcal</span>
            </span>
          </div>
        </div>

        <div className="p-5 pt-4">
          <MacroBarGroup
            proteinG={liveTotals.proteinG}
            carbsG={liveTotals.carbsG}
            fatG={liveTotals.fatG}
            caloriesKcal={liveTotals.caloriesKcal}
            plannedTotals={livePlannedTotals}
            goals={goals}
          />
          {livePlannedTotals.caloriesKcal > 0 || liveSkippedTotals.caloriesKcal > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-xl bg-[var(--color-card-muted)] px-3 py-2">
                <span className="font-semibold text-[var(--color-muted-strong)]">Planned</span>
                <span className="ml-2 tabular-nums text-[var(--color-ink)]">{livePlannedTotals.caloriesKcal} kcal</span>
              </div>
              <div className="rounded-xl bg-[var(--color-card-muted)] px-3 py-2">
                <span className="font-semibold text-[var(--color-muted-strong)]">Skipped</span>
                <span className="ml-2 tabular-nums text-[var(--color-ink)]">{liveSkippedTotals.caloriesKcal} kcal</span>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      {gymSummary && gymSummary.overlaps.length > 0 ? (
        <section>
          <h2 className="mb-2.5 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Gym Buddies
          </h2>
          <TransitionLink
            href={`/gym?date=${selectedDate}`}
            motion="screen"
            className="block"
            aria-label="Open gym schedule"
          >
            <GymOverlapList overlaps={gymSummary.overlaps} />
          </TransitionLink>
        </section>
      ) : null}

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="mb-2.5 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Quick Add
            </h2>
            <p className="mb-2 text-sm text-[var(--color-muted)]">
              Repeat foods that already fit your routine.
            </p>
          </div>
        </div>
        <QuickAddRail
          items={quickAddItems}
          onAdd={addDraftFromCandidate}
          emptyState={
            <p className="text-sm text-[var(--color-muted)]">
              Log some foods or add templates to see suggestions here.
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
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              The main log for the day. Use the center + button to add more.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!clientReady}
              onClick={() => setShowSearchModal(true)}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)] disabled:opacity-60"
              aria-label="Search food history"
            >
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="7.5" cy="7.5" r="5" />
                <line x1="11.5" y1="11.5" x2="15" y2="15" />
              </svg>
            </button>
            <button
              type="button"
              disabled={!clientReady}
              onClick={() => {
                setGroupError(null);
                setShowGroupManager((open) => !open);
              }}
              className="flex h-9 items-center rounded-xl px-3 text-xs font-semibold text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)] disabled:opacity-60"
            >
              Groups
            </button>
          </div>
        </div>

        {drafts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center">
            <p className="text-sm text-[var(--color-muted)]">No food items logged yet.</p>
            <div className="mt-3 flex justify-center gap-2">
              <button
                type="button"
                disabled={!clientReady}
                onClick={() => openPresetModal()}
                className="rounded-full border border-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5 disabled:opacity-60"
              >
                From template
              </button>
              <button
                type="button"
                disabled={!clientReady}
                onClick={addCustomDraft}
                className="rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
              >
                Add custom
              </button>
            </div>
          </div>
        ) : null}

        {showGroupManager ? (
          <div className="mb-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                Meal Groups
              </h3>
              <button
                type="button"
                onClick={() => setShowGroupManager(false)}
                className="text-xs font-semibold text-[var(--color-muted)] hover:text-[var(--color-ink)]"
              >
                Done
              </button>
            </div>
            <div className="space-y-2">
              {localMealGroups.map((group) => (
                <div key={group.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    defaultValue={group.label}
                    disabled={groupMutationId === group.id}
                    onBlur={(event) => {
                      if (event.target.value.trim() !== group.label) {
                        void handleRenameMealGroup(group.id, event.target.value);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      }
                    }}
                    className={`${GROUP_INPUT_CLASS} disabled:opacity-60`}
                  />
                  <button
                    type="button"
                    disabled={groupMutationId === group.id}
                    onClick={() => void handleDeleteMealGroup(group.id)}
                    className="rounded-xl px-3 py-2 text-xs font-semibold text-[var(--color-danger)] transition hover:bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={newGroupLabel}
                onChange={(event) => setNewGroupLabel(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleCreateMealGroup();
                  }
                }}
                placeholder="New group"
                className={GROUP_INPUT_CLASS}
              />
              <button
                type="button"
                disabled={!newGroupLabel.trim() || groupMutationId === "new"}
                onClick={() => void handleCreateMealGroup()}
                className="rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {groupError ? (
              <p className="mt-3 text-sm text-[var(--color-danger)]">{groupError}</p>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-5">
          {groupedDraftSections.map(({ group, drafts: groupDrafts }) => {
            if (groupDrafts.length === 0) return null;
            return (
              <div key={group?.id ?? "ungrouped"} className="space-y-2">
                <h3 className="px-1 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                  {group?.label ?? "Ungrouped"}
                </h3>
                <div className="space-y-3">
                  {groupDrafts.map((draft) => {
                    // UI-25: per-card pending state; one card's mutation never
                    // enables, admits edits on, or releases another card.
                    const busy = pendingClientIds.has(draft.clientId);

                    return (
                      <MealCard
                        key={draft.clientId}
                        draft={draft}
                        busy={busy}
                        error={errors[draft.clientId]}
                        isCopied={copiedCardIds.has(draft.clientId)}
                        mealGroups={localMealGroups}
                        onChange={mealCardHandlers.onChange}
                        onSave={mealCardHandlers.onSave}
                        onDelete={mealCardHandlers.onDelete}
                        onDuplicate={mealCardHandlers.onDuplicate}
                        onGroupChange={mealCardHandlers.onGroupChange}
                        onStatusChange={mealCardHandlers.onStatusChange}
                        onCopyToToday={
                          isViewingToday ? undefined : mealCardHandlers.onCopyToToday
                        }
                        onDiscardChanges={mealCardHandlers.onDiscardChanges}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );

  return (
    <>
      <AppShell
        userEmail={userEmail}
        canAccessAdmin={canAccessAdmin}
        selectedDate={selectedDate}
        title="Food Log"
        activeTab="log"
        showDateNavigation
        showGymShortcut
        gymPendingInviteCount={gymSummary?.pendingInviteCount ?? 0}
        onComposeAction={handleComposeAction}
        todayStr={todayStr}
      >
        {content}
      </AppShell>

      {showSearchModal && (
        <ModalChunkDismissProvider onDismiss={() => setShowSearchModal(false)}>
          <FoodSearchModal
            onClose={() => setShowSearchModal(false)}
            onEntrySaved={handleSearchEntrySaved}
            onViewDate={(date) => {
              setShowSearchModal(false);
              const href = `/?date=${date}`;
              prepareNavigationMotion(href, "day-jump");
              router.push(href);
            }}
          />
        </ModalChunkDismissProvider>
      )}

      {showPresetsModal && !templates.loaded && (
        <CollectionLoadStateModal
          title="Templates"
          loading={templates.loading}
          error={templates.error}
          onClose={() => setShowPresetsModal(false)}
          onRetry={() => void templates.ensureLoaded()}
        />
      )}

      {showPresetsModal && templates.loaded && (
        <ModalChunkDismissProvider onDismiss={dismissPresetModal}>
          <PresetModal
            presets={templates.items}
            mutation={presetMutation}
            errorMessage={presetError}
            initialKind={presetInitialKind}
            onClose={dismissPresetModal}
            onSelect={addDraftFromPreset}
            onSave={handleSavePreset}
            onUpdate={handleUpdatePreset}
            onDelete={handleDeletePreset}
          />
        </ModalChunkDismissProvider>
      )}

      {showRecipePickerModal && !recipes.loaded && (
        <CollectionLoadStateModal
          title="Pick a Recipe"
          loading={recipes.loading}
          error={recipes.error}
          onClose={() => setShowRecipePickerModal(false)}
          onRetry={() => void recipes.ensureLoaded()}
        />
      )}

      {showRecipePickerModal && recipes.loaded && (
        <ModalChunkDismissProvider
          onDismiss={() => setShowRecipePickerModal(false)}
        >
          <RecipePickerModal
            recipes={recipes.items}
            onClose={() => setShowRecipePickerModal(false)}
            onSelect={addDraftFromRecipe}
          />
        </ModalChunkDismissProvider>
      )}

      {showPhotoModal && (
        <ModalChunkDismissProvider onDismiss={() => setShowPhotoModal(false)}>
          <AiFoodPhotoModal
            onClose={() => setShowPhotoModal(false)}
            onAddToLog={(macros) => {
              appendMacroSelectionAsDraft(macros);
              setShowPhotoModal(false);
            }}
            onSaveAsPreset={(input) => handleSavePreset(input)}
          />
        </ModalChunkDismissProvider>
      )}

      {/* Mirrors the component's own render condition so its chunk stays unloaded until a capture flow starts. */}
      {(showScanner || scanResult || notFoundBarcode) && (
        <ModalChunkDismissProvider onDismiss={dismissBarcodeCapture}>
          <BarcodeCaptureModals
            showScanner={showScanner}
            scanResult={scanResult}
            notFoundBarcode={notFoundBarcode}
            setShowScanner={setShowScanner}
            setScanResult={setScanResult}
            setNotFoundBarcode={setNotFoundBarcode}
            onAddToLog={(macros) => {
              appendMacroSelectionAsDraft(macros);
            }}
            onSaveAsPreset={(input) => handleSavePreset(input)}
          />
        </ModalChunkDismissProvider>
      )}
    </>
  );
}
