"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "macro-tracker-theme";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

function getPreferredTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  const storedTheme = window.localStorage.getItem(STORAGE_KEY);
  if (storedTheme === "light" || storedTheme === "dark") {
    return storedTheme;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const nextTheme = getPreferredTheme();
    applyTheme(nextTheme);
    setTheme(nextTheme);
    setReady(true);
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    window.localStorage.setItem(STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      disabled={!ready}
      className="rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-ink)] shadow-[0_10px_24px_rgba(10,10,10,0.08)] transition hover:-translate-y-0.5 disabled:opacity-70"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
