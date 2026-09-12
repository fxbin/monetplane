export const SUPPORTED_PROVIDER_SETUPS = [
  {
    provider: "creem",
    label: "Creem",
    description: "Hosted checkout for one-time purchases and subscriptions.",
    credentialFields: [
      {
        key: "apiKey",
        label: "API key",
        placeholder: "creem_...",
        help: "Used by MonetPlane for server-to-server Creem API requests.",
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        placeholder: "••••••••••••••••",
        help: "Used to verify incoming Creem webhook signatures.",
      },
    ],
  },
  {
    provider: "waffo",
    label: "Waffo",
    description:
      "One-time and recurring checkout with refund and subscription operations.",
    credentialFields: [
      {
        key: "apiKey",
        label: "API key",
        placeholder: "waffo_...",
        help: "Sent as X-API-KEY for Waffo API requests.",
      },
      {
        key: "signingSecret",
        label: "Signing secret",
        placeholder: "••••••••••••••••",
        help: "Used to sign outgoing Waffo API request bodies.",
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        placeholder: "••••••••••••••••",
        help: "Used to verify incoming Waffo webhook signatures.",
      },
    ],
  },
] as const;

export type SupportedProviderSetup =
  (typeof SUPPORTED_PROVIDER_SETUPS)[number]["provider"];

export function getProviderSetup(provider: string) {
  return (
    SUPPORTED_PROVIDER_SETUPS.find((item) => item.provider === provider) ?? null
  );
}

export function validateProviderSetupCredentials(
  provider: string,
  credentials: Record<string, unknown>,
): Record<string, string> {
  const setup = getProviderSetup(provider);
  if (!setup) throw new Error("Choose a supported payment provider");

  const normalized: Record<string, string> = {};
  for (const field of setup.credentialFields) {
    const value = credentials[field.key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field.label} is required for ${setup.label}`);
    }
    normalized[field.key] = value.trim();
  }

  return normalized;
}
