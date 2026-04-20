"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useSyncExternalStore, useTransition } from "react";

import {
  formatSelectedDate,
  nextDateString,
  previousDateString,
} from "@/lib/formatting";
import {
  markNavigationRendered,
  prepareNavigationMotion,
  resolveNavigationMotion,
} from "@/lib/navigation-motion";
import { getLocalDateString, getStartupDateRedirect } from "@/lib/startup-date";

import { HamburgerMenu } from "./hamburger-menu";
import { TransitionLink } from "./transition-link";

type AppShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  activeTab: "log" | "summary" | "recipes" | "goals" | "stats" | "weight";
  showDateNavigation?: boolean;
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
  canAccessAdmin,
  selectedDate,
  activeTab,
  showDateNavigation = true,
  children,
}: AppShellProps) {
  const pathname = usePathname();
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
  const previousDateHref = `${basePath}?date=${previousDateString(selectedDate)}`;
  const nextDateHref = `${basePath}?date=${nextDateString(selectedDate)}`;
  const screenMotion = resolveNavigationMotion(pathname, selectedDate);
  const screenKey = `${pathname}?date=${selectedDate}`;
  const isDayMotion =
    screenMotion === "day-forward" ||
    screenMotion === "day-backward" ||
    screenMotion === "day-jump";
  // For day changes, keep the outer shell (header) mounted and only animate
  // the content. For screen/intro transitions, animate the whole shell.
  const outerKey = isDayMotion ? pathname : screenKey;
  const outerMotion = isDayMotion ? "none" : screenMotion;
  const contentMotion = isDayMotion ? screenMotion : "none";

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

  useEffect(() => {
    markNavigationRendered(pathname, selectedDate);
  }, [pathname, selectedDate]);

  useEffect(() => {
    if (!showDateNavigation) {
      return;
    }

    router.prefetch(previousDateHref);
    router.prefetch(nextDateHref);
  }, [nextDateHref, previousDateHref, router, showDateNavigation]);

  useEffect(() => {
    if (!showDateNavigation) {
      return;
    }

    function handleKey(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          return;
        }
        if (target.isContentEditable) {
          return;
        }
      }

      if (event.key === "ArrowLeft") {
        navigateToDate(previousDateString(selectedDate), "day-backward");
      } else {
        navigateToDate(nextDateString(selectedDate), "day-forward");
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // navigateToDate is defined inline and captures basePath + router; re-register
    // whenever any of those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, basePath, showDateNavigation]);

  function navigateToDate(
    nextDate: string,
    motion: "day-forward" | "day-backward" | "day-jump" = "day-jump",
  ) {
    const href = `${basePath}?date=${nextDate}`;
    prepareNavigationMotion(href, motion);

    startNavigation(() => {
      router.push(href);
    });
  }

  return (
    <main className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <div
          key={outerKey}
          data-screen-motion={outerMotion}
          className="macro-screen-stage flex min-h-screen flex-col"
        >
          {/* Top bar: hamburger + date nav */}
          <header className="px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6">
            {/* Row 1: hamburger + title + spacer */}
            <div className="flex items-center gap-3">
              <HamburgerMenu
                userEmail={userEmail}
                canAccessAdmin={canAccessAdmin}
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
            {showDateNavigation ? (
              <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-shell-panel)] px-2 py-1.5">
                <TransitionLink
                  href={previousDateHref}
                  motion="day-backward"
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                  aria-label="Previous day"
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4l-5 5 5 5" />
                  </svg>
                </TransitionLink>

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
                      onChange={(event) => {
                        const nextDate = event.target.value;
                        const motion =
                          nextDate < selectedDate ? "day-backward"
                          : nextDate > selectedDate ? "day-forward"
                          : "day-jump";

                        navigateToDate(nextDate, motion);
                      }}
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
                      onChange={(event) => {
                        const nextDate = event.target.value;
                        const motion =
                          nextDate < selectedDate ? "day-backward"
                          : nextDate > selectedDate ? "day-forward"
                          : "day-jump";

                        navigateToDate(nextDate, motion);
                      }}
                      className="w-[9.75rem] rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-2 py-1 text-xs text-[var(--color-ink)] outline-none"
                      aria-label="Pick a day"
                    />
                  </label>
                )}

                <TransitionLink
                  href={nextDateHref}
                  motion="day-forward"
                  className="flex h-9 w-9 items-center justify-center rounded-xl text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                  aria-label="Next day"
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7 4l5 5-5 5" />
                  </svg>
                </TransitionLink>
              </div>
            ) : null}

            {/* Jump to today — only shown when not on today */}
            {showDateNavigation && !isToday && (
              <div className="mt-2 flex justify-center">
                <button
                  type="button"
                  onClick={() => navigateToDate(todayStr)}
                  disabled={isPending}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-[var(--color-accent-strong)] disabled:opacity-50"
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

          <div
            key={screenKey}
            data-screen-motion={contentMotion}
            className="macro-screen-stage flex-1 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6"
          >
            {children}
          </div>
        </div>
      </div>
    </main>
  );
}
