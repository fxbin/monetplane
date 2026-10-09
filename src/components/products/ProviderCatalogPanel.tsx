"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

type CatalogLinkPriceOption = {
  id: string;
  label: string;
};

type CatalogLinkMappingView = {
  monetplanePriceId: string;
  providerConnectionId: string;
  /** Null while a provisioning intent (#156) has no external product yet. */
  providerProductId: string | null;
  source: string;
  status: string;
  lastVerifiedLabel: string | null;
};

type CatalogLinkConnection = {
  id: string;
  name: string;
  provider: string;
};

type CatalogMismatch = {
  field: string;
  monetplane: string;
  provider: string;
};

type CatalogLinkPreview = {
  providerProductId: string;
  product: {
    name: string | null;
    status: string;
    mode: string;
    billingType: string;
    amountMinor: number;
    currency: string;
  } | null;
  match: { ok: boolean; mismatches: CatalogMismatch[] };
  legacyProviderProductId: string | null;
};

type ProviderCatalogPanelProps = {
  applicationName: string;
  environment: "test" | "live";
  /** Product's routed provider connection for this environment. */
  connection: CatalogLinkConnection | null;
  prices: CatalogLinkPriceOption[];
  mappings: CatalogLinkMappingView[];
  labels: Dictionary["catalogLink"];
};

function fieldLabel(labels: Dictionary["catalogLink"], field: string): string {
  switch (field) {
    case "currency":
      return labels.fieldCurrency;
    case "amountMinor":
      return labels.fieldAmountMinor;
    case "billingType":
      return labels.fieldBillingType;
    case "billingInterval":
      return labels.fieldBillingInterval;
    case "mode":
      return labels.fieldMode;
    case "status":
      return labels.fieldStatus;
    default:
      return field;
  }
}

function statusLabel(
  labels: Dictionary["catalogLink"],
  status: string,
): string {
  switch (status) {
    case "unconfigured":
      return labels.statusNotConfigured;
    case "synced":
      return labels.statusSynced;
    case "pending":
      return labels.statusPending;
    case "creating":
      return labels.statusCreating;
    case "needs_reconciliation":
      return labels.statusNeedsReconciliation;
    case "failed":
      return labels.statusFailed;
    default:
      return status;
  }
}

function sourceLabel(
  labels: Dictionary["catalogLink"],
  source: string,
): string {
  return source === "created" ? labels.sourceCreated : labels.sourceLinked;
}

/**
 * Unified provider catalog panel (#157): one place per price to create the
 * provider product, link an existing one, or recover an uncertain intent —
 * with the sync state always visible and blind retry structurally absent.
 */
