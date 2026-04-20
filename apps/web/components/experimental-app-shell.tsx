"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";

import type { ComposeAction } from "@/lib/compose";
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

import { ExperimentalProfileSheet } from "./experimental-profile-sheet";
import { TransitionLink } from "./transition-link";

type ExperimentalAppShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  title: string;
  activeTab: "log" | "progress" | "recipes" | "summary";
  showDateNavigation?: boolean;
  onComposeAction?: (action: ComposeAction) => void;
  topBar?: (controls: { openSettings: () => void }) => ReactNode;
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

export function ExperimentalAppShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  title: _title,
  activeTab,
  showDateNavigation = false,
  onComposeAction,
  topBar,
  children,
}: ExperimentalAppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startNavigation] = useTransition();
  const [profileOpen, setProfileOpen] = useState(false);
  const supportsShowPicker = useSyncExternalStore(
    subscribeToNothing,
    getShowPickerSupport,
    () => true,
  );
  const dateInputRef = useRef<HTMLInputElement>(null);
  const todayStr = useMemo(() => getLocalDateString(), []);
  const isToday = selectedDate === todayStr;
  const basePath = activeTab === "summary" ? "/summary" : "/";
  const previousDateHref = `${basePath}?date=${previousDateString(selectedDate)}`;
  const nextDateHref = `${basePath}?date=${nextDateString(selectedDate)}`;
  const screenMotion = resolveNavigationMotion(pathname, selectedDate);
  const screenKey = `${pathname}?date=${selectedDate}`;
  const isDayMotion =
    screenMotion === "day-forward" ||
    screenMotion === "day-backward" ||
    screenMotion === "day-jump";
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

  useEffect(() => {
    if (!onComposeAction) return;

    function handleAddEvent(event: Event) {
      const action = (event as CustomEvent<ComposeAction>).detail;
      if (action) onComposeAction!(action);
    }

    window.addEventListener("macro-tracker-add", handleAddEvent);
    return () => window.removeEventListener("macro-tracker-add", handleAddEvent);
  }, [onComposeAction]);

  return (
    <>
      <main className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-ink)]">
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
          <div
            key={outerKey}
            data-screen-motion={outerMotion}
            className="macro-screen-stage flex min-h-screen flex-col"
          >
            {showDateNavigation ? (
              <div className="sticky top-0 z-20 px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1 rounded-[1.45rem] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-strong)_92%,transparent)] p-1 shadow-[0_16px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl">
                    <div className="flex h-12 items-center justify-between gap-2 rounded-[1.05rem] bg-[var(--color-shell-panel)] px-1.5">
                      <TransitionLink
                        href={previousDateHref}
                        motion="day-backward"
                        className="flex h-8 w-8 items-center justify-center rounded-xl text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                        aria-label="Previous day"
                      >
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M11 4l-5 5 5 5" />
                        </svg>
                      </TransitionLink>

                      {supportsShowPicker ? (
                        <button
                          type="button"
                          className="relative flex h-full flex-1 items-center justify-center text-center"
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
                        <label className="relative flex h-full flex-1 items-center justify-center text-center">
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
                        </label>
                      )}

                      <TransitionLink
                        href={nextDateHref}
                        motion="day-forward"
                        className="flex h-8 w-8 items-center justify-center rounded-xl text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                        aria-label="Next day"
                      >
                        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M7 4l5 5-5 5" />
                        </svg>
                      </TransitionLink>
                    </div>
                  </div>
                  <ExperimentalSettingsButton
                    onClick={() => setProfileOpen(true)}
                    className="shrink-0"
                  />
                </div>
              </div>
            ) : null}

            <div
              key={screenKey}
              data-screen-motion={contentMotion}
              className={[
                "macro-screen-stage flex-1 px-4 pb-[calc(6.9rem+env(safe-area-inset-bottom))] sm:px-6",
                showDateNavigation
                  ? "pt-2"
                  : "pt-[calc(0.8rem+env(safe-area-inset-top))]",
              ].join(" ")}
            >
              {!showDateNavigation && topBar ? topBar({
                openSettings: () => setProfileOpen(true),
              }) : null}

              {!showDateNavigation && !topBar ? (
                <div className="mb-3 flex justify-end">
                  <ExperimentalSettingsButton onClick={() => setProfileOpen(true)} />
                </div>
              ) : null}
              {children}
            </div>
          </div>
        </div>
      </main>

      {showDateNavigation && !isToday ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.35rem+env(safe-area-inset-bottom))] z-40 px-4">
          <div className="mx-auto flex w-full max-w-3xl justify-center">
            <button
              type="button"
              onClick={() => navigateToDate(todayStr)}
              disabled={isPending}
              className="pointer-events-auto inline-flex h-10 items-center gap-1.5 rounded-full bg-[var(--color-accent)] px-4 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(0,0,0,0.18)] transition hover:-translate-y-0.5 disabled:opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="2" width="10" height="9" rx="1.5" />
                <line x1="1" y1="5" x2="11" y2="5" />
                <line x1="4" y1="1" x2="4" y2="3" />
                <line x1="8" y1="1" x2="8" y2="3" />
              </svg>
              Today
            </button>
          </div>
        </div>
      ) : null}

      <ExperimentalProfileSheet
        open={profileOpen}
        userEmail={userEmail}
        canAccessAdmin={canAccessAdmin}
        onClose={() => setProfileOpen(false)}
      />
    </>
  );
}

export function ExperimentalSettingsButton({
  onClick,
  className = "",
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex h-12 w-12 items-center justify-center rounded-full border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-strong)_92%,transparent)] text-[var(--color-ink)] shadow-[0_10px_20px_rgba(0,0,0,0.12)] backdrop-blur-xl transition hover:bg-[var(--color-card-muted)]",
        className,
      ].join(" ")}
      aria-label="Open settings"
    >
      <svg width="17" height="17" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="6" r="3" />
        <path d="M3 15c1.5-2.5 4-3.5 6-3.5s4.5 1 6 3.5" />
      </svg>
    </button>
  );
}
