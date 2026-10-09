import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CancelSubscriptionInput,
  CheckoutResult,
  CreateCatalogProductInput,
  CreatedCatalogProduct,
  GetCatalogProductInput,
  GetPaymentInput,
  GetSubscriptionInput,
  NormalizedPayment,
  NormalizedProviderCatalogProduct,
  NormalizedProviderEvent,
  NormalizedRefund,
  NormalizedSubscription,
  PaymentProviderAdapter,
  ProviderCapabilities,
  ProviderConnectionContext,
  ProviderMode,
  RefundPaymentInput,
  UpdateSubscriptionInput,
  VerifiedWebhook,
  VerifyWebhookInput,
} from "../contract";
import {
  InvalidProviderWebhookSignatureError,
  ProviderOperationError,
  UnsupportedProviderCapabilityError,
} from "../contract";
// Shared adapter kit (audit A8): JSON guards, credential access, base URL
// resolution, and fetch-JSON boilerplate live in ./shared for all adapters.
import {
  classifyHttpFailure,
  headerValue,
  isRecord,
  type JsonRecord,
  numberValue,
  parseWebhookJson,
  providerBaseUrl,
  providerErrorMessage,
  providerFetchJson,
  recordValue,
  requiredCredential,
  stringValue,
} from "./shared";

const CREEM_PRODUCTION_API = "https://api.creem.io";
const CREEM_TEST_API = "https://test-api.creem.io";

const CREEM_CAPABILITIES: ProviderCapabilities = {
  one_time_checkout: true,
  recurring_subscription: true,
  monthly_interval: true,
  annual_interval: true,
  weekly_interval: false,
  trial_periods: false,
  // POST /v1/refunds supports full refunds by transaction ID (may return
  // pending for async provider confirmation); refund.created webhooks
  // complete the picture (#100).
  refund: true,
  subscription_cancel: true,
  subscription_update: false,
  customer_portal: false,
  provider_hosted_checkout: true,
  catalog_provisioning: true,
};

type FetchLike = typeof fetch;

type CreemAdapterOptions = {
  fetchImpl?: FetchLike;
  baseUrls?: {
    test?: string;
    live?: string;
  };
};

function providerObjectId(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!isRecord(value)) return undefined;
  return stringValue(value.id);
}

/**
 * Money discipline: Creem amount fields are minor-unit integers. A value
 * that parses to a finite non-integer must fail closed — passing it
 * downstream could book a plausible-looking wrong amount (project review
 * 2026-10-04, finding 1.6). Missing values stay undefined so the commerce
 * layer's own fail-closed amount validation decides.
 */
function minorAmountValue(value: unknown): number | undefined {
  const parsed = numberValue(value);
  if (parsed === undefined) return undefined;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(
      `Creem amount is not a safe integer (minor units): ${String(value)}`,
    );
  }
  return parsed;
}

function baseUrl(
  connection: ProviderConnectionContext,
  options: CreemAdapterOptions,
): string {
  return providerBaseUrl(
    connection,
    { test: CREEM_TEST_API, live: CREEM_PRODUCTION_API },
    options.baseUrls,
  );
}

async function creemRequest(
  connection: ProviderConnectionContext,
  options: CreemAdapterOptions,
  path: string,
  init?: RequestInit,
): Promise<JsonRecord> {
  const { status, statusText, payload } = await providerFetchJson(
    `${baseUrl(connection, options)}${path}`,
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-api-key": requiredCredential(connection, "apiKey", "Creem"),
        ...(init?.headers ?? {}),
      },
    },
    { provider: "Creem", fetchImpl: options.fetchImpl },
  );

  if (status < 200 || status >= 300) {
    // Shared classification (roundtable batch 1): Creem previously threw a
    // bare Error for every failure, so deterministic 4xx rejections were
    // classified outcome_uncertain and operators could NEVER retry them.
    throw classifyHttpFailure(
      status,
      providerErrorMessage(
        payload,
        `Creem request failed (${statusText ? `${status} ${statusText}` : `${status}`})`,
      ),
    );
  }
  return payload;
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

/**
 * Fixed Creem billing periods (GET /v1/products ProductEntity, verified
 * 2026-10-08) normalized to MonetPlane interval semantics. `every-day` and
 * unknown periods are deliberately absent: a period we cannot represent
 * cannot be verified against a MonetPlane price, so the lookup fails
 * closed instead of guessing (#155).
 */
const CREEM_FIXED_BILLING_PERIODS: Record<
  string,
  { recurringInterval: "week" | "month" | "year"; intervalCount: number }
