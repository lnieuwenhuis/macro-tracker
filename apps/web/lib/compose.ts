export type ComposeAction = "custom" | "preset" | "scan" | "recipe";

export function normalizeComposeAction(value?: string | null): ComposeAction | null {
  switch (value) {
    case "custom":
    case "preset":
    case "scan":
    case "recipe":
      return value;
    default:
      return null;
  }
}
