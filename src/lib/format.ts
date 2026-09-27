/**
 * Formatting helpers for dashboard display.
 */

import { minorToDisplayString } from "./money";

/**
 * Render a minor-unit amount with its currency symbol, decimal-aware via
 * the money registry (audit A1): zero-decimal currencies (JPY, ISK, …)
 * render as whole units — e.g. JPY 1000 → "¥1000", not "¥10.00".
 */
export function formatAmount(amountMinor: number, currency: string): string {
  const symbol = currencySymbols[currency.toUpperCase()] ?? currency;
  return `${symbol}${minorToDisplayString(amountMinor, currency)}`;
}

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const currencySymbols: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  CNY: "¥",
  JPY: "¥",
};
