// Shared native-validity bridge for controlled `type="number"` fields (UI-20/UI-21/UI-28/UI-29).
//
// A React-controlled number input reports an incomplete exponent such as `1e`
// as `event.target.value === ""` with `validity.badInput === true`. A
// string-only parser (`Number(value)`) maps that to `0`, which is
// indistinguishable from a deliberately cleared optional field. These helpers
// read the native `ValidityState` first so saves can block invalid input while
// preserving legitimate empty-optional semantics.

import { parseDecimalInput } from "./numbers";

export type NumberValiditySnapshot = {
  badInput: boolean;
  rangeUnderflow: boolean;
  rangeOverflow: boolean;
  stepMismatch: boolean;
  valueMissing: boolean;
};

const EMPTY_SNAPSHOT: NumberValiditySnapshot = {
  badInput: false,
  rangeUnderflow: false,
  rangeOverflow: false,
  stepMismatch: false,
  valueMissing: false,
};

export function snapshotNumberValidity(
  input: HTMLInputElement | null | undefined,
): NumberValiditySnapshot {
  if (!input?.validity) {
    return { ...EMPTY_SNAPSHOT };
  }

  const { badInput, rangeUnderflow, rangeOverflow, stepMismatch, valueMissing } =
    input.validity;
  return { badInput, rangeUnderflow, rangeOverflow, stepMismatch, valueMissing };
}

/** Native states that must block a save even when the React string is empty. */
export function hasBlockingNativeValidity(snapshot: NumberValiditySnapshot): boolean {
  return (
    snapshot.badInput || snapshot.rangeUnderflow || snapshot.rangeOverflow
  );
}

export function findBlockingNumberInput(
  container: HTMLElement | null,
): HTMLInputElement | null {
  if (!container) {
    return null;
  }

  const inputs = container.querySelectorAll<HTMLInputElement>(
    'input[type="number"]',
  );
  for (const input of inputs) {
    if (hasBlockingNativeValidity(snapshotNumberValidity(input))) {
      return input;
    }
  }

  return null;
}

type NumberFieldCheck = {
  /** Current React-controlled string value. */
  value: string;
  /** Human label used in the actionable error, e.g. "Calories". */
  label: string;
  validity?: NumberValiditySnapshot;
  /** When true, fractional values are rejected without rounding (calories/portions). */
  integer?: boolean;
  /** Inclusive minimum for the parsed value; defaults to no bound. */
  min?: number;
  /** Inclusive maximum for the parsed value; defaults to no bound. */
  max?: number;
  /** When true, an empty string is valid and maps to "clear"/default downstream. */
  optional?: boolean;
};

/**
 * Returns an actionable field error, or `null` when the field may proceed.
 * Empty strings stay valid for optional fields; native `badInput`/range states
 * always fail first so `1e` and `-5` cannot silently become `0`/`null`.
 */
export function getNumberFieldError({
  value,
  label,
  validity = EMPTY_SNAPSHOT,
  integer = false,
  min,
  max,
  optional = true,
}: NumberFieldCheck): string | null {
  if (validity.badInput) {
    return `${label} is not a valid number yet. Finish or clear it before saving.`;
  }

  if (validity.rangeUnderflow && min != null) {
    return `${label} must be at least ${min}.`;
  }

  if (validity.rangeUnderflow) {
    return `${label} must be a positive number.`;
  }

  if (validity.rangeOverflow && max != null) {
    return `${label} must be at most ${max}.`;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return optional ? null : `${label} is required.`;
  }

  const parsed = parseDecimalInput(trimmed);
  if (parsed == null) {
    return `${label} is not a valid number yet. Finish or clear it before saving.`;
  }

  if (integer && !Number.isInteger(parsed)) {
    return `${label} must be a whole number.`;
  }

  if (min != null && parsed < min) {
    return `${label} must be at least ${min}.`;
  }

  if (max != null && parsed > max) {
    return `${label} must be at most ${max}.`;
  }

  return null;
}

/** Validates a positive-optional macro/goal field (`""` clears, otherwise `> 0`). */
export function getPositiveOptionalFieldError(
  value: string,
  label: string,
  validity?: NumberValiditySnapshot,
): string | null {
  const trimmed = value.trim();
  if (!trimmed && !validity?.badInput) {
    return null;
  }

  const base = getNumberFieldError({ value, label, validity, optional: true });
  if (base) {
    return base;
  }

  const parsed = parseDecimalInput(trimmed);
  if (parsed != null && parsed <= 0) {
    return `${label} must be greater than 0, or cleared.`;
  }

  return null;
}
