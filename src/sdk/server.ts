/**
 * MonetPlane Server SDK — single-entry-point HTTP client.
 *
 * Product teams use this SDK to integrate with MonetPlane without
 * importing any provider SDK or touching provider-specific objects.
 *
 * @example
 * ```ts
 * import { createMonetPlaneClient } from "@monetplane/sdk/server";
 *
 * const client = createMonetPlaneClient({
 *   baseUrl: process.env.MONETPLANE_BASE_URL!,
 *   appSecret: process.env.MONETPLANE_APP_SECRET!,
 * });
 *
 * const checkout = await client.createCheckout({
 *   externalCustomerId: "user-123",
 *   items: [{ priceId: "price_credits_100", quantity: 1 }],
 *   providerConnectionId: "pc_...",
 *   successUrl: "https://app.example.com/success",
 *   cancelUrl: "https://app.example.com/cancel",
 * });
 * ```
 */

import { MonetPlaneError, NetworkError, responseToError } from "./errors";
import type {
  CaptureReservationInput,
  CaptureReservationResult,
  CheckoutInput,
  CheckoutResult,
  CreditBalance,
  CustomerInput,
  CustomerResult,
  DebitCreditsInput,
  DebitCreditsResult,
  EntitlementCheckInput,
  EntitlementCheckResult,
  MonetPlaneClientOptions,
  ReleaseReservationInput,
  ReleaseReservationResult,
  ReserveCreditsInput,
  ReserveCreditsResult,
} from "./types";

type Client = {
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  upsertCustomer(input: CustomerInput): Promise<CustomerResult>;
  getCreditBalance(
    externalCustomerId: string,
    creditType: string,
  ): Promise<CreditBalance>;
  debitCredits(input: DebitCreditsInput): Promise<DebitCreditsResult>;
  reserveCredits(input: ReserveCreditsInput): Promise<ReserveCreditsResult>;
  captureReservation(
    input: CaptureReservationInput,
  ): Promise<CaptureReservationResult>;
  releaseReservation(
    input: ReleaseReservationInput,
  ): Promise<ReleaseReservationResult>;
  checkEntitlement(
    input: EntitlementCheckInput,
  ): Promise<EntitlementCheckResult>;
};

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("MonetPlane baseUrl is required");
  return trimmed;
}

function assertSecret(secret: string): void {
  if (!secret || !secret.trim()) {
    throw new Error("MonetPlane appSecret is required");
  }
}

async function request(
  options: Required<
    Pick<MonetPlaneClientOptions, "baseUrl" | "appSecret" | "timeoutMs">
  > & {
    fetchImpl: typeof fetch;
  },
  path: string,
  body: Record<string, unknown> | null,
): Promise<unknown> {
  const url = `${options.baseUrl}${path}`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    response = await options.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.appSecret}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (error) {
    if (error instanceof MonetPlaneError) throw error;
    throw new NetworkError(
      error instanceof Error ? error.message : "Network request failed",
      error,
    );
  }

  if (!response.ok) {
    throw await responseToError(response);
  }

  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createMonetPlaneClient(
  options: MonetPlaneClientOptions,
): Client {
  assertSecret(options.appSecret);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30000;

  const call = (path: string, body: Record<string, unknown> | null = null) =>
    request(
      { baseUrl, appSecret: options.appSecret, timeoutMs, fetchImpl },
      path,
      body,
    );

  return {
    async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
      const data = await call("/api/checkout", input);
      return data as CheckoutResult;
    },

    async upsertCustomer(input: CustomerInput): Promise<CustomerResult> {
      const data = await call("/api/customers", input);
      return data as CustomerResult;
    },

    async getCreditBalance(
      externalCustomerId: string,
      creditType: string,
    ): Promise<CreditBalance> {
      const data = await call("/api/credits/balance", {
        externalCustomerId,
        creditType,
      });
      return data as CreditBalance;
    },

    async debitCredits(input: DebitCreditsInput): Promise<DebitCreditsResult> {
      const data = await call("/api/credits/debit", input);
      return data as DebitCreditsResult;
    },

    async reserveCredits(
      input: ReserveCreditsInput,
    ): Promise<ReserveCreditsResult> {
      const payload = {
        ...input,
        expiresAt: input.expiresAt
          ? input.expiresAt instanceof Date
            ? input.expiresAt.toISOString()
            : input.expiresAt
          : null,
      };
      const data = await call("/api/credits/reserve", payload);
      return data as ReserveCreditsResult;
    },

    async captureReservation(
      input: CaptureReservationInput,
    ): Promise<CaptureReservationResult> {
      const data = await call("/api/credits/capture", input);
      return data as CaptureReservationResult;
    },

    async releaseReservation(
      input: ReleaseReservationInput,
    ): Promise<ReleaseReservationResult> {
      const data = await call("/api/credits/release", input);
      return data as ReleaseReservationResult;
    },

    async checkEntitlement(
      input: EntitlementCheckInput,
    ): Promise<EntitlementCheckResult> {
      const data = await call("/api/entitlements/check", {
        ...input,
        at: input.at ? input.at.toISOString() : undefined,
      });
      return data as EntitlementCheckResult;
    },
  };
}
