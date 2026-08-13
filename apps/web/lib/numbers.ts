/**
 * Shared numeric parsing, rounding and formatting.
 *
 * These used to be hand-rolled per call site, which let the decimal-comma rule
 * diverge: `"72,5"` parsed fine in the barcode form and became `null` in
 * onboarding, even though both serve the same (comma-using) market.
 */

export function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

export function roundToTwoDecimals(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Parses a user-typed number, accepting `,` as the decimal separator. Returns
 * `null` for anything that is not a finite number.
 */
export function parseDecimalInput(value: string): number | null {
  const trimmed = value.trim().replace(/,/g, ".");
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);

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
