import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CancelSubscriptionInput,
  CheckoutResult,
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
import { InvalidProviderWebhookSignatureError } from "../contract";

const WAFFO_PRODUCTION_API = "https://api.waffo.com";
const WAFFO_SANDBOX_API = "https://api-sandbox.waffo.com";

const WAFFO_CAPABILITIES: ProviderCapabilities = {
  one_time_checkout: true,
  recurring_subscription: true,
  monthly_interval: true,
  annual_interval: true,
  refund: true,
  subscription_cancel: true,
  subscription_update: true,
  customer_portal: false,
  provider_hosted_checkout: true,
};

type FetchLike = typeof fetch;

type WaffoAdapterOptions = {
  fetchImpl?: FetchLike;
  baseUrls?: {
    test?: string;
    live?: string;
  };
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
  if (!value) throw new Error(`Waffo credential ${key} is required`);
  return value;
}

function baseUrl(
  connection: ProviderConnectionContext,
  options: WaffoAdapterOptions,
): string {
  const configured =
    connection.mode === "test"
      ? options.baseUrls?.test
      : options.baseUrls?.live;
  const official =
    connection.mode === "test" ? WAFFO_SANDBOX_API : WAFFO_PRODUCTION_API;
  return (configured ?? official).replace(/\/+$/, "");
}

function signatureFor(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function safeEqualHex(expected: string, actual: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  const normalizedActual = actual.trim().toLowerCase();
  if (!normalizedExpected || !normalizedActual) return false;
  const expectedBuffer = Buffer.from(normalizedExpected, "hex");
  const actualBuffer = Buffer.from(normalizedActual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

async function waffoRequest(
  connection: ProviderConnectionContext,
  options: WaffoAdapterOptions,
  path: string,
  payload: JsonRecord,
): Promise<JsonRecord> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const rawBody = JSON.stringify(payload);
  const response = await fetchImpl(`${baseUrl(connection, options)}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": requiredCredential(connection, "apiKey"),
      "x-signature": signatureFor(
        rawBody,
        requiredCredential(connection, "signingSecret"),
      ),
    },
    body: rawBody,
  });

  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Waffo returned invalid JSON (${response.status} ${response.statusText})`,
      );
    }
  }

  if (!isRecord(parsed))
    throw new Error("Waffo response must be a JSON object");
  if (!response.ok) {
    throw new Error(
      stringValue(parsed.msg) ??
        stringValue(parsed.message) ??
        stringValue(parsed.error) ??
        `Waffo request failed (${response.status} ${response.statusText})`,
    );
  }
  const code = stringValue(parsed.code);
  if (code && code !== "0") {
    throw new Error(
      stringValue(parsed.msg) ??
        stringValue(parsed.message) ??
        `Waffo error ${code}`,
    );
  }
  const data = recordValue(parsed.data);
  return data ?? parsed;
}

function catalogProductId(
  connection: ProviderConnectionContext,
  monetplanePriceId: string,
): string {
  const catalog = recordValue(connection.metadata.catalog);
  const mapping = catalog?.[monetplanePriceId];
  if (typeof mapping === "string" && mapping.trim()) return mapping.trim();
  const productId = stringValue(recordValue(mapping)?.productId)?.trim();
  if (productId) return productId;
  throw new Error(
    `Waffo catalog mapping is missing for MonetPlane price ${monetplanePriceId}`,
  );
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function centsFromAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.round(value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 100);
}

function mapPaymentStatus(value: unknown): NormalizedPayment["status"] {
  switch (value) {
    case "PAY_SUCCESS":
    case "SUCCESS":
    case "SUCCEEDED":
    case "PAID":
      return "succeeded";
    case "PAY_FAILED":
    case "FAILED":
    case "CLOSED":
    case "CANCELLED":
    case "CANCELED":
      return "failed";
    case "REFUNDED":
    case "PARTIAL_REFUNDED":
      return "refunded";
    default:
      return "pending";
  }
}

