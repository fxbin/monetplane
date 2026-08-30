import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount } from "@/lib/format";
import { getOverviewStats, getRecentOrders } from "@/modules/admin/queries";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const context = await getConsoleContext();
  const applicationId = context.selectedApplication?.id;
  const [stats, recentOrders] = await Promise.all([
    getOverviewStats(applicationId, context.environment),
    getRecentOrders(5, applicationId),
  ]);

  const hasApplication = Boolean(context.selectedApplication);
  const hasBillingData = stats.products > 0 || stats.orders > 0 || stats.customers > 0;
  const environmentLabel = context.environment === "test" ? "Sandbox" : "Production";

  return (
    <PageContainer
      title="Overview"
      description={
        context.selectedApplication
          ? `Monitor ${context.selectedApplication.name} billing health and activity.`
          : "Create a project to start configuring your billing control plane."
      }
    >
      {hasApplication && hasBillingData ? (
        <div className="overview-grid">
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-label">Environment</span>
              <span className="stat-value stat-value-text">{environmentLabel}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Products</span>
              <span className="stat-value">{stats.products}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Customers</span>
              <span className="stat-value">{stats.customers}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Active Providers</span>
              <span className="stat-value">{stats.activeProviders}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Orders</span>
              <span className="stat-value">{stats.orders}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Revenue (paid)</span>
              <span className="stat-value">
                {formatAmount(stats.totalRevenueMinor, "USD")}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Credit Transactions</span>
              <span className="stat-value">{stats.creditTransactions}</span>
            </div>
          </div>

          {recentOrders.length > 0 && (
            <div className="card">
              <h2 className="card-title">Recent Orders</h2>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Order ID</th>
                      <th>Customer</th>
                      <th>Mode</th>
                      <th>Status</th>
                      <th>Amount</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentOrders.map((order) => (
                      <tr key={order.id}>
                        <td className="cell-mono">{order.id.slice(0, 8)}</td>
                        <td>
                          {order.customerEmail ?? order.externalCustomerId ?? "—"}
                        </td>
                        <td>{order.billingMode}</td>
                        <td>
                          <span className={`badge badge-${order.status}`}>
                            {order.status}
                          </span>
                        </td>
                        <td>
                          {formatAmount(order.totalAmountMinor, order.currency)}
                        </td>
                        <td className="cell-muted">
                          {new Date(order.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="empty-state empty-state-guided">
          <h2 className="empty-state-title">
            {hasApplication ? "Finish setting up this project" : "Create your first project"}
          </h2>
          <p className="empty-state-desc">
            {hasApplication
              ? "Complete the billing setup path below. Sandbox is the safest place to run your first checkout."
              : "A project represents one product or website using MonetPlane and keeps its billing data isolated."}
          </p>
          <div className="onboarding-checklist">
            {!hasApplication && (
              <a className="onboarding-item onboarding-item-link" href="/applications/new">
                <span className="onboarding-number">1</span>
                <span>Create a project</span>
              </a>
            )}
            <div className="onboarding-item">
              <span className="onboarding-number">{hasApplication ? "1" : "2"}</span>
              <span>Connect a payment provider</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">{hasApplication ? "2" : "3"}</span>
              <span>Create your first product</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">{hasApplication ? "3" : "4"}</span>
              <span>Add the SDK to your application</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">{hasApplication ? "4" : "5"}</span>
              <span>Run a Sandbox checkout</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">{hasApplication ? "5" : "6"}</span>
              <span>Receive your first payment event</span>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
