"use client";

import type { ChangeEvent, Ref } from "react";

type NumberInputFieldProps = {
  label: string;
  value: string;
  unit: string;
  step: string;
  min?: string;
  max?: string;
  name?: string;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string, input: HTMLInputElement | null) => void;
  variant?: "default" | "card";
  labelClassName?: string;
  fieldClassName?: string;
  controlClassName?: string;
  inputClassName?: string;
  unitClassName?: string;
};

const NUMBER_FIELD_VARIANTS = {
  default: {
    labelClassName: "block",
    fieldClassName:
      "mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]",
    controlClassName: "relative",
    inputClassName:
      "w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 pr-16 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60",
    unitClassName:
      "pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]",
  },
  card: {
    labelClassName:
      "block rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4",
    fieldClassName:
      "text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]",
    controlClassName: "relative mt-2",
    inputClassName:
      "w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-3 pr-12 text-base font-semibold text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:opacity-60",
    unitClassName:
      "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[var(--color-muted)]",
  },
} satisfies Record<
  NonNullable<NumberInputFieldProps["variant"]>,
  {
    labelClassName: string;
    fieldClassName: string;
    controlClassName: string;
    inputClassName: string;
    unitClassName: string;
  }
>;

export function NumberInputField({
  label,
  value,
  unit,
  step,
  min = "0",
  max,
  name,
  required,
  invalid,
  describedBy,
  disabled,
  inputRef,
  onChange,
  variant = "default",
  labelClassName,
  fieldClassName,
  controlClassName,
  inputClassName,
  unitClassName,
}: NumberInputFieldProps) {
  const classes = NUMBER_FIELD_VARIANTS[variant];

  return (
    <label className={labelClassName ?? classes.labelClassName}>
      <span className={fieldClassName ?? classes.fieldClassName}>{label}</span>
      <div className={controlClassName ?? classes.controlClassName}>
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          name={name}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          ref={inputRef}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onChange(event.target.value, event.target)
          }
          className={inputClassName ?? classes.inputClassName}
        />
        <span className={unitClassName ?? classes.unitClassName}>{unit}</span>
      </div>
    </label>
  );
}