> = {
  "every-month": { recurringInterval: "month", intervalCount: 1 },
  "every-three-months": { recurringInterval: "month", intervalCount: 3 },
  "every-six-months": { recurringInterval: "month", intervalCount: 6 },
  "every-year": { recurringInterval: "year", intervalCount: 1 },
};

function creemBillingPeriodToInterval(value: JsonRecord): {
  recurringInterval: "week" | "month" | "year";
  intervalCount: number;
} | null {
  const period = stringValue(value.billing_period);
  // `billing_period` is only REQUIRED for recurring products in the Creem
  // reference (verified 2026-10-08): a one-time product may omit it. An
  // omitted period normalizes to "no interval"; if a recurring MonetPlane
  // price is being compared, the comparison layer flags the missing
  // interval as a mismatch instead of guessing.
  if (!period || period === "once") return null;

  if (period === "custom") {
    const interval = stringValue(value.recurring_interval);
    const count = numberValue(value.recurring_interval_count);
    if (
      (interval === "week" || interval === "month" || interval === "year") &&
      count !== undefined &&
      Number.isSafeInteger(count) &&
      count >= 1
    ) {
      return { recurringInterval: interval, intervalCount: count };
    }
    throw new Error(
      "Creem product has a custom billing interval MonetPlane cannot verify",
    );
  }

  const fixed = CREEM_FIXED_BILLING_PERIODS[period];
  if (fixed) return fixed;
  throw new Error(`Creem product has an unsupported billing period: ${period}`);
}

/**
 * Inverse mapping for creates (#156): MonetPlane interval semantics → the
 * Creem request body. Fixed Creem periods are preferred; anything else
 * (week-based, month xN beyond the fixed set, year xN) becomes the
 * documented `custom` form with recurring_interval + count. Exported for
 * unit tests.
 */
export function creemBillingPeriodFromBody(input: {
  billingType: "one_time" | "recurring";
  recurringInterval: "week" | "month" | "year" | null;
  intervalCount: number | null;
}): Record<string, unknown> {
  if (input.billingType !== "recurring") return {};
  const interval = input.recurringInterval;
  const count = input.intervalCount;
  if (!interval || count === null || count === undefined) {
    throw new Error(
      "Recurring Creem products require a billing interval and count",
    );
  }
  for (const [period, fixed] of Object.entries(CREEM_FIXED_BILLING_PERIODS)) {
    if (fixed.recurringInterval === interval && fixed.intervalCount === count) {
      return { billing_period: period };
    }
  }
  return {
    billing_period: "custom",
    recurring_interval: interval,
    recurring_interval_count: count,
  };
}

/** Creem create-product constraints (reference, verified 2026-10-08). */
const CREEM_CREATE_CURRENCIES = new Set(["USD", "EUR"]);
const CREEM_TAX_CATEGORIES = new Set([
  "saas",
  "digital-goods-service",
  "ebooks",
]);

function creemProductMode(value: unknown): ProviderMode | "unknown" {
  switch (value) {
    case "prod":
      return "live";
    case "test":
    case "sandbox":
      return "test";
    default:
      return "unknown";
  }
}

/**
 * Normalize a Creem ProductEntity into the comparison shape used by the
 * console link flow (#155). Anything required for verification that is
 * missing or unrepresentable throws — the caller fails closed.
 */
