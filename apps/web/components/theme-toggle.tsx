"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  DEFAULT_THEME,
  STORAGE_KEY,
  THEMES,
  ThemeId,
  getThemeColorScheme,
  isValidTheme,
} from "@/lib/themes";

// ─── Core helpers ─────────────────────────────────────────────────────────────

function applyTheme(theme: ThemeId) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = getThemeColorScheme(theme);
}

function getActiveTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  // Migrate legacy values
  if (stored === "light") return "sandstone";
  if (stored === "dark") return "ember";
  return isValidTheme(stored ?? "") ? (stored as ThemeId) : DEFAULT_THEME;
}

function subscribeToTheme(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener("macro-tracker-theme-change", callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener("macro-tracker-theme-change", callback);
  };
}

export function setTheme(theme: ThemeId) {
  window.localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  window.dispatchEvent(new Event("macro-tracker-theme-change"));
}

export function useTheme(): ThemeId {
  return useSyncExternalStore<ThemeId>(
    subscribeToTheme,
    getActiveTheme,
    () => DEFAULT_THEME,
  );
}

// ─── ThemePicker ──────────────────────────────────────────────────────────────
// Pill-chip grid for the hamburger menu.

export function ThemePicker() {
  const activeTheme = useTheme();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    applyTheme(activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (containerRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const current = THEMES.find((theme) => theme.id === activeTheme) ?? THEMES[0];
  const [currentAccent, currentBg] = current.swatch;

  return (
    <div ref={containerRef} className="space-y-2.5">
      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
        Theme
      </span>
      <button
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        aria-expanded={open}
        aria-label={`Current theme: ${current.label}. Click to ${open ? "collapse" : "expand"} theme options`}
        className="flex w-full items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-left transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-card-muted)]"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ background: `linear-gradient(135deg, ${currentAccent} 50%, ${currentBg} 50%)` }}
          />
          <span className="min-w-0">
            <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-muted)]">
              Current
            </span>
            <span className="block truncate text-xs font-semibold text-[var(--color-ink)]">
              {current.label}
            </span>
          </span>
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={["shrink-0 text-[var(--color-muted)] transition-transform", open ? "rotate-180" : ""].join(" ")}
        >
          <polyline points="4,6 8,10 12,6" />
        </svg>
      </button>
      {open && (
        <div className="flex flex-wrap gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-shell-panel)] p-2">
          {THEMES.map((theme) => {
            const isActive = theme.id === activeTheme;
            const [accent, bg] = theme.swatch;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => {
                  setTheme(theme.id);
                  setOpen(false);
                }}
                aria-label={`Switch to ${theme.label} theme`}
                aria-pressed={isActive}
                className={[
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap transition-all",
                  isActive
                    ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]"
                    : "border-[var(--color-border-strong)] text-[var(--color-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-muted-strong)]",
                ].join(" ")}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: `linear-gradient(135deg, ${accent} 50%, ${bg} 50%)` }}
                />
                {theme.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── ThemeToggle ──────────────────────────────────────────────────────────────
// Compact cycle-button for the login page.

export function ThemeToggle() {
  const activeTheme = useTheme();

  useEffect(() => {
    applyTheme(activeTheme);
  }, [activeTheme]);

  const currentIndex = THEMES.findIndex((t) => t.id === activeTheme);
  const current = THEMES[currentIndex] ?? THEMES[0];
  const next = THEMES[(currentIndex + 1) % THEMES.length];
  const [accent, bg] = current.swatch;

  return (
    <button
      type="button"
      onClick={() => setTheme(next.id)}
      aria-label={`Current theme: ${current.label}. Click to switch to ${next.label}`}
      className="flex items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-ink)] shadow-[0_10px_24px_rgba(10,10,10,0.08)] transition hover:-translate-y-0.5"
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: `linear-gradient(135deg, ${accent} 50%, ${bg} 50%)` }}
      />
      {current.label}
    </button>
  );
}
