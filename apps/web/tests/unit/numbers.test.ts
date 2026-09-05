import { describe, expect, it } from "vitest";

import {
  formatMacroValue,
  parseDecimalInput,
  parseNonNegativeNumber,
  parsePositiveNumber,
  roundToSingleDecimal,
  roundToTwoDecimals,
} from "@/lib/numbers";

describe("parseDecimalInput", () => {
  it("reads a period as the decimal separator", () => {
    expect(parseDecimalInput("1.5")).toBe(1.5);
    expect(parseDecimalInput("0.25")).toBe(0.25);
    expect(parseDecimalInput("  72.5  ")).toBe(72.5);
  });

  it("reads an unambiguous comma as the decimal separator", () => {
    // The decimal-comma market this app serves types "72,5".
    expect(parseDecimalInput("1,5")).toBe(1.5);
    expect(parseDecimalInput("72,5")).toBe(72.5);
    expect(parseDecimalInput("1,50")).toBe(1.5);
    expect(parseDecimalInput("1234,5")).toBe(1234.5);
    expect(parseDecimalInput(",5")).toBe(0.5);
    expect(parseDecimalInput("-1,5")).toBe(-1.5);
  });

  it("rejects thousands-grouped input instead of shifting the decimal point", () => {
    // Grouped shapes must reject outright, not silently shift the decimal point.
    expect(parseDecimalInput("1,234")).toBeNull();
    expect(parseDecimalInput("2,500")).toBeNull();
    expect(parseDecimalInput("12,345")).toBeNull();
    expect(parseDecimalInput("-1,234")).toBeNull();
  });

  it("rejects input that mixes both separators", () => {
    expect(parseDecimalInput("1,234.56")).toBeNull();
    expect(parseDecimalInput("1.234,56")).toBeNull();
  });

  it("rejects more than one comma", () => {
    expect(parseDecimalInput("1,234,567")).toBeNull();
    expect(parseDecimalInput("1,2,3")).toBeNull();
  });

  it("never returns a value 1000x smaller than a grouped input", () => {
    for (const grouped of ["1,234", "9,000", "10,500", "100,000"]) {
      expect(parseDecimalInput(grouped)).toBeNull();
    }
  });

  it("leaves plain integers and garbage behaving as before", () => {
    expect(parseDecimalInput("1234")).toBe(1234);
    expect(parseDecimalInput("0")).toBe(0);
    expect(parseDecimalInput("-3")).toBe(-3);
    expect(parseDecimalInput("")).toBeNull();
    expect(parseDecimalInput("   ")).toBeNull();
    expect(parseDecimalInput("abc")).toBeNull();
    expect(parseDecimalInput("1.2.3")).toBeNull();
    expect(parseDecimalInput("Infinity")).toBeNull();
  });
});

describe("parsePositiveNumber / parseNonNegativeNumber", () => {
  it("inherits the stricter comma rule", () => {
    expect(parsePositiveNumber("1,5")).toBe(1.5);
    expect(parsePositiveNumber("2,500")).toBeNull();
    expect(parseNonNegativeNumber("1,234")).toBeNull();
  });

  it("still applies its own sign bound", () => {
    expect(parsePositiveNumber("0")).toBeNull();
    expect(parseNonNegativeNumber("0")).toBe(0);
    expect(parsePositiveNumber("-1")).toBeNull();
  });
});

describe("rounding and formatting", () => {
  it("rounds to the documented precision", () => {
    expect(roundToSingleDecimal(1.24)).toBe(1.2);
    expect(roundToTwoDecimals(1.005)).toBe(1);
  });

  it("renders integers bare and fractions to one decimal", () => {
    expect(formatMacroValue(12)).toBe("12");
    expect(formatMacroValue(12.34)).toBe("12.3");
  });
});
