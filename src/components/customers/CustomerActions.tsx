"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useId, useState } from "react";

type ActionDialogProps = {
  title: string;
  description: string;
  triggerLabel: string;
  triggerClassName?: string;
  confirmLabel: string;
  children?: ReactNode;
  onConfirm: () => Promise<void>;
};

function ActionDialog({
  title,
  description,
  triggerLabel,
  triggerClassName = "btn btn-secondary",
  confirmLabel,
  children,
  onConfirm,
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
      setError(cause instanceof Error ? cause.message : "Operation failed");
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
              <span className="customer-action-kicker">Confirm operation</span>
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
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={pending}
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

async function requestAction(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const result = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Operation failed");
  return result;
}

export function GrantCreditsAction({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [creditType, setCreditType] = useState("credits");
  const [amount, setAmount] = useState("100");
  const [note, setNote] = useState("");

  return (
    <ActionDialog
      title="Grant credits"
      description="This creates an admin adjustment in the immutable credit ledger. The resulting balance will be visible immediately."
      triggerLabel="Grant credits"
      confirmLabel="Confirm grant"
      onConfirm={async () => {
        const parsedAmount = Number(amount);
        if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
          throw new Error("Amount must be a positive whole number");
        }
        await requestAction(
          `/api/admin/customers/${encodeURIComponent(customerId)}/credits`,
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
          <span>Credit type</span>
          <input
            className="cell-mono"
            value={creditType}
            onChange={(event) =>
              setCreditType(event.target.value.toLowerCase())
            }
          />
        </label>
        <label className="field-group">
          <span>Amount</span>
          <input
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="field-group span-two">
          <span>Operator note</span>
          <textarea
            rows={2}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Why is this adjustment being made?"
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
}: {
  customerId: string;
  subscriptionId: string;
  label: string;
}) {
  const router = useRouter();
  return (
    <ActionDialog
      title="Cancel subscription"
      description={`Cancel ${label} through its configured payment provider. MonetPlane will apply the provider-neutral subscription state returned by the adapter.`}
      triggerLabel="Cancel subscription"
      triggerClassName="btn btn-secondary customer-danger-button"
      confirmLabel="Confirm cancellation"
      onConfirm={async () => {
        await requestAction(
          `/api/admin/customers/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
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
}: {
  customerId: string;
  paymentId: string;
  amountLabel: string;
}) {
  const router = useRouter();
  return (
    <ActionDialog
      title="Refund payment"
      description={`Issue a full ${amountLabel} refund through the configured provider. MonetPlane blocks unsafe credit-grant and subscription refunds in this workspace.`}
      triggerLabel="Refund"
      triggerClassName="btn btn-secondary customer-danger-button"
      confirmLabel="Confirm full refund"
      onConfirm={async () => {
        await requestAction(
          `/api/admin/customers/${encodeURIComponent(customerId)}/payments/${encodeURIComponent(paymentId)}/refund`,
          { method: "POST" },
        );
        router.refresh();
      }}
    />
  );
}
