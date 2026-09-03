// Shared parsing/rounding/formatting so the decimal-comma rule below applies everywhere.

export function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

export function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

// A thousands-grouped shape ("1,234"), indistinguishable from a decimal comma followed by exactly three digits.
const THOUSANDS_GROUPED = /^[+-]?\d{1,3},\d{3}$/;

// Rejects ambiguous "," shapes as null instead of guessing, because a wrong guess is silently off by 1000x.
export function parseDecimalInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  let normalized = trimmed;
  const commas = trimmed.split(",").length - 1;

  if (commas > 0) {
    if (
      commas > 1 ||
      trimmed.includes(".") ||
      THOUSANDS_GROUPED.test(trimmed)
    ) {
      return null;
    }

    normalized = trimmed.replace(",", ".");
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePositiveNumber(value: string): number | null {
  const parsed = parseDecimalInput(value);

  return parsed != null && parsed > 0 ? parsed : null;
}

export function parseNonNegativeNumber(value: string): number | null {
  const parsed = parseDecimalInput(value);

  return parsed != null && parsed >= 0 ? parsed : null;
}

/** Renders a macro number for display: integers bare, otherwise one decimal. */
export function formatMacroValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
