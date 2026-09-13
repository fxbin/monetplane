"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";

type CredentialField = {
  key: string;
  label: string;
  help: string;
};

type ProviderConnectionActionsProps = {
  connectionId: string;
  currentName: string;
  providerLabel: string;
  status: "active" | "revoked";
  credentialFields: CredentialField[];
};

type ActionResponse = {
  error?: string;
};

async function requestAction(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const result = (await response.json()) as ActionResponse;
  if (!response.ok)
    throw new Error(result.error ?? "Provider operation failed");
  return result;
}

export function ProviderConnectionActions({
  connectionId,
  currentName,
  providerLabel,
  status,
  credentialFields,
}: ProviderConnectionActionsProps) {
  const router = useRouter();
  const reconfigureTitleId = useId();
  const revokeTitleId = useId();
  const [reconfigureOpen, setReconfigureOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === "revoked") {
    return (
      <div className="provider-management-disabled">
        This connection is revoked. Its historical metadata remains available,
        but credentials and runtime operations are disabled.
      </div>
    );
  }

  async function submitReconfigure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await requestAction(
        `/api/admin/providers/${encodeURIComponent(connectionId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            ...(replaceCredentials ? { credentials } : {}),
          }),
        },
      );
      setReconfigureOpen(false);
      setReplaceCredentials(false);
      setCredentials({});
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to update provider connection",
      );
    } finally {
      setPending(false);
    }
  }

  async function revoke() {
    setPending(true);
    setError(null);
    try {
      await requestAction(
        `/api/admin/providers/${encodeURIComponent(connectionId)}`,
        { method: "DELETE" },
      );
      setRevokeOpen(false);
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to revoke provider connection",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="provider-management-actions">
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => {
            setError(null);
            setName(currentName);
            setReconfigureOpen(true);
          }}
        >
          Reconfigure
        </button>
        <button
          className="btn btn-secondary provider-danger-button"
          type="button"
          onClick={() => {
            setError(null);
            setRevokeOpen(true);
          }}
        >
          Revoke connection
        </button>
      </div>

      {reconfigureOpen && (
        <div className="provider-action-backdrop">
          <form
            className="provider-action-dialog card"
            aria-labelledby={reconfigureTitleId}
            aria-modal="true"
            role="dialog"
            onSubmit={submitReconfigure}
          >
            <div>
              <span className="provider-action-kicker">Provider settings</span>
              <h2 id={reconfigureTitleId}>Reconfigure {providerLabel}</h2>
              <p>
                Rename this connection or replace its complete credential set.
                Existing secret values are never revealed.
              </p>
            </div>

            <label className="form-field">
              <span className="form-label">Connection name</span>
              <input
                className="form-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>

            {credentialFields.length > 0 && (
              <label className="provider-replace-toggle">
                <input
                  type="checkbox"
                  checked={replaceCredentials}
                  onChange={(event) => {
                    setReplaceCredentials(event.target.checked);
                    setCredentials({});
                    setError(null);
                  }}
                />
                <span>
                  <strong>Replace credentials</strong>
                  <small>
                    Supply every required field. Leaving this off keeps the
                    encrypted credential envelope unchanged.
                  </small>
                </span>
              </label>
            )}

            {replaceCredentials && (
              <div className="provider-reconfigure-credentials">
                {credentialFields.map((field) => (
                  <label className="form-field" key={field.key}>
                    <span className="form-label">{field.label}</span>
                    <input
                      className="form-input cell-mono"
                      type="password"
                      autoComplete="new-password"
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
            )}

            {error && (
              <div className="provider-connect-error" role="alert">
                {error}
              </div>
            )}

            <div className="provider-action-buttons">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={pending}
                onClick={() => setReconfigureOpen(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}

      {revokeOpen && (
        <div className="provider-action-backdrop">
          <section
            className="provider-action-dialog card"
            aria-labelledby={revokeTitleId}
            aria-modal="true"
            role="dialog"
          >
            <div>
              <span className="provider-action-kicker">
                Destructive operation
              </span>
              <h2 id={revokeTitleId}>Revoke {providerLabel} connection?</h2>
              <p>
                New runtime operations will stop using this connection.
                Historical payments, subscriptions, and audit records remain
                intact.
              </p>
            </div>

            {error && (
              <div className="provider-connect-error" role="alert">
                {error}
              </div>
            )}

            <div className="provider-action-buttons">
              <button
                className="btn btn-secondary"
                type="button"
                disabled={pending}
                onClick={() => setRevokeOpen(false)}
              >
                Keep connection
              </button>
              <button
                className="btn btn-secondary provider-danger-button"
                type="button"
                disabled={pending}
                onClick={() => void revoke()}
              >
                {pending ? "Revoking…" : "Confirm revoke"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
