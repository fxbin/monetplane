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
  // POST /v2/payments/captures/{id}/refund — endpoint contract exercised
  // live; capture-dependent execution pending the buyer-approval evidence
  // step (docs/paypal-live-evidence.md qualifications).
  refund: true,
  // POST /v1/billing/subscriptions/{id}/cancel — route/auth exercised live;
  // only ACTIVE subscriptions are cancellable and the evidence subscription
  // stayed APPROVAL_PENDING without a buyer approval.
  subscription_cancel: true,
  subscription_update: false,
  customer_portal: false,
  provider_hosted_checkout: true,
};

type FetchLike = typeof fetch;

type PayPalAdapterOptions = {
  fetchImpl?: FetchLike;
  baseUrls?: { test?: string; live?: string };
};

type JsonRecord = Record<string, unknown>;

type CachedToken = { token: string; expiresAt: number };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

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

function headerValue(
  headers: Readonly<Record<string, string | undefined>>,
  target: string,
): string | undefined {
  const direct = headers[target];
  if (direct) return direct;
  const normalizedTarget = target.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedTarget && value) return value;
  }
  return undefined;
}

function requiredCredential(
  connection: ProviderConnectionContext,
  key: string,
): string {
  const value = connection.credentials[key]?.trim();
  if (!value) throw new Error(`PayPal credential ${key} is required`);
  return value;
}

function baseUrl(
  connection: ProviderConnectionContext,
  options: PayPalAdapterOptions,
): string {
  const configured =
    connection.mode === "test"
      ? options.baseUrls?.test
      : options.baseUrls?.live;
  const official =
    connection.mode === "test" ? PAYPAL_TEST_API : PAYPAL_PRODUCTION_API;
  return (configured ?? official).replace(/\/+$/, "");
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

/** PayPal decimal string ("19.00") → MonetPlane minor units. */
function parseAmountMinor(
  value: unknown,
  currency: string,
): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(amount * 10 ** currencyDecimals(currency));
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
  const productId = stringValue(mapping?.productId)?.trim();
  const planId = stringValue(mapping?.planId)?.trim();
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
    const clientId = requiredCredential(connection, "clientId");
    const clientSecret = requiredCredential(connection, "clientSecret");
    const cacheKey = `${connection.id}:${clientId}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${baseUrl(connection, options)}/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
    );
    const text = await response.text();
    let body: JsonRecord = {};
    if (text) {
      try {
        body = JSON.parse(text) as JsonRecord;
      } catch {
        throw new Error(
          `PayPal OAuth response is invalid JSON (${response.status})`,
        );
      }
    }
    const token = stringValue(body.access_token);
    const expiresIn = numberValue(body.expires_in);
    if (!response.ok || !token) {
      throw new Error(
        `PayPal OAuth failed (${response.status}): ${stringValue(body.error) ?? stringValue(body.message) ?? "unknown error"}`,
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
  ): Promise<{ status: number; payload: JsonRecord }> {
    const token = await accessToken(connection);
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${baseUrl(connection, options)}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await response.text();
    let payload: JsonRecord = {};
    if (text) {
      try {
        payload = JSON.parse(text) as JsonRecord;
      } catch {
        throw new Error(
          `PayPal returned invalid JSON (${response.status} ${response.statusText})`,
        );
      }
    }
    if (response.status === 401 && init?.retryAuth !== false) {
      tokenCache.delete(
        `${connection.id}:${requiredCredential(connection, "clientId")}`,
      );
      return paypalRequest(connection, path, { ...init, retryAuth: false });
    }
    return { status: response.status, payload };
  }

  async function paypalCall(
    connection: ProviderConnectionContext,
    path: string,
    init?: RequestInit,
  ): Promise<JsonRecord> {
    const { status, payload } = await paypalRequest(connection, path, init);
    if (status < 200 || status >= 300) {
      const detail = recordValue(
        (Array.isArray(payload.details) ? payload.details[0] : undefined) ??
          recordValue(payload.error),
      );
      const message =
        stringValue(payload.message) ??
        stringValue(detail?.description) ??
        stringValue(payload.error_description) ??
        `PayPal request failed (${status})`;
      // Deterministic schema/validation rejections are retryable after
      // input fixes; everything else stays outcome-uncertain (fail-safe).
      if (status === 400 || status === 422) {
        const error = new Error(message) as Error & { failureKind?: string };
        error.failureKind = "rejected";
        throw error;
      }
      throw new Error(message);
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
        const major = (amountMinor / 10 ** currencyDecimals(currency)).toFixed(
          currencyDecimals(currency),
        );
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
      return {
        providerPaymentId: id,
        status: mapPaymentStatus(payload.status),
        amountMinor: parseAmountMinor(amount?.value, currency) ?? 0,
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
          value: (input.amountMinor / 10 ** currencyDecimals(currency)).toFixed(
            currencyDecimals(currency),
          ),
        };
      }
      const payload = await paypalCall(
        connection,
        `/v2/payments/captures/${encodeURIComponent(input.providerPaymentId)}/refund`,
        { method: "POST", body: JSON.stringify(body) },
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
      const webhookId = requiredCredential(connection, "webhookId");

      let event: JsonRecord;
      try {
        const parsed = JSON.parse(input.rawBody) as unknown;
        if (!isRecord(parsed)) throw new Error("not an object");
        event = parsed;
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.rawBody) as unknown;
      } catch {
        throw new Error("PayPal webhook body is not valid JSON");
      }
      if (!isRecord(parsed)) {
        throw new Error("PayPal webhook must be a JSON object");
      }
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
        ? parseAmountMinor(amount?.value, currency)
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
        return {
          ...base,
          ...correlation,
          type: "subscription.renewed",
          providerSubscriptionId: agreementId,
          providerPaymentId: id,
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
