import type { WebhookEvent, WebhookEventData } from "@waffo/pancake-ts";
import {
  BillingPeriod,
  verifyWebhook as sdkVerifyWebhook,
  TaxCategory,
  WaffoPancake,
  WaffoPancakeError,
} from "@waffo/pancake-ts";
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
  VerifiedWebhook,
  VerifyWebhookInput,
} from "../contract";
import {
  InvalidProviderWebhookSignatureError,
  ProviderOperationError,
  UnsupportedProviderCapabilityError,
} from "../contract";

/**
 * Waffo Pancake MoR adapter (#93).
 *
 * Protocol source of truth: the official `@waffo/pancake-ts` SDK against
 * the Waffo Pancake platform documented at docs.waffo.ai. The SDK owns
 * request signing (merchant RSA key), webhook signature verification
 * (built-in platform public keys, anti-replay tolerance), hosts, and
 * error semantics.
 *
 * Connection credentials (encrypted envelope):
 *  - merchantId  MER_…   (X-Merchant-Id; the API key's environment is
 *                         derived by the gateway from the key itself)
 *  - privateKey  merchant RSA private key (PEM or base64 PKCS8)
 *  - storeId     STO_…   store that owns the product shells we create
 *
 * Checkout model: Pancake sessions reference exactly ONE product. We
 * create an idempotent "shell" product per (MonetPlane product, billing
 * shape, price) via the SDK's deterministic idempotency (merchantId +
 * path + body) and let the session use the shell's stored price. The
 * MonetPlane order id travels as `orderMerchantExternalId` (inherited by
 * payments/refunds) plus flat metadata for the customer id, which is how
 * webhooks correlate back.
 *
 * Webhooks: `x-waffo-signature` = `t=<ts>,v1=<base64>`; SDK verifies
 * RSA-SHA256 over `${t}.${rawBody}` with per-environment built-in public
 * keys and anti-replay tolerance. Refunds are asynchronous tickets —
 * completion arrives as refund.succeeded / refund.failed webhooks.
 */

const WAFFO_CAPABILITIES: ProviderCapabilities = {
  one_time_checkout: true,
  recurring_subscription: true,
  monthly_interval: true,
  annual_interval: true,
  weekly_interval: true,
  trial_periods: true,
  refund: true,
  subscription_cancel: true,
  subscription_update: false,
  customer_portal: false,
  provider_hosted_checkout: true,
};

type JsonRecord = Record<string, unknown>;

/** Subset of the SDK surface this adapter uses (also the test seam). */
type PancakeClientLike = {
  onetimeProducts: {
    create(params: JsonRecord): Promise<{ product: { id: string } }>;
  };
  subscriptionProducts: {
    create(params: JsonRecord): Promise<{ product: { id: string } }>;
  };
  checkout: {
    createSession(params: JsonRecord): Promise<{
      sessionId: string;
      checkoutUrl: string;
      expiresAt: string;
    }>;
  };
  orders: {
    cancelSubscription(
      params: JsonRecord,
    ): Promise<{ orderId: string; status: string }>;
  };
  auth: {
    issueSessionToken(params: JsonRecord): Promise<{ token: string }>;
  };
  customer: (
    token: string,
    options?: JsonRecord,
  ) => {
    createRefundTicket(params: JsonRecord): Promise<{
      ticket: { id: string; status: string; subjectId: string };
    }>;
  };
};

type VerifyWebhookImpl = (
  payload: string,
  signatureHeader: string | undefined | null,
  options?: { environment?: "test" | "prod" },
) => WebhookEvent;

