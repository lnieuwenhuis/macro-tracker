"use client";

import type { QuickAddCandidate } from "@macro-tracker/db";

type QuickAddRailProps = {
  items: QuickAddCandidate[];
  onAdd: (candidate: QuickAddCandidate) => void;
  emptyState?: React.ReactNode;
};

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
      className="flex w-40 shrink-0 flex-col gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-3.5 text-left shadow-[0_4px_16px_rgba(74,45,28,0.05)] transition hover:-translate-y-0.5 hover:border-[var(--color-accent)] active:translate-y-0"
      aria-label={`Quick add ${candidate.label}`}
    >
      {/* Label */}
      <span className="line-clamp-2 text-[13px] font-semibold leading-tight text-[var(--color-ink)]">
        {candidate.label}
      </span>

      {/* Calories */}
      <span className="text-base font-bold tabular-nums text-[var(--color-ink)]">
        {candidate.caloriesKcal}
        <span className="ml-0.5 text-[11px] font-semibold text-[var(--color-muted)]">kcal</span>
      </span>

      {/* Compact single-line macros — never wrap */}
      <div className="flex items-center gap-2 text-[11px] font-semibold tabular-nums">
        <span className="text-[var(--color-bar-protein)]">P {candidate.proteinG}g</span>
        <span className="text-[var(--color-bar-carbs)]">C {candidate.carbsG}g</span>
        <span className="text-[var(--color-bar-fat)]">F {candidate.fatG}g</span>
      </div>
    </button>
  );
}

export function QuickAddRail({ items, onAdd, emptyState }: QuickAddRailProps) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-[76px] items-center justify-center rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-4 py-4 text-center">
        {emptyState ?? (
          <p className="text-sm text-[var(--color-muted)]">No items yet.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      {items.map((item, index) => (
        <QuickAddCard
          key={`${item.label}-${item.source}-${index}`}
          candidate={item}
          onAdd={onAdd}
        />
      ))}
    </div>
  );
}
