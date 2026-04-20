export const STORAGE_KEY = "macro-tracker-theme";

export type ThemeId =
  | "sandstone"
  | "ember"
  | "ocean"
  | "forest"
  | "sakura"
  | "lavender"
  | "midnight"
  | "arctic"
  | "mint"
  | "crimson"
  | "nord"
  | "dusk";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  colorScheme: "light" | "dark";
  description: string;
  /** [accent, appBg] used for the swatch preview */
  swatch: [string, string];
}

export const THEMES: ThemeMeta[] = [
  {
    id: "sandstone",
    label: "Sandstone",
    colorScheme: "light",
    description: "Warm beige & earthy brown",
    swatch: ["#ca6b3a", "#efe5d6"],
  },
  {
    id: "ember",
    label: "Ember",
    colorScheme: "dark",
    description: "Charcoal & warm amber",
    swatch: ["#df7f43", "#1f1818"],
  },
  {
    id: "ocean",
    label: "Ocean",
    colorScheme: "dark",
    description: "Deep navy & cyan",
    swatch: ["#38b2c9", "#101c2c"],
  },
  {
    id: "forest",
    label: "Forest",
    colorScheme: "dark",
    description: "Woodland green & moss",
    swatch: ["#6aae6a", "#131e15"],
  },
  {
    id: "sakura",
    label: "Sakura",
    colorScheme: "light",
    description: "Soft pink & cherry blossom",
    swatch: ["#d06888", "#f2e4e6"],
  },
  {
    id: "lavender",
    label: "Lavender",
    colorScheme: "light",
    description: "Purple & periwinkle",
    swatch: ["#8a5cc6", "#e8e0f0"],
  },
  {
    id: "midnight",
    label: "Midnight",
    colorScheme: "dark",
    description: "Deep black & electric violet",
    swatch: ["#6c6cf0", "#0c0c18"],
  },
  {
    id: "arctic",
    label: "Arctic",
    colorScheme: "light",
    description: "Ice blue & crisp sky",
    swatch: ["#2e88c0", "#e2f0f8"],
  },
  {
    id: "mint",
    label: "Mint",
    colorScheme: "light",
    description: "Fresh green & morning dew",
    swatch: ["#22a062", "#dff5ea"],
  },
  {
    id: "crimson",
    label: "Crimson",
    colorScheme: "dark",
    description: "Deep maroon & blood red",
    swatch: ["#cc3838", "#160c0c"],
  },
  {
    id: "nord",
    label: "Nord",
    colorScheme: "dark",
    description: "Steel blue-grey & frost",
    swatch: ["#88c0d0", "#252a34"],
  },
  {
    id: "dusk",
    label: "Dusk",
    colorScheme: "dark",
    description: "Deep violet & sunset coral",
    swatch: ["#e07850", "#180f28"],
  },
];

export const DEFAULT_THEME: ThemeId = "sandstone";

export const THEME_IDS = THEMES.map((t) => t.id);

export function isValidTheme(value: string): value is ThemeId {
  return (THEME_IDS as string[]).includes(value);
}

export function getThemeColorScheme(id: ThemeId): "light" | "dark" {
  return THEMES.find((t) => t.id === id)?.colorScheme ?? "light";
}