type WaffoAdapterOptions = {
  clientFactory?: (connection: ProviderConnectionContext) => PancakeClientLike;
  verifyWebhookImpl?: VerifyWebhookImpl;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredCredential(
  connection: ProviderConnectionContext,
  field: string,
): string {
  const credentials = connection.credentials as Record<string, unknown>;
  const value = stringValue(credentials?.[field]);
  if (!value) {
    throw new ProviderOperationError(
      `Waffo connection is missing the ${field} credential`,
      "rejected",
    );
  }
  return value;
}

/**
 * Money: Pancake uses display-value strings ("29.00" USD, "1000" JPY);
 * MonetPlane uses integer minor units. Zero-decimal ISO currencies are
 * converted without cents.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XOF",
  "XPF",
]);

function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

function minorToDisplay(amountMinor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const value = amountMinor / 10 ** decimals;
  return value.toFixed(decimals);
}

function displayToMinor(display: string, currency: string): number | undefined {
  const parsed = Number(display);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.round(parsed * 10 ** currencyDecimals(currency));
}

function pancakeEnvironment(mode: string): "test" | "prod" {
  return mode === "live" ? "prod" : "test";
}

function billingPeriodFor(
  interval: "week" | "month" | "year" | undefined,
): BillingPeriod {
  if (interval === "week") return BillingPeriod.Weekly;
  if (interval === "year") return BillingPeriod.Yearly;
  return BillingPeriod.Monthly;
}

function slugifyProductShell(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "monetplane-product";
}

function classifySdkError(
  error: unknown,
  operation: string,
): ProviderOperationError {
  if (error instanceof WaffoPancakeError) {
    const message = `Waffo rejected ${operation} (HTTP ${error.status})`;
    // 4xx is a deterministic provider rejection; 5xx may have executed
    // server-side, so it stays uncertain (never blind-retried).
    return new ProviderOperationError(
      message,
      error.status >= 500 ? "outcome_uncertain" : "rejected",
    );
  }
  const message =
    error instanceof Error ? error.message : `Waffo ${operation} failed`;
  return new ProviderOperationError(
    `Waffo ${operation} outcome uncertain: ${message}`,
    "outcome_uncertain",
  );
}

function clientFor(
  connection: ProviderConnectionContext,
  options: WaffoAdapterOptions,
): PancakeClientLike {
  if (options.clientFactory) return options.clientFactory(connection);
  const merchantId = requiredCredential(connection, "merchantId");
  const privateKey = requiredCredential(connection, "privateKey");
  return new WaffoPancake({
    merchantId,
    privateKey,
  }) as unknown as PancakeClientLike;
}

/* ------------------------------------------------------------------ */
/* Webhook normalization                                               */
/* ------------------------------------------------------------------ */

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

type ParsedPancakeEvent = WebhookEvent & { data: WebhookEventData };

function parsePancakeEvent(rawBody: string): ParsedPancakeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("Waffo Pancake webhook body is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Waffo Pancake webhook must be a JSON object");
  }
  const eventType = stringValue(parsed.eventType);
  const id = stringValue(parsed.id);
  const timestamp = stringValue(parsed.timestamp);
  const data = isRecord(parsed.data)
    ? (parsed.data as unknown as WebhookEventData)
    : undefined;
  if (!eventType || !id || !timestamp || !data) {
    throw new Error("Waffo Pancake webhook is missing required event fields");
  }
  return parsed as unknown as ParsedPancakeEvent;
}

function subscriptionStatusFrom(
  orderStatus: string | undefined,
  eventType: string,
): NormalizedSubscription["status"] {
  switch (orderStatus) {
    case "active":
      return "active";
    case "past_due":
    case "past-due":
      return "past_due";
    case "canceled":
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "pending":
      return "pending";
    default:
      return eventType === "subscription.activated" ? "active" : "active";
  }
}

function baseEvent(
  connection: ProviderConnectionContext,
  event: ParsedPancakeEvent,
): Omit<NormalizedProviderEvent, "type" | "rawEventReference"> {
  const data = event.data;
  // Correlation: prefer the external id we stamped on the checkout
  // session (inherited by orders/payments/refunds), then session metadata.
  const metadata = isRecord(data.orderMetadata) ? data.orderMetadata : {};
  return {
    provider: "waffo",
    providerConnectionId: connection.id,
    // Delivery UUID — deterministic idempotency identity.
    providerEventId: event.id,
    providerEventName: event.eventType,
    applicationId: connection.applicationId,
    occurredAt: event.timestamp,
    monetplaneOrderId:
      stringValue(data.orderMerchantExternalId) ??
      stringValue(metadata.monetplaneOrderId),
    monetplaneCustomerId:
      stringValue(data.merchantProvidedBuyerIdentity) ??
      stringValue(metadata.monetplaneCustomerId),
  };
}

