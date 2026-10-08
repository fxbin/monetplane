import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ReconcileBillingOperationAction,
  RefundPaymentAction,
  RetryBillingOperationAction,
} from "@/components/billing/BillingOperationActions";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary, getLocaleTag } from "@/i18n/server";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getPaymentDetail } from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type PaymentPageProps = {
  params: Promise<{ paymentId: string }>;
};

export default async function PaymentPage({ params }: PaymentPageProps) {
  const [{ paymentId }, context, dictionary] = await Promise.all([
    params,
    getConsoleContext(),
    getDictionary(),
  ]);
  const localeTag = await getLocaleTag();
  const fmtDateTime = (d: Date | string) => formatDateTime(d, localeTag);
  const t = dictionary.paymentDetail;
  if (!context.selectedApplication) notFound();

  let payment: Awaited<ReturnType<typeof getPaymentDetail>>;
  try {
    payment = await getPaymentDetail(
      context.selectedApplication.id,
      paymentId,
      context.environment,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Payment not found")) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer
      title={t.title}
      description={t.description}
      primaryAction={{ label: t.back, href: "/payments" }}
    >
      <section className="billing-detail-hero card">
        <div>
          <span className="builder-kicker">{t.kicker}</span>
          <h2>{formatAmount(payment.amountMinor, payment.currency)}</h2>
          <div className="billing-detail-meta">
            <code>{payment.id}</code>
            <span>{payment.providerPaymentId}</span>
            <span>{fmtDateTime(payment.createdAt)}</span>
          </div>
        </div>
        <StatusBadge status={payment.status} />
      </section>

      <div className="billing-summary-grid">
        <section className="card billing-summary-card">
          <span>{t.customer}</span>
          {payment.applicationCustomerId ? (
            <Link href={`/customers/${payment.applicationCustomerId}`}>
              <strong>
                {payment.externalCustomerId ?? t.customerFallback}
              </strong>
            </Link>
          ) : (
            <strong>{t.unknown}</strong>
          )}
          <small>{payment.customerEmail ?? t.noEmail}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.provider}</span>
          <strong>
            {payment.providerName ?? payment.provider ?? t.unknown}
          </strong>
          <small>{payment.providerConnectionId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.order}</span>
          <strong>{payment.orderId ?? t.notLinked}</strong>
          <small>{payment.billingMode ?? t.unknownBillingMode}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.refunds}</span>
          <strong>{payment.refunds.length}</strong>
          <small>
            {payment.refundEligibility.eligible ? t.eligibleNow : t.notEligible}
          </small>
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.operationKicker}</span>
            <h2 className="card-title">{t.eligibilityTitle}</h2>
          </div>
        </div>
        {payment.refundEligibility.eligible ? (
          <div className="billing-operation-callout is-eligible">
            <div>
              <strong>{t.eligibleTitle}</strong>
              <p>{t.eligibleDesc}</p>
            </div>
            <RefundPaymentAction
              paymentId={payment.id}
              labels={dictionary.operationActions}
            />
          </div>
        ) : (
          <div className="billing-operation-callout">
            <div>
              <strong>{t.unavailableTitle}</strong>
              <p>{payment.refundEligibility.reason}</p>
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
        {payment.items.length === 0 ? (
          <p className="card-empty-copy">{t.noItems}</p>
        ) : (
          <div className="billing-item-list">
            {payment.items.map((item) => (
              <div
                className="billing-item-row"
                key={`${item.orderId}:${item.priceId}`}
              >
                <div>
                  <strong>
                    {item.productName ?? item.productKey ?? item.productId}
                  </strong>
                  <code>{item.productId}</code>
                </div>
                <span>
                  {formatMessage(t.quantityTimes, {
                    count: String(item.quantity),
                    amount: formatAmount(
                      item.unitAmountMinor,
                      payment.currency,
                    ),
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
          {payment.operations.length === 0 ? (
            <p className="card-empty-copy">{t.noOperations}</p>
          ) : (
            <div className="billing-operation-list">
              {payment.operations.map((operation) => (
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
              <span className="builder-kicker">{t.refundHistoryKicker}</span>
              <h2 className="card-title">{t.refundsTitle}</h2>
            </div>
          </div>
          {payment.refunds.length === 0 ? (
            <p className="card-empty-copy">{t.noRefunds}</p>
          ) : (
            <div className="billing-operation-list">
              {payment.refunds.map((refund) => (
                <Link
                  className="billing-operation-row billing-operation-link"
                  href={`/refunds/${refund.id}`}
                  key={refund.id}
                >
                  <div>
                    <strong>
                      {formatAmount(
                        refund.amountMinor ?? payment.amountMinor,
                        payment.currency,
                      )}
                    </strong>
                    <code>{refund.providerRefundId}</code>
                  </div>
                  <StatusBadge status={refund.status} />
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.timelineKicker}</span>
            <h2 className="card-title">{t.eventsTitle}</h2>
          </div>
          <span className="customer-section-note">{t.eventsNote}</span>
        </div>
        {payment.events.length === 0 ? (
          <p className="card-empty-copy">{t.noEvents}</p>
        ) : (
          <div className="billing-timeline">
            {payment.events.map((event) => (
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
    </PageContainer>
  );
}
