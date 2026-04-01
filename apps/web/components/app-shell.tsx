"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, type ReactNode, useTransition } from "react";

import {
  formatSelectedDate,
  nextDateString,
  previousDateString,
} from "@/lib/formatting";

import { HamburgerMenu } from "./hamburger-menu";

type AppShellProps = {
  userEmail: string;
  selectedDate: string;
  activeTab: "log" | "summary" | "goals";
  children: ReactNode;
};

export function AppShell({
  userEmail,
  selectedDate,
  activeTab,
  children,
}: AppShellProps) {
  const router = useRouter();
  const [isPending, startNavigation] = useTransition();
  const basePath =
    activeTab === "summary" ? "/summary" : activeTab === "goals" ? "/goals" : "/";

  function navigateToDate(nextDate: string) {
    startTransition(() => {
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
              {activeTab === "log" ? "Food Log" : activeTab === "summary" ? "Summary" : "Goals"}
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

            <button
              type="button"
              className="relative flex-1 text-center"
              onClick={() => {
                const input = document.getElementById("date-picker-hidden") as HTMLInputElement;
                input?.showPicker?.();
              }}
            >
              <span className="text-sm font-semibold text-[var(--color-ink)]">
                {formatSelectedDate(selectedDate)}
              </span>
              <input
                id="date-picker-hidden"
                type="date"
                value={selectedDate}
                disabled={isPending}
                onChange={(event) => navigateToDate(event.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
                aria-label="Pick a day"
              />
            </button>

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
        </header>

        <div className="flex-1 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6">
          {children}
        </div>
      </div>
    </main>
  );
}
