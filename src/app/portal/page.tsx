import { CancelSubscriptionButton } from "@/components/portal/PortalActions";
import { formatAmount, formatDate, formatDateTime } from "@/lib/format";
import { PortalServiceError } from "@/modules/portal/service";
import { getPortalBillingState } from "@/server/control-plane/portal";
import "../portal.css";

export const dynamic = "force-dynamic";

function PortalMessage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="portal-shell">
      <div className="portal-card portal-message-card">
        <h1 className="portal-title">{title}</h1>
        <p className="portal-message">{description}</p>
      </div>
    </div>
  );
}

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";

  if (!token) {
    return (
      <PortalMessage
        title="Billing portal"
        description="This page needs a portal session token. Start the billing portal from inside the application."
      />
    );
  }

  let state: Awaited<ReturnType<typeof getPortalBillingState>>;
  try {
    state = await getPortalBillingState(token);
  } catch (error) {
    if (error instanceof PortalServiceError) {
      return (
        <PortalMessage title="Session ended" description={error.message} />
      );
    }
    console.error("[portal] Error:", error);
    return (
      <PortalMessage
        title="Something went wrong"
        description="The billing portal could not be loaded. Try starting a new session from the application."
      />
    );
  }

  const activeSubscriptions = state.subscriptions.filter(
    (subscription) =>
      subscription.status === "active" ||
      subscription.status === "past_due" ||
      subscription.status === "pending",
  );
  const historySubscriptions = state.subscriptions.filter(
    (subscription) => !activeSubscriptions.includes(subscription),
  );

  return (
    <div className="portal-shell" data-environment={state.session.environment}>
      <div className="portal-card">
        <header className="portal-header">
          <div className="portal-brand">
            {state.branding.logoUrl && (
              /* Branding is application-controlled content; referrerpolicy
                 keeps MonetPlane URLs out of the third-party request. */
              <img
                src={state.branding.logoUrl}
                alt=""
                className="portal-logo"
                referrerPolicy="no-referrer"
              />
            )}
            <div>
              <h1 className="portal-title">{state.branding.displayName}</h1>
              <p className="portal-subtitle">Billing &amp; subscriptions</p>
            </div>
          </div>
          {state.session.returnUrl && (
            <a
              className="portal-back-link"
              href={state.session.returnUrl}
              rel="noreferrer"
            >
              ← Back to application
            </a>
          )}
        </header>

        {state.session.environment === "test" && (
          <p className="portal-test-banner">
            Sandbox environment — billing data shown is test data.
          </p>
        )}

        <section className="portal-section">
          <h2 className="portal-section-title">Current subscriptions</h2>
          {activeSubscriptions.length === 0 ? (
            <p className="portal-empty">
              You don&apos;t have an active subscription.
            </p>
          ) : (
            <div className="portal-subscription-list">
              {activeSubscriptions.map((subscription) => (
                <div key={subscription.id} className="portal-subscription">
                  <div className="portal-subscription-main">
                    <div className="portal-plan-line">
                      {subscription.items.map((item) => (
                        <span key={item.productName} className="portal-plan">
                          {item.productName}
                          {item.quantity > 1 && ` ×${item.quantity}`}
                        </span>
                      ))}
                    </div>
                    <div className="portal-plan-meta">
                      {subscription.status === "past_due" && (
                        <span className="portal-badge portal-badge-warning">
                          Payment issue
                        </span>
                      )}
                      {subscription.cancelAtPeriodEnd ? (
                        <span className="portal-badge">
                          Ends {formatDate(subscription.currentPeriodEnd ?? "")}
                        </span>
                      ) : (
                        subscription.currentPeriodEnd && (
                          <span className="portal-badge">
                            Renews {formatDate(subscription.currentPeriodEnd)}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                  <div className="portal-subscription-side">
                    {subscription.items.length > 0 && (
                      <div className="portal-price">
                        {formatAmount(
                          subscription.items[0].unitAmountMinor *
                            subscription.items[0].quantity,
                          subscription.items[0].currency,
                        )}
                        {subscription.items[0].recurringInterval &&
                          ` / ${subscription.items[0].recurringInterval}`}
                      </div>
                    )}
                    {subscription.canCancel &&
                      !subscription.cancelAtPeriodEnd && (
                        <CancelSubscriptionButton
                          token={token}
                          subscriptionId={subscription.id}
                        />
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {historySubscriptions.length > 0 && (
            <details className="portal-details">
              <summary>
                Past subscriptions ({historySubscriptions.length})
              </summary>
              <ul className="portal-history-list">
                {historySubscriptions.map((subscription) => (
                  <li key={subscription.id}>
                    {subscription.items[0]?.productName ?? "Subscription"} ·{" "}
                    {subscription.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {state.capabilities.paymentManagement && (
          <section className="portal-section">
            <h2 className="portal-section-title">Payment method</h2>
            <p className="portal-empty">
              Manage your payment method with our secure payment provider.
            </p>
            <a
              className="portal-button"
              href={`/api/portal/payment-management?token=${token}`}
            >
              Manage payment method
            </a>
          </section>
        )}

        {state.entitlements.length > 0 && (
          <section className="portal-section">
            <h2 className="portal-section-title">Your plan features</h2>
            <ul className="portal-feature-list">
              {state.entitlements.map((entitlement) => (
                <li key={entitlement.featureKey}>{entitlement.featureKey}</li>
              ))}
            </ul>
          </section>
        )}

        {state.credits.length > 0 && (
          <section className="portal-section">
            <h2 className="portal-section-title">Credits</h2>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Credit type</th>
                    <th>Available</th>
                    <th>Reserved</th>
                  </tr>
                </thead>
                <tbody>
                  {state.credits.map((credit) => (
                    <tr key={credit.creditType}>
                      <td className="cell-mono">{credit.creditType}</td>
                      <td>{credit.availableBalance}</td>
                      <td>{credit.reservedBalance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="portal-section">
          <h2 className="portal-section-title">Billing history</h2>
          {state.payments.length === 0 ? (
            <p className="portal-empty">No payments yet.</p>
          ) : (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {state.payments.map((payment) => (
                    <tr key={payment.id}>
                      <td>{formatDateTime(payment.createdAt)}</td>
                      <td>
                        {formatAmount(payment.amountMinor, payment.currency)}
                      </td>
                      <td>
                        <span
                          className={`portal-badge ${
                            payment.status === "succeeded"
                              ? "portal-badge-success"
                              : payment.status === "failed"
                                ? "portal-badge-danger"
                                : ""
                          }`}
                        >
                          {payment.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {state.refunds.length > 0 && (
            <ul className="portal-history-list">
              {state.refunds.map((refund) => (
                <li key={refund.id}>
                  Refund {refund.status}
                  {refund.amountMinor !== null &&
                    ` · ${formatAmount(refund.amountMinor, state.payments[0]?.currency ?? "USD")}`}
                  · {formatDate(refund.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </section>

        {state.branding.supportEmail && (
          <footer className="portal-footer">
            Questions?{" "}
            <a href={`mailto:${state.branding.supportEmail}`}>
              {state.branding.supportEmail}
            </a>
          </footer>
        )}
      </div>
    </div>
  );
}