export function ProviderCatalogPanel({
  applicationName,
  environment,
  connection,
  prices,
  mappings,
  labels,
}: ProviderCatalogPanelProps) {
  const router = useRouter();
  const [priceId, setPriceId] = useState(prices[0]?.id ?? "");
  const [providerProductId, setProviderProductId] = useState("");
  const [verification, setVerification] = useState<{
    environment: "test" | "live";
    connectionId: string;
    priceId: string;
    providerProductId: string;
    preview: CatalogLinkPreview;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [linking, setLinking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [failing, setFailing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const verifyAbort = useRef<AbortController | null>(null);
  const identityRef = useRef("");
  identityRef.current = `${environment}:${connection?.id ?? "none"}`;

  const environmentNoun =
    environment === "test" ? labels.sandbox : labels.production;

  // Scope by both price and the routed connection so the state shown is
  // always THIS connection's mapping for the selected price.
  const mappingForPrice = connection
    ? mappings.find(
        (mapping) =>
          mapping.monetplanePriceId === priceId &&
          mapping.providerConnectionId === connection.id,
      )
    : undefined;
  const mappingStatus = mappingForPrice?.status ?? "unconfigured";

  const verificationIsCurrent =
    verification !== null &&
    verification.environment === environment &&
    verification.connectionId === connection?.id &&
    verification.priceId === priceId &&
    verification.providerProductId === providerProductId.trim();

  const canLink =
    Boolean(verificationIsCurrent && verification?.preview.match.ok) &&
    !linking;

  /**
   * Production writes need a deliberate confirmation — creating or
   * binding a REAL provider product is an external, money-adjacent act.
   */
  function confirmLiveAction(): boolean {
    if (environment !== "live") return true;
    return window.confirm(labels.liveConfirm);
  }

  function invalidateVerification() {
    verifyAbort.current?.abort();
    verifyAbort.current = null;
    setVerifying(false);
    setVerification(null);
    setMessage(null);
  }

  async function verify() {
    if (!connection || !priceId || !providerProductId.trim()) return;
    verifyAbort.current?.abort();
    const controller = new AbortController();
    verifyAbort.current = controller;
    const requestIdentity = identityRef.current;
    setVerifying(true);
    setMessage(null);
    setVerification(null);
    try {
      const response = await fetch(
        "/api/admin/providers/catalog-links/preview",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: connection.id,
            priceId,
            providerProductId: providerProductId.trim(),
          }),
          signal: controller.signal,
        },
      );
      const result = (await response.json()) as {
        error?: string;
        preview?: CatalogLinkPreview;
      };
      if (controller.signal.aborted) return;
      if (!response.ok || !result.preview) {
        if (identityRef.current === requestIdentity) {
          setMessage(result.error ?? labels.mismatchTitle);
        }
        return;
      }
      if (identityRef.current !== requestIdentity) return;
      setVerification({
        environment,
        connectionId: connection.id,
        priceId,
        providerProductId: providerProductId.trim(),
        preview: result.preview,
      });
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (identityRef.current === requestIdentity) {
        setMessage(
          cause instanceof Error ? cause.message : labels.mismatchTitle,
        );
      }
    } finally {
      if (verifyAbort.current === controller) {
        verifyAbort.current = null;
        setVerifying(false);
      }
    }
  }

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canLink) return;
    if (!confirmLiveAction()) return;
    setLinking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/providers/catalog-links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: connection?.id,
          priceId,
          providerProductId: providerProductId.trim(),
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        outcome?: string;
        mapping?: { providerProductId: string };
      };
      if (!response.ok) {
        throw new Error(result.error ?? labels.mismatchTitle);
      }
      setMessage(
        result.outcome === "already_linked"
          ? labels.reverified
          : result.outcome === "recovered"
            ? labels.recovered
            : formatMessage(labels.linked, {
                productId: result.mapping?.providerProductId ?? "",
              }),
      );
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : labels.mismatchTitle);
    } finally {
      setLinking(false);
    }
  }

  async function createInProvider() {
    if (!connection || !priceId || creating) return;
    if (!confirmLiveAction()) return;
    setCreating(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/providers/catalog-products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connectionId: connection.id,
          priceId,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        outcome?: string;
        providerProductId?: string;
      };
      if (!response.ok) {
        throw new Error(result.error ?? labels.createFailed);
      }
      setMessage(
        result.outcome === "already_synced"
          ? labels.reverified
          : formatMessage(labels.createdAndLinked, {
              productId: result.providerProductId ?? "",
            }),
      );
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : labels.createFailed);
    } finally {
      setCreating(false);
    }
  }

  async function markFailedForRetry() {
    if (!connection || !priceId || failing) return;
    setFailing(true);
    setMessage(null);
    try {
      const response = await fetch(
        "/api/admin/providers/catalog-products/fail-intent",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            connectionId: connection.id,
            priceId,
          }),
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? labels.createFailed);
      }
      setMessage(labels.markedFailedRetryable);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : labels.createFailed);
    } finally {
      setFailing(false);
    }
  }

  const showLinkForm =
    Boolean(connection && priceId) &&
    (mappingStatus === "unconfigured" ||
      mappingStatus === "needs_reconciliation" ||
      mappingStatus === "failed");
  const showCreate =
    Boolean(connection && priceId) &&
    (mappingStatus === "unconfigured" || mappingStatus === "failed");

  return (
    <section className="catalog-link-panel">
      <h3>{formatMessage(labels.kicker, { environment: environmentNoun })}</h3>
      <p className="catalog-link-title">{labels.title}</p>
      <p className="catalog-link-description">{labels.description}</p>

      <div className="catalog-link-context">
        <span>
          {labels.applicationLabel}: <strong>{applicationName}</strong>
        </span>
        <span>
          {labels.environmentLabel}: <strong>{environmentNoun}</strong>
        </span>
        {connection && (
          <span>
            {labels.connectionLabel}: <strong>{connection.name}</strong>{" "}
            <code>{connection.provider}</code>
          </span>
        )}
      </div>

      {prices.length === 0 ? (
        <p>{labels.noPrice}</p>
      ) : !connection ? (
        <p>
          {formatMessage(labels.noConnection, {
            environment: environmentNoun,
          })}
        </p>
      ) : (
        <>
          <label className="field-group">
            <span>{labels.priceLabel}</span>
            <select
              value={priceId}
              onChange={(event) => {
                setPriceId(event.target.value);
                invalidateVerification();
              }}
            >
              {prices.map((price) => (
                <option key={price.id} value={price.id}>
                  {price.label}
                </option>
              ))}
            </select>
          </label>

          <div className="catalog-link-current">
            <span className="catalog-link-current-title">
              {labels.currentTitle}
            </span>
            <span className={`catalog-status catalog-status-${mappingStatus}`}>
              {statusLabel(labels, mappingStatus)}
            </span>
            {mappingForPrice ? (
              <>
                <code>{mappingForPrice.providerProductId ?? "—"}</code>
                <span>
                  {formatMessage(labels.currentDetail, {
                    source: sourceLabel(labels, mappingForPrice.source),
                    status: statusLabel(labels, mappingForPrice.status),
                  })}
                </span>
                {mappingForPrice.lastVerifiedLabel && (
                  <span>
                    {formatMessage(labels.currentSince, {
                      date: mappingForPrice.lastVerifiedLabel,
                    })}
                  </span>
                )}
              </>
            ) : (
              <span>
                {formatMessage(labels.noMapping, {
                  environment: environmentNoun,
                })}
              </span>
            )}
          </div>

          {mappingStatus === "synced" && (
            <p className="catalog-link-empty">{labels.syncedNote}</p>
          )}
          {(mappingStatus === "pending" || mappingStatus === "creating") && (
            <p className="catalog-link-empty">{labels.inFlightNote}</p>
          )}
          {mappingStatus === "needs_reconciliation" && (
            <div className="catalog-link-recovery">
              <strong>{labels.needsAttentionTitle}</strong>
              <p>{labels.needsAttentionBody}</p>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={markFailedForRetry}
                disabled={failing || creating}
              >
                {failing ? labels.markingFailed : labels.markFailedForRetry}
              </button>
            </div>
          )}

          {showCreate && (
            <button
              type="button"
              className="btn btn-primary catalog-create-btn"
              onClick={createInProvider}
              disabled={creating}
            >
              {creating
                ? labels.creating
                : formatMessage(labels.createInProvider, {
                    provider: connection.provider,
                  })}
            </button>
          )}

          {showLinkForm && (
            <form className="catalog-link-form" onSubmit={link}>
              {mappingStatus !== "unconfigured" && (
                <p className="catalog-link-form-hint">{labels.adoptHint}</p>
              )}
              <label className="field-group">
                <span>{labels.productLabel}</span>
                <input
                  value={providerProductId}
                  placeholder={labels.productPlaceholder}
                  onChange={(event) => {
                    setProviderProductId(event.target.value);
                    invalidateVerification();
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={verify}
                disabled={
                  verifying || linking || creating || !providerProductId.trim()
                }
              >
                {verifying ? labels.verifying : labels.verify}
              </button>

              {verificationIsCurrent && verification && (
                <div className="catalog-link-preview">
                  {verification.preview.match.ok ? (
                    <>
                      <p>{labels.matchOk}</p>
                      {verification.preview.product && (
                        <p>
                          {formatMessage(labels.providerSummary, {
                            currency: verification.preview.product.currency,
                            amountMinor: String(
                              verification.preview.product.amountMinor,
                            ),
                            billingType:
                              verification.preview.product.billingType,
                            status: verification.preview.product.status,
                          })}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <p>{labels.mismatchTitle}</p>
                      <ul>
                        {verification.preview.match.mismatches.map(
                          (mismatch) => (
                            <li key={mismatch.field}>
                              {fieldLabel(labels, mismatch.field)}:{" "}
                              {mismatch.monetplane} ≠ {mismatch.provider}
                            </li>
                          ),
                        )}
                      </ul>
                    </>
                  )}
                  {verification.preview.legacyProviderProductId && (
                    <p>
                      {formatMessage(labels.legacyNote, {
                        productId: verification.preview.legacyProviderProductId,
                      })}
                    </p>
                  )}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={!canLink}
              >
                {linking ? labels.linking : labels.link}
              </button>
            </form>
          )}

          {message && <span className="catalog-link-message">{message}</span>}
        </>
      )}
    </section>
  );
}