function mapRefundStatus(value: unknown): NormalizedRefund["status"] {
  switch (value) {
    case "REFUND_SUCCESS":
    case "SUCCESS":
    case "SUCCEEDED":
      return "succeeded";
    case "REFUND_FAILED":
    case "FAILED":
    case "CLOSED":
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
    case "PAST_DUE":
    case "UNPAID":
      return "past_due";
    case "MERCHANT_CANCELLED":
    case "CHANNEL_CANCELLED":
    case "CANCELLED":
    case "CANCELED":
      return "cancelled";
    case "EXPIRED":
    case "CLOSE":
    case "CLOSED":
      return "expired";
    default:
      return "pending";
  }
}

function normalizePaymentObject(value: JsonRecord): NormalizedPayment {
  const providerPaymentId =
    stringValue(value.acquiringOrderId) ??
    stringValue(value.orderId) ??
    stringValue(value.paymentId) ??
    stringValue(value.id);
  if (!providerPaymentId)
    throw new Error("Waffo payment response is missing id");
  return {
    providerPaymentId,
    status: mapPaymentStatus(
      value.orderStatus ?? value.paymentStatus ?? value.status,
    ),
    amountMinor:
      centsFromAmount(value.orderAmount ?? value.amount) ??
      numberValue(value.amountMinor) ??
      0,
    currency: stringValue(value.orderCurrency ?? value.currency) ?? "USD",
    providerCustomerId: stringValue(value.customerId ?? value.buyerId),
  };
}

function normalizeSubscriptionObject(
  value: JsonRecord,
): NormalizedSubscription {
  const providerSubscriptionId =
    stringValue(value.subscriptionId) ?? stringValue(value.id);
  if (!providerSubscriptionId) {
    throw new Error("Waffo subscription response is missing id");
  }
  const cancelAtPeriodEnd =
    booleanValue(value.cancelAtPeriodEnd) ??
    value.subscriptionStatus === "MERCHANT_CANCELLED";
  return {
    providerSubscriptionId,
    status: mapSubscriptionStatus(value.subscriptionStatus ?? value.status),
    providerCustomerId: stringValue(value.customerId ?? value.buyerId),
    currentPeriodStart: timestampValue(
      value.currentPeriodStart ?? value.periodStart,
    ),
    currentPeriodEnd: timestampValue(value.currentPeriodEnd ?? value.periodEnd),
    cancelAtPeriodEnd,
  };
}

function parseWebhook(input: VerifiedWebhook): {
  providerEventId: string;
  providerEventName: string;
  occurredAt: string;
  result: JsonRecord;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new Error("Waffo webhook body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Waffo webhook must be a JSON object");
  const result = recordValue(parsed.result ?? parsed.data);
  const providerEventName = stringValue(parsed.eventType ?? parsed.type);
  const providerEventId =
    stringValue(parsed.eventId) ??
    stringValue(parsed.notificationId) ??
    stringValue(parsed.id) ??
    stringValue(result?.notificationId) ??
    stringValue(result?.acquiringOrderId) ??
    stringValue(result?.subscriptionId);
  if (!providerEventName || !providerEventId || !result) {
    throw new Error("Waffo webhook is missing required event fields");
  }
  const occurredAt =
    timestampValue(parsed.createdAt ?? parsed.eventTime ?? result.eventTime) ??
    new Date(0).toISOString();
  return { providerEventId, providerEventName, occurredAt, result };
}

function metadataCorrelation(result: JsonRecord) {
  return {
    monetplaneOrderId:
      stringValue(result.orderMerchantExternalId) ??
      stringValue(result.merchantOrderId) ??
      stringValue(result.requestId),
    monetplaneCustomerId:
      stringValue(result.customerMerchantExternalId) ??
      stringValue(result.merchantCustomerId),
  };
}

function baseNormalizedEvent(
  connection: ProviderConnectionContext,
  event: ReturnType<typeof parseWebhook>,
): Omit<NormalizedProviderEvent, "type" | "rawEventReference"> {
  return {
    provider: "waffo",
    providerConnectionId: connection.id,
    providerEventId: event.providerEventId,
    providerEventName: event.providerEventName,
    applicationId: connection.applicationId,
    occurredAt: event.occurredAt,
  };
}

