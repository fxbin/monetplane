import { PageContainer } from "@/components/layout/PageContainer";
import { formatMessage, getDictionary } from "@/i18n/server";
import { getUsageAnalytics } from "@/server/control-plane/analytics";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-");
  return new Date(Number(year), Number(monthNumber) - 1, 1).toLocaleDateString(
    "en-US",
    { month: "short", year: "2-digit" },
  );
}

export default async function UsagePage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.usage;
  const application = context.selectedApplication;

  if (!application) {
    return (
      <PageContainer title={t.title} description={t.noProjectDescription}>
        <p className="cell-muted">{t.noProjectBody}</p>
      </PageContainer>
    );
  }

  const analytics = await getUsageAnalytics(
    application.id,
    context.environment,
  );
  const hasUsage =
    analytics.byCreditType.length > 0 || analytics.topCustomers.length > 0;
  const maxDebited = Math.max(
    ...analytics.monthly.map((entry) => entry.debited),
    1,
  );

  return (
    <PageContainer
      title={t.title}
      description={formatMessage(t.description, {
        application: application.name,
        environment:
          context.environment === "test"
            ? dictionary.common.sandbox
            : dictionary.common.production,
      })}
    >
      <div className="card">
        <h2 className="card-title">{t.monthlyTitle}</h2>
        {hasUsage ? (
          <div className="chart-bars">
            {analytics.monthly.map((entry) => (
              <div key={entry.month} className="chart-bar-col">
                <div
                  className="chart-bar chart-bar-credits"
                  style={{
                    height: `${Math.max((entry.debited / maxDebited) * 100, entry.debited > 0 ? 3 : 0)}%`,
                  }}
                  title={`${entry.month}: ${entry.debited} credits`}
                />
                <span className="chart-bar-label">
                  {formatMonth(entry.month)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="cell-muted">{t.monthlyEmpty}</p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">{t.byTypeTitle}</h2>
        {analytics.byCreditType.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thCreditType}</th>
                  <th>{t.thGranted}</th>
                  <th>{t.thUsed}</th>
                  <th>{t.thTransactions}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.byCreditType.map((row) => (
                  <tr key={row.creditType}>
                    <td className="cell-mono">{row.creditType}</td>
                    <td>{row.granted.toLocaleString()}</td>
                    <td>{row.debited.toLocaleString()}</td>
                    <td>{row.transactions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cell-muted">{t.byTypeEmpty}</p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">{t.topCustomersTitle}</h2>
        {analytics.topCustomers.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thCustomer}</th>
                  <th>{t.thExternalId}</th>
                  <th>{t.thCreditsUsed}</th>
                  <th>{t.thTransactions}</th>
                </tr>
              </thead>
              <tbody>
                {analytics.topCustomers.map((customer) => (
                  <tr key={customer.applicationCustomerId}>
                    <td>{customer.email ?? customer.externalCustomerId}</td>
                    <td className="cell-mono">{customer.externalCustomerId}</td>
                    <td>{customer.debited.toLocaleString()}</td>
                    <td>{customer.transactions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cell-muted">{t.topCustomersEmpty}</p>
        )}
      </div>
    </PageContainer>
  );
}
