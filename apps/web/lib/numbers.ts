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
 * A single comma sitting between one-to-three digits and exactly three digits
 * — `1,234`, `2,500`, `12,345`. That is the shape a thousands separator takes,
 * and it is also the shape `1,5`-style decimal commas can never take, because
 * a decimal comma followed by exactly three digits is indistinguishable from
 * grouping. Anchored so it only matches when it is the whole number.
 */
const THOUSANDS_GROUPED = /^[+-]?\d{1,3},\d{3}$/;

/**
 * Parses a user-typed number, accepting `,` as the decimal separator.
 *
 * **The `,` collision is real and unresolvable at this layer.** `"1,234"` is
 * one thousand two hundred and thirty-four to an en-US typist and one point
 * two three four to a decimal-comma typist, and nothing in the string says
 * which. This used to blanket-replace every `,` with `.`, so `"1,234"` became
 * `1.234` — a silent 1000x error that no downstream validation could catch,
 * because 1.234 is a perfectly valid macro value. Ambiguous input is now
 * rejected instead: a caller that gets `null` shows a validation error, which
 * is recoverable, where a wrong-by-1000 number is not.
 *
 * Accepted: no comma at all (`"1234"`, `"1.5"`), or exactly one comma that
 * cannot be read as grouping (`"1,5"`, `"1,50"`, `"1234,5"`).
 * Rejected: grouped shapes (`"1,234"`), several commas (`"1,234,567"`), and
 * anything mixing both separators (`"1,234.56"`, `"1.234,56"`).
 *
 * Returns `null` for anything that is not a finite number.
 */
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