function normalizeWaffoPancakeWebhook(
  connection: ProviderConnectionContext,
  input: VerifiedWebhook,
): NormalizedProviderEvent {
  const event = parsePancakeEvent(input.rawBody);
  const data = event.data;
  const base = baseEvent(connection, event);
  const unknown = (): NormalizedProviderEvent => ({
    ...base,
    type: "unknown",
    rawEventReference: event.id,
  });

  const amountMinor = displayToMinor(String(data.amount ?? ""), data.currency);

  switch (event.eventType) {
    case "order.completed":
    case "subscription.payment_succeeded": {
      const providerPaymentId = stringValue(data.paymentId) ?? event.eventId;
      return {
        ...base,
        type: "payment.succeeded",
        providerPaymentId,
        providerSubscriptionId:
          event.eventType === "subscription.payment_succeeded"
            ? data.orderId
            : undefined,
        providerCustomerId: base.monetplaneCustomerId ?? undefined,
        amountMinor,
        currency: data.currency,
        rawEventReference: event.id,
      };
    }
    case "subscription.activated":
    case "subscription.renewed":
    case "subscription.recovered":
    case "subscription.plan_changed":
    case "subscription.plan_change_scheduled":
    case "subscription.plan_change_failed":
    case "subscription.canceling":
    case "subscription.uncanceled":
    case "subscription.past_due":
    case "subscription.canceled": {
      if (event.eventType === "subscription.canceled") {
        return {
          ...base,
          type: "subscription.cancelled",
          providerSubscriptionId: data.orderId,
          subscriptionStatus: "cancelled",
          subscriptionPeriodStart: stringValue(data.currentPeriodStart),
          subscriptionPeriodEnd: stringValue(data.currentPeriodEnd),
          rawEventReference: event.id,
        };
      }
      const activated = event.eventType === "subscription.activated";
      const renewing = event.eventType === "subscription.renewed";
      return {
        ...base,
        type: activated
          ? "subscription.activated"
          : renewing
            ? "subscription.renewed"
            : "subscription.updated",
        providerSubscriptionId: data.orderId,
        subscriptionStatus: subscriptionStatusFrom(
          data.orderStatus,
          event.eventType,
        ),
        subscriptionPeriodStart: stringValue(data.currentPeriodStart),
        subscriptionPeriodEnd: stringValue(data.currentPeriodEnd),
        cancelAtPeriodEnd: event.eventType === "subscription.canceling",
        rawEventReference: event.id,
      };
    }
    case "refund.succeeded": {
      const providerPaymentId = stringValue(data.paymentId);
      if (!providerPaymentId) return unknown();
      return {
        ...base,
        type: "payment.refunded",
        providerRefundId: event.eventId,
        providerPaymentId,
        amountMinor,
        rawEventReference: event.id,
      };
    }
    default:
      // refund.failed and any future event types stay visible in the
      // Events timeline without mutating billing state.
      return unknown();
  }
}

/* ------------------------------------------------------------------ */
/* Adapter                                                             */
/* ------------------------------------------------------------------ */

