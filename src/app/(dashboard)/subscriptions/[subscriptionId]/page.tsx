import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CancelSubscriptionAction,
  ReconcileBillingOperationAction,
  RetryBillingOperationAction,
} from "@/components/billing/BillingOperationActions";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getSubscriptionDetail } from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type SubscriptionPageProps = {
  params: Promise<{ subscriptionId: string }>;
};

export default async function SubscriptionPage({
  params,
}: SubscriptionPageProps) {
  const [{ subscriptionId }, context] = await Promise.all([
    params,
    getConsoleContext(),
  ]);
  if (!context.selectedApplication) notFound();

  let subscription: Awaited<ReturnType<typeof getSubscriptionDetail>>;
  try {
    subscription = await getSubscriptionDetail(
      context.selectedApplication.id,
      subscriptionId,
      context.environment,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Subscription not found")
    ) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer
      title="Subscription detail"
      description="Recurring billing state, customer access, cancellation eligibility, and operation recovery."
      primaryAction={{ label: "Back to subscriptions", href: "/subscriptions" }}
    >
      <section className="billing-detail-hero card">
        <div>
          <span className="builder-kicker">Subscription</span>
          <h2>
            {subscription.items[0]?.productName ??
              subscription.items[0]?.productKey ??
              subscription.id}
          </h2>
          <div className="billing-detail-meta">
            <code>{subscription.id}</code>
            <span>{subscription.providerSubscriptionId}</span>
            <span>Updated {formatDateTime(subscription.updatedAt)}</span>
          </div>
        </div>
        <span className={`badge badge-${subscription.status}`}>
          {subscription.status.replace("_", " ")}
        </span>
      </section>

      <div className="billing-summary-grid">
        <section className="card billing-summary-card">
          <span>Customer</span>
          <Link href={`/customers/${subscription.applicationCustomerId}`}>
            <strong>{subscription.externalCustomerId ?? "Customer"}</strong>
          </Link>
          <small>{subscription.customerEmail ?? "No email"}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Provider</span>
          <strong>
            {subscription.providerName ?? subscription.provider ?? "Unknown"}
          </strong>
          <small>{subscription.providerConnectionId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Current period</span>
          <strong>
            {subscription.currentPeriodEnd
              ? formatDateTime(subscription.currentPeriodEnd)
              : "No period end"}
          </strong>
          <small>
            {subscription.cancelAtPeriodEnd
              ? "Cancellation scheduled"
              : "Renews normally"}
          </small>
        </section>
        <section className="card billing-summary-card">
          <span>Operator operations</span>
          <strong>{subscription.operations.length}</strong>
          <small>
            {subscription.operations.some(
              (operation) => operation.status === "needs_reconciliation",
            )
              ? "Reconciliation needed"
              : "No reconciliation alert"}
          </small>
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Operation</span>
            <h2 className="card-title">Cancellation eligibility</h2>
          </div>
        </div>
        {subscription.cancellationEligibility.eligible ? (
          <div className="billing-operation-callout is-eligible">
            <div>
              <strong>Cancellation is available</strong>
              <p>
                The connected provider declares subscription cancellation
                capability.
              </p>
            </div>
            <CancelSubscriptionAction subscriptionId={subscription.id} />
          </div>
        ) : (
          <div className="billing-operation-callout">
            <div>
              <strong>Cancellation unavailable</strong>
              <p>{subscription.cancellationEligibility.reason}</p>
            </div>
          </div>
        )}
      </section>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Plan</span>
            <h2 className="card-title">Subscription items</h2>
          </div>
        </div>
        {subscription.items.length === 0 ? (
          <p className="card-empty-copy">No subscription items are recorded.</p>
        ) : (
          <div className="billing-item-list">
            {subscription.items.map((item) => (
              <div
                className="billing-item-row"
                key={`${item.subscriptionId}:${item.priceId}`}
              >
                <div>
                  <strong>
                    {item.productName ?? item.productKey ?? item.productId}
                  </strong>
                  <code>{item.productId}</code>
                </div>
                <span>
                  {item.amountMinor !== null &&
                  item.amountMinor !== undefined &&
                  item.currency
                    ? `${formatAmount(item.amountMinor, item.currency)}/${item.recurringInterval ?? "period"}`
                    : `${item.quantity} × item`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="billing-two-column-grid">
        <section className="card billing-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Operations</span>
              <h2 className="card-title">Recovery journal</h2>
            </div>
          </div>
          {subscription.operations.length === 0 ? (
            <p className="card-empty-copy">
              No operator mutations have been recorded.
            </p>
          ) : (
            <div className="billing-operation-list">
              {subscription.operations.map((operation) => (
                <div className="billing-operation-row" key={operation.id}>
                  <div>
                    <strong>{operation.type.replace("_", " ")}</strong>
                    <code>{operation.id}</code>
                    <span>
                      Attempt {operation.attemptNumber}
                      {operation.retryOfOperationId ? " · retry" : ""}
                      {" · "}
                      {formatDateTime(operation.createdAt)}
                    </span>
                    {operation.failureKind && (
                      <small>
                        Provider outcome: {operation.failureKind.replaceAll("_", " ")}
                      </small>
                    )}
                    {operation.errorMessage && (
                      <small>{operation.errorMessage}</small>
                    )}
                  </div>
                  <div className="billing-operation-row-action">
                    <span className={`badge badge-${operation.status}`}>
                      {operation.status.replaceAll("_", " ")}
                    </span>
                    {["provider_succeeded", "needs_reconciliation"].includes(
                      operation.status,
                    ) && (
                      <ReconcileBillingOperationAction
                        operationId={operation.id}
                      />
                    )}
                    {operation.status === "failed" &&
                      operation.failureKind === "rejected" && (
                        <RetryBillingOperationAction operationId={operation.id} />
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card billing-section">
          <div className="card-heading-row">
            <div>
              <span className="builder-kicker">Timeline</span>
              <h2 className="card-title">Provider events</h2>
            </div>
          </div>
          {subscription.events.length === 0 ? (
            <p className="card-empty-copy">
              No related provider events were found.
            </p>
          ) : (
            <div className="billing-timeline">
              {subscription.events.map((event) => (
                <div className="billing-timeline-row" key={event.id}>
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
    </PageContainer>
  );
}
