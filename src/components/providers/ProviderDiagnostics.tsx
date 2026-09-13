"use client";

import { type FormEvent, useState } from "react";

type DiagnosticKind = "configuration" | "payment" | "subscription";

type CapabilityRow = {
  key: string;
  supported: boolean;
};

type DiagnosticResult = {
  kind: DiagnosticKind;
  status: "passed";
  checkedAt: string;
  provider: string;
  connectionId: string;
  environment: "test" | "live";
  summary: string;
  capabilities?: CapabilityRow[];
  payment?: {
    providerPaymentId: string;
    status: string;
    amountMinor: number;
    currency: string;
    providerCustomerId?: string;
  };
  subscription?: {
    providerSubscriptionId: string;
    status: string;
    providerCustomerId?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd: boolean;
  };
};

type DiagnosticResponse = {
  result?: DiagnosticResult;
  error?: string;
  code?: string;
};

export function ProviderDiagnostics({
  connectionId,
  providerLabel,
  environment,
  disabled,
}: {
  connectionId: string;
  providerLabel: string;
  environment: "test" | "live";
  disabled: boolean;
}) {
  const [kind, setKind] = useState<DiagnosticKind>("configuration");
  const [providerResourceId, setProviderResourceId] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const environmentLabel = environment === "test" ? "Sandbox" : "Production";

  async function runDiagnostic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch(
        `/api/admin/providers/${encodeURIComponent(connectionId)}/diagnostics`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind,
            ...(kind === "configuration"
              ? {}
              : { providerResourceId: providerResourceId.trim() }),
          }),
        },
      );
      const body = (await response.json()) as DiagnosticResponse;
      if (!response.ok || !body.result) {
        throw new Error(body.error ?? "Provider diagnostic failed");
      }
      setResult(body.result);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Provider diagnostic failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card provider-diagnostic-card">
      <div className="card-heading-row">
        <div>
          <span className="provider-detail-kicker">Diagnostics</span>
          <h2 className="card-title">Runtime verification</h2>
        </div>
        <span className="provider-diagnostic-readonly">Read-only</span>
      </div>

      <p className="provider-diagnostic-intro">
        Verify the real {providerLabel} adapter and this {environmentLabel}
        credential boundary without creating a checkout, refund, cancellation,
        or other provider mutation.
      </p>

      {disabled ? (
        <div className="provider-runtime-warning">
          <strong>Diagnostics unavailable</strong>
          <span>
            Revoked connections cannot decrypt credentials or execute provider
            runtime probes.
          </span>
        </div>
      ) : (
        <form className="provider-diagnostic-form" onSubmit={runDiagnostic}>
          <div className="provider-diagnostic-kind-grid">
            <button
              className={`provider-diagnostic-kind${kind === "configuration" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={kind === "configuration"}
              onClick={() => {
                setKind("configuration");
                setResult(null);
                setError(null);
              }}
            >
              <strong>Configuration</strong>
              <span>
                Resolve adapter, decrypt credentials, inspect capabilities.
              </span>
            </button>
            <button
              className={`provider-diagnostic-kind${kind === "payment" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={kind === "payment"}
              onClick={() => {
                setKind("payment");
                setResult(null);
                setError(null);
              }}
            >
              <strong>Payment lookup</strong>
              <span>Query one provider payment and normalize its state.</span>
            </button>
            <button
              className={`provider-diagnostic-kind${kind === "subscription" ? " is-selected" : ""}`}
              type="button"
              aria-pressed={kind === "subscription"}
              onClick={() => {
                setKind("subscription");
                setResult(null);
                setError(null);
              }}
            >
              <strong>Subscription lookup</strong>
              <span>Query one provider subscription without changing it.</span>
            </button>
          </div>

          {kind !== "configuration" && (
            <label className="form-field provider-diagnostic-resource">
              <span className="form-label">
                Provider {kind === "payment" ? "payment" : "subscription"} ID
              </span>
              <input
                className="form-input cell-mono"
                value={providerResourceId}
                onChange={(event) => setProviderResourceId(event.target.value)}
                placeholder={
                  kind === "payment"
                    ? "Provider payment / order ID"
                    : "Provider subscription ID"
                }
                required
              />
              <span className="form-help">
                Use the provider-native ID. The probe performs a read-only lookup
                through the same production runtime adapter used by MonetPlane.
              </span>
            </label>
          )}

          <div className="provider-diagnostic-action-row">
            <div>
              <strong>{environmentLabel} boundary</strong>
              <span>
                The API refuses connections from the other console environment.
              </span>
            </div>
            <button
              className="btn btn-secondary"
              type="submit"
              disabled={pending}
            >
              {pending ? "Running…" : "Run diagnostic"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="provider-diagnostic-result is-error" role="alert">
          <strong>Diagnostic failed</strong>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <output className="provider-diagnostic-result is-success">
          <div className="provider-diagnostic-result-heading">
            <div>
              <strong>Diagnostic passed</strong>
              <span>{result.summary}</span>
            </div>
            <time dateTime={result.checkedAt}>
              {new Date(result.checkedAt).toLocaleString()}
            </time>
          </div>

          {result.payment && (
            <dl className="provider-diagnostic-data">
              <div>
                <dt>Status</dt>
                <dd>{result.payment.status}</dd>
              </div>
              <div>
                <dt>Provider payment</dt>
                <dd className="cell-mono">{result.payment.providerPaymentId}</dd>
              </div>
              <div>
                <dt>Amount (minor units)</dt>
                <dd>
                  {result.payment.amountMinor} {result.payment.currency}
                </dd>
              </div>
              <div>
                <dt>Provider customer</dt>
                <dd className="cell-mono">
                  {result.payment.providerCustomerId ?? "Not returned"}
                </dd>
              </div>
            </dl>
          )}

          {result.subscription && (
            <dl className="provider-diagnostic-data">
              <div>
                <dt>Status</dt>
                <dd>{result.subscription.status}</dd>
              </div>
              <div>
                <dt>Provider subscription</dt>
                <dd className="cell-mono">
                  {result.subscription.providerSubscriptionId}
                </dd>
              </div>
              <div>
                <dt>Current period end</dt>
                <dd>{result.subscription.currentPeriodEnd ?? "Not returned"}</dd>
              </div>
              <div>
                <dt>Cancel at period end</dt>
                <dd>{result.subscription.cancelAtPeriodEnd ? "Yes" : "No"}</dd>
              </div>
            </dl>
          )}

          {result.capabilities && (
            <div className="provider-diagnostic-capabilities">
              {result.capabilities.map((capability) => (
                <span
                  className={capability.supported ? "is-supported" : ""}
                  key={capability.key}
                >
                  {capability.supported ? "✓" : "—"} {capability.key}
                </span>
              ))}
            </div>
          )}
        </output>
      )}
    </section>
  );
}
