"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";

async function requestAction(url: string, fallbackError: string) {
  const response = await fetch(url, { method: "POST" });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? fallbackError);
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
  labels: Dictionary["operationActions"];
};

function ConfirmAction({
  title,
  description,
  triggerLabel,
  confirmLabel,
  endpoint,
  children,
  danger = false,
  labels,
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
      await requestAction(endpoint, labels.failed);
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed);
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
              <span className="builder-kicker">{labels.confirmKicker}</span>
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
                {labels.cancel}
              </button>
              <button
                className="btn btn-primary"
                disabled={pending}
                type="button"
                onClick={() => void confirm()}
              >
                {pending ? labels.working : confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function RefundPaymentAction({
  paymentId,
  labels,
}: {
  paymentId: string;
  labels: Dictionary["operationActions"];
}) {
  return (
    <ConfirmAction
      danger
      title={labels.refundTitle}
      description={labels.refundDesc}
      triggerLabel={labels.refundTrigger}
      confirmLabel={labels.refundConfirm}
      endpoint={`/api/admin/payments/${encodeURIComponent(paymentId)}/refund`}
      labels={labels}
    />
  );
}

export function CancelSubscriptionAction({
  subscriptionId,
  labels,
}: {
  subscriptionId: string;
  labels: Dictionary["operationActions"];
}) {
  return (
    <ConfirmAction
      danger
      title={labels.cancelTitle}
      description={labels.cancelDesc}
      triggerLabel={labels.cancelTrigger}
      confirmLabel={labels.cancelConfirm}
      endpoint={`/api/admin/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`}
      labels={labels}
    />
  );
}

export function ReconcileBillingOperationAction({
  operationId,
  labels,
}: {
  operationId: string;
  labels: Dictionary["operationActions"];
}) {
  return (
    <ConfirmAction
      title={labels.reconcileTitle}
      description={labels.reconcileDesc}
      triggerLabel={labels.reconcileTrigger}
      confirmLabel={labels.reconcileConfirm}
      endpoint={`/api/admin/operations/${encodeURIComponent(operationId)}/reconcile`}
      labels={labels}
    />
  );
}

export function RetryBillingOperationAction({
  operationId,
  labels,
}: {
  operationId: string;
  labels: Dictionary["operationActions"];
}) {
  return (
    <ConfirmAction
      danger
      title={labels.retryTitle}
      description={labels.retryDesc}
      triggerLabel={labels.retryTrigger}
      confirmLabel={labels.retryConfirm}
      endpoint={`/api/admin/operations/${encodeURIComponent(operationId)}/retry`}
      labels={labels}
    />
  );
}
