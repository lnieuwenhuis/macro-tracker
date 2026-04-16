"use client";

import type { QuickAddCandidate } from "@macro-tracker/db";

import Link from "next/link";

type QuickAddRailProps = {
  title: string;
  items: QuickAddCandidate[];
  onAdd: (candidate: QuickAddCandidate) => void;
  emptyState?: React.ReactNode;
};

function SourceBadge({ source }: { source: QuickAddCandidate["source"] }) {
  if (source === "preset") {
    return (
      <span className="rounded bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--color-accent)]">
        Preset
      </span>
    );
  }
  return (
    <span className="rounded bg-[var(--color-card-muted)] px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--color-muted-strong)]">
      Recent
    </span>
  );
}

function QuickAddCard({
  candidate,
  onAdd,
}: {
  candidate: QuickAddCandidate;
  onAdd: (candidate: QuickAddCandidate) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAdd(candidate)}
      className="flex w-36 shrink-0 flex-col gap-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-3 text-left shadow-[0_4px_16px_rgba(74,45,28,0.05)] transition hover:-translate-y-0.5 hover:border-[var(--color-accent)] active:translate-y-0"
      aria-label={`Quick add ${candidate.label}`}
    >
      {/* Label */}
      <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-[var(--color-ink)]">
        {candidate.label}
      </span>

      {/* Compact macros */}
      <div className="flex flex-wrap gap-1">
        {candidate.proteinG > 0 && (
          <span className="rounded-md bg-[color-mix(in_srgb,var(--color-bar-protein)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-protein)]">
            P {candidate.proteinG}g
          </span>
        )}
        {candidate.carbsG > 0 && (
          <span className="rounded-md bg-[color-mix(in_srgb,var(--color-bar-carbs)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-carbs)]">
            C {candidate.carbsG}g
          </span>
        )}
        {candidate.fatG > 0 && (
          <span className="rounded-md bg-[color-mix(in_srgb,var(--color-bar-fat)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-fat)]">
            F {candidate.fatG}g
          </span>
        )}
      </div>

      {/* Calories + source */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] tabular-nums text-[var(--color-muted)]">
          {candidate.caloriesKcal} kcal
        </span>
        <SourceBadge source={candidate.source} />
      </div>
    </button>
  );
}

export function QuickAddRail({
  title,
  items,
  onAdd,
  emptyState,
}: QuickAddRailProps) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
        {title}
      </h3>
      {items.length === 0 ? (
        <div className="flex min-h-[80px] items-center justify-center rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-4 py-4 text-center">
          {emptyState ?? (
            <p className="text-sm text-[var(--color-muted)]">No items yet.</p>
          )}
        </div>
      ) : (
        <div className="flex gap-2.5 overflow-x-auto pb-1.5 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item, index) => (
            <QuickAddCard
              key={`${item.label}-${item.source}-${index}`}
              candidate={item}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type GoalsCTARailProps = {
  title: string;
};

export function GoalsCTARail({ title }: GoalsCTARailProps) {
  return (
    <div>
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
        {title}
      </h3>
      <div className="flex min-h-[80px] items-center justify-center rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-4 py-4 text-center">
        <div>
          <p className="text-sm text-[var(--color-muted)]">
            Set goals to see personalised food suggestions here.
          </p>
          <Link
            href="/goals"
            className="mt-2 inline-block rounded-full border border-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
          >
            Set goals →
          </Link>
        </div>
      </div>
    </div>
  );
}
