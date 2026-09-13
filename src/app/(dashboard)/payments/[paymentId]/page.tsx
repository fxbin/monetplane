import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ReconcileBillingOperationAction,
  RefundPaymentAction,
} from "@/components/billing/BillingOperationActions";
import { PageContainer } from "@/components/layout/PageContainer";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getPaymentDetail } from "@/server/control-plane/billing-operations";
import { getConsoleContext } from "@/server/control-plane/context";

export const dynamic = "force-dynamic";

type PaymentPageProps = {
  params: Promise<{ paymentId: string }>;
};

export default async function PaymentPage({ params }: PaymentPageProps) {
  const [{ paymentId }, context] = await Promise.all([
    params,
    getConsoleContext(),
  ]);
  if (!context.selectedApplication) notFound();

  let payment: Awaited<ReturnType<typeof getPaymentDetail>>;
  try {
    payment = await getPaymentDetail(context.selectedApplication.id, paymentId);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Payment not found")) {
      notFound();
    }
    throw error;
  }

  return (
    <PageContainer
      title="Payment detail"
      description="Provider-neutral payment state, customer context, refund eligibility, and recoverable operation history."
      primaryAction={{ label: "Back to payments", href: "/payments" }}
    >
      <section className="billing-detail-hero card">
        <div>
          <span className="builder-kicker">Payment</span>
          <h2>{formatAmount(payment.amountMinor, payment.currency)}</h2>
          <div className="billing-detail-meta">
            <code>{payment.id}</code>
            <span>{payment.providerPaymentId}</span>
            <span>{formatDateTime(payment.createdAt)}</span>
          </div>
        </div>
        <span className={`badge badge-${payment.status}`}>{payment.status}</span>
      </section>

      <div className="billing-summary-grid">
        <section className="card billing-summary-card">
          <span>Customer</span>
          {payment.applicationCustomerId ? (
            <Link href={`/customers/${payment.applicationCustomerId}`}>
              <strong>{payment.externalCustomerId ?? "Customer"}</strong>
            </Link>
          ) : (
            <strong>Unknown</strong>
          )}
          <small>{payment.customerEmail ?? "No email"}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Provider</span>
          <strong>{payment.providerName ?? payment.provider ?? "Unknown"}</strong>
          <small>{payment.providerConnectionId}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Order</span>
          <strong>{payment.orderId ?? "Not linked"}</strong>
          <small>{payment.billingMode ?? "Unknown billing mode"}</small>
        </section>
        <section className="card billing-summary-card">
          <span>Refunds</span>
          <strong>{payment.refunds.length}</strong>
          <small>{payment.refundEligibility.eligible ? "Eligible now" : "Not eligible"}</small>
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Operation</span>
            <h2 className="card-title">Refund eligibility</h2>
          </div>
        </div>
        {payment.refundEligibility.eligible ? (
          <div className="billing-operation-callout is-eligible">
            <div>
              <strong>Full refund is available</strong>
              <p>
                The provider declares refund capability and MonetPlane found no unsafe credit-clawback condition.
              </p>
            </div>
            <RefundPaymentAction paymentId={payment.id} />
          </div>
        ) : (
          <div className="billing-operation-callout">
            <div>
              <strong>Refund unavailable</strong>
              <p>{payment.refundEligibility.reason}</p>
            </div>
          </div>
        )}
      </section>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Purchased items</span>
            <h2 className="card-title">Product context</h2>
          </div>
        </div>
        {payment.items.length === 0 ? (
          <p className="card-empty-copy">No order items are linked to this payment.</p>
        ) : (
          <div className="billing-item-list">
            {payment.items.map((item) => (
              <div className="billing-item-row" key={`${item.orderId}:${item.priceId}`}>
                <div>
                  <strong>{item.productName ?? item.productKey ?? item.productId}</strong>
                  <code>{item.productId}</code>
                </div>
                <span>
                  {item.quantity} × {formatAmount(item.unitAmountMinor, payment.currency)}
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
          {payment.operations.length === 0 ? (
            <p className="card-empty-copy">No operator mutations have been recorded.</p>
          ) : (
            <div className="billing-operation-list">
              {payment.operations.map((operation) => (
                <div className="billing-operation-row" key={operation.id}>
                  <div>
                    <strong>{operation.type.replace("_", " ")}</strong>
                    <code>{operation.id}</code>
                    <span>{formatDateTime(operation.createdAt)}</span>
                    {operation.errorMessage && <small>{operation.errorMessage}</small>}
                  </div>
                  <div className="billing-operation-row-action">
                    <span className={`badge badge-${operation.status}`}>
                      {operation.status.replaceAll("_", " ")}
                    </span>
                    {["provider_succeeded", "needs_reconciliation"].includes(
                      operation.status,
                    ) && (
                      <ReconcileBillingOperationAction operationId={operation.id} />
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
              <span className="builder-kicker">Refund history</span>
              <h2 className="card-title">Refunds</h2>
            </div>
          </div>
          {payment.refunds.length === 0 ? (
            <p className="card-empty-copy">No refund records yet.</p>
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
                  <span className={`badge badge-${refund.status}`}>
                    {refund.status}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card billing-section">
        <div className="card-heading-row">
          <div>
            <span className="builder-kicker">Timeline</span>
            <h2 className="card-title">Provider events</h2>
          </div>
          <span className="customer-section-note">Normalized events only</span>
        </div>
        {payment.events.length === 0 ? (
          <p className="card-empty-copy">No related provider events were found.</p>
        ) : (
          <div className="billing-timeline">
            {payment.events.map((event) => (
              <div className="billing-timeline-row" key={event.id}>
                <div className="customer-event-dot" aria-hidden="true" />
                <div>
                  <strong>{event.normalizedType}</strong>
                  <span>{event.providerEventName}</span>
                  <small>{formatDateTime(event.occurredAt)}</small>
                </div>
                <span className={`badge badge-${event.status}`}>{event.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </PageContainer>
  );
}
