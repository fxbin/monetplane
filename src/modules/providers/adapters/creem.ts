import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CancelSubscriptionInput,
  CheckoutResult,
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

const CREEM_PRODUCTION_API = "https://api.creem.io";
const CREEM_TEST_API = "https://test-api.creem.io";

const CREEM_CAPABILITIES: ProviderCapabilities = {
  one_time_checkout: true,
  recurring_subscription: true,
  monthly_interval: true,
  annual_interval: true,
  refund: false,
  subscription_cancel: true,
  subscription_update: false,
  customer_portal: false,
  provider_hosted_checkout: true,
};

type FetchLike = typeof fetch;

type CreemAdapterOptions = {
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

function providerObjectId(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!isRecord(value)) return undefined;
  return stringValue(value.id);
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
  if (!value) throw new Error(`Creem credential ${key} is required`);
  return value;
}

function baseUrl(
  connection: ProviderConnectionContext,
  options: CreemAdapterOptions,
): string {
  const configured =
    connection.mode === "test"
      ? options.baseUrls?.test
      : options.baseUrls?.live;
  const official =
    connection.mode === "test" ? CREEM_TEST_API : CREEM_PRODUCTION_API;
  return (configured ?? official).replace(/\/+$/, "");
}

async function creemRequest(
  connection: ProviderConnectionContext,
  options: CreemAdapterOptions,
  path: string,
  init?: RequestInit,
): Promise<JsonRecord> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl(connection, options)}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": requiredCredential(connection, "apiKey"),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `Creem returned invalid JSON (${response.status} ${response.statusText})`,
      );
    }
  }

  if (!response.ok) {
    const record = recordValue(body);
    const message =
      stringValue(record?.message) ??
      stringValue(record?.error) ??
      `Creem request failed (${response.status} ${response.statusText})`;
    throw new Error(message);
  }
  if (!isRecord(body)) throw new Error("Creem response must be a JSON object");
  return body;
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
    `Creem catalog mapping is missing for MonetPlane price ${monetplanePriceId}`,
  );
}

function mapPaymentStatus(value: unknown): NormalizedPayment["status"] {
  switch (value) {
    case "paid":
      return "succeeded";
    case "refunded":
    case "partialRefund":
    case "partially_refunded":
      return "refunded";
    case "declined":
    case "chargedBack":
    case "chargeback":
    case "uncollectible":
    case "void":
    case "canceled":
      return "failed";
    default:
      return "pending";
  }
}

function mapSubscriptionStatus(
  value: unknown,
): NormalizedSubscription["status"] {
  switch (value) {
    case "active":
    case "scheduled_cancel":
      return "active";
    case "unpaid":
      return "past_due";
    case "canceled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return "pending";
  }
}

function normalizeSubscriptionObject(
  value: JsonRecord,
): NormalizedSubscription {
  const id = stringValue(value.id);
  if (!id) throw new Error("Creem subscription response is missing id");
  return {
    providerSubscriptionId: id,
    status: mapSubscriptionStatus(value.status),
    providerCustomerId: providerObjectId(value.customer),
    currentPeriodStart: stringValue(value.current_period_start_date),
    currentPeriodEnd: stringValue(value.current_period_end_date),
    cancelAtPeriodEnd: value.status === "scheduled_cancel",
  };
}

