import type { PaymentProviderAdapter } from "./contract";

const adapters = new Map<string, PaymentProviderAdapter>();

export class ProviderAdapterNotRegisteredError extends Error {
  constructor(provider: string) {
    super(`Provider adapter is not registered: ${provider}`);
    this.name = "ProviderAdapterNotRegisteredError";
  }
}

export function registerProviderAdapter(
  adapter: PaymentProviderAdapter,
): () => void {
  const provider = adapter.provider.trim().toLowerCase();
  if (!provider) throw new Error("Provider adapter name is required");
  adapters.set(provider, adapter);

  return () => {
    if (adapters.get(provider) === adapter) adapters.delete(provider);
  };
}

export function getProviderAdapter(provider: string): PaymentProviderAdapter {
  const adapter = adapters.get(provider.trim().toLowerCase());
  if (!adapter) throw new ProviderAdapterNotRegisteredError(provider);
  return adapter;
}

export function clearProviderAdaptersForTests(): void {
  adapters.clear();
}
