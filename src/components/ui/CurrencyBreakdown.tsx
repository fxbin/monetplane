import { formatAmount } from "@/lib/format";

/**
 * Per-currency amount list for KPI cards (audit A3).
 *
 * Amounts are never summed across currencies (docs/analytics-definitions.md):
 * a multi-currency card renders one labeled entry per currency instead of a
 * single mislabeled sum. An empty list renders a neutral placeholder.
 */
export function CurrencyBreakdown({
  amounts,
  emptyLabel = "—",
}: {
  amounts: ReadonlyArray<{ currency: string; amountMinor: number }>;
  emptyLabel?: string;
}) {
  if (amounts.length === 0) {
    return <>{emptyLabel}</>;
  }
  return (
    <>
      {amounts.map((entry, index) => (
        <span key={entry.currency}>
          {index > 0 ? " · " : ""}
          {formatAmount(entry.amountMinor, entry.currency)}
        </span>
      ))}
    </>
  );
}
