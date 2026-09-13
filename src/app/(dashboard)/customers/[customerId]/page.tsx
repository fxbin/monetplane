import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CancelSubscriptionAction,
  GrantCreditsAction,
  RefundPaymentAction,
} from "@/components/customers/CustomerActions";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getConsoleContext } from "@/server/control-plane/context";
import { getCustomerWorkspace } from "@/server/control-plane/customer-workspace";

export const dynamic = "force-dynamic";

type CustomerPageProps = {
  params: Promise<{ customerId: string }>;
};

function subscriptionLabel(
  subscription: Awaited<
    ReturnType<typeof getCustomerWorkspace>
  >["subscriptions"][number],
) {
  const product = subscription.items[0]?.productName;
  return product || `Subscription ${subscription.id}`;
}

export default async function CustomerPage({ params }: CustomerPageProps) {
  const [{ customerId }, context] = await Promise.all([
    params,
    getConsoleContext(),
  ]);
  if (!context.selectedApplication) notFound();

  let workspace: Awaited<ReturnType<typeof getCustomerWorkspace>>;
  try {
    workspace = await getCustomerWorkspace(
      context.selectedApplication.id,
      customerId,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Customer not found")
    ) {
      notFound();
    }
    throw error;
  }

  const currentSubscription = workspace.currentSubscription;
  const totalAvailableCredits = workspace.creditAccounts.reduce(
    (sum, account) => sum + account.availableBalance,
    0,
  );
  const totalReservedCredits = workspace.creditAccounts.reduce(
    (sum, account) => sum + account.reservedBalance,
    0,
  );
  const activeEntitlements = workspace.entitlements.filter(
    (entitlement) => entitlement.status === "active",
  );

  return (
    <PageContainer
      title={workspace.customer.externalCustomerId}
      description={
        workspace.customer.email ??
        `Billing workspace for ${context.selectedApplication.name}`
      }
      primaryAction={{ label: "Back to customers", href: "/customers" }}
    >
      <section className="customer-workspace-hero card">
        <div className="customer-workspace-identity">
          <span className="builder-kicker">Customer billing workspace</span>
          <h2>{workspace.customer.externalCustomerId}</h2>
          <div className="customer-identity-meta">
            <span>{workspace.customer.email ?? "No email recorded"}</span>
            <code>{workspace.customer.id}</code>
            <span>Created {formatDateTime(workspace.customer.createdAt)}</span>
          </div>
        </div>
        <div className="customer-hero-actions">
          <GrantCreditsAction customerId={workspace.customer.id} />
        </div>
      </section>

      <div className="customer-summary-grid">
        <section className="card customer-summary-card">
          <span>Current plan</span>
          {currentSubscription ? (
            <>
              <strong>{subscriptionLabel(currentSubscription)}</strong>
              <div>
                <span className={`badge badge-${currentSubscription.status}`}>
                  {currentSubscription.status.replace("_", " ")}
                </span>
                {currentSubscription.cancelAtPeriodEnd && (
                  <span className="customer-inline-note">
                    Cancels at period end
                  </span>
                )}
              </div>
            </>
          ) : (
            <strong>No subscription</strong>
          )}
        </section>
        <section className="card customer-summary-card">
          <span>Available credits</span>
          <strong>{totalAvailableCredits.toLocaleString()}</strong>
          <small>{totalReservedCredits.toLocaleString()} reserved</small>
        </section>
        <section className="card customer-summary-card">
          <span>Active features</span>
          <strong>{activeEntitlements.length}</strong>
          <small>{workspace.entitlements.length} total grants</small>
        </section>
        <section className="card customer-summary-card">
          <span>Payments</span>
          <strong>{workspace.payments.length}</strong>
          <small>
            {
              workspace.payments.filter(
                (payment) => payment.status === "succeeded",
              ).length
            }{" "}
            successful
          </small>
        </section>
      </div>

      <section className="card customer-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Subscription</span>
            <h2 className="card-title">Current plan & history</h2>
          </div>
        </div>
        {workspace.subscriptions.length === 0 ? (
          <p className="card-empty-copy">
            This customer has no subscription history.
          </p>
        ) : (
          <div className="customer-subscription-list">
            {workspace.subscriptions.map((subscription) => (
              <article
                className="customer-subscription-row"
                key={subscription.id}
              >
                <div className="customer-subscription-main">
                  <div>
                    <strong>{subscriptionLabel(subscription)}</strong>
                    <code>{subscription.id}</code>
                  </div>
                  <span className={`badge badge-${subscription.status}`}>
                    {subscription.status.replace("_", " ")}
                  </span>
                </div>
                <div className="customer-subscription-meta">
                  <span>
                    {subscription.providerName ??
                      subscription.provider ??
                      "Provider"}
                  </span>
                  <span>
                    {subscription.currentPeriodEnd
                      ? `Period ends ${formatDateTime(subscription.currentPeriodEnd)}`
                      : "No period end recorded"}
                  </span>
                  {subscription.cancelAtPeriodEnd && (
                    <span>Cancellation scheduled</span>
                  )}
                </div>
                <div className="customer-subscription-products">
                  {subscription.items.map((item) => (
                    <span key={`${subscription.id}:${item.priceId}`}>
                      {item.productName ?? item.productId}
                      {item.amountMinor !== null &&
                      item.amountMinor !== undefined &&
                      item.currency
                        ? ` · ${formatAmount(item.amountMinor, item.currency)}/${item.recurringInterval ?? "period"}`
                        : ""}
                    </span>
                  ))}
                </div>
                {subscription.canCancel && (
                  <div className="customer-row-actions">
                    <CancelSubscriptionAction
                      customerId={workspace.customer.id}
                      subscriptionId={subscription.id}
                      label={subscriptionLabel(subscription)}
                    />
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="customer-two-column-grid">
        <section className="card customer-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Credits</span>
              <h2 className="card-title">Balances</h2>
            </div>
          </div>
          {workspace.creditAccounts.length === 0 ? (
            <p className="card-empty-copy">No credit accounts yet.</p>
          ) : (
            <div className="credit-account-grid">
              {workspace.creditAccounts.map((account) => (
                <div className="credit-account-card" key={account.id}>
                  <code>{account.creditType}</code>
                  <strong>{account.availableBalance.toLocaleString()}</strong>
                  <span>
                    {account.reservedBalance.toLocaleString()} reserved
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card customer-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Access</span>
              <h2 className="card-title">Entitlements</h2>
            </div>
          </div>
          {workspace.entitlements.length === 0 ? (
            <p className="card-empty-copy">No entitlement grants yet.</p>
          ) : (
            <div className="entitlement-list">
              {workspace.entitlements.map((entitlement) => (
                <div className="entitlement-row" key={entitlement.id}>
                  <div>
                    <strong>{entitlement.featureKey}</strong>
                    <span>
                      {entitlement.sourceType} · {entitlement.sourceId}
                    </span>
                  </div>
                  <span className={`badge badge-${entitlement.status}`}>
                    {entitlement.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card customer-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Payments</span>
            <h2 className="card-title">Payment history</h2>
          </div>
          <span className="customer-section-note">Provider-neutral state</span>
        </div>
        {workspace.payments.length === 0 ? (
          <p className="card-empty-copy">
            No payments recorded for this customer.
          </p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table customer-payment-table">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Provider</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {workspace.payments.map((payment) => {
                  const amountLabel = formatAmount(
                    payment.amountMinor,
                    payment.currency,
                  );
                  const canRefund =
                    payment.canRefundProvider &&
                    payment.status === "succeeded" &&
                    payment.order?.billingMode === "one_time";
                  return (
                    <tr key={payment.id}>
                      <td>
                        <div className="customer-payment-id">
                          <code>{payment.id}</code>
                          {payment.orderItems[0] && (
                            <span>
                              {payment.orderItems
                                .map(
                                  (item) => item.productName ?? item.productId,
                                )
                                .join(", ")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>{amountLabel}</td>
                      <td>
                        <span className={`badge badge-${payment.status}`}>
                          {payment.status}
                        </span>
                      </td>
                      <td>{payment.providerName ?? payment.provider ?? "—"}</td>
                      <td className="cell-muted">
                        {formatDateTime(payment.createdAt)}
                      </td>
                      <td>
                        {canRefund ? (
                          <RefundPaymentAction
                            customerId={workspace.customer.id}
                            paymentId={payment.id}
                            amountLabel={amountLabel}
                          />
                        ) : payment.status === "failed" ? (
                          <span className="customer-action-unavailable">
                            Retry is not available in the shared provider
                            contract
                          </span>
                        ) : (
                          <span className="customer-action-unavailable">
                            No supported action
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="customer-two-column-grid customer-history-grid">
        <section className="card customer-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Credit ledger</span>
              <h2 className="card-title">Recent movements</h2>
            </div>
          </div>
          {workspace.creditLedger.length === 0 ? (
            <p className="card-empty-copy">No credit movements yet.</p>
          ) : (
            <div className="ledger-list">
              {workspace.creditLedger.slice(0, 30).map((entry) => (
                <div className="ledger-row" key={entry.id}>
                  <div>
                    <strong>{entry.type}</strong>
                    <span>
                      {entry.sourceType} · {entry.sourceId}
                    </span>
                  </div>
                  <div className="ledger-row-values">
                    <strong
                      className={
                        entry.amount > 0 ? "is-positive" : "is-negative"
                      }
                    >
                      {entry.amount > 0 ? "+" : ""}
                      {entry.amount.toLocaleString()}
                    </strong>
                    <span>
                      {entry.availableAfter.toLocaleString()} available
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card customer-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Events</span>
              <h2 className="card-title">Recent billing events</h2>
            </div>
          </div>
          {workspace.events.length === 0 ? (
            <p className="card-empty-copy">
              No customer-linked provider events found.
            </p>
          ) : (
            <div className="customer-event-list">
              {workspace.events.map((event) => (
                <div className="customer-event-row" key={event.id}>
                  <div className="customer-event-dot" aria-hidden="true" />
                  <div>
                    <strong>{event.normalizedType}</strong>
                    <span>{event.providerEventName}</span>
                    <small>{formatDateTime(event.occurredAt)}</small>
                  </div>
                  <span className={`badge badge-${event.status}`}>
                    {event.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="customer-workspace-footer">
        <Link href="/customers">← Back to customer list</Link>
      </div>
    </PageContainer>
  );
}
