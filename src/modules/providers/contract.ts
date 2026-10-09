export const PROVIDER_CAPABILITIES = [
  "one_time_checkout",
  "recurring_subscription",
  "monthly_interval",
  "annual_interval",
  "weekly_interval",
  "trial_periods",
  "refund",
  "subscription_cancel",
  "subscription_update",
  "customer_portal",
  "provider_hosted_checkout",
  "catalog_provisioning",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];
export type ProviderCapabilities = Readonly<
  Record<ProviderCapability, boolean>
>;

export type ProviderMode = "test" | "live";
export type ProviderOperationFailureKind = "rejected" | "outcome_uncertain";
export type CheckoutBillingMode = "one_time" | "subscription";

export type ProviderConnectionContext = {
  id: string;
  applicationId: string;
  provider: string;
  mode: ProviderMode;
  metadata: Record<string, unknown>;
  credentials: Readonly<Record<string, string>>;
};

export type ProviderConnectionValidation = {
  summary: string;
};

export type CreateCheckoutInput = {
  applicationId: string;
  monetplaneOrderId: string;
  monetplaneCustomerId: string;
  customerEmail?: string;
  billingMode: CheckoutBillingMode;
  interval?: "week" | "month" | "year";
  /** Trial window from the price (pricing v2); providers gate on capability. */
  trialPeriodDays?: number;
  currency: string;
  items: Array<{
    productId: string;
    productName?: string;
    priceId: string;
    quantity: number;
    unitAmountMinor: number;
    /**
     * Persisted catalog mapping for this price (#155), resolved by the
     * provider runtime from provider_catalog_mappings before the adapter
     * call. Adapters prefer it over their legacy connection-metadata
     * catalog so existing connections keep working unchanged.
     */
    providerProductId?: string;
  }>;
  successUrl: string;
  cancelUrl: string;
  providerCustomerId?: string;
  metadata?: Record<string, string>;
};

export type CheckoutResult = {
  providerCheckoutId: string;
  checkoutUrl: string;
  providerCustomerId?: string;
  reconciliationMetadata: Record<string, string>;
};

export type GetPaymentInput = { providerPaymentId: string };
export type NormalizedPayment = {
  providerPaymentId: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  amountMinor: number;
  currency: string;
  providerCustomerId?: string;
};

export type GetSubscriptionInput = { providerSubscriptionId: string };
export type CancelSubscriptionInput = { providerSubscriptionId: string };
export type UpdateSubscriptionInput = {
  providerSubscriptionId: string;
  providerPriceId?: string;
  metadata?: Record<string, string>;
};
export type NormalizedSubscription = {
  providerSubscriptionId: string;
  status: "pending" | "active" | "past_due" | "cancelled" | "expired";
  providerCustomerId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
};

export type RefundPaymentInput = {
  providerPaymentId: string;
  amountMinor?: number;
  requestId?: string;
};
export type NormalizedRefund = {
  providerRefundId: string;
  providerPaymentId: string;
  status: "pending" | "succeeded" | "failed";
  amountMinor?: number;
};

/**
 * Read-only provider catalog product lookup (#155). Optional adapter
 * operation used by the console "link existing product" flow: the adapter
 * fetches the provider-side product and normalizes it into the fields the
 * link validation compares against a MonetPlane price. Providers without a
 * product API leave this unimplemented and the link flow fails closed.
 */
export type GetCatalogProductInput = { providerProductId: string };

export type NormalizedProviderCatalogProduct = {
  providerProductId: string;
  name: string | null;
  status: "active" | "archived" | "unknown";
  /** Provider-side environment of the product, normalized from provider terms. */
  mode: ProviderMode | "unknown";
  billingType: "one_time" | "recurring";
  amountMinor: number;
  currency: string;
  recurringInterval: "week" | "month" | "year" | null;
  intervalCount: number | null;
  taxCategory: string | null;
};

/**
 * Catalog provisioning input (#156): create a provider product from a
 * MonetPlane price. `idempotencyKey` is a caller-stable value (the
 * persisted mapping row id) so a re-sent create after a crash dedupes at
 * the provider instead of producing a duplicate product — only for
 * providers whose documented contract supports it (Creem's
 * Idempotency-Key header, verified 2026-10-08).
 */
export type CreateCatalogProductInput = {
  name: string;
  description: string | null;
  amountMinor: number;
  currency: string;
  billingType: "one_time" | "recurring";
  recurringInterval: "week" | "month" | "year" | null;
  intervalCount: number | null;
  taxCategory: string | null;
  idempotencyKey: string;
};

export type CreatedCatalogProduct = { providerProductId: string };

/**
 * Optional hosted payment-management redirect (#71). Providers that expose a
 * native customer billing portal may implement this; the customer portal only
 * offers the redirect when the active connection both implements the method
 * and claims the `customer_portal` capability.
 */
export type CreateCustomerPortalSessionInput = {
  providerCustomerId?: string;
  returnUrl?: string;
};
export type CustomerPortalSessionResult = {
  url: string;
};

export type VerifyWebhookInput = {
  rawBody: string;
  headers: Readonly<Record<string, string | undefined>>;
};
export type VerifiedWebhook = { rawBody: string };

