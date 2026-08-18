import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  CancelSubscriptionInput,
  CheckoutResult,
  CreateCheckoutInput,
  GetPaymentInput,
  GetSubscriptionInput,
  NormalizedPayment,
  NormalizedProviderEvent,
  NormalizedProviderEventType,
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
  NORMALIZED_PROVIDER_EVENT_TYPES,
} from "../contract";

const MOCK_CAPABILITIES: ProviderCapabilities = {
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

type MockWebhookPayload = {
  id: string;
  type: string;
  occurred_at: string;
  data?: {
    provider_customer_id?: string;
    provider_payment_id?: string;
    provider_subscription_id?: string;
    monetplane_order_id?: string;
    monetplane_customer_id?: string;
    amount_minor?: number;
    currency?: string;
  };
};

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function webhookSecret(connection: ProviderConnectionContext): string {
  const secret = connection.credentials.webhookSecret;
  if (!secret) throw new Error("Mock provider requires webhookSecret");
  return secret;
}

export function signMockWebhookPayload(
  rawBody: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function isKnownEventType(value: string): value is NormalizedProviderEventType {
  return NORMALIZED_PROVIDER_EVENT_TYPES.includes(
    value as NormalizedProviderEventType,
  );
}

export const mockProviderAdapter: PaymentProviderAdapter = {
  provider: "mock",

  getCapabilities() {
    return MOCK_CAPABILITIES;
  },

  async createCheckout(
    connection: ProviderConnectionContext,
    input: CreateCheckoutInput,
  ): Promise<CheckoutResult> {
    const correlation = [
      connection.id,
      input.monetplaneOrderId,
      input.monetplaneCustomerId,
      input.billingMode,
    ].join(":");
    const providerCheckoutId = stableId("mock_checkout", correlation);

    return {
      providerCheckoutId,
      checkoutUrl: `https://mock.monetplane.test/checkout/${providerCheckoutId}`,
      providerCustomerId:
        input.providerCustomerId ??
        stableId("mock_customer", input.monetplaneCustomerId),
      reconciliationMetadata: {
        monetplane_order_id: input.monetplaneOrderId,
        monetplane_customer_id: input.monetplaneCustomerId,
      },
    };
  },

  async getPayment(
    _connection: ProviderConnectionContext,
    input: GetPaymentInput,
  ): Promise<NormalizedPayment> {
    return {
      providerPaymentId: input.providerPaymentId,
      status: "succeeded",
      amountMinor: 0,
      currency: "USD",
    };
  },

  async getSubscription(
    _connection: ProviderConnectionContext,
    input: GetSubscriptionInput,
  ): Promise<NormalizedSubscription> {
    return {
      providerSubscriptionId: input.providerSubscriptionId,
      status: "active",
      cancelAtPeriodEnd: false,
    };
  },

  async cancelSubscription(
    _connection: ProviderConnectionContext,
    input: CancelSubscriptionInput,
  ): Promise<NormalizedSubscription> {
    return {
      providerSubscriptionId: input.providerSubscriptionId,
      status: "cancelled",
      cancelAtPeriodEnd: false,
    };
  },

  async updateSubscription(
    _connection: ProviderConnectionContext,
    input: UpdateSubscriptionInput,
  ): Promise<NormalizedSubscription> {
    return {
      providerSubscriptionId: input.providerSubscriptionId,
      status: "active",
      cancelAtPeriodEnd: false,
    };
  },

  async refundPayment(
    _connection: ProviderConnectionContext,
    input: RefundPaymentInput,
  ): Promise<NormalizedRefund> {
    return {
      providerRefundId: stableId("mock_refund", input.providerPaymentId),
      providerPaymentId: input.providerPaymentId,
      status: "succeeded",
      amountMinor: input.amountMinor,
    };
  },

  async verifyWebhook(
    connection: ProviderConnectionContext,
    input: VerifyWebhookInput,
  ): Promise<VerifiedWebhook> {
    const signature = input.headers["x-monetplane-mock-signature"];
    if (!signature) throw new InvalidProviderWebhookSignatureError();

    const expected = Buffer.from(
      signMockWebhookPayload(input.rawBody, webhookSecret(connection)),
      "hex",
    );
    const actual = Buffer.from(signature, "hex");

    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new InvalidProviderWebhookSignatureError();
    }

    return { rawBody: input.rawBody };
  },

  async normalizeWebhook(
    connection: ProviderConnectionContext,
    input: VerifiedWebhook,
  ): Promise<NormalizedProviderEvent> {
    const payload = JSON.parse(input.rawBody) as MockWebhookPayload;
    if (!payload.id || !payload.type || !payload.occurred_at) {
      throw new Error("Invalid mock provider webhook payload");
    }

    const data = payload.data ?? {};
    const type = isKnownEventType(payload.type) ? payload.type : "unknown";

    return {
      provider: "mock",
      providerConnectionId: connection.id,
      providerEventId: payload.id,
      providerEventName: payload.type,
      type,
      applicationId: connection.applicationId,
      occurredAt: payload.occurred_at,
      providerCustomerId: data.provider_customer_id,
      providerPaymentId: data.provider_payment_id,
      providerSubscriptionId: data.provider_subscription_id,
      monetplaneOrderId: data.monetplane_order_id,
      monetplaneCustomerId: data.monetplane_customer_id,
      amountMinor: data.amount_minor,
      currency: data.currency,
      rawEventReference: payload.id,
    };
  },
};
