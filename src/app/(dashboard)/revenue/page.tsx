import { PageContainer } from "@/components/layout/PageContainer";
import { CurrencyBreakdown } from "@/components/ui/CurrencyBreakdown";
import { formatMessage, getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount } from "@/lib/format";
import {
  getRevenueAnalytics,
  getRevenueAnalyticsV1,
  getSubscriptionAnalytics,
} from "@/server/control-plane/analytics";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

function formatMonth(month: string, localeTag: string): string {
  const [year, monthNumber] = month.split("-");
  const date = new Date(
    Number(year),
    Number(monthNumber) - 1,
    1,
  ).toLocaleDateString(localeTag, { month: "short", year: "2-digit" });
  return date;
}

export default async function RevenuePage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const t = dictionary.revenue;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  if (!application) {
    return (
      <PageContainer title={t.title} description={t.noProjectDescription}>
        <p className="cell-muted">{t.noProjectBody}</p>
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
      title={t.title}
      description={formatMessage(t.description, {
        application: application.name,
        environment: environmentLabel,
      })}
    >
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">{t.kpiTotal}</span>
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
          <span className="stat-label">{t.kpiPayments}</span>
          <span className="stat-value">{analytics.totals.payments}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t.kpiAverage}</span>
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
          <span className="stat-label">{t.kpiSuccessRate}</span>
          <span className="stat-value">
            {operational.paymentOutcomes.successRate === null
              ? "—"
              : `${(operational.paymentOutcomes.successRate * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t.kpiActiveSubscriptions}</span>
          <span className="stat-value">{subscriptions.active}</span>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title">{t.volumeTitle}</h2>
        {operational.volumeByCurrency.length === 0 ? (
          <p className="cell-muted">{t.volumeEmpty}</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.thCurrency}</th>
                <th>{t.thVolume}</th>
                <th>{t.thPayments}</th>
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
              {t.mrrTitle}
            </h2>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thCurrency}</th>
                  <th>{t.thMrr}</th>
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
          {t.monthlyTitle}
          {dominantCurrency ? ` · ${dominantCurrency.currency}` : ""}
        </h2>
        {dominantCurrency ? (
          <>
            {otherCurrencies.length > 0 && (
              <p className="cell-muted">
                {formatMessage(t.alsoIn, {
                  currencies: otherCurrencies.join(", "),
                })}
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
                    {formatMonth(entry.month, localeTag)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="cell-muted">
            {formatMessage(t.monthlyEmpty, { environment: environmentLabel })}
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">{t.byProductTitle}</h2>
        {analytics.byProduct.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thProduct}</th>
                  <th>{t.thCurrency}</th>
                  <th>{t.thOrders}</th>
                  <th>{t.thUnits}</th>
                  <th>{t.thRevenue}</th>
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
          <p className="cell-muted">{t.noPaidOrders}</p>
        )}
      </div>
    </PageContainer>
  );
}
