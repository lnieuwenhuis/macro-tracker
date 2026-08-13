export type ProgressTab = "goals" | "weight";

export function normalizeProgressTab(value?: string | null): ProgressTab {
  return value === "weight" ? "weight" : "goals";
}
