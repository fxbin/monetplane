/**
 * Formatting helpers for dashboard display.
 */

export function formatAmount(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  const symbol = currencySymbols[currency.toUpperCase()] ?? currency;
  return `${symbol}${major.toFixed(2)}`;
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
