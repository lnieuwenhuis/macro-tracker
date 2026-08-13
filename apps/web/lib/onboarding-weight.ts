import type { WeightUnit } from "@macro-tracker/db";

import { parsePositiveNumber, roundToTwoDecimals } from "./numbers";

const POUNDS_PER_KG = 2.2046226218;

export { parsePositiveNumber };

export function convertWeight(
  value: number,
  from: WeightUnit,
  to: WeightUnit,
): number {
  if (from === to) {
    return value;
  }

  return roundToTwoDecimals(
    to === "lb" ? value * POUNDS_PER_KG : value / POUNDS_PER_KG,
  );
}

export function normalizeOnboardingWeightKg(
  value: string,
  unit: WeightUnit,
): number | null {
  const parsed = parsePositiveNumber(value);
  if (parsed == null) {
    return null;
  }

  return unit === "lb" ? roundToTwoDecimals(parsed / POUNDS_PER_KG) : parsed;
}
