"use client";

import { useState } from "react";

/**
 * Customer-initiated immediate cancellation (#71). The button is only
 * rendered when the provider connection claims subscription_cancel; the
 * server re-checks capability and session ownership on every call.
 */
export function CancelSubscriptionButton({
  token,
  subscriptionId,
}: {
  token: string;
  subscriptionId: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return <span className="portal-badge">Cancellation requested</span>;
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="portal-button portal-button-quiet"
        onClick={() => setConfirming(true)}
      >
        Cancel subscription
      </button>
    );
  }

  return (
    <div className="portal-confirm">
      <span className="portal-confirm-text">
        Cancel now? Access ends immediately.
      </span>
      <button
        type="button"
        className="portal-button portal-button-danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const response = await fetch("/api/portal/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token, subscriptionId }),
            });
            const body = (await response.json()) as Record<string, unknown>;
            if (!response.ok) {
              throw new Error(
                typeof body.error === "string"
                  ? body.error
                  : "Failed to cancel subscription",
              );
            }
            setDone(true);
            window.location.reload();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Failed");
            setBusy(false);
          }
        }}
      >
        {busy ? "Cancelling…" : "Confirm cancellation"}
      </button>
      <button
        type="button"
        className="portal-button portal-button-quiet"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Keep it
      </button>
      {error && <span className="portal-error">{error}</span>}
    </div>
  );
}
