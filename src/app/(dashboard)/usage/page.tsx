import { PageContainer } from "@/components/layout/PageContainer";
import { getConsoleContext } from "@/server/control-plane/context";
import { getUsageAnalytics } from "@/server/control-plane/overview";

export const dynamic = "force-dynamic";

function formatMonth(month: string): string {
  const [year, monthNumber] = month.split("-");
  return new Date(Number(year), Number(monthNumber) - 1, 1).toLocaleDateString(
    "en-US",
    { month: "short", year: "2-digit" },
  );
}

export default async function UsagePage() {
  const context = await getConsoleContext();
  const application = context.selectedApplication;

  if (!application) {
    return (
      <PageContainer
        title="Usage"
        description="Create a project to see credit usage analytics."
      >
        <p className="cell-muted">
          Usage analytics appear after you create a project.
        </p>
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
      title="Usage"
      description={`${application.name} · credit consumption in ${context.environment === "test" ? "Sandbox" : "Production"}.`}
    >
      <div className="card">
        <h2 className="card-title">Credits used by month</h2>
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
          <p className="cell-muted">
            No credit transactions yet. Grant or debit credits to see usage.
          </p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">By credit type</h2>
        {analytics.byCreditType.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Credit type</th>
                  <th>Granted</th>
                  <th>Used</th>
                  <th>Transactions</th>
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
          <p className="cell-muted">No credit activity.</p>
        )}
      </div>

      <div className="card">
        <h2 className="card-title">Top customers by usage</h2>
        {analytics.topCustomers.length > 0 ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>External ID</th>
                  <th>Credits used</th>
                  <th>Transactions</th>
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
          <p className="cell-muted">No customers with credit activity yet.</p>
        )}
      </div>
    </PageContainer>
  );
}
