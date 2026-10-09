// Single money authority (audit A1): the unified zero-decimal registry —
// ISK is 0-decimal here, intentionally superseding PayPal's old 2-decimal
// ISK handling (see src/lib/money.ts). Relative import: adapters are also
// imported by unit tests that run without a tsconfig-path resolver.
import {
  minorToDisplayString,
  parseProviderAmountToMinor,
} from "../../../lib/money";
import type {
  CancelSubscriptionInput,
  CheckoutResult,
  CreateCheckoutInput,
  GetPaymentInput,
  GetSubscriptionInput,
  NormalizedPayment,
  NormalizedProviderEvent,
  NormalizedRefund,
  NormalizedSubscription,
  PaymentProviderAdapter,
  ProviderCapabilities,
  ProviderConnectionContext,
  RefundPaymentInput,
  UpdateSubscriptionInput,
  VerifiedWebhook,
  VerifyWebhookInput,
} from "../contract";
import {
  InvalidProviderWebhookSignatureError,
  UnsupportedProviderCapabilityError,
} from "../contract";
// Shared adapter kit (audit A8): JSON guards, credential access, base URL
// resolution, and fetch-JSON boilerplate live in ./shared for all adapters.
import {
  classifyHttpFailure,
  headerValue,
  type JsonRecord,
  numberValue,
  optionalString,
  parseWebhookJson,
  providerBaseUrl,
  providerErrorMessage,
  providerFetchJson,
  recordValue,
  requiredCredential,
  stringValue,
} from "./shared";

/**
 * PayPal adapter (#72) — third real provider, PSP model (Orders + Billing
 * Subscriptions APIs). Verified against the real sandbox API; see
 * docs/paypal-live-evidence.md for the journey and qualifications.
 */

const PAYPAL_PRODUCTION_API = "https://api-m.paypal.com";
const PAYPAL_TEST_API = "https://api-m.sandbox.paypal.com";

const PAYPAL_CAPABILITIES: ProviderCapabilities = {
  one_time_checkout: true,
  recurring_subscription: true,
  monthly_interval: true,
  annual_interval: true,
  weekly_interval: true,
  trial_periods: true,
  // Live-verified: real refund 9R083634CD4158109 COMPLETED on capture
  // 7AV91188T0463123J (docs/paypal-live-evidence.md).
  refund: true,
  // Live-verified: real cancel of ACTIVE subscription I-MN88MMVNENFM →
  // CANCELLED (docs/paypal-live-evidence.md).
  subscription_cancel: true,
  subscription_update: false,
  customer_portal: false,
  provider_hosted_checkout: true,
  catalog_provisioning: false,
};

type FetchLike = typeof fetch;

type PayPalAdapterOptions = {
  fetchImpl?: FetchLike;
  baseUrls?: { test?: string; live?: string };
};

type CachedToken = { token: string; expiresAt: number };

function linkHref(payload: JsonRecord, ...rels: string[]): string | undefined {
  const links = Array.isArray(payload.links) ? payload.links : [];
  for (const rel of rels) {
    for (const link of links) {
      const record = recordValue(link);
      if (record?.rel === rel) {
        const href = stringValue(record.href);
        if (href) return href;
      }
    }
  }
  return undefined;
}

function baseUrl(
  connection: ProviderConnectionContext,
  options: PayPalAdapterOptions,
): string {
  return providerBaseUrl(
    connection,
    { test: PAYPAL_TEST_API, live: PAYPAL_PRODUCTION_API },
    options.baseUrls,
  );
}

/** MonetPlane correlation payload for PayPal custom_id (≤127 chars). */
function correlationCustomId(input: {
  monetplaneOrderId: string;
  monetplaneCustomerId: string;
}): string {
  return `monetplane_order_id:${input.monetplaneOrderId}|monetplane_customer_id:${input.monetplaneCustomerId}`;
}

