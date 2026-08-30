"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

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
};

export function ProductProviderRouteEditor({
  productId,
  environment,
  currentProviderConnectionId,
  providers,
}: ProductProviderRouteEditorProps) {
  const router = useRouter();
  const [providerConnectionId, setProviderConnectionId] = useState(
    currentProviderConnectionId ?? providers[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentLabel = environment === "test" ? "Sandbox" : "Production";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providerConnectionId) {
      setMessage(`Choose a ${environmentLabel} provider first.`);
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
        throw new Error(result.error ?? "Failed to update provider route");
      }
      setMessage(`${environmentLabel} provider updated.`);
      router.refresh();
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "Failed to update provider route",
      );
    } finally {
      setPending(false);
    }
  }

  if (providers.length === 0) {
    return (
      <div className="route-editor-empty">
        <p>No active {environmentLabel} provider is connected to this project.</p>
        <Link href="/providers/new" className="btn btn-secondary">
          Connect provider
        </Link>
      </div>
    );
  }

  return (
    <form className="product-route-editor" onSubmit={submit}>
      <label className="field-group">
        <span>{environmentLabel} provider</span>
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
        disabled={pending || providerConnectionId === currentProviderConnectionId}
      >
        {pending ? "Saving…" : "Save route"}
      </button>
      {message && <span className="route-editor-message">{message}</span>}
    </form>
  );
}