export const NORMALIZED_PROVIDER_EVENT_TYPES = [
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "subscription.created",
  "subscription.activated",
  "subscription.renewed",
  "subscription.updated",
  "subscription.cancelled",
  "subscription.expired",
  "unknown",
] as const;
export type NormalizedProviderEventType =
  (typeof NORMALIZED_PROVIDER_EVENT_TYPES)[number];

export type NormalizedProviderEvent = {
  provider: string;
  providerConnectionId: string;
  providerEventId: string;
  providerEventName: string;
  type: NormalizedProviderEventType;
  applicationId: string;
  occurredAt: string;
  providerCustomerId?: string;
  providerPaymentId?: string;
  providerRefundId?: string;
  providerSubscriptionId?: string;
  monetplaneOrderId?: string;
  monetplaneCustomerId?: string;
  amountMinor?: number;
  currency?: string;
  subscriptionStatus?: NormalizedSubscription["status"];
  subscriptionPeriodStart?: string;
  subscriptionPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  rawEventReference: string;
};

export interface PaymentProviderAdapter {
  readonly provider: string;
  getCapabilities(connection: ProviderConnectionContext): ProviderCapabilities;
  validateConnection?(
    connection: ProviderConnectionContext,
  ): Promise<ProviderConnectionValidation>;
  createCheckout(
    connection: ProviderConnectionContext,
    input: CreateCheckoutInput,
  ): Promise<CheckoutResult>;
  getPayment(
    connection: ProviderConnectionContext,
    input: GetPaymentInput,
  ): Promise<NormalizedPayment>;
  getSubscription(
    connection: ProviderConnectionContext,
    input: GetSubscriptionInput,
  ): Promise<NormalizedSubscription>;
  cancelSubscription(
    connection: ProviderConnectionContext,
    input: CancelSubscriptionInput,
  ): Promise<NormalizedSubscription>;
  updateSubscription(
    connection: ProviderConnectionContext,
    input: UpdateSubscriptionInput,
  ): Promise<NormalizedSubscription>;
  refundPayment(
    connection: ProviderConnectionContext,
    input: RefundPaymentInput,
  ): Promise<NormalizedRefund>;
  /**
   * Optional: hosted payment-management redirect for end customers (#71).
   * Capability gating is enforced by the runtime — callers must check
   * `customer_portal` and must treat a missing implementation as unsupported.
   */
  createCustomerPortalSession?(
    connection: ProviderConnectionContext,
    input: CreateCustomerPortalSessionInput,
  ): Promise<CustomerPortalSessionResult>;
  /**
   * Optional: read-only catalog product lookup for the console link flow
   * (#155). A missing implementation means the provider cannot verify
   * existing products, and linking must fail closed rather than guess.
   */
  getCatalogProduct?(
    connection: ProviderConnectionContext,
    input: GetCatalogProductInput,
  ): Promise<NormalizedProviderCatalogProduct>;
  /**
   * Optional: provider product creation for the provisioning flow (#156),
   * gated by the `catalog_provisioning` capability. Returns only the
   * created provider product id — the caller MUST re-read the product
   * through getCatalogProduct and compare it against the MonetPlane price
   * before trusting the create (bidirectional verification). Network I/O
   * must stay outside any database transaction.
   */
  createCatalogProduct?(
    connection: ProviderConnectionContext,
    input: CreateCatalogProductInput,
  ): Promise<CreatedCatalogProduct>;
  verifyWebhook(
    connection: ProviderConnectionContext,
    input: VerifyWebhookInput,
  ): Promise<VerifiedWebhook>;
  normalizeWebhook(
    connection: ProviderConnectionContext,
    input: VerifiedWebhook,
  ): Promise<NormalizedProviderEvent>;
}

export class ProviderOperationError extends Error {
  constructor(
    message: string,
    public readonly failureKind: ProviderOperationFailureKind,
    /**
     * HTTP status when the failure came from a provider response (#156):
     * lets callers distinguish retryable rate limits (429) from other
     * deterministic 4xx rejections without parsing messages.
     */
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderOperationError";
  }
}

export class UnsupportedProviderCapabilityError extends Error {
  constructor(
    public readonly provider: string,
    public readonly capability: ProviderCapability,
  ) {
    super(`Provider ${provider} does not support ${capability}`);
    this.name = "UnsupportedProviderCapabilityError";
  }
}

export class InvalidProviderWebhookSignatureError extends Error {
  constructor(message = "Invalid provider webhook signature") {
    super(message);
    this.name = "InvalidProviderWebhookSignatureError";
  }
}

export class ProviderApplicationMismatchError extends Error {
  constructor(message = "Provider request application context mismatch") {
    super(message);
    this.name = "ProviderApplicationMismatchError";
  }
}

/**
 * The provider's adapter does not implement the optional catalog product
 * lookup (#155). Distinct from ProviderOperationError so the console link
 * flow can surface "unsupported provider" instead of a lookup failure.
 */
export class ProviderCatalogLookupUnsupportedError extends Error {
  constructor(public readonly provider: string) {
    super(`Provider ${provider} does not support catalog product lookup`);
    this.name = "ProviderCatalogLookupUnsupportedError";
  }
}

export function classifyProviderOperationFailure(
  error: unknown,
): ProviderOperationFailureKind {
  if (error instanceof ProviderOperationError) return error.failureKind;
  if (
    error instanceof UnsupportedProviderCapabilityError ||
    error instanceof ProviderApplicationMismatchError
  ) {
    return "rejected";
  }
  return "outcome_uncertain";
}
