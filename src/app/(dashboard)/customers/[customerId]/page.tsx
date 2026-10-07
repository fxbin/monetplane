import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CancelSubscriptionAction,
  GrantCreditsAction,
  RefundPaymentAction,
} from "@/components/customers/CustomerActions";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount, formatDate, formatDateTime } from "@/lib/format";
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
  fallback: string,
) {
  const product = subscription.items[0]?.productName;
  return product || formatMessage(fallback, { id: subscription.id });
}

export default async function CustomerPage({ params }: CustomerPageProps) {
  const [{ customerId }, context, dictionary] = await Promise.all([
    params,
    getConsoleContext(),
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDate = (d: Date | string) => formatDate(d, localeTag);
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.customerDetail;
  if (!context.selectedApplication) notFound();

  let workspace: Awaited<ReturnType<typeof getCustomerWorkspace>>;
  try {
    workspace = await getCustomerWorkspace(
      context.selectedApplication.id,
      customerId,
      context.environment,
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
        formatMessage(t.workspaceFallback, {
          application: context.selectedApplication.name,
        })
      }
      primaryAction={{ label: t.back, href: "/customers" }}
    >
      <section className="customer-workspace-hero card">
        <div className="customer-workspace-identity">
          <span className="builder-kicker">{t.kicker}</span>
          <h2>{workspace.customer.externalCustomerId}</h2>
          <div className="customer-identity-meta">
            <span>{workspace.customer.email ?? t.noEmail}</span>
            <code>{workspace.customer.id}</code>
            <span>
              {formatMessage(t.created, {
                date: fmtDateTime(workspace.customer.createdAt),
              })}
            </span>
          </div>
        </div>
        <div className="customer-hero-actions">
          <GrantCreditsAction
            customerId={workspace.customer.id}
            labels={dictionary.customerActions}
          />
        </div>
      </section>

      <div className="customer-summary-grid">
        <section className="card customer-summary-card">
          <span>{t.currentPlan}</span>
          {currentSubscription ? (
            <>
              <strong>
                {subscriptionLabel(currentSubscription, t.subscriptionFallback)}
              </strong>
              <div>
                <StatusBadge
                  status={currentSubscription.status}
                  label={currentSubscription.status.replace("_", " ")}
                />
                {currentSubscription.cancelAtPeriodEnd && (
                  <span className="customer-inline-note">
                    {t.cancelsAtPeriodEnd}
                  </span>
                )}
              </div>
            </>
          ) : (
            <strong>{t.noSubscription}</strong>
          )}
        </section>
        <section className="card customer-summary-card">
          <span>{t.availableCredits}</span>
          <strong>{totalAvailableCredits.toLocaleString()}</strong>
          <small>
            {formatMessage(t.reserved, {
              count: totalReservedCredits.toLocaleString(),
            })}
          </small>
        </section>
        <section className="card customer-summary-card">
          <span>{t.activeFeatures}</span>
          <strong>{activeEntitlements.length}</strong>
          <small>
            {formatMessage(t.totalGrants, {
              count: String(workspace.entitlements.length),
            })}
          </small>
        </section>
        <section className="card customer-summary-card">
          <span>{t.payments}</span>
          <strong>{workspace.payments.length}</strong>
          <small>
            {formatMessage(t.successfulCount, {
              count: String(
                workspace.payments.filter(
                  (payment) => payment.status === "succeeded",
                ).length,
              ),
            })}
          </small>
        </section>
      </div>

      <section className="card customer-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.subscriptionKicker}</span>
            <h2 className="card-title">{t.planHistoryTitle}</h2>
          </div>
        </div>
        {workspace.subscriptions.length === 0 ? (
          <p className="card-empty-copy">{t.noSubscriptions}</p>
        ) : (
          <div className="customer-subscription-list">
            {workspace.subscriptions.map((subscription) => (
              <article
                className="customer-subscription-row"
                key={subscription.id}
              >
                <div className="customer-subscription-main">
                  <div>
                    <strong>
                      {subscriptionLabel(subscription, t.subscriptionFallback)}
                    </strong>
                    <code>{subscription.id}</code>
                  </div>
                  <StatusBadge
                    status={subscription.status}
                    label={subscription.status.replace("_", " ")}
                  />
                </div>
                <div className="customer-subscription-meta">
                  <span>
                    {subscription.providerName ??
                      subscription.provider ??
                      t.providerFallback}
                  </span>
                  <span>
                    {subscription.currentPeriodEnd
                      ? formatMessage(t.periodEnds, {
                          date: fmtDateTime(subscription.currentPeriodEnd),
                        })
                      : t.noPeriodEnd}
                  </span>
                  {subscription.cancelAtPeriodEnd && (
                    <span>{t.cancellationScheduled}</span>
                  )}
                </div>
                <div className="customer-subscription-products">
                  {subscription.items.map((item) => (
                    <span key={`${subscription.id}:${item.priceId}`}>
                      {item.productName ?? item.productId}
                      {item.amountMinor !== null &&
                      item.amountMinor !== undefined &&
                      item.currency
                        ? ` · ${formatAmount(item.amountMinor, item.currency)}/${item.recurringInterval ?? t.intervalPeriod}`
                        : ""}
                    </span>
                  ))}
                </div>
                {subscription.canCancel && (
                  <div className="customer-row-actions">
                    <CancelSubscriptionAction
                      customerId={workspace.customer.id}
                      subscriptionId={subscription.id}
                      label={subscriptionLabel(
                        subscription,
                        t.subscriptionFallback,
                      )}
                      labels={dictionary.customerActions}
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
              <span className="builder-kicker">{t.creditsKicker}</span>
              <h2 className="card-title">{t.balancesTitle}</h2>
            </div>
          </div>
          {workspace.creditAccounts.length === 0 ? (
            <p className="card-empty-copy">{t.noCreditAccounts}</p>
          ) : (
            <div className="credit-account-grid">
              {workspace.creditAccounts.map((account) => (
                <div className="credit-account-card" key={account.id}>
                  <code>{account.creditType}</code>
                  <strong>{account.availableBalance.toLocaleString()}</strong>
                  <span>
                    {formatMessage(t.reserved, {
                      count: account.reservedBalance.toLocaleString(),
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card customer-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">{t.accessKicker}</span>
              <h2 className="card-title">{t.entitlementsTitle}</h2>
            </div>
          </div>
          {workspace.entitlements.length === 0 ? (
            <p className="card-empty-copy">{t.noEntitlements}</p>
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
                  <StatusBadge status={entitlement.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card customer-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.paymentsKicker}</span>
            <h2 className="card-title">{t.paymentsTitle}</h2>
          </div>
          <span className="customer-section-note">{t.paymentsNote}</span>
        </div>
        {workspace.payments.length === 0 ? (
          <p className="card-empty-copy">{t.noPayments}</p>
        ) : (
          <div className="table-wrapper">
            <table className="data-table customer-payment-table">
              <thead>
                <tr>
                  <th>{t.thPayment}</th>
                  <th>{t.thAmount}</th>
                  <th>{t.thStatus}</th>
                  <th>{t.thProvider}</th>
                  <th>{t.thCreated}</th>
                  <th>{t.thAction}</th>
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
                        <StatusBadge status={payment.status} />
                      </td>
                      <td>{payment.providerName ?? payment.provider ?? "—"}</td>
                      <td className="cell-muted">
                        {fmtDateTime(payment.createdAt)}
                      </td>
                      <td>
                        {canRefund ? (
                          <RefundPaymentAction
                            customerId={workspace.customer.id}
                            paymentId={payment.id}
                            amountLabel={amountLabel}
                            labels={dictionary.customerActions}
                          />
                        ) : payment.status === "failed" ? (
                          <span className="customer-action-unavailable">
                            {t.retryUnavailable}
                          </span>
                        ) : (
                          <span className="customer-action-unavailable">
                            {t.noAction}
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
              <span className="builder-kicker">{t.ledgerKicker}</span>
              <h2 className="card-title">{t.ledgerTitle}</h2>
            </div>
          </div>
          {workspace.creditLedger.length === 0 ? (
            <p className="card-empty-copy">{t.noLedger}</p>
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
                      {formatMessage(t.availableAfter, {
                        count: entry.availableAfter.toLocaleString(),
                      })}
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
              <span className="builder-kicker">{t.eventsKicker}</span>
              <h2 className="card-title">{t.eventsTitle}</h2>
            </div>
          </div>
          {workspace.events.length === 0 ? (
            <p className="card-empty-copy">{t.noEvents}</p>
          ) : (
            <div className="customer-event-list">
              {workspace.events.map((event) => (
                <div className="customer-event-row" key={event.id}>
                  <div className="customer-event-dot" aria-hidden="true" />
                  <div>
                    <strong>{event.normalizedType}</strong>
                    <span>{event.providerEventName}</span>
                    <small>{fmtDateTime(event.occurredAt)}</small>
                  </div>
                  <StatusBadge status={event.status} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="customer-workspace-footer">
        <Link href="/customers">{t.backToList}</Link>
      </div>
    </PageContainer>
  );
}
