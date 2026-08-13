"use client";

import type { DailySummary, MacroGoals, MealEntryRecord, MealEntryStatus, MealGroup, MealTemplate, QuickAddCandidate, RecipeRecord } from "@macro-tracker/db";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";

import { applyTemplateAction, createMealGroupAction, deleteMealGroupAction, deleteMealEntryAction, loadRecipesAction, loadTemplatesAction, markMealEntryStatusAction, saveMealEntryAction, updateMealGroupAction } from "@/lib/actions";
import type { ComposeAction } from "@/lib/compose";
import { computeLiveTotalsByStatus, rankCandidates } from "@/lib/quick-add";
import { prepareNavigationMotion } from "@/lib/navigation-motion";
import type { OpenFoodFactsProduct } from "@/lib/openfoodfacts";
import type { PresetTemplateKind } from "@/lib/preset-modal-state";
import { getLocalDateString } from "@/lib/startup-date";
import { createLazyCollectionLoader } from "@/lib/lazy-collection";
import { prefetchOnIdle } from "@/lib/idle-prefetch";

import { CompactModal } from "./compact-modal";
import { ExperimentalAppShell } from "./experimental-app-shell";
import { MacroBarGroup } from "./macro-bar";
import { MealCard, type MealDraft } from "./meal-card";
import {
  ModalChunkDismissProvider,
  ModalChunkFallback,
  OverlayBackdropFallback,
} from "./modal-chunk-fallback";
import { QuickAddRail } from "./quick-add-rail";
import { useTemplateMutations } from "./use-template-mutations";

// Modals only mount behind a flag, so keep them out of the log screen's initial
// bundle. `prefetchModalChunks` below pulls them in once the browser is idle,
// so opening one still costs nothing at click time.
//
// The `loading` option is load-bearing: without it (or `ssr: false`)
// next/dynamic emits no Suspense boundary of its own, so the first open
// suspends up to the route-level loading.tsx and the whole page swaps to the
// skeleton and remounts. The fallbacks mirror each modal's own shell rather
// than rendering null — a lazy component always suspends for at least one
// frame on first mount, and a null fallback makes the overlay vanish for that
// frame, which reads as the modal closing and reopening. The options must stay
// inline object literals — the bundler analyzes dynamic() options statically
// and rejects a shared const.
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

type DashboardShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  dailySummary: DailySummary;
  goals: MacroGoals;
  quickAddCandidates: QuickAddCandidate[];
  initialComposeAction?: ComposeAction | null;
  initialPresetTemplateKind?: PresetTemplateKind | null;
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
    // Use String() unconditionally: a falsy check like `meal.proteinG ? ...`
    // incorrectly converts a legitimate 0 value into an empty string.
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
  meals: MealEntryRecord[],
) {
  const savedDrafts = meals.map((meal) => {
    const existingDraft = currentDrafts.find((draft) => draft.id === meal.id);
    return mealToDraftWithClientId(meal, existingDraft?.clientId ?? meal.id);
  });
  const unsavedDrafts = currentDrafts.filter((draft) => !draft.id);

  return [...savedDrafts, ...unsavedDrafts];
}

function createEmptyDraft(sortOrder: number, status: MealEntryStatus): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    status,
    label: "",
    quantity: "1",
    unit: "serving",
    servingMultiplier: "1",
    proteinG: "",
    carbsG: "",
    fatG: "",
    caloriesKcal: "",
    sortOrder,
  };
}

