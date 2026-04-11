"use client";

type IngredientDraft = {
  clientId: string;
  label: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  caloriesKcal: string;
};

type IngredientCardProps = {
  draft: IngredientDraft;
  disabled?: boolean;
  onChange: (clientId: string, draft: IngredientDraft) => void;
  onDelete: (clientId: string) => void;
  onDuplicate: (clientId: string) => void;
};

function NumericInput({
  label,
  value,
  unit,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  step: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 pr-9 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]">
          {unit}
        </span>
      </div>
    </label>
  );
}

export function IngredientCard({
  draft,
  disabled,
  onChange,
  onDelete,
  onDuplicate,
}: IngredientCardProps) {
  function update(field: keyof IngredientDraft, value: string) {
    onChange(draft.clientId, { ...draft, [field]: value });
  }

  const hasValues =
    Boolean(draft.proteinG) ||
    Boolean(draft.carbsG) ||
    Boolean(draft.fatG) ||
    Boolean(draft.caloriesKcal);

  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] shadow-[0_4px_16px_rgba(74,45,28,0.05)]">
      <div className="px-4 pb-4 pt-3">
        {/* Name + delete row */}
        <div className="flex items-start gap-2">
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Name
            </span>
            <input
              type="text"
              value={draft.label}
              disabled={disabled}
              onChange={(e) => update("label", e.target.value)}
              placeholder="Chicken breast, rice..."
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDuplicate(draft.clientId)}
            className="mt-5 shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-ink)] disabled:opacity-50"
            aria-label={`Duplicate ${draft.label || "ingredient"}`}
            title="Duplicate"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 11V4a1 1 0 0 1 1-1h7" />
            </svg>
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDelete(draft.clientId)}
            className="mt-5 shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-danger)] disabled:opacity-50"
            aria-label={`Remove ${draft.label || "ingredient"}`}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <line x1="4" y1="4" x2="12" y2="12" />
              <line x1="12" y1="4" x2="4" y2="12" />
            </svg>
          </button>
        </div>

        {/* Macro inputs */}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumericInput
            label="Protein"
            value={draft.proteinG}
            unit="g"
            step="0.1"
            disabled={disabled}
            onChange={(v) => update("proteinG", v)}
          />
          <NumericInput
            label="Carbs"
            value={draft.carbsG}
            unit="g"
            step="0.1"
            disabled={disabled}
            onChange={(v) => update("carbsG", v)}
          />
          <NumericInput
            label="Fat"
            value={draft.fatG}
            unit="g"
            step="0.1"
            disabled={disabled}
            onChange={(v) => update("fatG", v)}
          />
          <NumericInput
            label="Calories"
            value={draft.caloriesKcal}
            unit="kcal"
            step="1"
            disabled={disabled}
            onChange={(v) => update("caloriesKcal", v)}
          />
        </div>

        {/* Inline macro summary */}
        {hasValues && (
          <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-0.5">
            {draft.proteinG ? (
              <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">
                P {draft.proteinG}g
              </span>
            ) : null}
            {draft.carbsG ? (
              <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">
                C {draft.carbsG}g
              </span>
            ) : null}
            {draft.fatG ? (
              <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">
                F {draft.fatG}g
              </span>
            ) : null}
            {draft.caloriesKcal ? (
              <span className="text-[10px] font-semibold text-[var(--color-muted)]">
                {draft.caloriesKcal} kcal
              </span>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

export type { IngredientDraft };