function parseWebhook(input: VerifiedWebhook): {
  providerEventId: string;
  providerEventName: string;
  occurredAt: string;
  object: JsonRecord;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawBody) as unknown;
  } catch {
    throw new Error("Creem webhook body is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("Creem webhook must be a JSON object");
  const providerEventId = stringValue(parsed.id);
  const providerEventName = stringValue(parsed.eventType);
  const createdAt = numberValue(parsed.created_at);
  const object = recordValue(parsed.object);
  if (
    !providerEventId ||
    !providerEventName ||
    createdAt === undefined ||
    !object
  ) {
    throw new Error("Creem webhook is missing required event fields");
  }
  const occurredAt = new Date(createdAt).toISOString();
  return { providerEventId, providerEventName, occurredAt, object };
}

function metadataCorrelation(object: JsonRecord) {
  const metadata = recordValue(object.metadata);
  return {
    monetplaneOrderId:
      stringValue(metadata?.monetplane_order_id) ??
      stringValue(object.request_id),
    monetplaneCustomerId: stringValue(metadata?.monetplane_customer_id),
  };
}

function baseNormalizedEvent(
  connection: ProviderConnectionContext,
  event: ReturnType<typeof parseWebhook>,
): Omit<NormalizedProviderEvent, "type" | "rawEventReference"> {
  return {
    provider: "creem",
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

function normalizeCreemWebhook(
  connection: ProviderConnectionContext,
  input: VerifiedWebhook,
): NormalizedProviderEvent {
  const event = parseWebhook(input);
  const object = event.object;
  const base = baseNormalizedEvent(connection, event);
  const correlation = metadataCorrelation(object);
  const customerId = providerObjectId(object.customer);

  if (event.providerEventName === "checkout.completed") {
    const order = recordValue(object.order);
    const orderType = stringValue(order?.type);
    const transactionId = providerObjectId(order?.transaction);
    const subscriptionId = providerObjectId(object.subscription);

    if (orderType === "recurring" || subscriptionId) {
      if (!subscriptionId) return unknownEvent(connection, event);
      return {
        ...base,
        ...correlation,
        type: "subscription.created",
        providerSubscriptionId: subscriptionId,
        providerCustomerId: customerId ?? providerObjectId(order?.customer),
        subscriptionStatus: "pending",
        rawEventReference: event.providerEventId,
      };
    }

    if (!transactionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "payment.succeeded",
      providerPaymentId: transactionId,
      providerCustomerId: customerId ?? providerObjectId(order?.customer),
      amountMinor:
        numberValue(order?.amount_paid) ??
        numberValue(order?.amount_due) ??
        numberValue(order?.amount),
      currency: stringValue(order?.currency),
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.active") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "subscription.created",
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      subscriptionStatus: "pending",
      subscriptionPeriodStart: stringValue(object.current_period_start_date),
      subscriptionPeriodEnd: stringValue(object.current_period_end_date),
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.paid") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "subscription.renewed",
      providerSubscriptionId: subscriptionId,
      providerPaymentId: stringValue(object.last_transaction_id),
      providerCustomerId: customerId,
      subscriptionStatus: "active",
      subscriptionPeriodStart: stringValue(object.current_period_start_date),
      subscriptionPeriodEnd: stringValue(object.current_period_end_date),
      cancelAtPeriodEnd: object.status === "scheduled_cancel",
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.past_due") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "payment.failed",
      providerSubscriptionId: subscriptionId,
      providerPaymentId:
        stringValue(object.last_transaction_id) ??
        `creem-event:${event.providerEventId}`,
      providerCustomerId: customerId,
      amountMinor: numberValue(recordValue(object.product)?.price),
      currency: stringValue(recordValue(object.product)?.currency),
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.scheduled_cancel") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "subscription.updated",
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      subscriptionStatus: "active",
      subscriptionPeriodStart: stringValue(object.current_period_start_date),
      subscriptionPeriodEnd: stringValue(object.current_period_end_date),
      cancelAtPeriodEnd: true,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.canceled") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "subscription.cancelled",
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      subscriptionPeriodStart: stringValue(object.current_period_start_date),
      subscriptionPeriodEnd: stringValue(object.current_period_end_date),
      cancelAtPeriodEnd: false,
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.expired") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "subscription.expired",
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      subscriptionPeriodStart: stringValue(object.current_period_start_date),
      subscriptionPeriodEnd: stringValue(object.current_period_end_date),
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "subscription.update") {
    const subscriptionId = stringValue(object.id);
    if (!subscriptionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "subscription.updated",
      providerSubscriptionId: subscriptionId,
      providerCustomerId: customerId,
      subscriptionStatus: mapSubscriptionStatus(object.status),
      subscriptionPeriodStart: stringValue(object.current_period_start_date),
      subscriptionPeriodEnd: stringValue(object.current_period_end_date),
      cancelAtPeriodEnd: object.status === "scheduled_cancel",
      rawEventReference: event.providerEventId,
    };
  }

  if (event.providerEventName === "refund.created") {
    const transaction = recordValue(object.transaction);
    const refundId = stringValue(object.id);
    const transactionId = stringValue(transaction?.id);
    if (!refundId || !transactionId) return unknownEvent(connection, event);
    return {
      ...base,
      ...correlation,
      type: "payment.refunded",
      providerPaymentId: transactionId,
      providerRefundId: refundId,
      providerSubscriptionId: providerObjectId(object.subscription),
      providerCustomerId: customerId,
      amountMinor: numberValue(object.refund_amount),
      currency: stringValue(object.refund_currency),
      rawEventReference: event.providerEventId,
    };
  }

  return unknownEvent(connection, event);
}

export function createCreemProviderAdapter(
  options: CreemAdapterOptions = {},
): PaymentProviderAdapter {
  return {
    provider: "creem",

    getCapabilities() {
      return CREEM_CAPABILITIES;
    },

    async createCheckout(connection, input): Promise<CheckoutResult> {
      if (input.items.length !== 1) {
        throw new Error(
          "Creem checkout supports exactly one mapped product per checkout",
        );
      }
      const item = input.items[0];
      if (!item) throw new Error("Creem checkout requires one item");
      const productId = catalogProductId(connection, item.priceId);
      const metadata: Record<string, string> = {
        ...(input.metadata ?? {}),
        monetplane_application_id: input.applicationId,
        monetplane_order_id: input.monetplaneOrderId,
        monetplane_customer_id: input.monetplaneCustomerId,
        monetplane_price_id: item.priceId,
        monetplane_cancel_url: input.cancelUrl,
      };
      const customer = input.providerCustomerId
        ? { id: input.providerCustomerId }
        : undefined;
      const response = await creemRequest(
        connection,
        options,
        "/v1/checkouts",
        {
          method: "POST",
          body: JSON.stringify({
            product_id: productId,
            request_id: input.monetplaneOrderId,
            units: item.quantity,
            customer,
            success_url: input.successUrl,
            metadata,
          }),
        },
      );
      const providerCheckoutId = stringValue(response.id);
      const checkoutUrl = stringValue(response.checkout_url);
      if (!providerCheckoutId || !checkoutUrl) {
        throw new Error(
          "Creem checkout response is missing id or checkout_url",
        );
      }
      return {
        providerCheckoutId,
        checkoutUrl,
        providerCustomerId: providerObjectId(response.customer),
        reconciliationMetadata: {
          monetplane_order_id: input.monetplaneOrderId,
          monetplane_customer_id: input.monetplaneCustomerId,
          requestId: input.monetplaneOrderId,
          creemProductId: productId,
        },
      };
    },

    async getPayment(
      connection,
      input: GetPaymentInput,
    ): Promise<NormalizedPayment> {
      const response = await creemRequest(
        connection,
        options,
        `/v1/transactions?transaction_id=${encodeURIComponent(input.providerPaymentId)}`,
      );
      const id = stringValue(response.id);
      const amount =
        numberValue(response.amount_paid) ?? numberValue(response.amount);
      const currency = stringValue(response.currency);
      if (!id || amount === undefined || !currency) {
        throw new Error("Creem transaction response is incomplete");
      }
      return {
        providerPaymentId: id,
        status: mapPaymentStatus(response.status),
        amountMinor: amount,
        currency,
        providerCustomerId: providerObjectId(response.customer),
      };
    },

    async getSubscription(
      connection,
      input: GetSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const response = await creemRequest(
        connection,
        options,
        `/v1/subscriptions?subscription_id=${encodeURIComponent(input.providerSubscriptionId)}`,
      );
      return normalizeSubscriptionObject(response);
    },

    async cancelSubscription(
      connection,
      input: CancelSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const response = await creemRequest(
        connection,
        options,
        `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({ mode: "immediate", onExecute: "cancel" }),
        },
      );
      return normalizeSubscriptionObject(response);
    },

    async updateSubscription(
      _connection,
      _input: UpdateSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      throw new UnsupportedProviderCapabilityError(
        "creem",
        "subscription_update",
      );
    },

    async refundPayment(
      _connection,
      _input: RefundPaymentInput,
    ): Promise<NormalizedRefund> {
      throw new UnsupportedProviderCapabilityError("creem", "refund");
    },

    async verifyWebhook(
      connection,
      input: VerifyWebhookInput,
    ): Promise<VerifiedWebhook> {
      const signature = headerValue(input.headers, "creem-signature")?.trim();
      const secret = requiredCredential(connection, "webhookSecret");
      if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) {
        throw new InvalidProviderWebhookSignatureError();
      }
      const expected = createHmac("sha256", secret)
        .update(input.rawBody)
        .digest("hex");
      const expectedBuffer = Buffer.from(expected, "hex");
      const signatureBuffer = Buffer.from(signature, "hex");
      if (
        expectedBuffer.length !== signatureBuffer.length ||
        !timingSafeEqual(expectedBuffer, signatureBuffer)
      ) {
        throw new InvalidProviderWebhookSignatureError();
      }
      return { rawBody: input.rawBody };
    },

    async normalizeWebhook(
      connection,
      input: VerifiedWebhook,
    ): Promise<NormalizedProviderEvent> {
      return normalizeCreemWebhook(connection, input);
    },
  };
}

export const creemProviderAdapter = createCreemProviderAdapter();
