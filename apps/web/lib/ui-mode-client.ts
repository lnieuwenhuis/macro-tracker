"use client";

import { useSyncExternalStore } from "react";

import {
  DEFAULT_UI_MODE,
  UI_MODE_COOKIE_NAME,
  UI_MODE_EVENT,
  UI_MODE_STORAGE_KEY,
  isUiMode,
  normalizeUiMode,
  type UiMode,
} from "./ui-mode";

function subscribeToUiMode(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(UI_MODE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(UI_MODE_EVENT, callback);
  };
}

function getUiModeFromCookieString(cookieString: string) {
  const cookieEntries = cookieString.split(";");

  for (const entry of cookieEntries) {
    const [rawName, ...rawValueParts] = entry.trim().split("=");
    if (rawName !== UI_MODE_COOKIE_NAME) {
      continue;
    }

    return normalizeUiMode(rawValueParts.join("="));
  }

  return DEFAULT_UI_MODE;
}

function getStoredUiMode() {
  const stored = window.localStorage.getItem(UI_MODE_STORAGE_KEY);
  if (isUiMode(stored ?? "")) {
    return stored as UiMode;
  }

  return getUiModeFromCookieString(document.cookie);
}

export function useUiMode(): UiMode {
  return useSyncExternalStore<UiMode>(
    subscribeToUiMode,
    getStoredUiMode,
    () => DEFAULT_UI_MODE,
  );
}
