"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/console";

type Endpoint = {
  id: string;
  name: string;
  url: string;
  secretPrefix: string;
  eventTypes: string[];
  status: string;
  createdAt: Date | string;
};

type Delivery = {
  id: string;
  endpointId: string;
  endpointName: string | null;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  responseStatus: number | null;
  errorMessage: string | null;
  createdAt: Date | string;
  deliveredAt: Date | string | null;
};

type RevealedSecret = { title: string; secret: string; notice: string };

export function WebhookManager({
  endpoints,
  deliveries,
  environmentLabel,
}: {
  endpoints: Endpoint[];
  deliveries: Delivery[];
  environmentLabel: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("Backend events");
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState("*");
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
        typeof body.error === "string" ? body.error : "Request failed",
      );
    }
    return body;
  }

  async function createEndpoint(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    try {
      const body = await request("/api/admin/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name,
          url,
          eventTypes: eventTypes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }),
      });
      const endpoint = body.endpoint as { name: string; secret: string };
      setRevealed({
        title: `${endpoint.name} signing secret`,
        secret: endpoint.secret,
        notice: String(body.notice ?? "Store this secret now."),
      });
      setUrl("");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to create webhook",
      );
    } finally {
      setBusy(null);
    }
  }

  async function act(
    label: string,
    path: string,
    action: "test" | "rotate" | "disable" | "retry",
  ) {
    setBusy(label);
    try {
      const body = await request(path, {
        method: action === "disable" ? "DELETE" : "POST",
      });
      if (action === "rotate") {
        const endpoint = body.endpoint as { name: string; secret: string };
        setRevealed({
          title: `${endpoint.name} rotated secret`,
          secret: endpoint.secret,
          notice: String(
            body.notice ?? "Update the receiver before the next delivery.",
          ),
        });
      }
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Webhook action failed",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="developer-stack">
      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>Add {environmentLabel} endpoint</h2>
            <p>
              MonetPlane signs each POST with HMAC-SHA256. Production endpoints
              must use HTTPS; Sandbox may use HTTP for local testing.
            </p>
          </div>
        </div>
        <form className="webhook-create-grid" onSubmit={createEndpoint}>
          <label>
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label className="webhook-url-field">
            <span>Endpoint URL</span>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://api.example.com/webhooks/monetplane"
              required
            />
          </label>
          <label>
            <span>Events</span>
            <input
              value={eventTypes}
              onChange={(event) => setEventTypes(event.target.value)}
              placeholder="*, payment.succeeded"
            />
          </label>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy === "create"}
          >
            {busy === "create" ? "Adding…" : "Add endpoint"}
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
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setRevealed(null)}
            >
              I stored it
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
            <h2>Endpoints</h2>
            <p>
              Signing secrets are write-only after creation. Rotate only when
              the receiver can be updated immediately.
            </p>
          </div>
        </div>
        {endpoints.length ? (
          <div className="webhook-endpoint-list">
            {endpoints.map((endpoint) => (
              <article className="webhook-endpoint-card" key={endpoint.id}>
                <div>
                  <div className="webhook-endpoint-title">
                    <strong>{endpoint.name}</strong>
                    <StatusBadge status={endpoint.status} />
                  </div>
                  <code>{endpoint.url}</code>
                  <div className="webhook-endpoint-meta">
                    secret {endpoint.secretPrefix}… ·{" "}
                    {endpoint.eventTypes.join(", ")}
                  </div>
                </div>
                {endpoint.status === "active" && (
                  <div className="developer-row-actions">
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          `test:${endpoint.id}`,
                          `/api/admin/webhooks/${endpoint.id}/test`,
                          "test",
                        )
                      }
                    >
                      Send test
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          `rotate:${endpoint.id}`,
                          `/api/admin/webhooks/${endpoint.id}/rotate`,
                          "rotate",
                        )
                      }
                    >
                      Rotate secret
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        window.confirm(`Disable ${endpoint.name}?`) &&
                        act(
                          `disable:${endpoint.id}`,
                          `/api/admin/webhooks/${endpoint.id}`,
                          "disable",
                        )
                      }
                    >
                      Disable
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="developer-empty">
            No endpoint configured for this environment.
          </div>
        )}
      </section>

      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>Recent deliveries</h2>
            <p>
              Failures retain status, HTTP code, and a bounded error message.
              Response bodies are not stored.
            </p>
          </div>
        </div>
        {deliveries.length ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>HTTP</th>
                  <th>Created</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => (
                  <tr key={delivery.id}>
                    <td>
                      <div className="cell-mono">{delivery.eventType}</div>
                      <div className="cell-muted">{delivery.eventId}</div>
                    </td>
                    <td>{delivery.endpointName ?? delivery.endpointId}</td>
                    <td>
                      <StatusBadge status={delivery.status} />
                      {delivery.errorMessage && (
                        <div className="delivery-error-message">
                          {delivery.errorMessage}
                        </div>
                      )}
                    </td>
                    <td>{delivery.attemptCount}</td>
                    <td>{delivery.responseStatus ?? "—"}</td>
                    <td className="cell-muted">
                      {new Date(delivery.createdAt).toLocaleString()}
                    </td>
                    <td>
                      {delivery.status === "failed" && (
                        <button
                          className="btn btn-secondary"
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            act(
                              `retry:${delivery.id}`,
                              `/api/admin/webhooks/deliveries/${delivery.id}/retry`,
                              "retry",
                            )
                          }
                        >
                          Retry
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="developer-empty">
            No deliveries yet. Send a test to verify the receiver.
          </div>
        )}
      </section>
    </div>
  );
}
