import Link from "next/link";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatMessage, getDictionary } from "@/i18n/server";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getRefundDetail } from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type RefundPageProps = {
  params: Promise<{ refundId: string }>;
};

export default async function RefundPage({ params }: RefundPageProps) {
  const [{ refundId }, context, dictionary] = await Promise.all([
    params,
    getConsoleContext(),
    getDictionary(),
  ]);
  const t = dictionary.refundDetail;
  if (!context.selectedApplication) notFound();

  let refund: Awaited<ReturnType<typeof getRefundDetail>>;
  try {
    refund = await getRefundDetail(
      context.selectedApplication.id,
      refundId,
      context.environment,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("Refund not found")) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer
      title={t.title}
      description={t.description}
      primaryAction={{ label: t.back, href: "/refunds" }}
    >
      <section className="billing-detail-hero card">
        <div>
          <span className="builder-kicker">{t.kicker}</span>
          <h2>
            {refund.amountMinor !== null && refund.paymentCurrency
              ? formatAmount(refund.amountMinor, refund.paymentCurrency)
              : t.kicker}
          </h2>
          <div className="billing-detail-meta">
            <code>{refund.id}</code>
            <span>{refund.providerRefundId}</span>
            <span>{formatDateTime(refund.createdAt)}</span>
          </div>
        </div>
        <StatusBadge status={refund.status} />
      </section>

      <div className="billing-summary-grid">
        <section className="card billing-summary-card">
          <span>{t.payment}</span>
          <Link href={`/payments/${refund.paymentId}`}>
            <strong>{refund.paymentId}</strong>
          </Link>
          <small>{refund.payment.providerPaymentId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.customer}</span>
          {refund.applicationCustomerId ? (
            <Link href={`/customers/${refund.applicationCustomerId}`}>
              <strong>{refund.externalCustomerId ?? t.customerFallback}</strong>
            </Link>
          ) : (
            <strong>{t.unknown}</strong>
          )}
          <small>{refund.customerEmail ?? t.noEmail}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.provider}</span>
          <strong>{refund.providerName ?? refund.provider ?? t.unknown}</strong>
          <small>{refund.providerConnectionId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>{t.order}</span>
          <strong>{refund.orderId ?? t.notLinked}</strong>
          <small>{refund.payment.billingMode ?? t.unknownBillingMode}</small>
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">{t.productKicker}</span>
            <h2 className="card-title">{t.itemsTitle}</h2>
          </div>
        </div>
        {refund.items.length === 0 ? (
          <p className="card-empty-copy">{t.noItems}</p>
        ) : (
          <div className="billing-item-list">
            {refund.items.map((item) => (
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
                  })}
                </span>
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
          <span className="customer-section-note">{t.eventsNote}</span>
        </div>
        {refund.payment.events.length === 0 ? (
          <p className="card-empty-copy">{t.noEvents}</p>
        ) : (
          <div className="billing-timeline">
            {refund.payment.events.map((event) => (
              <div className="billing-timeline-row" key={event.id}>
                <div className="customer-event-dot" aria-hidden="true" />
                <div>
                  <strong>{event.normalizedType}</strong>
                  <span>{event.providerEventName}</span>
                  <small>{formatDateTime(event.occurredAt)}</small>
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
