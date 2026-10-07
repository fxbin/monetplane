"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { Dictionary } from "@/i18n/dictionaries/en";
import { formatMessage } from "@/i18n/format";

type ProviderOption = {
  id: string;
  provider: string;
  name: string;
  mode: "test" | "live";
};

type ProductProviderRouteEditorProps = {
  productId: string;
  environment: "test" | "live";
  currentProviderConnectionId: string | null;
  providers: ProviderOption[];
  /** Locale-resolved labels. */
  labels: Dictionary["routeEditor"];
};

export function ProductProviderRouteEditor({
  productId,
  environment,
  currentProviderConnectionId,
  providers,
  labels,
}: ProductProviderRouteEditorProps) {
  const router = useRouter();
  const currentRouteIsActive = providers.some(
    (provider) => provider.id === currentProviderConnectionId,
  );
  const [providerConnectionId, setProviderConnectionId] = useState(
    currentRouteIsActive
      ? (currentProviderConnectionId ?? "")
      : (providers[0]?.id ?? ""),
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentLabel =
    environment === "test" ? labels.sandboxFallback : labels.productionFallback;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providerConnectionId) {
      setMessage(
        formatMessage(labels.chooseProviderFirst, {
          environment: environmentLabel,
        }),
      );
      return;
    }

    setPending(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/admin/products/${encodeURIComponent(productId)}/routing`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ providerConnectionId }),
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? labels.failed);
      }
      setMessage(
        formatMessage(labels.updated, { environment: environmentLabel }),
      );
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : labels.failed);
    } finally {
      setPending(false);
    }
  }

  if (providers.length === 0) {
    return (
      <div className="route-editor-empty">
        <p>
          {formatMessage(labels.noProvider, { environment: environmentLabel })}
        </p>
        <Link href="/providers/new" className="btn btn-secondary">
          {labels.connectProvider}
        </Link>
      </div>
    );
  }

  return (
    <form className="product-route-editor" onSubmit={submit}>
      <label className="field-group">
        <span>
          {formatMessage(labels.providerLabel, {
            environment: environmentLabel,
          })}
        </span>
        <select
          value={providerConnectionId}
          onChange={(event) => {
            setProviderConnectionId(event.target.value);
            setMessage(null);
          }}
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.provider}
            </option>
          ))}
        </select>
      </label>
      <button
        className="btn btn-secondary"
        type="submit"
        disabled={
          pending ||
          (currentRouteIsActive &&
            providerConnectionId === currentProviderConnectionId)
        }
      >
        {pending ? labels.saving : labels.saveRoute}
      </button>
      {message && <span className="route-editor-message">{message}</span>}
    </form>
  );
}
