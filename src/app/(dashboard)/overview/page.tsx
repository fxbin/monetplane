import { PageContainer } from "@/components/layout/PageContainer";
import { CurrencyBreakdown } from "@/components/ui/CurrencyBreakdown";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
import { formatAmount } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import { getOverviewCommandCenter } from "@/server/control-plane/overview";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [context, dictionary] = await Promise.all([
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.overview;
  const application = context.selectedApplication;
  const environmentLabel =
    context.environment === "test"
      ? dictionary.common.sandbox
      : dictionary.common.production;

  if (!application) {
    return (
      <PageContainer title={t.title} description={t.emptyDescription}>
        <div className="empty-state empty-state-guided">
          <h2 className="empty-state-title">{t.emptyTitle}</h2>
          <p className="empty-state-desc">{t.emptyDesc}</p>
          <div className="onboarding-checklist">
            <a
              className="onboarding-item onboarding-item-link"
              href="/applications/new"
            >
              <span className="onboarding-number">1</span>
              <span>{t.createProjectStep}</span>
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
      title={t.title}
      description={formatMessage(t.description, {
        application: application.name,
        environment: environmentLabel,
      })}
      primaryAction={{ label: t.connectProvider, href: "/providers" }}
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
          <span className="stat-label">
            {formatMessage(t.kpiRevenue, { environment: environmentLabel })}
          </span>
          <span className="stat-value">
            <CurrencyBreakdown amounts={kpis.revenueByCurrency} />
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t.kpiPayments}</span>
          <span className="stat-value">{kpis.payments}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t.kpiActiveSubscriptions}</span>
          <span className="stat-value">{kpis.activeSubscriptions}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t.kpiCreditsGranted}</span>
          <span className="stat-value">
            {kpis.creditsGranted.toLocaleString()}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">{t.kpiCreditsUsed}</span>
          <span className="stat-value">
            {kpis.creditsDebited.toLocaleString()}
          </span>
        </div>
      </div>

      <div className="overview-grid">
        <div className="overview-checklist card">
          <h2 className="card-title">
            {setupComplete ? t.checklistDone : t.checklistPending}
          </h2>
          {nextStep && (
            <p className="overview-checklist-next">
              {t.next} <a href={nextStep.href}>{nextStep.label}</a>
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
          <h2 className="card-title">
            {formatMessage(t.providerHealthTitle, {
              environment: environmentLabel,
            })}
          </h2>
          {overview.providerHealth.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thProvider}</th>
                  <th>{t.thConnection}</th>
                  <th>{t.thStatus}</th>
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
              {formatMessage(t.noProvidersBefore, {
                environment: environmentLabel,
              })}
              <a href="/providers">{t.noProvidersLink}</a>
              {t.noProvidersAfter}
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">{t.topProducts}</h2>
          {overview.topProducts.length > 0 ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.thProduct}</th>
                  <th>{t.thUnits}</th>
                  <th>{t.thRevenue}</th>
                </tr>
              </thead>
              <tbody>
                {overview.topProducts.map((product) => (
                  <tr key={`${product.productId}:${product.currency}`}>
                    <td>{product.productName}</td>
                    <td>{product.units}</td>
                    <td>
                      {formatAmount(product.revenueMinor, product.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="cell-muted">
              {t.noProductsBefore}
              <a href="/products">{t.noProductsLink}</a>
              {t.noProductsAfter}
            </p>
          )}
        </div>

        <div className="card">
          <h2 className="card-title">{t.recentPayments}</h2>
          {overview.recentPayments.length > 0 ? (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t.thPayment}</th>
                    <th>{t.thCustomer}</th>
                    <th>{t.thProvider}</th>
                    <th>{t.thStatus}</th>
                    <th>{t.thAmount}</th>
                    <th>{t.thDate}</th>
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
              {hasBillingData ? t.noPaymentsYet : t.firstPayment}
            </p>
          )}
        </div>
      </div>

      <div className="overview-links">
        <a className="overview-link-card" href="/revenue">
          <span className="overview-link-title">{t.linkRevenue} →</span>
          <span className="cell-muted">{t.linkRevenueDesc}</span>
        </a>
        <a className="overview-link-card" href="/usage">
          <span className="overview-link-title">{t.linkUsage} →</span>
          <span className="cell-muted">{t.linkUsageDesc}</span>
        </a>
        <a className="overview-link-card" href="/developer">
          <span className="overview-link-title">{t.linkDeveloper} →</span>
          <span className="cell-muted">{t.linkDeveloperDesc}</span>
        </a>
      </div>
    </PageContainer>
  );
}