export function createWaffoProviderAdapter(
  options: WaffoAdapterOptions = {},
): PaymentProviderAdapter {
  const verifyImpl: VerifyWebhookImpl =
    options.verifyWebhookImpl ??
    ((payload, signatureHeader, verifyOptions) =>
      sdkVerifyWebhook(payload, signatureHeader, verifyOptions));

  return {
    provider: "waffo",

    getCapabilities(): ProviderCapabilities {
      return WAFFO_CAPABILITIES;
    },

    async createCheckout(
      connection: ProviderConnectionContext,
      input,
    ): Promise<CheckoutResult> {
      if (input.items.length !== 1) {
        throw new UnsupportedProviderCapabilityError(
          "waffo",
          "one_time_checkout",
        );
      }
      const client = clientFor(connection, options);
      const storeId = requiredCredential(connection, "storeId");
      const item = input.items[0];
      const currency = input.currency.toUpperCase();
      const lineTotalMinor = item.unitAmountMinor * item.quantity;
      const shellName = `mp-${slugifyProductShell(
        item.productName ?? item.productId,
      )}`;
      const shellPrices = {
        [currency]: {
          amount: minorToDisplay(lineTotalMinor, currency),
          taxCategory: TaxCategory.SaaS,
        },
      };

      let productId: string;
      try {
        if (input.billingMode === "subscription") {
          const { product } = await client.subscriptionProducts.create({
            storeId,
            name: shellName,
            billingPeriod: billingPeriodFor(input.interval),
            prices: shellPrices,
            metadata: { monetplaneProductId: item.productId },
          });
          productId = product.id;
        } else {
          const { product } = await client.onetimeProducts.create({
            storeId,
            name: shellName,
            prices: shellPrices,
            metadata: { monetplaneProductId: item.productId },
          });
          productId = product.id;
        }
      } catch (error) {
        throw classifySdkError(error, "product shell creation");
      }

      try {
        const session = await client.checkout.createSession({
          productId,
          currency,
          buyerEmail: input.customerEmail,
          successUrl: input.successUrl,
          withTrial:
            input.billingMode === "subscription" && input.trialPeriodDays
              ? true
              : undefined,
          metadata: {
            monetplaneOrderId: input.monetplaneOrderId,
            monetplaneCustomerId: input.monetplaneCustomerId,
          },
          orderMerchantExternalId: input.monetplaneOrderId,
        });
        return {
          providerCheckoutId: session.sessionId,
          checkoutUrl: session.checkoutUrl,
          reconciliationMetadata: {
            // Snake-case keys are the cross-adapter contract the commerce
            // layer greps for when reconciling provider state.
            monetplane_order_id: input.monetplaneOrderId,
            monetplane_customer_id: input.monetplaneCustomerId,
            waffo_session_id: session.sessionId,
            waffo_product_id: productId,
            expires_at: session.expiresAt,
          },
        };
      } catch (error) {
        throw classifySdkError(error, "checkout session creation");
      }
    },

    async getSubscription(): Promise<NormalizedSubscription> {
      // Subscription state arrives via webhooks; synchronous inquiry is
      // intentionally unsupported for the Pancake adapter.
      throw new UnsupportedProviderCapabilityError(
        "waffo",
        "subscription_update",
      );
    },

    async updateSubscription(): Promise<NormalizedSubscription> {
      // Pancake plan changes happen in the Waffo dashboard or via product
      // groups; MonetPlane does not mutate plans programmatically yet.
      throw new UnsupportedProviderCapabilityError(
        "waffo",
        "subscription_update",
      );
    },

    async getPayment(): Promise<NormalizedPayment> {
      // Pancake exposes payments through GraphQL queries; MonetPlane
      // reconciles via webhooks + the operation journal instead, so
      // synchronous payment inquiry is intentionally unsupported.
      throw new UnsupportedProviderCapabilityError(
        "waffo",
        "recurring_subscription",
      );
    },

    async refundPayment(
      connection: ProviderConnectionContext,
      input: RefundPaymentInput,
    ): Promise<NormalizedRefund> {
      const client = clientFor(connection, options);
      const storeId = requiredCredential(connection, "storeId");
      const currency = "USD";
      try {
        const { token } = await client.auth.issueSessionToken({
          storeId,
          buyerIdentity: input.requestId ?? input.providerPaymentId,
        });
        const { ticket } = await client
          .customer(token, {
            environment: pancakeEnvironment(connection.mode),
          })
          .createRefundTicket({
            paymentId: input.providerPaymentId,
            reason: "monetplane operator refund",
            requestedAmount: input.amountMinor
              ? {
                  amount: minorToDisplay(input.amountMinor, currency),
                  currency,
                }
              : undefined,
            refundTicketMerchantExternalId: input.requestId,
          });
        const status: NormalizedRefund["status"] =
          ticket.status === "succeeded"
            ? "succeeded"
            : ticket.status === "rejected"
              ? "failed"
              : "pending";
        return {
          providerRefundId: ticket.id,
          providerPaymentId: input.providerPaymentId,
          status,
          amountMinor: input.amountMinor,
        };
      } catch (error) {
        throw classifySdkError(error, "refund ticket");
      }
    },

    async cancelSubscription(
      connection: ProviderConnectionContext,
      input: CancelSubscriptionInput,
    ): Promise<NormalizedSubscription> {
      const client = clientFor(connection, options);
      try {
        const result = await client.orders.cancelSubscription({
          orderId: input.providerSubscriptionId,
        });
        return {
          providerSubscriptionId: result.orderId,
          status: result.status === "canceled" ? "cancelled" : "active",
          cancelAtPeriodEnd: result.status !== "canceled",
        };
      } catch (error) {
        throw classifySdkError(error, "subscription cancellation");
      }
    },

    async validateConnection(connection: ProviderConnectionContext) {
      const client = clientFor(connection, options);
      const storeId = requiredCredential(connection, "storeId");
      try {
        // Cheap, side-effect-free probe: issuing a short-lived customer
        // session token exercises merchant auth + signing end to end.
        await client.auth.issueSessionToken({
          storeId,
          buyerIdentity: "monetplane-connection-check",
        });
        return { summary: "Merchant credentials verified with Waffo" };
      } catch (error) {
        if (error instanceof ProviderOperationError) throw error;
        throw classifySdkError(error, "connection validation");
      }
    },

    async verifyWebhook(
      connection: ProviderConnectionContext,
      input: VerifyWebhookInput,
    ): Promise<VerifiedWebhook> {
      const signature = headerValue(input.headers, "x-waffo-signature");
      if (!signature) {
        throw new InvalidProviderWebhookSignatureError(
          "Missing x-waffo-signature header",
        );
      }
      try {
        // Environment pinned from the connection so a test key cannot be
        // verified against prod keys (fail closed).
        verifyImpl(input.rawBody, signature, {
          environment: pancakeEnvironment(connection.mode),
        });
      } catch (error) {
        throw new InvalidProviderWebhookSignatureError(
          error instanceof Error
            ? `Waffo Pancake webhook verification failed: ${error.message}`
            : "Waffo Pancake webhook verification failed",
        );
      }
      return { rawBody: input.rawBody };
    },

    async normalizeWebhook(
      connection: ProviderConnectionContext,
      input: VerifiedWebhook,
    ): Promise<NormalizedProviderEvent> {
      return normalizeWaffoPancakeWebhook(connection, input);
    },
  };
}
