"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useSyncExternalStore, useTransition } from "react";

import {
  formatSelectedDate,
  nextDateString,
  previousDateString,
} from "@/lib/formatting";
import { getLocalDateString, getStartupDateRedirect } from "@/lib/startup-date";

import { HamburgerMenu } from "./hamburger-menu";

type AppShellProps = {
  userEmail: string;
  selectedDate: string;
  activeTab: "log" | "summary" | "recipes" | "goals" | "stats" | "weight";
  children: ReactNode;
};

function subscribeToNothing() {
  return () => {};
}

function getShowPickerSupport() {
  return (
    typeof HTMLInputElement !== "undefined" &&
    "showPicker" in HTMLInputElement.prototype
  );
}

export function AppShell({
  userEmail,
  selectedDate,
  activeTab,
  children,
}: AppShellProps) {
  const router = useRouter();
  const [isPending, startNavigation] = useTransition();
  const supportsShowPicker = useSyncExternalStore(
    subscribeToNothing,
    getShowPickerSupport,
    () => true,
  );
  const dateInputRef = useRef<HTMLInputElement>(null);
  const todayStr = useMemo(() => getLocalDateString(), []);
  const isToday = selectedDate === todayStr;
  const basePath =
    activeTab === "summary" ? "/summary"
    : activeTab === "recipes" ? "/recipes"
    : activeTab === "goals" ? "/goals"
    : activeTab === "stats" ? "/stats"
    : activeTab === "weight" ? "/weight"
    : "/";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextDate = getStartupDateRedirect({
      requestedDate: params.get("date"),
      selectedDate,
      localDate: getLocalDateString(),
    });

    if (!nextDate) {
      return;
    }

    params.set("date", nextDate);

    startNavigation(() => {
      router.replace(`${window.location.pathname}?${params.toString()}`, {
        scroll: false,
      });
    });
  }, [router, selectedDate, startNavigation]);

  function navigateToDate(nextDate: string) {
    startNavigation(() => {
      router.push(`${basePath}?date=${nextDate}`);
    });
  }

  return (
    <main className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        {/* Top bar: hamburger + date nav */}
        <header className="px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6">
          {/* Row 1: hamburger + title + spacer */}
          <div className="flex items-center gap-3">
            <HamburgerMenu
              userEmail={userEmail}
              selectedDate={selectedDate}
              activeTab={activeTab}
            />
            <h1 className="flex-1 text-center font-serif text-xl font-semibold text-[var(--color-ink)]">
              {activeTab === "log" ? "Food Log" : activeTab === "summary" ? "Summary" : activeTab === "recipes" ? "Recipes" : activeTab === "stats" ? "Stats" : activeTab === "weight" ? "Weight" : "Goals"}
            </h1>
            {/* Invisible spacer to keep title centered */}
            <div className="h-10 w-10" />
          </div>

          {/* Row 2: date navigation */}
          <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-shell-panel)] px-2 py-1.5">
            <Link
              href={`${basePath}?date=${previousDateString(selectedDate)}`}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
              aria-label="Previous day"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4l-5 5 5 5" />
              </svg>
            </Link>

            {supportsShowPicker ? (
              <button
                type="button"
                className="relative flex-1 text-center"
                onClick={() => dateInputRef.current?.showPicker?.()}
              >
                <span className="text-sm font-semibold text-[var(--color-ink)]">
                  {formatSelectedDate(selectedDate)}
                </span>
                <input
                  ref={dateInputRef}
                  type="date"
                  value={selectedDate}
                  disabled={isPending}
                  onChange={(event) => navigateToDate(event.target.value)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="Pick a day"
                />
              </button>
            ) : (
              <label className="flex flex-1 flex-col items-center gap-1 py-1 text-center">
                <span className="text-sm font-semibold text-[var(--color-ink)]">
                  {formatSelectedDate(selectedDate)}
                </span>
                <input
                  ref={dateInputRef}
                  type="date"
                  value={selectedDate}
                  disabled={isPending}
                  onChange={(event) => navigateToDate(event.target.value)}
                  className="w-[9.75rem] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none"
                  aria-label="Pick a day"
                />
              </label>
            )}

            <Link
              href={`${basePath}?date=${nextDateString(selectedDate)}`}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
              aria-label="Next day"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 4l5 5-5 5" />
              </svg>
            </Link>
          </div>

          {/* Jump to today — only shown when not on today */}
          {!isToday && (
            <div className="mt-2 flex justify-center">
              <button
                type="button"
                onClick={() => navigateToDate(todayStr)}
                disabled={isPending}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)]/10 px-3 py-1 text-xs font-semibold text-[var(--color-accent)] transition hover:bg-[var(--color-accent)]/20 disabled:opacity-50"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1" y="2" width="10" height="9" rx="1.5" />
                  <line x1="1" y1="5" x2="11" y2="5" />
                  <line x1="4" y1="1" x2="4" y2="3" />
                  <line x1="8" y1="1" x2="8" y2="3" />
                </svg>
                Today
              </button>
            </div>
          )}
        </header>

        <div className="flex-1 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6">
          {children}
        </div>
      </div>
    </main>
  );
}
