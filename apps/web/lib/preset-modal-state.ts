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
  // Keeps the selected tab on empty lists (see preset-modal-state.test.ts).
  return selectedKind;
}
