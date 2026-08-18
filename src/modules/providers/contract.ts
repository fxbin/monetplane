export const PROVIDER_CAPABILITIES = [
  "one_time_checkout",
  "recurring_subscription",
  "monthly_interval",
  "annual_interval",
  "refund",
  "subscription_cancel",
  "subscription_update",
  "customer_portal",
  "provider_hosted_checkout",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];
export type ProviderCapabilities = Readonly<Record<ProviderCapability, boolean>>;

export type ProviderMode = "test" | "live";
export type CheckoutBillingMode = "one_time" | "subscription";

export type ProviderConnectionContext = {
  id: string;
  applicationId: string;
  provider: string;
  mode: ProviderMode;
  metadata: Record<string, unknown>;
  credentials: Readonly<Record<string, string>>;
};

export type CreateCheckoutInput = {
  applicationId: string;
  monetplaneOrderId: string;
  monetplaneCustomerId: string;
  billingMode: CheckoutBillingMode;
  interval?: "month" | "year";
  currency: string;
  items: Array<{
    productId: string;
    priceId: string;
    quantity: number;
    unitAmountMinor: number;
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
};
export type NormalizedRefund = {
  providerRefundId: string;
  providerPaymentId: string;
  status: "pending" | "succeeded" | "failed";
  amountMinor?: number;
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
  providerSubscriptionId?: string;
  monetplaneOrderId?: string;
  monetplaneCustomerId?: string;
  amountMinor?: number;
  currency?: string;
  rawEventReference: string;
};

export interface PaymentProviderAdapter {
  readonly provider: string;
  getCapabilities(connection: ProviderConnectionContext): ProviderCapabilities;
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
  verifyWebhook(
    connection: ProviderConnectionContext,
    input: VerifyWebhookInput,
  ): Promise<VerifiedWebhook>;
  normalizeWebhook(
    connection: ProviderConnectionContext,
    input: VerifiedWebhook,
  ): Promise<NormalizedProviderEvent>;
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
