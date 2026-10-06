"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

type ActionDialogProps = {
  title: string;
  description: string;
  triggerLabel: string;
  triggerClassName?: string;
  confirmLabel: string;
  children?: ReactNode;
  onConfirm: () => Promise<void>;
  labels: Dictionary["customerActions"];
};

function ActionDialog({
  title,
  description,
  triggerLabel,
  triggerClassName = "btn btn-secondary",
  confirmLabel,
  children,
  onConfirm,
  labels,
}: ActionDialogProps) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className={triggerClassName}
        type="button"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {triggerLabel}
      </button>
      {open && (
        <div className="customer-action-backdrop">
          <section
            aria-labelledby={titleId}
            aria-modal="true"
            className="customer-action-dialog card"
            role="dialog"
          >
            <div>
              <span className="customer-action-kicker">
                {labels.confirmKicker}
              </span>
              <h2 id={titleId}>{title}</h2>
              <p>{description}</p>
            </div>
            {children}
            {error && (
              <div className="customer-action-error" role="alert">
                {error}
              </div>
            )}
            <div className="customer-action-dialog-buttons">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                {labels.cancel}
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={pending}
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

async function requestAction(
  url: string,
  fallback: string,
  init?: RequestInit,
) {
  const response = await fetch(url, init);
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? fallback);
  return result;
}

export function GrantCreditsAction({
  customerId,
  labels,
}: {
  customerId: string;
  labels: Dictionary["customerActions"];
}) {
  const router = useRouter();
  const [creditType, setCreditType] = useState("credits");
  const [amount, setAmount] = useState("100");
  const [note, setNote] = useState("");

  return (
    <ActionDialog
      title={labels.grantTitle}
      description={labels.grantDesc}
      triggerLabel={labels.grantTrigger}
      confirmLabel={labels.grantConfirm}
      labels={labels}
      onConfirm={async () => {
        const parsedAmount = Number(amount);
        if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
          throw new Error(labels.grantAmountInvalid);
        }
        await requestAction(
          `/api/admin/customers/${encodeURIComponent(customerId)}/credits`,
          labels.failed,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ creditType, amount: parsedAmount, note }),
          },
        );
        router.refresh();
      }}
    >
      <div className="customer-action-fields">
        <label className="field-group">
          <span>{labels.creditType}</span>
          <input
            className="cell-mono"
            value={creditType}
            onChange={(event) =>
              setCreditType(event.target.value.toLowerCase())
            }
          />
        </label>
        <label className="field-group">
          <span>{labels.amount}</span>
          <input
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field-group span-two">
          <span>{labels.operatorNote}</span>
          <textarea
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={labels.operatorNotePlaceholder}
          />
        </label>
      </div>
    </ActionDialog>
  );
}

export function CancelSubscriptionAction({
  customerId,
  subscriptionId,
  label,
  labels,
}: {
  customerId: string;
  subscriptionId: string;
  label: string;
  labels: Dictionary["customerActions"];
}) {
  const router = useRouter();
  return (
    <ActionDialog
      title={labels.cancelTitle}
      description={formatMessage(labels.cancelDesc, { label })}
      triggerLabel={labels.cancelTrigger}
      triggerClassName="btn btn-secondary customer-danger-button"
      confirmLabel={labels.cancelConfirm}
      labels={labels}
      onConfirm={async () => {
        await requestAction(
          `/api/admin/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
          labels.failed,
          { method: "POST" },
        );
        router.refresh();
      }}
    />
  );
}

export function RefundPaymentAction({
  customerId,
  paymentId,
  amountLabel,
  labels,
}: {
  customerId: string;
  paymentId: string;
  amountLabel: string;
  labels: Dictionary["customerActions"];
}) {
  const router = useRouter();
  return (
    <ActionDialog
      title={labels.refundTitle}
      description={formatMessage(labels.refundDesc, { amount: amountLabel })}
      triggerLabel={labels.refundTrigger}
      triggerClassName="btn btn-secondary customer-danger-button"
      confirmLabel={labels.refundConfirm}
      labels={labels}
      onConfirm={async () => {
        await requestAction(
          `/api/admin/customers/${encodeURIComponent(customerId)}/payments/${encodeURIComponent(paymentId)}/refund`,
          labels.failed,
          { method: "POST" },
        );
        router.refresh();
      }}
    />
  );
}
