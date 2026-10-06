"use client";

import { useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";

/**
 * Customer-initiated immediate cancellation (#71). The button is only
 * rendered when the provider connection claims subscription_cancel; the
 * server re-checks capability and session ownership on every call.
 */
export function CancelSubscriptionButton({
  token,
  subscriptionId,
  labels,
}: {
  token: string;
  subscriptionId: string;
  labels: Dictionary["portal"];
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return <span className="portal-badge">{labels.cancelRequested}</span>;
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="portal-button portal-button-quiet"
        onClick={() => setConfirming(true)}
      >
        {labels.cancelSubscription}
      </button>
    );
  }

  return (
    <div className="portal-confirm">
      <span className="portal-confirm-text">{labels.cancelConfirmText}</span>
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
                  : labels.cancelFailed,
              );
            }
            setDone(true);
            window.location.reload();
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : labels.cancelError,
            );
            setBusy(false);
          }
        }}
      >
        {busy ? labels.cancelling : labels.cancelConfirm}
      </button>
      <button
        type="button"
        className="portal-button portal-button-quiet"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        {labels.keepIt}
      </button>
      {error && <span className="portal-error">{error}</span>}
    </div>
  );
}
