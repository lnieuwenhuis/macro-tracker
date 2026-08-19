export type PresetTemplateKind = "food" | "day";

type PresetTemplateCounts = {
  foodItemCount: number;
  dayCount: number;
};

export function getInitialPresetTemplateKind({
  foodItemCount,
  dayCount,
}: PresetTemplateCounts): PresetTemplateKind {
  return foodItemCount > 0 || dayCount === 0 ? "food" : "day";
}

export function normalizePresetTemplateKind(
  value?: string | null,
): PresetTemplateKind | null {
  return value === "food" || value === "day" ? value : null;
}

export function resolvePresetModalActiveKind({
  selectedKind,
}: {
  selectedKind: PresetTemplateKind;
}): PresetTemplateKind {
  // Deliberately does not consult foodItemCount/dayCount: once the user has
  // selected a tab, it must stay active even if that list is (or becomes)
  // empty. Auto-switching away on an empty list would yank the selection out
  // from under the user; see preset-modal-state.test.ts for the regression
  // this guards against.
  return selectedKind;
}
