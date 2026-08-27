import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount } from "@/lib/format";
import { getOverviewStats, getRecentOrders } from "@/modules/admin/queries";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [stats, recentOrders] = await Promise.all([
    getOverviewStats(),
    getRecentOrders(5),
  ]);

  const hasData = stats.applications > 0 || stats.products > 0;

  return (
    <PageContainer
      title="Overview"
      description="Monitor revenue, payments, subscriptions, and provider health at a glance."
    >
      {hasData ? (
        <div className="overview-grid">
          <div className="stat-cards">
            <div className="stat-card">
              <span className="stat-label">Applications</span>
              <span className="stat-value">{stats.applications}</span>
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
                          {order.customerEmail ??
                            order.externalCustomerId ??
                            "—"}
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
        <div className="empty-state">
          <h2 className="empty-state-title">Welcome to MonetPlane</h2>
          <p className="empty-state-desc">
            Set up your billing control plane to start accepting payments,
            managing credits, and tracking subscriptions.
          </p>
          <div className="onboarding-checklist">
            <div className="onboarding-item">
              <span className="onboarding-number">1</span>
              <span>Connect a payment provider</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">2</span>
              <span>Create your first product</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">3</span>
              <span>Add the SDK to your application</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">4</span>
              <span>Send your first event</span>
            </div>
            <div className="onboarding-item">
              <span className="onboarding-number">5</span>
              <span>Receive your first payment</span>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
