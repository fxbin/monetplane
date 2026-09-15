export type ProviderSetupField = {
  key: string;
  label: string;
  placeholder: string;
  help: string;
  inputType: "password" | "text" | "url";
  secret: boolean;
};

type ProviderSetup = {
  provider: string;
  label: string;
  description: string;
  credentialFields: readonly ProviderSetupField[];
};

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
        inputType: "password",
        secret: true,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        placeholder: "••••••••••••••••",
        help: "Used to verify incoming Creem webhook signatures.",
        inputType: "password",
        secret: true,
      },
    ],
  },
  {
    provider: "waffo",
    label: "Waffo",
    description:
      "One-time and recurring checkout with RSA-signed API and webhook operations.",
    credentialFields: [
      {
        key: "apiKey",
        label: "API key",
        placeholder: "waffo_...",
        help: "Official Waffo API key for the selected Sandbox or Production environment.",
        inputType: "password",
        secret: true,
      },
      {
        key: "merchantId",
        label: "Merchant ID",
        placeholder: "merchant_...",
        help: "Waffo merchant identifier. The official SDK injects this into merchant-scoped requests.",
        inputType: "text",
        secret: false,
      },
      {
        key: "privateKey",
        label: "Merchant private key",
        placeholder: "Base64 PKCS8 or unencrypted PKCS8 PEM",
        help: "Merchant RSA private key used by the official Waffo SDK to sign requests.",
        inputType: "password",
        secret: true,
      },
      {
        key: "waffoPublicKey",
        label: "Waffo public key",
        placeholder: "Base64 X509 public key",
        help: "Waffo RSA public key used by the official SDK to verify responses and webhooks.",
        inputType: "password",
        secret: true,
      },
      {
        key: "notifyUrl",
        label: "Webhook notification URL",
        placeholder: "https://billing.example.com/api/waffo/webhook",
        help: "Public HTTPS endpoint that receives Waffo payment and subscription notifications for this connection.",
        inputType: "url",
        secret: false,
      },
    ],
  },
] as const satisfies readonly ProviderSetup[];

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

  if (provider === "waffo") {
    let notifyUrl: URL;
    try {
      notifyUrl = new URL(normalized.notifyUrl ?? "");
    } catch {
      throw new Error("Webhook notification URL must be a valid URL for Waffo");
    }
    if (notifyUrl.protocol !== "https:") {
      throw new Error("Webhook notification URL must use HTTPS for Waffo");
    }
  }

  return normalized;
}
