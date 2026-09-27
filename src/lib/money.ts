/**
 * Single money authority (audit A1): currency minor-unit handling shared by
 * provider adapters, the product builder, and dashboard formatting.
 *
 * MonetPlane stores every amount as an integer number of minor units
 * (Number.isSafeInteger-validated; no float arithmetic). This module is the
 * only place that decides how a currency maps between minor units and
 * display/provider strings. It is intentionally dependency-free and pure so
 * it is safe to import from client components ("use client") and server
 * adapters alike.
 *
 * History: paypal.ts and waffo.ts used to carry two divergent zero-decimal
 * tables (one had MGA/XAF but not ISK, the other ISK but not MGA/XAF), so
 * the same JPY/ISK product could differ 100x per provider. This registry
 * supersedes both.
 */

/**
 * ISO-4217 currencies with an exponent of 0 (no minor unit in practice),
 * plus ISK.
 *
 * ISK is not ISO-4217 zero-minor-unit, but Stripe and most e-commerce
 * platforms treat it as 0-decimal because Icelandic banks stopped using
 * the eyrir in practice. This registry intentionally supersedes PayPal's
 * old 2-decimal ISK handling: amounts for ISK are now minor units = whole
 * krónur everywhere in MonetPlane (a deliberate behavioral change from the
 * pre-unification PayPal adapter).
 */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

/**
 * Minor-unit decimal places for a currency: 0 for zero-decimal currencies,
 * 2 for everything else. Only 0 and 2 exist in this system (no 3-decimal
 * KWD/BHD-style handling anywhere as of audit A1).
 */
export function currencyDecimals(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

// Display input ("1,000.50" style): either an ungrouped integer run or
// properly grouped thousands; commas must separate exactly three digits.
const GROUPED_INTEGER = String.raw`(?:\d+|\d{1,3}(?:,\d{3})+)`;
const DISPLAY_WHOLE_UNITS_PATTERN = new RegExp(`^${GROUPED_INTEGER}$`);
const DISPLAY_TWO_DECIMALS_PATTERN = new RegExp(
  `^${GROUPED_INTEGER}(?:\\.\\d{0,2})?$`,
);

/**
 * Parse a user-entered display amount ("10.50", "1,000.50", "1000") into
 * minor units for the currency. Decimal-aware replacement for the product
 * builder wizard's hardcoded ×100 parser.
 *
 * Returns undefined for anything that is not a valid non-negative amount
 * with at most `currencyDecimals` fraction digits. For zero-decimal
 * currencies a fractional input is rejected (never rounded silently);
 * a trailing dot is accepted for 2-decimal currencies only ("10." = "10").
 */
export function parseDisplayAmountToMinor(
  input: string,
  currency: string,
): number | undefined {
  const decimals = currencyDecimals(currency);
  const trimmed = input.trim();
  const pattern =
    decimals === 0 ? DISPLAY_WHOLE_UNITS_PATTERN : DISPLAY_TWO_DECIMALS_PATTERN;
  if (!pattern.test(trimmed)) return undefined;

  const normalized = trimmed.replaceAll(",", "");
  const [integerPart, fractionPart = ""] = normalized.split(".");
  const integer = Number(integerPart);
  if (!Number.isSafeInteger(integer)) return undefined;
  if (decimals === 0) return integer;

  const scale = 10 ** decimals;
  if (integer > Number.MAX_SAFE_INTEGER / scale) return undefined;
  const minor = integer * scale + Number(fractionPart.padEnd(decimals, "0"));
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/**
 * Parse a provider-supplied major-unit value (PayPal "19.00" / Waffo
 * webhook "49.90" display strings, occasionally a number) into minor units.
 *
 * Parsed with exact integer arithmetic (no float multiply): the integer
 * part and the first `currencyDecimals` fraction digits are combined, and
 * any further sub-minor digits are rounded half-up in magnitude so a
 * hypothetical "19.005" resolves deterministically. Returns undefined for
 * non-numeric or unsafe-integer results.
 */
export function parseProviderAmountToMinor(
  value: unknown,
  currency: string,
): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = /^([+-]?\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return undefined;

  const decimals = currencyDecimals(currency);
  const scale = 10 ** decimals;
  const sign = match[1].startsWith("-") ? -1 : 1;
  const whole = Number(match[1].replace(/^[+-]/, ""));
  if (!Number.isSafeInteger(whole) || whole > Number.MAX_SAFE_INTEGER / scale) {
    return undefined;
  }
  const fractionDigits = match[2] ?? "";
  const kept = Number(fractionDigits.slice(0, decimals).padEnd(decimals, "0"));
  const roundUp =
    decimals === 0
      ? Number(fractionDigits[0] ?? "0") >= 5
      : Number(fractionDigits[decimals] ?? "0") >= 5;
  const magnitude = whole * scale + kept + (roundUp ? 1 : 0);
  const minor = sign * magnitude;
  return Number.isSafeInteger(minor) ? minor : undefined;
}

/**
 * Render minor units as plain display digits for the currency — no symbol,
 * no thousands grouping, presentation logic stays in the caller
 * (src/lib/format.ts adds the currency symbol).
 *
 * "1050" USD → "10.50"; "1000" JPY → "1000"; "-1050" USD → "-10.50".
 * Throws on non-safe-integer input: callers must pass validated minor
 * units, and silently mangling an amount for display would hide bugs.
 */
export function minorToDisplayString(
  amountMinor: number,
  currency: string,
): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(
      `minorToDisplayString requires a safe integer minor amount, received ${String(amountMinor)}`,
    );
  }
  const decimals = currencyDecimals(currency);
  const scale = 10 ** decimals;
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  const fraction = abs % scale;
  const whole = (abs - fraction) / scale;
  if (decimals === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(fraction).padStart(decimals, "0")}`;
}
