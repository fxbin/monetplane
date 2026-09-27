import { describe, expect, it } from "vitest";
import {
  currencyDecimals,
  minorToDisplayString,
  parseDisplayAmountToMinor,
  parseProviderAmountToMinor,
  ZERO_DECIMAL_CURRENCIES,
} from "../src/lib/money";

describe("currencyDecimals", () => {
  it("returns 0 for ISO zero-minor-unit currencies", () => {
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("MGA")).toBe(0);
    expect(currencyDecimals("XAF")).toBe(0);
    expect(currencyDecimals("BIF")).toBe(0);
    expect(currencyDecimals("KRW")).toBe(0);
    expect(currencyDecimals("VND")).toBe(0);
    expect(currencyDecimals("XOF")).toBe(0);
  });

  it("treats ISK as zero-decimal (Stripe-style, unified registry)", () => {
    expect(currencyDecimals("ISK")).toBe(0);
  });

  it("returns 2 for two-decimal currencies", () => {
    expect(currencyDecimals("USD")).toBe(2);
    expect(currencyDecimals("EUR")).toBe(2);
    expect(currencyDecimals("GBP")).toBe(2);
    expect(currencyDecimals("CNY")).toBe(2);
  });

  it("is case-insensitive and only ever yields 0 or 2", () => {
    expect(currencyDecimals("jpy")).toBe(0);
    expect(currencyDecimals("usd")).toBe(2);
    for (const code of ["AAA", "ZZZ", "", "us"]) {
      const decimals = currencyDecimals(code);
      expect([0, 2]).toContain(decimals);
    }
  });

  it("keeps the registry uppercase-only", () => {
    for (const code of ZERO_DECIMAL_CURRENCIES) {
      expect(code).toBe(code.toUpperCase());
    }
  });
});

describe("parseDisplayAmountToMinor", () => {
  it("parses two-decimal display input into minor units", () => {
    expect(parseDisplayAmountToMinor("10.50", "USD")).toBe(1050);
    expect(parseDisplayAmountToMinor("10.5", "USD")).toBe(1050);
    expect(parseDisplayAmountToMinor("10", "USD")).toBe(1000);
    expect(parseDisplayAmountToMinor("0", "USD")).toBe(0);
    expect(parseDisplayAmountToMinor("10.", "USD")).toBe(1000);
  });

  it("accepts 1,000.50-style grouping", () => {
    expect(parseDisplayAmountToMinor("1,000.50", "USD")).toBe(100050);
    expect(parseDisplayAmountToMinor("1,000,000", "USD")).toBe(100000000);
  });

  it("parses zero-decimal input as whole minor units (JPY)", () => {
    expect(parseDisplayAmountToMinor("1000", "JPY")).toBe(1000);
    expect(parseDisplayAmountToMinor("1,000", "JPY")).toBe(1000);
    expect(parseDisplayAmountToMinor("0", "JPY")).toBe(0);
  });

  it("rejects fractional input for zero-decimal currencies instead of rounding", () => {
    expect(parseDisplayAmountToMinor("10.5", "JPY")).toBeUndefined();
    expect(parseDisplayAmountToMinor("10.", "JPY")).toBeUndefined();
    expect(parseDisplayAmountToMinor("1000.01", "ISK")).toBeUndefined();
  });

  it("rejects invalid input", () => {
    expect(parseDisplayAmountToMinor("", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor("  ", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor("abc", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor("-5", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor("10.505", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor("10,50", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor("1,00", "USD")).toBeUndefined();
    expect(parseDisplayAmountToMinor(",000", "USD")).toBeUndefined();
    expect(
      parseDisplayAmountToMinor("99999999999999999999", "USD"),
    ).toBeUndefined();
  });
});

describe("parseProviderAmountToMinor", () => {
  it("parses provider decimal strings exactly", () => {
    expect(parseProviderAmountToMinor("29.00", "USD")).toBe(2900);
    expect(parseProviderAmountToMinor("49.90", "USD")).toBe(4990);
    expect(parseProviderAmountToMinor("9.9", "USD")).toBe(990);
    expect(parseProviderAmountToMinor("1000", "JPY")).toBe(1000);
  });

  it("accepts numeric provider values", () => {
    expect(parseProviderAmountToMinor(29.9, "USD")).toBe(2990);
    expect(parseProviderAmountToMinor(1000, "JPY")).toBe(1000);
  });

  it("rounds sub-minor digits half-up deterministically", () => {
    expect(parseProviderAmountToMinor("19.005", "USD")).toBe(1901);
    expect(parseProviderAmountToMinor("19.004", "USD")).toBe(1900);
    expect(parseProviderAmountToMinor("10.5", "JPY")).toBe(11);
  });

  it("rejects non-numeric and unsafe input", () => {
    expect(parseProviderAmountToMinor(undefined, "USD")).toBeUndefined();
    expect(parseProviderAmountToMinor(null, "USD")).toBeUndefined();
    expect(parseProviderAmountToMinor("", "USD")).toBeUndefined();
    expect(parseProviderAmountToMinor("abc", "USD")).toBeUndefined();
    expect(parseProviderAmountToMinor("1e+21", "USD")).toBeUndefined();
    expect(
      parseProviderAmountToMinor("99999999999999999999", "USD"),
    ).toBeUndefined();
  });
});

describe("minorToDisplayString", () => {
  it("renders two-decimal currencies with two fraction digits", () => {
    expect(minorToDisplayString(1050, "USD")).toBe("10.50");
    expect(minorToDisplayString(5, "USD")).toBe("0.05");
    expect(minorToDisplayString(0, "USD")).toBe("0.00");
    expect(minorToDisplayString(-1050, "USD")).toBe("-10.50");
  });

  it("renders zero-decimal currencies as whole units", () => {
    expect(minorToDisplayString(1000, "JPY")).toBe("1000");
    expect(minorToDisplayString(0, "JPY")).toBe("0");
    expect(minorToDisplayString(-1000, "ISK")).toBe("-1000");
  });

  it("contains digits only (no symbol, no grouping)", () => {
    const digits = minorToDisplayString(1234500, "USD");
    expect(digits).toBe("12345.00");
    expect(digits).not.toContain(",");
    expect(digits).not.toContain("$");
  });

  it("throws on non-safe-integer minor amounts", () => {
    expect(() => minorToDisplayString(10.5, "USD")).toThrow(TypeError);
    expect(() => minorToDisplayString(Number.NaN, "USD")).toThrow(TypeError);
    expect(() => minorToDisplayString(1e21, "USD")).toThrow(TypeError);
  });
});
