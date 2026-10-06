"use client";

import { type FormEvent, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

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
  labels,
}: {
  connectionId: string;
  providerLabel: string;
  environment: "test" | "live";
  disabled: boolean;
  labels: Dictionary["providerDiagnostics"];
}) {
  const [kind, setKind] = useState<DiagnosticKind>("configuration");
  const [providerResourceId, setProviderResourceId] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const environmentLabel =
    environment === "test" ? labels.sandbox : labels.production;

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
        throw new Error(body.error ?? labels.failed);
      }
      setResult(body.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="card provider-diagnostic-card">
      <div className="card-heading-row">
        <div>
          <span className="provider-detail-kicker">{labels.kicker}</span>
          <h2 className="card-title">{labels.title}</h2>
        </div>
        <span className="provider-diagnostic-readonly">{labels.readOnly}</span>
      </div>

      <p className="provider-diagnostic-intro">
        {formatMessage(labels.intro, {
          provider: providerLabel,
          environment: environmentLabel,
        })}
      </p>

      {disabled ? (
        <div className="provider-runtime-warning">
          <strong>{labels.unavailableTitle}</strong>
          <span>{labels.unavailableDesc}</span>
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
              <strong>{labels.kindConfiguration}</strong>
              <span>{labels.kindConfigurationDesc}</span>
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
              <strong>{labels.kindPayment}</strong>
              <span>{labels.kindPaymentDesc}</span>
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
              <strong>{labels.kindSubscription}</strong>
              <span>{labels.kindSubscriptionDesc}</span>
            </button>
          </div>

          {kind !== "configuration" && (
            <label className="form-field provider-diagnostic-resource">
              <span className="form-label">
                {formatMessage(labels.resourceIdLabel, {
                  kind:
                    kind === "payment"
                      ? labels.kindPayment
                      : labels.kindSubscription,
                })}
              </span>
              <input
                className="form-input cell-mono"
                value={providerResourceId}
                onChange={(event) => setProviderResourceId(event.target.value)}
                placeholder={
                  kind === "payment"
                    ? labels.paymentPlaceholder
                    : labels.subscriptionPlaceholder
                }
                required
              />
              <span className="form-help">{labels.resourceHelp}</span>
            </label>
          )}

          <div className="provider-diagnostic-action-row">
            <div>
              <strong>
                {formatMessage(labels.boundaryTitle, {
                  environment: environmentLabel,
                })}
              </strong>
              <span>{labels.boundaryDesc}</span>
            </div>
            <button
              className="btn btn-secondary"
              type="submit"
              disabled={pending}
            >
              {pending ? labels.running : labels.runButton}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="provider-diagnostic-result is-error" role="alert">
          <strong>{labels.errorTitle}</strong>
          <span>{error}</span>
        </div>
      )}

      {result && (
        <output className="provider-diagnostic-result is-success">
          <div className="provider-diagnostic-result-heading">
            <div>
              <strong>{labels.passedTitle}</strong>
              <span>{result.summary}</span>
            </div>
            <time dateTime={result.checkedAt}>
              {new Date(result.checkedAt).toLocaleString()}
            </time>
          </div>

          {result.payment && (
            <dl className="provider-diagnostic-data">
              <div>
                <dt>{labels.dtStatus}</dt>
                <dd>{result.payment.status}</dd>
              </div>
              <div>
                <dt>{labels.dtProviderPayment}</dt>
                <dd className="cell-mono">
                  {result.payment.providerPaymentId}
                </dd>
              </div>
              <div>
                <dt>{labels.dtAmount}</dt>
                <dd>
                  {result.payment.amountMinor} {result.payment.currency}
                </dd>
              </div>
              <div>
                <dt>{labels.dtProviderCustomer}</dt>
                <dd className="cell-mono">
                  {result.payment.providerCustomerId ?? labels.notReturned}
                </dd>
              </div>
            </dl>
          )}

          {result.subscription && (
            <dl className="provider-diagnostic-data">
              <div>
                <dt>{labels.dtStatus}</dt>
                <dd>{result.subscription.status}</dd>
              </div>
              <div>
                <dt>{labels.dtProviderSubscription}</dt>
                <dd className="cell-mono">
                  {result.subscription.providerSubscriptionId}
                </dd>
              </div>
              <div>
                <dt>{labels.dtPeriodEnd}</dt>
                <dd>
                  {result.subscription.currentPeriodEnd ?? labels.notReturned}
                </dd>
              </div>
              <div>
                <dt>{labels.dtCancelAtPeriodEnd}</dt>
                <dd>
                  {result.subscription.cancelAtPeriodEnd
                    ? labels.yes
                    : labels.no}
                </dd>
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