function parseCustomId(value: unknown): {
  monetplaneOrderId?: string;
  monetplaneCustomerId?: string;
} {
  const customId = stringValue(value);
  if (!customId) return {};
  const parts = customId.split("|");
  const read = (prefix: string) => {
    const match = parts.find((part) => part.startsWith(`${prefix}:`));
    return match ? match.slice(prefix.length + 1) : undefined;
  };
  return {
    monetplaneOrderId: read("monetplane_order_id"),
    monetplaneCustomerId: read("monetplane_customer_id"),
  };
}

function catalogMapping(
  connection: ProviderConnectionContext,
  monetplanePriceId: string,
): { productId: string; planId: string } {
  const catalog = recordValue(connection.metadata.catalog);
  const mapping = recordValue(catalog?.[monetplanePriceId]);
  const productId = optionalString(mapping?.productId);
  const planId = optionalString(mapping?.planId);
  if (!productId || !planId) {
    throw new Error(
      `PayPal catalog mapping is missing for MonetPlane price ${monetplanePriceId} (requires productId and planId)`,
    );
  }
  return { productId, planId };
}

function mapPaymentStatus(value: unknown): NormalizedPayment["status"] {
  switch (value) {
    case "COMPLETED":
      return "succeeded";
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return "refunded";
    case "DECLINED":
    case "DENIED":
    case "FAILED":
    case "VOIDED":
      return "failed";
    default:
      return "pending";
  }
}

function mapSubscriptionStatus(
  value: unknown,
): NormalizedSubscription["status"] {
  switch (value) {
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "past_due";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      return "pending";
  }
}

function normalizeSubscriptionObject(
  value: JsonRecord,
): NormalizedSubscription {
  const id = stringValue(value.id);
  if (!id) throw new Error("PayPal subscription response is missing id");
  const billingInfo = recordValue(value.billing_info);
  return {
    providerSubscriptionId: id,
    status: mapSubscriptionStatus(value.status),
    providerCustomerId: stringValue(recordValue(value.subscriber)?.payer_id),
    currentPeriodStart: stringValue(
      recordValue(billingInfo?.last_payment)?.time,
    ),
    currentPeriodEnd: stringValue(billingInfo?.next_billing_time),
    cancelAtPeriodEnd: false,
  };
}

