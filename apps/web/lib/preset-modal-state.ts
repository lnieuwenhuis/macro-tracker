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
  // Deliberately ignores foodItemCount/dayCount: a selected tab stays active even if that list becomes empty.
  // See preset-modal-state.test.ts for the regression this guards.
  return selectedKind;
}
