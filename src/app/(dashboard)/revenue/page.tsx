import { PageContainer } from "@/components/layout/PageContainer";
import { CurrencyBreakdown } from "@/components/ui/CurrencyBreakdown";
import { formatAmount } from "@/lib/format";
import {
  getRevenueAnalytics,
  getRevenueAnalyticsV1,
  getSubscriptionAnalytics,
} from "@/server/control-plane/analytics";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-");
  const date = new Date(
    Number(year),
    Number(monthNumber) - 1,
    1,
  ).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return date;
}

export default async function RevenuePage() {
  const context = await getConsoleContext();
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

  if (!application) {
    return (
      <PageContainer
        title="Revenue"
        description="Create a project to see revenue analytics."
      >
        <p className="cell-muted">
          Revenue analytics appear after you create a project.
        </p>
      </PageContainer>
    );
  }

  const now = new Date();
  const [analytics, operational, subscriptions] = await Promise.all([
    getRevenueAnalytics(application.id, context.environment),
    getRevenueAnalyticsV1(application.id, context.environment, {
      from: new Date(now.getTime() - 30 * 24 * 3600 * 1000),
      to: new Date(now.getTime() + 60_000),
    }),
    getSubscriptionAnalytics(application.id, context.environment),
  ]);
  // The chart renders the dominant currency's series; other currencies are
  // listed so the view is honest about the mix (amounts are never summed
  // across currencies).
  const dominantCurrency = analytics.totals.byCurrency[0];
  const monthly = dominantCurrency
    ? analytics.monthly.filter(
        (entry) => entry.currency === dominantCurrency.currency,
      )
    : [];
  const otherCurrencies = analytics.totals.byCurrency
    .slice(1)
    .map((entry) => entry.currency);
  const maxRevenue = Math.max(...monthly.map((entry) => entry.revenueMinor), 1);

  return (
    <PageContainer
      title="Revenue"
      description={`${application.name} · ${environmentLabel} succeeded payments by month.`}
    >
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">Total revenue (12 months)</span>
          <span className="stat-value">
            <CurrencyBreakdown
              amounts={analytics.totals.byCurrency.map((entry) => ({
                currency: entry.currency,
                amountMinor: entry.revenueMinor,
              }))}
            />
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Payments</span>
          <span className="stat-value">{analytics.totals.payments}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Average payment</span>
          <span className="stat-value">
            <CurrencyBreakdown
              amounts={analytics.totals.byCurrency.map((entry) => ({
                currency: entry.currency,
                amountMinor: entry.averagePaymentMinor,
              }))}
            />
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Success rate (30d)</span>
          <span className="stat-value">
            {operational.paymentOutcomes.successRate === null
              ? "—"
              : `${(operational.paymentOutcomes.successRate * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Active subscriptions</span>
          <span className="stat-value">{subscriptions.active}</span>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">Volume by currency (30 days)</h2>
        {operational.volumeByCurrency.length === 0 ? (
          <p className="cell-muted">
            No succeeded payments in this environment yet.
          </p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Currency</th>
                <th>Volume</th>
                <th>Payments</th>
              </tr>
            </thead>
            <tbody>
              {operational.volumeByCurrency.map((row) => (
                <tr key={row.currency}>
                  <td className="cell-mono">{row.currency}</td>
                  <td>{formatAmount(row.amountMinor, row.currency)}</td>
                  <td>{row.payments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {subscriptions.mrrByCurrency.length > 0 && (
          <>
            <h2 className="card-title" style={{ marginTop: 16 }}>
              MRR by currency (monthly-normalized)
            </h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th>MRR</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.mrrByCurrency.map((row) => (
                  <tr key={row.currency}>
                    <td className="cell-mono">{row.currency}</td>
                    <td>{formatAmount(row.amountMinor, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">
          Monthly revenue
          {dominantCurrency ? ` · ${dominantCurrency.currency}` : ""}
        </h2>
        {dominantCurrency ? (
          <>
            {otherCurrencies.length > 0 && (
              <p className="cell-muted">
                Also in {otherCurrencies.join(", ")} — see the per-currency
                totals above.
              </p>
            )}
            <div className="chart-bars">
              {monthly.map((entry) => (
                <div
                  key={`${entry.currency}:${entry.month}`}
                  className="chart-bar-col"
                >
                  <div
                    className="chart-bar chart-bar-revenue"
                    style={{
                      height: `${Math.max((entry.revenueMinor / maxRevenue) * 100, entry.revenueMinor > 0 ? 3 : 0)}%`,
                    }}
                    title={`${entry.month}: ${formatAmount(entry.revenueMinor, entry.currency)}`}
                  />
                  <span className="chart-bar-label">
                    {formatMonth(entry.month)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="cell-muted">
            No succeeded payments in {environmentLabel} yet.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Revenue by product</h2>
        {analytics.byProduct.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Currency</th>
                  <th>Orders</th>
                  <th>Units</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byProduct.map((product) => (
                  <tr key={`${product.productId}:${product.currency}`}>
                    <td>{product.productName}</td>
                    <td className="cell-mono">{product.currency}</td>
                    <td>{product.orders}</td>
                    <td>{product.units}</td>
                    <td>
                      {formatAmount(product.revenueMinor, product.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cell-muted">No paid orders yet.</p>
        )}
      </div>
    </PageContainer>
  );
}
