import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount } from "@/lib/format";
import {
  getRevenueAnalyticsV1,
  getSubscriptionAnalytics,
} from "@/server/control-plane/analytics";
import { getConsoleContext } from "@/server/control-plane/context";
import { getRevenueAnalytics } from "@/server/control-plane/overview";

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

  const analytics = await getRevenueAnalytics(
    application.id,
    context.environment,
  );
  const now = new Date();
  const [operational, subscriptions] = await Promise.all([
    getRevenueAnalyticsV1(application.id, context.environment, {
      from: new Date(now.getTime() - 30 * 24 * 3600 * 1000),
      to: new Date(now.getTime() + 60_000),
    }),
    getSubscriptionAnalytics(application.id, context.environment),
  ]);
  const maxRevenue = Math.max(
    ...analytics.monthly.map((entry) => entry.revenueMinor),
    1,
  );

  return (
    <PageContainer
      title="Revenue"
      description={`${application.name} · ${environmentLabel} succeeded payments by month.`}
    >
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">Total revenue (12 months)</span>
          <span className="stat-value">
            {formatAmount(analytics.totals.revenueMinor, "USD")}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Payments</span>
          <span className="stat-value">{analytics.totals.payments}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Average payment</span>
          <span className="stat-value">
            {formatAmount(analytics.totals.averagePaymentMinor, "USD")}
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
        <h2 className="card-title">Monthly revenue</h2>
        {analytics.totals.payments > 0 ? (
          <div className="chart-bars">
            {analytics.monthly.map((entry) => (
              <div key={entry.month} className="chart-bar-col">
                <div
                  className="chart-bar chart-bar-revenue"
                  style={{
                    height: `${Math.max((entry.revenueMinor / maxRevenue) * 100, entry.revenueMinor > 0 ? 3 : 0)}%`,
                  }}
                  title={`${entry.month}: ${formatAmount(entry.revenueMinor, "USD")}`}
                />
                <span className="chart-bar-label">
                  {formatMonth(entry.month)}
                </span>
              </div>
            ))}
          </div>
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
                  <th>Orders</th>
                  <th>Units</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byProduct.map((product) => (
                  <tr key={product.productId}>
                    <td>{product.productName}</td>
                    <td>{product.orders}</td>
                    <td>{product.units}</td>
                    <td>{formatAmount(product.revenueMinor, "USD")}</td>
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
