export const UI_MODE_STORAGE_KEY = "macro-tracker-ui-mode";
export const UI_MODE_COOKIE_NAME = UI_MODE_STORAGE_KEY;
export const UI_MODE_EVENT = "macro-tracker-ui-mode-change";
export const UI_MODE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const DEFAULT_UI_MODE = "legacy";

export type UiMode = "legacy" | "experimental";
export type ProgressTab = "goals" | "weight";

type SearchParamsLike = {
  get(name: string): string | null;
  toString(): string;
};

export function isUiMode(value: string): value is UiMode {
  return value === "legacy" || value === "experimental";
}

export function normalizeUiMode(value?: string | null): UiMode {
  return isUiMode(value ?? "") ? (value as UiMode) : DEFAULT_UI_MODE;
}

export function normalizeProgressTab(value?: string | null): ProgressTab {
  return value === "weight" ? "weight" : "goals";
}

export function setUiMode(mode: UiMode) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(UI_MODE_STORAGE_KEY, mode);
  document.cookie =
    `${UI_MODE_COOKIE_NAME}=${mode}; path=/; max-age=${UI_MODE_COOKIE_MAX_AGE}; SameSite=Lax`;
  window.dispatchEvent(new Event(UI_MODE_EVENT));
}

function cloneSearchParams(searchParams?: SearchParamsLike | null) {
  return new URLSearchParams(searchParams?.toString() ?? "");
}

function buildHref(pathname: string, searchParams: URLSearchParams) {
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function mapRouteForUiMode({
  pathname,
  searchParams,
  nextMode,
}: {
  pathname: string;
  searchParams?: SearchParamsLike | null;
  nextMode: UiMode;
}) {
  const nextSearchParams = cloneSearchParams(searchParams);

  if (nextMode === "experimental") {
    if (pathname === "/goals") {
      nextSearchParams.set("tab", "goals");
      return buildHref("/progress", nextSearchParams);
    }

    if (pathname === "/weight") {
      nextSearchParams.set("tab", "weight");
      return buildHref("/progress", nextSearchParams);
    }

    if (pathname === "/stats") {
      return buildHref("/summary", nextSearchParams);
    }

    return buildHref(pathname, nextSearchParams);
  }

  if (pathname === "/progress") {
    const targetPath = normalizeProgressTab(nextSearchParams.get("tab")) === "weight"
      ? "/weight"
      : "/goals";
    nextSearchParams.delete("tab");
    return buildHref(targetPath, nextSearchParams);
  }

  return buildHref(pathname, nextSearchParams);
}
