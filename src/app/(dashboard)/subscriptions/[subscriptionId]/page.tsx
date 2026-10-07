import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CancelSubscriptionAction,
  ReconcileBillingOperationAction,
  RetryBillingOperationAction,
} from "@/components/billing/BillingOperationActions";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount, formatDate, formatDateTime } from "@/lib/format";
import { getSubscriptionDetail } from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type SubscriptionPageProps = {
  params: Promise<{ subscriptionId: string }>;
};

export default async function SubscriptionPage({
  params,
}: SubscriptionPageProps) {
  const [{ subscriptionId }, context, dictionary] = await Promise.all([
    params,
    getConsoleContext(),
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDate = (d: Date | string) => formatDate(d, localeTag);
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.subscriptionDetail;
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
      title={t.title}
      description={t.description}
      primaryAction={{ label: t.back, href: "/subscriptions" }}
    >
      <section className="billing-detail-hero card">
        <div>
          <span className="builder-kicker">{t.kicker}</span>
          <h2>
            {subscription.items[0]?.productName ??
              subscription.items[0]?.productKey ??
              subscription.id}
          </h2>
          <div className="billing-detail-meta">
            <code>{subscription.id}</code>
            <span>{subscription.providerSubscriptionId}</span>
            <span>
              {formatMessage(t.updated, {
                date: fmtDateTime(subscription.updatedAt),
              })}
            </span>
          </div>
        </div>
        <StatusBadge
          status={subscription.status}
          label={subscription.status.replace("_", " ")}
        />
      </section>

      <div className="billing-summary-grid">
        <section className="card billing-summary-card">
          <span>{t.customer}</span>
          <Link href={`/customers/${subscription.applicationCustomerId}`}>
            <strong>
              {subscription.externalCustomerId ?? t.customerFallback}
            </strong>
          </Link>
          <small>{subscription.customerEmail ?? t.noEmail}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.provider}</span>
          <strong>
            {subscription.providerName ?? subscription.provider ?? t.unknown}
          </strong>
          <small>{subscription.providerConnectionId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.currentPeriod}</span>
          <strong>
            {subscription.currentPeriodEnd
              ? fmtDateTime(subscription.currentPeriodEnd)
              : t.noPeriodEnd}
          </strong>
          <small>
            {subscription.cancelAtPeriodEnd
              ? t.cancellationScheduled
              : t.renewsNormally}
          </small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.operationsCard}</span>
          <strong>{subscription.operations.length}</strong>
          <small>
            {subscription.operations.some(
              (operation) => operation.status === "needs_reconciliation",
            )
              ? t.reconciliationNeeded
              : t.noReconciliationAlert}
          </small>
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.operationKicker}</span>
            <h2 className="card-title">{t.cancellationTitle}</h2>
          </div>
        </div>
        {subscription.cancellationEligibility.eligible ? (
          <div className="billing-operation-callout is-eligible">
            <div>
              <strong>{t.cancellationAvailable}</strong>
              <p>{t.cancellationAvailableDesc}</p>
            </div>
            <CancelSubscriptionAction
              subscriptionId={subscription.id}
              labels={dictionary.operationActions}
            />
          </div>
        ) : (
          <div className="billing-operation-callout">
            <div>
              <strong>{t.cancellationUnavailable}</strong>
              <p>{subscription.cancellationEligibility.reason}</p>
            </div>
          </div>
        )}
      </section>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.itemsKicker}</span>
            <h2 className="card-title">{t.itemsTitle}</h2>
          </div>
        </div>
        {subscription.items.length === 0 ? (
          <p className="card-empty-copy">{t.noItems}</p>
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
                    ? `${formatAmount(item.amountMinor, item.currency)}/${item.recurringInterval ?? t.intervalPeriod}`
                    : formatMessage(t.quantityTimes, {
                        count: String(item.quantity),
                        amount: "",
                      })}
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
              <span className="builder-kicker">{t.operationsKicker}</span>
              <h2 className="card-title">{t.journalTitle}</h2>
            </div>
          </div>
          {subscription.operations.length === 0 ? (
            <p className="card-empty-copy">{t.noOperations}</p>
          ) : (
            <div className="billing-operation-list">
              {subscription.operations.map((operation) => (
                <div className="billing-operation-row" key={operation.id}>
                  <div>
                    <strong>{operation.type.replace("_", " ")}</strong>
                    <code>{operation.id}</code>
                    <span>
                      {formatMessage(t.attempt, {
                        number: String(operation.attemptNumber),
                      })}
                      {operation.retryOfOperationId ? t.retrySuffix : ""}
                      {" · "}
                      {fmtDateTime(operation.createdAt)}
                    </span>
                    {operation.failureKind && (
                      <small>
                        {formatMessage(t.providerOutcome, {
                          outcome: operation.failureKind.replaceAll("_", " "),
                        })}
                      </small>
                    )}
                    {operation.errorMessage && (
                      <small>{operation.errorMessage}</small>
                    )}
                  </div>
                  <div className="billing-operation-row-action">
                    <StatusBadge
                      status={operation.status}
                      label={operation.status.replaceAll("_", " ")}
                    />
                    {["provider_succeeded", "needs_reconciliation"].includes(
                      operation.status,
                    ) && (
                      <ReconcileBillingOperationAction
                        operationId={operation.id}
                        labels={dictionary.operationActions}
                      />
                    )}
                    {operation.status === "failed" &&
                      operation.failureKind === "rejected" && (
                        <RetryBillingOperationAction
                          operationId={operation.id}
                          labels={dictionary.operationActions}
                        />
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
              <span className="builder-kicker">{t.timelineKicker}</span>
              <h2 className="card-title">{t.eventsTitle}</h2>
            </div>
          </div>
          {subscription.events.length === 0 ? (
            <p className="card-empty-copy">{t.noEvents}</p>
          ) : (
            <div className="billing-timeline">
              {subscription.events.map((event) => (
                <div className="billing-timeline-row" key={event.id}>
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
    </PageContainer>
  );
}
