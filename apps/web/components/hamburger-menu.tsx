"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { LeaderboardStats } from "@macro-tracker/db";

import { fetchLeaderboardStatsAction } from "@/lib/actions";
import { formatShortDate } from "@/lib/formatting";
import { ThemeToggle } from "./theme-toggle";
import { TransitionLink } from "./transition-link";

type HamburgerMenuProps = {
  userEmail: string;
  selectedDate: string;
  activeTab: "log" | "summary" | "recipes" | "goals" | "stats" | "weight";
};

type StatRowProps = {
  icon: React.ReactNode;
  iconColor: string;
  label: string;
  value: string;
  date?: string | null;
};

function StatRow({ icon, iconColor, label, value, date }: StatRowProps) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl px-2 py-2">
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
        style={{ background: `color-mix(in srgb, ${iconColor} 15%, transparent)`, color: iconColor }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase leading-none tracking-[0.1em] text-[var(--color-muted)]">
          {label}
        </p>
        <p className="mt-0.5 text-xs font-bold tabular-nums text-[var(--color-ink)]">
          {value}
        </p>
      </div>
      {date && (
        <span className="shrink-0 text-[10px] text-[var(--color-muted)]">{date}</span>
      )}
    </div>
  );
}

function LeaderboardSkeleton() {
  return (
    <div className="space-y-1">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-xl px-2 py-2">
          <div className="h-8 w-8 animate-pulse rounded-lg bg-[var(--color-card-muted)]" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2 w-14 animate-pulse rounded bg-[var(--color-card-muted)]" />
            <div className="h-3 w-20 animate-pulse rounded bg-[var(--color-card-muted)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function HamburgerMenu({
  userEmail,
  selectedDate,
  activeTab,
}: HamburgerMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardStats | null>(null);
  const [leaderboardError, setLeaderboardError] = useState(false);

  useEffect(() => {
    if (!open || leaderboard !== null || leaderboardError) return;

    let cancelled = false;

    fetchLeaderboardStatsAction().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setLeaderboard(result.stats);
      } else {
        setLeaderboardError(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, leaderboard, leaderboardError]);

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

  useEffect(() => {
    if (!open) {
      return;
    }

    router.prefetch(`/?date=${selectedDate}`);
    router.prefetch(`/summary?date=${selectedDate}`);
    router.prefetch(`/recipes?date=${selectedDate}`);
    router.prefetch(`/goals?date=${selectedDate}`);
    router.prefetch("/stats");
    router.prefetch("/weight");
  }, [open, router, selectedDate]);

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
            {/* Header */}
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

            {/* Scrollable middle: nav + leaderboard */}
            <div className="flex-1 overflow-y-auto">
              <nav className="px-4 py-5 space-y-1">
                <TransitionLink
                  href={`/?date=${selectedDate}`}
                  motion="screen"
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
                </TransitionLink>
                <TransitionLink
                  href={`/summary?date=${selectedDate}`}
                  motion="screen"
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
                </TransitionLink>
                <TransitionLink
                  href={`/recipes?date=${selectedDate}`}
                  motion="screen"
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                    activeTab === "recipes"
                      ? "bg-[var(--color-accent)] text-white"
                      : "text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                  }`}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
                    <path d="M6 6h6" />
                    <path d="M6 9h6" />
                    <path d="M6 12h4" />
                  </svg>
                  Recipes
                </TransitionLink>
                <TransitionLink
                  href={`/goals?date=${selectedDate}`}
                  motion="screen"
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
                </TransitionLink>
                <TransitionLink
                  href={`/stats`}
                  motion="screen"
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
                </TransitionLink>
                <TransitionLink
                  href={`/weight`}
                  motion="screen"
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition ${
                    activeTab === "weight"
                      ? "bg-[var(--color-accent)] text-white"
                      : "text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                  }`}
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 2v14" />
                    <path d="M4 4h10" />
                    <path d="M3 8h4v4H3z" />
                    <path d="M11 8h4v4h-4z" />
                    <path d="M4 14h10" />
                  </svg>
                  Weight
                </TransitionLink>
              </nav>

              {/* Leaderboard / personal records */}
              <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                  Your Records
                </p>

                {!leaderboardError && !leaderboard ? (
                  <LeaderboardSkeleton />
                ) : leaderboard ? (
                  <div className="space-y-0.5">
                    {leaderboard.bestCalorieDay && (
                      <StatRow
                        icon={
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 2c0 0-4 3-4 6a4 4 0 0 0 8 0c0-3-4-6-4-6z" />
                            <path d="M6 10c0 1.1.9 2 2 2" />
                          </svg>
                        }
                        iconColor="var(--color-accent)"
                        label="Best Calorie Day"
                        value={`${leaderboard.bestCalorieDay.caloriesKcal.toLocaleString()} kcal`}
                        date={formatShortDate(leaderboard.bestCalorieDay.date)}
                      />
                    )}

                    {leaderboard.bestProteinDay && (
                      <StatRow
                        icon={
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="3" cy="8" r="2" />
                            <circle cx="13" cy="8" r="2" />
                            <line x1="5" y1="8" x2="11" y2="8" />
                            <line x1="7" y1="5" x2="7" y2="11" />
                            <line x1="9" y1="5" x2="9" y2="11" />
                          </svg>
                        }
                        iconColor="#22c55e"
                        label="Best Protein Day"
                        value={`${leaderboard.bestProteinDay.proteinG}g protein`}
                        date={formatShortDate(leaderboard.bestProteinDay.date)}
                      />
                    )}

                    {leaderboard.bestCarbsDay && (
                      <StatRow
                        icon={
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 12c0-4 2-8 5-9 3 1 5 5 5 9" />
                            <path d="M5 12h6" />
                            <path d="M6 9h4" />
                          </svg>
                        }
                        iconColor="#3b82f6"
                        label="Best Carbs Day"
                        value={`${leaderboard.bestCarbsDay.carbsG}g carbs`}
                        date={formatShortDate(leaderboard.bestCarbsDay.date)}
                      />
                    )}

                    {leaderboard.mostActiveDay && (
                      <StatRow
                        icon={
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="3" width="12" height="11" rx="1.5" />
                            <line x1="5" y1="1" x2="5" y2="5" />
                            <line x1="11" y1="1" x2="11" y2="5" />
                            <line x1="2" y1="7" x2="14" y2="7" />
                            <circle cx="5.5" cy="10" r="1" fill="currentColor" stroke="none" />
                            <circle cx="8" cy="10" r="1" fill="currentColor" stroke="none" />
                            <circle cx="10.5" cy="10" r="1" fill="currentColor" stroke="none" />
                          </svg>
                        }
                        iconColor="#a855f7"
                        label="Most Active Day"
                        value={`${leaderboard.mostActiveDay.entryCount} meals`}
                        date={formatShortDate(leaderboard.mostActiveDay.date)}
                      />
                    )}

                    <StatRow
                      icon={
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="2,12 5,7 8,9 11,4 14,7" />
                          <circle cx="14" cy="7" r="1.5" fill="currentColor" stroke="none" />
                        </svg>
                      }
                      iconColor="#f59e0b"
                      label="Current Streak"
                      value={
                        leaderboard.currentStreak === 1
                          ? "1 day"
                          : `${leaderboard.currentStreak} days`
                      }
                    />

                    <StatRow
                      icon={
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8 2l1.5 3.5L13 6l-2.5 2.5.6 3.5L8 10.5 4.9 12l.6-3.5L3 6l3.5-.5z" />
                        </svg>
                      }
                      iconColor="#eab308"
                      label="Best Streak"
                      value={
                        leaderboard.longestStreak === 1
                          ? "1 day"
                          : `${leaderboard.longestStreak} days`
                      }
                    />

                    <StatRow
                      icon={
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="3" width="12" height="11" rx="1.5" />
                          <line x1="5" y1="1" x2="5" y2="5" />
                          <line x1="11" y1="1" x2="11" y2="5" />
                          <line x1="2" y1="7" x2="14" y2="7" />
                        </svg>
                      }
                      iconColor="#64748b"
                      label="Days Tracked"
                      value={
                        leaderboard.totalDaysTracked === 1
                          ? "1 day"
                          : `${leaderboard.totalDaysTracked} days`
                      }
                    />
                  </div>
                ) : null}
              </div>
            </div>

            {/* Footer: theme + user + sign out */}
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
