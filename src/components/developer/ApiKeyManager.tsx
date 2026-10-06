"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/console";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

type ApiKey = {
  id: string;
  name: string;
  secretPrefix: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  revokedAt: Date | string | null;
};

type RevealedSecret = {
  title: string;
  secret: string;
  notice: string;
};

export function ApiKeyManager({
  keys,
  labels,
}: {
  keys: ApiKey[];
  labels: Dictionary["apiKeyManager"];
}) {
  const router = useRouter();
  const [name, setName] = useState(labels.keyNamePlaceholder);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);

  async function request(path: string, init: RequestInit) {
    setError(null);
    const response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init.headers },
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof body.error === "string" ? body.error : labels.requestFailed,
      );
    }
    return body;
  }

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    try {
      const body = await request("/api/admin/api-keys", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const key = body.key as { secret: string; name: string };
      setRevealed({
        title: formatMessage(labels.createdTitle, { name: key.name }),
        secret: key.secret,
        notice: String(body.notice ?? labels.storeNow),
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedCreate);
    } finally {
      setBusy(null);
    }
  }

  async function rotateKey(key: ApiKey) {
    setBusy(`rotate:${key.id}`);
    try {
      const body = await request(`/api/admin/api-keys/${key.id}/rotate`, {
        method: "POST",
      });
      const replacement = body.key as { secret: string; name: string };
      setRevealed({
        title: formatMessage(labels.rotatedTitle, { name: replacement.name }),
        secret: replacement.secret,
        notice: String(body.notice ?? labels.rotateNotice),
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedRotate);
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(key: ApiKey) {
    if (
      !window.confirm(formatMessage(labels.revokeConfirm, { name: key.name }))
    ) {
      return;
    }
    setBusy(`revoke:${key.id}`);
    try {
      await request(`/api/admin/api-keys/${key.id}`, { method: "DELETE" });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedRevoke);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="developer-stack">
      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>{labels.createTitle}</h2>
            <p>{labels.createDesc}</p>
          </div>
        </div>
        <form className="developer-inline-form" onSubmit={createKey}>
          <label className="filter-field">
            <span className="filter-field-label">{labels.keyName}</span>
            <input
              className="form-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={labels.keyNamePlaceholder}
              required
            />
          </label>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy === "create"}
          >
            {busy === "create" ? labels.creating : labels.createButton}
          </button>
        </form>
      </section>

      {revealed && (
        <section className="secret-reveal" aria-live="polite">
          <div>
            <strong>{revealed.title}</strong>
            <p>{revealed.notice}</p>
          </div>
          <code>{revealed.secret}</code>
          <div className="secret-reveal-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => navigator.clipboard.writeText(revealed.secret)}
            >
              {labels.copyOnce}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setRevealed(null)}
            >
              {labels.stored}
            </button>
          </div>
        </section>
      )}

      {error && (
        <div className="developer-error" role="alert">
          {error}
        </div>
      )}

      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>{labels.listTitle}</h2>
            <p>{labels.listDesc}</p>
          </div>
        </div>
        {keys.length ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{labels.thName}</th>
                  <th>{labels.thPrefix}</th>
                  <th>{labels.thLastUsed}</th>
                  <th>{labels.thStatus}</th>
                  <th aria-label={labels.thActions} />
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const revoked = Boolean(key.revokedAt);
                  return (
                    <tr key={key.id}>
                      <td>{key.name}</td>
                      <td className="cell-mono">{key.secretPrefix}…</td>
                      <td className="cell-muted">
                        {key.lastUsedAt
                          ? new Date(key.lastUsedAt).toLocaleString()
                          : labels.never}
                      </td>
                      <td>
                        <StatusBadge status={revoked ? "revoked" : "active"} />
                      </td>
                      <td>
                        {!revoked && (
                          <div className="developer-row-actions">
                            <button
                              className="btn btn-secondary"
                              type="button"
                              disabled={busy !== null}
                              onClick={() => rotateKey(key)}
                            >
                              {labels.rotate}
                            </button>
                            <button
                              className="btn btn-secondary"
                              type="button"
                              disabled={busy !== null}
                              onClick={() => revokeKey(key)}
                            >
                              {labels.revoke}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="developer-empty">{labels.empty}</div>
        )}
      </section>
    </div>
  );
}
