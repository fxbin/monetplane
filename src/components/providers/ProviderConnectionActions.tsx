"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

type CredentialField = {
  key: string;
  label: string;
  help: string;
  placeholder: string;
  inputType: "password" | "text" | "url";
  secret: boolean;
};

type ProviderConnectionActionsProps = {
  connectionId: string;
  currentName: string;
  providerLabel: string;
  status: "active" | "revoked";
  credentialFields: CredentialField[];
  /** Locale-resolved labels. */
  labels: Dictionary["providerActions"];
};

type ActionResponse = {
  error?: string;
};

async function requestAction(
  url: string,
  fallbackError: string,
  init: RequestInit,
) {
  const response = await fetch(url, init);
  const result = (await response.json()) as ActionResponse;
  if (!response.ok) throw new Error(result.error ?? fallbackError);
  return result;
}

export function ProviderConnectionActions({
  connectionId,
  currentName,
  providerLabel,
  status,
  credentialFields,
  labels,
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
      <div className="provider-management-disabled">{labels.revokedNotice}</div>
    );
  }

  async function submitReconfigure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await requestAction(
        `/api/admin/providers/${encodeURIComponent(connectionId)}`,
        labels.failedUpdate,
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
      setError(cause instanceof Error ? cause.message : labels.failedUpdate);
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
        labels.failedRevoke,
        { method: "DELETE" },
      );
      setRevokeOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedRevoke);
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
          {labels.reconfigure}
        </button>
        <button
          className="btn btn-secondary provider-danger-button"
          type="button"
          onClick={() => {
            setError(null);
            setRevokeOpen(true);
          }}
        >
          {labels.revokeConnection}
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
              <span className="provider-action-kicker">
                {labels.settingsKicker}
              </span>
              <h2 id={reconfigureTitleId}>
                {formatMessage(labels.reconfigureTitle, {
                  provider: providerLabel,
                })}
              </h2>
              <p>{labels.reconfigureDesc}</p>
            </div>

            <label className="form-field">
              <span className="form-label">{labels.connectionName}</span>
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
                  <strong>{labels.replaceToggleTitle}</strong>
                  <small>{labels.replaceToggleDesc}</small>
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
                {labels.cancel}
              </button>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? labels.saving : labels.saveChanges}
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
                {labels.destructiveKicker}
              </span>
              <h2 id={revokeTitleId}>
                {formatMessage(labels.revokeTitle, { provider: providerLabel })}
              </h2>
              <p>{labels.revokeDesc}</p>
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
                {labels.keepConnection}
              </button>
              <button
                className="btn btn-secondary provider-danger-button"
                type="button"
                disabled={pending}
                onClick={() => void revoke()}
              >
                {pending ? labels.revoking : labels.confirmRevoke}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
