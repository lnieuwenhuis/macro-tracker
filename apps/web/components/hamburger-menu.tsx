"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "./theme-toggle";

type HamburgerMenuProps = {
  userEmail: string;
  selectedDate: string;
  activeTab: "log" | "summary" | "goals" | "stats";
};

export function HamburgerMenu({
  userEmail,
  selectedDate,
  activeTab,
}: HamburgerMenuProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-shell-panel)] text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
        aria-label="Open menu"
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <line x1="3" y1="5" x2="17" y2="5" />
          <line x1="3" y1="10" x2="17" y2="10" />
          <line x1="3" y1="15" x2="17" y2="15" />
        </svg>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" />

          <div
            ref={panelRef}
            className="relative z-10 flex h-full w-72 max-w-[80vw] flex-col bg-[var(--color-surface-strong)] shadow-2xl animate-in slide-in-from-left"
            style={{ animation: "slideIn 0.2s ease-out" }}
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 pb-4 pt-[calc(1rem+env(safe-area-inset-top))]">
              <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--color-accent)]">
                Macro Tracker
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
                aria-label="Close menu"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                >
                  <line x1="4" y1="4" x2="14" y2="14" />
                  <line x1="14" y1="4" x2="4" y2="14" />
                </svg>
              </button>
            </div>

            <nav className="flex-1 px-4 py-5 space-y-1">
              <Link
                href={`/?date=${selectedDate}`}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                  activeTab === "log"
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3h12v12H3z" />
                  <path d="M3 7h12" />
                  <path d="M7 7v8" />
                </svg>
                Food Log
              </Link>
              <Link
                href={`/summary?date=${selectedDate}`}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                  activeTab === "summary"
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="10" width="3" height="6" />
                  <rect x="7.5" y="6" width="3" height="10" />
                  <rect x="13" y="2" width="3" height="14" />
                </svg>
                Summary
              </Link>
              <Link
                href={`/goals?date=${selectedDate}`}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                  activeTab === "goals"
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="9" cy="9" r="7" />
                  <circle cx="9" cy="9" r="3" />
                  <line x1="9" y1="2" x2="9" y2="4" />
                  <line x1="9" y1="14" x2="9" y2="16" />
                  <line x1="2" y1="9" x2="4" y2="9" />
                  <line x1="14" y1="9" x2="16" y2="9" />
                </svg>
                Goals
              </Link>
              <Link
                href={`/stats`}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                  activeTab === "stats"
                    ? "bg-[var(--color-accent)] text-white"
                    : "text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="2,14 6,8 9,11 12,5 16,9" />
                  <circle cx="16" cy="9" r="1.5" fill="currentColor" stroke="none" />
                </svg>
                Stats
              </Link>
            </nav>

            <div className="border-t border-[var(--color-border)] px-5 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                  Theme
                </span>
                <ThemeToggle />
              </div>

              <p className="truncate text-xs text-[var(--color-muted)]">
                {userEmail}
              </p>

              <form action="/api/auth/logout" method="post">
                <button
                  type="submit"
                  className="w-full rounded-xl border border-[var(--color-border)] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
