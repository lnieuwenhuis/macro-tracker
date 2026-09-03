export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const SECTION_HEADING_CLASS =
  "text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]";
export const CARD_CLASS =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 shadow-[0_4px_16px_rgba(74,45,28,0.05)]";
export const EMPTY_STATE_CLASS =
  "rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center text-sm text-[var(--color-muted)]";
export const PRIMARY_BUTTON_CLASS =
  "rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60";
export const SECONDARY_BUTTON_CLASS =
  "rounded-full border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)] disabled:opacity-60";
export const TEXT_INPUT_CLASS =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]";

export function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 5h11" />
      <path d="M7 5V3.5h4V5" />
      <path d="M5 5l.7 9h6.6L13 5" />
    </svg>
  );
}
