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
    label: "Waffo Pancake",
    description:
      "Waffo Pancake MoR platform: hosted checkout, subscriptions (weekly/monthly/yearly), trials, and refund tickets via the official @waffo/pancake-ts SDK.",
    credentialFields: [
      {
        key: "merchantId",
        label: "Merchant ID",
        placeholder: "MER_...",
        help: "Waffo Pancake merchant id (X-Merchant-Id). Create a Merchant API Key in the Waffo console; the key's environment (test/prod) is derived by Waffo automatically.",
        inputType: "text",
        secret: false,
      },
      {
        key: "privateKey",
        label: "Merchant private key",
        placeholder: "-----BEGIN PRIVATE KEY----- or base64 PKCS8",
        help: "RSA private key from the Merchant API Key. The SDK signs every request with it. Paste the PEM text or its base64 form.",
        inputType: "password",
        secret: true,
      },
      {
        key: "storeId",
        label: "Store ID",
        placeholder: "STO_...",
        help: "Waffo store that owns the product shells MonetPlane creates for checkout. Webhook signing keys are built into the SDK, so no public key is needed.",
        inputType: "text",
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
    if (!/^MER_[A-Za-z0-9]+$/.test(normalized.merchantId ?? "")) {
      throw new Error("Waffo Merchant ID must look like MER_…");
    }
    if (!/^STO_[A-Za-z0-9]+$/.test(normalized.storeId ?? "")) {
      throw new Error("Waffo Store ID must look like STO_…");
    }
    const key = normalized.privateKey ?? "";
    const looksLikePem = key.includes("PRIVATE KEY");
    const looksLikeBase64 = /^[A-Za-z0-9+/=\s]+$/.test(key);
    if (!looksLikePem && !looksLikeBase64) {
      throw new Error(
        "Waffo private key must be a PEM string or its base64 encoding",
      );
    }
  }

  return normalized;
}
