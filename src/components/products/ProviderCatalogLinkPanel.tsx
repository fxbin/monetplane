"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

type CatalogLinkPriceOption = {
  id: string;
  label: string;
};

type CatalogLinkMappingView = {
  monetplanePriceId: string;
  providerConnectionId: string;
  providerProductId: string;
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

type ProviderCatalogLinkPanelProps = {
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
 * Console "link existing provider product" flow (#155): two-step, verify
 * first — the confirm button only unlocks after a read-only provider
 * comparison succeeded for the exact price + product ID pair.
 */
export function ProviderCatalogLinkPanel({
  environment,
  connection,
  prices,
  mappings,
  labels,
}: ProviderCatalogLinkPanelProps) {
  const router = useRouter();
  const [priceId, setPriceId] = useState(prices[0]?.id ?? "");
  const [providerProductId, setProviderProductId] = useState("");
  const [preview, setPreview] = useState<CatalogLinkPreview | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const environmentNoun =
    environment === "test" ? labels.sandbox : labels.production;

  // Scope by both price and the routed connection so the "current
  // mapping" never shows another same-environment connection's row.
  const mappingForPrice = connection
    ? mappings.find(
        (mapping) =>
          mapping.monetplanePriceId === priceId &&
          mapping.providerConnectionId === connection.id,
      )
    : undefined;

  // Confirm only the exact pair that was just verified.
  const verifiedPair = preview?.match.ok
    ? `${priceId}:${preview.providerProductId}`
    : null;
  const canLink =
    Boolean(
      verifiedPair && providerProductId.trim() === preview?.providerProductId,
    ) && !linking;

  async function callCatalogLinks(
    path: string,
  ): Promise<{ ok: boolean; error?: string; preview?: CatalogLinkPreview }> {
    const response = await fetch(`/api/admin/providers/catalog-links${path}`, {
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
      preview?: CatalogLinkPreview;
    };
    if (!response.ok) {
      return { ok: false, error: result.error ?? labels.verify };
    }
    return { ok: true, preview: result.preview };
  }

  async function verify() {
    if (!connection || !priceId || !providerProductId.trim()) return;
    setVerifying(true);
    setMessage(null);
    setPreview(null);
    try {
      const result = await callCatalogLinks("/preview");
      if (!result.ok || !result.preview) {
        setMessage(result.error ?? labels.mismatchTitle);
        return;
      }
      setPreview(result.preview);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : labels.mismatchTitle);
    } finally {
      setVerifying(false);
    }
  }

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canLink) return;
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

  return (
    <section className="catalog-link-panel">
      <h3>{formatMessage(labels.kicker, { environment: environmentNoun })}</h3>
      <p className="catalog-link-title">{labels.title}</p>
      <p className="catalog-link-description">{labels.description}</p>

      {mappingForPrice ? (
        <div className="catalog-link-current">
          <span className="catalog-link-current-title">
            {labels.currentTitle}
          </span>
          <code>{mappingForPrice.providerProductId}</code>
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
        </div>
      ) : (
        priceId && (
          <p className="catalog-link-empty">
            {formatMessage(labels.noMapping, { environment: environmentNoun })}
          </p>
        )
      )}

      {prices.length === 0 ? (
        <p>{labels.noPrice}</p>
      ) : !connection ? (
        <p>
          {formatMessage(labels.noConnection, {
            environment: environmentNoun,
          })}
        </p>
      ) : (
        <form className="catalog-link-form" onSubmit={link}>
          <label className="field-group">
            <span>{labels.priceLabel}</span>
            <select
              value={priceId}
              onChange={(event) => {
                setPriceId(event.target.value);
                setPreview(null);
                setMessage(null);
              }}
            >
              {prices.map((price) => (
                <option key={price.id} value={price.id}>
                  {price.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field-group">
            <span>{labels.productLabel}</span>
            <input
              value={providerProductId}
              placeholder={labels.productPlaceholder}
              onChange={(event) => {
                setProviderProductId(event.target.value);
                setPreview(null);
                setMessage(null);
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={verify}
            disabled={
              verifying || linking || !providerProductId.trim() || !priceId
            }
          >
            {verifying ? labels.verifying : labels.verify}
          </button>

          {preview && (
            <div className="catalog-link-preview">
              {preview.match.ok ? (
                <>
                  <p>{labels.matchOk}</p>
                  {preview.product && (
                    <p>
                      {formatMessage(labels.providerSummary, {
                        currency: preview.product.currency,
                        amountMinor: String(preview.product.amountMinor),
                        billingType: preview.product.billingType,
                        status: preview.product.status,
                      })}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <p>{labels.mismatchTitle}</p>
                  <ul>
                    {preview.match.mismatches.map((mismatch) => (
                      <li key={mismatch.field}>
                        {fieldLabel(labels, mismatch.field)}:{" "}
                        {mismatch.monetplane} ≠ {mismatch.provider}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {preview.legacyProviderProductId && (
                <p>
                  {formatMessage(labels.legacyNote, {
                    productId: preview.legacyProviderProductId,
                  })}
                </p>
              )}
            </div>
          )}

          <button type="submit" className="btn btn-primary" disabled={!canLink}>
            {linking ? labels.linking : labels.link}
          </button>
          {message && <span className="catalog-link-message">{message}</span>}
        </form>
      )}
    </section>
  );
}
