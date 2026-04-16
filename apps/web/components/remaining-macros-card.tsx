import Link from "next/link";

import { formatMacroValue } from "@/lib/formatting";
import type { RemainingMacros } from "@/lib/quick-add";

type MacroStatus = "left" | "hit" | "over";

function getStatus(value: number | null): MacroStatus {
  if (value === null) return "hit";
  if (value > 0.5) return "left";
  if (value < -0.5) return "over";
  return "hit";
}

function StatusBadge({ status }: { status: MacroStatus }) {
  if (status === "hit") {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-success)]">
        hit
      </span>
    );
  }
  if (status === "over") {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-danger)]">
        over
      </span>
    );
  }
  return (
    <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
      left
    </span>
  );
}

type MacroPillProps = {
  label: string;
  value: number | null;
  unit: string;
};

function MacroPill({ label, value, unit }: MacroPillProps) {
  const status = getStatus(value);
  const absValue = value !== null ? Math.abs(value) : null;

  const valueColor =
    status === "over"
      ? "text-[var(--color-danger)]"
      : status === "hit"
        ? "text-[var(--color-success)]"
        : "text-[var(--color-ink)]";

  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-xl bg-[var(--color-shell-panel)] px-1.5 py-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <span className={`text-[15px] font-bold tabular-nums leading-none ${valueColor}`}>
        {absValue !== null ? formatMacroValue(absValue) : "—"}
      </span>
      <span className="text-[10px] font-semibold text-[var(--color-muted)]">{unit}</span>
      <StatusBadge status={status} />
    </div>
  );
}

type RemainingMacrosCardProps = {
  remaining: RemainingMacros;
  hasGoals: boolean;
};

export function RemainingMacrosCard({
  remaining,
  hasGoals,
}: RemainingMacrosCardProps) {
  if (!hasGoals) {
    return (
      <section
        aria-label="Remaining today"
        className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Remaining Today
            </p>
            <p className="mt-0.5 text-sm text-[var(--color-muted)]">
              Set goals to track what&apos;s left for the day.
            </p>
          </div>
          <Link
            href="/goals"
            className="shrink-0 rounded-full border border-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
          >
            Set goals →
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Remaining today"
      className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]"
    >
      <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
        Remaining Today
      </h2>
      <div className="flex gap-2">
        <MacroPill
          label="Cal"
          value={remaining.caloriesKcal}
          unit=" kcal"
        />
        <MacroPill label="Prot" value={remaining.proteinG} unit="g" />
        <MacroPill label="Carbs" value={remaining.carbsG} unit="g" />
        <MacroPill label="Fat" value={remaining.fatG} unit="g" />
      </div>
    </section>
  );
}
