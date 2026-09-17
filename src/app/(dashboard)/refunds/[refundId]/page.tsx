import Link from "next/link";
import { notFound } from "next/navigation";
import { PageContainer } from "@/components/layout/PageContainer";
import { StatusBadge } from "@/components/ui/console";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getRefundDetail } from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type RefundPageProps = {
  params: Promise<{ refundId: string }>;
};

export default async function RefundPage({ params }: RefundPageProps) {
  const [{ refundId }, context] = await Promise.all([
    params,
    getConsoleContext(),
  ]);
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
      title="Refund detail"
      description="Normalized refund state with the payment, customer, product, and event context needed to explain what happened."
      primaryAction={{ label: "Back to refunds", href: "/refunds" }}
    >
      <section className="billing-detail-hero card">
        <div>
          <span className="builder-kicker">Refund</span>
          <h2>
            {refund.amountMinor !== null && refund.paymentCurrency
              ? formatAmount(refund.amountMinor, refund.paymentCurrency)
              : "Refund"}
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
          <span>Payment</span>
          <Link href={`/payments/${refund.paymentId}`}>
            <strong>{refund.paymentId}</strong>
          </Link>
          <small>{refund.payment.providerPaymentId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Customer</span>
          {refund.applicationCustomerId ? (
            <Link href={`/customers/${refund.applicationCustomerId}`}>
              <strong>{refund.externalCustomerId ?? "Customer"}</strong>
            </Link>
          ) : (
            <strong>Unknown</strong>
          )}
          <small>{refund.customerEmail ?? "No email"}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Provider</span>
          <strong>{refund.providerName ?? refund.provider ?? "Unknown"}</strong>
          <small>{refund.providerConnectionId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Order</span>
          <strong>{refund.orderId ?? "Not linked"}</strong>
          <small>{refund.payment.billingMode ?? "Unknown billing mode"}</small>
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Product context</span>
            <h2 className="card-title">Refunded items</h2>
          </div>
        </div>
        {refund.items.length === 0 ? (
          <p className="card-empty-copy">
            No order items are linked to this refund.
          </p>
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
                <span>{item.quantity} × item</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Timeline</span>
            <h2 className="card-title">Payment events</h2>
          </div>
          <span className="customer-section-note">Normalized events only</span>
        </div>
        {refund.payment.events.length === 0 ? (
          <p className="card-empty-copy">
            No related provider events were found.
          </p>
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
