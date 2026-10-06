"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";
import { SUPPORTED_PROVIDER_SETUPS } from "@/modules/providers/setup";

type ProviderConnectFormProps = {
  projectName: string;
  environment: "test" | "live";
  /** Locale-resolved labels. */
  labels: Dictionary["providersNew"];
  connectLabels: Dictionary["providerConnect"];
};

type CreateProviderResponse = {
  connection?: {
    id: string;
    provider: string;
    name: string;
    mode: "test" | "live";
  };
  error?: string;
};

export function ProviderConnectForm({
  projectName,
  environment,
  labels,
  connectLabels,
}: ProviderConnectFormProps) {
  const router = useRouter();
  const environmentLabel =
    environment === "test" ? labels.sandboxFallback : labels.productionFallback;
  const [provider, setProvider] = useState("creem");
  const [name, setName] = useState(`Creem ${environmentLabel}`);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setup = useMemo(
    () =>
      SUPPORTED_PROVIDER_SETUPS.find((item) => item.provider === provider) ??
      SUPPORTED_PROVIDER_SETUPS[0],
    [provider],
  );

  function chooseProvider(nextProvider: string) {
    const next = SUPPORTED_PROVIDER_SETUPS.find(
      (item) => item.provider === nextProvider,
    );
    if (!next) return;
    setProvider(next.provider);
    setName(`${next.label} ${environmentLabel}`);
    setCredentials({});
    setError(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, name, credentials }),
      });
      const result = (await response.json()) as CreateProviderResponse;
      if (!response.ok || !result.connection) {
        throw new Error(result.error ?? labels.failed);
      }

      router.push("/providers");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failed);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="provider-connect-form" onSubmit={submit}>
      <section className="card provider-connect-section">
        <div className="project-form-heading">
          <span className="project-form-step">1</span>
          <div>
            <h2>{connectLabels.chooseTitle}</h2>
            <p>{connectLabels.chooseDesc}</p>
          </div>
        </div>

        <div className="provider-choice-grid">
          {SUPPORTED_PROVIDER_SETUPS.map((item) => {
            const selected = item.provider === provider;
            return (
              <button
                key={item.provider}
                className={`provider-choice-card${selected ? " is-selected" : ""}`}
                type="button"
                aria-pressed={selected}
                onClick={() => chooseProvider(item.provider)}
              >
                <span className="provider-choice-mark">
                  {item.label.slice(0, 1)}
                </span>
                <span className="provider-choice-copy">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <span className="provider-choice-check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="card provider-connect-section">
        <div className="project-form-heading">
          <span className="project-form-step">2</span>
          <div>
            <h2>{connectLabels.identityTitle}</h2>
            <p>
              {formatMessage(connectLabels.identityDesc, {
                application: projectName,
              })}
            </p>
          </div>
        </div>

        <div className="project-form-grid">
          <label className="form-field">
            <span className="form-label">{connectLabels.connectionName}</span>
            <input
              className="form-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${setup.label} ${environmentLabel}`}
              required
            />
            <span className="form-help">
              {connectLabels.connectionNameHelp}
            </span>
          </label>

          <div className="form-field">
            <span className="form-label">{connectLabels.environment}</span>
            <div className={`provider-environment-lock is-${environment}`}>
              <span className="provider-environment-dot" />
              <strong>{environmentLabel}</strong>
              <span>{environment === "test" ? "test" : "live"}</span>
            </div>
            <span className="form-help">{connectLabels.environmentHelp}</span>
          </div>
        </div>
      </section>

      <section className="card provider-connect-section">
        <div className="project-form-heading">
          <span className="project-form-step">3</span>
          <div>
            <h2>
              {formatMessage(connectLabels.configTitle, {
                provider: setup.label,
              })}
            </h2>
            <p>{connectLabels.configDesc}</p>
          </div>
        </div>

        <div className="provider-credential-grid">
          {setup.credentialFields.map((field) => (
            <label className="form-field" key={field.key}>
              <span className="form-label">{field.label}</span>
              <input
                className="form-input cell-mono"
                type={field.inputType}
                autoComplete={field.secret ? "new-password" : "off"}
                placeholder={field.placeholder}
                value={credentials[field.key] ?? ""}
                onChange={(event) =>
                  setCredentials((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
                required
              />
              <span className="form-help">{field.help}</span>
            </label>
          ))}
        </div>

        <div className="provider-secret-note">{connectLabels.secretNote}</div>
      </section>

      {error && (
        <div className="provider-connect-error" role="alert">
          {error}
        </div>
      )}

      <div className="provider-connect-actions">
        <Link href="/providers" className="btn btn-secondary">
          {connectLabels.cancel}
        </Link>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending
            ? labels.connecting
            : formatMessage(labels.connectAction, { provider: setup.label })}
        </button>
      </div>
    </form>
  );
}