function createDraftFromCandidate(
  candidate: QuickAddCandidate,
  sortOrder: number,
  status: MealEntryStatus,
): MealDraft {
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    status,
    label: candidate.label,
    quantity: "1",
    unit: "serving",
    servingMultiplier: "1",
    proteinG: String(candidate.proteinG),
    carbsG: String(candidate.carbsG),
    fatG: String(candidate.fatG),
    caloriesKcal: String(candidate.caloriesKcal),
    sortOrder,
  };
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
  return {
    clientId: `draft-${crypto.randomUUID()}`,
    status,
    productId: selection.productId ?? null,
    label: selection.label,
    quantity: String(selection.quantity ?? 1),
    unit: selection.unit ?? "serving",
    servingMultiplier: String(selection.servingMultiplier ?? 1),
    proteinG: String(selection.proteinG),
    carbsG: String(selection.carbsG),
    fatG: String(selection.fatG),
    caloriesKcal: String(selection.caloriesKcal),
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

function mealDraftToSaveInput(
  draft: MealDraft,
  {
    date,
    includeId = true,
    includeSortOrder = true,
    mealGroupId = draft.mealGroupId ?? null,
    status = draft.status,
  }: {
    date: string;
    includeId?: boolean;
    includeSortOrder?: boolean;
    mealGroupId?: string | null;
    status?: MealEntryStatus;
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

  return input;
}

function getNextSortOrder(drafts: MealDraft[]) {
  return drafts.reduce((highest, draft) => Math.max(highest, draft.sortOrder), -1) + 1;
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
  initialComposeAction = null,
  initialPresetTemplateKind = null,
}: DashboardShellProps) {
  const router = useRouter();
  const composeHandledRef = useRef<string | null>(null);
  const selectedDateRef = useRef(selectedDate);
  const [clientReady, setClientReady] = useState(false);
  const [drafts, setDrafts] = useState<MealDraft[]>(() =>
    dailySummary.meals.map(mealToDraft),
  );
  const [savedMeals, setSavedMeals] = useState<MealEntryRecord[]>(
    dailySummary.meals,
  );
  const [errors, setErrors] = useState<ErrorState>({});
  const [activeMutation, setActiveMutation] = useState<string | null>(null);
  const [savingClientId, setSavingClientId] = useState<string | null>(null);
  const [isPending, beginMutation] = useTransition();

  const [showPresetsModal, setShowPresetsModal] = useState(false);
  const [presetInitialKind, setPresetInitialKind] =
    useState<PresetTemplateKind | null>(null);
  const [localTemplates, setLocalTemplates] = useState<MealTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  const templateLoaderRef = useRef<ReturnType<typeof createLazyCollectionLoader<MealTemplate[]>> | null>(null);
  templateLoaderRef.current ??= createLazyCollectionLoader(async () => {
    const result = await loadTemplatesAction();
    if (!result.ok || !result.templates) {
      throw new Error(result.error ?? "Unable to load templates.");
    }
    return result.templates;
  });
  const [presetMutation, setPresetMutation] = useState<PresetMutationState | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const {
    handleSavePreset,
    handleDeletePreset,
    handleUpdatePreset,
  } = useTemplateMutations({
    localTemplates,
    setLocalTemplates,
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

  // Recipe picker state
  const [showRecipePickerModal, setShowRecipePickerModal] = useState(false);
  const [localRecipes, setLocalRecipes] = useState<RecipeRecord[]>([]);
  const [recipesLoaded, setRecipesLoaded] = useState(false);
  const [recipesLoading, setRecipesLoading] = useState(false);
  const [recipeLoadError, setRecipeLoadError] = useState<string | null>(null);
  const recipeLoaderRef = useRef<ReturnType<typeof createLazyCollectionLoader<RecipeRecord[]>> | null>(null);
  recipeLoaderRef.current ??= createLazyCollectionLoader(async () => {
    const result = await loadRecipesAction();
    if (!result.ok || !result.recipes) {
      throw new Error(result.error ?? "Unable to load recipes.");
    }
    return result.recipes;
  });

  // Food search state
  const [showSearchModal, setShowSearchModal] = useState(false);

  // AI photo estimate state
  const [showPhotoModal, setShowPhotoModal] = useState(false);

  useEffect(() => {
    setClientReady(true);
  }, []);

  useEffect(() => prefetchOnIdle(prefetchModalChunks), []);

  useEffect(() => {
    setSavedMeals(dailySummary.meals);
    setLocalMealGroups(dailySummary.mealGroups);
    setDrafts((currentDrafts) => {
      if (selectedDateRef.current !== selectedDate) {
        return dailySummary.meals.map(mealToDraft);
      }

      return reconcileDraftsWithSavedMeals(currentDrafts, dailySummary.meals);
    });
    selectedDateRef.current = selectedDate;
  }, [dailySummary.mealGroups, dailySummary.meals, selectedDate]);

  // Tracks cards that were recently copied to today so the button can give
  // brief visual confirmation before returning to its normal state.
  const [copiedCardIds, setCopiedCardIds] = useState<Set<string>>(new Set());

  // Barcode scanner state
  const [showScanner, setShowScanner] = useState(false);
  const [scanResult, setScanResult] = useState<OpenFoodFactsProduct | null>(null);
  const [notFoundBarcode, setNotFoundBarcode] = useState<string | null>(null);

  function dismissBarcodeCapture() {
    setShowScanner(false);
    setScanResult(null);
    setNotFoundBarcode(null);
  }

  // ---------------------------------------------------------------------------
  // Live totals react to unsaved drafts immediately.
  // ---------------------------------------------------------------------------

  const totalsByStatus = useMemo(
    () => computeLiveTotalsByStatus(drafts),
    [drafts],
  );
  const liveTotals = totalsByStatus.eaten;
  const livePlannedTotals = totalsByStatus.planned;
  const liveSkippedTotals = totalsByStatus.skipped;
  const todayStr = useMemo(() => getLocalDateString(), []);
  const defaultEntryStatus: MealEntryStatus =
    selectedDate > todayStr ? "planned" : "eaten";

  // ---------------------------------------------------------------------------
  // Quick-add rails
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Draft helpers
  // ---------------------------------------------------------------------------

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
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));
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

    setDrafts((currentDrafts) =>
      currentDrafts.map((item) =>
        item.clientId === clientId ? { ...item, mealGroupId } : item,
      ),
    );
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));

    if (!draft.id || !isOnlyGroupDirty(draft, mealGroupId)) {
      return;
    }

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await saveMealEntryAction(mealDraftToSaveInput(draft, {
        date: selectedDate,
        mealGroupId,
      }));

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to update group.",
        }));
        setActiveMutation(null);
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
    });
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
    } finally {
      setPresetMutation(null);
    }
  }

  function addDraftFromRecipe(recipe: RecipeRecord) {
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

  /** Source-agnostic: tap any quick-add card to open a prefilled draft (no auto-save). */
  function addDraftFromCandidate(candidate: QuickAddCandidate) {
    setDrafts((currentDrafts) => [
      ...currentDrafts,
      createDraftFromCandidate(
        candidate,
        getNextSortOrder(currentDrafts),
        defaultEntryStatus,
      ),
    ]);
  }

  function handleSearchEntrySaved(entry: MealEntryRecord) {
    if (entry.date !== selectedDate) {
      return;
    }

    setSavedMeals((meals) => upsertSavedMeal(meals, entry));
    setDrafts((currentDrafts) => {
      const existingDraft = currentDrafts.find((draft) => draft.id === entry.id);
      const savedDraft = mealToDraftWithClientId(
        entry,
        existingDraft?.clientId ?? entry.id,
      );

      if (!existingDraft) {
        return [...currentDrafts, savedDraft];
      }

      return currentDrafts.map((draft) =>
        draft.id === entry.id ? savedDraft : draft,
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
    setErrors((currentErrors) => ({
      ...currentErrors,
      [clientId]: null,
    }));
  }

  async function handleSave(clientId: string): Promise<boolean> {
    const draft = drafts.find((entry) => entry.clientId === clientId);
    if (!draft) {
      return false;
    }

    setSavingClientId(clientId);
    try {
      const result = await saveMealEntryAction(
        mealDraftToSaveInput(draft, { date: selectedDate }),
      );

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
            ? mealToDraftWithClientId(savedEntry, clientId)
            : d,
        ),
      );
      setSavedMeals((meals) => upsertSavedMeal(meals, savedEntry));
      router.refresh();
      return true;
    } finally {
      setSavingClientId(null);
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

      setSavedMeals((meals) => meals.filter((meal) => meal.id !== draft.id));
      removeLocalDraft(clientId);
      router.refresh();
    });
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

    setActiveMutation(clientId);
    beginMutation(async () => {
      const result = await markMealEntryStatusAction({
        id: draft.id!,
        status,
      });

      if (!result.ok) {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [clientId]: result.error ?? "Unable to update status.",
        }));
        setActiveMutation(null);
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
      } else {
        setDrafts((currentDrafts) =>
          currentDrafts.map((item) =>
            item.clientId === clientId ? { ...item, status } : item,
          ),
        );
      }
      router.refresh();
    });
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
    } finally {
      setGroupMutationId(null);
    }
  }

  const isViewingToday = selectedDate === todayStr;

  // Meal card callbacks close over draft state, so they get a fresh identity on
  // every keystroke. Route them through a ref so each card receives a stable
  // prop and `MealCard`'s memo can skip the cards that did not change -- typing
  // in one row used to re-render every row on the day.
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

      const maxSortOrder = currentDrafts.reduce(
        (max, d) => Math.max(max, d.sortOrder),
        -1,
      );

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
      const result = await saveMealEntryAction(mealDraftToSaveInput(draft, {
        date: todayStr,
        includeId: false,
        includeSortOrder: false,
        status: "eaten",
      }));

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

  function openPresetModal(initialKind: PresetTemplateKind | null = null) {
    setPresetError(null);
    setPresetInitialKind(initialKind);
    setShowPresetsModal(true);
    void ensureTemplatesLoaded();
  }

  function dismissPresetModal() {
    setPresetError(null);
    setShowPresetsModal(false);
  }

  async function ensureTemplatesLoaded() {
    if (templatesLoaded || templatesLoading) {
      return;
    }

    setTemplatesLoading(true);
    setTemplateLoadError(null);
    try {
      const templates = await templateLoaderRef.current!.load();
      setLocalTemplates(templates);
      setTemplatesLoaded(true);
    } catch (loadError) {
      setTemplateLoadError(
        loadError instanceof Error ? loadError.message : "Unable to load templates.",
      );
    }
    setTemplatesLoading(false);
  }

  function openRecipePickerModal() {
    setShowRecipePickerModal(true);
    void ensureRecipesLoaded();
  }

  async function ensureRecipesLoaded() {
    if (recipesLoaded || recipesLoading) {
      return;
    }

    setRecipesLoading(true);
    setRecipeLoadError(null);
    try {
      const recipes = await recipeLoaderRef.current!.load();
      setLocalRecipes(recipes);
      setRecipesLoaded(true);
    } catch (loadError) {
      setRecipeLoadError(
        loadError instanceof Error ? loadError.message : "Unable to load recipes.",
      );
    }
    setRecipesLoading(false);
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
                    className="min-w-0 flex-1 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:opacity-60"
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
                className="min-w-0 flex-1 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
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
                    const busy =
                      savingClientId === draft.clientId ||
                      (isPending && activeMutation === draft.clientId);

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

      {showPresetsModal && !templatesLoaded && (
        <CollectionLoadStateModal
          title="Templates"
          loading={templatesLoading}
          error={templateLoadError}
          onClose={() => setShowPresetsModal(false)}
          onRetry={() => void ensureTemplatesLoaded()}
        />
      )}

      {showPresetsModal && templatesLoaded && (
        <ModalChunkDismissProvider onDismiss={dismissPresetModal}>
          <PresetModal
            presets={localTemplates}
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

      {showRecipePickerModal && !recipesLoaded && (
        <CollectionLoadStateModal
          title="Pick a Recipe"
          loading={recipesLoading}
          error={recipeLoadError}
          onClose={() => setShowRecipePickerModal(false)}
          onRetry={() => void ensureRecipesLoaded()}
        />
      )}

      {showRecipePickerModal && recipesLoaded && (
        <ModalChunkDismissProvider
          onDismiss={() => setShowRecipePickerModal(false)}
        >
          <RecipePickerModal
            recipes={localRecipes}
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
              setDrafts((currentDrafts) => [
                ...currentDrafts,
                createDraftFromMacroSelection(
                  macros,
                  getNextSortOrder(currentDrafts),
                  defaultEntryStatus,
                ),
              ]);
              setShowPhotoModal(false);
            }}
            onSaveAsPreset={(input) => {
              handleSavePreset(input);
            }}
          />
        </ModalChunkDismissProvider>
      )}

      {/* Mirrors the component's own render condition so its chunk stays
          unloaded until a capture flow actually starts. */}
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
              setDrafts((currentDrafts) => [
                ...currentDrafts,
                createDraftFromMacroSelection(
                  macros,
                  getNextSortOrder(currentDrafts),
                  defaultEntryStatus,
                ),
              ]);
            }}
            onSaveAsPreset={(input) => {
              handleSavePreset(input);
            }}
          />
        </ModalChunkDismissProvider>
      )}
    </>
  );
}
