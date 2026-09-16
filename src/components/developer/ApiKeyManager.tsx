"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

export function ApiKeyManager({ keys }: { keys: ApiKey[] }) {
  const router = useRouter();
  const [name, setName] = useState("Server key");
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
      throw new Error(typeof body.error === "string" ? body.error : "Request failed");
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
        title: `${key.name} created`,
        secret: key.secret,
        notice: String(body.notice ?? "Store this secret now."),
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create API key");
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
        title: `${replacement.name} replacement created`,
        secret: replacement.secret,
        notice: String(body.notice ?? "Deploy the replacement before revoking the old key."),
      });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to rotate API key");
    } finally {
      setBusy(null);
    }
  }

  async function revokeKey(key: ApiKey) {
    if (!window.confirm(`Revoke ${key.name}? Requests using this secret will stop working.`)) {
      return;
    }
    setBusy(`revoke:${key.id}`);
    try {
      await request(`/api/admin/api-keys/${key.id}`, { method: "DELETE" });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to revoke API key");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="developer-stack">
      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>Create server key</h2>
            <p>
              Keys authenticate server-to-server SDK calls. They are project-wide today and are not separated by Sandbox / Production until environment isolation is expanded.
            </p>
          </div>
        </div>
        <form className="developer-inline-form" onSubmit={createKey}>
          <label>
            <span>Key name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Production backend"
              required
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy === "create"}>
            {busy === "create" ? "Creating…" : "Create API key"}
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
              Copy once
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setRevealed(null)}>
              I stored it
            </button>
          </div>
        </section>
      )}

      {error && <div className="developer-error" role="alert">{error}</div>}

      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>Server keys</h2>
            <p>Only the prefix and usage metadata remain visible after creation.</p>
          </div>
        </div>
        {keys.length ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
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
                        {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "Never"}
                      </td>
                      <td>
                        <span className={`badge badge-${revoked ? "revoked" : "active"}`}>
                          {revoked ? "revoked" : "active"}
                        </span>
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
                              Rotate
                            </button>
                            <button
                              className="btn btn-secondary"
                              type="button"
                              disabled={busy !== null}
                              onClick={() => revokeKey(key)}
                            >
                              Revoke
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
          <div className="developer-empty">No API keys yet. Create one for your backend.</div>
        )}
      </section>
    </div>
  );
}
