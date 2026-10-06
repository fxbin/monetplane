"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/console";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

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
  labels,
}: {
  endpoints: Endpoint[];
  deliveries: Delivery[];
  environmentLabel: string;
  labels: Dictionary["webhookManager"];
}) {
  const router = useRouter();
  const [name, setName] = useState(labels.namePlaceholder);
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
        typeof body.error === "string" ? body.error : labels.requestFailed,
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
        notice: String(body.notice ?? labels.storeNow),
      });
      setUrl("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.failedCreate);
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
          title: formatMessage(labels.rotatedTitle, { name: endpoint.name }),
          secret: endpoint.secret,
          notice: String(body.notice ?? labels.rotateNotice),
        });
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.actionFailed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="developer-stack">
      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>
              {formatMessage(labels.addTitle, {
                environment: environmentLabel,
              })}
            </h2>
            <p>{labels.addDesc}</p>
          </div>
        </div>
        <form className="webhook-create-grid" onSubmit={createEndpoint}>
          <label className="filter-field">
            <span className="filter-field-label">{labels.name}</span>
            <input
              className="form-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label className="webhook-url-field filter-field">
            <span className="filter-field-label">{labels.endpointUrl}</span>
            <input
              className="form-input"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://api.example.com/webhooks/monetplane"
              required
            />
          </label>
          <label className="filter-field">
            <span className="filter-field-label">{labels.events}</span>
            <input
              className="form-input"
              value={eventTypes}
              onChange={(event) => setEventTypes(event.target.value)}
              placeholder={labels.eventsPlaceholder}
            />
          </label>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy === "create"}
          >
            {busy === "create" ? labels.adding : labels.addButton}
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
            <h2>{labels.endpointsTitle}</h2>
            <p>{labels.endpointsDesc}</p>
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
                      {labels.sendTest}
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
                      {labels.rotateSecret}
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      disabled={busy !== null}
                      onClick={() =>
                        window.confirm(
                          formatMessage(labels.disableConfirm, {
                            name: endpoint.name,
                          }),
                        ) &&
                        act(
                          `disable:${endpoint.id}`,
                          `/api/admin/webhooks/${endpoint.id}`,
                          "disable",
                        )
                      }
                    >
                      {labels.disable}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="developer-empty">{labels.endpointsEmpty}</div>
        )}
      </section>

      <section className="developer-panel">
        <div className="developer-panel-heading">
          <div>
            <h2>{labels.deliveriesTitle}</h2>
            <p>{labels.deliveriesDesc}</p>
          </div>
        </div>
        {deliveries.length ? (
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{labels.thEvent}</th>
                  <th>{labels.thEndpoint}</th>
                  <th>{labels.thStatus}</th>
                  <th>{labels.thAttempts}</th>
                  <th>{labels.thHttp}</th>
                  <th>{labels.thCreated}</th>
                  <th aria-label={labels.thActions} />
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
                          {labels.retry}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="developer-empty">{labels.deliveriesEmpty}</div>
        )}
      </section>
    </div>
  );
}
