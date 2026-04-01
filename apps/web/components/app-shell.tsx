"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, type ReactNode, useTransition } from "react";

import {
  formatSelectedDate,
  nextDateString,
  previousDateString,
} from "@/lib/formatting";

import { ThemeToggle } from "./theme-toggle";

type AppShellProps = {
  userEmail: string;
  selectedDate: string;
  activeTab: "log" | "summary";
  children: ReactNode;
};

function tabClass(active: boolean) {
  return active
    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
    : "border-[var(--color-border)] bg-[var(--color-shell-panel)] text-[var(--color-muted-strong)]";
}

export function AppShell({
  userEmail,
  selectedDate,
  activeTab,
  children,
}: AppShellProps) {
  const router = useRouter();
  const [isPending, startNavigation] = useTransition();
  const basePath = activeTab === "summary" ? "/summary" : "/";

  function navigateToDate(nextDate: string) {
    startTransition(() => {
      router.push(`${basePath}?date=${nextDate}`);
    });
  }

  return (
    <main className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <header className="px-5 pb-5 pt-[calc(1rem+env(safe-area-inset-top))] sm:px-6 sm:pb-6 sm:pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--color-muted-strong)]">
                Macro Tracker
              </p>
              <h1 className="mt-2 max-w-[10ch] font-serif text-[2.85rem] leading-[0.92] text-[var(--color-ink)] sm:max-w-none sm:text-5xl">
                {formatSelectedDate(selectedDate)}
              </h1>
              <p className="mt-3 text-sm leading-6 text-[var(--color-muted)]">
                Signed in as {userEmail}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-shell-panel)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)] transition hover:border-[var(--color-ink)] hover:text-[var(--color-ink)]"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>

          <nav className="mt-5 grid grid-cols-2 gap-2">
            <Link
              href={`/?date=${selectedDate}`}
              className={`rounded-full border px-4 py-3 text-center text-sm font-semibold transition ${tabClass(activeTab === "log")}`}
            >
              Food log
            </Link>
            <Link
              href={`/summary?date=${selectedDate}`}
              className={`rounded-full border px-4 py-3 text-center text-sm font-semibold transition ${tabClass(activeTab === "summary")}`}
            >
              Summary
            </Link>
          </nav>

          <div className="mt-4 rounded-[1.5rem] border border-[var(--color-border)] bg-[var(--color-shell-panel)] p-3">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
              Pick a day
            </span>
            <div className="mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-2">
              <Link
                href={`${basePath}?date=${previousDateString(selectedDate)}`}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-3 text-sm font-semibold text-[var(--color-ink)]"
              >
                Prev
              </Link>

              <label>
                <span className="sr-only">Pick a day</span>
                <input
                  type="date"
                  value={selectedDate}
                  disabled={isPending}
                  onChange={(event) => navigateToDate(event.target.value)}
                  className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-base text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
                />
              </label>

              <Link
                href={`${basePath}?date=${nextDateString(selectedDate)}`}
                className="rounded-full border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-3 text-sm font-semibold text-[var(--color-ink)]"
              >
                Next
              </Link>
            </div>
          </div>
        </header>

        <div className="flex-1 px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6">
          {children}
        </div>
      </div>
    </main>
  );
}
