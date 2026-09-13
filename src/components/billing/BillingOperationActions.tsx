"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";

async function requestAction(url: string) {
  const response = await fetch(url, { method: "POST" });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "Billing operation failed");
  }
  return body;
}

type ConfirmActionProps = {
  title: string;
  description: string;
  triggerLabel: string;
  confirmLabel: string;
  endpoint: string;
  children?: ReactNode;
  danger?: boolean;
};

function ConfirmAction({
  title,
  description,
  triggerLabel,
  confirmLabel,
  endpoint,
  children,
  danger = false,
}: ConfirmActionProps) {
  const router = useRouter();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await requestAction(endpoint);
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Billing operation failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className={`btn btn-secondary${danger ? " billing-danger-button" : ""}`}
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {triggerLabel}
      </button>
      {open && (
        <div className="billing-action-backdrop">
          <section
            aria-labelledby={titleId}
            aria-modal="true"
            className="billing-action-dialog card"
            role="dialog"
          >
            <div>
              <span className="builder-kicker">Confirm billing operation</span>
              <h2 id={titleId}>{title}</h2>
              <p>{description}</p>
            </div>
            {children}
            {error && (
              <div className="billing-action-error" role="alert">
                {error}
              </div>
            )}
            <div className="billing-action-buttons">
              <button
                className="btn btn-secondary"
                disabled={pending}
                type="button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                type="button"
                onClick={() => void confirm()}
              >
                {pending ? "Working…" : confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function RefundPaymentAction({ paymentId }: { paymentId: string }) {
  return (
    <ConfirmAction
      danger
      title="Refund payment"
      description="Issue a full refund through the configured provider. MonetPlane records the operation before the provider call so any local persistence drift remains recoverable."
      triggerLabel="Refund payment"
      confirmLabel="Confirm full refund"
      endpoint={`/api/admin/payments/${encodeURIComponent(paymentId)}/refund`}
    />
  );
}

export function CancelSubscriptionAction({
  subscriptionId,
}: {
  subscriptionId: string;
}) {
  return (
    <ConfirmAction
      danger
      title="Cancel subscription"
      description="Cancel this subscription through its provider and reconcile the normalized result back into MonetPlane."
      triggerLabel="Cancel subscription"
      confirmLabel="Confirm cancellation"
      endpoint={`/api/admin/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`}
    />
  );
}

export function ReconcileBillingOperationAction({
  operationId,
}: {
  operationId: string;
}) {
  return (
    <ConfirmAction
      title="Reconcile operation"
      description="Reapply the already-recorded provider-normalized result to MonetPlane. This does not call the provider again."
      triggerLabel="Reconcile"
      confirmLabel="Reconcile local state"
      endpoint={`/api/admin/operations/${encodeURIComponent(operationId)}/reconcile`}
    />
  );
}
