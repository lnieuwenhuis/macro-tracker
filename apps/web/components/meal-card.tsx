"use client";

type MealDraft = {
  clientId: string;
  id?: string;
  label: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  caloriesKcal: string;
  sortOrder: number;
};

type MealCardProps = {
  draft: MealDraft;
  busy: boolean;
  error?: string | null;
  onChange: (
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) => void;
  onSave: (clientId: string) => void;
  onDelete: (clientId: string) => void;
};

function NumericInput({
  label,
  value,
  busy,
  step,
  onChange,
}: {
  label: string;
  value: string;
  busy: boolean;
  step: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-2">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <input
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-4 py-3 text-base text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

export function MealCard({
  draft,
  busy,
  error,
  onChange,
  onSave,
  onDelete,
}: MealCardProps) {
  const heading = draft.label.trim() || "New meal";

  return (
    <article className="rounded-[1.5rem] border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 shadow-[0_18px_50px_rgba(74,45,28,0.08)] sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
            Food item
          </p>
          <h3 className="mt-1 font-serif text-[1.65rem] leading-tight text-[var(--color-ink)]">
            {heading}
          </h3>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(draft.clientId)}
          className="rounded-full border border-[var(--color-border-strong)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)] disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      <label className="mt-4 block space-y-2">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
          Name
        </span>
        <input
          type="text"
          value={draft.label}
          disabled={busy}
          onChange={(event) =>
            onChange(draft.clientId, "label", event.target.value)
          }
          className="w-full rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-4 py-3 text-base text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          placeholder="500g quark, banana, oats, chicken breast..."
        />
      </label>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <NumericInput
          label="Protein"
          value={draft.proteinG}
          busy={busy}
          step="0.1"
          onChange={(value) => onChange(draft.clientId, "proteinG", value)}
        />
        <NumericInput
          label="Carbs"
          value={draft.carbsG}
          busy={busy}
          step="0.1"
          onChange={(value) => onChange(draft.clientId, "carbsG", value)}
        />
        <NumericInput
          label="Fat"
          value={draft.fatG}
          busy={busy}
          step="0.1"
          onChange={(value) => onChange(draft.clientId, "fatG", value)}
        />
        <NumericInput
          label="Calories"
          value={draft.caloriesKcal}
          busy={busy}
          step="1"
          onChange={(value) => onChange(draft.clientId, "caloriesKcal", value)}
        />
      </div>

      {error ? (
        <p className="mt-4 text-sm text-[var(--color-danger)]">{error}</p>
      ) : null}

      <button
        type="button"
        disabled={busy}
        onClick={() => onSave(draft.clientId)}
        className="mt-4 w-full rounded-full bg-[var(--color-accent)] px-4 py-3.5 text-sm font-semibold text-white transition-transform duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
      >
        {busy ? "Saving..." : "Save food"}
      </button>
    </article>
  );
}

export type { MealDraft };
