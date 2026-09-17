import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatAmount } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import { getOverviewCommandCenter } from "@/server/control-plane/overview";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const context = await getConsoleContext();
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test" ? "Sandbox" : "Production";

  if (!application) {
    return (
      <PageContainer
        title="Overview"
        description="Create a project to start configuring your billing control plane."
      >
        <div className="empty-state empty-state-guided">
          <h2 className="empty-state-title">Create your first project</h2>
          <p className="empty-state-desc">
            A project represents one product or website using MonetPlane and
            keeps its billing data isolated.
          </p>
          <div className="onboarding-checklist">
            <a
              className="onboarding-item onboarding-item-link"
              href="/applications/new"
            >
              <span className="onboarding-number">1</span>
              <span>Create a project</span>
            </a>
          </div>
        </div>
      </PageContainer>
    );
  }

  const overview = await getOverviewCommandCenter(
    application.id,
    context.environment,
  );
  const { kpis, warnings, setupSteps } = overview;
  const pendingSteps = setupSteps.filter((step) => !step.done);
  const nextStep = pendingSteps[0];
  const setupComplete = pendingSteps.length === 0;
  const hasBillingData =
    kpis.payments > 0 ||
    kpis.activeSubscriptions > 0 ||
    kpis.creditsGranted > 0;

  return (
    <PageContainer
      title="Overview"
      description={`${application.name} · ${environmentLabel} billing health and activity.`}
      primaryAction={{ label: "Connect provider", href: "/providers" }}
    >
      {warnings.length > 0 && (
        <div className="overview-warnings">
          {warnings.map((warning) => (
            <a
              key={warning.message}
              className={`overview-warning overview-warning-${warning.level}`}
              href={warning.href}
            >
              {warning.message}
            </a>
          ))}
        </div>
      )}

      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-label">Revenue ({environmentLabel})</span>
          <span className="stat-value">
            {formatAmount(kpis.revenueMinor, "USD")}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Payments</span>
          <span className="stat-value">{kpis.payments}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Active subscriptions</span>
          <span className="stat-value">{kpis.activeSubscriptions}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Credits granted</span>
          <span className="stat-value">
            {kpis.creditsGranted.toLocaleString()}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Credits used</span>
          <span className="stat-value">
            {kpis.creditsDebited.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="overview-grid">
        <div className="overview-checklist card">
          <h2 className="card-title">
            {setupComplete
              ? "Billing is fully connected"
              : "Finish setting up billing"}
          </h2>
          {nextStep && (
            <p className="overview-checklist-next">
              Next: <a href={nextStep.href}>{nextStep.label}</a>
            </p>
          )}
          <div className="overview-checklist-steps">
            {setupSteps.map((step, index) => (
              <a
                key={step.key}
                className={`overview-checklist-item ${step.done ? "overview-checklist-item-done" : ""}`}
                href={step.href}
              >
                <span className="overview-checklist-mark">
                  {step.done ? "✓" : index + 1}
                </span>
                <span>{step.label}</span>
              </a>
            ))}
          </div>
        </div>

        <div className="card">
          <h2 className="card-title">Provider health · {environmentLabel}</h2>
          {overview.providerHealth.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Connection</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.providerHealth.map((provider) => (
                  <tr key={provider.id}>
                    <td>{provider.provider}</td>
                    <td>{provider.name}</td>
                    <td>
                      <StatusBadge status={provider.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="cell-muted">
              No providers connected in {environmentLabel}.{" "}
              <a href="/providers">Connect one</a> to enable checkout.
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Top products</h2>
          {overview.topProducts.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Units</th>
                  <th>Revenue</th>
                </tr>
              </thead>
              <tbody>
                {overview.topProducts.map((product) => (
                  <tr key={product.productId}>
                    <td>{product.productName}</td>
                    <td>{product.units}</td>
                    <td>{formatAmount(product.revenueMinor, "USD")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="cell-muted">
              No paid orders yet. <a href="/products">Create a product</a> to
              get started.
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">Recent payments</h2>
          {overview.recentPayments.length > 0 ? (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Payment</th>
                    <th>Customer</th>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Amount</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recentPayments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="cell-mono">{payment.id.slice(0, 8)}</td>
                      <td>
                        {payment.customerEmail ??
                          payment.externalCustomerId ??
                          "—"}
                      </td>
                      <td>{payment.provider}</td>
                      <td>
                        <StatusBadge status={payment.status} />
                      </td>
                      <td>
                        {formatAmount(payment.amountMinor, payment.currency)}
                      </td>
                      <td className="cell-muted">
                        {new Date(payment.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="cell-muted">
              {hasBillingData
                ? "No payments recorded in this environment yet."
                : "Run a Sandbox checkout to see your first payment here."}
            </p>
          )}
        </div>
      </div>

      <div className="overview-links">
        <a className="overview-link-card" href="/revenue">
          <span className="overview-link-title">Revenue →</span>
          <span className="cell-muted">
            Monthly revenue and product breakdown
          </span>
        </a>
        <a className="overview-link-card" href="/usage">
          <span className="overview-link-title">Usage →</span>
          <span className="cell-muted">
            Credit consumption by type and customer
          </span>
        </a>
        <a className="overview-link-card" href="/developer">
          <span className="overview-link-title">Developer →</span>
          <span className="cell-muted">
            Quickstart, API keys, integration health
          </span>
        </a>
      </div>
    </PageContainer>
  );
}