export function normalizeCreemCatalogProduct(
  value: JsonRecord,
): NormalizedProviderCatalogProduct {
  const providerProductId = stringValue(value.id);
  const billingType =
    value.billing_type === "onetime"
      ? ("one_time" as const)
      : value.billing_type === "recurring"
        ? ("recurring" as const)
        : undefined;
  const amountMinor = minorAmountValue(value.price);
  const currency = stringValue(value.currency)?.toUpperCase();
  if (
    !providerProductId ||
    !billingType ||
    amountMinor === undefined ||
    !currency
  ) {
    throw new Error(
      "Creem product response is missing id, billing_type, price, or currency",
    );
  }
  const interval = creemBillingPeriodToInterval(value);
  return {
    providerProductId,
    name: stringValue(value.name) ?? null,
    status:
      value.status === "active" || value.status === "archived"
        ? value.status
        : "unknown",
    mode: creemProductMode(value.mode),
    billingType,
    amountMinor,
    currency,
    recurringInterval: interval?.recurringInterval ?? null,
    intervalCount: interval?.intervalCount ?? null,
    taxCategory: stringValue(value.tax_category) ?? null,
  };
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
  const parsed = parseWebhookJson(input.rawBody, "Creem");
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
        minorAmountValue(order?.amount_paid) ??
        minorAmountValue(order?.amount_due) ??
        minorAmountValue(order?.amount),
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
      amountMinor: minorAmountValue(recordValue(object.product)?.price),
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

  if (
    event.providerEventName === "subscription.update" ||
    event.providerEventName === "subscription.trialing" ||
    event.providerEventName === "subscription.paused"
  ) {
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
      amountMinor: minorAmountValue(object.refund_amount),
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
      // Mapping precedence (#155): the persisted provider_catalog_mappings
      // row wins; the legacy connection metadata catalog is the fallback so
      // pre-existing connections keep their exact checkout behavior.
      const productId =
        item.providerProductId ?? catalogProductId(connection, item.priceId);
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
        minorAmountValue(response.amount_paid) ??
        minorAmountValue(response.amount);
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
      connection,
      input: RefundPaymentInput,
    ): Promise<NormalizedRefund> {
      // Live-verified contract (#102): the request body accepts ONLY
      // transaction_id (metadata is rejected), and the 200 response is
      // { status } — no refund id. The authoritative refund id arrives
      // later via the refund.created webhook (object.id); until then a
      // deterministic id keyed to the transaction keeps retries stable.
      const response = await creemRequest(connection, options, "/v1/refunds", {
        method: "POST",
        body: JSON.stringify({
          transaction_id: input.providerPaymentId,
        }),
      });
      const status = stringValue(response.status) ?? "";
      const normalizedStatus: NormalizedRefund["status"] =
        status === "succeeded"
          ? "succeeded"
          : status === "failed" || status === "canceled"
            ? "failed"
            : "pending";
      return {
        providerRefundId: `refund:${input.providerPaymentId}`,
        providerPaymentId: input.providerPaymentId,
        status: normalizedStatus,
      };
    },

    async getCatalogProduct(
      connection,
      input: GetCatalogProductInput,
    ): Promise<NormalizedProviderCatalogProduct> {
      const response = await creemRequest(
        connection,
        options,
        `/v1/products/${encodeURIComponent(input.providerProductId)}`,
      );
      return normalizeCreemCatalogProduct(response);
    },

    async createCatalogProduct(
      connection,
      input: CreateCatalogProductInput,
    ): Promise<CreatedCatalogProduct> {
      // Creem-side pre-flight (reference, verified 2026-10-08): currency
      // must be USD/EUR; price must be 0 (free) or at least 100 minor
      // units; tax_category must be a documented enum when supplied.
      // Violations are deterministic (rejected) — the state machine parks
      // them as failed, never as uncertain.
      const currency = input.currency.toUpperCase();
      if (!CREEM_CREATE_CURRENCIES.has(currency)) {
        throw new ProviderOperationError(
          `Creem only supports ${[...CREEM_CREATE_CURRENCIES].join(" and ")} product currencies, not ${currency}`,
          "rejected",
        );
      }
      if (
        !Number.isSafeInteger(input.amountMinor) ||
        (input.amountMinor !== 0 && input.amountMinor < 100)
      ) {
        throw new ProviderOperationError(
          "Creem product prices must be 0 (free) or at least 100 minor units",
          "rejected",
        );
      }
      if (input.taxCategory && !CREEM_TAX_CATEGORIES.has(input.taxCategory)) {
        throw new ProviderOperationError(
          `Unsupported Creem tax category: ${input.taxCategory}`,
          "rejected",
        );
      }
      if (!input.idempotencyKey.trim()) {
        throw new ProviderOperationError(
          "Creem product creation requires an idempotency key",
          "rejected",
        );
      }

      const body: Record<string, unknown> = {
        name: input.name,
        description: input.description ?? "",
        price: input.amountMinor,
        currency,
        billing_type:
          input.billingType === "one_time" ? "onetime" : "recurring",
        ...creemBillingPeriodFromBody(input),
      };
      if (input.taxCategory) body.tax_category = input.taxCategory;

      const response = await creemRequest(connection, options, "/v1/products", {
        method: "POST",
        headers: { "idempotency-key": input.idempotencyKey.trim() },
        body: JSON.stringify(body),
      });
      const providerProductId = stringValue(response.id);
      if (!providerProductId) {
        throw new Error("Creem create product response is missing id");
      }
      // Only the id is trusted here: the caller must re-read the product
      // via getCatalogProduct and compare before declaring it synced.
      return { providerProductId };
    },

    async verifyWebhook(
      connection,
      input: VerifyWebhookInput,
    ): Promise<VerifiedWebhook> {
      const signature = headerValue(input.headers, "creem-signature")?.trim();
      const secret = requiredCredential(connection, "webhookSecret", "Creem");
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
