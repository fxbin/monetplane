"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { SUPPORTED_PROVIDER_SETUPS } from "@/modules/providers/setup";

type ProviderConnectFormProps = {
  projectName: string;
  environment: "test" | "live";
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
}: ProviderConnectFormProps) {
  const router = useRouter();
  const environmentLabel = environment === "test" ? "Sandbox" : "Production";
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
        throw new Error(result.error ?? "Failed to connect payment provider");
      }

      router.push("/providers");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to connect payment provider",
      );
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
            <h2>Choose provider</h2>
            <p>
              Connect one of the payment adapters already implemented by
              MonetPlane.
            </p>
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
            <h2>Connection identity</h2>
            <p>
              This connection belongs to {projectName} and the current console
              environment.
            </p>
          </div>
        </div>

        <div className="project-form-grid">
          <label className="form-field">
            <span className="form-label">Connection name</span>
            <input
              className="form-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${setup.label} ${environmentLabel}`}
              required
            />
            <span className="form-help">
              A human-readable label. The default includes the environment so a
              Sandbox and Production connection can coexist safely.
            </span>
          </label>

          <div className="form-field">
            <span className="form-label">Environment</span>
            <div className={`provider-environment-lock is-${environment}`}>
              <span className="provider-environment-dot" />
              <strong>{environmentLabel}</strong>
              <span>{environment === "test" ? "test" : "live"}</span>
            </div>
            <span className="form-help">
              Change Sandbox / Production from the top bar before creating a
              connection. The API does not accept a client-supplied mode.
            </span>
          </div>
        </div>
      </section>

      <section className="card provider-connect-section">
        <div className="project-form-heading">
          <span className="project-form-step">3</span>
          <div>
            <h2>{setup.label} connection config</h2>
            <p>
              Secrets and provider runtime configuration are encrypted before
              storage and are never returned by the provider list API.
            </p>
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

        <div className="provider-secret-note">
          MonetPlane stores an encrypted connection envelope. After creation the
          console only exposes field metadata, never persisted values.
        </div>
      </section>

      {error && (
        <div className="provider-connect-error" role="alert">
          {error}
        </div>
      )}

      <div className="provider-connect-actions">
        <Link href="/providers" className="btn btn-secondary">
          Cancel
        </Link>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Connecting…" : `Connect ${setup.label}`}
        </button>
      </div>
    </form>
  );
}