export function createPayPalProviderAdapter(
  options: PayPalAdapterOptions = {},
): PaymentProviderAdapter {
  const tokenCache = new Map<string, CachedToken>();

  async function accessToken(
    connection: ProviderConnectionContext,
  ): Promise<string> {
    const clientId = requiredCredential(connection, "clientId", "PayPal");
    const clientSecret = requiredCredential(
      connection,
      "clientSecret",
      "PayPal",
    );
    const cacheKey = `${connection.id}:${clientId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const { status, payload } = await providerFetchJson(
      `${baseUrl(connection, options)}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
      { provider: "PayPal", fetchImpl: options.fetchImpl },
    );
    const token = stringValue(payload.access_token);
    const expiresIn = numberValue(payload.expires_in);
    if (status < 200 || status >= 300 || !token) {
      throw new Error(
        `PayPal OAuth failed (${status}): ${stringValue(payload.error) ?? stringValue(payload.message) ?? "unknown error"}`,
      );
    }
    const cachedToken = {
      token,
      expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
    };
    tokenCache.set(cacheKey, cachedToken);
    return token;
  }

  async function paypalRequest(
    connection: ProviderConnectionContext,
    path: string,
    init?: RequestInit & { retryAuth?: boolean },
  ): Promise<{ status: number; statusText: string; payload: JsonRecord }> {
    const token = await accessToken(connection);
    const result = await providerFetchJson(
      `${baseUrl(connection, options)}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      },
      { provider: "PayPal", fetchImpl: options.fetchImpl },
    );
    if (result.status === 401 && init?.retryAuth !== false) {
      tokenCache.delete(
        `${connection.id}:${requiredCredential(connection, "clientId", "PayPal")}`,
      );
      return paypalRequest(connection, path, { ...init, retryAuth: false });
    }
    return result;
  }

  async function paypalCall(
    connection: ProviderConnectionContext,
    path: string,
    init?: RequestInit,
  ): Promise<JsonRecord> {
    const { status, payload } = await paypalRequest(connection, path, init);
    if (status < 200 || status >= 300) {
      const message = providerErrorMessage(
        payload,
        `PayPal request failed (${status})`,
      );
      // Shared classification (roundtable batch 1): 4xx never executed
      // server-side → retryable-after-fix; 5xx may have executed → stays
      // outcome-uncertain so the journal never blind-retries it.
      // (Audit A8 history: this must throw the CLASSIFIED error so
      // classifyProviderOperationFailure sees the failure kind.)
      throw classifyHttpFailure(status, message);
    }
    return payload;
  }

  return {
    provider: "paypal",

    getCapabilities() {
      return PAYPAL_CAPABILITIES;
    },

    async createCheckout(
      connection: ProviderConnectionContext,
      input: CreateCheckoutInput,
    ): Promise<CheckoutResult> {
      if (input.items.length !== 1) {
        throw new Error(
          "PayPal checkout supports exactly one mapped product per checkout",
        );
      }
      const item = input.items[0];
      if (!item) throw new Error("PayPal checkout requires one item");

      if (input.billingMode === "one_time") {
        const amountMinor = item.unitAmountMinor * item.quantity;
        const currency = input.currency;
        const major = minorToDisplayString(amountMinor, currency);
        const payload = await paypalCall(connection, "/v2/checkout/orders", {
          method: "POST",
          body: JSON.stringify({
            intent: "CAPTURE",
            purchase_units: [
              {
                custom_id: correlationCustomId(input),
                description:
                  item.productName?.slice(0, 127) ?? "MonetPlane order",
                amount: { currency_code: currency, value: major },
              },
            ],
            payment_source: {
              paypal: {
                experience_context: {
                  user_action: "PAY_NOW",
                  return_url: input.successUrl,
                  cancel_url: input.cancelUrl,
                },
              },
            },
          }),
        });
        const providerCheckoutId = stringValue(payload.id);
        const checkoutUrl = linkHref(payload, "approve", "payer-action");
        if (!providerCheckoutId || !checkoutUrl) {
          throw new Error(
            "PayPal order response is missing id or approve link",
          );
        }
        return {
          providerCheckoutId,
          checkoutUrl,
          reconciliationMetadata: {
            monetplane_order_id: input.monetplaneOrderId,
            monetplane_customer_id: input.monetplaneCustomerId,
            paypalOrderId: providerCheckoutId,
          },
        };
      }

      const { planId } = catalogMapping(connection, item.priceId);
      const payload = await paypalCall(
        connection,
        "/v1/billing/subscriptions",
        {
          method: "POST",
          body: JSON.stringify({
            plan_id: planId,
            custom_id: correlationCustomId(input),
            subscriber: input.customerEmail
              ? { email_address: input.customerEmail }
              : undefined,
            application_context: {
              brand_name: "MonetPlane",
              user_action: "SUBSCRIBE_NOW",
              return_url: input.successUrl,
              cancel_url: input.cancelUrl,
            },
          }),
        },
      );
      const providerCheckoutId = stringValue(payload.id);
      const checkoutUrl = linkHref(payload, "approve", "payer-action");
      if (!providerCheckoutId || !checkoutUrl) {
        throw new Error(
          "PayPal subscription response is missing id or approve link",
        );
      }
      return {
        providerCheckoutId,
        checkoutUrl,
        reconciliationMetadata: {
          monetplane_order_id: input.monetplaneOrderId,
          monetplane_customer_id: input.monetplaneCustomerId,
          paypalSubscriptionId: providerCheckoutId,
          paypalPlanId: planId,
        },
      };
    },

    async getPayment(
      connection: ProviderConnectionContext,
      input: GetPaymentInput,
    ): Promise<NormalizedPayment> {
      const payload = await paypalCall(
        connection,
        `/v2/payments/captures/${encodeURIComponent(input.providerPaymentId)}`,
      );
      const amount = recordValue(payload.amount);
      const currency = stringValue(amount?.currency_code);
      const id = stringValue(payload.id);
      if (!id || !currency) {
        throw new Error("PayPal capture response is incomplete");
      }
      const amountMinor = parseProviderAmountToMinor(amount?.value, currency);
      if (amountMinor === undefined) {
        // Fail closed (project review 2026-10-04, finding 1.6): a missing
        // or non-numeric amount must not normalize to a "0 minor" success,
        // which would silently mint a free payment for reconciliation.
        throw new Error(
          `PayPal capture ${id} returned an unparseable amount for ${currency}`,
        );
      }
      return {
        providerPaymentId: id,
        status: mapPaymentStatus(payload.status),
        amountMinor,
        currency,
        providerCustomerId: stringValue(recordValue(payload.payer)?.payer_id),
      };
    },

    async getSubscription(
      connection: ProviderConnectionContext,
      input: GetSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const payload = await paypalCall(
        connection,
        `/v1/billing/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
      );
      return normalizeSubscriptionObject(payload);
    },

    async cancelSubscription(
      connection: ProviderConnectionContext,
      input: CancelSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      await paypalCall(
        connection,
        `/v1/billing/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "Cancelled by customer request" }),
        },
      );
      const payload = await paypalCall(
        connection,
        `/v1/billing/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`,
      );
      return normalizeSubscriptionObject(payload);
    },

    async updateSubscription(
      _connection: ProviderConnectionContext,
      _input: UpdateSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      throw new UnsupportedProviderCapabilityError(
        "paypal",
        "subscription_update",
      );
    },

    async refundPayment(
      connection: ProviderConnectionContext,
      input: RefundPaymentInput,
    ): Promise<NormalizedRefund> {
      const body: JsonRecord = {};
      if (input.amountMinor !== undefined) {
        // Partial refunds must match the capture currency; resolve it from
        // the capture itself. Full-refund requests omit the amount.
        const capture = await paypalCall(
          connection,
          `/v2/payments/captures/${encodeURIComponent(input.providerPaymentId)}`,
        );
        const currency =
          stringValue(recordValue(capture.amount)?.currency_code) ?? "USD";
        body.amount = {
          currency_code: currency,
          value: minorToDisplayString(input.amountMinor, currency),
        };
      }
      // Provider-side idempotency: PayPal dedupes refund requests that
      // carry the same PayPal-Request-Id, so replaying the SAME journal
      // operation's provider call cannot produce a second real refund.
      // (Explicit retries create a new journal operation with its own key
      // — by design, since retry is only allowed after a deterministic
      // rejection, where PayPal never saw the original request.)
      const payload = await paypalCall(
        connection,
        `/v2/payments/captures/${encodeURIComponent(input.providerPaymentId)}/refund`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: input.requestId
            ? { "PayPal-Request-Id": input.requestId }
            : undefined,
        },
      );
      const id = stringValue(payload.id);
      if (!id) throw new Error("PayPal refund response is missing id");
      const status = stringValue(payload.status) ?? "";
      return {
        providerRefundId: id,
        providerPaymentId: input.providerPaymentId,
        status:
          status === "COMPLETED"
            ? "succeeded"
            : status === "DECLINED" ||
                status === "FAILED" ||
                status === "CANCELLED"
              ? "failed"
              : "pending",
        amountMinor: input.amountMinor,
      };
    },

    async verifyWebhook(
      connection: ProviderConnectionContext,
      input: VerifyWebhookInput,
    ): Promise<VerifiedWebhook> {
      const transmissionId = headerValue(
        input.headers,
        "paypal-transmission-id",
      )?.trim();
      const transmissionTime = headerValue(
        input.headers,
        "paypal-transmission-time",
      )?.trim();
      const transmissionSig = headerValue(
        input.headers,
        "paypal-transmission-sig",
      )?.trim();
      const authAlgo = headerValue(input.headers, "paypal-auth-algo")?.trim();
      const certUrl = headerValue(input.headers, "paypal-cert-url")?.trim();

      if (
        !transmissionId ||
        !transmissionTime ||
        !transmissionSig ||
        !authAlgo ||
        !certUrl
      ) {
        throw new InvalidProviderWebhookSignatureError();
      }
      const webhookId = requiredCredential(connection, "webhookId", "PayPal");

      let event: JsonRecord;
      try {
        event = parseWebhookJson(input.rawBody, "PayPal");
      } catch {
        throw new InvalidProviderWebhookSignatureError();
      }

      const { status, payload } = await paypalRequest(
        connection,
        "/v1/notifications/verify-webhook-signature",
        {
          method: "POST",
          body: JSON.stringify({
            auth_algo: authAlgo,
            cert_url: certUrl,
            transmission_id: transmissionId,
            transmission_sig: transmissionSig,
            transmission_time: transmissionTime,
            webhook_id: webhookId,
            webhook_event: event,
          }),
        },
      );
      const verificationStatus = stringValue(payload.verification_status);
      if (status !== 200 || verificationStatus !== "SUCCESS") {
        throw new InvalidProviderWebhookSignatureError();
      }
      return { rawBody: input.rawBody };
    },

    async normalizeWebhook(
      connection: ProviderConnectionContext,
      input: VerifiedWebhook,
    ): Promise<NormalizedProviderEvent> {
      const parsed = parseWebhookJson(input.rawBody, "PayPal");
      const providerEventId = stringValue(parsed.id);
      const providerEventName = stringValue(parsed.event_type);
      const occurredAt = stringValue(parsed.create_time);
      const resource = recordValue(parsed.resource);
      if (!providerEventId || !providerEventName || !occurredAt || !resource) {
        throw new Error("PayPal webhook is missing required event fields");
      }

      const base: Omit<NormalizedProviderEvent, "type" | "rawEventReference"> =
        {
          provider: "paypal",
          providerConnectionId: connection.id,
          providerEventId,
          providerEventName,
          applicationId: connection.applicationId,
          occurredAt,
        };
      const unknownEvent = (): NormalizedProviderEvent => ({
        ...base,
        type: "unknown",
        rawEventReference: providerEventId,
      });

      const correlation = parseCustomId(resource.custom_id);
      const amount = recordValue(resource.amount);
      const currency = stringValue(amount?.currency_code);
      const amountMinor = currency
        ? parseProviderAmountToMinor(amount?.value, currency)
        : undefined;

      const amountFields = currency
        ? { amountMinor, currency }
        : { amountMinor: undefined, currency: undefined };

      if (providerEventName === "PAYMENT.CAPTURE.COMPLETED") {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "payment.succeeded",
          providerPaymentId: id,
          providerCustomerId: stringValue(
            recordValue(recordValue(resource.payer)?.payer_id),
          ),
          ...amountFields,
          rawEventReference: providerEventId,
        };
      }

      if (
        providerEventName === "PAYMENT.CAPTURE.DENIED" ||
        providerEventName === "PAYMENT.CAPTURE.DECLINED"
      ) {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "payment.failed",
          providerPaymentId: id,
          ...amountFields,
          rawEventReference: providerEventId,
        };
      }

      if (
        providerEventName === "PAYMENT.CAPTURE.REFUNDED" ||
        providerEventName === "PAYMENT.CAPTURE.REVERSED"
      ) {
        const refundId = stringValue(resource.id);
        const captureId = stringValue(
          recordValue(recordValue(resource.supplementary_data)?.related_ids)
            ?.capture,
        );
        if (!refundId || !captureId) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "payment.refunded",
          providerPaymentId: captureId,
          providerRefundId: refundId,
          ...amountFields,
          rawEventReference: providerEventId,
        };
      }

      if (providerEventName === "BILLING.SUBSCRIPTION.CREATED") {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "subscription.created",
          providerSubscriptionId: id,
          subscriptionStatus: "pending",
          rawEventReference: providerEventId,
        };
      }

      if (providerEventName === "BILLING.SUBSCRIPTION.ACTIVATED") {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        const billingInfo = recordValue(resource.billing_info);
        return {
          ...base,
          ...correlation,
          type: "subscription.activated",
          providerSubscriptionId: id,
          subscriptionStatus: "active",
          subscriptionPeriodStart: stringValue(
            recordValue(billingInfo?.last_payment)?.time,
          ),
          subscriptionPeriodEnd: stringValue(billingInfo?.next_billing_time),
          rawEventReference: providerEventId,
        };
      }

      if (
        providerEventName === "BILLING.SUBSCRIPTION.SUSPENDED" ||
        providerEventName === "BILLING.SUBSCRIPTION.UPDATED" ||
        providerEventName === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
      ) {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        const billingInfo = recordValue(resource.billing_info);
        return {
          ...base,
          ...correlation,
          type: "subscription.updated",
          providerSubscriptionId: id,
          subscriptionStatus: mapSubscriptionStatus(resource.status),
          subscriptionPeriodStart: stringValue(
            recordValue(billingInfo?.last_payment)?.time,
          ),
          subscriptionPeriodEnd: stringValue(billingInfo?.next_billing_time),
          rawEventReference: providerEventId,
        };
      }

      if (providerEventName === "BILLING.SUBSCRIPTION.CANCELLED") {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "subscription.cancelled",
          providerSubscriptionId: id,
          subscriptionStatus: "cancelled",
          cancelAtPeriodEnd: false,
          rawEventReference: providerEventId,
        };
      }

      if (providerEventName === "BILLING.SUBSCRIPTION.EXPIRED") {
        const id = stringValue(resource.id);
        if (!id) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "subscription.expired",
          providerSubscriptionId: id,
          subscriptionStatus: "expired",
          rawEventReference: providerEventId,
        };
      }

      if (providerEventName === "PAYMENT.SALE.COMPLETED") {
        const id = stringValue(resource.id);
        const agreementId = stringValue(resource.billing_agreement_id);
        if (!id || !agreementId) return unknownEvent();
        // Sale events carry no billing period. Without boundaries the
        // commerce layer keys this cycle's grants off the subscription's
        // previous period, colliding with the activation grant's
        // idempotency key — the cycle is paid but delivers nothing. Fetch
        // the authoritative period from the subscription API instead.
        // Failures throw on purpose: PayPal redelivers the webhook, which
        // is far safer than silently mis-accounting a paid cycle.
        const subscription = normalizeSubscriptionObject(
          await paypalCall(
            connection,
            `/v1/billing/subscriptions/${encodeURIComponent(agreementId)}`,
          ),
        );
        return {
          ...base,
          ...correlation,
          type: "subscription.renewed",
          providerSubscriptionId: agreementId,
          providerPaymentId: id,
          subscriptionStatus: subscription.status,
          subscriptionPeriodStart: subscription.currentPeriodStart,
          subscriptionPeriodEnd: subscription.currentPeriodEnd,
          ...amountFields,
          rawEventReference: providerEventId,
        };
      }

      if (providerEventName === "PAYMENT.SALE.DENIED") {
        const id = stringValue(resource.id);
        const agreementId = stringValue(resource.billing_agreement_id);
        if (!id || !agreementId) return unknownEvent();
        return {
          ...base,
          ...correlation,
          type: "payment.failed",
          providerSubscriptionId: agreementId,
          providerPaymentId: id,
          ...amountFields,
          rawEventReference: providerEventId,
        };
      }

      return unknownEvent();
    },
  };
}

export const payPalProviderAdapter = createPayPalProviderAdapter();