function unknownEvent(
  connection: ProviderConnectionContext,
  event: ReturnType<typeof parseWebhook>,
): NormalizedProviderEvent {
  return {
    ...baseNormalizedEvent(connection, event),
    type: "unknown",
    rawEventReference: event.providerEventId,
  };
}

function normalizeWaffoWebhook(
  connection: ProviderConnectionContext,
  input: VerifiedWebhook,
): NormalizedProviderEvent {
  const event = parseWebhook(input);
  const result = event.result;
  const base = baseNormalizedEvent(connection, event);
  const correlation = metadataCorrelation(result);

  if (event.providerEventName === "PAYMENT_NOTIFICATION") {
    const payment = normalizePaymentObject(result);
    const subscriptionId = stringValue(
      recordValue(result.subscriptionInfo)?.subscriptionId,
    );
    return {
      ...base,
      ...correlation,
      type:
        payment.status === "succeeded" ? "payment.succeeded" : "payment.failed",
      providerPaymentId: payment.providerPaymentId,
      providerSubscriptionId: subscriptionId,
      providerCustomerId: payment.providerCustomerId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "REFUND_NOTIFICATION") {
    const providerRefundId =
      stringValue(result.refundId) ?? stringValue(result.refundTicketId);
    const providerPaymentId =
      stringValue(result.acquiringOrderId) ?? stringValue(result.orderId);
    if (!providerRefundId || !providerPaymentId)
      return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "payment.refunded",
      providerRefundId,
      providerPaymentId,
      providerCustomerId: stringValue(result.customerId ?? result.buyerId),
      amountMinor: centsFromAmount(result.refundAmount),
      currency: stringValue(result.refundCurrency ?? result.orderCurrency),
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "SUBSCRIPTION_STATUS_NOTIFICATION") {
    const subscription = normalizeSubscriptionObject(result);
    const normalizedType: NormalizedProviderEvent["type"] =
      subscription.status === "active"
        ? "subscription.activated"
        : subscription.status === "cancelled"
          ? "subscription.cancelled"
          : subscription.status === "expired"
            ? "subscription.expired"
            : "subscription.updated";
    return {
      ...base,
      ...correlation,
      type: normalizedType,
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCustomerId: subscription.providerCustomerId,
      subscriptionStatus: subscription.status,
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION") {
    const subscription = normalizeSubscriptionObject(result);
    return {
      ...base,
      ...correlation,
      type: "subscription.renewed",
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCustomerId: subscription.providerCustomerId,
      subscriptionStatus: subscription.status,
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "SUBSCRIPTION_CHANGE_NOTIFICATION") {
    const subscription = normalizeSubscriptionObject(result);
    return {
      ...base,
      ...correlation,
      type: "subscription.updated",
      providerSubscriptionId: subscription.providerSubscriptionId,
      providerCustomerId: subscription.providerCustomerId,
      subscriptionStatus: subscription.status,
      subscriptionPeriodStart: subscription.currentPeriodStart,
      subscriptionPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      rawEventReference: event.providerEventId,
    };
  }

  return unknownEvent(connection, event);
}

export function createWaffoProviderAdapter(
  options: WaffoAdapterOptions = {},
): PaymentProviderAdapter {
  return {
    provider: "waffo",

    getCapabilities() {
      return WAFFO_CAPABILITIES;
    },

    async createCheckout(connection, input): Promise<CheckoutResult> {
      if (input.items.length !== 1) {
        throw new Error(
          "Waffo checkout supports exactly one mapped product per checkout",
        );
      }
      const item = input.items[0];
      if (!item) throw new Error("Waffo checkout requires one item");
      const productId = catalogProductId(connection, item.priceId);
      const payload = {
        productId,
        quantity: item.quantity,
        currency: input.currency,
        successRedirectUrl: input.successUrl,
        cancelRedirectUrl: input.cancelUrl,
        orderMerchantExternalId: input.monetplaneOrderId,
        customerMerchantExternalId: input.monetplaneCustomerId,
        metadata: {
          ...(input.metadata ?? {}),
          monetplane_application_id: input.applicationId,
          monetplane_order_id: input.monetplaneOrderId,
          monetplane_customer_id: input.monetplaneCustomerId,
          monetplane_price_id: item.priceId,
        },
      } satisfies JsonRecord;
      const response = await waffoRequest(
        connection,
        options,
        input.billingMode === "subscription"
          ? "/api/v1/subscription/create"
          : "/api/v1/order/create",
        payload,
      );
      const providerCheckoutId =
        stringValue(response.checkoutId) ??
        stringValue(response.orderId) ??
        stringValue(response.subscriptionId);
      const checkoutUrl =
        stringValue(response.checkoutUrl) ??
        stringValue(response.orderAction) ??
        stringValue(response.paymentUrl);
      if (!providerCheckoutId || !checkoutUrl) {
        throw new Error(
          "Waffo checkout response is missing checkout id or url",
        );
      }
      return {
        providerCheckoutId,
        checkoutUrl,
        providerCustomerId: stringValue(
          response.customerId ?? response.buyerId,
        ),
        reconciliationMetadata: {
          monetplane_order_id: input.monetplaneOrderId,
          monetplane_customer_id: input.monetplaneCustomerId,
          waffo_product_id: productId,
        },
      };
    },

    async getPayment(connection, input): Promise<NormalizedPayment> {
      const response = await waffoRequest(
        connection,
        options,
        "/api/v1/order/inquiry",
        {
          acquiringOrderId: input.providerPaymentId,
        },
      );
      return normalizePaymentObject(response);
    },

    async getSubscription(connection, input): Promise<NormalizedSubscription> {
      const response = await waffoRequest(
        connection,
        options,
        "/api/v1/subscription/inquiry",
        { subscriptionId: input.providerSubscriptionId },
      );
      return normalizeSubscriptionObject(response);
    },

    async cancelSubscription(
      connection,
      input: CancelSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const response = await waffoRequest(
        connection,
        options,
        "/api/v1/subscription/cancel",
        { subscriptionId: input.providerSubscriptionId },
      );
      return normalizeSubscriptionObject({
        subscriptionId: input.providerSubscriptionId,
        ...response,
      });
    },

    async updateSubscription(
      connection,
      input: UpdateSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const response = await waffoRequest(
        connection,
        options,
        "/api/v1/subscription/change",
        {
          subscriptionId: input.providerSubscriptionId,
          productId: input.providerPriceId,
          metadata: input.metadata,
        },
      );
      return normalizeSubscriptionObject({
        subscriptionId: input.providerSubscriptionId,
        ...response,
      });
    },

    async refundPayment(
      connection,
      input: RefundPaymentInput,
    ): Promise<NormalizedRefund> {
      const response = await waffoRequest(
        connection,
        options,
        "/api/v1/order/refund",
        {
          acquiringOrderId: input.providerPaymentId,
          refundAmount: input.amountMinor,
        },
      );
      const providerRefundId =
        stringValue(response.refundId) ?? stringValue(response.refundTicketId);
      if (!providerRefundId)
        throw new Error("Waffo refund response is missing id");
      return {
        providerRefundId,
        providerPaymentId: input.providerPaymentId,
        status: mapRefundStatus(response.refundStatus ?? response.status),
        amountMinor:
          centsFromAmount(response.refundAmount) ?? input.amountMinor,
      };
    },

    async verifyWebhook(
      connection,
      input: VerifyWebhookInput,
    ): Promise<VerifiedWebhook> {
      const signature = headerValue(input.headers, "x-signature");
      if (!signature) {
        throw new InvalidProviderWebhookSignatureError(
          "Missing Waffo webhook signature",
        );
      }
      const expected = signatureFor(
        input.rawBody,
        requiredCredential(connection, "webhookSecret"),
      );
      if (!safeEqualHex(expected, signature)) {
        throw new InvalidProviderWebhookSignatureError(
          "Invalid Waffo webhook signature",
        );
      }
      return { rawBody: input.rawBody };
    },

    async normalizeWebhook(
      connection,
      input: VerifiedWebhook,
    ): Promise<NormalizedProviderEvent> {
      return normalizeWaffoWebhook(connection, input);
    },
  };
}
